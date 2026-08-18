/**
 * 데일리 브리프 — 외부 발행 파이프라인(유튜브 자동발행 등)용 공개 API.
 *
 *   /api/daily-brief?market=KR|US|both   장 마감 요약 JSON (대본 재료)
 *   /api/brief-card.svg?market=KR|US     온톨로지 경로 카드 1280×720 (썸네일·본문 이미지)
 *
 * 원칙
 *  - 공개 데이터만 담는다(결론·리그·백테스트). 계좌·주문·실계좌 손익은 절대 넣지 않는다.
 *  - 필드 계약을 지킨다 — 외부 파이프라인이 구독하므로 이름을 바꾸면 안 깨질 수 없다.
 *    필드 추가는 자유, 삭제·개명은 금지.
 *  - 이미지는 서버가 SVG 로 직접 그린다. 3D 화면 스크린샷은 서버에서 재현이 불안정하고,
 *    같은 데이터로 그린 2D 인과 다이어그램이 더 읽기 쉽다.
 */
import type { Env } from "./env";
import { getVerdict, type OntoVerdict } from "./verdict";
import { labOverview } from "./quant";
import { backtestResults } from "./backtest";

type BriefMarket = "KR" | "US";

const MACRO_KO: Record<string, string> = {
  OIL: "유가", USDKRW: "원/달러", US10Y: "미 10년 금리", SEMI: "반도체 업황",
  KOSPI: "코스피", CHINA: "중국 증시", VIX: "변동성", GOLD: "금",
  DXY: "달러인덱스", COPPER: "구리", NASDAQ: "나스닥", BTC: "비트코인",
};

const DISCLAIMER =
  "본 내용은 운영자 개인 계좌 운용 기록의 공개이며 투자 자문·권유가 아닙니다. 시뮬레이션·백테스트는 과거 데이터 기반으로 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 이용자 본인에게 있습니다.";

function kstDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/* ── JSON 브리프 ─────────────────────────────────────── */

async function marketBrief(env: Env, market: BriefMarket) {
  const [verdict, lab] = await Promise.all([
    getVerdict(env, market),
    labOverview(env, market).catch(() => null),
  ]);
  const cur = market === "US" ? "$" : "원";
  const pick = (s: OntoVerdict["stocks"]["recommend"][number]) => ({
    code: s.code,
    name: s.name,
    sector: s.sector,
    score: s.score,
    price: s.price,
    priceLabel: `${s.price.toLocaleString("ko-KR")}${cur}`,
    changePct: s.changePct,
    reason: s.reason,
  });
  return {
    market,
    marketKo: market === "US" ? "미국" : "한국",
    regime: verdict.regime,
    causal: verdict.causal,
    sectors: {
      recommend: verdict.sectors.recommend.map((s) => ({ sector: s.sector, score: s.score, reasons: s.reasons })),
      avoid: verdict.sectors.avoid.map((s) => ({ sector: s.sector, score: s.score, reasons: s.reasons })),
    },
    picks: verdict.stocks.recommend.slice(0, 5).map(pick),
    avoid: verdict.stocks.avoid.slice(0, 3).map(pick),
    league: lab
      ? {
          currency: lab.currency,
          strategies: lab.strategies.map((st) => ({
            nameKo: st.nameKo,
            tagKo: st.tagKo,
            live: st.liveNow,
            pnlPct: st.pnlPct,
            equity: st.equity,
          })),
        }
      : null,
    dataAsOf: verdict.dataAsOf,
    generatedAt: verdict.generatedAt,
  };
}

/**
 * 데일리 브리프 — 필드 계약은 docs 로 외부에 공유된다. 삭제·개명 금지.
 */
