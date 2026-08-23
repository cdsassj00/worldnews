export interface MinuteBar {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 0%는 신규 진입만 끄는 값이다. 이미 낸 주문이나 보유 단타 포지션이 있으면
 * 손절·체결확인·당일청산이 끝날 때까지 사이클을 계속 돌려야 한다.
 */
export function shouldRunScalpCycle(pct: number, hasPosition: boolean, hasPending: boolean): boolean {
  return pct > 0 || hasPosition || hasPending;
}

export interface ScalpSignal {
  enter: boolean;
  score: number;
  vwap: number;
  openingHigh: number;
  volumeRatio: number;
  reason: string;
}

const round = (v: number, d = 4) => Number(v.toFixed(d));

/** 5분 시초범위 돌파 + VWAP + 거래량 확인. 입력은 시간 오름차순 1분봉이다. */
export function scalpEntrySignal(input: MinuteBar[]): ScalpSignal {
  const bars = input.filter((b) => b.close > 0 && b.volume >= 0).sort((a, b) => a.at - b.at);
  if (bars.length < 12) return { enter: false, score: 0, vwap: 0, openingHigh: 0, volumeRatio: 0, reason: "분봉 12개 미만" };
  const opening = bars.slice(0, 5);
  const openingHigh = Math.max(...opening.map((b) => b.high));
  const latest = bars[bars.length - 1];
  const prior = bars.slice(Math.max(5, bars.length - 11), -1);
  const avgVol = prior.reduce((s, b) => s + b.volume, 0) / Math.max(1, prior.length);
  const volumeRatio = avgVol > 0 ? latest.volume / avgVol : 0;
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  const vwap = vol > 0 ? pv / vol : latest.close;
  const breakoutPct = openingHigh > 0 ? ((latest.close - openingHigh) / openingHigh) * 100 : 0;
  const aboveVwapPct = vwap > 0 ? ((latest.close - vwap) / vwap) * 100 : 0;
  const enter = breakoutPct >= 0.1 && aboveVwapPct >= 0 && aboveVwapPct <= 1.5 && volumeRatio >= 1.5;
  const score = Math.max(-1, Math.min(1, breakoutPct / 0.8 + (volumeRatio - 1) / 3 + aboveVwapPct / 2));
  return {
    enter,
    score: round(score, 3),
    vwap: round(vwap, 4),
    openingHigh: round(openingHigh, 4),
    volumeRatio: round(volumeRatio, 2),
    reason: enter
      ? `시초범위 +${round(breakoutPct, 2)}% 돌파 · VWAP 위 +${round(aboveVwapPct, 2)}% · 거래량 ${round(volumeRatio, 1)}배`
      : `대기: 돌파 ${round(breakoutPct, 2)}% · VWAP ${round(aboveVwapPct, 2)}% · 거래량 ${round(volumeRatio, 1)}배`,
  };
}

export function scalpExitReason(args: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  enteredAt: number;
  now: number;
  vwap?: number;
}): string | null {
  const { entryPrice, currentPrice, peakPrice, enteredAt, now, vwap } = args;
  if (entryPrice <= 0 || currentPrice <= 0) return null;
  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const peakPct = ((peakPrice - entryPrice) / entryPrice) * 100;
  const fromPeakPct = peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;
  if (pnlPct <= -0.8) return `단타 손절 ${round(pnlPct, 2)}%`;
  if (pnlPct >= 1.3) return `단타 익절 +${round(pnlPct, 2)}%`;
  if (peakPct >= 0.8 && fromPeakPct <= -0.4) return `단타 추적청산: 고점 대비 ${round(fromPeakPct, 2)}%`;
  if (vwap && currentPrice < vwap && pnlPct < 0) return `VWAP 재이탈 ${round(pnlPct, 2)}%`;
  if (now - enteredAt >= 30 * 60_000) return `30분 시간청산 ${round(pnlPct, 2)}%`;
  return null;
}
