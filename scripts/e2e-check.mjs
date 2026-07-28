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

// 원격 URL 검증 시에는 컨테이너 프록시를 통해야 한다(E2E_PROXY 또는 HTTPS_PROXY).
const proxyServer = process.env.E2E_PROXY ?? (base.startsWith("http://127.0.0.1") ? undefined : process.env.HTTPS_PROXY);

const browser = await chromium.launch({
  executablePath,
  proxy: proxyServer ? { server: proxyServer } : undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: Boolean(proxyServer),
});

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

// 메인 화면 = 3D 온톨로지 그래프
await page.waitForFunction(() => window.__wfg?.ontoReady === true, { timeout: 120000 });
await page.waitForTimeout(900);
const ontoStats = await page.evaluate(() => window.__wfg.onto.stats());
check(
  "3D 온톨로지 렌더",
  ontoStats.frames > 3 && ontoStats.nodes >= 20 && ontoStats.edges >= 20,
  `frames ${ontoStats.frames} · 노드 ${ontoStats.nodes} · 간선 ${ontoStats.edges} · calls ${ontoStats.calls}`,
);
check("좌측 거시 신호", (await page.locator("#macro-list .macro-row").count()) >= 6);
check("좌측 종목 점수", (await page.locator("#score-list button").count()) >= 5);

// 종목 노드를 고르면 오른쪽에 점수 구성이 뜬다
await page.locator("#score-list button").first().click();
await page.waitForSelector(".tscore", { timeout: 15000 });
check(
  "종목 상세(점수 구성)",
  (await page.locator(".tscore-row").count()) === 3,
  `막대 ${await page.locator(".tscore-row").count()}개`,
);
await page.screenshot({ path: `${outDir}/12-onto3d.png` });

// 종목 검색 → 상세 (레이더 DB가 있을 때만)
const radarSt = await page.evaluate(async () => (await fetch("/api/radar/status")).json());
if (radarSt.available && radarSt.scored > 0) {
  await page.fill("#ticker-search", "삼성");
  await page.waitForSelector("#ticker-results button", { timeout: 20000 });
  const cnt = await page.locator("#ticker-results button").count();
  await page.locator("#ticker-results button").first().click();
  await page.waitForSelector(".verdict", { timeout: 10000 });
  check("종목 검색 → 온톨로지 분석", cnt >= 1, `결과 ${cnt}건 · ${await page.locator(".panel-head h2").first().textContent()}`);
} else {
  console.log("[참고] 종목 검색 검사 건너뜀 (레이더 미적재)");
}

// 기회 탐색 탭 — 수혜 경로/상대 강세/약세 경고 전환
check("기회 탐색 탭 3개", (await page.locator("#radar-tabs .radar-tab").count()) === 3);
await page.click('#radar-tabs .radar-tab[data-tab="weak"]');
await page.waitForTimeout(300);
check(
  "약세 경고 탭 전환",
  ((await page.locator("#radar-tab-note").textContent()) ?? "").includes("매도"),
  `${await page.locator("#radar-list li").count()}행`,
);
await page.click('#radar-tabs .radar-tab[data-tab="tailwind"]');

// 온톨로지 설명 모달
await page.click("#btn-onto-help");
await page.waitForSelector("#onto-help-modal .oh-table", { timeout: 5000 });
check("온톨로지 설명 모달", (await page.locator("#onto-help-modal .oh-table tr").count()) >= 4);
await page.click("#onto-help-close");

// 지구본은 아이콘 → 클릭하면 세계 경제 지표 모달
await page.click("#btn-world");
await page.waitForSelector("#world-grid .world-cell", { timeout: 90000 });
check("세계 경제 지표", (await page.locator("#world-grid .world-cell").count()) >= 6, `${await page.locator("#world-grid .world-cell").count()}개 지표`);
check("모달 글로벌 헤드라인", (await page.locator("#world-news a").count()) >= 3);

// 지구본 초기화 대기(모달 안)
await page.waitForFunction(() => window.__wfg?.ready === true, { timeout: 120000 });
check("지구본 초기화", true);

