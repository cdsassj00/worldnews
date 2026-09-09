/**
 * 장면 SVG → PNG. 텔레그램·SNS 는 SVG 를 못 그리기 때문에 래스터가 필요하다.
 *
 * Cloudflare Browser Rendering(BROWSER 바인딩)으로 우리 scene.svg 를 열어 화면을 찍는다.
 * 워커 안에서 직접 SVG 를 그리는 방법(resvg-wasm 등)도 있지만, 한글 폰트를 번들에 넣어야 하고
 * 사이트 화면과 미세하게 달라진다 — **보이는 그대로**를 보내려면 실제로 렌더해서 찍는 편이 맞다.
 *
 * 브라우저는 비싸다(기동 수 초). 하루 몇 장 수준에서만 쓰고, 결과는 KV 에 캐시한다.
 */
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./env";

const SITE = "https://stockontology.cc";
const TTL = 3600; // 1시간 — 같은 차트를 하루에 여러 번 찍지 않는다

/** scene.svg 한 장을 PNG 로. 실패하면 null (공지는 이미지 없이라도 나가야 한다) */
export async function sceneShot(env: Env, view: string, market: "KR" | "US" = "KR"): Promise<ArrayBuffer | null> {
  if (!env.BROWSER) return null;
  const key = `shot:v1:${market}:${view}`;
  const cached = await env.CACHE.get(key, "arrayBuffer").catch(() => null);
  if (cached) return cached;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    const url = `${SITE}/api/scene.svg?market=${market}&view=${encodeURIComponent(view)}`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
    const buf = (await page.screenshot({ type: "png" })) as unknown as ArrayBuffer;
    await env.CACHE.put(key, buf, { expirationTtl: TTL }).catch(() => undefined);
    return buf;
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
