/**
 * 퀀트 트랙 — **수급과 차트만으로** 점수를 낸다.
 *
 * 온톨로지 트랙(거시 인과 → 섹터 → 종목)과 의도적으로 분리한 두 번째 엔진이다.
 * 여기에는 거시 해석도, 뉴스도, 섹터 지식도 들어가지 않는다. 들어가는 것은 셋뿐이다.
 *
 *   ① 차트   — 추세(이평 정렬)·모멘텀·상대강도·밴드 위치
 *   ② 수급   — 자금흐름(MFI)·매집강도(CLV 누적)·거래대금 급증
 *   ③ 위험   — 변동성·과열 페널티
 *
 * 왜 나누나: 두 엔진은 **틀리는 방식이 다르다**. 온톨로지는 거시 해석이 틀리면
 * 전 종목이 같이 틀리고, 퀀트는 추세가 꺾이는 변곡점에서 틀린다. 한 계좌에서
 * 두 규칙을 섞으면 어느 쪽이 돈을 벌었는지 영영 알 수 없다. 그래서 자금·상태·
 * 성과를 따로 두고, 여기서는 점수 계산만 순수 함수로 제공한다.
 *
 * 이 파일은 네트워크·KV·Env 를 모른다 — 백테스트와 운영이 **같은 코드**를 쓰기 위해서다.
 */
import { clamp, round, sma, pctChange, atr14, stdevPct, type PriceHistory } from "./scoring";

/* ── 지표 ─────────────────────────────── */

/** Money Flow Index (자금흐름지수) — 가격×거래량으로 매수·매도 압력을 가른다. 0~100 */
export function mfi(s: PriceHistory, n = 14): number {
  const len = s.closes.length;
  if (len < n + 2) return 50;
  let pos = 0, neg = 0;
  for (let i = len - n; i < len; i++) {
    const tp = ((s.highs[i] ?? s.closes[i]) + (s.lows[i] ?? s.closes[i]) + s.closes[i]) / 3;
    const prevTp = ((s.highs[i - 1] ?? s.closes[i - 1]) + (s.lows[i - 1] ?? s.closes[i - 1]) + s.closes[i - 1]) / 3;
    const flow = tp * (s.volumes[i] ?? 0);
    if (tp > prevTp) pos += flow;
    else if (tp < prevTp) neg += flow;
  }
  if (pos + neg <= 0) return 50;
  return (pos / (pos + neg)) * 100;
}

/**
 * 매집강도 — CLV(Close Location Value) 가중 거래량의 최근 누적.
 * 종가가 그날 고가 쪽에서 마감할수록 "사는 쪽이 이겼다"고 본다.
 * 외국인·기관 순매수를 직접 볼 수 없는 구간에서 쓰는 수급 프록시다.
 */
export function accumulation(s: PriceHistory, n = 20): number {
  const len = s.closes.length;
  if (len < n + 1) return 0;
  let acc = 0, vol = 0;
  for (let i = len - n; i < len; i++) {
    const hi = s.highs[i] ?? s.closes[i];
    const lo = s.lows[i] ?? s.closes[i];
    const v = s.volumes[i] ?? 0;
    const clv = hi > lo ? ((s.closes[i] - lo) - (hi - s.closes[i])) / (hi - lo) : 0;
    acc += clv * v;
    vol += v;
  }
  return vol ? acc / vol : 0; // -1(전부 하단 마감) ~ +1(전부 상단 마감)
}

/** 거래대금 급증 배수 — 최근 5일 평균 대금 ÷ 이전 60일 평균 대금 */
export function turnoverSurge(s: PriceHistory): number {
  const len = s.closes.length;
  if (len < 66) return 1;
  const amt = (i: number) => s.closes[i] * (s.volumes[i] ?? 0);
  let recent = 0;
  for (let i = len - 5; i < len; i++) recent += amt(i);
  recent /= 5;
  let base = 0;
  for (let i = len - 65; i < len - 5; i++) base += amt(i);
  base /= 60;
  return base > 0 ? recent / base : 1;
}

/** 일평균 거래대금(원) — 유동성 필터용 */
export function avgTurnover(s: PriceHistory, n = 20): number {
  const len = s.closes.length;
  if (!len) return 0;
  const from = Math.max(0, len - n);
  let sum = 0;
  for (let i = from; i < len; i++) sum += s.closes[i] * (s.volumes[i] ?? 0);
  return sum / (len - from);
}

/* ── 점수 ─────────────────────────────── */