// WebGL 렌더 확인: 실제 드로우콜/삼각형이 나가는지 (readPixels 는 더블버퍼 때문에 신뢰 못 함)
await page.waitForTimeout(800);
const stats = await page.evaluate(() => window.__wfg.globe.renderStats());
check("WebGL 렌더 동작", stats.frames > 3 && stats.triangles > 1000, `frames ${stats.frames} · calls ${stats.calls} · tri ${stats.triangles}`);
await page.screenshot({ path: `${outDir}/13-world.png` });

// 국가 클릭 정확도: 여러 나라를 정면으로 돌린 뒤 캔버스 중앙 클릭 → 같은 나라가 잡혀야 한다
// (나라를 고르면 모달이 닫히는 게 정상 동작이라 매 회 다시 연다)
const openWorld = async () => {
  if (await page.locator("#world-modal").evaluate((n) => n.hidden)) {
    await page.click("#btn-world");
    await page.waitForTimeout(250);
  }
};
await openWorld();
const canvas = await page.locator("#globe").boundingBox();
const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

for (const cc of ["KR", "US", "BR", "DE", "AU", "IN", "ZA", "RU", "CA", "JP", "AR", "CN", "GB", "MX"]) {
  await openWorld();
  await page.evaluate((code) => window.__wfg.globe.selectByIso2(code), cc);
  await page.waitForFunction(() => window.__wfg.globe.isFlying() === false, { timeout: 15000 });
  await page.waitForTimeout(120);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(350);
  const picked = await page.evaluate(() => window.__wfg.lastPick);
  check(`중앙 클릭 픽 정확도 ${cc}`, picked?.iso2 === cc, `잡힌 국가 ${picked?.iso2 ?? "없음"} (${picked?.ko ?? "-"})`);
}

// 한국 패널 확인
await openWorld();
await page.evaluate(() => window.__wfg.globe.selectByIso2("KR"));
await page.waitForTimeout(300);
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
const kisState0 = await page.evaluate(async () => (await fetch("/api/kis/status")).json());
await page.getByRole("tab", { name: "주문" }).click();
await page.waitForTimeout(600);
const orderFormVisible = await page.locator('form[data-role="order-form"]').count();
const warnVisible = await page.locator(".order-warn").count();
check(
  "주문 탭 렌더",
  kisState0.configured ? orderFormVisible === 1 : orderFormVisible + warnVisible > 0,
  `form ${orderFormVisible} / 경고 ${warnVisible} / configured ${kisState0.configured}`,
);
await page.screenshot({ path: `${outDir}/03-order.png` });

// 해외주식 차단 상태에서 미국 주문 탭이 이유를 보여주는지
const kisState = kisState0;
if (kisState.configured && !kisState.overseasEnabled) {
  await openWorld();
  await page.evaluate(() => window.__wfg.globe.selectByIso2("US"));
  await page.waitForFunction(() => document.querySelector(".panel-head h2")?.textContent?.includes("미국"), { timeout: 20000 });
  await page.getByRole("tab", { name: "주문" }).click();
  await page.waitForSelector(".order-warn", { timeout: 20000 });
  const warnText = (await page.locator(".order-warn").allTextContents()).join(" ");
  const formCount = await page.locator('form[data-role="order-form"]').count();
  check(
    "해외 주문 차단 안내",
    /해외주식 주문이 막혀 있습니다/.test(warnText) && formCount === 0,
    `form ${formCount} · ${warnText.slice(0, 60)}`,
  );
  await page.screenshot({ path: `${outDir}/05-overseas-blocked.png` });
  await openWorld();
  await page.evaluate(() => window.__wfg.globe.selectByIso2("KR"));
  await page.waitForFunction(() => document.querySelector(".panel-head h2")?.textContent?.includes("대한민국"), { timeout: 20000 });
} else {
  console.log(`[참고] 해외 주문 차단 검사 건너뜀 (configured=${kisState.configured}, overseasEnabled=${kisState.overseasEnabled})`);
}

