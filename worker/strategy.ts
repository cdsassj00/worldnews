/**
 * 온톨로지 기반 종목 선정 엔진.
 *
 *   1) 거시 신호 관측: 유가·환율·금리·반도체업황·중국·변동성·시장 (5일 변화율 → -1~1 정규화)
 *   2) 그래프 전파: 거시 → 섹터 민감도 → 종목 (경로를 그대로 보존해 설명 가능하게)
 *   3) 가격 신호: 모멘텀·추세·밴드 위치·거래량 (recommend.ts 와 같은 계열)
 *   4) 뉴스 신호: 종목 별칭이 걸린 기사의 감성
 *   5) 합성 점수 → 목표 포트폴리오
 *
 * 세 신호를 합치는 이유는 서로 다른 실패 모드를 갖기 때문이다.
 * 온톨로지는 구조는 알지만 타이밍을 모르고, 모멘텀은 타이밍은 알지만 이유를 모르며,
 * 뉴스는 빠르지만 잡음이 많다. 한 축이 무너져도 나머지가 버티게 한다.
 */
import type { Env } from "./env";
import { MACRO, SENSITIVITY, UNIVERSE, type MacroId, type SectorId, type UniverseTicker } from "../shared/ontology";
import { getManySeries, getSeries, type Series } from "./quotes";
import { getNews, type NewsItem } from "./news";
import { scoreForTicker } from "./sentiment";
import { clamp, round } from "./util";

export interface MacroSignal {
  id: MacroId;
  nameKo: string;
  changePct: number;
  /** -1 ~ 1 로 정규화한 신호 세기 */
  value: number;
  price: number;
  upMeansKo: string;
}

export interface ScoreReason {
  kind: "ontology" | "price" | "news";
  text: string;
  contribution: number;
}

export interface TickerScore {
  code: string;
  symbol: string;
  nameKo: string;
  price: number;
  changePct: number;
  /** 합성 점수 (-1 ~ 1 근처) */
  score: number;
  ontologyScore: number;
  priceScore: number;
  newsScore: number;
  /** 변동성(일간 표준편차 %) */
  volatility: number;
  atr: number;
  reasons: ScoreReason[];
}

export interface StrategyResult {
  generatedAt: number;
  macro: MacroSignal[];
  scores: TickerScore[];
  /** 시장 전반 위험도 (VIX·지수 기반). 1에 가까울수록 위험회피 */
  riskOff: number;
  note: string;
}

/** 최근 n일 변화율(%) */
function pctChange(closes: number[], days: number): number {
  if (closes.length <= days) return 0;
  const now = closes.at(-1)!;
  const then = closes[closes.length - 1 - days];
  return then ? ((now - then) / then) * 100 : 0;
}

