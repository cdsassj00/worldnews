/**
 * AI 시장 분석.
 *
 * 제공자 우선순위
 *  1) ANTHROPIC_API_KEY 시크릿이 있으면 Claude (기본 claude-opus-5)
 *  2) Workers AI 바인딩(AI)이 있으면 그걸로 (별도 키 불필요)
 *  3) 둘 다 없으면 기능 비활성 — 화면에 이유를 표시한다
 *
 * 입력은 이 서비스가 이미 계산한 것들(지수, 뉴스 제목, 종목 점수·근거)이고,
 * 모델은 그걸 한국어 브리핑으로 정리한다. 새 숫자를 만들어내지 말라고 명시한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { MarketInfo } from "../shared/markets";
import type { NewsItem } from "./news";
import type { RecommendResult } from "./recommend";
import { ApiError, cached } from "./util";

export interface AnalysisResult {
  cc: string;
  provider: "anthropic" | "workers-ai";
  model: string;
  generatedAt: number;
  /** 3줄 요약 */
  summary: string[];
  /** 주목 종목 */
  picks: { name: string; symbol: string; stance: string; reason: string }[];
  /** 리스크 */
  risks: string[];
  /** 오늘 확인할 것 */
  checklist: string[];
  disclaimer: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: "anthropic" | "workers-ai" | null;
  model: string | null;
  reason: string;
}

const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const DISCLAIMER =
  "AI가 정리한 참고 브리핑입니다. 투자 자문이 아니며 수익을 보장하지 않습니다. 원문 뉴스와 지표를 직접 확인하세요.";

export function aiStatus(env: Env): AiStatus {
  if (env.ANTHROPIC_API_KEY) {
    return {
      enabled: true,
      provider: "anthropic",
      model: env.AI_MODEL || DEFAULT_CLAUDE_MODEL,
      reason: "Anthropic API 키로 Claude 분석을 사용합니다.",
    };
  }
  if (env.AI) {
    return {
      enabled: true,
      provider: "workers-ai",
      model: env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
      reason: "Anthropic 키가 없어 Cloudflare Workers AI로 분석합니다(키 불필요).",
    };
  }
  return {
    enabled: false,
    provider: null,
    model: null,
    reason:
      "AI 분석이 비활성 상태입니다. wrangler secret put ANTHROPIC_API_KEY 로 키를 넣거나, wrangler.jsonc 에 Workers AI 바인딩(ai)을 추가하세요.",
  };
}

/* ── 프롬프트 ─────────────────────────────── */

const SYSTEM_PROMPT = `당신은 한국 개인투자자를 위한 시장 브리핑 애널리스트입니다.

규칙:
- 입력으로 준 지표·뉴스 제목·점수만 근거로 씁니다. 새로운 수치나 없는 사실을 만들지 않습니다.
- 모든 출력은 한국어입니다. 문장은 "합니다체"로 담백하게 씁니다.
- 수익을 약속하거나 단정적으로 예측하지 않습니다. "가능성", "이면", "확인 필요" 같은 조건부 표현을 씁니다.
- 종목 의견은 입력에 있는 점수·판정과 모순되지 않게 씁니다.
- 슬로건, 감탄사, 이모지, 홍보 문구를 쓰지 않습니다.
- 한자를 쓰지 않습니다. 한국어는 한글로만 씁니다(종목명에 원래 한자·영문이 들어간 경우는 그대로 둡니다).
- summary 는 정확히 3개, picks 는 최대 3개, risks 는 2~3개, checklist 는 2~3개입니다.
- picks 의 stance 는 "매수 검토" / "분할 매수" / "관망" / "비중 축소" 중 하나입니다.`;

interface AnalysisPayload {
  summary: string[];
  picks: { name: string; symbol: string; stance: string; reason: string }[];
  risks: string[];
  checklist: string[];
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "array", items: { type: "string" } },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          symbol: { type: "string" },
          stance: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "symbol", "stance", "reason"],
        additionalProperties: false,
      },
    },
    risks: { type: "array", items: { type: "string" } },
    checklist: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "picks", "risks", "checklist"],
  additionalProperties: false,
} as const;

function buildUserPrompt(
  market: MarketInfo,
  indices: { label: string; price: number; changePct: number }[],
  news: NewsItem[],
  reco: RecommendResult | null,
): string {
  const idxText = indices.length
    ? indices.map((i) => `- ${i.label}: ${i.price} (${i.changePct >= 0 ? "+" : ""}${i.changePct}%)`).join("\n")
    : "- 지수 데이터 없음";

  const newsText = news
    .slice(0, 14)
    .map((n) => `- [${n.lang === "ko" ? "한국어" : "현지"}] ${n.title} (${n.source})`)
    .join("\n");

  const recoText = reco?.items.length
    ? reco.items
        .slice(0, 8)
        .map(
          (r) =>
            `- ${r.name}(${r.symbol}) 점수 ${r.score} · 판정 ${r.actionKo} · 현재가 ${r.price}${r.currency} · 손절 ${r.plan.stop}(${r.plan.stopPct}%) · 목표 ${r.plan.target}(${r.plan.targetPct}%) · 근거: ${r.factors
              .map((f) => `${f.label} ${f.text}`)
              .join(", ")}`,
        )
        .join("\n")
    : "- 종목 점수 데이터 없음";

  return `대상 국가: ${market.nameKo} (${market.cc})
통화: ${market.currency}

[지수]
${idxText}

[최근 뉴스 제목]
${newsText || "- 뉴스 없음"}

[정량 점수 결과]
시장 분위기: ${reco?.marketBias?.score ?? "N/A"} — ${reco?.marketBias?.text ?? "N/A"}
${recoText}

위 자료만 근거로 ${market.nameKo} 시장 브리핑을 작성하세요.
- summary: 지금 이 시장에서 벌어지는 일 3문장
- picks: 점수와 뉴스가 함께 지지하는 종목 (없으면 빈 배열)
- risks: 이 시장에서 지금 조심할 것
- checklist: 오늘/이번 주에 확인할 구체적 항목`;
}

