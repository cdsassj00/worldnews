/**
 * 분봉 단타 검증 — "온톨로지고 수급이고 다 빼고 차트만으로" (2026-08-25 사용자 지시).
 *
 * 기존 quant-backtest.ts 는 전부 일봉이다. 이건 5분봉으로 같은 질문을 던진다:
 * 지금 있는 차트 전략 13종(shared/ta.ts runStrategies)을 그대로 5분봉에 붙이면
 * 비용을 감수하고도 이기는가?
 *
 * 데이터: 야후 5분봉은 최근 60일치만 준다(1분봉은 5일치뿐이라 검증엔 너무 짧다).
 * 유니버스: UNIVERSE 의 core=true 20종(자동매매가 실제로 사는 유동성 상위 종목) —
 * 스캘핑은 슬리피지가 수익을 잡아먹으므로 유동성 없는 종목은 애초에 후보가 아니다.
 * 매매 규칙: 당일청산(오버나잇 금지 — 진짜 단타). 손절·익절 %, 합의점수 문턱을
 * 몇 가지로 바꿔가며 코스피 매수후보유와 비교한다.
 *
 * 실행: npx tsx scripts/minute-backtest.ts
 */
import { runStrategies, consensus } from "../shared/ta";
import { UNIVERSE } from "../shared/ontology";
import type { PriceHistory } from "../shared/scoring";

const CORE = UNIVERSE.filter((u) => u.core);
const CAPITAL_KRW = 4_000_000;
const ROUND_TRIP_COST = 0.0023; // 왕복 0.23% — 기존 백테스트와 동일 가정
const SLIPPAGE = 0.001; // 편도 0.1% — 분봉은 호가 스프레드가 더 크게 문다

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

