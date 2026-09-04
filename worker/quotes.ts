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
  /** closes 와 같은 인덱스로 정렬된 시가 — 캔들스틱 렌더용(2026-09-04) */
  opens: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  /** closes 와 같은 인덱스로 정렬된 밀리초 epoch — 지지·저항이 "언제" 만들어졌는지 표기용
   * (2026-09-04 유튜브 파이프라인 요청: levelNote 에 월 표기). highs/lows/volumes 는 각자
   * 독립적으로 null 을 걸러 만들어져 인덱스가 어긋날 수 있어(기존 동작 유지), 새 용도에는
   * closes 와 함께 걸러진 이 배열만 쓴다. */
  timestamps: number[];
}

interface YahooChart {
  chart: {
    error: { code: string; description: string } | null;
    result:
      | {
          meta: Record<string, unknown>;
          timestamp?: number[];
          indicators: { quote: { open?: (number | null)[]; close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[] }[] };
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
      const rawCloses = q.close ?? [];
      const rawOpens = q.open ?? [];
      const ts = r.timestamp ?? [];
      const closes: number[] = [];
      const opens: number[] = [];
      const timestamps: number[] = [];
      for (let i = 0; i < rawCloses.length; i++) {
        const v = rawCloses[i];
        if (typeof v !== "number") continue;
        closes.push(v);
        opens.push(typeof rawOpens[i] === "number" ? (rawOpens[i] as number) : v);
        timestamps.push((ts[i] ?? 0) * 1000);
      }
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
        opens: opens.map((v) => round(v, 4)),
        highs: (q.high ?? []).filter((v): v is number => typeof v === "number").map((v) => round(v, 4)),
        lows: (q.low ?? []).filter((v): v is number => typeof v === "number").map((v) => round(v, 4)),
        volumes: (q.volume ?? []).map((v) => (typeof v === "number" ? v : 0)),
        timestamps,
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

/* ── 배치 시세 (spark) ─────────────────────────────── */

/** 종가만 있는 경량 시리즈. 확장 유니버스(수십 종목)용 — fetch 한 번에 최대 20심볼. */
export interface SparkSeries {
  symbol: string;
  price: number;
  changePct: number;
  closes: number[];
  /** 마지막 일봉의 시각(ms) — "이 시세가 언제 것인지"를 화면에 밝히는 데 쓴다 */
  ts: number | null;
}

/** 응답은 { "005930.KS": { close: [...], timestamp: [...] }, ... } 형태의 평면 맵이다 */
type YahooSpark = Record<string, { symbol?: string; close?: (number | null)[]; timestamp?: number[] } | undefined>;

async function loadSpark(symbols: string[], range: string): Promise<SparkSeries[]> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(","))}&range=${range}&interval=1d`;
      const data = await fetchJson<YahooSpark>(url, undefined, 9000);
      const out: SparkSeries[] = [];
      for (const sym of symbols) {
        const r = data[sym];
        const closes = (r?.close ?? []).filter((v): v is number => typeof v === "number");
        if (closes.length < 2) continue;
        const price = closes.at(-1)!;
        const prev = num(closes.at(-2), price);
        const lastTs = r?.timestamp?.length ? r.timestamp[r.timestamp.length - 1] * 1000 : null;
        out.push({
          symbol: sym,
          price: round(price, 4),
          changePct: prev ? round(((price - prev) / prev) * 100, 2) : 0,
          closes: closes.map((v) => round(v, 4)),
          ts: lastTs,
        });
      }
      if (out.length) return out;
      throw new ApiError(502, "spark_empty", { symbols: symbols.length });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiError(502, "spark_failed");
}

/** 캐시 없이 바로 배치 조회 (레이더 스캔용 — 한 번 쓰고 버리는 데이터라 캐시가 낭비다) */
export async function loadSparkFresh(symbols: string[], range = "6mo"): Promise<SparkSeries[]> {
  const uniq = [...new Set(symbols.filter(Boolean))];
  const out: SparkSeries[] = [];
  for (let i = 0; i < uniq.length; i += 20) {
    try {
      out.push(...(await loadSpark(uniq.slice(i, i + 20), range)));
    } catch {
      /* 한 묶음 실패는 무시 */
    }
  }
  return out;
}

/**
 * 확장 유니버스 배치 조회. 20심볼씩 묶어 fetch 하고 묶음 단위로 캐시한다.
 * TTL 30분 — 5일 변화율·모멘텀 계산엔 충분하고 KV 쓰기 예산을 지킨다.
 */
export async function getSparkMany(env: Env, symbols: string[], range = "6mo"): Promise<SparkSeries[]> {
  const uniq = [...new Set(symbols.filter(Boolean))].sort();
  const out: SparkSeries[] = [];
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    try {
      const { data } = await cached(env, `spark:${range}:${batch[0]}:${batch.length}`, 1800, () => loadSpark(batch, range));
      out.push(...data);
    } catch {
      /* 한 묶음이 죽어도 나머지는 살린다 */
    }
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