// 검증 모드(ORDER_DRY_RUN)일 때 주문 탭이 그 사실을 알려주는지
if (kisState.configured && kisState.dryRun) {
  await page.getByRole("tab", { name: "주문" }).click();
  await page.waitForSelector(".order-warn", { timeout: 20000 });
  const dryText = (await page.locator(".order-warn").allTextContents()).join(" ");
  check("검증 모드 안내", /검증 모드/.test(dryText), dryText.slice(0, 60));
  await page.screenshot({ path: `${outDir}/06-dryrun.png` });
}

// AI 분석 탭 (제공자가 설정돼 있을 때만)
const cfg = await page.evaluate(async () => (await fetch("/api/config")).json());
if (cfg.ai?.enabled) {
  await openWorld();
  await page.evaluate(() => window.__wfg.globe.selectByIso2("KR"));
  await page.waitForFunction(() => document.querySelector(".panel-head h2")?.textContent?.includes("대한민국"), { timeout: 20000 });
  await page.getByRole("tab", { name: "AI 분석" }).click();
  await page.waitForSelector(".ai-block", { timeout: 120000 });
  const blocks = await page.locator(".ai-block").count();
  const bullets = await page.locator(".ai-list li").count();
  check("AI 분석 렌더", blocks >= 1 && bullets >= 2, `블록 ${blocks} · 항목 ${bullets} · ${cfg.ai.provider}`);
  await page.screenshot({ path: `${outDir}/07-ai.png` });
} else {
  console.log(`[참고] AI 분석 검사 건너뜀 — ${cfg.ai?.reason ?? "상태 불명"}`);
}

// 자동매매 대시보드
await page.click("#btn-auto");
await page.waitForSelector("#auto-body .auto-block", { timeout: 120000 });
const autoBlocks = await page.locator("#auto-body .auto-block").count();
const gateItems = await page.locator("#auto-body .gate-list li").count();
const macroChips = await page.locator("#auto-body .macro-chip").count();
const scoreRows = await page.locator("#auto-body .score-row").count();
check(
  "자동매매 대시보드 렌더",
  autoBlocks >= 6 && gateItems >= 1 && macroChips >= 4 && scoreRows >= 3,
  `블록 ${autoBlocks} · 게이트 ${gateItems} · 거시 ${macroChips} · 점수 ${scoreRows}`,
);
// 온톨로지 경로도 — 종목을 바꾸면 그림이 다시 그려져야 한다
const ontoChips = await page.locator("#auto-body .onto-chip").count();
const ontoNodes = await page.locator("#auto-body .onto-svg .onto-node").count();
const ontoMath = (await page.locator("#auto-body .onto-math").first().textContent()) ?? "";
check(
  "온톨로지 경로도",
  ontoChips >= 3 && ontoNodes >= 3 && /×0\.35/.test(ontoMath),
  `칩 ${ontoChips} · 노드 ${ontoNodes} · ${ontoMath.replace(/\s+/g, " ").slice(0, 48)}`,
);
if (ontoChips > 1) {
  const before = await page.locator("#auto-body .onto-node .n1").last().textContent();
  await page.locator("#auto-body .onto-chip").nth(1).click();
  await page.waitForTimeout(300);
  const after = await page.locator("#auto-body .onto-node .n1").last().textContent();
  check("온톨로지 종목 전환", before !== after, `${before} → ${after}`);
}
check("백테스트 결과 고지", (await page.locator("#auto-body .bt-block .bt-row").count()) >= 3);

const autoBadge = (await page.locator("#auto-badge").textContent()) ?? "";
check("자동매매 상태 배지", autoBadge.trim().length > 0 && !/확인중/.test(autoBadge), autoBadge.trim());
await page.screenshot({ path: `${outDir}/08-autotrade.png` });
await page.click("#auto-close");

// 티커테이프 & 좌측 요약
check("티커테이프", (await page.locator(".tape-item").count()) > 5);
check("지금 움직이는 시장", (await page.locator("#hot-list button").count()) >= 3);

// 검색 (세계 경제 모달 안)
await page.click("#btn-world");
await page.waitForTimeout(400);
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
