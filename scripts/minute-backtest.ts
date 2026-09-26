/**
 * 분봉 단타 검증 v2 — "온톨로지고 수급이고 다 빼고 차트만으로" (2026-08-25 사용자 지시).
 *
 * v1(consensus 13종 그대로 5분봉에 적용)은 실패했다 — 느슨하면 승률 29%로 지고,
 * 빡빡하면 매매가 거의 안 나왔다. 원인은 지표 기간이 전부 일봉 기준(MA60=60일)
 * 이었던 것 — 5분봉에 그대로 얹으면 반나절을 "장기추세"로 오인한다.
 *
 * v2 는 기간을 분봉에 맞게 다시 잡고, 서로 다른 논리인 역추세·추세추종을
 * 뒤섞지 않고 따로 검증한다(기존 일봉 백테스트가 돌파·역추세를 나눠 봤던 것과 같은 원칙).
 *  - 역추세: RSI(9) 과매도 + 볼린저(20,2) 하단 접근 → 반등에 건다.
 *  - 추세추종: N봉 고점 돌파(돈치안) + ADX(14) 로 "횡보 아님" 확인 → 눌림 없이 따라간다.
 *
 * 데이터: 야후 5분봉 60일(핵심 유동성 20종목). 당일청산(오버나잇 금지).
 * 실행: npx tsx scripts/minute-backtest.ts
 */
import { rsiSeries, bollinger, adxSeries, donchian, smaSeries } from "../shared/ta";
import { UNIVERSE } from "../shared/ontology";

const CORE = UNIVERSE.filter((u) => u.core);
const CAPITAL_KRW = 4_000_000;
const ROUND_TRIP_COST = 0.0023;
const SLIPPAGE = 0.001;

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