export interface QuantParts {
  /** 이평 정렬·이격 */
  trend: number;
  /** 5·20일 모멘텀 */
  momentum: number;
  /** 시장 대비 초과수익 */
  relStrength: number;
  /** MFI 기반 자금흐름 */
  moneyFlow: number;
  /** CLV 누적 매집강도 */
  accum: number;
  /** 거래대금 급증 */
  surge: number;
  /**
   * 돌파 — 20일 밴드 상단·60일 신고가 근접.
   * 첫 판에서는 이 자리를 "과열"로 감점했는데, 그러면 추세 상단을 달리는 주도주를
   * 체계적으로 피하고 뒤처진 종목만 사게 된다. 추세추종의 전제를 스스로 깨는 설계였다.
   * 그래서 부호를 프로파일이 정하도록 축을 분리했다(감점하고 싶으면 음수 가중치를 준다).
   */
  breakout: number;
  /** 과열·급락 페널티 (음수만) — 밴드 최하단 붕괴 같은 극단만 남긴다 */
  overheat: number;
  /** 실전에서만 붙는 실제 수급(외국인·기관 순매수) 보정 — 백테스트에서는 0 */
  realFlow: number;
}

export type QuantWeights = Record<keyof QuantParts, number>;

export interface QuantProfile {
  id: string;
  nameKo: string;
  weights: QuantWeights;
}

/**
 * 프로파일 — 같은 지표를 어떤 비중으로 볼 것인가.
 * 성과가 제일 좋은 하나를 고르려고 둔 게 아니라, **무엇이 성과를 만드는지**
 * 분리해 보려고 둔 것이다(차트만 / 수급만 / 섞기).
 */
export const QUANT_PROFILES: QuantProfile[] = [
  {
    id: "chart",
    nameKo: "차트 중심",
    weights: { trend: 1.2, momentum: 1.1, relStrength: 0.9, moneyFlow: 0.3, accum: 0.2, surge: 0.3, breakout: 0.4, overheat: 0.8, realFlow: 0 },
  },
  {
    id: "flow",
    nameKo: "수급 중심",
    weights: { trend: 0.4, momentum: 0.3, relStrength: 0.5, moneyFlow: 1.1, accum: 1.0, surge: 0.9, breakout: 0.1, overheat: 0.8, realFlow: 0 },
  },
  {
    id: "blend",
    nameKo: "수급+차트",
    weights: { trend: 0.9, momentum: 0.8, relStrength: 0.8, moneyFlow: 0.7, accum: 0.6, surge: 0.5, breakout: 0.3, overheat: 0.8, realFlow: 0 },
  },
  {
    id: "breakout",
    nameKo: "돌파(신고가+대금)",
    weights: { trend: 0.8, momentum: 0.6, relStrength: 0.7, moneyFlow: 0.3, accum: 0.4, surge: 1.0, breakout: 1.3, overheat: 0.3, realFlow: 0 },
  },
  {
    id: "meanrev",
    nameKo: "역추세(눌림목)",
    weights: { trend: 0.3, momentum: -0.6, relStrength: 0.4, moneyFlow: 0.8, accum: 0.9, surge: 0.4, breakout: -0.8, overheat: 0.3, realFlow: 0 },
  },
];

export function profileById(id: string): QuantProfile {
  return QUANT_PROFILES.find((p) => p.id === id) ?? QUANT_PROFILES[2];
}

export interface QuantInput {
  hist: PriceHistory;
  /** 시장 지수 종가 (상대강도용) — 없으면 상대강도 0 */
  market?: number[];
  /**
   * 실전 수급 보정 — 외국인·기관 순매수를 시가총액/거래대금 대비로 정규화한 -1~1 값.
   * 과거 재현이 불가능해 백테스트에서는 항상 undefined 다. 이 항의 가중치를
   * 프로파일에서 0 으로 두는 이유이기도 하다(검증되지 않은 축은 점수를 흔들지 않는다).
   */
  realFlow?: number;
}

export interface QuantSignal {
  score: number;
  parts: QuantParts;
  /** 사람이 읽는 근거 문장 */
  reasons: { text: string; contribution: number }[];
  atr: number;
  volatility: number;
  turnover: number;
  /** 진단용 원시값 */
  raw: { mom5: number; mom20: number; rs20: number; mfi: number; accum: number; surge: number; rangePos: number };
}

/**
 * 지표(parts) → 점수. 프로파일만 바꿔 가며 재계산할 수 있게 분리했다
 * (백테스트에서 프로파일 3개를 돌릴 때 지표를 세 번 계산하지 않으려고).
 *
 * 페널티(overheat)와 미검증 축(realFlow)은 분모에서 제외한다 —
 * 가중치를 0 으로 둔 축이 점수를 눌러 버리는 일이 없어야 한다.
 */
export function scoreFromParts(p: QuantParts, profile: QuantProfile): number {
  const w = profile.weights;
  const denom = Math.abs(w.trend) + Math.abs(w.momentum) + Math.abs(w.relStrength) + Math.abs(w.moneyFlow) + Math.abs(w.accum) + Math.abs(w.surge) + Math.abs(w.breakout) || 1;
  const positive =
    p.trend * w.trend + p.momentum * w.momentum + p.relStrength * w.relStrength +
    p.moneyFlow * w.moneyFlow + p.accum * w.accum + p.surge * w.surge + p.breakout * w.breakout;
  return round(clamp(positive / denom + p.overheat * w.overheat * 0.35 + p.realFlow * w.realFlow * 0.3, -1, 1), 3);
}

