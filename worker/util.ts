import type { Env } from "./env";

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

export function jsonCached(data: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

export class ApiError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: "internal_error", detail: message }, { status: 500 });
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  ttl?: number;
}

/**
 * 1층: 아이솔레이트 메모리 캐시.
 *
 * KV 무료 플랜은 **쓰기가 하루 1,000회**뿐이다. 시세처럼 TTL이 짧은 캐시를 KV에 쓰면
 * 그것만으로 하루 수천 회를 태워 한도를 소진하고, 그 뒤로는 모든 캐시 저장이 실패한다
 * (실제로 겪었다 — "KV put() limit exceeded for the day").
 * 그래서 짧은 캐시는 메모리에만 두고, KV에는 5분 이상짜리만 쓴다.
 * 아이솔레이트가 바뀌면 메모리는 비지만, 그 비용은 업스트림 fetch 한 번이다.
 */
const MEM = new Map<string, CacheEntry<unknown>>();
const MEM_MAX = 500;
/** 이 TTL(초) 미만짜리는 KV에 쓰지 않는다 */
const KV_WRITE_MIN_TTL = 300;

function memGet<T>(key: string): CacheEntry<T> | null {
  return (MEM.get(key) as CacheEntry<T> | undefined) ?? null;
}

function memSet<T>(key: string, entry: CacheEntry<T>): void {
  if (MEM.size >= MEM_MAX) {
    // 가장 오래된 것부터 버린다 (Map 은 삽입 순서를 보존한다)
    const first = MEM.keys().next().value;
    if (first !== undefined) MEM.delete(first);
  }
  MEM.delete(key);
  MEM.set(key, entry);
}

/**
 * read-through 캐시 (메모리 → KV → loader). 같은 키의 결과를 ttl초 동안 재사용한다.
 * 실패 시(예: 업스트림 장애) 만료된 값이라도 stale 로 돌려준다.
 */
/**
 * 캐시 무효화 — 설정이 바뀌어 캐시된 결과가 즉시 틀려지는 경우에 쓴다.
 *
 * 메모리 캐시는 아이솔레이트마다 따로라 여기서 지워도 다른 아이솔레이트에는 남는다.
 * 그래서 이것만 믿지 말고, 설정에 따라 달라지는 결과는 **캐시 키에 설정값을 넣는 것**이
 * 근본 해법이다(예: auto:plan:onto / auto:plan:quant).
 */
export async function invalidateCache(env: Env, key: string): Promise<void> {
  MEM.delete(key);
  await env.CACHE.delete(key).catch(() => undefined);
}

export async function cached<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  /** 결과에 따라 TTL을 다르게 주고 싶을 때(예: 빈 결과는 짧게) */
  ttlFor?: (data: T) => number,
): Promise<{ data: T; stale: boolean; fetchedAt: number }> {
  const now = Date.now();
  const fresh = (e: CacheEntry<T> | null) => e && now - e.fetchedAt < (e.ttl ?? ttlSeconds) * 1000;

  const mem = memGet<T>(key);
  if (fresh(mem)) return { data: mem!.data, stale: false, fetchedAt: mem!.fetchedAt };

  let kv: CacheEntry<T> | null = null;
  if (ttlSeconds >= KV_WRITE_MIN_TTL) {
    kv = (await env.CACHE.get(key, "json").catch(() => null)) as CacheEntry<T> | null;
    if (fresh(kv)) {
      memSet(key, kv!);
      return { data: kv!.data, stale: false, fetchedAt: kv!.fetchedAt };
    }
  }

  try {
    const data = await loader();
    const effectiveTtl = ttlFor ? ttlFor(data) : ttlSeconds;
    const entry: CacheEntry<T> = { data, fetchedAt: now, ttl: effectiveTtl };
    memSet(key, entry);
    if (effectiveTtl >= KV_WRITE_MIN_TTL) {
      await env.CACHE.put(
        key,
        JSON.stringify(entry),
        // 만료 후에도 stale 폴백으로 쓰려고 TTL을 넉넉히 준다(최소 60초).
        { expirationTtl: Math.max(60, effectiveTtl * 12) },
      ).catch(() => undefined);
    }
    return { data, stale: false, fetchedAt: now };
  } catch (err) {
    const fallback = mem ?? kv;
    if (fallback) return { data: fallback.data, stale: true, fetchedAt: fallback.fetchedAt };
    throw err;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (!res.ok) throw new ApiError(502, `upstream_${res.status}`, { url, status: res.status });
  return (await res.json()) as T;
}

export async function fetchText(url: string, init?: RequestInit, timeoutMs = 8000): Promise<string> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (!res.ok) throw new ApiError(502, `upstream_${res.status}`, { url, status: res.status });
  return await res.text();
}

export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; worldnews-globe/0.1)",
        "accept-language": "ko,en;q=0.8",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function round(v: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** 타이밍 세이프 문자열 비교 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
