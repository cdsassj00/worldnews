import { chromium } from "playwright";
import { existsSync } from "node:fs";
const exec = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exec, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.addInitScript(() => { try { localStorage.setItem("wfg-tour-done", "1"); localStorage.setItem("wfg-theme", "light"); } catch {} });
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__wfg?.ontoReady === true, { timeout: 90000 });
await page.waitForTimeout(3000);
const out = "/tmp/claude-0/-home-user-worldnews/ea5702fb-828c-5a5e-9e3a-7b12a44d68a5/scratchpad";
await page.locator("#terminal").scrollIntoViewIfNeeded();
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/onto-light2.png` });
// 양쪽 접기
await page.click("#btn-rail-toggle");
await page.click("#btn-panel-toggle");
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/onto-wide.png` });
await browser.close();
