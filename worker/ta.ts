/**
 * 기술적 분석 API — shared/ta.ts 의 전략 판정을 종목 단위로 제공한다.
 *
 * 스캔(퀀트 트랙)과 달리 **요청이 올 때만 계산한다.** 전략 13종은 사용자가 특정
 * 종목을 눌렀을 때 보는 화면이지, 전 종목을 주기적으로 돌려 둘 이유가 없다.
 * 크론 서브리퀘스트 예산(50)을 여기에 쓰면 자동매매가 밀린다.
 *
 * 차트를 그릴 원본 시세도 같이 내려준다 — 화면이 지표를 다시 계산하지 않게 하려는 것이다.
 * 서버와 화면이 각자 계산하면 눈에 보이는 선과 판정 근거가 어긋날 수 있다.
 */
import type { Env } from "./env";
import { analyze, adxSeries, bollinger, macdSeries, rsiSeries, smaSeries, supertrend, type TaReport } from "../shared/ta";
import { getSeries } from "./quotes";
import { cached, round } from "./util";

export interface TaResponse extends TaReport {
  symbol: string;
  name: string;
  currency: string;
  changePct: number;
  asOf: number;
  /** 차트용 — 최근 N일 */
  chart: {
    t: number[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
    ma20: number[];
    ma60: number[];
    bbUpper: number[];
    bbLower: number[];
    rsi: number[];
    macd: number[];
    macdSignal: number[];
    macdHist: number[];
    adx: number[];
    pdi: number[];
    mdi: number[];
    supertrend: number[];
    stTrend: number[];
  };
}

/** NaN 은 JSON 에서 null 이 되어 버리므로 화면이 다루기 쉽게 미리 null 로 만든다 */
const clean = (a: number[], digits = 2): (number | null)[] =>
  a.map((v) => (typeof v === "number" && Number.isFinite(v) ? round(v, digits) : null)) as (number | null)[];

export async function taReport(env: Env, symbol: string, days = 180): Promise<TaResponse> {
  // 2년치를 받아 계산하고 화면에는 최근 구간만 내려준다.
  // 200일선·52주 고저는 짧은 데이터로는 아예 계산이 안 된다.
  const s = await getSeries(env, symbol, "2y");
  const hist = { price: s.price, closes: s.closes, highs: s.highs, lows: s.lows, volumes: s.volumes };
  const rep = analyze(hist);

  const n = s.closes.length;
  const from = Math.max(0, n - days);
  const cut = <T>(a: T[]): T[] => a.slice(from);

  const bb = bollinger(s.closes, 20, 2);
  const m = macdSeries(s.closes);
  const a = adxSeries(s.highs, s.lows, s.closes);
  const st = supertrend(s.highs, s.lows, s.closes, 10, 3);

  return {
    ...rep,
    symbol: s.symbol,
    name: s.name,
    currency: s.currency,
    changePct: s.changePct,
    asOf: s.time,
    chart: {
      // 야후 차트에서 시각 배열은 quotes 계층이 버리므로 인덱스를 그대로 쓴다
      t: cut(s.closes.map((_, i) => i)),
      open: cut(s.closes.map((v, i) => s.closes[i - 1] ?? v)),
      high: cut(s.highs),
      low: cut(s.lows),
      close: cut(s.closes),
      volume: cut(s.volumes),
      ma20: cut(clean(smaSeries(s.closes, 20), 0)) as number[],
      ma60: cut(clean(smaSeries(s.closes, 60), 0)) as number[],
      bbUpper: cut(clean(bb.upper, 0)) as number[],
      bbLower: cut(clean(bb.lower, 0)) as number[],
      rsi: cut(clean(rsiSeries(s.closes, 14), 1)) as number[],
      macd: cut(clean(m.macd)) as number[],
      macdSignal: cut(clean(m.signal)) as number[],
      macdHist: cut(clean(m.hist)) as number[],
      adx: cut(clean(a.adx, 1)) as number[],
      pdi: cut(clean(a.pdi, 1)) as number[],
      mdi: cut(clean(a.mdi, 1)) as number[],
      supertrend: cut(clean(st.line, 0)) as number[],
      stTrend: cut(clean(st.trend, 0)) as number[],
    },
  };
}

export async function taCached(env: Env, symbol: string, days = 180): Promise<TaResponse> {
  // 일봉 기반이라 장중에도 몇 분 단위면 충분하다
  const { data } = await cached(env, `ta:${symbol}:${days}`, 180, () => taReport(env, symbol, days));
  return data;
}
