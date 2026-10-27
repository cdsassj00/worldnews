/**
 * shared/markets.ts 에 들어있는 Yahoo Finance 심볼이 실제로 시세를 반환하는지 확인한다.
 * 사용: npm run validate:symbols
 * 출력: OK / DEAD 목록. DEAD 심볼은 markets.ts 에서 제거하거나 교체한다.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../shared/markets.ts", import.meta.url), "utf8");

const symbols = new Set();
for (const m of src.matchAll(/(?:^|\s)(?:index|index2|symbol):\s*"([^"]+)"/g)) symbols.add(m[1]);
for (const m of src.matchAll(/\{\s*symbol:\s*"([^"]+)"/g)) symbols.add(m[1]);

const list = [...symbols].sort();
console.log(`checking ${list.length} symbols…\n`);

const dead = [];
const ok = [];

async function check(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const px = r?.meta?.regularMarketPrice;
    if (typeof px === "number") ok.push(`${sym} = ${px} ${r.meta.currency ?? ""}`);
    else dead.push(`${sym} :: ${j?.chart?.error?.description ?? "no price"}`);
  } catch (err) {
    dead.push(`${sym} :: ${err.message}`);
  }
}

// 4개씩 순차 배치 (레이트리밋 회피)
for (let i = 0; i < list.length; i += 4) {
  await Promise.all(list.slice(i, i + 4).map(check));
  await new Promise((r) => setTimeout(r, 120));
}

console.log("── OK ──");
for (const l of ok) console.log("  " + l);
console.log(`\n── DEAD (${dead.length}) ──`);
for (const l of dead) console.log("  " + l);
process.exitCode = dead.length ? 1 : 0;
