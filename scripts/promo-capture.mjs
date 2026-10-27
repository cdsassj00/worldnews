/* SNS 홍보 영상 캡처 — 로컬(데이터 시드 완료 상태)에서 사이트 투어를 녹화한다 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
const exec = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => existsSync(p));
const OUT = "/tmp/claude-0/-home-user-worldnews/ea5702fb-828c-5a5e-9e3a-7b12a44d68a5/scratchpad/promo";
const browser = await chromium.launch({ executablePath: exec, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem("wfg-tour-done", "1"); } catch {} });
const hold = (ms) => page.waitForTimeout(ms);

await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".lab-bt-chip", { timeout: 60000 });
await hold(4500); // 히어로 + 데이터 로딩
await page.screenshot({ path: `${OUT}/shot-hero.png` });

// 전략실
await page.locator("#lab-strip").scrollIntoViewIfNeeded();
await hold(2500);
await page.locator(".lab-card").first().click();
await hold(3000);
await page.screenshot({ path: `${OUT}/shot-lab.png` });

// 온톨로지 3D
await page.locator("#terminal").scrollIntoViewIfNeeded();
await hold(4500);

// 차트분석
await page.locator('#terminal-tabs .tt-tab[data-pane="ta"]').click();
await hold(600);
await page.locator("#ta-search").click();
await page.locator("#ta-search").pressSequentially("삼성전자", { delay: 130 });
await page.waitForSelector("#ta-results button", { timeout: 30000 });
await hold(500);
await page.locator("#ta-results button").first().click();
await page.waitForSelector(".ta-plan-head", { timeout: 40000 });
await hold(3500);
await page.locator("#pane-ta .radar-tab").nth(1).click();
await page.waitForSelector(".ta-chart", { timeout: 40000 });
await hold(3500);
await page.screenshot({ path: `${OUT}/shot-chart.png` });

// 수급분석
await page.locator('#terminal-tabs .tt-tab[data-pane="flow"]').click();
await hold(3500);

// 조합 전략
await page.locator('#terminal-tabs .tt-tab[data-pane="combo"]').click();
await hold(2500);
const slider = page.locator("#combo-sliders input").first();
if (await slider.count()) { await slider.focus(); for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowRight"); await hold(120); } }
await hold(2500);
await page.screenshot({ path: `${OUT}/shot-combo.png` });

// 마무리 — 히어로로
await page.locator("#hero").scrollIntoViewIfNeeded();
await hold(2500);

const video = page.video();
await ctx.close();
const path = await video.path();
console.log("VIDEO:", path);
await browser.close();