/* ── 제공자별 호출 ─────────────────────────────── */

async function runAnthropic(env: Env, prompt: string): Promise<{ data: AnalysisPayload; model: string }> {
  const model = env.AI_MODEL || DEFAULT_CLAUDE_MODEL;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    // 짧은 브리핑이라 사고 깊이는 낮게 잡아 지연·비용을 줄인다.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new ApiError(502, "ai_refused", { hint: "모델이 응답을 거부했습니다. 뉴스 내용에 민감한 주제가 섞였을 수 있습니다." });
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new ApiError(502, "ai_empty_response");
  return { data: parsePayload(textBlock.text), model };
}

/** Workers AI 응답에서 텍스트를 뽑는다. 모델·런타임에 따라 모양이 조금씩 다르다. */
function workersAiText(out: unknown): string {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const o = out as Record<string, unknown>;
  if (typeof o.response === "string") return o.response;
  // 일부 모델은 { response: { response: "..." } } 또는 { result: { response: "..." } } 형태를 준다.
  for (const key of ["response", "result", "output"]) {
    const v = o[key];
    if (v && typeof v === "object") {
      const inner = workersAiText(v);
      if (inner) return inner;
    }
  }
  if (Array.isArray(o.choices)) {
    const first = o.choices[0] as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === "string") return msg.content;
  }
  return "";
}

async function runWorkersAi(env: Env, prompt: string): Promise<{ data: AnalysisPayload; model: string }> {
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
  const out = (await env.AI!.run(model, {
    messages: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\n반드시 아래 JSON 형식만 출력하세요(설명·코드블록 금지):\n{"summary":["..."],"picks":[{"name":"","symbol":"","stance":"","reason":""}],"risks":["..."],"checklist":["..."]}`,
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 1800,
  })) as unknown;
  const text = workersAiText(out);
  if (!text) {
    throw new ApiError(502, "ai_empty_response", {
      hint: "Workers AI 응답에서 텍스트를 찾지 못했습니다.",
      shape: out && typeof out === "object" ? Object.keys(out as Record<string, unknown>) : typeof out,
    });
  }
  return { data: parsePayload(text), model };
}

function parsePayload(text: string): AnalysisPayload {
  // 코드블록이나 앞뒤 설명이 섞여도 첫 JSON 객체만 뽑아 쓴다.
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ApiError(502, "ai_bad_json", { snippet: cleaned.slice(0, 200) });
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new ApiError(502, "ai_bad_json", { snippet: cleaned.slice(0, 200) });
  }
  const obj = raw as Partial<AnalysisPayload>;
  const strings = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max) : [];

  return {
    summary: strings(obj.summary, 4),
    risks: strings(obj.risks, 4),
    checklist: strings(obj.checklist, 4),
    picks: Array.isArray(obj.picks)
      ? obj.picks
          .filter((p): p is AnalysisPayload["picks"][number] => Boolean(p && typeof p === "object"))
          .slice(0, 3)
          .map((p) => ({
            name: String(p.name ?? ""),
            symbol: String(p.symbol ?? ""),
            stance: String(p.stance ?? ""),
            reason: String(p.reason ?? ""),
          }))
      : [],
  };
}

/* ── 엔트리 ─────────────────────────────── */

export async function analyze(
  env: Env,
  market: MarketInfo,
  indices: { label: string; price: number; changePct: number }[],
  news: NewsItem[],
  reco: RecommendResult | null,
): Promise<AnalysisResult> {
  const status = aiStatus(env);
  if (!status.enabled) throw new ApiError(503, "ai_disabled", { hint: status.reason });

  const prompt = buildUserPrompt(market, indices, news, reco);
  const { data, model } =
    status.provider === "anthropic" ? await runAnthropic(env, prompt) : await runWorkersAi(env, prompt);

  if (!data.summary.length) throw new ApiError(502, "ai_empty_summary");

  return {
    cc: market.cc,
    provider: status.provider!,
    model,
    generatedAt: Date.now(),
    ...data,
    disclaimer: DISCLAIMER,
  };
}

/** 15분 캐시. 같은 국가를 여러 명이 봐도 모델 호출은 한 번이다. */
export async function getAnalysis(
  env: Env,
  market: MarketInfo,
  indices: { label: string; price: number; changePct: number }[],
  news: NewsItem[],
  reco: RecommendResult | null,
) {
  return cached(env, `ai:v1:${market.cc}`, 900, () => analyze(env, market, indices, news, reco));
}