export function quantSignal(input: QuantInput, profile: QuantProfile): QuantSignal {
  const s = input.hist;
  const closes = s.closes;
  const price = s.price;

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const mom5 = pctChange(closes, 5);
  const mom20 = pctChange(closes, 20);

  // ① 추세 — 20일선 이격 + 20/60 정렬 + 5/20 정렬
  const gap20 = ma20 ? ((price - ma20) / ma20) * 100 : 0;
  const align = ma60 ? ((ma20 - ma60) / ma60) * 100 : 0;
  const alignFast = ma20 ? ((ma5 - ma20) / ma20) * 100 : 0;
  const trend = clamp((clamp(gap20 / 5, -1, 1) * 0.4 + clamp(align / 5, -1, 1) * 0.35 + clamp(alignFast / 3, -1, 1) * 0.25), -1, 1);

  // ② 모멘텀
  const momentum = clamp(clamp(mom5 / 6, -1, 1) * 0.45 + clamp(mom20 / 14, -1, 1) * 0.55, -1, 1);

  // ③ 상대강도 — 같은 기간 시장 대비 초과 수익
  let rs20 = 0;
  if (input.market && input.market.length > 21) {
    const m = input.market;
    const mkt = ((m.at(-1)! - m[m.length - 21]) / m[m.length - 21]) * 100;
    rs20 = mom20 - mkt;
  }
  const relStrength = clamp(rs20 / 8, -1, 1);

  // ④ 자금흐름 (MFI) — 50 이 중립. 85 이상은 과열이라 되돌린다.
  const mfiVal = mfi(s, 14);
  const moneyFlow = mfiVal > 85 ? clamp((100 - mfiVal) / 15 - 0.2, -1, 0.4) : clamp((mfiVal - 50) / 25, -1, 1);

  // ⑤ 매집강도
  const accVal = accumulation(s, 20);
  const accum = clamp(accVal * 2.5, -1, 1);

  // ⑥ 거래대금 급증 — 오르면서 대금이 붙어야 의미가 있다(하락 급증은 투매)
  const surgeRatio = turnoverSurge(s);
  const surgeRaw = clamp((surgeRatio - 1) / 1.2, -0.6, 1);
  const surge = mom5 >= 0 ? surgeRaw : -Math.abs(surgeRaw) * 0.6;

  // ⑦ 돌파 — 20일 밴드에서 어디에 있나 + 60일 신고가 근접
  const window = closes.slice(-20);
  const hi = Math.max(...window, price);
  const lo = Math.min(...window, price);
  const rangePos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  const hi60 = Math.max(...closes.slice(-60), price);
  const breakout = clamp((rangePos - 0.55) / 0.35 + (price >= hi60 * 0.995 ? 0.3 : 0), -1, 1);

  // ⑧ 극단 페널티 — 밴드 최하단을 뚫는 자리(떨어지는 칼)만 남긴다
  const overheat = rangePos < 0.05 ? -0.6 : 0;

  const realFlow = clamp(input.realFlow ?? 0, -1, 1);

  const parts: QuantParts = { trend, momentum, relStrength, moneyFlow, accum, surge, breakout, overheat, realFlow };
  const w = profile.weights;
  const denom = Math.abs(w.trend) + Math.abs(w.momentum) + Math.abs(w.relStrength) + Math.abs(w.moneyFlow) + Math.abs(w.accum) + Math.abs(w.surge) + Math.abs(w.breakout) || 1;
  const score = scoreFromParts(parts, profile);

  return {
    score,
    parts,
    atr: atr14(s),
    volatility: stdevPct(closes, 20),
    turnover: avgTurnover(s, 20),
    raw: { mom5: round(mom5, 2), mom20: round(mom20, 2), rs20: round(rs20, 2), mfi: round(mfiVal, 1), accum: round(accVal, 3), surge: round(surgeRatio, 2), rangePos: round(rangePos, 2) },
    reasons: [
      { text: `추세 — 20일선 ${gap20 >= 0 ? "+" : ""}${round(gap20, 1)}% · 20/60선 ${align >= 0 ? "정배열" : "역배열"}(${round(align, 1)}%)`, contribution: round(trend * w.trend / denom, 3) },
      { text: `수급 — 자금흐름지수 ${round(mfiVal, 0)} · 매집강도 ${round(accVal, 2)} · 거래대금 ${round(surgeRatio, 2)}배`, contribution: round((moneyFlow * w.moneyFlow + accum * w.accum + surge * w.surge) / denom, 3) },
      { text: `상대강도 — 20일 시장 대비 ${rs20 >= 0 ? "+" : ""}${round(rs20, 1)}%p · 밴드 위치 ${Math.round(rangePos * 100)}%`, contribution: round((relStrength * w.relStrength + breakout * w.breakout) / denom, 3) },
    ],
  };
}
