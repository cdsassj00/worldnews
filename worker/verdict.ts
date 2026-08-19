/**
 * 온톨로지 결론 엔진 — "그래서 뭘 사고 뭘 피하나"를 출력하는 층.
 *
 * 설계 원칙 (2026-08-02 사용자 지시):
 *   섹터·종목은 온톨로지의 구성물이 아니라 **분석의 출력**이다.
 *   온톨로지가 담는 것은 요인(거시·뉴스·수급)과 요인 사이의 인과이고,
 *   그 인과를 계산한 결과로 "이런 국면 → 이런 섹터 → 이런 종목"이 나와야 한다.
 *
 * 파이프라인:
 *   ① 요인 관측: 거시 12개(가격) + 뉴스 보정(AI) + 수급(외국인 순매수, KIS)
 *   ② 인과 확인: MACRO_LINKS 중 "지금 실제로 작동한" 사슬만 골라 서사로 남긴다
 *      (예: VIX +9.6% → (위험회피) → 코스피 -10.7% : 방향이 맞아떨어질 때만)
 *   ③ 국면 판정: 위험선호/금리/달러/원자재 축을 종합해 한 문장으로
 *   ④ 섹터 결론: 민감도 표로 전파한 섹터 점수 상·하위 = 추천/회피 (근거 문장 포함)
 *   ⑤ 종목 결론: 추천 섹터 안에서 레이더 점수 상위 = 추천, 전체 최하위 = 회피
 *
 * 시장 파라미터(KR/US)로 같은 엔진이 두 시장을 처리한다.
 */
import type { Env } from "./env";
import {
  MACRO_LINKS,
  RELATIONS,
  SENSITIVITY,
  US_SENSITIVITY,
  type MacroId,
} from "../shared/ontology";
import { effectiveValue, round, type MacroSignal } from "../shared/scoring";
import { runStrategy } from "./strategy";
import { radarTop } from "./radarscan";
import { liveSensitivity } from "./senslive";
import { cached } from "./util";
import { getInvestorFlow, type InvestorFlow } from "./flows";

export type VerdictMarket = "KR" | "US";

export interface SectorVerdict {
  sector: string;
  score: number;
  reasons: string[];
  /** 그래프 시각화용 — 이 결론을 만든 거시 기여 */
  edges: { macroId: MacroId; contribution: number }[];
}

export interface StockVerdict {
  code: string;
  name: string;
  sector: string | null;
  score: number;
  price: number;
  changePct: number;
  reason: string;
  /** 종목별 실제 근거 — 온톨로지/가격/뉴스 축의 기여 문장 (레이더 계산 그대로) */
  reasons: string[];
}

export interface OntoVerdict {
  market: VerdictMarket;
  generatedAt: number;
  dataAsOf: number | null;
  /** ③ 국면 */
  regime: { label: string; tone: "risk-off" | "caution" | "risk-on"; riskOff: number; lines: string[] };
  /** ② 지금 작동 중인 인과 사슬 */
  causal: string[];
  /** 수급 요인 (KR 전용, KIS 연결 시) */
  flow: InvestorFlow | null;
  /** ④ 섹터 결론 */
  sectors: { recommend: SectorVerdict[]; avoid: SectorVerdict[] };
  /** ⑤ 종목 결론 */
  stocks: { recommend: StockVerdict[]; avoid: StockVerdict[] };
  note: string;
}

const MACRO_KO: Record<string, string> = {
  OIL: "유가", USDKRW: "원/달러", US10Y: "미 10년 금리", SEMI: "반도체 업황",
  KOSPI: "코스피", CHINA: "중국 증시", VIX: "변동성(VIX)", GOLD: "금",
  DXY: "달러인덱스", COPPER: "구리", NASDAQ: "나스닥", BTC: "비트코인",
};

/** 시장별 위험회피: 변동성 급등 + 시장 베타 하락 */
function riskOffFor(macro: MacroSignal[], market: VerdictMarket): number {
  const get = (id: MacroId) => macro.find((m) => m.id === id)?.value ?? 0;
  const beta = market === "US" ? get("NASDAQ") : get("KOSPI");
  return round(Math.min(1, Math.max(0, get("VIX") * 0.6 - beta * 0.6)), 2);
}

/** 한국 시장에만 의미 있는 노드 — 미국 브리프의 인과 사슬에서는 제외한다.
 * (2026-08-19 유튜브 파이프라인 보고: 미국 causal 이 코스피·원/달러를 설명하고 있었다) */
const KR_ONLY_NODES = new Set<MacroId>(["KOSPI", "USDKRW"]);