export async function dailyBrief(env: Env, market: "KR" | "US" | "both") {
  const markets: BriefMarket[] = market === "both" ? ["KR", "US"] : [market];
  const briefs = await Promise.all(markets.map((m) => marketBrief(env, m)));
  const bt = backtestResults() as { measuredAt?: string } | null;
  const kr = briefs.find((b) => b.market === "KR");
  const first = briefs[0];
  const titleBase = kr ?? first;
  return {
    version: 1,
    date: kstDate(),
    site: "https://stockontology.cc",
    /** 영상 제목·태그 제안 — 파이프라인이 그대로 쓰거나 가공한다 */
    video: {
      titleSuggestion: `${kstDate()} 온톨로지 데일리 — ${titleBase.regime.label}${titleBase.picks[0] ? ` · ${titleBase.picks[0].name} 외 ${Math.max(0, titleBase.picks.length - 1)}종목` : ""}`,
      hashtags: ["#온톨로지", "#주식자동매매", "#AI투자", "#매크로", ...(titleBase.picks.slice(0, 3).map((p) => `#${p.name.replace(/\s+/g, "")}`))],
    },
    images: markets.map((m) => ({
      market: m,
      /** 1280×720 온톨로지 경로 카드 — <img> 로 쓰거나 브라우저로 렌더 후 캡처 */
      cardSvg: `https://stockontology.cc/api/brief-card.svg?market=${m}`,
    })),
    briefs,
    backtestMeasuredAt: bt?.measuredAt ?? null,
    disclaimer: DISCLAIMER,
  };
}

/* ── 온톨로지 경로 카드 (1280×720 SVG) ─────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtSigned = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

/**
 * 거시 → 섹터 → 종목 인과 경로를 2D 로 그린 발행용 카드.
 * 사이트 3D 무대와 같은 데이터(getVerdict)라 내용이 어긋나지 않는다.
 */
