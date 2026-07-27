/**
 * 점수 계산의 순수 함수 모음.
 *
 * 여기에 모아 둔 이유는 하나다 — **백테스트가 운영과 똑같은 코드를 돌려야 하기 때문**이다.
 * 실전은 worker/strategy.ts, 검증은 scripts/backtest.ts 로 진입점이 다르지만
 * 점수를 만드는 계산은 이 파일 하나를 공유한다. 여기서 갈라지면 백테스트 결과는 의미가 없다.
 *
 * 그래서 이 파일은 네트워크·KV·Env 를 모른다. 숫자 배열만 받아 숫자를 돌려준다.
 */
import { MACRO, SENSITIVITY, type MacroFactor, type MacroId, type SectorId, type UniverseTicker } from "./ontology";

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function round(v: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** 점수 계산에 필요한 최소한의 일봉 히스토리 */
export interface PriceHistory {
  /** 현재가(또는 최종 종가) */
  price: number;
  /** 일봉 종가 (오래된 → 최신) */
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
}

export interface MacroSignal {
  id: MacroId;
  nameKo: string;
  changePct: number;
  /** -1 ~ 1 로 정규화한 신호 세기 (가격 관측) */
  value: number;
  price: number;
  upMeansKo: string;
  /** 1면·거시 뉴스를 AI가 해석한 보정 (-1~1). 가격은 이미 일어난 일, 뉴스는 일어나는 중인 일이다. */
  newsImpact?: number;
  newsReason?: string;
}

/** 전파에 쓰는 유효 신호 = 가격 관측 + 뉴스 보정×0.4 (백테스트에는 뉴스 보정이 없어 가격 관측만 쓰인다) */
export function effectiveValue(m: MacroSignal): number {
  return clamp(m.value + 0.4 * (m.newsImpact ?? 0), -1, 1);
}

export interface ScoreReason {
  kind: "ontology" | "price" | "news";
  text: string;
  contribution: number;
}

/* ── 기본 통계 ─────────────────────────────── */

/** 최근 n일 변화율(%) */
export function pctChange(closes: number[], days: number): number {
  if (closes.length <= days) return 0;
  const now = closes.at(-1)!;
  const then = closes[closes.length - 1 - days];
  return then ? ((now - then) / then) * 100 : 0;
}

export function sma(closes: number[], n: number): number {
  if (!closes.length) return 0;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** 일간 수익률 표준편차(%) */
export function stdevPct(closes: number[], n = 20): number {
  const slice = closes.slice(-(n + 1));
  if (slice.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100;
}

export function atr14(s: PriceHistory): number {
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

/** 종가 배열 하나를 거시 신호 한 건으로 변환 (5일 변화율 ÷ 기준폭) */
export function macroSignal(factor: MacroFactor, history: PriceHistory): MacroSignal {
  const change = pctChange(history.closes, 5);
  return {
    id: factor.id,
    nameKo: factor.nameKo,
    changePct: round(change, 2),
    value: round(clamp(change / factor.scale, -1, 1), 3),
    price: history.price,
    upMeansKo: factor.upMeansKo,
  };
}

/** 심볼 → 히스토리 조회 함수를 받아 거시 신호 전체를 만든다 */
export function macroSignals(lookup: (symbol: string) => PriceHistory | undefined): MacroSignal[] {
  const out: MacroSignal[] = [];
  for (const factor of MACRO) {
    const h = lookup(factor.symbol);
    if (!h || h.closes.length < 6) continue;
    out.push(macroSignal(factor, h));
  }
  return out;
}

/* ── 2) 온톨로지 전파 ─────────────────────────────── */

/**
 * 거시 신호를 섹터 민감도를 타고 종목까지 전파한다.
 * 기여도 = 섹터비중 × 민감도 × 신호세기. 경로를 문장으로 남겨 설명 가능하게 한다.
 */
export function propagate(
  ticker: UniverseTicker,
  macro: MacroSignal[],
): { score: number; reasons: ScoreReason[]; edges: { macroId: MacroId; sector: SectorId; contribution: number }[] } {
  const byId = new Map(macro.map((m) => [m.id, m]));
  const contributions: { text: string; value: number }[] = [];
  const edges: { macroId: MacroId; sector: SectorId; contribution: number }[] = [];
  let total = 0;

  for (const [sectorName, weight] of Object.entries(ticker.sectors) as [SectorId, number][]) {
    const sens = SENSITIVITY[sectorName] ?? {};
    for (const [macroId, sensitivity] of Object.entries(sens) as [MacroId, number][]) {
      const signal = byId.get(macroId);
      if (!signal) continue;
      const v = effectiveValue(signal);
      if (Math.abs(v) < 0.05) continue;
      const contribution = weight * sensitivity * v;
      total += contribution;
      edges.push({ macroId, sector: sectorName, contribution: round(contribution, 3) });
      if (Math.abs(contribution) >= 0.05) {
        contributions.push({
          text: `${signal.nameKo} ${signal.changePct >= 0 ? "+" : ""}${signal.changePct}% → ${sectorName} 민감도 ${sensitivity > 0 ? "+" : ""}${sensitivity}`,
          value: contribution,
        });
      }
    }
  }

  contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  edges.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    // 여러 요인이 겹쳐도 과도해지지 않게 눌러 준다
    score: clamp(total / 1.5, -1, 1),
    reasons: contributions.slice(0, 3).map((c) => ({
      kind: "ontology" as const,
      text: c.text,
      contribution: round(c.value, 3),
    })),
    edges,
  };
}

/* ── 3) 가격 신호 ─────────────────────────────── */

export function priceSignal(s: PriceHistory): {
  score: number;
  reasons: ScoreReason[];
  volatility: number;
  atr: number;
} {
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

export const WEIGHTS = { ontology: 0.35, price: 0.45, news: 0.2 } as const;

export function composite(ontologyScore: number, priceScore: number, newsScore: number): number {
  return clamp(
    ontologyScore * WEIGHTS.ontology + priceScore * WEIGHTS.price + newsScore * WEIGHTS.news,
    -1,
    1,
  );
}

/** VIX 상승 + 지수 하락 = 위험회피 국면 */
export function riskOffFrom(macro: MacroSignal[]): number {
  const vix = macro.find((m) => m.id === "VIX")?.value ?? 0;
  const kospi = macro.find((m) => m.id === "KOSPI")?.value ?? 0;
  return round(clamp(vix * 0.6 - kospi * 0.6, 0, 1), 2);
}
