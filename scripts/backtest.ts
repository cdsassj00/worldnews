/**
 * 자동매매 백테스트.
 *
 * 목적은 "얼마 벌었나"가 아니라 **규칙이 의도대로 작동하는지**를 실제 가격으로 확인하는 것이다.
 * 점수 계산은 shared/scoring.ts 를 그대로 쓴다 — 운영과 다른 코드로 검증하면 의미가 없다.
 *
 * 재현 규칙
 *  - 매일 종가로 점수를 계산하고, **다음 거래일 시가**에 체결한다(같은 날 종가 체결은 미래를 보는 것이다).
 *  - 매수 슬리피지 +0.3%, 매도 -0.3%, 수수료·세금은 왕복 0.23%(증권거래세 0.18% + 수수료)로 잡는다.
 *  - 손절 -7% / 익절 +15% 는 장중 저가·고가로 판정한다(종가만 보면 실제보다 유리하게 나온다).
 *  - 원금 200만 · 종목당 25% · 1회 주문 50만 · 동시 5종목 · 하루 최대 6건 — 운영값과 동일.
 *  - 당일 -5% 신규매수 정지, 고점대비 -20% 영구 정지도 그대로 적용.
 *
 * 한계 (결과를 읽을 때 반드시 감안할 것)
 *  - **뉴스 축(가중치 0.20)은 0으로 둔다.** 과거 시점의 뉴스를 그때 그대로 재현할 수 없다.
 *    실전은 뉴스가 붙으므로 백테스트와 완전히 같은 판단이 나오지는 않는다.
 *  - 유니버스가 지금 살아 있는 20종목이라 생존편향이 있다(상장폐지·부진 종목이 빠져 있다).
 *  - 미체결·부분체결·호가 잔량은 무시한다. 대형주 소액 주문이라 영향은 작다고 본다.
 *
 * 실행: npx esbuild scripts/backtest.ts --bundle --platform=node --format=esm --outfile=/tmp/bt.mjs && node /tmp/bt.mjs
 */
import { MACRO, UNIVERSE as FULL_UNIVERSE, roundToTick, type MacroFactor, type UniverseTicker } from "../shared/ontology";

// 백테스트는 자동매매와 같은 대상(코어)만 돈다 — 확장층은 분석 전용이라 시뮬레이션 대상이 아니다.
const UNIVERSE = FULL_UNIVERSE.filter((t) => t.core);
import { composite, macroSignal, priceSignal, propagate, riskOffFrom, type MacroSignal, type PriceHistory } from "../shared/scoring";
import { levelLadder, tradePlan, trendState } from "../shared/ta";

/* ── 설정 ─────────────────────────── */

const CAPITAL = 2_000_000;
const MAX_POSITION_PCT = 25;
const MAX_ORDER_KRW = 500_000;
const MIN_ORDER_KRW = 30_000;
const MAX_POSITIONS = 5;
const MAX_TRADES_PER_DAY = 6;
const MAX_ORDERS_PER_CYCLE = 3;
const DAILY_LOSS_HALT_PCT = 5;
const MAX_DRAWDOWN_PCT = 20;
const BUY_SCORE = 0.35;
const SELL_SCORE = -0.05;
const SLIPPAGE = 0.003;
/** 왕복 거래비용 (매도 시 한 번에 반영) */
const ROUND_TRIP_COST = 0.0023;

const YEARS = Number(process.env.BT_YEARS ?? 2);
/**
 * 데이터 수집 구간과 **평가 구간은 다르다**.
 *
 * 점수 계산에 60일 이동평균이 들어가므로 앞의 60거래일은 워밍업으로 소모된다.
 * 예전에는 BT_RANGE=3mo 를 그대로 수집 구간으로 썼는데, 3개월 ≈ 63거래일이라
 * 워밍업을 빼면 매매 가능한 날이 3일밖에 남지 않았다 — "최근 3개월 성과"가 아니라
 * "3일 성과"를 본 셈이고, 그 결과로 시나리오 비교를 한 것은 잘못이었다.
 *
 * 그래서 수집은 항상 넉넉히(BT_RANGE, 기본 2y) 하고, **평가만 최근 BT_EVAL 구간**으로
 * 자른다. BT_EVAL=3mo 면 워밍업은 그 이전 데이터로 채우고 최근 3개월만 매매한다.
 */
const RANGE = process.env.BT_RANGE || `${YEARS}y`;
/** 평가 구간 — 3mo | 6mo | 1y | all (기본: 수집 구간 전체) */
const EVAL = process.env.BT_EVAL || "all";

