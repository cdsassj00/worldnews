/**
 * 종목별 가격 레벨 — 지지·저항·이동평균·52주 고저·변동성·거래량 (2026-09-04 유튜브
 * 파이프라인 요청 1번). "얼마에 사서 얼마에 손절인지" 절대 가격을 요구했다.
 *
 * 원칙: 계산 근거가 있는 것만 낸다. 지지·저항은 스윙 피벗(전후 N봉보다 낮은/높은 값)을
 * 찾아 가까운 가격끼리 묶고, **실제로 두 번 이상 부딪힌 자리만** 지지·저항으로 인정한다.
 * 한 번만 스친 가격을 "지지선"이라 부르는 건 근거 없는 숫자를 만드는 것과 같다 —
 * 후보가 없으면 그 방향은 빈 배열을 낸다(추정으로 채우지 않는다).
 */
import type { Series } from "./quotes";
import { smaSeries, atrSeries } from "../shared/ta";
import { round } from "../shared/scoring";

export interface LevelPoint {
  price: number;
  /** 이 가격대에서 스윙 피벗이 부딪힌 횟수 */
  touches: number;
  /** 가장 최근에 이 자리를 시험한 날짜(그 시장 로컬 날짜, YYYY-MM-DD) */
  lastTouchDate: string | null;
}

export interface Levels {
  support: LevelPoint[];
  resistance: LevelPoint[];
  ma: { ma5: number | null; ma20: number | null; ma60: number | null; ma120: number | null };
  week52: { high: number; low: number };
  atr14: number | null;
  volume: { today: number; avg20: number | null };
  /** 지지·저항 후보 중 가장 근거가 좋은(터치 수 많은) 자리 한 줄 설명 — 없으면 null */
  levelNote: string | null;
}

function fmtDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function monthLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, month: "long" }).format(new Date(ms));
}

/** 스윙 피벗 — 전후 margin봉보다 낮은 저점 / 높은 고점만 피벗으로 본다 */
function findPivots(values: number[], margin: number, mode: "low" | "high"): number[] {
  const idx: number[] = [];
  for (let i = margin; i < values.length - margin; i++) {
    const window = values.slice(i - margin, i + margin + 1);
    const extreme = mode === "low" ? Math.min(...window) : Math.max(...window);
    if (values[i] === extreme) idx.push(i);
  }
  return idx;
}

/** 가까운 피벗끼리(가격 차이 tolerancePct 이내) 묶어 "같은 자리"로 취급한다 */
function clusterPivots(pivotIdx: number[], values: number[], timestamps: number[], tolerancePct: number, dp: number): LevelPoint[] {
  if (!pivotIdx.length) return [];
  const sorted = [...pivotIdx].sort((a, b) => values[a] - values[b]);
  const clusters: { idxs: number[] }[] = [];
  for (const i of sorted) {
    const last = clusters.at(-1);
    if (last) {
      const clusterAvg = last.idxs.reduce((s, j) => s + values[j], 0) / last.idxs.length;
      if (Math.abs(values[i] - clusterAvg) / clusterAvg <= tolerancePct) {
        last.idxs.push(i);
        continue;
      }
    }
    clusters.push({ idxs: [i] });
  }
  return clusters
    .filter((c) => c.idxs.length >= 2) // 두 번 이상 부딪힌 자리만 인정
    .map((c) => {
      const price = round(c.idxs.reduce((s, j) => s + values[j], 0) / c.idxs.length, dp);
      const lastIdx = c.idxs.reduce((a, b) => (timestamps[a] > timestamps[b] ? a : b));
      return { price, touches: c.idxs.length, lastTouchDate: timestamps[lastIdx] ? fmtDate(timestamps[lastIdx], "Asia/Seoul") : null };
    });
}

/**
 * @param series 1y 일봉(closes/highs/lows/volumes/timestamps 인덱스 정렬됨)
 * @param currentPrice 지금 가격 — 이 값 기준으로 지지(아래)·저항(위)을 가른다
 * @param tz 날짜 라벨용 시간대(한국="Asia/Seoul", 미국="America/New_York")
 */
