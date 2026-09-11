/**
 * 온톨로지 학습기 — 매매·시장 결과로 민감도 표를 진화시키는 MLOps 루프의 "학습" 단계.
 *
 *   ① 진단: 지난 1~2년에 대해 엣지(거시→섹터)마다
 *      "거시 유효신호(t) ↔ 섹터 5일 선행수익률(t)" 순위상관(IC)을 잰다.
 *      IC×부호가 양수면 우리가 적어둔 인과 방향이 데이터로 확인된 것이고,
 *      음수면 가정이 데이터와 어긋난 것이다.
 *   ② 후보 생성: 어긋난 엣지는 30% 축소, 강하게 확인된 엣지는 10% 강화.
 *      부호는 절대 뒤집지 않는다(경제적 근거가 있는 가정을 데이터 잡음으로
 *      뒤집으면 과최적화). 변경 폭도 ±1단계로 제한한다.
 *   ③ 게이트: 현재 표 vs 후보 표로 "추천 종목의 20일 미래수익(침팬지 대비)"을
 *      나란히 재고, 후보가 이길 때만 승격 자격을 준다.
 *
 * 출력: shared/sensitivity-candidate.json — 승격은 사람이 한다:
 *   curl -X POST https://stockontology.cc/api/onto/promote -H "Authorization: Bearer 거래암호" \
 *        -d @shared/sensitivity-candidate.json
 * 되돌리기: POST /api/onto/rollback
 *
 * 실행: npm run onto-learn  (기간: OL_YEARS=1)
 */
import { writeFileSync } from "node:fs";
import { MACRO, SENSITIVITY, UNIVERSE as FULL_UNIVERSE, type MacroFactor, type MacroId, type SectorId } from "../shared/ontology";
import { composite, effectiveValue, macroSignal, priceSignal, propagate, type MacroSignal, type PriceHistory } from "../shared/scoring";

const UNIVERSE = FULL_UNIVERSE.filter((t) => t.core || true); // 89종목 전체 — 섹터 표본을 넓힌다
const YEARS = Number(process.env.OL_YEARS ?? 1);
const FWD = 5; // 섹터 선행수익률 지평(거래일)
const CONFIRM = 0.05; // |IC| 이 이 이상이면 유의미로 본다
const SHRINK = 0.7; // 어긋난 엣지 축소 배율
const BOOST = 1.1; // 확인된 엣지 강화 배율
const MAX_W = 0.95;

interface Bars { symbol: string; t: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }

async function fetchBars(symbol: string, range: string): Promise<Bars | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; worldnews-onto-learn/0.1)" } });
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
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 20) return 0;
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