/** 평가 시작일(YYYY-MM-DD) — 마지막 거래일에서 EVAL 만큼 뒤로 */
function evalStartDate(lastDate: string): string {
  const m = /^(\d+)(mo|y|d)$/.exec(EVAL);
  if (!m) return "0000-00-00"; // all
  const n = Number(m[1]);
  const d = new Date(lastDate + "T00:00:00Z");
  if (m[2] === "mo") d.setUTCMonth(d.getUTCMonth() - n);
  else if (m[2] === "y") d.setUTCFullYear(d.getUTCFullYear() - n);
  else d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 시나리오 — 무엇이 성과를 좌우하는지 **원인을 분리**하려고 둔 것이지
 * 제일 좋은 숫자를 고르려고 둔 게 아니다. 과최적화는 백테스트만 예뻐지고 실전은 무너진다.
 */
export interface Scenario {
  name: string;
  /** 손절: 고정 %(fixed) 또는 변동성 배수(atr) */
  /**
   * 손절 기준.
   *  fixed — 고정 %(모든 종목에 같은 자)
   *  atr   — 변동성 배수
   *  chart — **차트가 정한 자리**: 가장 가까운 지지선 아래 0.5×ATR (0.6~3×ATR 로 제한)
   *          익절도 위쪽 저항으로 잡는다. shared/ta.ts 의 levelLadder 를 그대로 쓴다.
   */
  stopMode: "fixed" | "atr" | "chart";
  stopPct: number;
  atrMult: number;
  /** 익절: 고정 % / 고점대비 추적 / 없음 */
  exitMode: "fixed" | "trail" | "none";
  takePct: number;
  trailPct: number;
  /** 점수가 SELL_SCORE 밑으로 떨어지면 매도 */
  signalExit: boolean;
  /** riskOff 가 이 값 이상이면 보유분 정리 (1 초과면 사실상 끔) */
  riskOffExit: number;
  /**
   * 교체 매매 — 보유 종목 중 최저 점수가 미보유 후보 최고 점수보다 이만큼 낮으면
   * 팔고 갈아탄다. 0 이면 끔. "안 되는 건 정리하고 될 법한 걸 산다"는 규칙의 검증판.
   */
  rotateGap?: number;
  /**
   * 국면 적응 — 시장이 하락 추세거나 위험회피가 높으면 단타 규칙(짧은 익절·빠른 손절·교체),
   * 상승 추세면 보유 규칙(추적손절·긴 익절)으로 자동 전환한다.
   * 판정은 그날까지의 데이터만 쓴다(미래 참조 없음).
   */
  adaptive?: { fast: Partial<Scenario>; slow: Partial<Scenario> };
  /** chart 모드에서 **손절만** 차트로 잡고 익절은 기존 규칙을 쓴다 */
  chartTargetOff?: boolean;
}

/**
 * 국면 판정 — 하락 국면인가.
 * 첫 시도(20일선 이탈 OR 모멘텀 OR 위험회피)는 너무 민감해 상승장 조정마다 단타로
 * 갈아타며 휩쓸렸다(1년 구간 -2.7%). 60일선 아래 **그리고** 20일 모멘텀 음수라는
 * AND 조건으로 둔감하게 바꾼다.
 */
function isDefensive(kospiCloses: number[], riskOff: number): boolean {
  if (kospiCloses.length < 21) return riskOff >= 0.5;
  const last = kospiCloses[kospiCloses.length - 1];
  const ma20 = kospiCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const mom20 = last / kospiCloses[kospiCloses.length - 21] - 1;
  // 20일선 아래이면서 20일 수익률도 마이너스일 때만 방어(단타) 모드.
  // OR 로 묶으면 상승장 조정마다 갈아타 휩쓸리고, 60일선으로 늦추면 하락장을 놓친다.
  return last < ma20 && mom20 < -0.01;
}

const SCENARIOS: Scenario[] = [
  { name: "현재 설정",            stopMode: "fixed", stopPct: 7,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "A 신호이탈 매도 제거",   stopMode: "fixed", stopPct: 7,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: false, riskOffExit: 0.8 },
  { name: "B 위험회피 매도 제거",   stopMode: "fixed", stopPct: 7,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 9 },
  { name: "C 익절 → 추적손절 8%",  stopMode: "fixed", stopPct: 7,  atrMult: 2,   exitMode: "trail", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "D 손절 → 변동성 2.5×ATR", stopMode: "atr",  stopPct: 7,  atrMult: 2.5, exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "E 손절 12% 완화",       stopMode: "fixed", stopPct: 12, atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "F 추적손절 + 이탈매도만", stopMode: "atr",  stopPct: 7,  atrMult: 2.5, exitMode: "trail", takePct: 15, trailPct: 10, signalExit: true,  riskOffExit: 9 },
  { name: "G 추적손절만 (거의 홀딩)", stopMode: "atr", stopPct: 7,  atrMult: 3,   exitMode: "trail", takePct: 15, trailPct: 12, signalExit: false, riskOffExit: 9 },
  /* 아래는 사용자 제안 검증: "손해나는 건 빨리 자르고 더 나은 종목으로 갈아탄다" */
  { name: "H 교체매매 (갭 0.3)",     stopMode: "fixed", stopPct: 7,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8, rotateGap: 0.3 },
  { name: "I 손절 -4% (빠른 손절)",   stopMode: "fixed", stopPct: 4,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "J 손절 -4% + 교체 0.3",   stopMode: "fixed", stopPct: 4,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8, rotateGap: 0.3 },
  { name: "K 손절 -4% + 교체 0.15",  stopMode: "fixed", stopPct: 4,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8, rotateGap: 0.15 },
  { name: "L 익절 +8% + 교체 0.3",   stopMode: "fixed", stopPct: 5,  atrMult: 2,   exitMode: "fixed", takePct: 8,  trailPct: 8,  signalExit: true,  riskOffExit: 0.8, rotateGap: 0.3 },
  /* N — 사용자 선택 2번: 현재 설정에서 손절만 -5% 로 (매도가 아예 안 나가는 문제 해소) */
  { name: "N 현재 + 손절 -5%",      stopMode: "fixed", stopPct: 5,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "N2 현재 + 손절 -6%",     stopMode: "fixed", stopPct: 6,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  /* P — 사용자 승인 A안: 손절·익절을 차트(지지·저항)가 정한다. 종목마다 다른 손절이 된다. */
  { name: "P 차트 손절·익절",        stopMode: "chart", stopPct: 5,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8 },
  { name: "P2 차트 + 이탈매도 제거",  stopMode: "chart", stopPct: 5,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: false, riskOffExit: 0.8 },
  /* P3 — 손절만 차트, 익절은 기존 +15% 유지.
   * P/P2 가 진 원인이 "변동성 맞춤 손절"인지 "가까운 저항으로 익절을 당긴 것"인지
   * 분리해야 한다. 둘을 같이 바꾸면 어느 쪽이 범인인지 영영 알 수 없다. */
  { name: "P3 차트 손절 + 익절 15%", stopMode: "chart", stopPct: 5,  atrMult: 2,   exitMode: "fixed", takePct: 15, trailPct: 8,  signalExit: true,  riskOffExit: 0.8, chartTargetOff: true },
  { name: "P4 차트 손절 + 추적손절",  stopMode: "chart", stopPct: 5,  atrMult: 2,   exitMode: "trail", takePct: 15, trailPct: 10, signalExit: true,  riskOffExit: 0.8, chartTargetOff: true },
  /* M — 국면 적응형(사용자 선택 1번): 하락 국면엔 L 규칙, 상승 국면엔 G 규칙 */
  {
    name: "M 국면적응 (하락=단타/상승=보유)",
    stopMode: "fixed", stopPct: 5, atrMult: 2, exitMode: "fixed", takePct: 8, trailPct: 8,
    signalExit: true, riskOffExit: 0.8, rotateGap: 0.3,
    adaptive: {
      fast: { stopMode: "fixed", stopPct: 5, exitMode: "fixed", takePct: 8, signalExit: true, rotateGap: 0.3 },
      slow: { stopMode: "atr", atrMult: 3, exitMode: "trail", trailPct: 12, takePct: 15, signalExit: false, rotateGap: 0 },
    },
  },
];

/* ── 데이터 ─────────────────────────────── */

interface Bars {
  symbol: string;
  /** epoch seconds */
  t: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

async function fetchBars(symbol: string, range: string): Promise<Bars | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; worldnews-backtest/0.1)" } });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const r = data?.chart?.result?.[0];
      if (!r?.timestamp) continue;
      const q = r.indicators.quote[0];
      const t: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number") continue; // 휴장·결측 캔들 제거
        t.push(r.timestamp[i]);
        open.push(typeof q.open?.[i] === "number" ? q.open[i] : c);
        high.push(typeof q.high?.[i] === "number" ? q.high[i] : c);
        low.push(typeof q.low?.[i] === "number" ? q.low[i] : c);
        close.push(c);
        volume.push(typeof q.volume?.[i] === "number" ? q.volume[i] : 0);
      }
      return { symbol, t, open, high, low, close, volume };
    } catch {
      /* 다음 호스트로 */
    }
  }
  return null;
}