export function computeLevels(series: Series, currentPrice: number, tz: string): Levels | null {
  const { closes, highs, lows, volumes, timestamps } = series;
  // highs/lows/volumes 는 quotes.ts 에서 독립적으로 null 을 걸러 만들어져 closes 와 길이가
  // 다를 수 있다 — 셋 다 같은 길이일 때만 안전하게 정렬돼 있다고 보고, 아니면 레벨 계산을 접는다
  // (틀린 지지선을 내느니 아예 안 내는 쪽이 안전하다).
  if (closes.length < 40 || highs.length !== closes.length || lows.length !== closes.length) return null;

  // 원화는 소수점이 없다 — "36,168.18원" 같은 값은 계산이 아니라 표시 실수로 읽힌다.
  // 통화 판별은 currency 문자열이 없을 수도 있어(스파크 API 폴백) tz 로도 보정한다.
  const dp = series.currency === "USD" || tz === "America/New_York" ? 2 : 0;
  const ma = (n: number) => {
    const s = smaSeries(closes, n);
    const v = s.at(-1);
    return v !== undefined && !Number.isNaN(v) ? round(v, dp) : null;
  };
  const atr = atrSeries(highs, lows, closes, 14).at(-1);

  const lowPivots = findPivots(lows, 3, "low");
  const highPivots = findPivots(highs, 3, "high");
  const tolerancePct = 0.015; // 1.5% 이내면 "같은 자리"
  const supportAll = clusterPivots(lowPivots, lows, timestamps, tolerancePct, dp).filter((p) => p.price < currentPrice);
  const resistanceAll = clusterPivots(highPivots, highs, timestamps, tolerancePct, dp).filter((p) => p.price > currentPrice);
  const rank = (a: LevelPoint, b: LevelPoint) => b.touches - a.touches || Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  const support = supportAll.sort(rank).slice(0, 2);
  const resistance = resistanceAll.sort(rank).slice(0, 2);

  const best = [...support, ...resistance].sort((a, b) => b.touches - a.touches)[0];
  const levelNote = best
    ? `${best.price.toLocaleString("ko-KR")}은 최근 ${best.touches}번 ${support.includes(best) ? "지지" : "저항"}받은 자리${best.lastTouchDate ? `(최근 ${monthLabel(new Date(best.lastTouchDate).getTime(), tz)})` : ""}입니다`
    : null;

  const vol20 = volumes.length >= 21 ? volumes.slice(-21, -1) : null;

  return {
    support,
    resistance,
    ma: { ma5: ma(5), ma20: ma(20), ma60: ma(60), ma120: ma(120) },
    week52: { high: round(Math.max(...highs.slice(-252)), dp), low: round(Math.min(...lows.slice(-252)), dp) },
    atr14: atr !== undefined && !Number.isNaN(atr) ? round(atr, dp) : null,
    volume: {
      today: volumes.at(-1) ?? 0,
      avg20: vol20 ? Math.round(vol20.reduce((s, v) => s + v, 0) / vol20.length) : null,
    },
    levelNote,
  };
}

/**
 * 가장 가까운 지지·저항 — 손절·목표로 실제로 쓸 자리.
 *
 * computeLevels 의 support/resistance 는 "많이 부딪힌 순"이라 몇 달 전 바닥이 잡히곤 한다
 * (현재가 56,000원인데 지지 36,168원 같은 값). 살아 있는 지지·저항으로 널리 쓰이는
 * 이동평균·52주 고저까지 후보에 넣고 **먼저 닿는 자리**를 고른다.
 *
 * 스윙 목록(swing.ts)과 차트 화면(scenes.ts)이 이 함수를 함께 쓴다 — 한 공지 안에서
 * 글과 그림이 다른 지지선을 말하면 그 순간 둘 다 못 믿을 숫자가 된다.
 */
export function nearestLevels(lv: Levels | null, price: number): {
  support: { price: number; label: string } | null;
  resistance: { price: number; label: string } | null;
} {
  if (!lv || !price) return { support: null, resistance: null };
  /* 라벨에 지지/저항을 박지 않는다 — 한 번 저항이던 자리가 뚫리면 지지가 된다.
   * 그대로 두면 "지지 21,588 (4번 저항받은 자리)" 처럼 자기모순인 문장이 나간다
   * (2026-09-11 실측). 역할은 현재가 대비 위/아래로 이미 정해지므로 여기선 횟수만 말한다. */
  const cands: { price: number; label: string }[] = [
    ...lv.support.map((s) => ({ price: s.price, label: `${s.touches}번 부딪힌 자리` })),
    ...lv.resistance.map((s) => ({ price: s.price, label: `${s.touches}번 부딪힌 자리` })),
    ...(lv.ma.ma5 ? [{ price: lv.ma.ma5, label: "5일선" }] : []),
    ...(lv.ma.ma20 ? [{ price: lv.ma.ma20, label: "20일선" }] : []),
    ...(lv.ma.ma60 ? [{ price: lv.ma.ma60, label: "60일선" }] : []),
    ...(lv.ma.ma120 ? [{ price: lv.ma.ma120, label: "120일선" }] : []),
    ...(lv.week52.low ? [{ price: lv.week52.low, label: "52주 최저" }] : []),
    ...(lv.week52.high ? [{ price: lv.week52.high, label: "52주 최고" }] : []),
  ];
  /* 저항은 잡음을 피해 현재가 +2%(또는 0.8×ATR) 밖에서 찾는다 — shared/ta.ts tradePlan 과 같은 기준.
   * 지지는 가까울수록 손절 기준으로 쓸모가 있어 그대로 가장 가까운 것을 쓴다. */
  const minGap = Math.max(price * 0.02, (lv.atr14 ?? 0) * 0.8);
  const below = cands.filter((c) => c.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
  const above = cands.filter((c) => c.price > price + minGap).sort((a, b) => a.price - b.price)[0] ?? null;
  return { support: below, resistance: above };
}