async function fetchMinuteBars(symbol: string): Promise<Bar[]> {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=60d&interval=5m&includePrePost=false`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data = (await res.json()) as {
        chart: { result: { timestamp?: number[]; indicators: { quote: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] | null };
      };
      const r = data.chart.result?.[0];
      if (!r?.timestamp) return [];
      const q = r.indicators.quote[0];
      const bars: Bar[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        bars.push({ t: r.timestamp[i], o, h, l, c, v: v ?? 0 });
      }
      return bars;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(`  ! ${symbol} 실패: ${lastErr}`);
  return [];
}

function kstDate(unixSec: number): string {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

interface Trade { pnlPct: number; bars: number }

/**
 * 지수 추세 필터 — 코스피 자체가 최근 N봉 평균 위에 있을 때만 롱 진입을 허용한다.
 * 2026-08-25 사용자 지시로 추가: v2 가 전패한 원인 중 하나가 60일 내내 하락장(-20.7%)
 * 이었는데 롱 전용 전략을 계속 돌린 것 — "떨어지는 칼날 잡기"를 걸러내려는 필터다.
 * 타임스탬프로 대사한다(개별 종목·지수가 같은 거래소라 봉 시각이 대체로 일치하지만,
 * 결측 대비 못 찾으면 필터를 통과시킨다 — 필터가 있어서 매매가 아예 막히는 것보다는 낫다).
 */
function buildTrendFilter(kospiBars: Bar[], smaN: number): Map<number, boolean> {
  const closes = kospiBars.map((b) => b.c);
  const sma = smaSeries(closes, smaN);
  const map = new Map<number, boolean>();
  for (let i = 0; i < kospiBars.length; i++) {
    if (!Number.isNaN(sma[i])) map.set(kospiBars[i].t, closes[i] > sma[i]);
  }
  return map;
}

/** 역추세 — RSI 과매도 + 볼린저 하단권. 반등 목표 도달 또는 RSI 중립 복귀 시 청산. */
function simulateMeanRev(
  bars: Bar[],
  cfg: { rsiN: number; rsiBuy: number; rsiExit: number; bbN: number; bbMult: number; stopPct: number; takePct: number },
  trendFilter?: Map<number, boolean>,
): Trade[] {
  const closes = bars.map((b) => b.c);
  const rsi = rsiSeries(closes, cfg.rsiN);
  const bb = bollinger(closes, cfg.bbN, cfg.bbMult);
  const trades: Trade[] = [];
  let pos: { entry: number; idx: number } | null = null;
  const warmup = Math.max(cfg.rsiN, cfg.bbN) + 2;

  for (let i = warmup; i < bars.length; i++) {
    const day = kstDate(bars[i].t);
    const isLastBarOfDay = i === bars.length - 1 || kstDate(bars[i + 1].t) !== day;

    if (pos) {
      const pnlPct = ((bars[i].c - pos.entry) / pos.entry) * 100;
      let exit = false, why = "";
      if (pnlPct <= -cfg.stopPct) { exit = true; why = "손절"; }
      else if (pnlPct >= cfg.takePct) { exit = true; why = "익절"; }
      else if (rsi[i] >= cfg.rsiExit) { exit = true; why = "RSI중립복귀"; }
      else if (isLastBarOfDay) { exit = true; why = "당일청산"; }
      if (exit) {
        void why;
        const netPct = ((bars[i].c * (1 - SLIPPAGE) - pos.entry * (1 + SLIPPAGE)) / pos.entry) * 100 - ROUND_TRIP_COST * 100;
        trades.push({ pnlPct: netPct, bars: i - pos.idx });
        pos = null;
      }
      continue;
    }
    if (isLastBarOfDay) continue;
    if (Number.isNaN(rsi[i]) || Number.isNaN(bb.lower[i])) continue;
    if (trendFilter && trendFilter.get(bars[i].t) === false) continue; // 지수가 단기평균 밑이면 진입 안 함
    // 과매도 + 하단밴드 접근(밴드 폭의 30% 이내로 근접) — 동시에 만족해야 진입
    const nearLower = bars[i].c <= bb.lower[i] + (bb.mid[i] - bb.lower[i]) * 0.3;
    if (rsi[i] <= cfg.rsiBuy && nearLower) {
      pos = { entry: bars[i].c, idx: i };
    }
  }
  return trades;
}

/** 추세추종 — N봉 고점 돌파 + ADX 로 횡보장 배제. 추적손절로 추세를 태운다. */
function simulateBreakout(
  bars: Bar[],
  cfg: { donchianN: number; adxN: number; adxMin: number; stopPct: number; trailPct: number },
  trendFilter?: Map<number, boolean>,
): Trade[] {
  const closes = bars.map((b) => b.c), highs = bars.map((b) => b.h), lows = bars.map((b) => b.l);
  const dc = donchian(highs, lows, cfg.donchianN);
  const { adx } = adxSeries(highs, lows, closes, cfg.adxN);
  const trades: Trade[] = [];
  let pos: { entry: number; idx: number; peak: number } | null = null;
  const warmup = Math.max(cfg.donchianN, cfg.adxN) + 2;

  for (let i = warmup; i < bars.length; i++) {
    const day = kstDate(bars[i].t);
    const isLastBarOfDay = i === bars.length - 1 || kstDate(bars[i + 1].t) !== day;

    if (pos) {
      pos.peak = Math.max(pos.peak, bars[i].c);
      const pnlPct = ((bars[i].c - pos.entry) / pos.entry) * 100;
      const trailStop = pos.peak * (1 - cfg.trailPct / 100);
      let exit = false;
      if (pnlPct <= -cfg.stopPct) exit = true;
      else if (bars[i].c <= trailStop && pos.peak > pos.entry) exit = true;
      else if (isLastBarOfDay) exit = true;
      if (exit) {
        const netPct = ((bars[i].c * (1 - SLIPPAGE) - pos.entry * (1 + SLIPPAGE)) / pos.entry) * 100 - ROUND_TRIP_COST * 100;
        trades.push({ pnlPct: netPct, bars: i - pos.idx });
        pos = null;
      }
      continue;
    }
    if (isLastBarOfDay) continue;
    if (Number.isNaN(dc.up[i - 1]) || Number.isNaN(adx[i])) continue;
    if (trendFilter && trendFilter.get(bars[i].t) === false) continue;
    // 직전 봉까지의 N봉 최고가를 이번 봉 종가가 넘어서면 돌파. 오늘 자신을 포함해 계산하면 항상 참이 되므로 i-1 기준.
    if (bars[i].c > dc.up[i - 1] && adx[i] >= cfg.adxMin) {
      pos = { entry: bars[i].c, idx: i, peak: bars[i].c };
    }
  }
  return trades;
}

function report(name: string, trades: Trade[], tradingDays: number) {
  if (!trades.length) { console.log(name.padEnd(34) + "매매 없음".padStart(10)); return; }
  const perTradeCapital = CAPITAL_KRW / CORE.length;
  let totalPnl = 0, wins = 0, grossWin = 0, grossLoss = 0;
  for (const t of trades) {
    const pnlKrw = perTradeCapital * (t.pnlPct / 100);
    totalPnl += pnlKrw;
    if (t.pnlPct > 0) { wins++; grossWin += pnlKrw; } else grossLoss += Math.abs(pnlKrw);
  }
  const totalReturn = (totalPnl / CAPITAL_KRW) * 100;
  const winRate = (wins / trades.length) * 100;
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const avgBars = trades.reduce((s, t) => s + t.bars, 0) / trades.length;
  console.log(
    name.padEnd(34) +
      `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`.padStart(10) +
      String(trades.length).padStart(7) +
      `${winRate.toFixed(0)}%`.padStart(7) +
      (pf === Infinity ? "∞" : pf.toFixed(2)).padStart(7) +
      `${(avgBars * 5).toFixed(0)}분`.padStart(9) +
      (trades.length / tradingDays).toFixed(2).padStart(11),
  );
}

async function main() {
  console.log(`데이터 수집 — 핵심 유동성 ${CORE.length}종목, 5분봉 60일…`);
  const barsByCode = new Map<string, Bar[]>();
  for (const u of CORE) {
    const bars = await fetchMinuteBars(u.symbol);
    barsByCode.set(u.code, bars);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  완료 (봉당 ${barsByCode.get(CORE[0].code)?.length ?? 0}개)`);

  const kospiBars = await fetchMinuteBars("^KS11");
  const benchReturn = kospiBars.length > 1 ? ((kospiBars[kospiBars.length - 1].c - kospiBars[0].c) / kospiBars[0].c) * 100 : 0;
  const tradingDays = new Set(barsByCode.get(CORE[0].code)?.map((b) => kstDate(b.t)) ?? []).size || 1;

  console.log("\n" + "=".repeat(96));
  console.log(`분봉(5분) 차트 전용 스캘핑 v2 — ${tradingDays}거래일 · 원금 ${CAPITAL_KRW.toLocaleString("ko-KR")}원 · 비용 왕복 0.23%+슬리피지 0.2%`);
  console.log(`벤치마크 코스피 매수후보유 = ${benchReturn >= 0 ? "+" : ""}${benchReturn.toFixed(2)}%`);
  console.log("=".repeat(96));
  console.log(
    "시나리오".padEnd(34) + "수익률".padStart(10) + "매매".padStart(7) + "승률".padStart(7) + "PF".padStart(7) + "평균보유".padStart(9) + "일평균매매".padStart(11),
  );
  console.log("-".repeat(96));

  const meanRevScenarios = [
    { name: "R1 RSI9·과매도25·손절0.7·익절1.2", rsiN: 9, rsiBuy: 25, rsiExit: 50, bbN: 20, bbMult: 2, stopPct: 0.7, takePct: 1.2 },
    { name: "R2 RSI9·과매도30·손절0.7·익절1.5", rsiN: 9, rsiBuy: 30, rsiExit: 50, bbN: 20, bbMult: 2, stopPct: 0.7, takePct: 1.5 },
    { name: "R3 RSI14·과매도30·손절1·익절1.5", rsiN: 14, rsiBuy: 30, rsiExit: 50, bbN: 20, bbMult: 2, stopPct: 1, takePct: 1.5 },
    { name: "R4 RSI9·과매도20(엄격)·손절0.5·익절1", rsiN: 9, rsiBuy: 20, rsiExit: 45, bbN: 20, bbMult: 2.2, stopPct: 0.5, takePct: 1 },
  ];
  for (const cfg of meanRevScenarios) {
    const all: Trade[] = [];
    for (const u of CORE) all.push(...simulateMeanRev(barsByCode.get(u.code) ?? [], cfg));
    report(cfg.name, all, tradingDays);
  }

  console.log();
  const breakoutScenarios = [
    { name: "B1 12봉(1h)돌파·ADX18·손절0.7·추적1", donchianN: 12, adxN: 14, adxMin: 18, stopPct: 0.7, trailPct: 1 },
    { name: "B2 12봉돌파·ADX22(엄격)·손절0.7·추적1", donchianN: 12, adxN: 14, adxMin: 22, stopPct: 0.7, trailPct: 1 },
    { name: "B3 24봉(2h)돌파·ADX18·손절1·추적1.5", donchianN: 24, adxN: 14, adxMin: 18, stopPct: 1, trailPct: 1.5 },
    { name: "B4 6봉(30분)돌파·ADX18·손절0.5·추적0.7", donchianN: 6, adxN: 14, adxMin: 18, stopPct: 0.5, trailPct: 0.7 },
  ];
  for (const cfg of breakoutScenarios) {
    const all: Trade[] = [];
    for (const u of CORE) all.push(...simulateBreakout(barsByCode.get(u.code) ?? [], cfg));
    report(cfg.name, all, tradingDays);
  }

  // 지수 추세 필터 — 코스피가 단기평균 위일 때만 롱 진입. 각 그룹의 상대적 우등생(R4·B3)에 적용해 비교.
  console.log(`\n지수 추세 필터 적용 (코스피 5분봉 SMA20/SMA60 위일 때만 진입) — R4·B3 재측정`);
  const filter20 = buildTrendFilter(kospiBars, 20);
  const filter60 = buildTrendFilter(kospiBars, 60);
  const r4 = meanRevScenarios[3];
  const b3 = breakoutScenarios[2];
  for (const [label, filter] of [["SMA20", filter20], ["SMA60", filter60]] as const) {
    const rAll: Trade[] = [];
    for (const u of CORE) rAll.push(...simulateMeanRev(barsByCode.get(u.code) ?? [], r4, filter));
    report(`${r4.name} +지수필터${label}`, rAll, tradingDays);
    const bAll: Trade[] = [];
    for (const u of CORE) bAll.push(...simulateBreakout(barsByCode.get(u.code) ?? [], b3, filter));
    report(`${b3.name} +지수필터${label}`, bAll, tradingDays);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
