/**
 * 장면(Scene) API — 영상 파이프라인용 서버 렌더 화면 (2026-08-20 v3 요청서 방안 A).
 *
 *   GET /api/scene.svg?market=KR|US&view=overview            전체 그래프 (거시→섹터→종목 3층)
 *   GET /api/scene.svg?market=KR&view=sector:정유화학          추천 섹터 하나 강조
 *   GET /api/scene.svg?market=KR&view=stock:010950            종목 상세 (합성 점수 분해 + 경로)
 *   GET /api/scene.svg?market=KR&view=league                  전략실 리그 4엔진 성적
 *   GET /api/scene.svg?view=backtest                          백테스트 성적표 (양 시장)
 *   공통: &animate=1 → 간선에 3초 흐름 루프(SMIL — 크롬/파폭 재생, 화면 녹화용)
 *
 * 1920×1080 고정 · 배치 결정론(정렬된 데이터에서 계산) · 준비 대기 불필요(완성본만 응답)
 * · UI 크롬 없음. 브라우저 없이 resvg/sharp 로 래스터화 가능(웹폰트만 온라인 필요).
 * 공개 데이터만 담는다 — 계좌·주문·매매 일지는 어떤 뷰에도 넣지 않는다.
 */
import type { Env } from "./env";
import { getVerdict } from "./verdict";
import { labOverview } from "./quant";
import { radarFind } from "./radarscan";
import { backtestResults } from "./backtest";
import { getManySeries } from "./quotes";
import { computeLevels } from "./levels";
import { buildEnginesAndAgreement } from "./agreement";
import { smaSeries } from "../shared/ta";
import { ApiError, round } from "./util";
import krSeed from "../shared/radar-universe.json";
import usSeed from "../shared/us-universe.json";

const CODE_TO_SYMBOL = new Map<string, string>([
  ...(krSeed as { code: string; symbol: string }[]).map((t): [string, string] => [t.code, t.symbol]),
  ...(usSeed as { code: string; symbol: string }[]).map((t): [string, string] => [t.code, t.symbol]),
]);
/** 야후 meta.shortName 은 한국 종목도 영문("SamsungElec")으로 온다 — 화면엔 우리 시드의 한글명을 쓴다 */
const CODE_TO_NAME = new Map<string, string>([
  ...(krSeed as { code: string; name: string }[]).map((t): [string, string] => [t.code, t.name]),
  ...(usSeed as { code: string; name: string }[]).map((t): [string, string] => [t.code, t.name]),
]);

const W = 1920, H = 1080;
const GOLD = "#d9a441", UP = "#e0524a", DOWN = "#3b82f6", FG = "#e2e8f0", DIM = "#94a3b8", PANEL = "rgba(15,23,42,0.92)";
const FONT = `font-family="'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif"`;
const FONT_IMPORT = `<style>@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');</style>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sgn = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const dirColor = (v: number) => (v >= 0 ? UP : DOWN);

const MACRO_KO: Record<string, string> = {
  OIL: "유가", USDKRW: "원/달러", US10Y: "미 10년 금리", SEMI: "반도체 업황",
  KOSPI: "코스피", CHINA: "중국 증시", VIX: "변동성", GOLD: "금",
  DXY: "달러인덱스", COPPER: "구리", NASDAQ: "나스닥", BTC: "비트코인", US2Y: "미 단기금리", JPY: "엔/달러",
};

const DISCLAIMER = "운영자 개인 기록의 공개이며 투자 자문·권유가 아닙니다 · 투자 판단과 책임은 이용자 본인에게 있습니다";

function kstDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shell(body: string, animate: boolean): string {
  const anim = animate
    ? `<style>.flow{stroke-dasharray:14 10;animation:dash 3s linear infinite}@keyframes dash{to{stroke-dashoffset:-96}}</style>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${FONT_IMPORT}${anim}
