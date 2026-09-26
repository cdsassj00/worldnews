/**
 * 1면·거시 뉴스 → 거시요인 보정.
 *
 * 종목마다 뉴스를 긁는 대신, 시장을 움직이는 큰 기사(금리·유가·환율·전쟁·관세·중국)를
 * AI가 읽고 8개 거시요인에 방향으로 매핑한다. 그 보정이 온톨로지 그래프를 타고
 * 전 종목에 전파된다 — 기사 1건이 89종목의 점수를 움직이는 증폭 구조다.
 *
 * 키워드 사전으로는 안 되는 부분이다: "긴장 고조"와 "긴장 완화"는 반대 방향인데
 * 사전은 둘 다 "긴장"으로 본다. 그래서 이것만은 AI(있으면 Claude, 없으면 Workers AI)가 읽는다.
 * 30분 캐시 — 1면 기사는 분 단위로 안 바뀐다.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { MACRO, type MacroId } from "../shared/ontology";
import { getGlobalNews, getNews } from "./news";
import { aiStatus, geminiText, openrouterText, providerOrder } from "./analysis";
import { cached, clamp, round } from "./util";

export interface MacroAdjustment {
  id: MacroId;
  /** -1(강한 하락 압력) ~ +1(강한 상승 압력) */
  impact: number;
  reasonKo: string;
}

export interface MacroNewsResult {
  generatedAt: number;
  provider: "openrouter" | "gemini" | "anthropic" | "workers-ai" | null;
  headlinesUsed: number;
  adjustments: MacroAdjustment[];
}

const VALID_IDS = new Set<string>(MACRO.map((m) => m.id));

const SYSTEM = `당신은 거시경제 뉴스가 시장 요인에 주는 단기(수일) 방향 영향을 판정하는 애널리스트입니다.

요인 목록 (id — 의미):
${MACRO.map((m) => `- ${m.id}: ${m.nameKo} (상승 = ${m.upMeansKo})`).join("\n")}

규칙:
- 입력한 헤드라인만 근거로 판단합니다. 없는 사실을 만들지 않습니다.
- impact 는 해당 요인 "값"이 오를 압력이면 양수, 내릴 압력이면 음수. -1~1.
- 확실한 것만 냅니다. 애매하면 그 요인은 제외합니다. 보통 2~5개면 충분합니다.
- 개별 기업 기사(실적·인사)는 무시합니다. 시장 전체를 움직이는 기사만 봅니다.
- [n시간 전] 표시가 있는 헤드라인은 그 나이를 감안합니다. 하루 넘게 지난 기사는 이미 가격에 반영됐을 가능성이 크니 보수적으로 봅니다.
- reasonKo 는 근거 헤드라인을 요약한 한국어 한 문장입니다.
- JSON 만 출력합니다: {"adjustments":[{"id":"OIL","impact":0.5,"reasonKo":"..."}]}`;

function parseAdjustments(text: string): MacroAdjustment[] {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (raw as { adjustments?: unknown }).adjustments;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a): a is { id: string; impact: number; reasonKo?: string } =>
      Boolean(a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string"),
    )
    .filter((a) => VALID_IDS.has(a.id) && Number.isFinite(a.impact))
    .slice(0, 8)
    .map((a) => ({
      id: a.id as MacroId,
      impact: round(clamp(Number(a.impact), -1, 1), 2),
      reasonKo: String(a.reasonKo ?? "").slice(0, 120),
    }));
}

