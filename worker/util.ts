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

/**
 * KV 기반 read-through 캐시. 같은 키에 대한 결과를 ttl초 동안 재사용한다.
 * 실패 시(예: 업스트림 장애) 만료된 값이라도 stale 로 돌려준다.
 */
export async function cached<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<{ data: T; stale: boolean; fetchedAt: number }> {
  const raw = await env.CACHE.get(key, "json").catch(() => null);
  const entry = raw as { data: T; fetchedAt: number } | null;
  const now = Date.now();
  if (entry && now - entry.fetchedAt < ttlSeconds * 1000) {
    return { data: entry.data, stale: false, fetchedAt: entry.fetchedAt };
  }
  try {
    const data = await loader();
    await env.CACHE.put(
      key,
      JSON.stringify({ data, fetchedAt: now }),
      // 만료 후에도 stale 폴백으로 쓰려고 TTL을 넉넉히 준다(최소 60초).
      { expirationTtl: Math.max(60, ttlSeconds * 12) },
    ).catch(() => undefined);
    return { data, stale: false, fetchedAt: now };
  } catch (err) {
    if (entry) return { data: entry.data, stale: true, fetchedAt: entry.fetchedAt };
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
