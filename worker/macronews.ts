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
import { aiStatus } from "./analysis";
import { cached, clamp, round } from "./util";

export interface MacroAdjustment {
  id: MacroId;
  /** -1(강한 하락 압력) ~ +1(강한 상승 압력) */
  impact: number;
  reasonKo: string;
}

export interface MacroNewsResult {
  generatedAt: number;
  provider: "anthropic" | "workers-ai" | null;
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
  const titles = [
    ...(global.status === "fulfilled" ? global.value.data.items : []),
    ...(kr.status === "fulfilled" ? kr.value.data.items : []),
  ]
    .map((n) => n.title)
    .filter(Boolean);
  const uniq = [...new Set(titles)].slice(0, 22);
  if (uniq.length < 3) return { generatedAt: Date.now(), provider: null, headlinesUsed: uniq.length, adjustments: [] };

  const prompt = `아래 최근 헤드라인을 읽고 거시요인 보정을 내세요.\n\n${uniq.map((t) => `- ${t}`).join("\n")}`;

  let adjustments: MacroAdjustment[] = [];
  if (status.provider === "anthropic") {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });
    const res = await client.messages.create({
      model: env.AI_MODEL || "claude-opus-5",
      max_tokens: 1500,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    adjustments = parseAdjustments(text);
  } else {
    const out = (await env.AI!.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      max_tokens: 900,
    })) as { response?: string };
    adjustments = parseAdjustments(typeof out === "string" ? out : (out?.response ?? JSON.stringify(out ?? "")));
  }

  return { generatedAt: Date.now(), provider: status.provider, headlinesUsed: uniq.length, adjustments };
}

/** 30분 캐시. 실패하면 빈 보정(=가격 관측만)으로 5분 뒤 재시도. */
export async function getMacroNewsAdjust(env: Env): Promise<MacroNewsResult> {
  const { data } = await cached(
    env,
    "mnews:v1",
    1800,
    () => interpret(env),
    (r) => (r.adjustments.length ? 1800 : 300),
  );
  return data;
}