/** KST 날짜(YYYY-MM-DD)만 뽑는다 — 당일청산 판정용 */
function kstDate(unixSec: number): string {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

interface Scenario {
  name: string;
  buyScore: number;
  sellScore: number;
  stopPct: number;
  takePct: number;
  lookback: number; // 지표 계산에 쓰는 트레일링 바 개수
}

const SCENARIOS: Scenario[] = [
  { name: "M1 문턱0.3·손절1%·익절2%", buyScore: 0.3, sellScore: -0.1, stopPct: 1, takePct: 2, lookback: 60 },
  { name: "M2 문턱0.4·손절1%·익절2%", buyScore: 0.4, sellScore: -0.1, stopPct: 1, takePct: 2, lookback: 60 },
  { name: "M3 문턱0.4·손절0.7%·익절1.5%", buyScore: 0.4, sellScore: -0.1, stopPct: 0.7, takePct: 1.5, lookback: 60 },
  { name: "M4 문턱0.5·손절1%·익절3%", buyScore: 0.5, sellScore: -0.1, stopPct: 1, takePct: 3, lookback: 60 },
  { name: "M5 문턱0.4·손절1.5%·익절1.5%(1:1)", buyScore: 0.4, sellScore: -0.1, stopPct: 1.5, takePct: 1.5, lookback: 60 },
];

interface Trade { code: string; entry: number; exit: number; pnlPct: number; reason: string; bars: number }

function simulate(code: string, bars: Bar[], cfg: Scenario): Trade[] {
  const trades: Trade[] = [];
  let pos: { entry: number; idx: number; peak: number } | null = null;

  for (let i = cfg.lookback; i < bars.length; i++) {
    const day = kstDate(bars[i].t);
    const isLastBarOfDay = i === bars.length - 1 || kstDate(bars[i + 1].t) !== day;

    if (pos) {
      const pnlPct = ((bars[i].c - pos.entry) / pos.entry) * 100;
      let exit = 0, reason = "";
      if (pnlPct <= -cfg.stopPct) { exit = bars[i].c; reason = "손절"; }
      else if (pnlPct >= cfg.takePct) { exit = bars[i].c; reason = "익절"; }
      else if (isLastBarOfDay) { exit = bars[i].c; reason = "당일청산"; }
      if (exit) {
        const netPct = ((exit * (1 - SLIPPAGE) - pos.entry * (1 + SLIPPAGE)) / pos.entry) * 100 - ROUND_TRIP_COST * 100;
        trades.push({ code, entry: pos.entry, exit, pnlPct: netPct, reason, bars: i - pos.idx });
        pos = null;
      }
      continue;
    }

    // 장 마지막 바에는 신규 진입 안 함(청산 못 하고 오버나잇 될 수 있음)
    if (isLastBarOfDay) continue;

    const window = bars.slice(i - cfg.lookback, i + 1);
    const hist: PriceHistory = {
      price: window[window.length - 1].c,
      closes: window.map((b) => b.c),
      highs: window.map((b) => b.h),
      lows: window.map((b) => b.l),
      volumes: window.map((b) => b.v),
    };
    const score = consensus(runStrategies(hist)).score;
    if (score >= cfg.buyScore) {
      pos = { entry: bars[i].c, idx: i, peak: bars[i].c };
    }
  }
  return trades;
}

async function main() {
  console.log(`데이터 수집 — 핵심 유동성 ${CORE.length}종목, 5분봉 60일…`);
  const barsByCode = new Map<string, Bar[]>();
  for (const u of CORE) {
    const bars = await fetchMinuteBars(u.symbol);
    barsByCode.set(u.code, bars);
    console.log(`  ${u.nameKo}(${u.code}) — ${bars.length}봉`);
    await new Promise((r) => setTimeout(r, 300)); // 레이트리밋 방지
  }

  // 벤치마크 — 코스피 지수 자체를 5분봉 매수후보유로
  const kospiBars = await fetchMinuteBars("^KS11");
  const benchReturn = kospiBars.length > 1 ? ((kospiBars[kospiBars.length - 1].c - kospiBars[0].c) / kospiBars[0].c) * 100 : 0;

  console.log("\n" + "=".repeat(90));
  console.log(`분봉(5분) 차트 전용 스캘핑 검증 — 60일 · 원금 ${CAPITAL_KRW.toLocaleString("ko-KR")}원 · 비용 왕복 0.23%+슬리피지 0.2%`);
  console.log(`벤치마크 코스피 매수후보유 = ${benchReturn >= 0 ? "+" : ""}${benchReturn.toFixed(2)}%`);
  console.log("=".repeat(90));
  console.log(
    "시나리오".padEnd(28) + "수익률".padStart(10) + "매매".padStart(8) + "승률".padStart(8) + "PF".padStart(7) + "평균보유".padStart(10) + "일평균매매".padStart(12),
  );
  console.log("-".repeat(90));

  for (const cfg of SCENARIOS) {
    const allTrades: Trade[] = [];
    for (const u of CORE) {
      const bars = barsByCode.get(u.code) ?? [];
      if (bars.length < cfg.lookback + 10) continue;
      allTrades.push(...simulate(u.code, bars, cfg));
    }
    if (!allTrades.length) {
      console.log(cfg.name.padEnd(28) + "매매 없음".padStart(10));
      continue;
    }
    // 균등 배분 가정(종목당 자본/20) — 복리 없이 단순 합산
    const perTradeCapital = CAPITAL_KRW / CORE.length;
    let totalPnl = 0, wins = 0, grossWin = 0, grossLoss = 0;
    for (const t of allTrades) {
      const pnlKrw = perTradeCapital * (t.pnlPct / 100);
      totalPnl += pnlKrw;
      if (t.pnlPct > 0) { wins++; grossWin += pnlKrw; } else grossLoss += Math.abs(pnlKrw);
    }
    const totalReturn = (totalPnl / CAPITAL_KRW) * 100;
    const winRate = (wins / allTrades.length) * 100;
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgBars = allTrades.reduce((s, t) => s + t.bars, 0) / allTrades.length;
    const tradingDays = new Set(barsByCode.get(CORE[0].code)?.map((b) => kstDate(b.t)) ?? []).size || 1;
    console.log(
      cfg.name.padEnd(28) +
        `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`.padStart(10) +
        String(allTrades.length).padStart(8) +
        `${winRate.toFixed(0)}%`.padStart(8) +
        (pf === Infinity ? "∞" : pf.toFixed(2)).padStart(7) +
        `${(avgBars * 5).toFixed(0)}분`.padStart(10) +
        (allTrades.length / tradingDays).toFixed(1).padStart(12),
    );
  }
  console.log("\n※ 지표 기간(RSI14·MA20/60 등)은 일봉 기준 그대로다 — 5분봉에 맞게 재튜닝 전 1차 측정.");
}

main().catch((err) => { console.error(err); process.exit(1); });
