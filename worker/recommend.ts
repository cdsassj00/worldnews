import type { Env } from "./env";
import type { MarketInfo, Ticker } from "../shared/markets";
import type { Series } from "./quotes";
import { getManySeries } from "./quotes";
import type { NewsItem } from "./news";
import { scoreForTicker, scoreText } from "./sentiment";
import { clamp, round } from "./util";

export type Action = "BUY" | "ACCUMULATE" | "WATCH" | "REDUCE" | "SELL";

export interface Factor {
  key: string;
  label: string;
  /** -1 ~ 1 정규화 값 */
  value: number;
  weight: number;
  /** 사람이 읽는 근거 */
  text: string;
}

export interface Recommendation {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  changePct: number;
  score: number;
  action: Action;
  actionKo: string;
  confidence: number;
  factors: Factor[];
  /** 진입/손절/목표 (ATR 기반) */
  plan: {
    entry: number;
    stop: number;
    target: number;
    riskPerShare: number;
    rewardPerShare: number;
    rr: number;
    stopPct: number;
    targetPct: number;
  };
  atr: number;
  /** 한국투자증권 주문 가능 여부 */
  orderable: boolean;
  kis?: { market: string; code: string };
  newsHits: number;
}

export interface RecommendResult {
  cc: string;
  generatedAt: number;
  marketBias: { score: number; text: string };
  items: Recommendation[];
  universe: number;
  disclaimer: string;
}

const DISCLAIMER =
  "이 화면의 점수·의견은 가격 지표와 공개 뉴스 키워드로 계산한 참고 자료입니다. 투자 자문이 아니며 어떤 수익도 보장하지 않습니다. 최종 매매 판단과 책임은 이용자 본인에게 있습니다.";

function pctChange(closes: number[], days: number): number {
  if (closes.length <= days) return 0;
  const now = closes.at(-1)!;
  const then = closes[closes.length - 1 - days];
  if (!then) return 0;
  return ((now - then) / then) * 100;
}

