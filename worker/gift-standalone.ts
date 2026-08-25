import { GIFT_API_PATH, GIFT_PAGE_PATH } from "../shared/gift";
import type { Env } from "./env";
import { finishKakaoConnect, giftQuote, requestGift, startKakaoConnect } from "./gift";
import { assertTradeAuth } from "./kis";
import { ApiError, errorResponse, json } from "./util";

const GIFT_ASSET_PREFIX = "/gift-assets/";

async function giftPage(request: Request, env: Env, url: URL): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(`${url.origin}/gift-shell.txt`, request));
  if (!shell.ok) return new Response("Gift page unavailable", { status: 503 });

  // 선물 전용 Worker의 자산 경로를 사용해 메인 사이트의 /assets 와 완전히 분리한다.
  const html = (await shell.text()).replaceAll("/assets/", GIFT_ASSET_PREFIX);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
      "referrer-policy": "no-referrer",
    },
  });
}

async function giftAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const assetPath = `/assets/${url.pathname.slice(GIFT_ASSET_PREFIX.length)}`;
  const assetUrl = new URL(assetPath, url.origin);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("cache-control", "private, max-age=86400");
  return new Response(asset.body, { status: asset.status, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if ((path === GIFT_PAGE_PATH || path === `${GIFT_PAGE_PATH}/`) && (request.method === "GET" || request.method === "HEAD")) {
    return giftPage(request, env, url);
  }

  if (path.startsWith(GIFT_ASSET_PREFIX) && request.method === "GET") {
    return giftAsset(request, env, url);
  }

  if (path.startsWith("/gift/") && request.method === "GET") {
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    headers.set("cache-control", "private, max-age=86400");
    return new Response(asset.body, { status: asset.status, headers });
  }

  if (path === GIFT_API_PATH) {
    if (request.method === "GET") return json(await giftQuote(env));
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { note?: string };
      return json(await requestGift(env, url.origin, String(body.note ?? "")));
    }
    throw new ApiError(405, "method_not_allowed");
  }

  if (path === `${GIFT_API_PATH}/kakao/start`) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json({ url: await startKakaoConnect(env, url.origin) });
  }

  if (path === `${GIFT_API_PATH}/kakao/callback`) {
    if (url.searchParams.get("error")) throw new ApiError(400, "kakao_consent_denied");
    return finishKakaoConnect(env, url.origin, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
  }

  return new Response("Not found", {
    status: 404,
    headers: { "x-robots-tag": "noindex, nofollow, noarchive" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