<defs><radialGradient id="bg" cx="50%" cy="28%" r="95%"><stop offset="0%" stop-color="#0b1530"/><stop offset="100%" stop-color="#040814"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${body}
<text x="80" y="${H - 40}" fill="${DIM}" font-size="19" ${FONT}>${esc(DISCLAIMER)}</text>
<text x="${W - 80}" y="${H - 40}" text-anchor="end" fill="${GOLD}" font-size="22" font-weight="700" ${FONT}>stockontology.cc</text>
</svg>`;
}

function header(title: string, sub: string, accent = GOLD): string {
  return `<text x="80" y="96" fill="${GOLD}" font-size="28" font-weight="900" letter-spacing="5" ${FONT}>STOCKONTOLOGY</text>
<text x="80" y="168" fill="${FG}" font-size="54" font-weight="900" ${FONT}>${title}</text>
<text x="80" y="212" fill="${accent === GOLD ? DIM : accent}" font-size="26" ${FONT}>${esc(sub)}</text>`;
}

function node(x: number, y: number, w: number, h: number, l1: string, l2: string, accent: string, big = false): string {
  return `<g><rect x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="14" fill="${PANEL}" stroke="${accent}" stroke-width="2"/>
<text x="${x + 20}" y="${y - (big ? 8 : 6)}" fill="${FG}" font-size="${big ? 30 : 25}" font-weight="800" ${FONT}>${esc(l1)}</text>
<text x="${x + 20}" y="${y + (big ? 26 : 22)}" fill="${DIM}" font-size="${big ? 21 : 18}" ${FONT}>${esc(l2)}</text></g>`;
}

function edge(x1: number, y1: number, x2: number, y2: number, color: string, width: number, label?: string): string {
  let s = `<path class="flow" d="M${x1},${y1} C${x1 + 90},${y1} ${x2 - 90},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${width.toFixed(1)}" opacity="0.75"/>`;
  if (label) s += `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 10}" text-anchor="middle" fill="${color}" font-size="20" font-weight="700" ${FONT}>${esc(label)}</text>`;
  return s;
}

/* ── overview: 거시 → 섹터 → 종목 3층 전체 ─────────────── */

async function sceneOverview(env: Env, market: "KR" | "US", animate: boolean): Promise<string> {
  const v = await getVerdict(env, market);
  const sectors = v.sectors.recommend.slice(0, 4);
  const macroIds = [...new Set(sectors.flatMap((s) => s.edges.slice(0, 3).map((e) => e.macroId)))].slice(0, 6);
  const stocks = v.stocks.recommend.slice(0, 6);

  const colX = { macro: 80, sector: 640, ticker: 1200 } as const;
  const nodeW = 400, nodeH = 84;
  const top = 280, height = 700;
  const yFor = (i: number, n: number) => top + height / 2 - (n * (nodeH + 34)) / 2 + i * (nodeH + 34) + nodeH / 2;
  const macroY = new Map(macroIds.map((id, i) => [id, yFor(i, macroIds.length)]));
  const sectorY = new Map(sectors.map((s, i) => [s.sector, yFor(i, sectors.length)]));
  const stockY = new Map(stocks.map((s, i) => [s.code, yFor(i, stocks.length)]));

  let edges = "";
  for (const s of sectors) {
    const sy = sectorY.get(s.sector)!;
    for (const e of s.edges.slice(0, 3)) {
      const my = macroY.get(e.macroId);
      if (my === undefined) continue;
      edges += edge(colX.macro + nodeW, my, colX.sector, sy, dirColor(e.contribution), 2 + Math.min(9, Math.abs(e.contribution) * 12), sgn(e.contribution));
    }
    for (const t of stocks.filter((x) => x.sector === s.sector)) {
      edges += edge(colX.sector + nodeW, sy, colX.ticker, stockY.get(t.code)!, GOLD, 3.5);
    }
  }

  let nodes = "";
  for (const [id, y] of macroY) nodes += node(colX.macro, y, nodeW, nodeH, MACRO_KO[id] ?? id, "거시요인", DIM);
  for (const s of sectors) nodes += node(colX.sector, sectorY.get(s.sector)!, nodeW, nodeH, s.sector, `섹터 점수 ${sgn(s.score)}`, GOLD);
  for (const t of stocks) nodes += node(colX.ticker, stockY.get(t.code)!, nodeW, nodeH, t.name, `점수 ${sgn(t.score)} · ${sgn(t.changePct, 1)}%`, dirColor(t.score));

  const cols = `<text x="${colX.macro}" y="${top - 16}" fill="${DIM}" font-size="22" letter-spacing="3" ${FONT}>거시요인</text>
<text x="${colX.sector}" y="${top - 16}" fill="${DIM}" font-size="22" letter-spacing="3" ${FONT}>섹터</text>
<text x="${colX.ticker}" y="${top - 16}" fill="${DIM}" font-size="22" letter-spacing="3" ${FONT}>종목</text>`;

  const mk = market === "US" ? "미국" : "한국";
  return shell(header(`${kstDate()} ${mk} 온톨로지 — ${esc(v.regime.label)}`, v.causal[0] ?? v.regime.lines[0] ?? "") + cols + edges + nodes, animate);
}

