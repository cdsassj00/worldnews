/**
 * 예측력 평가 — "네가 고른 종목을 샀다면 어떻게 됐나".
 *
 * 백테스트(scripts/backtest.ts)가 자금·한도·손절이 얽힌 **전략 시뮬레이션**이라면,
 * 이 스크립트는 그 제약을 전부 걷어내고 **점수의 예측력 자체**만 잰다.
 *
 *   매일: 운영과 같은 계산(shared/scoring)으로 전 종목 점수를 매긴다.
 *   추천 = 점수 상위 3개 중 매수 기준(0.15) 통과분. 다음날 시가에 샀다고 치고
 *   1·5·20 거래일 뒤 종가 수익률을 잰다.
 *
 * 대조군 — "당연히 오른 장이었다"는 착시를 벗기기 위한 것:
 *   침팬지     같은 날, 같은 유니버스에서 무작위로 골랐을 때의 기대 수익
 *              (= 유니버스 평균). 추천이 이걸 못 이기면 종목 선택 능력이 없는 것이다.
 *   코스피     같은 기간 지수.
 *   최하위 3   점수가 가장 낮은 종목 — 약세 경고가 진짜라면 이쪽 수익이 나빠야 한다.
 *   IC         점수와 미래 수익률의 순위상관(스피어만). 예측력의 표준 척도.
 *
 * 한계: 뉴스 축은 과거 재현 불가로 0. 유니버스는 현재 코어 20종목이라 생존편향 있음.
 *
 * 실행: npm run predict-eval  (기간 변경: PE_YEARS=1)
 */
import { MACRO, UNIVERSE as FULL_UNIVERSE, type MacroFactor } from "../shared/ontology";
import { composite, macroSignal, priceSignal, propagate, type MacroSignal, type PriceHistory } from "../shared/scoring";

const UNIVERSE = FULL_UNIVERSE.filter((t) => t.core);
const YEARS = Number(process.env.PE_YEARS ?? 2);
const BUY_SCORE = 0.15;
const TOP_N = 3;
const HORIZONS = [1, 5, 20];
/** 왕복 비용 + 슬리피지 (현실 보정 표시용) */
const ROUND_TRIP = 0.0053;

/* ── 데이터 (backtest.ts 와 같은 방식) ── */

interface Bars { symbol: string; t: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }

async function fetchBars(symbol: string, range: string): Promise<Bars | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; worldnews-predict-eval/0.1)" } });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const r = data?.chart?.result?.[0];
      if (!r?.timestamp) continue;
      const q = r.indicators.quote[0];
      const t: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number") continue;
        t.push(r.timestamp[i]);
        open.push(typeof q.open?.[i] === "number" ? q.open[i] : c);
        high.push(typeof q.high?.[i] === "number" ? q.high[i] : c);
        low.push(typeof q.low?.[i] === "number" ? q.low[i] : c);
        close.push(c);
        volume.push(typeof q.volume?.[i] === "number" ? q.volume[i] : 0);
      }
      return { symbol, t, open, high, low, close, volume };
    } catch { /* 다음 호스트 */ }
  }
  return null;
}

async function loadAll(symbols: string[], range: string): Promise<Map<string, Bars>> {
  const out = new Map<string, Bars>();
  for (let i = 0; i < symbols.length; i += 5) {
    const got = await Promise.all(symbols.slice(i, i + 5).map((s) => fetchBars(s, range)));
    for (const b of got) if (b) out.set(b.symbol.toUpperCase(), b);
  }
  return out;
}

const dateKey = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const sliceHistory = (b: Bars, upto: number): PriceHistory => ({
  price: b.close[upto],
  closes: b.close.slice(0, upto + 1),
  highs: b.high.slice(0, upto + 1),
  lows: b.low.slice(0, upto + 1),
  volumes: b.volume.slice(0, upto + 1),
});

/* ── 통계 유틸 ── */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
/** 평균이 0과 다른지 대략적인 t-값 (일별 표본이 겹쳐 있어 과신 금지 — 참고용) */
const tstat = (xs: number[]) => (xs.length > 2 && stdev(xs) > 0 ? mean(xs) / (stdev(xs) / Math.sqrt(xs.length)) : 0);

function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const r = new Array<number>(n);
    idx.forEach(([, i], pos) => (r[i] = pos));
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/* ── 평가 ── */

const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";

