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

export interface ShotRequest { view: string; market?: "KR" | "US"; caption?: string }
export interface Shot { view: string; png: ArrayBuffer; caption: string }

/**
 * 여러 장을 브라우저 한 번으로 찍는다.
 *
 * 브라우저 기동이 몇 초라 장면마다 launch 하면 3장에 20초씩 든다 — 텔레그램 명령은
 * 그 사이 무응답으로 보인다. 캐시에 있는 장면은 브라우저를 열기 전에 먼저 걷어낸다.
 * 못 찍은 장면은 조용히 빠진다(그림 한 장 때문에 글까지 막지 않는다).
 */
export async function sceneShots(env: Env, reqs: ShotRequest[]): Promise<Shot[]> {
  if (!reqs.length) return [];
  const out: Shot[] = [];
  const todo: { req: ShotRequest; key: string }[] = [];

  for (const req of reqs) {
    const market = req.market ?? "KR";
    const key = `shot:v1:${market}:${req.view}`;
    const hit = env.BROWSER ? await env.CACHE.get(key, "arrayBuffer").catch(() => null) : null;
    if (hit) out.push({ view: req.view, png: hit, caption: req.caption ?? "" });
    else todo.push({ req, key });
  }
  if (!todo.length || !env.BROWSER) return out;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    for (const { req, key } of todo) {
      try {
        const market = req.market ?? "KR";
        const url = `${SITE}/api/scene.svg?market=${market}&view=${encodeURIComponent(req.view)}`;
        const resp = await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
        // 장면이 404/400 이면 브라우저는 JSON 오류 본문을 그린다 — 그걸 찍어 보내면
        // "흰 화면에 코드 몇 줄"이 채널에 올라간다(2026-09-09 ING 실측). 그럴 바엔 이미지를 뺀다.
        const ct = resp?.headers()["content-type"] ?? "";
        if (!resp || !resp.ok() || !ct.includes("svg")) continue;
        const buf = (await page.screenshot({ type: "png" })) as unknown as ArrayBuffer;
        await env.CACHE.put(key, buf, { expirationTtl: TTL }).catch(() => undefined);
        out.push({ view: req.view, png: buf, caption: req.caption ?? "" });
      } catch {
        /* 이 장면만 건너뛴다 */
      }
    }
  } catch {
    /* 브라우저를 못 열면 캐시에서 건진 것만 돌려준다 */
  } finally {
    await browser?.close().catch(() => undefined);
  }
  // 호출자가 준 순서대로 — 앨범에서 차트가 전략표 뒤로 가면 읽는 순서가 틀어진다
  const rank = new Map(reqs.map((r, i) => [r.view, i]));
  return out.sort((a, b) => (rank.get(a.view) ?? 0) - (rank.get(b.view) ?? 0));
}

/** scene.svg 한 장을 PNG 로. 실패하면 null (공지는 이미지 없이라도 나가야 한다) */
export async function sceneShot(env: Env, view: string, market: "KR" | "US" = "KR"): Promise<ArrayBuffer | null> {
  const [shot] = await sceneShots(env, [{ view, market }]);
  return shot?.png ?? null;
}