/** ② 지금 실제로 작동한 인과 사슬만 문장으로 */
function activeCausalChains(macro: MacroSignal[], market: VerdictMarket): string[] {
  const byId = new Map(macro.map((m) => [m.id, m]));
  const out: { text: string; strength: number }[] = [];
  for (const l of MACRO_LINKS) {
    if (market === "US" && (KR_ONLY_NODES.has(l.from) || KR_ONLY_NODES.has(l.to))) continue;
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    if (!from || !to) continue;
    const fv = effectiveValue(from);
    const tv = effectiveValue(to);
    // 원인이 유의미하게 움직였고, 결과가 인과 부호대로 따라 움직였을 때만 "작동 중"
    if (Math.abs(fv) < 0.15 || Math.abs(tv) < 0.1) continue;
    if (Math.sign(tv) !== Math.sign(fv * l.sign)) continue;
    out.push({
      text: `${MACRO_KO[l.from]} ${from.changePct >= 0 ? "+" : ""}${from.changePct}% → ${MACRO_KO[l.to]} ${to.changePct >= 0 ? "+" : ""}${to.changePct}% — ${l.ko}`,
      strength: Math.abs(fv) + Math.abs(tv),
    });
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, 4).map((x) => x.text);
}

/** ③ 국면 판정 — 축별 상태를 종합해 사람이 읽는 문장으로 */
function judgeRegime(macro: MacroSignal[], market: VerdictMarket, flow: InvestorFlow | null) {
  const get = (id: MacroId) => macro.find((m) => m.id === id);
  const v = (id: MacroId) => (get(id) ? effectiveValue(get(id)!) : 0);
  const riskOff = riskOffFor(macro, market);

  const tone: OntoVerdict["regime"]["tone"] = riskOff >= 0.55 ? "risk-off" : riskOff >= 0.35 ? "caution" : "risk-on";
  const label =
    tone === "risk-off" ? "위험회피 국면 — 방어와 선별이 우선" :
    tone === "caution" ? "경계 국면 — 방향 탐색 중" : "위험선호 국면 — 순풍 확산";

  const lines: string[] = [];
  const beta = market === "US" ? get("NASDAQ") : get("KOSPI");
  const vix = get("VIX");
  if (vix && beta) {
    lines.push(
      `위험선호: 변동성(VIX) ${vix.changePct >= 0 ? "+" : ""}${vix.changePct}% · ${market === "US" ? "나스닥" : "코스피"} ${beta.changePct >= 0 ? "+" : ""}${beta.changePct}% → 위험회피 지수 ${riskOff}`,
    );
  }
  const r = v("US10Y");
  if (Math.abs(r) >= 0.1) lines.push(`금리: 미 10년 ${r > 0 ? "상승" : "하락"} 압력 — ${r > 0 ? "은행·보험 순풍, 성장주(바이오·인터넷·기술) 역풍" : "성장주 밸류에이션 부담 완화"}`);
  const d = v("DXY");
  if (Math.abs(d) >= 0.1) lines.push(`달러: ${d > 0 ? "강세 — 신흥국 자금 이탈·원화 약세 압력" : "약세 — 위험자산에 우호"}`);
  const o = v("OIL"), c = v("COPPER");
  if (Math.abs(o) >= 0.15 || Math.abs(c) >= 0.15) {
    lines.push(`원자재: 유가 ${o >= 0 ? "↑" : "↓"} · 구리 ${c >= 0 ? "↑" : "↓"} — ${c > 0.1 ? "실물 수요 회복 신호" : c < -0.1 ? "실물 수요 둔화 신호" : "혼조"}`);
  }
  if (flow && flow.available && market === "KR") {
    lines.push(`수급: 최근 ${flow.days}일 외국인 대형주 순매수 ${flow.foreignNetBuyKrw >= 0 ? "+" : ""}${Math.round(flow.foreignNetBuyKrw / 1e8)}억원 — ${flow.foreignNetBuyKrw >= 0 ? "돌아오는 중" : "이탈 지속"} (${flow.basis})`);
  }
  return { label, tone, riskOff, lines };
}

