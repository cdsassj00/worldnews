/**
 * "한 달 동안 거래량이 엄청 터졌는데 주가는 3%도 안 오른 종목" — 매집 신호 검증
 *
 * 신호(그날 종가까지의 정보만 사용):
 *   · 최근 20거래일 평균 거래량 ≥ 직전 60거래일 평균의 K배 (기본 2배)
 *   · 그 20일 중 거래량이 평소의 1.5배를 넘은 날이 6일 이상 (하루 반짝 급증 제외)
 *   · 같은 20일 동안 주가 변화가 −3% ~ +3% ("3%도 안 오름")
 * 매수: 신호 다음 날 시가. 매도: N거래일 뒤 종가. 비용 왕복 0.5%.
 * 같은 종목은 신호 뒤 20거래일 동안 다시 세지 않는다.
 * 비교: ① 같은 기간 코스피 ② 아무 날·아무 종목이나 샀을 때(기준선)
 * 국면: 바닥권(그 전 60일 −10% 이상 하락) / 고점권(그 전 60일 +20% 이상 상승) / 전체
 */
import { readFileSync, readdirSync } from "node:fs";
const DIR = process.argv[2];
const H = [5, 10, 20, 40];
const COST = 0.005;

function load(f) {
  try {
    const r = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"))?.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators.quote[0];
    const rows = [];
    r.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null || q.volume[i] == null) return;
      rows.push({ d: new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i], v: q.volume[i] });
    });
    return rows;
  } catch { return null; }
}
const idx = load("_KS11.json");
const idxByDate = new Map(idx.map((x, i) => [x.d, i]));

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const res = {}; // key -> {h: [{r, ir}]}
const push = (k, h, r, ir) => { ((res[k] ??= {})[h] ??= []).push({ r, ir }); };

for (const f of readdirSync(DIR)) {
  if (f.startsWith("_")) continue;
  const b = load(f); if (!b || b.length < 200) continue;
  const runs = [{ K: 2, tag: "거래량2배" }, { K: 3, tag: "거래량3배" }];
  for (const { K, tag } of runs) {
    let skipUntil = -1;
    for (let t = 80; t < b.length - 1; t++) {
      // 기준선(아무 날) — K=2 루프에서만 5일 간격 표본
      if (K === 2 && t % 5 === 0) record("기준선(아무 날·아무 종목)", b, t);
      if (t <= skipUntil) continue;
      const base = mean(b.slice(t - 79, t - 19).map((x) => x.v));
      if (!(base > 0)) continue;
      const win = b.slice(t - 19, t + 1);
      const v20 = mean(win.map((x) => x.v));
      const hot = win.filter((x) => x.v > base * 1.5).length;
      const chg = b[t].c / b[t - 20].c - 1;
      if (v20 < base * K || hot < 6 || chg < -0.03 || chg > 0.03) continue;
      const pre = b[t - 20].c / b[t - 80].c - 1;
      record(`${tag} · 전체`, b, t);
      if (pre <= -0.10) record(`${tag} · 바닥권(그 전 60일 −10%↓)`, b, t);
      else if (pre >= 0.20) record(`${tag} · 고점권(그 전 60일 +20%↑)`, b, t);
      else record(`${tag} · 중간`, b, t);
      skipUntil = t + 20;
    }
  }
}

function record(key, b, t) {
  const e = t + 1, entry = b[e].o;
  const ie = idxByDate.get(b[e].d);
  for (const h of H) {
    const x = e + h - 1; if (x >= b.length) continue;
    const r = b[x].c / entry - 1 - COST;
    const ix = idxByDate.get(b[x].d);
    const ir = ie !== undefined && ix !== undefined ? idx[ix].c / idx[ie].o - 1 : null;
    push(key, h, r, ir);
  }
}

const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
console.log(`기간: ${idx[0].d} ~ ${idx.at(-1).d}  ·  국내 ${readdirSync(DIR).length - 1}종목`);
console.log("구분 | 보유 | 건수 | 승률 | 평균 | 코스피 대비 초과 | 코스피보다 나은 비율");
for (const [k, byH] of Object.entries(res)) {
  for (const h of H) {
    const a = byH[h]; if (!a?.length) continue;
    const ex = a.filter((x) => x.ir !== null);
    console.log(`${k} | ${h}일 | ${a.length} | ${(a.filter((x) => x.r > 0).length / a.length * 100).toFixed(0)}% | ${pct(mean(a.map((x) => x.r)))} | ${pct(mean(ex.map((x) => x.r - x.ir)))} | ${(ex.filter((x) => x.r > x.ir).length / (ex.length || 1) * 100).toFixed(0)}%`);
  }
}