function sma(closes: number[], n: number): number {
  if (!closes.length) return 0;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stdevPct(closes: number[], n = 20): number {
  const slice = closes.slice(-(n + 1));
  if (slice.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100;
}

function atr14(s: Series): number {
  const n = Math.min(14, s.closes.length - 1);
  if (n <= 1) return s.price * 0.02;
  let sum = 0;
  for (let i = s.closes.length - n; i < s.closes.length; i++) {
    const high = s.highs[i] ?? s.closes[i];
    const low = s.lows[i] ?? s.closes[i];
    const prev = s.closes[i - 1] ?? s.closes[i];
    sum += Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  }
  return sum / n || s.price * 0.02;
}

/* ── 1) 거시 신호 ─────────────────────────────── */

async function observeMacro(env: Env): Promise<MacroSignal[]> {
  const series = await getManySeries(env, MACRO.map((m) => m.symbol), "3mo");
  const out: MacroSignal[] = [];
  for (const factor of MACRO) {
    const s = series.find((x) => x.symbol.toUpperCase() === factor.symbol.toUpperCase());
    if (!s) continue;
    const change = pctChange(s.closes, 5);
    out.push({
      id: factor.id,
      nameKo: factor.nameKo,
      changePct: round(change, 2),
      value: round(clamp(change / factor.scale, -1, 1), 3),
      price: s.price,
      upMeansKo: factor.upMeansKo,
    });
  }
  return out;
}

/* ── 2) 온톨로지 전파 ─────────────────────────────── */

function propagate(ticker: UniverseTicker, macro: MacroSignal[]): { score: number; reasons: ScoreReason[] } {
  const byId = new Map(macro.map((m) => [m.id, m]));
  const contributions: { text: string; value: number }[] = [];
  let total = 0;

  for (const [sectorName, weight] of Object.entries(ticker.sectors) as [SectorId, number][]) {
    const sens = SENSITIVITY[sectorName] ?? {};
    for (const [macroId, sensitivity] of Object.entries(sens) as [MacroId, number][]) {
      const signal = byId.get(macroId);
      if (!signal || Math.abs(signal.value) < 0.05) continue;
      const contribution = weight * sensitivity * signal.value;
      total += contribution;
      if (Math.abs(contribution) >= 0.05) {
        contributions.push({
          text: `${signal.nameKo} ${signal.changePct >= 0 ? "+" : ""}${signal.changePct}% → ${sectorName} 민감도 ${sensitivity > 0 ? "+" : ""}${sensitivity}`,
          value: contribution,
        });
      }
    }
  }

  contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return {
    // 여러 요인이 겹쳐도 과도해지지 않게 눌러 준다
    score: clamp(total / 1.5, -1, 1),
    reasons: contributions.slice(0, 3).map((c) => ({
      kind: "ontology" as const,
      text: c.text,
      contribution: round(c.value, 3),
    })),
  };
}

/* ── 3) 가격 신호 ─────────────────────────────── */

function priceSignal(s: Series): { score: number; reasons: ScoreReason[]; volatility: number; atr: number } {
  const closes = s.closes;
  const mom5 = pctChange(closes, 5);
  const mom20 = pctChange(closes, 20);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const trend = ma20 ? ((s.price - ma20) / ma20) * 100 : 0;
  const align = ma60 ? ((ma20 - ma60) / ma60) * 100 : 0;
  const window = closes.slice(-20);
  const hi = Math.max(...window, s.price);
  const lo = Math.min(...window, s.price);
  const rangePos = hi > lo ? (s.price - lo) / (hi - lo) : 0.5;
  const vol20 = s.volumes.slice(-21, -1).filter((v) => v > 0);
  const avgVol = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const volRatio = avgVol ? (s.volumes.at(-1) ?? 0) / avgVol : 1;
  const volatility = stdevPct(closes, 20);

  const fMom5 = clamp(mom5 / 6, -1, 1);
  const fMom20 = clamp(mom20 / 15, -1, 1);
  const fTrend = clamp(trend / 6, -1, 1);
  const fAlign = clamp(align / 6, -1, 1);
  // 과열(밴드 상단 붙음)은 추격매수 위험이라 감점
  const fRange = rangePos > 0.96 ? -0.4 : rangePos < 0.08 ? -0.5 : clamp((rangePos - 0.3) / 0.5, -1, 1);
  const fVol = clamp((volRatio - 1) / 1.5, -0.5, 1);

  const score = clamp(
    (fMom5 * 0.9 + fMom20 * 1.1 + fTrend * 0.9 + fAlign * 0.5 + fRange * 0.6 + fVol * 0.4) / 4.4,
    -1,
    1,
  );

  return {
    score,
    volatility,
    atr: atr14(s),
    reasons: [
      { kind: "price", text: `20일 ${mom20 >= 0 ? "+" : ""}${round(mom20, 1)}% · 5일 ${mom5 >= 0 ? "+" : ""}${round(mom5, 1)}%`, contribution: round(fMom20 * 0.25, 3) },
      { kind: "price", text: `20일선 대비 ${trend >= 0 ? "+" : ""}${round(trend, 1)}% · 밴드 ${Math.round(rangePos * 100)}%`, contribution: round(fTrend * 0.2, 3) },
      { kind: "price", text: `거래량 평균의 ${round(volRatio, 2)}배 · 일변동성 ${round(volatility, 2)}%`, contribution: round(fVol * 0.1, 3) },
    ],
  };
}

/* ── 합성 ─────────────────────────────── */

export async function runStrategy(env: Env): Promise<StrategyResult> {
  const [macro, priceSeries, newsResult] = await Promise.all([
    observeMacro(env),
    getManySeries(env, UNIVERSE.map((t) => t.symbol), "6mo"),
    getNews(env, "KR", "대한민국").catch(() => null),
  ]);

  const news: NewsItem[] = newsResult?.data.items ?? [];
  const bySymbol = new Map(priceSeries.map((s) => [s.symbol.toUpperCase(), s]));

  const vix = macro.find((m) => m.id === "VIX")?.value ?? 0;
  const kospi = macro.find((m) => m.id === "KOSPI")?.value ?? 0;
  // 변동성이 튀고 지수가 밀리면 위험회피 국면으로 본다
  const riskOff = round(clamp(vix * 0.6 - kospi * 0.6, 0, 1), 2);

  const scores: TickerScore[] = [];
  for (const t of UNIVERSE) {
    const s = bySymbol.get(t.symbol.toUpperCase());
    if (!s || s.closes.length < 30) continue;

    const onto = propagate(t, macro);
    const price = priceSignal(s);
    const sent = scoreForTicker(news, [t.nameKo, ...t.aliases]);
    const newsScore = sent.hits ? clamp(sent.score, -1, 1) : 0;

    // 온톨로지 0.35 · 가격 0.45 · 뉴스 0.20
    const composite = clamp(onto.score * 0.35 + price.score * 0.45 + newsScore * 0.2, -1, 1);

    const reasons = [...onto.reasons, ...price.reasons];
    if (sent.hits) {
      reasons.push({
        kind: "news",
        text: `관련 기사 ${sent.hits}건 (긍정 ${sent.positive}·부정 ${sent.negative})`,
        contribution: round(newsScore * 0.2, 3),
      });
    }

    scores.push({
      code: t.code,
      symbol: s.symbol,
      nameKo: t.nameKo,
      price: s.price,
      changePct: s.changePct,
      score: round(composite, 3),
      ontologyScore: round(onto.score, 3),
      priceScore: round(price.score, 3),
      newsScore: round(newsScore, 3),
      volatility: round(price.volatility, 2),
      atr: round(price.atr, 1),
      reasons,
    });
  }

  scores.sort((a, b) => b.score - a.score);

  const top = macro
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((m) => `${m.nameKo} ${m.changePct >= 0 ? "+" : ""}${m.changePct}%`)
    .join(", ");

  return {
    generatedAt: Date.now(),
    macro,
    scores,
    riskOff,
    note: `거시 상위 변동: ${top || "없음"} · 위험회피 지수 ${riskOff}`,
  };
}

/** 지수 시세 한 건 (자동매매 상태 화면용) */
export async function kospiSnapshot(env: Env) {
  const s = await getSeries(env, "^KS11", "5d").catch(() => null);
  return s ? { price: s.price, changePct: s.changePct } : null;
}