function sma(closes: number[], n: number): number {
  if (closes.length < n) return closes.reduce((a, b) => a + b, 0) / Math.max(1, closes.length);
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function atr14(s: Series): number {
  const n = Math.min(14, s.closes.length - 1, s.highs.length - 1, s.lows.length - 1);
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

function stdevPct(closes: number[], n = 20): number {
  const slice = closes.slice(-(n + 1));
  if (slice.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * 100;
}

function actionFor(score: number): { action: Action; ko: string } {
  if (score >= 1.15) return { action: "BUY", ko: "매수 우선 검토" };
  if (score >= 0.45) return { action: "ACCUMULATE", ko: "분할 매수" };
  if (score > -0.45) return { action: "WATCH", ko: "관망" };
  if (score > -1.15) return { action: "REDUCE", ko: "비중 축소" };
  return { action: "SELL", ko: "매도 검토" };
}

function evaluate(t: Ticker, s: Series, news: NewsItem[], marketBias: number): Recommendation {
  const closes = s.closes;
  const mom5 = pctChange(closes, 5);
  const mom20 = pctChange(closes, 20);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const trend = ma20 ? ((s.price - ma20) / ma20) * 100 : 0;
  const longTrend = ma60 ? ((ma20 - ma60) / ma60) * 100 : 0;
  const window = closes.slice(-20);
  const hi = Math.max(...window, s.price);
  const lo = Math.min(...window, s.price);
  const rangePos = hi > lo ? (s.price - lo) / (hi - lo) : 0.5;
  const vol20 = s.volumes.slice(-21, -1).filter((v) => v > 0);
  const avgVol = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const lastVol = s.volumes.at(-1) ?? 0;
  const volRatio = avgVol ? lastVol / avgVol : 1;
  const vola = stdevPct(closes, 20);
  const sent = scoreForTicker(news, [t.name, ...(t.aliases ?? []), t.symbol.split(".")[0]]);

  // 정규화 (-1 ~ 1)
  const fMom5 = clamp(mom5 / 6, -1, 1);
  const fMom20 = clamp(mom20 / 15, -1, 1);
  const fTrend = clamp(trend / 6, -1, 1);
  const fLong = clamp(longTrend / 6, -1, 1);
  // 0.35~0.85 구간을 가장 높게, 과열(>0.95)·급락(<0.1)은 감점
  const fRange = rangePos > 0.95 ? -0.35 : rangePos < 0.1 ? -0.6 : clamp((rangePos - 0.3) / 0.5, -1, 1);
  const fVol = clamp((volRatio - 1) / 1.5, -0.6, 1);
  const fSent = sent.hits ? sent.score : marketBias * 0.5;
  const fRisk = -clamp((vola - 2.2) / 3, 0, 1); // 일변동성 2.2% 초과분은 위험 감점

  const factors: Factor[] = [
    { key: "mom5", label: "단기 모멘텀(5일)", value: round(fMom5, 2), weight: 0.9, text: `5일 ${mom5 >= 0 ? "+" : ""}${round(mom5, 2)}%` },
    { key: "mom20", label: "중기 모멘텀(20일)", value: round(fMom20, 2), weight: 1.1, text: `20일 ${mom20 >= 0 ? "+" : ""}${round(mom20, 2)}%` },
    { key: "trend", label: "20일선 대비", value: round(fTrend, 2), weight: 0.8, text: `20일선 대비 ${trend >= 0 ? "+" : ""}${round(trend, 2)}%` },
    { key: "longTrend", label: "20/60일선 배열", value: round(fLong, 2), weight: 0.5, text: `20일선이 60일선 대비 ${longTrend >= 0 ? "+" : ""}${round(longTrend, 2)}%` },
    { key: "range", label: "20일 밴드 위치", value: round(fRange, 2), weight: 0.6, text: `20일 고저 구간 ${Math.round(rangePos * 100)}% 지점` },
    { key: "volume", label: "거래량", value: round(fVol, 2), weight: 0.4, text: `20일 평균의 ${round(volRatio, 2)}배` },
    {
      key: "news",
      label: "뉴스 감성",
      value: round(fSent, 2),
      weight: 1.0,
      text: sent.hits
        ? `관련 기사 ${sent.hits}건 (긍정 ${sent.positive}·부정 ${sent.negative})`
        : "개별 기사 없음 → 시장 전반 감성 적용",
    },
    { key: "risk", label: "변동성 리스크", value: round(fRisk, 2), weight: 0.7, text: `일변동성 ${round(vola, 2)}%` },
  ];

  const score = factors.reduce((a, f) => a + f.value * f.weight, 0) / 2.5;
  const { action, ko } = actionFor(score * 2.5);

  const atr = atr14(s);
  const entry = s.price;
  const stop = round(Math.max(0.01, entry - atr * 2), 2);
  const target = round(entry + atr * 3, 2);
  const riskPerShare = round(entry - stop, 4);
  const rewardPerShare = round(target - entry, 4);

  return {
    symbol: s.symbol,
    name: t.name || s.name,
    currency: s.currency,
    price: s.price,
    changePct: s.changePct,
    score: round(score * 2.5, 2),
    action,
    actionKo: ko,
    confidence: round(clamp(Math.abs(score) * 100, 5, 95), 0),
    factors,
    plan: {
      entry: round(entry, 2),
      stop,
      target,
      riskPerShare,
      rewardPerShare,
      rr: riskPerShare > 0 ? round(rewardPerShare / riskPerShare, 2) : 0,
      stopPct: round(((stop - entry) / entry) * 100, 2),
      targetPct: round(((target - entry) / entry) * 100, 2),
    },
    atr: round(atr, 3),
    orderable: Boolean(t.kis),
    kis: t.kis,
    newsHits: sent.hits,
  };
}

export async function recommend(env: Env, market: MarketInfo, news: NewsItem[], indexSeries?: Series): Promise<RecommendResult> {
  const headlineSent = scoreText(news.slice(0, 20).map((n) => `${n.title} ${n.summary}`));
  const indexMom = indexSeries ? pctChange(indexSeries.closes, 5) : 0;
  const marketBias = clamp(headlineSent.score * 0.6 + clamp(indexMom / 4, -1, 1) * 0.4, -1, 1);

  const seriesList = await getManySeries(
    env,
    market.tickers.map((t) => t.symbol),
    "6mo",
  );
  const bySymbol = new Map(seriesList.map((s) => [s.symbol.toUpperCase(), s]));

  const items: Recommendation[] = [];
  for (const t of market.tickers) {
    const s = bySymbol.get(t.symbol.toUpperCase());
    if (!s || s.closes.length < 25) continue;
    items.push(evaluate(t, s, news, marketBias));
  }
  items.sort((a, b) => b.score - a.score);

  const biasText =
    marketBias > 0.25
      ? `뉴스·지수 흐름이 우호적입니다(지수 5일 ${round(indexMom, 2)}%, 뉴스 긍정 ${headlineSent.positive}·부정 ${headlineSent.negative}).`
      : marketBias < -0.25
        ? `시장 분위기가 부정적입니다(지수 5일 ${round(indexMom, 2)}%, 뉴스 긍정 ${headlineSent.positive}·부정 ${headlineSent.negative}). 신규 진입은 비중을 줄이세요.`
        : `중립 구간입니다(지수 5일 ${round(indexMom, 2)}%, 뉴스 긍정 ${headlineSent.positive}·부정 ${headlineSent.negative}). 종목별 선별 대응이 유효합니다.`;

  return {
    cc: market.cc,
    generatedAt: Date.now(),
    marketBias: { score: round(marketBias, 2), text: biasText },
    items,
    universe: market.tickers.length,
    disclaimer: DISCLAIMER,
  };
}

export { DISCLAIMER };
