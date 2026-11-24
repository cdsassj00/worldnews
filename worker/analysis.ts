/**
 * AI 시장 분석.
 *
 * 제공자 우선순위 (비용 순 — 사용자 요청: 토큰 싼 걸로)
 *  1) GEMINI_API_KEY 가 있으면 Gemini Flash (무료 쿼터가 커서 사실상 0원)
 *  2) ANTHROPIC_API_KEY 가 있으면 Claude (기본 claude-haiku-4-5 — 저비용 티어)
 *  3) Workers AI 바인딩(AI) — 워커 요금에 포함, 별도 키 불필요
 *  4) 전부 없으면 기능 비활성 — 화면에 이유를 표시한다
 *
 * 앞 순위가 실패(과부하·타임아웃)하면 다음 순위로 자동 폴백한다 —
 * 한 제공자가 죽었다고 화면에 internal_error 를 던지지 않는다.
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

export type AiProvider = "openrouter" | "gemini" | "anthropic" | "workers-ai";

export interface AnalysisResult {
  cc: string;
  provider: AiProvider;
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
  provider: AiProvider | null;
  model: string | null;
  reason: string;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
// OpenRouter 기본 모델 — 저비용·JSON 안정성 기준. OPENROUTER_MODEL 로 교체 가능.
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
// 사용자 요청(2026-08-01)으로 저비용 티어를 기본값으로 한다. 되돌리려면 AI_MODEL 로 오버라이드.
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const DISCLAIMER =
  "AI가 정리한 참고 브리핑입니다. 투자 자문이 아니며 수익을 보장하지 않습니다. 원문 뉴스와 지표를 직접 확인하세요.";

/** 제공자 시도 순서 — 기본은 비용 순. AI_PROVIDER 로 1순위를 고정할 수 있고,
 *  고정 제공자가 실패하면 나머지 순서로 폴백한다(사용자 지시 2026-08-17: Claude Sonnet 주력). */
export function providerOrder(env: Env): AiProvider[] {
  const base: AiProvider[] = ["openrouter", "gemini", "anthropic", "workers-ai"];
  const pin = (env.AI_PROVIDER || "").trim() as AiProvider;
  return base.includes(pin) ? [pin, ...base.filter((p) => p !== pin)] : base;
}

