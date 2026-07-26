import type { Env } from "./env";
import { ApiError, cached, fetchJson, num, round } from "./util";

export interface Series {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  /** 현재가(또는 최종 종가) */
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  marketState: string;
  time: number;
  /** 일봉 종가(오래된 → 최신) */
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
}

interface YahooChart {
  chart: {
    error: { code: string; description: string } | null;
    result:
      | {
          meta: Record<string, unknown>;
          timestamp?: number[];
          indicators: { quote: { close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[] }[] };
        }[]
      | null;
  };
}

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

/** Yahoo Finance 차트 API. 무인증이라 호출 실패 시 호스트를 번갈아 시도한다. */
async function loadSeries(symbol: string, range: string, interval: string): Promise<Series> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const data = await fetchJson<YahooChart>(url);
      const r = data.chart.result?.[0];
      if (!r) throw new ApiError(404, "symbol_not_found", { symbol, reason: data.chart.error?.description });
      const meta = r.meta;
      const q = r.indicators?.quote?.[0] ?? {};
      const closes = (q.close ?? []).filter((v): v is number => typeof v === "number");
      const price = num(meta.regularMarketPrice, closes.at(-1) ?? 0);
      // chartPreviousClose 는 "조회 구간 직전 종가"라서 range 가 길면 전일 종가가 아니다.
      // 직전 일봉 종가 → previousClose → chartPreviousClose 순으로 써야 전일대비가 맞는다.
      const prevClose = num(closes.at(-2), num(meta.previousClose, num(meta.chartPreviousClose, price)));
      if (!price) throw new ApiError(404, "no_price", { symbol });
      return {
        symbol: String(meta.symbol ?? symbol),
        name: String(meta.shortName ?? meta.longName ?? symbol),
        currency: String(meta.currency ?? ""),
        exchange: String(meta.fullExchangeName ?? meta.exchangeName ?? ""),
        price: round(price, 4),
        prevClose: round(prevClose, 4),
        change: round(price - prevClose, 4),
        changePct: prevClose ? round(((price - prevClose) / prevClose) * 100, 2) : 0,
        marketState: String(meta.marketState ?? "UNKNOWN"),
        time: num(meta.regularMarketTime) * 1000,
        closes: closes.map((v) => round(v, 4)),
        highs: (q.high ?? []).filter((v): v is number => typeof v === "number").map((v) => round(v, 4)),
        lows: (q.low ?? []).filter((v): v is number => typeof v === "number").map((v) => round(v, 4)),
        volumes: (q.volume ?? []).map((v) => (typeof v === "number" ? v : 0)),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiError(502, "quote_failed", { symbol });
}

export async function getSeries(env: Env, symbol: string, range = "3mo", interval = "1d"): Promise<Series> {
  const ttl = interval === "1d" ? 120 : 60;
  const { data } = await cached(env, `q:${symbol}:${range}:${interval}`, ttl, () => loadSeries(symbol, range, interval));
  return data;
}

/** 여러 심볼을 동시 6개 제한(Workers 커넥션 한도)에 맞춰 병렬 조회. 실패한 심볼은 제외한다. */
export async function getManySeries(env: Env, symbols: string[], range = "3mo"): Promise<Series[]> {
  const out: Series[] = [];
  const uniq = [...new Set(symbols.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 5) {
    const batch = uniq.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map((s) => getSeries(env, s, range)));
    for (const s of settled) if (s.status === "fulfilled") out.push(s.value);
  }
  return out;
}

/** 지수/티커테이프용 경량 표현 */
export interface Snapshot {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  currency: string;
  marketState: string;
}

export function toSnapshot(s: Series, label?: string): Snapshot {
  return {
    symbol: s.symbol,
    label: label ?? s.name,
    price: s.price,
    changePct: s.changePct,
    currency: s.currency,
    marketState: s.marketState,
  };
}