/* ── sector:이름 — 한 섹터 강조 ─────────────────────────── */

async function sceneSector(env: Env, market: "KR" | "US", name: string, animate: boolean): Promise<string> {
  const v = await getVerdict(env, market);
  /* 추천·회피 상위 4개 밖이라도(오늘 픽의 업종이면 특히) 그릴 수 있어야 한다
   * (2026-09-04 유튜브 파이프라인 요청 6번) — 전체 섹터 목록에서 찾는다. */
  const s = v.sectors.all.find((x) => x.sector === name);
  if (!s) throw new ApiError(404, "sector_not_found", { sector: name, available: v.sectors.all.map((x) => x.sector) });
  const stocks = v.stocks.recommend.filter((x) => x.sector === name).slice(0, 4);

  const nodeW = 430, nodeH = 92;
  const cy = 560;
  const macroX = 90, sectorX = 700, stockX = 1330;
  const edgesList = s.edges.slice(0, 4);
  const my = (i: number) => cy - ((edgesList.length - 1) * 130) / 2 + i * 130;
  const ty = (i: number) => cy - ((Math.max(1, stocks.length) - 1) * 120) / 2 + i * 120;

  let g = "";
  edgesList.forEach((e, i) => {
    g += edge(macroX + nodeW, my(i), sectorX, cy, dirColor(e.contribution), 3 + Math.min(10, Math.abs(e.contribution) * 13), sgn(e.contribution));
    g += node(macroX, my(i), nodeW, nodeH, MACRO_KO[e.macroId] ?? e.macroId, "거시요인", dirColor(e.contribution));
  });
  stocks.forEach((t, i) => {
    g += edge(sectorX + nodeW, cy, stockX, ty(i), GOLD, 4);
    g += node(stockX, ty(i), nodeW, nodeH, t.name, `점수 ${sgn(t.score)} · ${sgn(t.changePct, 1)}%`, dirColor(t.score));
  });
  g += node(sectorX, cy, nodeW, 120, s.sector, `섹터 점수 ${sgn(s.score)}`, GOLD, true);

  let reasons = "";
  s.reasons.slice(0, 3).forEach((r, i) => {
    reasons += `<text x="90" y="${900 + i * 40}" fill="${DIM}" font-size="24" ${FONT}>· ${esc(r)}</text>`;
  });

  const mk = market === "US" ? "미국" : "한국";
  return shell(header(`${mk} 섹터 결론 — ${esc(s.sector)}`, `${kstDate()} · 이 섹터로 들어오는 인과 경로`) + g + reasons, animate);
}

/* ── stock:코드 — 합성 점수 분해 + 온톨로지 경로 ─────────── */