export function aiStatus(env: Env): AiStatus {
  for (const p of providerOrder(env)) {
    if (p === "openrouter" && env.OPENROUTER_API_KEY) {
      return {
        enabled: true,
        provider: "openrouter",
        model: env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        reason: "OpenRouter API 키로 분석합니다 (모델은 OPENROUTER_MODEL 로 교체 가능).",
      };
    }
    if (p === "gemini" && env.GEMINI_API_KEY) {
      return {
        enabled: true,
        provider: "gemini",
        model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
        reason: "Gemini API 키로 Gemini Flash 분석을 사용합니다(저비용).",
      };
    }
    if (p === "anthropic" && env.ANTHROPIC_API_KEY) {
      return {
        enabled: true,
        provider: "anthropic",
        model: env.AI_MODEL || DEFAULT_CLAUDE_MODEL,
        reason: "Anthropic API 키로 Claude 분석을 사용합니다.",
      };
    }
    if (p === "workers-ai" && env.AI) {
      return {
        enabled: true,
        provider: "workers-ai",
        model: env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
        reason: "다른 AI 키가 없어 Cloudflare Workers AI로 분석합니다(키 불필요).",
      };
    }
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

/** OpenRouter chat completions — OpenAI 호환. 워커 어디서든 재사용할 수 있는 공용 헬퍼. */
export async function openrouterText(env: Env, system: string, prompt: string, maxTokens = 2000): Promise<string> {
  const model = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY!}`,
      "http-referer": "https://stockontology.cc",
      "x-title": "Stockontology",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new ApiError(502, "openrouter_error", { status: res.status, body: (await res.text()).slice(0, 300) });
  }
  const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = out.choices?.[0]?.message?.content ?? "";
  if (!text) throw new ApiError(502, "ai_empty_response", { provider: "openrouter" });
  return text;
}

async function runOpenRouter(env: Env, prompt: string): Promise<{ data: AnalysisPayload; model: string }> {
  const model = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const text = await openrouterText(
    env,
    `${SYSTEM_PROMPT}\n\n반드시 아래 JSON 형식만 출력하세요(설명·코드블록 금지):\n{"summary":["..."],"picks":[{"name":"","symbol":"","stance":"","reason":""}],"risks":["..."],"checklist":["..."]}`,
    prompt,
  );
  return { data: parsePayload(text), model };
}

/** Gemini generateContent — JSON 강제 출력. 워커 어디서든 재사용할 수 있게 단순 REST 로 부른다. */
export async function geminiText(env: Env, system: string, prompt: string, maxTokens = 2000): Promise<string> {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        // 기계적 JSON 생성이라 사고 토큰은 비용·지연 낭비다 (2.5-flash 는 기본 켜짐)
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) {
    throw new ApiError(502, "gemini_error", { status: res.status, body: (await res.text()).slice(0, 300) });
  }
  const out = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (out.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) throw new ApiError(502, "ai_empty_response", { provider: "gemini" });
  return text;
}

async function runGemini(env: Env, prompt: string): Promise<{ data: AnalysisPayload; model: string }> {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const text = await geminiText(
    env,
    `${SYSTEM_PROMPT}\n\n반드시 아래 JSON 형식만 출력하세요:\n{"summary":["..."],"picks":[{"name":"","symbol":"","stance":"","reason":""}],"risks":["..."],"checklist":["..."]}`,
    prompt,
  );
  return { data: parsePayload(text), model };
}

async function runAnthropic(env: Env, prompt: string): Promise<{ data: AnalysisPayload; model: string }> {
  const model = env.AI_MODEL || DEFAULT_CLAUDE_MODEL;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });

  // output_config(effort·json_schema)는 4.6+ 전용이라 저비용 티어(haiku-4-5)에서 400 이 난다.
  // 모델 무관하게 돌도록 프롬프트로 JSON 형식을 강제하고 파서가 관대하게 받는다.
  const response = await client.messages.create({
    model,
    max_tokens: 2500,
    system: `${SYSTEM_PROMPT}\n\n반드시 아래 JSON 형식만 출력하세요(설명·코드블록 금지):\n{"summary":["..."],"picks":[{"name":"","symbol":"","stance":"","reason":""}],"risks":["..."],"checklist":["..."]}`,
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
  const prompt = buildUserPrompt(market, indices, news, reco);

  // providerOrder 순서(기본 비용순, AI_PROVIDER 로 1순위 고정)로 시도하고, 실패하면 다음으로 폴백한다.
  const attempts: { provider: AiProvider; run: () => Promise<{ data: AnalysisPayload; model: string }> }[] = [];
  for (const p of providerOrder(env)) {
    if (p === "openrouter" && env.OPENROUTER_API_KEY) attempts.push({ provider: "openrouter", run: () => runOpenRouter(env, prompt) });
    if (p === "gemini" && env.GEMINI_API_KEY) attempts.push({ provider: "gemini", run: () => runGemini(env, prompt) });
    if (p === "anthropic" && env.ANTHROPIC_API_KEY) attempts.push({ provider: "anthropic", run: () => runAnthropic(env, prompt) });
    if (p === "workers-ai" && env.AI) attempts.push({ provider: "workers-ai", run: () => runWorkersAi(env, prompt) });
  }
  if (!attempts.length) throw new ApiError(503, "ai_disabled", { hint: aiStatus(env).reason });

  let lastErr: unknown = null;
  for (const a of attempts) {
    try {
      const { data, model } = await a.run();
      if (!data.summary.length) throw new ApiError(502, "ai_empty_summary");
      return {
        cc: market.cc,
        provider: a.provider,
        model,
        generatedAt: Date.now(),
        ...data,
        disclaimer: DISCLAIMER,
      };
    } catch (err) {
      lastErr = err; // 다음 제공자로
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiError(502, "ai_all_providers_failed");
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
