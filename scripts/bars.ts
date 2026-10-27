/**
 * 백테스트용 일봉 수집기 — 야후 차트 API.
 *
 * backtest.ts(온톨로지 트랙)와 quant-backtest.ts(수급·차트 트랙)가 같은 데이터
 * 경로를 쓰도록 분리했다. 두 백테스트가 서로 다른 방식으로 캔들을 정제하면
 * 비교 결과 자체를 믿을 수 없다.
 */

export interface Bars {
  symbol: string;
  /** epoch seconds */
  t: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/**
 * 디스크 캐시 — 같은 구간을 여러 번(3개월·6개월·1년) 돌릴 때 야후를 다시 긁지 않는다.
 * BT_CACHE 로 경로를 주면 켜진다. 캐시가 오래되면 지우면 그만이라 무효화 로직은 두지 않는다.
 */
const CACHE_DIR = process.env.BT_CACHE || "";

function cachePath(symbol: string, range: string): string {
  return `${CACHE_DIR}/${encodeURIComponent(symbol)}__${range}.json`;
}

export async function fetchBars(symbol: string, range: string, tries = 2): Promise<Bars | null> {
  if (CACHE_DIR) {
    try {
      const fs = await import("node:fs");
      const p = cachePath(symbol, range);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as Bars;
    } catch { /* 캐시 없으면 그냥 받는다 */ }
  }
  const got = await fetchFresh(symbol, range, tries);
  if (got && CACHE_DIR) {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath(symbol, range), JSON.stringify(got));
    } catch { /* 캐시 실패는 무시 */ }
  }
  return got;
}

async function fetchFresh(symbol: string, range: string, tries: number): Promise<Bars | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
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
    if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

export async function loadAll(symbols: string[], range: string, concurrency = 5, onProgress?: (done: number, total: number) => void): Promise<Map<string, Bars>> {
  const out = new Map<string, Bars>();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const got = await Promise.all(batch.map((s) => fetchBars(s, range)));
    for (const b of got) if (b) out.set(b.symbol.toUpperCase(), b);
    onProgress?.(Math.min(i + concurrency, symbols.length), symbols.length);
  }
  return out;
}

/** 날짜(YYYY-MM-DD) 키 */
export function dateKey(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/** 심볼별 "그 날짜 이하의 마지막 인덱스" 조회기 */
export function makeIdxAsOf(all: Map<string, Bars>[]): (sym: string, date: string) => number {
  const indexByDate = new Map<string, Map<string, number>>();
  const barsBySym = new Map<string, Bars>();
  for (const m of all) {
    for (const [sym, b] of m) {
      const idx = new Map<string, number>();
      b.t.forEach((ts, i) => idx.set(dateKey(ts), i));
      indexByDate.set(sym, idx);
      barsBySym.set(sym, b);
    }
  }
  return (sym: string, date: string): number => {
    const m = indexByDate.get(sym);
    const b = barsBySym.get(sym);
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
}
