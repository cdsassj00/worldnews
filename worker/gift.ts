import { GIFT_API_PATH, GIFT_PAGE_PATH, GIFT_SHARES, GIFT_STOCK_CODE, GIFT_STOCK_SYMBOL, giftRequestMessage, giftValue } from "../shared/gift";
import type { Env } from "./env";
import { domesticPrice, kisConfig, kisConfigured } from "./kis";
import { getSeries } from "./quotes";
import { ApiError } from "./util";

const TOKEN_KEY = "gift:kakao:token:v1";
const REQUEST_KEY = "gift:seungcheol:last-request";
const REQUEST_COOLDOWN_MS = 60_000;
const OAUTH_STATE_PREFIX = "gift:kakao:oauth:";

interface KakaoToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

function kstStamp(date = new Date()): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export async function giftQuote(env: Env): Promise<Record<string, unknown>> {
  let price = 0;
  let change = 0;
  let changePct = 0;
  let source = "Yahoo Finance";
  let asOf = Date.now();

  if (kisConfigured(env)) {
    try {
      const q = await domesticPrice(env, kisConfig(env), GIFT_STOCK_CODE);
      price = q.price;
      change = q.change;
      changePct = q.changePct;
      source = "한국투자증권 KIS";
    } catch { /* 공개 시세로 폴백 */ }
  }
  if (!price) {
    const q = await getSeries(env, GIFT_STOCK_SYMBOL, "5d");
    price = q.price;
    change = q.change;
    changePct = q.changePct;
    asOf = q.time || asOf;
  }
  if (!price) throw new ApiError(503, "gift_quote_unavailable");

  return {
    name: "삼성전자",
    code: GIFT_STOCK_CODE,
    shares: GIFT_SHARES,
    price: Math.round(price),
    change: Math.round(change),
    changePct,
    total: giftValue(price),
    source,
    asOf,
    notificationReady: await hasKakaoConnection(env),
  };
}

async function hasKakaoConnection(env: Env): Promise<boolean> {
  if (env.KAKAO_ACCESS_TOKEN || (env.KAKAO_REST_API_KEY && env.KAKAO_REFRESH_TOKEN)) return true;
  const stored = await env.CACHE.get(TOKEN_KEY, "json").catch(() => null) as KakaoToken | null;
  return Boolean(stored?.accessToken || (env.KAKAO_REST_API_KEY && stored?.refreshToken));
}

async function loadToken(env: Env): Promise<KakaoToken | null> {
  const stored = await env.CACHE.get(TOKEN_KEY, "json").catch(() => null) as KakaoToken | null;
  if (stored?.accessToken && stored.expiresAt > Date.now() + 60_000) return stored;

  const refreshToken = stored?.refreshToken || env.KAKAO_REFRESH_TOKEN;
  if (refreshToken && env.KAKAO_REST_API_KEY) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.KAKAO_REST_API_KEY,
      refresh_token: refreshToken,
    });
    if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
    const res = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
    });
    const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || typeof data.access_token !== "string") {
      throw new ApiError(503, "kakao_token_refresh_failed", { status: res.status, error: data.error ?? null });
    }
    const token: KakaoToken = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
      expiresAt: Date.now() + Math.max(300, Number(data.expires_in) || 21_000) * 1000,
    };
    await env.CACHE.put(TOKEN_KEY, JSON.stringify(token), { expirationTtl: 60 * 60 * 24 * 60 });
    return token;
  }

  if (env.KAKAO_ACCESS_TOKEN) {
    return { accessToken: env.KAKAO_ACCESS_TOKEN, expiresAt: Date.now() + 5 * 60_000 };
  }
  return null;
}

export async function startKakaoConnect(env: Env, origin: string): Promise<string> {
  if (!env.KAKAO_REST_API_KEY) throw new ApiError(503, "kakao_key_not_set");
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.CACHE.put(`${OAUTH_STATE_PREFIX}${state}`, "1", { expirationTtl: 600 });
  const redirectUri = `${origin}${GIFT_API_PATH}/kakao/callback`;
  const url = new URL("https://kauth.kakao.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.KAKAO_REST_API_KEY);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "talk_message");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function finishKakaoConnect(env: Env, origin: string, code: string, state: string): Promise<Response> {
  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const valid = state && await env.CACHE.get(stateKey).catch(() => null);
  if (!valid || !code || !env.KAKAO_REST_API_KEY) throw new ApiError(400, "invalid_kakao_callback");
  await env.CACHE.delete(stateKey).catch(() => undefined);
  const redirectUri = `${origin}${GIFT_API_PATH}/kakao/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.KAKAO_REST_API_KEY,
    redirect_uri: redirectUri,
    code,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new ApiError(503, "kakao_connect_failed", { status: res.status, error: data.error ?? null });
  }
  const token: KakaoToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in) || 21_000) * 1000,
  };
  await env.CACHE.put(TOKEN_KEY, JSON.stringify(token), { expirationTtl: 60 * 60 * 24 * 60 });
  return Response.redirect(`${origin}${GIFT_PAGE_PATH}?kakao=connected`, 302);
}

async function sendKakao(env: Env, text: string, pageUrl: string): Promise<void> {
  const token = await loadToken(env);
  if (!token) throw new ApiError(503, "kakao_not_connected", { saved: true, hint: "카카오 REST 키와 사용자 토큰 연결이 필요합니다." });
  const template = {
    object_type: "text",
    text,
    link: { web_url: pageUrl, mobile_web_url: pageUrl },
    button_title: "승철이 선물 페이지 보기",
  };
  const body = new URLSearchParams({ template_object: JSON.stringify(template) });
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.accessToken}`,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || Number(data.result_code) !== 0) {
    throw new ApiError(503, "kakao_send_failed", { saved: true, status: res.status, code: data.code ?? data.result_code ?? null });
  }
}

export async function requestGift(env: Env, origin: string, note: string): Promise<Record<string, unknown>> {
  const now = Date.now();
  const previous = await env.CACHE.get(REQUEST_KEY, "json").catch(() => null) as { at?: number } | null;
  if (previous?.at && now - previous.at < REQUEST_COOLDOWN_MS) {
    return { ok: true, duplicate: true, sentAt: previous.at, message: "조금 전 요청을 이미 전달했어요." };
  }

  const quote = await giftQuote(env);
  const cleanNote = note.trim().replace(/\s+/g, " ").slice(0, 100);
  const atKst = kstStamp();
  const message = `${giftRequestMessage(Number(quote.price), atKst)}${cleanNote ? `\n승철이 메모: ${cleanNote}` : ""}`;
  const record = { at: now, price: quote.price, total: quote.total, note: cleanNote, notified: false };
  await env.CACHE.put(REQUEST_KEY, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });

  await sendKakao(env, message, `${origin}${GIFT_PAGE_PATH}`);
  record.notified = true;
  await env.CACHE.put(REQUEST_KEY, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
  return { ok: true, duplicate: false, sentAt: now, total: quote.total, message: "아빠의 카카오톡으로 요청을 보냈어요!" };
}