async function main() {
  const range = `${YEARS}y`;
  process.stderr.write(`데이터 수집 (${range})…\n`);
  const macroBars = await loadAll(MACRO.map((m) => m.symbol), range);
  const tickerBars = await loadAll([...UNIVERSE.map((t) => t.symbol), "^KS11"], range);
  const kospi = tickerBars.get("^KS11")!;
  const calendar = kospi.t.map(dateKey);

  const idxCache = new Map<string, Map<string, number>>();
  for (const [sym, b] of [...macroBars, ...tickerBars]) {
    const m = new Map<string, number>();
    b.t.forEach((ts, i) => m.set(dateKey(ts), i));
    idxCache.set(sym, m);
  }
  const idxOf = (sym: string, date: string) => idxCache.get(sym)?.get(date) ?? -1;

  /* 섹터별 소속 종목 (비중 0.4 이상만 — 잡탕 분류 잡음 제거) */
  const sectorMembers = new Map<SectorId, { symbol: string }[]>();
  for (const t of UNIVERSE) {
    for (const [sec, w] of Object.entries(t.sectors) as [SectorId, number][]) {
      if (w < 0.4) continue;
      if (!sectorMembers.has(sec)) sectorMembers.set(sec, []);
      sectorMembers.get(sec)!.push({ symbol: t.symbol.toUpperCase() });
    }
  }

  process.stderr.write("일별 신호·수익률 적재…\n");
  const days: string[] = [];
  const macroEv = new Map<string, Map<MacroId, number>>();
  const sectorFwd = new Map<string, Map<SectorId, number>>();

  for (let d = 60; d < calendar.length - FWD - 1; d++) {
    const today = calendar[d];
    const evs = new Map<MacroId, number>();
    for (const f of MACRO as MacroFactor[]) {
      const i = idxOf(f.symbol.toUpperCase(), today);
      const b = macroBars.get(f.symbol.toUpperCase());
      if (i < 6 || !b) continue;
      evs.set(f.id, effectiveValue(macroSignal(f, sliceHistory(b, i))));
    }
    if (evs.size < 6) continue;

    const fwd = new Map<SectorId, number>();
    for (const [sec, members] of sectorMembers) {
      const rets: number[] = [];
      for (const m of members) {
        const b = tickerBars.get(m.symbol);
        const i = idxOf(m.symbol, today);
        if (!b || i < 0 || i + 1 + FWD >= b.close.length) continue;
        const buy = b.open[i + 1];
        if (!buy) continue;
        rets.push(b.close[i + 1 + FWD] / buy - 1);
      }
      if (rets.length >= 2) fwd.set(sec, mean(rets));
    }
    days.push(today);
    macroEv.set(today, evs);
    sectorFwd.set(today, fwd);
  }
  process.stderr.write(`표본 ${days.length} 거래일\n`);

  /* ① 엣지별 진단 */
  type Diag = { sector: SectorId; macroId: MacroId; w: number; ic: number; confirmed: boolean; contradicted: boolean; n: number };
  const diags: Diag[] = [];
  for (const [sector, sens] of Object.entries(SENSITIVITY) as [SectorId, Partial<Record<MacroId, number>>][]) {
    for (const [macroId, w] of Object.entries(sens) as [MacroId, number][]) {
      const xs: number[] = [], ys: number[] = [];
      for (const day of days) {
        const ev = macroEv.get(day)?.get(macroId);
        const fr = sectorFwd.get(day)?.get(sector);
        if (ev === undefined || fr === undefined) continue;
        xs.push(ev);
        ys.push(fr);
      }
      const icRaw = spearman(xs, ys);
      const ic = icRaw * Math.sign(w); // 부호 정렬: 양수 = 우리 가정 방향이 맞음
      diags.push({ sector, macroId, w, ic: Math.round(ic * 1000) / 1000, confirmed: ic > CONFIRM, contradicted: ic < -CONFIRM, n: xs.length });
    }
  }

  /* ② 후보 표 생성 — 부호 유지, 폭 제한 */
  const candidate: Record<string, Record<string, number>> = {};
  for (const [sector, sens] of Object.entries(SENSITIVITY)) {
    candidate[sector] = {};
    for (const [macroId, w] of Object.entries(sens) as [MacroId, number][]) {
      const d = diags.find((x) => x.sector === sector && x.macroId === macroId)!;
      let nw = w;
      if (d.contradicted) nw = w * SHRINK;
      else if (d.confirmed && d.ic > 0.1) nw = Math.sign(w) * Math.min(MAX_W, Math.abs(w) * BOOST);
      candidate[sector][macroId] = Math.round(nw * 100) / 100;
    }
  }

  /* ③ 게이트 — 현재 vs 후보: 상위 3 추천의 20일 선행수익 (침팬지 대비) */
  process.stderr.write("게이트 백테스트…\n");
  const evalTable = (table: Record<string, Partial<Record<MacroId, number>>>) => {
    const excess: number[] = [];
    for (let d = 60; d < calendar.length - 21; d += 3) {
      const today = calendar[d];
      const macro: MacroSignal[] = [];
      for (const f of MACRO as MacroFactor[]) {
        const i = idxOf(f.symbol.toUpperCase(), today);
        const b = macroBars.get(f.symbol.toUpperCase());
        if (i < 6 || !b) continue;
        macro.push(macroSignal(f, sliceHistory(b, i)));
      }
      if (macro.length < 6) continue;
      const rows: { score: number; ret: number }[] = [];
      for (const t of UNIVERSE) {
        const sym = t.symbol.toUpperCase();
        const b = tickerBars.get(sym);
        const i = idxOf(sym, today);
        if (!b || i < 60 || i + 21 >= b.close.length) continue;
        const hist = sliceHistory(b, i);
        const score = composite(propagate(t, macro, table).score, priceSignal(hist).score, 0);
        const buy = b.open[i + 1];
        if (!buy) continue;
        rows.push({ score, ret: b.close[i + 21] / buy - 1 });
      }
      if (rows.length < 20) continue;
      rows.sort((a, b) => b.score - a.score);
      const picks = rows.slice(0, 3).filter((r) => r.score >= 0.15);
      if (!picks.length) continue;
      excess.push(mean(picks.map((p) => p.ret)) - mean(rows.map((r) => r.ret)));
    }
    return { meanExcess: mean(excess), n: excess.length };
  };
  const cur = evalTable(SENSITIVITY);
  const cand = evalTable(candidate as Record<string, Partial<Record<MacroId, number>>>);
  const pass = cand.meanExcess > cur.meanExcess;

  /* 출력 */
  const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
  console.log("\n" + "=".repeat(76));
  console.log(`온톨로지 학습 진단  ${days[0]} ~ ${days.at(-1)}  (표본 ${days.length}일 · 엣지 ${diags.length}개)`);
  console.log("=".repeat(76));
  const bad = diags.filter((d) => d.contradicted).sort((a, b) => a.ic - b.ic);
  const good = diags.filter((d) => d.confirmed).sort((a, b) => b.ic - a.ic);
  console.log(`\n데이터와 어긋난 엣지 (${bad.length}) — 후보에서 30% 축소:`);
  for (const d of bad) console.log(`  ${d.sector.padEnd(6)} ← ${d.macroId.padEnd(6)} w=${d.w}  IC=${d.ic}`);
  console.log(`\n데이터로 확인된 엣지 상위 (${good.length}):`);
  for (const d of good.slice(0, 12)) console.log(`  ${d.sector.padEnd(6)} ← ${d.macroId.padEnd(6)} w=${d.w}  IC=+${d.ic}`);
  console.log(`\n게이트 (상위3 추천의 20일 수익, 유니버스 평균 대비 · 3일 간격 표본 ${cur.n}회)`);
  console.log(`  현재 표: ${pct(cur.meanExcess)}   후보 표: ${pct(cand.meanExcess)}   →  ${pass ? "통과 ✓ (후보가 우월)" : "탈락 ✗ (현재 유지)"}`);

  const out = {
    generatedAt: new Date().toISOString(),
    window: { from: days[0], to: days.at(-1), samples: days.length },
    gate: { current: cur.meanExcess, candidate: cand.meanExcess, pass },
    diagnostics: diags,
    candidate,
  };
  writeFileSync("shared/sensitivity-candidate.json", JSON.stringify(out, null, 1));
  console.log(`\nshared/sensitivity-candidate.json 저장${pass ? " — 승격하려면 /api/onto/promote (거래 암호 필요)" : " — 게이트 탈락이라 승격 비권장"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