async function sceneStock(env: Env, market: "KR" | "US", code: string, animate: boolean): Promise<string> {
  const found = (await radarFind(env, code)) as {
    items: {
      code: string; name: string; sector: string | null; market: string; price: number; changePct: number;
      score: number; onto: number; priceScore: number;
      edges: { macroId: string; sector: string; contribution: number }[];
      reasons: { kind: string; text: string; contribution: number }[];
    }[];
  };
  const t = found.items.find((x) => x.code === code) ?? found.items[0];
  if (!t) throw new ApiError(404, "stock_not_found", { code });

  // 합성 점수 = 온톨로지 0.35 + 가격 0.45 + 뉴스 0.20 — 뉴스 축은 잔차로 복원한다
  const wOnto = 0.35, wPrice = 0.45, wNews = 0.2;
  const newsScore = round((t.score - wOnto * t.onto - wPrice * t.priceScore) / wNews, 3);
  const cur = t.market === "US" ? "$" : "원";

  /* 왼쪽 — 점수 분해 바 */
  const barX = 90, barW = 640;
  const bars: [string, number, number][] = [["온톨로지", t.onto, wOnto], ["가격신호", t.priceScore, wPrice], ["뉴스감성", newsScore, wNews]];
  let left = `<text x="${barX}" y="330" fill="${GOLD}" font-size="28" font-weight="900" ${FONT}>합성 점수 분해</text>`;
  bars.forEach(([label, val, w], i) => {
    const y = 390 + i * 130;
    const contrib = val * w;
    const half = barW / 2;
    const len = Math.min(half, Math.abs(val) * half);
    left += `<text x="${barX}" y="${y - 14}" fill="${FG}" font-size="25" font-weight="700" ${FONT}>${label} <tspan fill="${DIM}" font-size="21">${val.toFixed(3)} × ${w} = </tspan><tspan fill="${dirColor(contrib)}" font-weight="800">${sgn(contrib, 3)}</tspan></text>`;
    left += `<rect x="${barX}" y="${y}" width="${barW}" height="26" rx="13" fill="rgba(148,163,184,0.15)"/>`;
    left += `<rect x="${val >= 0 ? barX + half : barX + half - len}" y="${y}" width="${Math.max(2, len)}" height="26" rx="13" fill="${dirColor(val)}"/>`;
    left += `<line x1="${barX + half}" y1="${y - 6}" x2="${barX + half}" y2="${y + 32}" stroke="${DIM}" stroke-width="1.5"/>`;
  });
  left += `<text x="${barX}" y="810" fill="${FG}" font-size="34" font-weight="900" ${FONT}>합성 ${sgn(t.score, 3)}</text>`;

  /* 오른쪽 — 온톨로지 경로 (거시 → 섹터 → 종목) */
  const macroX = 830, sectorX = 1310, nodeW = 330, nodeH = 78;
  const cy2 = 560;
  const es = t.edges.slice(0, 4);
  const my = (i: number) => cy2 - ((Math.max(1, es.length) - 1) * 116) / 2 + i * 116;
  let right = `<text x="${macroX}" y="330" fill="${GOLD}" font-size="28" font-weight="900" ${FONT}>왜 이 점수인가 — 온톨로지 경로</text>`;
  es.forEach((e, i) => {
    right += edge(macroX + nodeW, my(i), sectorX, cy2, dirColor(e.contribution), 2.5 + Math.min(8, Math.abs(e.contribution) * 12), sgn(e.contribution));
    right += node(macroX, my(i), nodeW, nodeH, MACRO_KO[e.macroId] ?? e.macroId, e.sector, dirColor(e.contribution));
  });
  right += node(sectorX, cy2, nodeW + 60, 108, t.name, `${t.sector ?? "미분류"} · 온톨로지 ${sgn(t.onto, 3)}`, GOLD, true);
  if (!es.length) right += `<text x="${macroX}" y="${cy2}" fill="${DIM}" font-size="24" ${FONT}>지금 유의미하게 작동한 거시 경로가 없습니다 — 점수는 가격·뉴스 축에서 나왔습니다.</text>`;

  let reasons = "";
  t.reasons.slice(0, 3).forEach((r, i) => {
    reasons += `<text x="90" y="${920 + i * 38}" fill="${DIM}" font-size="23" ${FONT}>· ${esc(r.text)}</text>`;
  });

  return shell(
    header(`${esc(t.name)} — 종합 ${sgn(t.score, 3)}`,
      `${kstDate()} · ${t.sector ?? "미분류"} · ${t.price.toLocaleString("ko-KR")}${cur} (${sgn(t.changePct, 1)}%)`,
      dirColor(t.score)) + left + right + reasons,
    animate,
  );
}