/** ④ 섹터 결론 — 민감도 표 × 유효 신호. RELATIONS 로 근거를 문장화한다. */
function sectorVerdicts(macro: MacroSignal[], market: VerdictMarket, krTable: Record<string, Partial<Record<MacroId, number>>>) {
  const table = market === "US" ? US_SENSITIVITY : krTable;
  const byId = new Map(macro.map((m) => [m.id, m]));
  const scored: SectorVerdict[] = [];
  for (const [sector, sens] of Object.entries(table)) {
    let total = 0;
    const parts: { text: string; value: number; macroId: MacroId }[] = [];
    for (const [macroId, w] of Object.entries(sens) as [MacroId, number][]) {
      const m = byId.get(macroId);
      if (!m) continue;
      const ev = effectiveValue(m);
      if (Math.abs(ev) < 0.05) continue;
      const contribution = w * ev;
      total += contribution;
      const rel = (RELATIONS as Record<string, Partial<Record<string, { rel: string; ko: string }>>>)[sector]?.[macroId];
      parts.push({
        text: `${MACRO_KO[macroId]} ${m.changePct >= 0 ? "+" : ""}${m.changePct}%${rel ? ` (${rel.rel} 경로)` : ""} → ${contribution >= 0 ? "+" : ""}${round(contribution, 2)}`,
        value: contribution,
        macroId,
      });
    }
    parts.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    scored.push({
      sector,
      score: round(total / 1.5, 3),
      reasons: parts.slice(0, 3).map((p) => p.text),
      edges: parts.slice(0, 4).map((p) => ({ macroId: p.macroId, contribution: round(p.value, 3) })),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    recommend: scored.filter((s) => s.score > 0.05).slice(0, 4),
    avoid: scored.filter((s) => s.score < -0.05).slice(-4).reverse(),
  };
}

/** ⑤ 종목 결론 — 추천 섹터 안의 레이더 상위 / 전체 최하위 */
async function stockVerdicts(env: Env, market: VerdictMarket, sectors: { recommend: SectorVerdict[]; avoid: SectorVerdict[] }) {
  const marketFilter = market === "US" ? "US" : undefined; // KR 은 KOSPI+KOSDAQ 라 전체에서 US 만 제외
  const [topRes, weakRes] = await Promise.all([
    radarTop(env, 60, "desc", undefined, marketFilter),
    radarTop(env, 60, "asc", undefined, marketFilter),
  ]);
  const isKr = (m: string) => m !== "US";
  const inMarket = (m: string) => (market === "US" ? m === "US" : isKr(m));
  const recSectors = new Set(sectors.recommend.map((s) => s.sector));
  const toStock = (r: (typeof topRes.items)[number], reason: string): StockVerdict => ({
    code: r.code, name: r.name, sector: r.sector, score: r.score, price: r.price, changePct: r.changePct, reason,
    // "왜 하필 이 종목인가" — 같은 상용구 반복 대신 레이더가 계산한 축별 기여를 그대로 (2026-08-19 파이프라인 요청 1-3)
    reasons: (r.reasons ?? []).slice(0, 3).map((x) => x.text),
  });
  const recommend = topRes.items
    .filter((r) => inMarket(r.market) && r.score >= 0.1)
    .map((r) => toStock(r, recSectors.has(r.sector ?? "") ? "추천 섹터 소속 + 종합 점수 상위" : "섹터 역풍을 이기는 종합 점수 상위"))
    .slice(0, 6);
  const avoid = weakRes.items
    .filter((r) => inMarket(r.market) && r.score <= -0.15)
    .map((r) => toStock(r, "종합 점수 최하위 — 보유 시 축소 검토"))
    .slice(0, 4);
  return { recommend, avoid };
}

async function buildVerdict(env: Env, market: VerdictMarket): Promise<OntoVerdict> {
  const { data: strat } = await cached(env, "auto:strategy", 300, () => runStrategy(env));
  const flow = market === "KR" ? await getInvestorFlow(env).catch(() => null) : null;
  const regime = judgeRegime(strat.macro, market, flow);
  const causal = activeCausalChains(strat.macro, market);
  const { table: krTable } = await liveSensitivity(env);
  const sectors = sectorVerdicts(strat.macro, market, krTable);
  const stocks = await stockVerdicts(env, market, sectors);
  return {
    market,
    generatedAt: Date.now(),
    dataAsOf: strat.dataAsOf ?? null,
    regime,
    causal,
    flow,
    sectors,
    stocks,
    note: "요인(거시·뉴스·수급)의 인과를 계산한 결론입니다. 참고 자료이며 투자 자문이 아닙니다.",
  };
}

/** 5분 캐시 — 전략 캐시와 보조를 맞춘다 */
export async function getVerdict(env: Env, market: VerdictMarket): Promise<OntoVerdict> {
  // v2: 종목별 reasons 추가 + 미국 causal 분리 (2026-08-19) — 키를 갈아 옛 모양 캐시를 무효화
  const { data } = await cached(env, `verdict:v2:${market}`, 300, () => buildVerdict(env, market));
  return data;
}