async function main() {
  const range = `${YEARS}y`;
  process.stderr.write(`데이터 수집 중 (${range})…\n`);
  const macroBars = await loadAll(MACRO.map((m) => m.symbol), range);
  const tickerBars = await loadAll([...UNIVERSE.map((t) => t.symbol), "^KS11"], range);
  const kospi = tickerBars.get("^KS11");
  if (!kospi) throw new Error("코스피 데이터 없음");
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

  /** 다음날 시가 매수 → H 거래일 뒤 종가 수익률 (비용 미반영 = 순수 예측력) */
  const fwdRet = (sym: string, scoreDate: string, H: number): number | null => {
    const b = tickerBars.get(sym);
    const di = calendar.indexOf(scoreDate);
    if (!b || di < 0 || di + 1 >= calendar.length) return null;
    const entry = idxAsOf(sym, calendar[di + 1]);
    if (entry < 0 || entry + H >= b.close.length) return null;
    const buy = b.open[entry];
    if (!buy) return null;
    return b.close[entry + H] / buy - 1;
  };

  process.stderr.write("일별 점수·미래 수익률 계산 중…\n");

  type DayEval = {
    date: string;
    picks: { name: string; score: number; ret: Record<number, number | null> }[];
    bottom: { name: string; ret: Record<number, number | null> }[];
    universeRet: Record<number, number[]>;
    kospiRet: Record<number, number | null>;
    ic: Record<number, number>;
  };
  const days: DayEval[] = [];

  for (let d = 60; d < calendar.length - 21; d++) {
    const today = calendar[d];
    const macro: MacroSignal[] = [];
    for (const f of MACRO as MacroFactor[]) {
      const i = idxAsOf(f.symbol.toUpperCase(), today);
      const b = macroBars.get(f.symbol.toUpperCase());
      if (i < 6 || !b) continue;
      macro.push(macroSignal(f, sliceHistory(b, i)));
    }
    if (macro.length < 4) continue;

    const ranked: { name: string; sym: string; score: number }[] = [];
    for (const t of UNIVERSE) {
      const sym = t.symbol.toUpperCase();
      const i = idxAsOf(sym, today);
      const b = tickerBars.get(sym);
      if (i < 60 || !b) continue;
      const hist = sliceHistory(b, i);
      ranked.push({ name: t.nameKo, sym, score: composite(propagate(t, macro).score, priceSignal(hist).score, 0) });
    }
    if (ranked.length < 10) continue;
    ranked.sort((a, b) => b.score - a.score);

    const rets: Record<number, (number | null)[]> = {};
    for (const H of HORIZONS) rets[H] = ranked.map((r) => fwdRet(r.sym, today, H));

    const universeRet: Record<number, number[]> = {};
    const ic: Record<number, number> = {};
    for (const H of HORIZONS) {
      const valid = ranked.map((r, i) => ({ s: r.score, ret: rets[H][i] })).filter((x): x is { s: number; ret: number } => x.ret !== null);
      universeRet[H] = valid.map((x) => x.ret);
      ic[H] = spearman(valid.map((x) => x.s), valid.map((x) => x.ret));
    }

    const ki = idxAsOf("^KS11", calendar[d + 1]);
    const kospiRet: Record<number, number | null> = {};
    for (const H of HORIZONS) {
      kospiRet[H] = ki >= 0 && ki + H < kospi.close.length ? kospi.close[ki + H] / kospi.open[ki] - 1 : null;
    }

    days.push({
      date: today,
      picks: ranked.slice(0, TOP_N).filter((r) => r.score >= BUY_SCORE).map((r, i) => ({
        name: r.name, score: r.score,
        ret: Object.fromEntries(HORIZONS.map((H) => [H, rets[H][ranked.indexOf(r)]])),
      })),
      bottom: ranked.slice(-TOP_N).map((r) => ({
        name: r.name,
        ret: Object.fromEntries(HORIZONS.map((H) => [H, rets[H][ranked.indexOf(r)]])),
      })),
      universeRet, kospiRet, ic,
    });
  }

  /* ── 집계 ── */

  console.log("\n" + "=".repeat(74));
  console.log(`예측력 평가  ${days[0].date} ~ ${days.at(-1)!.date}  (${days.length} 거래일 · 코어 ${UNIVERSE.length}종목)`);
  console.log(`추천 = 그날 점수 상위 ${TOP_N} 중 매수 기준(${BUY_SCORE}) 통과 · 다음날 시가 매수 가정 · 비용 미반영`);
  console.log("=".repeat(74));

  const pickDays = days.filter((d) => d.picks.length > 0);
  console.log(`\n추천이 나온 날: ${pickDays.length}/${days.length}일 (${((pickDays.length / days.length) * 100).toFixed(0)}%) — 나머지는 기준 미달로 관망`);

  console.log(`\n${"기간".padEnd(6)}${"추천 평균".padStart(11)}${"침팬지".padStart(10)}${"초과".padStart(10)}${"t값".padStart(7)}${"적중률".padStart(9)}${"침팬지 승률".padStart(13)}${"코스피".padStart(10)}`);
  console.log("─".repeat(74));
  for (const H of HORIZONS) {
    const pickR: number[] = [], chimpR: number[] = [], exR: number[] = [], kospiR: number[] = [];
    let hit = 0, hitN = 0, beat = 0, beatN = 0;
    for (const d of pickDays) {
      const rs = d.picks.map((p) => p.ret[H]).filter((r): r is number => r !== null);
      if (!rs.length || !d.universeRet[H].length) continue;
      const pr = mean(rs), cr = mean(d.universeRet[H]);
      pickR.push(pr); chimpR.push(cr); exR.push(pr - cr);
      if (d.kospiRet[H] !== null) kospiR.push(d.kospiRet[H]!);
      for (const r of rs) { hitN++; if (r > 0) hit++; }
      beatN++; if (pr > cr) beat++;
    }
    console.log(
      `${H}일`.padEnd(6) +
      pct(mean(pickR)).padStart(11) + pct(mean(chimpR)).padStart(10) + pct(mean(exR)).padStart(10) +
      tstat(exR).toFixed(1).padStart(7) +
      `${((hit / Math.max(1, hitN)) * 100).toFixed(0)}%`.padStart(9) +
      `${((beat / Math.max(1, beatN)) * 100).toFixed(0)}%`.padStart(13) +
      pct(mean(kospiR)).padStart(10),
    );
  }
  console.log("  * 침팬지 = 같은 날 같은 유니버스 무작위 선택의 기대 수익(유니버스 평균)");
  console.log("  * 초과 = 추천 − 침팬지. 이게 0 근처면 종목 선택 예측력이 없는 것이다.");

  console.log(`\n약세 경고 검증 (점수 최하위 ${TOP_N} — 예측력이 있다면 이쪽이 나빠야 함)`);
  for (const H of [5, 20]) {
    const botR: number[] = [], chimpR: number[] = [];
    for (const d of days) {
      const rs = d.bottom.map((p) => p.ret[H]).filter((r): r is number => r !== null);
      if (!rs.length || !d.universeRet[H].length) continue;
      botR.push(mean(rs)); chimpR.push(mean(d.universeRet[H]));
    }
    console.log(`  ${H}일: 최하위 ${pct(mean(botR))} vs 침팬지 ${pct(mean(chimpR))} → 격차 ${pct(mean(botR) - mean(chimpR))}`);
  }

  console.log(`\n점수 예측력 (IC — 점수와 미래 수익률의 순위상관, 전 종목 기준)`);
  for (const H of HORIZONS) {
    const ics = days.map((d) => d.ic[H]).filter((x) => Number.isFinite(x));
    const pos = ics.filter((x) => x > 0).length;
    console.log(`  ${H}일: 평균 IC ${mean(ics).toFixed(3)} · 양(+)인 날 ${((pos / ics.length) * 100).toFixed(0)}% · t값 ${tstat(ics).toFixed(1)}`);
  }
  console.log("  * IC 0.05 이상이면 쓸 만한 신호, 0.1 이상이면 강한 신호로 본다. 0 근처는 무의미.");

  /* 누적: 5일마다 추천 3종목 균등 매수·보유를 반복했다면 (겹침 없는 롤링) */
  console.log(`\n누적 시뮬 (5거래일마다 추천에 균등 재투자 · 추천 없으면 현금)`);
  for (const withCost of [false, true]) {
    let wealth = 1, chimpW = 1, chimpTimed = 1, kospiW = 1;
    for (let i = 0; i < days.length; i += 5) {
      const d = days[i];
      const rs = d.picks.map((p) => p.ret[5]).filter((r): r is number => r !== null);
      const uni = d.universeRet[5];
      const cost = withCost ? ROUND_TRIP : 0;
      if (rs.length) wealth *= 1 + mean(rs) - cost;
      if (uni.length) chimpW *= 1 + mean(uni) - cost;
      if (rs.length && uni.length) chimpTimed *= 1 + mean(uni) - cost; // 같은 타이밍, 무작위 종목
      if (d.kospiRet[5] !== null) kospiW *= 1 + d.kospiRet[5]!;
    }
    console.log(
      `  ${withCost ? "비용 반영" : "비용 제외"}: 추천 ${pct(wealth - 1)} · 침팬지(항상 투자) ${pct(chimpW - 1)} · 침팬지(같은 타이밍) ${pct(chimpTimed - 1)} · 코스피 ${pct(kospiW - 1)}`,
    );
  }
  console.log("  * '같은 타이밍' 침팬지와의 차이가 순수한 종목 선택 능력이다.");
  console.log("\n※ 뉴스 축은 과거 재현 불가로 0. 유니버스 생존편향 있음. 표본이 겹쳐 t값은 참고만.");
}

main().catch((e) => { console.error(e); process.exit(1); });