/* ── chart:코드 — 일봉 + 이동평균 + 지지·저항 + 거래량 (2026-09-04 요청 2번) ────── */

const MA20_COLOR = "#38bdf8", MA60_COLOR = "#a78bfa";

async function sceneChart(env: Env, market: "KR" | "US", code: string, animate: boolean): Promise<string> {
  const symbol = CODE_TO_SYMBOL.get(code);
  if (!symbol) throw new ApiError(404, "stock_not_found", { code });
  const [series] = await getManySeries(env, [symbol], "1y");
  if (!series) throw new ApiError(404, "chart_data_unavailable", { code });
  const cur = market === "US" ? "$" : "원";
  const tz = market === "US" ? "America/New_York" : "Asia/Seoul";
  const levels = computeLevels(series, series.price, tz);

  const N = Math.min(90, series.closes.length);
  const opens = series.opens.slice(-N), highs = series.highs.slice(-N), lows = series.lows.slice(-N);
  const closes = series.closes.slice(-N), volumes = series.volumes.slice(-N);
  // 이평선은 전체 이력으로 계산한 뒤(짧은 창에서 계산하면 왜곡된다) 표시 구간만 자른다
  const ma20Full = smaSeries(series.closes, 20).slice(-N);
  const ma60Full = smaSeries(series.closes, 60).slice(-N);

  const chartX0 = 110, chartX1 = 1680, chartTop = 300, chartBottom = 740;
  const volTop = 790, volBottom = 950;
  const priceMax = Math.max(...highs) * 1.02;
  const priceMin = Math.min(...lows) * 0.98;
  const yFor = (p: number) => chartBottom - ((p - priceMin) / (priceMax - priceMin)) * (chartBottom - chartTop);
  const barGap = (chartX1 - chartX0) / N;
  const bodyW = Math.max(2, Math.min(13, barGap * 0.62));
  const xFor = (i: number) => chartX0 + i * barGap + barGap / 2;
  const maxVol = Math.max(1, ...volumes);

  let candles = "";
  for (let i = 0; i < N; i++) {
    const x = xFor(i), up = closes[i] >= opens[i];
    const color = up ? UP : DOWN;
    candles += `<line x1="${x}" y1="${yFor(highs[i]).toFixed(1)}" x2="${x}" y2="${yFor(lows[i]).toFixed(1)}" stroke="${color}" stroke-width="1.5"/>`;
    const yO = yFor(opens[i]), yC = yFor(closes[i]);
    const top = Math.min(yO, yC), h = Math.max(1.5, Math.abs(yO - yC));
    candles += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`;
    const vh = (volumes[i] / maxVol) * (volBottom - volTop);
    candles += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${(volBottom - vh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${vh.toFixed(1)}" fill="${color}" opacity="0.55"/>`;
  }

  const maLine = (vals: number[], color: string) => {
    const pts = vals.map((v, i) => (Number.isNaN(v) ? null : `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`)).filter((p): p is string => p !== null);
    return pts.length > 1 ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.9"/>` : "";
  };
  const mas = maLine(ma20Full, MA20_COLOR) + maLine(ma60Full, MA60_COLOR);

  let srLines = "";
  const drawLevel = (p: { price: number; touches: number; lastTouchDate: string | null }, color: string) => {
    if (p.price < priceMin || p.price > priceMax) return;
    const y = yFor(p.price);
    srLines += `<line x1="${chartX0}" y1="${y.toFixed(1)}" x2="${chartX1}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="10 8" opacity="0.7"/>`;
    srLines += `<text x="${chartX1 + 14}" y="${(y + 6).toFixed(1)}" fill="${color}" font-size="19" font-weight="800" ${FONT}>${p.price.toLocaleString("ko-KR")} (${p.touches}회)</text>`;
  };
  for (const p of levels?.support ?? []) drawLevel(p, UP);
  for (const p of levels?.resistance ?? []) drawLevel(p, DOWN);

  const legend = `<text x="${chartX0}" y="${chartTop - 18}" fill="${MA20_COLOR}" font-size="19" font-weight="700" ${FONT}>— MA20</text>
<text x="${chartX0 + 110}" y="${chartTop - 18}" fill="${MA60_COLOR}" font-size="19" font-weight="700" ${FONT}>— MA60</text>
<text x="${chartX0 + 220}" y="${chartTop - 18}" fill="${UP}" font-size="19" font-weight="700" ${FONT}>┅ 지지</text>
<text x="${chartX0 + 320}" y="${chartTop - 18}" fill="${DOWN}" font-size="19" font-weight="700" ${FONT}>┅ 저항</text>`;

  const sub = `${kstDate()} · 일봉 ${N}개(약 ${Math.round(N / 21)}개월) · 현재가 ${series.price.toLocaleString("ko-KR")}${cur}` +
    (levels?.atr14 ? ` · ATR(14) ${levels.atr14.toLocaleString("ko-KR")}${cur}` : "");
  let note = "";
  if (levels?.levelNote) note = `<text x="${chartX0}" y="${volBottom + 60}" fill="${GOLD}" font-size="24" font-weight="800" ${FONT}>${esc(levels.levelNote)}</text>`;
  else note = `<text x="${chartX0}" y="${volBottom + 60}" fill="${DIM}" font-size="22" ${FONT}>두 번 이상 시험된 지지·저항 자리가 아직 확인되지 않았습니다 — 근거 없는 레벨은 표시하지 않습니다.</text>`;

  return shell(header(`${esc(CODE_TO_NAME.get(code) ?? series.name)} — 일봉 차트`, sub, dirColor(series.changePct)) + legend + mas + candles + srLines + note, animate);
}