async function interpret(env: Env): Promise<MacroNewsResult> {
  const status = aiStatus(env);
  if (!status.enabled) return { generatedAt: Date.now(), provider: null, headlinesUsed: 0, adjustments: [] };

  // 글로벌 + 국내 헤드라인 (둘 다 이미 10분 캐시가 있어 추가 fetch 비용이 거의 없다)
  const [global, kr] = await Promise.allSettled([getGlobalNews(env), getNews(env, "KR", "대한민국")]);
  const all = [
    ...(global.status === "fulfilled" ? global.value.data.items : []),
    ...(kr.status === "fulfilled" ? kr.value.data.items : []),
  ].filter((n) => n.title);

  // 오늘 자 뉴스만: 36시간 넘은 기사는 이미 가격에 반영된 정보다. 신선한 것부터 최신순.
  // 신선분이 너무 적으면(휴일 등) 오래된 것으로 채우되, 나이를 붙여 AI가 감안하게 한다.
  const now = Date.now();
  const MAX_AGE_MS = 36 * 3600 * 1000;
  const fresh = all
    .filter((n) => n.publishedAt > 0 && now - n.publishedAt <= MAX_AGE_MS)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  const pool = fresh.length >= 8 ? fresh : [...fresh, ...all.filter((n) => !fresh.includes(n))];

  const seen = new Set<string>();
  const lines: string[] = [];
  let used = 0;
  for (const n of pool) {
    if (seen.has(n.title)) continue;
    seen.add(n.title);
    const ageH = n.publishedAt > 0 ? Math.round((now - n.publishedAt) / 3600000) : null;
    lines.push(`- ${ageH !== null ? `[${ageH}시간 전] ` : ""}${n.title}`);
    if (++used >= 22) break;
  }
  if (lines.length < 3) return { generatedAt: Date.now(), provider: null, headlinesUsed: lines.length, adjustments: [] };

  const prompt = `아래 최근 헤드라인을 읽고 거시요인 보정을 내세요.\n\n${lines.join("\n")}`;

  // providerOrder 순서(기본 비용순, AI_PROVIDER 로 1순위 고정)로 시도. 실패하면 다음으로 폴백.
  const runners: { provider: MacroNewsResult["provider"]; run: () => Promise<string> }[] = [];
  for (const p of providerOrder(env)) {
    if (p === "openrouter" && env.OPENROUTER_API_KEY)
      runners.push({ provider: "openrouter", run: () => openrouterText(env, SYSTEM, prompt, 900) });
    if (p === "gemini" && env.GEMINI_API_KEY)
      runners.push({ provider: "gemini", run: () => geminiText(env, SYSTEM, prompt, 900) });
    if (p === "anthropic" && env.ANTHROPIC_API_KEY) {
      runners.push({
        provider: "anthropic",
        run: async () => {
          const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });
          const res = await client.messages.create({
            model: env.AI_MODEL || "claude-haiku-4-5",
            max_tokens: 1500,
            system: SYSTEM,
            messages: [{ role: "user", content: prompt }],
          });
          return res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
        },
      });
    }
    if (p === "workers-ai" && env.AI) {
      runners.push({
        provider: "workers-ai",
        run: async () => {
          const out = (await env.AI!.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: prompt },
            ],
            max_tokens: 900,
          })) as { response?: string };
          return typeof out === "string" ? out : (out?.response ?? JSON.stringify(out ?? ""));
        },
      });
    }
  }

  for (const r of runners) {
    try {
      const adjustments = parseAdjustments(await r.run());
      if (adjustments.length) return { generatedAt: Date.now(), provider: r.provider, headlinesUsed: lines.length, adjustments };
    } catch {
      /* 다음 제공자로 */
    }
  }
  return { generatedAt: Date.now(), provider: null, headlinesUsed: lines.length, adjustments: [] };
}

/**
 * 캐시: 장 전후·장중(KST 평일 07~16시)은 30분, 그 외(밤·주말)는 90분.
 * 크론이 24시간 도는데 밤마다 30분꼴로 AI를 부르면 토큰 비용만 쌓인다 —
 * 밤사이 미국장 헤드라인은 90분 주기로도 아침 판단에 충분히 최신이다.
 */
export async function getMacroNewsAdjust(env: Env): Promise<MacroNewsResult> {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const wd = kst.getUTCDay();
  const h = kst.getUTCHours();
  const activeHours = wd >= 1 && wd <= 5 && h >= 7 && h <= 16;
  const ttl = activeHours ? 1800 : 5400;
  const { data } = await cached(
    env,
    "mnews:v1",
    ttl,
    () => interpret(env),
    (r) => (r.adjustments.length ? ttl : 300),
  );
  return data;
}
