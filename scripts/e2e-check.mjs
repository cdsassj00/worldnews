/**
 * 브라우저 실검증 스크립트.
 * 지구본이 실제로 렌더되는지, 캔버스 중앙 클릭이 의도한 국가로 잡히는지(텍스처↔지오메트리 정렬),
 * 국가 패널·추천·주문 탭이 렌더되는지 확인하고 스크린샷을 남긴다.
 *
 * 사용: node scripts/e2e-check.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const outDir = process.argv[3] ?? "/tmp/wfg-shots";
mkdirSync(outDir, { recursive: true });

const failures = [];
const ok = [];
const check = (name, cond, extra = "") => {
  (cond ? ok : failures).push(`${name}${extra ? ` — ${extra}` : ""}`);
};

// 컨테이너에 미리 설치된 Chromium 을 그대로 쓴다(버전 핀 불일치 회피).
const CHROME_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter(Boolean);
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
// 폰트 CDN 차단(샌드박스)은 기능 결함이 아니므로 분리해 기록한다
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText ?? ""}`));
const isExternalAsset = (u) => /fonts\.googleapis|fonts\.gstatic|jsdelivr/.test(u);

await page.goto(base, { waitUntil: "domcontentloaded" });

// 지구본 초기화 대기
await page.waitForFunction(() => window.__wfg?.ready === true, { timeout: 45000 });
check("지구본 초기화", true);

// WebGL 렌더 확인: 실제 드로우콜/삼각형이 나가는지 (readPixels 는 더블버퍼 때문에 신뢰 못 함)
await page.waitForTimeout(800);
const stats = await page.evaluate(() => window.__wfg.globe.renderStats());
check("WebGL 렌더 동작", stats.frames > 3 && stats.triangles > 1000, `frames ${stats.frames} · calls ${stats.calls} · tri ${stats.triangles}`);

// 국가 클릭 정확도: 여러 나라를 정면으로 돌린 뒤 캔버스 중앙 클릭 → 같은 나라가 잡혀야 한다
const canvas = await page.locator("#globe").boundingBox();
const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

for (const cc of ["KR", "US", "BR", "DE", "AU", "IN", "ZA", "RU", "CA", "JP", "AR", "CN", "GB", "MX"]) {
  await page.evaluate((code) => window.__wfg.globe.selectByIso2(code), cc);
  await page.waitForFunction(() => window.__wfg.globe.isFlying() === false, { timeout: 15000 });
  await page.waitForTimeout(120);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(350);
  const picked = await page.evaluate(() => window.__wfg.lastPick);
  check(`중앙 클릭 픽 정확도 ${cc}`, picked?.iso2 === cc, `잡힌 국가 ${picked?.iso2 ?? "없음"} (${picked?.ko ?? "-"})`);
}

// 한국 패널 확인
await page.evaluate(() => window.__wfg.globe.selectByIso2("KR"));
await page.waitForSelector(".panel-head h2", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".index-card").length > 0, { timeout: 30000 });
const title = await page.locator(".panel-head h2").first().textContent();
check("패널 국가명", title?.includes("대한민국"), `표시 ${title}`);
const idxCount = await page.locator(".index-card").count();
check("지수 카드", idxCount >= 1, `${idxCount}개`);

// 추천 탭
await page.getByRole("tab", { name: /추천/ }).click();
await page.waitForFunction(() => document.querySelectorAll(".reco").length > 0, { timeout: 40000 });
const recoCount = await page.locator(".reco").count();
check("추천 카드", recoCount >= 3, `${recoCount}개`);
await page.locator(".reco-head").first().click();
await page.waitForSelector(".plan-grid");
check("추천 상세(손절/목표)", (await page.locator(".plan-cell").count()) >= 4);
await page.screenshot({ path: `${outDir}/02-reco.png` });

// 뉴스 탭
await page.getByRole("tab", { name: /뉴스/ }).click();
await page.waitForFunction(() => document.querySelectorAll(".news-list li a").length > 0, { timeout: 30000 });
check("뉴스 목록", (await page.locator(".news-list li a").count()) > 3, `${await page.locator(".news-list li a").count()}건`);

// 주문 탭
await page.getByRole("tab", { name: "주문" }).click();
await page.waitForTimeout(600);
const orderFormVisible = await page.locator('form[data-role="order-form"]').count();
const warnVisible = await page.locator(".order-warn").count();
check("주문 탭 렌더", orderFormVisible + warnVisible > 0, `form ${orderFormVisible} / 경고 ${warnVisible}`);
await page.screenshot({ path: `${outDir}/03-order.png` });

// 티커테이프 & 좌측 요약
check("티커테이프", (await page.locator(".tape-item").count()) > 5);
check("지금 움직이는 시장", (await page.locator("#hot-list button").count()) >= 3);
check("글로벌 헤드라인", (await page.locator("#global-news a").count()) >= 3);

// 검색
await page.fill("#country-search", "일본");
await page.waitForSelector("#search-results button");
await page.locator("#search-results button").first().click();
await page.waitForFunction(() => document.querySelector(".panel-head h2")?.textContent?.includes("일본"), { timeout: 20000 });
check("국가 검색", true);

// 전체 화면 스크린샷 (지구본 정면 = 일본)
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/01-overview.png` });

// 모바일 레이아웃
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);
const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
check("모바일 가로 스크롤 없음", !hScroll);
await page.screenshot({ path: `${outDir}/04-mobile.png`, fullPage: false });

const appFailures = failedRequests.filter((u) => !isExternalAsset(u));
const externalFailures = failedRequests.filter(isExternalAsset);
check("앱 리소스 로드 실패 없음", appFailures.length === 0, appFailures.slice(0, 3).join(" | "));
check(
  "콘솔 에러 없음(외부 폰트 CDN 제외)",
  consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0,
  consoleErrors.slice(0, 3).join(" | "),
);
if (externalFailures.length) {
  console.log(`\n[참고] 샌드박스에서 차단된 외부 폰트/CDN 요청 ${externalFailures.length}건 — 배포 환경에서는 정상 로드된다.`);
  for (const f of externalFailures.slice(0, 4)) console.log("   · " + f);
}

await browser.close();

console.log("\n=== PASS ===");
for (const o of ok) console.log("  ✓ " + o);
if (failures.length) {
  console.log("\n=== FAIL ===");
  for (const f of failures) console.log("  ✗ " + f);
}
console.log(`\n스크린샷: ${outDir}`);
process.exitCode = failures.length ? 1 : 0;