export async function briefCardSvg(env: Env, market: BriefMarket): Promise<string> {
  const v = await getVerdict(env, market);
  const W = 1280, H = 720;
  const GOLD = "#d9a441", UP = "#e0524a", DOWN = "#3b82f6", FG = "#e2e8f0", DIM = "#94a3b8";
  const toneColor = v.regime.tone === "risk-on" ? UP : v.regime.tone === "risk-off" ? DOWN : GOLD;
  const font = `font-family="'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif"`;

  // 왼쪽 다이어그램: 추천 섹터 상위 2개와 그 거시 기여, 각 섹터의 추천 종목
  const sectors = v.sectors.recommend.slice(0, 2);
  const stocksBySector = (sec: string) => v.stocks.recommend.filter((s) => s.sector === sec).slice(0, 2);
  const macroIds = [...new Set(sectors.flatMap((s) => s.edges.slice(0, 3).map((e) => e.macroId)))].slice(0, 4);

  const colX = { macro: 60, sector: 380, ticker: 700 } as const;
  const nodeW = 250, nodeH = 54;
  const diaTop = 190, diaH = 430;
  const yFor = (i: number, n: number) => diaTop + diaH / 2 - (n * (nodeH + 26)) / 2 + i * (nodeH + 26) + nodeH / 2;

  const macroY = new Map(macroIds.map((id, i) => [id, yFor(i, macroIds.length)]));
  const sectorY = new Map(sectors.map((s, i) => [s.sector, yFor(i, sectors.length)]));
  const tickers = sectors.flatMap((s) => stocksBySector(s.sector).map((t) => ({ t, sector: s.sector })));
  const tickerY = new Map(tickers.map((x, i) => [x.t.code, yFor(i, Math.max(1, tickers.length))]));

  let edges = "";
  for (const s of sectors) {
    const sy = sectorY.get(s.sector)!;
    for (const e of s.edges.slice(0, 3)) {
      const my = macroY.get(e.macroId);
      if (my === undefined) continue;
      const cls = e.contribution >= 0 ? UP : DOWN;
      const w = 1.5 + Math.min(6, Math.abs(e.contribution) * 9);
      const x1 = colX.macro + nodeW, x2 = colX.sector;
      edges += `<path d="M${x1},${my} C${x1 + 60},${my} ${x2 - 60},${sy} ${x2},${sy}" fill="none" stroke="${cls}" stroke-width="${w.toFixed(1)}" opacity="0.75"/>`;
      edges += `<text x="${(x1 + x2) / 2}" y="${(my + sy) / 2 - 8}" text-anchor="middle" fill="${cls}" font-size="15" font-weight="700" ${font}>${fmtSigned(e.contribution)}</text>`;
    }
    for (const { t } of stocksBySector(s.sector).map((t) => ({ t }))) {
      const ty = tickerY.get(t.code)!;
      const x1 = colX.sector + nodeW, x2 = colX.ticker;
      edges += `<path d="M${x1},${sy} C${x1 + 50},${sy} ${x2 - 50},${ty} ${x2},${ty}" fill="none" stroke="${GOLD}" stroke-width="2.5" opacity="0.7"/>`;
    }
  }

  const node = (x: number, y: number, line1: string, line2: string, accent: string) =>
    `<g><rect x="${x}" y="${y - nodeH / 2}" width="${nodeW}" height="${nodeH}" rx="10" fill="rgba(15,23,42,0.9)" stroke="${accent}" stroke-width="1.5"/>` +
    `<text x="${x + 14}" y="${y - 6}" fill="${FG}" font-size="19" font-weight="800" ${font}>${esc(line1)}</text>` +
    `<text x="${x + 14}" y="${y + 17}" fill="${DIM}" font-size="14" ${font}>${esc(line2)}</text></g>`;

  let nodes = "";
  for (const [id, y] of macroY) nodes += node(colX.macro, y, MACRO_KO[id] ?? id, "거시요인", DIM);
  for (const s of sectors) nodes += node(colX.sector, sectorY.get(s.sector)!, s.sector, `섹터 점수 ${fmtSigned(s.score)}`, GOLD);
  for (const { t } of tickers) {
    nodes += node(colX.ticker, tickerY.get(t.code)!, t.name, `점수 ${fmtSigned(t.score)} · ${fmtSigned(t.changePct, 1)}%`, t.score >= 0 ? UP : DOWN);
  }

  // 오른쪽: 추천 TOP5 / 회피
  const listX = 990;
  const rows = v.stocks.recommend.slice(0, 5);
  const avoid = v.stocks.avoid.slice(0, 2);
  let list = `<text x="${listX}" y="${diaTop + 6}" fill="${GOLD}" font-size="18" font-weight="900" ${font}>오늘의 온톨로지 추천</text>`;
  rows.forEach((s, i) => {
    const y = diaTop + 46 + i * 58;
    list += `<text x="${listX}" y="${y}" fill="${FG}" font-size="21" font-weight="800" ${font}>${i + 1}. ${esc(s.name)}</text>`;
    list += `<text x="${listX}" y="${y + 22}" fill="${DIM}" font-size="14" ${font}>${esc(s.sector ?? "")} · 점수 ${fmtSigned(s.score)} · ${fmtSigned(s.changePct, 1)}%</text>`;
  });
  if (avoid.length) {
    const y0 = diaTop + 46 + rows.length * 58 + 14;
    list += `<text x="${listX}" y="${y0}" fill="${DOWN}" font-size="16" font-weight="900" ${font}>피할 곳</text>`;
    avoid.forEach((s, i) => {
      list += `<text x="${listX}" y="${y0 + 26 + i * 24}" fill="${DIM}" font-size="15" ${font}>${esc(s.name)} (${fmtSigned(s.score)})</text>`;
    });
  }

  const dateStr = kstDate();
  const mkLabel = market === "US" ? "미국 시장" : "한국 시장";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="90%">
      <stop offset="0%" stop-color="#0b1530"/><stop offset="100%" stop-color="#040814"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="60" y="72" fill="${GOLD}" font-size="22" font-weight="900" letter-spacing="4" ${font}>STOCKONTOLOGY · 온톨로지 데일리</text>
  <text x="60" y="126" fill="${FG}" font-size="42" font-weight="900" ${font}>${dateStr} ${mkLabel} — <tspan fill="${toneColor}">${esc(v.regime.label)}</tspan></text>
  <text x="60" y="158" fill="${DIM}" font-size="17" ${font}>${esc((v.causal[0] ?? v.regime.lines[0] ?? "").slice(0, 78))}</text>
  <text x="${colX.macro}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${font}>거시요인</text>
  <text x="${colX.sector}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${font}>섹터</text>
  <text x="${colX.ticker}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${font}>종목</text>
  ${edges}${nodes}${list}
  <text x="60" y="${H - 36}" fill="${DIM}" font-size="13" ${font}>${esc(DISCLAIMER.slice(0, 90))}…</text>
  <text x="${W - 60}" y="${H - 36}" text-anchor="end" fill="${GOLD}" font-size="15" font-weight="700" ${font}>stockontology.cc</text>
</svg>`;
}