/* ── consensus — 종목(세로) × 엔진(가로) 합의 격자 (2026-09-04 요청 3번 부속) ────── */

const ENGINE_ORDER = ["onto", "quant", "ta", "fusion"];

async function sceneConsensus(env: Env, market: "KR" | "US"): Promise<string> {
  const [v, lab] = await Promise.all([getVerdict(env, market), labOverview(env, market)]);
  const cur = market === "US" ? "$" : "원";
  const headlineCodes = new Set(v.stocks.recommend.slice(0, 5).map((s) => s.code));
  const { agreement } = buildEnginesAndAgreement(market, lab.strategies, headlineCodes, cur);
  const rows = agreement.slice(0, 7);
  const engineNames = new Map(lab.strategies.map((s) => [s.id, s.nameKo]));

  const nameColX = 90, nameColW = 460;
  const engColW = 300, gap = 16;
  const gridX0 = nameColX + nameColW + 30;
  const rowH = 96, headerY = 300, firstRowY = 360;

  let g = "";
  ENGINE_ORDER.forEach((id, c) => {
    const x = gridX0 + c * (engColW + gap);
    const isDerived = id === "fusion";
    g += `<text x="${x + engColW / 2}" y="${headerY}" text-anchor="middle" fill="${isDerived ? DIM : GOLD}" font-size="24" font-weight="900" ${FONT}>${esc(engineNames.get(id) ?? id)}${isDerived ? " (파생)" : ""}</text>`;
  });
  g += `<text x="${nameColX}" y="${headerY}" fill="${DIM}" font-size="22" letter-spacing="2" ${FONT}>동시 지목 종목</text>`;

  rows.forEach((r, i) => {
    const y = firstRowY + i * rowH;
    g += `<rect x="${nameColX - 20}" y="${y - 54}" width="${gridX0 - nameColX + ENGINE_ORDER.length * (engColW + gap) - 4}" height="${rowH - 14}" rx="12" fill="${i % 2 ? "rgba(15,23,42,0.5)" : "rgba(15,23,42,0.85)"}"/>`;
    g += `<text x="${nameColX}" y="${y - 8}" fill="${FG}" font-size="27" font-weight="800" ${FONT}>${esc(r.name)}</text>`;
    g += `<text x="${nameColX}" y="${y + 20}" fill="${DIM}" font-size="18" ${FONT}>${esc(r.sector ?? "미분류")} · 독립 ${r.independentCount}표</text>`;
    const hitById = new Map(r.engines.map((e) => [e.id, e]));
    ENGINE_ORDER.forEach((id, c) => {
      const x = gridX0 + c * (engColW + gap);
      const hit = hitById.get(id);
      const cx = x + engColW / 2, cy = y - 20;
      if (hit) {
        g += `<circle cx="${cx}" cy="${cy}" r="22" fill="${hit.derived ? "rgba(148,163,184,0.25)" : "rgba(217,164,65,0.25)"}" stroke="${hit.derived ? DIM : GOLD}" stroke-width="2"/>`;
        g += `<text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="${hit.derived ? DIM : GOLD}" font-size="26" font-weight="900" ${FONT}>✓</text>`;
      } else {
        g += `<circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="rgba(148,163,184,0.2)" stroke-width="1.5"/>`;
      }
    });
  });

  const sub = `${kstDate()} · 근거가 다른 방식이 같은 종목에서 만난 자리 — "파생" 열(융합)은 다른 두 표를 섞은 결과라 독립 표에서 뺀다`;
  return shell(header(`${market === "US" ? "미국" : "한국"} 엔진 합의 격자`, sub) + g, false);
}

