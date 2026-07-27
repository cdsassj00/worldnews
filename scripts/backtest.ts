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
import { MACRO, UNIVERSE, roundToTick, type MacroFactor, type UniverseTicker } from "../shared/ontology";
import { composite, macroSignal, priceSignal, propagate, riskOffFrom, type MacroSignal, type PriceHistory } from "../shared/scoring";

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
const BUY_SCORE = 0.15;
const SELL_SCORE = -0.05;
const SLIPPAGE = 0.003;
/** 왕복 거래비용 (매도 시 한 번에 반영) */
const ROUND_TRIP_COST = 0.0023;

const YEARS = Number(process.env.BT_YEARS ?? 2);

/**
 * 시나리오 — 무엇이 성과를 좌우하는지 **원인을 분리**하려고 둔 것이지
 * 제일 좋은 숫자를 고르려고 둔 게 아니다. 과최적화는 백테스트만 예뻐지고 실전은 무너진다.
 */
export interface Scenario {
  name: string;
  /** 손절: 고정 %(fixed) 또는 변동성 배수(atr) */
  stopMode: "fixed" | "atr";
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
  /** 날짜별로 미리 계산해 둔 점수 (시나리오마다 재계산하지 않으려고) */
  daily: { date: string; riskOff: number; ranked: { code: string; symbol: string; nameKo: string; ticker: UniverseTicker; score: number; price: number; atr: number }[] }[];
}

/** 시나리오와 무관한 부분(데이터·점수)은 한 번만 계산한다 */
async function buildDataset(): Promise<Dataset> {
  const range = `${YEARS}y`;
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

  return { macroBars, tickerBars, calendar, idxAsOf, kospi, daily };
}

function simulate(ds: Dataset, cfg: Scenario): SimResult {
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

  for (let d = 60; d < calendar.length - 1; d++) {
    const today = calendar[d];
    const tomorrow = calendar[d + 1];
    const day = ds.daily[dayIndex.get(today) ?? -1];

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

      const stopPrice = cfg.stopMode === "atr"
        ? p.avgPrice - cfg.atrMult * p.atrAtEntry
        : p.avgPrice * (1 - cfg.stopPct / 100);
      let exit = 0, why = "";
      // 같은 날 둘 다 닿으면 손절이 먼저 닿았다고 보수적으로 가정
      if (b.low[bi] <= stopPrice) {
        exit = stopPrice;
        why = cfg.stopMode === "atr" ? `손절 ${cfg.atrMult}×ATR` : `손절 -${cfg.stopPct}%`;
      } else if (cfg.exitMode === "fixed" && b.high[bi] >= p.avgPrice * (1 + cfg.takePct / 100)) {
        exit = p.avgPrice * (1 + cfg.takePct / 100);
        why = `익절 +${cfg.takePct}%`;
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

    /* 3) 매수 (다음날 시가) */
    if (haltedDay === today) { blockedDays++; continue; }
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
        positions.set(r.code, {
          code: r.code, nameKo: r.nameKo, symbol: r.symbol,
          qty, avgPrice: fill, openedOn: tomorrow,
          peakPrice: fill, atrAtEntry: r.atr,
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
    scenario: cfg,
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
  const first = ds.daily[0].date;
  const lastDate = ds.calendar.at(-1)!;
  const ki = ds.idxAsOf("^KS11", first);
  const kf = ds.idxAsOf("^KS11", lastDate);
  const kospiReturn = ((ds.kospi.close[kf] - ds.kospi.close[ki]) / ds.kospi.close[ki]) * 100;

  console.log("\n" + "=".repeat(70));
  console.log(`백테스트  ${first} ~ ${lastDate}  (${ds.daily.length} 거래일)`);
  console.log(`벤치마크  코스피 매수 후 보유 = ${pct(kospiReturn)}`);
  console.log("=".repeat(70));
  console.log(`${"시나리오".padEnd(24)}${"수익률".padStart(10)}${"vs코스피".padStart(11)}${"최대낙폭".padStart(10)}${"매매".padStart(7)}${"승률".padStart(8)}${"PF".padStart(7)}`);
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
        s.pf.toFixed(2).padStart(7),
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