async function loadAll(symbols: string[], range: string): Promise<Map<string, Bars>> {
  const out = new Map<string, Bars>();
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    const got = await Promise.all(batch.map((s) => fetchBars(s, range)));
    for (const b of got) if (b) out.set(b.symbol.toUpperCase(), b);
  }
  return out;
}

/** 날짜(YYYY-MM-DD, KST) → 인덱스 */
function dateKey(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function sliceHistory(b: Bars, upto: number): PriceHistory {
  return {
    price: b.close[upto],
    closes: b.close.slice(0, upto + 1),
    highs: b.high.slice(0, upto + 1),
    lows: b.low.slice(0, upto + 1),
    volumes: b.volume.slice(0, upto + 1),
  };
}

/* ── 시뮬레이션 ─────────────────────────────── */

interface Position {
  code: string;
  nameKo: string;
  symbol: string;
  qty: number;
  avgPrice: number;
  openedOn: string;
  /** 추적손절용 보유 중 최고가 */
  peakPrice: number;
  /** 진입 시점 ATR (변동성 기반 손절용) */
  atrAtEntry: number;
  /** chart 모드에서 진입 시 계산해 고정하는 손절·익절 가격 */
  chartStop?: number;
  chartTarget?: number;
}

interface Trade {
  code: string;
  nameKo: string;
  qty: number;
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  holdDays: number;
}

interface SimResult {
  scenario: Scenario;
  /** 국면 적응형이 규칙을 바꾼 횟수 */
  regimeSwitches?: number;
  finalEquity: number;
  totalReturn: number;
  maxDd: number;
  trades: Trade[];
  equityCurve: { date: string; equity: number }[];
  haltReason: string;
  blockedDays: number;
}

interface Dataset {
  macroBars: Map<string, Bars>;
  tickerBars: Map<string, Bars>;
  calendar: string[];
  idxAsOf: (sym: string, date: string) => number;
  kospi: Bars;
  /** 평가 시작 인덱스 (워밍업 60거래일 이후 + BT_EVAL 구간) */
  startIdx: number;
  /** 날짜별로 미리 계산해 둔 점수 (시나리오마다 재계산하지 않으려고) */
  daily: { date: string; riskOff: number; ranked: { code: string; symbol: string; nameKo: string; ticker: UniverseTicker; score: number; price: number; atr: number }[] }[];
}

/** 시나리오와 무관한 부분(데이터·점수)은 한 번만 계산한다 */
async function buildDataset(): Promise<Dataset> {
  const range = RANGE;
  process.stderr.write(`데이터 수집 중 (${range})…\n`);
  const macroBars = await loadAll(MACRO.map((m) => m.symbol), range);
  const tickerBars = await loadAll([...UNIVERSE.map((t) => t.symbol), "^KS11"], range);

  const missingMacro = MACRO.filter((m) => !macroBars.has(m.symbol.toUpperCase())).map((m) => m.nameKo);
  const missingTicker = UNIVERSE.filter((t) => !tickerBars.has(t.symbol.toUpperCase())).map((t) => t.nameKo);
  if (missingMacro.length) process.stderr.write(`  ! 거시 결측: ${missingMacro.join(", ")}\n`);
  if (missingTicker.length) process.stderr.write(`  ! 종목 결측: ${missingTicker.join(", ")}\n`);

  const kospi = tickerBars.get("^KS11");
  if (!kospi) throw new Error("코스피 데이터를 받지 못했습니다.");
  const calendar = kospi.t.map(dateKey);

  const indexByDate = new Map<string, Map<string, number>>();
  for (const [sym, b] of [...macroBars, ...tickerBars]) {
    const m = new Map<string, number>();
    b.t.forEach((ts, i) => m.set(dateKey(ts), i));
    indexByDate.set(sym, m);
  }
  const idxAsOf = (sym: string, date: string): number => {
    const m = indexByDate.get(sym);
    const b = macroBars.get(sym) ?? tickerBars.get(sym);
    if (!m || !b) return -1;
    const hit = m.get(date);
    if (hit !== undefined) return hit;
    let lo = 0, hi = b.t.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dateKey(b.t[mid]) <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  process.stderr.write("점수 계산 중…\n");
  const daily: Dataset["daily"] = [];
  for (let d = 60; d < calendar.length - 1; d++) {
    const today = calendar[d];
    const macro: MacroSignal[] = [];
    for (const f of MACRO as MacroFactor[]) {
      const sym = f.symbol.toUpperCase();
      const i = idxAsOf(sym, today);
      const b = macroBars.get(sym);
      if (i < 6 || !b) continue;
      macro.push(macroSignal(f, sliceHistory(b, i)));
    }
    if (macro.length < 4) continue;
    const ranked: Dataset["daily"][number]["ranked"] = [];
    for (const t of UNIVERSE) {
      const sym = t.symbol.toUpperCase();
      const i = idxAsOf(sym, today);
      const b = tickerBars.get(sym);
      if (i < 60 || !b) continue;
      const hist = sliceHistory(b, i);
      const onto = propagate(t, macro);
      const price = priceSignal(hist);
      // 뉴스 축은 과거 재현이 불가능하므로 0
      ranked.push({ code: t.code, symbol: sym, nameKo: t.nameKo, ticker: t, score: composite(onto.score, price.score, 0), price: hist.price, atr: price.atr });
    }
    ranked.sort((a, b) => b.score - a.score);
    daily.push({ date: today, riskOff: riskOffFrom(macro), ranked });
  }

  const evalFrom = evalStartDate(calendar.at(-1)!);
  const firstEval = calendar.findIndex((d) => d >= evalFrom);
  const startIdx = Math.max(60, firstEval < 0 ? 60 : firstEval);
  if (startIdx >= calendar.length - 2) throw new Error(`평가 구간이 너무 짧습니다 (BT_EVAL=${EVAL}, 수집=${RANGE}). 수집 구간을 늘리세요.`);

  return { macroBars, tickerBars, calendar, idxAsOf, kospi, startIdx, daily };
}

function simulate(ds: Dataset, baseCfg: Scenario): SimResult {
  // 국면 적응형은 루프 안에서 cfg 를 갈아 끼운다. 고정 시나리오는 그대로 유지된다.
  let cfg: Scenario = baseCfg;
  let regimeSwitches = 0;
  const { tickerBars, calendar, idxAsOf } = ds;
  let cash = CAPITAL;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  let peak = CAPITAL;
  let haltedPermanent = false;
  let haltReason = "";
  let haltedDay = "";
  let blockedDays = 0;
  const perPositionCap = (CAPITAL * MAX_POSITION_PCT) / 100;

  const close = (p: Position, date: string, price: number, reason: string) => {
    const gross = p.qty * price;
    const proceeds = gross - gross * ROUND_TRIP_COST;
    cash += proceeds;
    const invested = p.qty * p.avgPrice;
    trades.push({
      code: p.code, nameKo: p.nameKo, qty: p.qty,
      buyDate: p.openedOn, buyPrice: Math.round(p.avgPrice),
      sellDate: date, sellPrice: Math.round(price),
      pnl: Math.round(proceeds - invested),
      pnlPct: ((proceeds - invested) / invested) * 100,
      reason,
      holdDays: Math.round((Date.parse(date) - Date.parse(p.openedOn)) / 86400000),
    });
    positions.delete(p.code);
  };

  const dayIndex = new Map(ds.daily.map((d, i) => [d.date, i]));

  for (let d = ds.startIdx; d < calendar.length - 1; d++) {
    const today = calendar[d];
    const tomorrow = calendar[d + 1];
    const day = ds.daily[dayIndex.get(today) ?? -1];

    /* 국면 적응 — 그날까지의 코스피 추세·위험회피로 규칙을 갈아 끼운다.
     * 오늘 이후 데이터는 쓰지 않으므로 미래 참조가 없다. */
    if (baseCfg.adaptive && day) {
      const ki = idxAsOf("^KS11", today);
      const closes = ki >= 0 ? ds.kospi.close.slice(0, ki + 1) : [];
      const defensive = isDefensive(closes, day.riskOff);
      const next = { ...baseCfg, ...(defensive ? baseCfg.adaptive.fast : baseCfg.adaptive.slow) } as Scenario;
      if (next.stopMode !== cfg.stopMode || next.takePct !== cfg.takePct || next.rotateGap !== cfg.rotateGap) regimeSwitches++;
      cfg = next;
    }

    let holdingsValue = 0;
    for (const p of positions.values()) {
      const i = idxAsOf(p.symbol, today);
      const b = tickerBars.get(p.symbol);
      holdingsValue += p.qty * (i >= 0 && b ? b.close[i] : p.avgPrice);
    }
    const equity = cash + holdingsValue;
    const prevEquity = equityCurve.at(-1)?.equity ?? CAPITAL;
    equityCurve.push({ date: today, equity });
    if (equity > peak) peak = equity;

    if (!haltedPermanent && ((peak - equity) / peak) * 100 >= MAX_DRAWDOWN_PCT) {
      haltedPermanent = true;
      haltReason = `${today} 고점대비 -${(((peak - equity) / peak) * 100).toFixed(1)}%`;
    }
    if (((prevEquity - equity) / prevEquity) * 100 >= DAILY_LOSS_HALT_PCT) haltedDay = today;

    /* 1) 장중 고저로 손절·익절 판정 */
    for (const p of [...positions.values()]) {
      const bi = idxAsOf(p.symbol, today);
      const b = tickerBars.get(p.symbol);
      if (bi < 0 || !b) continue;
      if (b.high[bi] > p.peakPrice) p.peakPrice = b.high[bi];

      const stopPrice = cfg.stopMode === "chart" && p.chartStop
        ? p.chartStop
        : cfg.stopMode === "atr"
          ? p.avgPrice - cfg.atrMult * p.atrAtEntry
          : p.avgPrice * (1 - cfg.stopPct / 100);
      const takePrice = cfg.stopMode === "chart" && p.chartTarget && !cfg.chartTargetOff
        ? p.chartTarget
        : p.avgPrice * (1 + cfg.takePct / 100);
      let exit = 0, why = "";
      // 같은 날 둘 다 닿으면 손절이 먼저 닿았다고 보수적으로 가정
      if (b.low[bi] <= stopPrice) {
        exit = stopPrice;
        why = cfg.stopMode === "chart" ? "손절 (지지선 이탈)" : cfg.stopMode === "atr" ? `손절 ${cfg.atrMult}×ATR` : `손절 -${cfg.stopPct}%`;
      } else if (cfg.exitMode === "fixed" && b.high[bi] >= takePrice) {
        exit = takePrice;
        why = cfg.stopMode === "chart" && !cfg.chartTargetOff ? "익절 (저항 도달)" : `익절 +${cfg.takePct}%`;
      } else if (cfg.exitMode === "trail") {
        const trailStop = p.peakPrice * (1 - cfg.trailPct / 100);
        // 진입가 위로 올라간 뒤에만 추적손절이 의미를 갖는다
        if (p.peakPrice > p.avgPrice && b.low[bi] <= trailStop && trailStop > stopPrice) {
          exit = trailStop;
          why = `추적손절 -${cfg.trailPct}%`;
        }
      }
      if (exit) close(p, today, exit, why);
    }

    if (haltedPermanent || !day) continue;

    /* 2) 신호 이탈·위험회피 매도 (다음날 시가) */
    const scoreByCode = new Map(day.ranked.map((r) => [r.code, r.score]));
    for (const p of [...positions.values()]) {
      const sc = scoreByCode.get(p.code);
      if (sc === undefined) continue;
      const bySignal = cfg.signalExit && sc <= SELL_SCORE;
      const byRisk = day.riskOff >= cfg.riskOffExit;
      if (!bySignal && !byRisk) continue;
      const oi = idxAsOf(p.symbol, tomorrow);
      const b = tickerBars.get(p.symbol);
      if (oi < 0 || !b) continue;
      close(p, tomorrow, b.open[oi] * (1 - SLIPPAGE), bySignal ? `신호 이탈 (${sc.toFixed(2)})` : `위험회피 ${day.riskOff}`);
    }

    /* 2-b) 교체 매매 — 자리가 다 찼을 때, 제일 약한 보유를 훨씬 강한 후보와 바꾼다.
     * 자금이 묶여 좋은 신호를 놓치는 문제를 푸는 규칙이다. */
    if (cfg.rotateGap && positions.size >= MAX_POSITIONS) {
      const heldScored = [...positions.values()]
        .map((p) => ({ p, score: scoreByCode.get(p.code) ?? -1 }))
        .sort((a, b) => a.score - b.score);
      const worst = heldScored[0];
      const best = day.ranked.find((r) => !positions.has(r.code) && r.score >= BUY_SCORE);
      if (worst && best && best.score - worst.score >= cfg.rotateGap) {
        const oi = idxAsOf(worst.p.symbol, tomorrow);
        const b = tickerBars.get(worst.p.symbol);
        if (oi >= 0 && b) {
          close(worst.p, tomorrow, b.open[oi] * (1 - SLIPPAGE), `교체 매도 (${worst.score.toFixed(2)} → ${best.nameKo} ${best.score.toFixed(2)})`);
        }
      }
    }

    /* 3) 매수 (다음날 시가) — 실전과 동일한 현재 국면 필터.
     * 코스피가 20일선 아래이고 20일 모멘텀이 -1% 미만이면 신규 진입하지 않는다. */
    if (haltedDay === today) { blockedDays++; continue; }
    const marketIdx = idxAsOf("^KS11", today);
    const marketCloses = marketIdx >= 0 ? ds.kospi.close.slice(0, marketIdx + 1) : [];
    if (isDefensive(marketCloses, day.riskOff)) { blockedDays++; continue; }
    let buys = 0;
    const riskScale = 1 - Math.min(0.5, day.riskOff * 0.5);
    for (const r of day.ranked) {
      if (buys >= MAX_ORDERS_PER_CYCLE || buys >= MAX_TRADES_PER_DAY) break;
      if (r.score < BUY_SCORE) break;
      const existing = positions.get(r.code);
      if (!existing && positions.size >= MAX_POSITIONS) continue;

      const oi = idxAsOf(r.symbol, tomorrow);
      const b = tickerBars.get(r.symbol);
      if (oi < 0 || !b) continue;
      const fill = roundToTick(b.open[oi] * (1 + SLIPPAGE), "up");

      const currentValue = existing ? existing.qty * r.price : 0;
      const room = Math.min(perPositionCap - currentValue, MAX_ORDER_KRW, cash);
      const sized = room * riskScale * Math.min(1, 0.5 + r.score);
      if (sized < MIN_ORDER_KRW) continue;
      const qty = Math.floor(sized / fill);
      if (qty < 1) continue;
      const cost = qty * fill;
      if (cost > cash) continue;

      cash -= cost;
      if (existing) {
        const total = existing.qty + qty;
        existing.avgPrice = (existing.avgPrice * existing.qty + fill * qty) / total;
        existing.qty = total;
        existing.atrAtEntry = r.atr;
      } else {
        /* 차트 기반 손절·익절 — 진입한 그 날의 데이터만으로 계산한다(미래 참조 없음).
         * 종목마다 다른 손절이 나온다. 이게 이 시나리오의 요점이다 —
         * 삼성전자(ATR 2.5%)와 현대백화점(ATR 10.8%)에 같은 -5% 자를 대지 않는다. */
        let chartStop: number | undefined;
        let chartTarget: number | undefined;
        if (cfg.stopMode === "chart") {
          const bi = idxAsOf(r.symbol, today);
          if (bi >= 60) {
            const hist = sliceHistory(b, bi);
            const ladder = levelLadder(hist);
            const plan = tradePlan(hist, { score: 0, verdict: "neutral", buy: 0, sell: 0, neutral: 0, text: "" }, trendState(hist), ladder);
            // 계획은 진입가 기준으로 옮긴다(계획은 전날 종가 기준이라 체결가와 다르다)
            const shift = fill / hist.price;
            chartStop = plan.stop.price * shift;
            chartTarget = plan.targets[0].price * shift;
          }
        }
        positions.set(r.code, {
          code: r.code, nameKo: r.nameKo, symbol: r.symbol,
          qty, avgPrice: fill, openedOn: tomorrow,
          peakPrice: fill, atrAtEntry: r.atr, chartStop, chartTarget,
        });
      }
      buys++;
    }
  }

  const lastDate = calendar.at(-1)!;
  for (const p of [...positions.values()]) {
    const i = idxAsOf(p.symbol, lastDate);
    const b = tickerBars.get(p.symbol);
    if (i >= 0 && b) close(p, lastDate, b.close[i] * (1 - SLIPPAGE), "기간 종료 청산");
  }

  let maxDd = 0, runPeak = CAPITAL;
  for (const e of equityCurve) {
    if (e.equity > runPeak) runPeak = e.equity;
    maxDd = Math.max(maxDd, ((runPeak - e.equity) / runPeak) * 100);
  }

  return {
    scenario: baseCfg, // 이름·설정은 원본 기준으로 보고한다
    regimeSwitches,
    finalEquity: cash,
    totalReturn: ((cash - CAPITAL) / CAPITAL) * 100,
    maxDd,
    trades,
    equityCurve,
    haltReason,
    blockedDays,
  };
}

/* ── 출력 ─────────────────────────────── */

const won = (n: number) => Math.round(n).toLocaleString("ko-KR") + "원";
const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

function stats(r: SimResult) {
  const wins = r.trades.filter((t) => t.pnl > 0);
  const losses = r.trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    wins, losses,
    winRate: r.trades.length ? (wins.length / r.trades.length) * 100 : 0,
    pf: grossLoss ? grossWin / grossLoss : Infinity,
    grossWin, grossLoss,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
  };
}

function detail(r: SimResult, kospiReturn: number) {
  const s = stats(r);
  console.log("\n" + "─".repeat(70));
  console.log(`상세 — ${r.scenario.name}`);
  console.log("─".repeat(70));
  console.log(`원금 ${won(CAPITAL)} → 최종 ${won(r.finalEquity)}   ${pct(r.totalReturn)}   (코스피 ${pct(kospiReturn)})`);
  console.log(`최대 낙폭 -${r.maxDd.toFixed(2)}% · 매매 ${r.trades.length}건 · 승률 ${s.winRate.toFixed(1)}% · PF ${s.pf.toFixed(2)}`);
  console.log(`평균 수익 ${pct(s.avgWin)} / 평균 손실 ${pct(s.avgLoss)}`);
  if (r.haltReason) console.log(`영구 정지: ${r.haltReason}`);

  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of r.trades) {
    const k = t.reason.split(" (")[0].replace(/위험회피 [\d.]+/, "위험회피");
    const cur = byReason.get(k) ?? { n: 0, pnl: 0 };
    cur.n++; cur.pnl += t.pnl;
    byReason.set(k, cur);
  }
  console.log("\n청산 사유별");
  for (const [k, v] of [...byReason].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(3)}건   ${won(v.pnl).padStart(14)}`);
  }

  const byTicker = new Map<string, { n: number; pnl: number }>();
  for (const t of r.trades) {
    const cur = byTicker.get(t.nameKo) ?? { n: 0, pnl: 0 };
    cur.n++; cur.pnl += t.pnl;
    byTicker.set(t.nameKo, cur);
  }
  const sorted = [...byTicker].sort((a, b) => b[1].pnl - a[1].pnl);
  console.log("\n종목별 상위 5 / 하위 5");
  for (const [k, v] of sorted.slice(0, 5)) console.log(`  + ${k.padEnd(18)} ${String(v.n).padStart(3)}건   ${won(v.pnl).padStart(14)}`);
  for (const [k, v] of sorted.slice(-5)) console.log(`  - ${k.padEnd(18)} ${String(v.n).padStart(3)}건   ${won(v.pnl).padStart(14)}`);
}

async function main() {
  const ds = await buildDataset();
  const first = ds.calendar[ds.startIdx];
  const lastDate = ds.calendar.at(-1)!;
  const ki = ds.idxAsOf("^KS11", first);
  const kf = ds.idxAsOf("^KS11", lastDate);
  const kospiReturn = ((ds.kospi.close[kf] - ds.kospi.close[ki]) / ds.kospi.close[ki]) * 100;

  console.log("\n" + "=".repeat(70));
  console.log(`백테스트  ${first} ~ ${lastDate}  (매매 ${ds.calendar.length - 1 - ds.startIdx} 거래일 · 데이터 ${RANGE} · 평가 ${EVAL})`);
  console.log(`벤치마크  코스피 매수 후 보유 = ${pct(kospiReturn)}`);
  console.log("=".repeat(70));
  console.log(`${"시나리오".padEnd(24)}${"수익률".padStart(10)}${"vs코스피".padStart(11)}${"최대낙폭".padStart(10)}${"매매".padStart(7)}${"승률".padStart(8)}${"PF".padStart(7)}${"보유".padStart(7)}`);
  console.log("─".repeat(70));

  const results: SimResult[] = [];
  for (const cfg of SCENARIOS) {
    const r = simulate(ds, cfg);
    results.push(r);
    const s = stats(r);
    console.log(
      cfg.name.padEnd(24) +
        pct(r.totalReturn).padStart(10) +
        pct(r.totalReturn - kospiReturn).padStart(11) +
        `-${r.maxDd.toFixed(1)}%`.padStart(10) +
        `${r.trades.length}`.padStart(7) +
        `${s.winRate.toFixed(0)}%`.padStart(8) +
        s.pf.toFixed(2).padStart(7) +
        // 단타 관점 지표: 평균 보유일 (며칠 만에 팔았나)
        `${(r.trades.reduce((a, t) => a + t.holdDays, 0) / Math.max(1, r.trades.length)).toFixed(0)}일`.padStart(7),
    );
  }

  detail(results[0], kospiReturn);
  const best = results.reduce((a, b) => (b.totalReturn > a.totalReturn ? b : a));
  if (best !== results[0]) detail(best, kospiReturn);

  console.log("\n※ 뉴스 축(가중치 0.20)은 과거 재현 불가로 0 처리. 유니버스 생존편향 있음.");
  console.log("※ 시나리오는 원인 분리용이다. 제일 높은 숫자를 그대로 채택하면 과최적화가 된다.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