/* ── league — 전략실 4엔진 성적 ─────────────────────────── */

async function sceneLeague(env: Env, market: "KR" | "US"): Promise<string> {
  const lab = await labOverview(env, market);
  const mk = market === "US" ? "미국" : "한국";
  const cardW = 420, cardH = 560, gap = 26, x0 = (W - cardW * 4 - gap * 3) / 2;
  let g = "";
  lab.strategies.forEach((st, i) => {
    const x = x0 + i * (cardW + gap), y = 300;
    const pc = st.pnlPct;
    g += `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="18" fill="${PANEL}" stroke="${st.liveNow ? GOLD : "rgba(148,163,184,0.3)"}" stroke-width="${st.liveNow ? 3 : 1.5}"/>`;
    g += `<text x="${x + 28}" y="${y + 64}" fill="${FG}" font-size="34" font-weight="900" ${FONT}>${st.no}호 ${esc(st.nameKo)}</text>`;
    g += `<text x="${x + 28}" y="${y + 100}" fill="${DIM}" font-size="21" ${FONT}>${esc(st.tagKo)}${st.liveNow ? " · 실계좌 운용 중" : " · 시뮬레이션"}</text>`;
    g += `<text x="${x + 28}" y="${y + 190}" fill="${dirColor(pc)}" font-size="58" font-weight="900" ${FONT}>${sgn(pc, 2)}%</text>`;
    g += `<text x="${x + 28}" y="${y + 232}" fill="${DIM}" font-size="20" ${FONT}>리그 수익률 · 승률 ${st.tradeStats.winRate}% (${st.tradeStats.total}회)</text>`;
    g += `<text x="${x + 28}" y="${y + 296}" fill="${GOLD}" font-size="21" font-weight="800" ${FONT}>지금 고른 종목</text>`;
    st.picks.slice(0, 4).forEach((p, j) => {
      g += `<text x="${x + 28}" y="${y + 336 + j * 40}" fill="${FG}" font-size="23" ${FONT}>${esc(p.name)} <tspan fill="${dirColor(p.score)}" font-size="20">${sgn(p.score)}</tspan></text>`;
    });
  });
  return shell(header(`${mk} 전략실 리그 — 4개 분석 방식의 실시간 경쟁`, `${kstDate()} · 같은 가상 원금·같은 규칙, 다른 것은 "무엇을 살까"뿐`) + g, false);
}

/* ── backtest — 성적표 ─────────────────────────────────── */

function sceneBacktest(): string {
  const bt = backtestResults() as {
    measuredAt?: string;
    engineComparison?: { engines: { id: string; nameKo: string; KR: { returns: number[] }; US: { returns: number[] } }[] };
  };
  const engines = bt.engineComparison?.engines ?? [];
  const cols = ["전략", "한국 3개월", "한국 6개월", "한국 1년", "미국 3개월", "미국 6개월", "미국 1년"];
  const x0 = 120, y0 = 320, rowH = 84, colWs = [320, 230, 230, 230, 230, 230, 230];
  const colX = (i: number) => x0 + colWs.slice(0, i).reduce((a, b) => a + b, 0);
  let g = "";
  cols.forEach((c, i) => { g += `<text x="${colX(i)}" y="${y0 - 24}" fill="${DIM}" font-size="23" font-weight="700" ${FONT}>${c}</text>`; });
  const bestKr = Math.max(...engines.map((e) => e.KR.returns[2] ?? -999));
  const bestUs = Math.max(...engines.map((e) => e.US.returns[2] ?? -999));
  engines.forEach((e, r) => {
    const y = y0 + r * rowH;
    g += `<rect x="${x0 - 24}" y="${y - 40}" width="${colWs.reduce((a, b) => a + b, 0) + 24}" height="${rowH - 12}" rx="12" fill="${r % 2 ? "rgba(15,23,42,0.5)" : "rgba(15,23,42,0.85)"}"/>`;
    g += `<text x="${colX(0)}" y="${y + 8}" fill="${FG}" font-size="27" font-weight="800" ${FONT}>${esc(e.nameKo)}</text>`;
    [...e.KR.returns, ...e.US.returns].forEach((v, c) => {
      const champ = (c === 2 && v === bestKr) || (c === 5 && v === bestUs);
      g += `<text x="${colX(c + 1)}" y="${y + 8}" fill="${dirColor(v)}" font-size="26" font-weight="${champ ? 900 : 600}" ${FONT}>${sgn(v, 1)}%${champ ? " 🏆" : ""}</text>`;
    });
  });
  g += `<text x="${x0}" y="${y0 + engines.length * rowH + 40}" fill="${DIM}" font-size="21" ${FONT}>과거 시세로 규칙을 되돌려 본 모의 실험 — 미래 수익을 보장하지 않습니다 · 슬리피지·수수료·세금 반영</text>`;
  return shell(header(`백테스트 성적표 — 7개 전략 × 두 시장`, `측정일 ${bt.measuredAt ?? "-"} · 매 거래일 16:40 KST 자동 재측정`) + g, false);
}

/* ── 엔트리 ───────────────────────────────────────────── */

export async function sceneSvg(env: Env, market: "KR" | "US", view: string, animate: boolean): Promise<string> {
  if (view === "overview") return sceneOverview(env, market, animate);
  if (view === "league") return sceneLeague(env, market);
  if (view === "backtest") return sceneBacktest();
  if (view.startsWith("sector:")) return sceneSector(env, market, view.slice(7), animate);
  if (view.startsWith("stock:")) return sceneStock(env, market, view.slice(6), animate);
  if (view.startsWith("chart:")) return sceneChart(env, market, view.slice(6), animate);
  if (view === "consensus") return sceneConsensus(env, market);
  throw new ApiError(400, "bad_view", { allowed: ["overview", "sector:<이름>", "stock:<코드>", "chart:<코드>", "league", "backtest", "consensus"] });
}
