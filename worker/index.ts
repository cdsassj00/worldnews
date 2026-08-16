import type { Env } from "./env";
import { GLOBAL_TAPE, MARKETS, REGION_FALLBACK, marketFor } from "../shared/markets";
import { ApiError, cached, errorResponse, json, jsonCached, num, round, invalidateCache } from "./util";
import { MACRO, MACRO_CLUSTERS, MACRO_LINKS, RELATIONS, SENSITIVITY, UNIVERSE } from "../shared/ontology";
import { WEIGHTS } from "../shared/scoring";
import { getManySeries, getSeries, toSnapshot } from "./quotes";
import { getGlobalNews, getNews } from "./news";
import { DISCLAIMER, recommend } from "./recommend";
import { aiStatus, getAnalysis } from "./analysis";
import { translateBatch } from "./translate";
import { langIndex } from "./langpages";
import {
  assertOverseasAllowed,
  assertTradeAuth,
  cancelDomesticOrder,
  domesticBalance,
  domesticPrice,
  kisConfig,
  kisStatus,
  overseasBalance,
  overseasCapability,
  overseasPrice,
  placeOrder,
  type OrderMarket,
  overseasReadiness,
} from "./kis";
import { adjustForDeposit, autoStatus, buildPlan, getJournal, loadState, resetLedger, resumeAuto, runCycle, getEngine, getEngineSel, setEngine, engineKey, AUTO_ENGINES } from "./autotrade";
import { runStrategy } from "./strategy";
import { tickerNewsStatus } from "./tickernews";
import { radarFind, radarOpps, radarScanChunk, radarSeedIfNeeded, radarStatus, radarTop } from "./radarscan";
import { comboRank, labCycle, labOverview, quantRank, quantScanChunk, quantStatus, resetQuant, QUANT_PROFILE_LIST } from "./quant";
import { taCached } from "./ta";
import { backtestResults } from "./backtest";
import { briefIndex, briefPage, rssXml, sitemapXml } from "./rss";
import { getVerdict } from "./verdict";
import { liveSensitivity, promoteSensitivity, rollbackSensitivity } from "./senslive";

export { RadarDB } from "./radar";

/** 국가명(한국어) — 지도 데이터와 별개로 Worker 쪽에서도 필요 */
const CC_NAME_KO: Record<string, string> = Object.fromEntries(
  Object.values(MARKETS).map((m) => [m.cc, m.nameKo]),
);

function marketOpen(tz: string, session?: [string, string]): { open: boolean; localTime: string; label: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const localTime = `${hour}:${minute}`;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  if (!session) return { open: false, localTime, label: "장시간 정보 없음" };
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = toMin(localTime);
  const open = !isWeekend && now >= toMin(session[0]) && now <= toMin(session[1]);
  return {
    open,
    localTime,
    label: isWeekend ? "주말 휴장" : open ? `정규장 진행중 (${session[0]}~${session[1]})` : `장 마감 (${session[0]}~${session[1]})`,
  };
}

async function fxToKrw(env: Env, currency: string): Promise<number> {
  if (!currency || currency === "KRW") return 1;
  try {
    const s = await getSeries(env, `${currency}KRW=X`, "5d");
    return s.price || 0;
  } catch {
    return 0;
  }
}

function regionIndexFor(cc: string) {
  const eu = ["AL", "AD", "BA", "BY", "MD", "ME", "MK", "RS", "UA", "IS", "LU", "LT", "LV", "EE", "SK", "SI", "HR", "BG", "RO", "HU", "CZ", "CY", "MT", "IE"];
  const asia = ["PK", "BD", "LK", "NP", "KH", "LA", "MM", "MN", "KZ", "UZ", "AZ", "GE", "AM", "IQ", "IR", "JO", "KW", "LB", "OM", "QA", "BH", "SY", "YE", "AF", "BN", "TL", "BT", "MV", "KG", "TJ", "TM"];
  const africa = ["NG", "KE", "GH", "TZ", "ET", "UG", "MA", "DZ", "TN", "SN", "CI", "CM", "ZW", "ZM", "BW", "NA", "MZ", "AO", "CD", "SD", "LY", "MU", "RW", "ML", "BF", "NE", "TD", "SO", "MG", "GA", "GN", "BJ", "TG", "SL", "LR", "MR", "CG", "CF", "ER", "SS", "DJ", "GM", "GW", "LS", "SZ", "MW", "BI", "GQ", "CV", "KM", "ST", "SC", "EH"];
  const northAm = ["GT", "CU", "HT", "DO", "HN", "NI", "CR", "PA", "JM", "TT", "BS", "BZ", "SV", "PR", "GL"];
  const southAm = ["CO", "PE", "VE", "EC", "BO", "PY", "UY", "GY", "SR", "GF"];
  const oceania = ["FJ", "PG", "SB", "VU", "NC", "WS", "TO", "FM", "PF"];
  if (eu.includes(cc)) return REGION_FALLBACK.EU;
  if (asia.includes(cc)) return REGION_FALLBACK.AS;
  if (africa.includes(cc)) return REGION_FALLBACK.AF;
  if (northAm.includes(cc)) return REGION_FALLBACK.NA;
  if (southAm.includes(cc)) return REGION_FALLBACK.SA_REGION;
  if (oceania.includes(cc)) return REGION_FALLBACK.OC;
  return REGION_FALLBACK.WORLD;
}

async function handleOverview(env: Env, cc: string, nameKo: string) {
  const overseas = overseasCapability(env);
  const m = marketFor(cc);
  const symbols: { symbol: string; label: string }[] = [];
  let hasLocalMarket = false;
  let regionNote: string | null = null;

  if (m?.index) {
    hasLocalMarket = true;
    symbols.push({ symbol: m.index, label: m.indexName ?? m.index });
    if (m.index2) symbols.push({ symbol: m.index2, label: m.index2Name ?? m.index2 });
  } else {
    const region = regionIndexFor(cc);
    symbols.push({ symbol: region.index, label: region.indexName });
    regionNote = m
      ? "이 국가의 대표지수는 공개 시세가 없어 지역 대표지수로 대체 표시합니다."
      : "이 국가는 개별 시장 데이터가 없어 지역 대표지수와 뉴스만 제공합니다.";
  }

  const series = await getManySeries(env, symbols.map((s) => s.symbol), "3mo");
  const indexList = symbols
    .map((s) => {
      const found = series.find((x) => x.symbol.toUpperCase() === s.symbol.toUpperCase());
      return found ? { ...toSnapshot(found, s.label), sparkline: found.closes.slice(-40) } : null;
    })
    .filter(Boolean);

  const fx = m ? await fxToKrw(env, m.currency) : 0;

  return {
    cc,
    nameKo: m?.nameKo ?? nameKo,
    hasLocalMarket,
    regionNote,
    proxyNote: m?.proxyNote ?? null,
    currency: m?.currency ?? null,
    fxToKrw: fx ? round(fx, 4) : null,
    session: m ? marketOpen(m.tz, m.session) : null,
    tz: m?.tz ?? null,
    indices: indexList,
    tickerCount: m?.tickers.length ?? 0,
    orderableCount:
      m?.tickers.filter((t) => t.kis && (t.kis.market === "KRX" || overseas.allowed)).length ?? 0,
    disclaimer: DISCLAIMER,
  };
}

async function router(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health") {
    return json({ ok: true, now: Date.now(), markets: Object.keys(MARKETS).length });
  }

  if (path === "/api/config") {
    const overseas = overseasCapability(env);
    return json({
      kis: kisStatus(env),
      ai: aiStatus(env),
      markets: Object.values(MARKETS).map((m) => {
        const withKis = m.tickers.filter((t) => t.kis);
        // 지금 계좌 모드에서 실제로 주문이 나갈 수 있는 종목 수
        const orderableNow = withKis.filter((t) => t.kis!.market === "KRX" || overseas.allowed).length;
        return {
          cc: m.cc,
          nameKo: m.nameKo,
          indexName: m.indexName ?? null,
          tickers: m.tickers.length,
          orderable: withKis.length,
          orderableNow,
        };
      }),
      disclaimer: DISCLAIMER,
    });
  }

  if (path === "/api/tape") {
    const { data, fetchedAt } = await cached(env, "tape:global", 90, async () => {
      const series = await getManySeries(env, GLOBAL_TAPE.map((t) => t.symbol), "5d");
      return GLOBAL_TAPE.map((t) => {
        const s = series.find((x) => x.symbol.toUpperCase() === t.symbol.toUpperCase());
        return s ? toSnapshot(s, t.label) : null;
      }).filter(Boolean);
    });
    return json({ items: data, fetchedAt });
  }

  if (path === "/api/global/news") {
    const { data, fetchedAt, stale } = await getGlobalNews(env);
    return json({ items: data.items, sources: data.sources, fetchedAt, stale });
  }

  const countryMatch = /^\/api\/country\/([A-Za-z]{2})(\/(overview|news|recommend|analysis))?$/.exec(path);
  if (countryMatch) {
    const cc = countryMatch[1].toUpperCase();
    const section = countryMatch[3] ?? "overview";
    const nameKo = url.searchParams.get("name") || CC_NAME_KO[cc] || cc;

    if (section === "news") {
      const { data, fetchedAt, stale } = await getNews(env, cc, nameKo);
      return json({ cc, items: data.items, sources: data.sources, fetchedAt, stale });
    }

    if (section === "recommend") {
      const m = marketFor(cc);
      if (!m || m.tickers.length === 0) {
        return json({
          cc,
          unsupported: true,
          reason: m
            ? "이 시장은 개별종목 시세 소스가 없어 추천을 계산하지 않습니다."
            : "이 국가는 종목 유니버스가 등록되지 않았습니다. 뉴스만 확인하세요.",
          items: [],
          disclaimer: DISCLAIMER,
        });
      }
      const { data } = await cached(env, `reco:${cc}`, 300, async () => {
        const [{ data: news }, indexSeries] = await Promise.all([
          getNews(env, cc, m.nameKo),
          m.index ? getSeries(env, m.index, "3mo").catch(() => undefined) : Promise.resolve(undefined),
        ]);
        return recommend(env, m, news.items, indexSeries);
      });
      return json(data);
    }

    if (section === "analysis") {
      const m = marketFor(cc);
      if (!m) {
        throw new ApiError(400, "analysis_unsupported", {
          hint: "이 국가는 시장 데이터가 없어 AI 분석을 만들지 않습니다.",
        });
      }
      const status = aiStatus(env);
      if (!status.enabled) throw new ApiError(503, "ai_disabled", { hint: status.reason });

      const [{ data: news }, ovw, recoResult] = await Promise.all([
        getNews(env, cc, m.nameKo),
        cached(env, `ovw:${cc}`, 120, () => handleOverview(env, cc, m.nameKo)),
        m.tickers.length
          ? cached(env, `reco:${cc}`, 300, async () => {
              const [{ data: n }, indexSeries] = await Promise.all([
                getNews(env, cc, m.nameKo),
                m.index ? getSeries(env, m.index, "3mo").catch(() => undefined) : Promise.resolve(undefined),
              ]);
              return recommend(env, m, n.items, indexSeries);
            })
          : Promise.resolve(null),
      ]);

      const indices = (ovw.data.indices as { label: string; price: number; changePct: number }[]) ?? [];
      const { data } = await getAnalysis(env, m, indices, news.items, recoResult ? recoResult.data : null);
      return json(data);
    }

    const { data } = await cached(env, `ovw:${cc}`, 120, () => handleOverview(env, cc, nameKo));
    return json(data);
  }

  if (path === "/api/quote") {
    const symbol = url.searchParams.get("symbol");
    if (!symbol) throw new ApiError(400, "symbol_required");
    const range = url.searchParams.get("range") ?? "3mo";
    const s = await getSeries(env, symbol, range);
    return json(s);
  }

  /* ── KIS ─────────────────────────────────────────────── */

  if (path === "/api/kis/status") {
    return json(kisStatus(env));
  }

  if (path === "/api/kis/price") {
    assertTradeAuth(env, request);
    const cfg = kisConfig(env);
    const market = (url.searchParams.get("market") ?? "KRX") as OrderMarket;
    const code = url.searchParams.get("code");
    if (!code) throw new ApiError(400, "code_required");
    assertOverseasAllowed(env, market);
    const data = market === "KRX" ? await domesticPrice(env, cfg, code) : await overseasPrice(env, cfg, market, code);
    return json(data);
  }

  if (path === "/api/kis/balance") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const cfg = kisConfig(env);
    const body = (await request.json().catch(() => ({}))) as { market?: string; currency?: string };
    const market = (body.market ?? "KRX") as OrderMarket;
    assertOverseasAllowed(env, market);
    const data =
      market === "KRX"
        ? await domesticBalance(env, cfg)
        : await overseasBalance(env, cfg, market, body.currency ?? "USD");
    return json(data);
  }

  if (path === "/api/kis/overseas-check") {
    // "해외 거래가 되나?" 를 우리 설정이 아니라 KIS 응답으로 답한다.
    // 잔고·보유 내역은 돌려주지 않는다 — 응답 코드와 달러 예수금 유무만 본다.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json(await overseasReadiness(env, kisConfig(env)));
  }

  if (path === "/api/kis/order") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const cfg = kisConfig(env);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const market = String(body.market ?? "KRX") as OrderMarket;
    const code = String(body.code ?? "").trim();
    const side = String(body.side ?? "") === "sell" ? "sell" : "buy";
    const qty = Math.floor(num(body.qty));
    const orderType = String(body.orderType ?? "limit") === "market" ? "market" : "limit";
    const price = num(body.price);
    const currency = String(body.currency ?? (market === "KRX" ? "KRW" : "USD"));
    if (!code) throw new ApiError(400, "code_required");
    // 확인 절차: 프론트에서 종목코드를 다시 입력해 confirm 필드로 보낸다.
    if (String(body.confirm ?? "").toUpperCase() !== code.toUpperCase()) {
      throw new ApiError(400, "confirm_mismatch", { hint: "확인란에 종목코드를 정확히 입력해야 주문이 전송됩니다." });
    }

    const fx = await fxToKrw(env, currency);
    const unit = orderType === "market" ? num(body.refPrice, price) : price;
    const notionalKrw = unit * qty * (currency === "KRW" ? 1 : fx || 0);
    if (currency !== "KRW" && !fx) throw new ApiError(502, "fx_unavailable", { hint: "환율 조회 실패로 한도 검증을 못 했습니다." });

    const result = await placeOrder(env, cfg, { market, code, side, qty, price, orderType, notionalKrw });
    return json({ ...result, notionalKrw: Math.round(notionalKrw), currency });
  }

  if (path === "/api/kis/cancel") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const cfg = kisConfig(env);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const out = await cancelDomesticOrder(env, cfg, {
      orgNo: String(body.orgNo ?? ""),
      orderNo: String(body.orderNo ?? ""),
      qty: Math.floor(num(body.qty)),
      all: Boolean(body.all),
    });
    return json({ ok: true, detail: out["msg1"] ?? null });
  }

  /* ── 자동매매 ─────────────────────────────────────────── */

  if (path === "/api/auto/engine") {
    // 조회는 공개, 변경은 거래 암호 필요 — 실제 돈이 걸린 설정이다.
    if (request.method === "POST") {
      assertTradeAuth(env, request);
      const body = (await request.json().catch(() => ({}))) as { engine?: string; weights?: { onto?: number; flow?: number; chart?: number } };
      const prev = await getEngineSel(env);
      const sel = await setEngine(env, body);
      // 옛 엔진으로 만든 계획이 남아 있으면 화면이 바로 안 바뀐다 — 프리셋 + 전후 커스텀 키 전부 비운다
      await Promise.all([
        ...AUTO_ENGINES.map((e) => invalidateCache(env, `auto:plan:${e.id}`)),
        invalidateCache(env, `auto:plan:${engineKey(prev)}`),
        invalidateCache(env, `auto:plan:${engineKey(sel)}`),
      ]);
      // 사용자 지시(2026-08-16): 엔진은 바뀐 그 순간부터 작동한다.
      // 다음 크론(최대 15분)을 기다리지 않고 즉시 한 사이클을 돌린다 — 장중이면
      // 새 엔진 기준의 매도·매수가 바로 나가고, 장외면 계획·일지만 갱신된다.
      ctx.waitUntil(runCycle(env).catch(() => undefined));
      return json({ ok: true, engine: sel.id, engineName: sel.nameKo, weights: sel.w, engines: AUTO_ENGINES, note: "엔진 변경 즉시 사이클을 실행합니다 (장중이면 실주문 포함)." });
    }
    const sel = await getEngineSel(env);
    return json({ engine: sel.id, engineName: sel.nameKo, weights: sel.w, engines: AUTO_ENGINES });
  }

  if (path === "/api/auto/status") {
    // 계좌 평가액·보유 내역이 담긴다 — 자동매매 화면과 함께 비공개(나만 보기)
    assertTradeAuth(env, request);
    const state = await loadState(env);
    return json({
      ...autoStatus(env),
      engine: await getEngine(env),
      engines: AUTO_ENGINES,
      state: {
        baselineEquity: state.baselineEquity,
        lastEquity: state.lastEquity,
        peakEquity: state.peakEquity,
        pnlKrw: state.baselineEquity ? Math.round(state.lastEquity - state.baselineEquity) : 0,
        day: state.day,
        tradesToday: state.tradesToday,
        haltedDay: state.haltedDay,
        haltedPermanent: state.haltedPermanent,
        haltReason: state.haltReason,
        targetReachedAt: state.targetReachedAt,
        lastCycleAt: state.lastCycleAt,
        positions: Object.values(state.positions),
      },
    });
  }

  if (path === "/api/auto/plan") {
    // 2026-08-16 사용자 지시("자동매매는 나만 보도록"): 계좌 금액·주문 계획이 담긴
    // 화면이라 거래 암호 없이는 열리지 않는다. 공개 화면(전략실·조합 전략)은
    // 백테스트·시뮬레이션·조합 순위만 보여준다.
    assertTradeAuth(env, request);
    // 캐시 키에 엔진을 넣는다 — 넣지 않으면 엔진을 바꿔도 2분간 옛 계획이 돌아와
    // "버튼이 안 눌린다"로 보인다. 메모리 캐시는 아이솔레이트마다 따로라
    // 무효화만으로는 못 막고, 키를 갈라야 확실하다.
    const sel = await getEngineSel(env);
    const { data } = await cached(env, `auto:plan:${engineKey(sel)}`, 120, () => buildPlan(env));
    return json(data);
  }

  if (path === "/api/translate") {
    // 실시간 번역 — 공개, 캐시 우선. 남용 방지는 배치 크기·미스 상한으로.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    const body = (await request.json().catch(() => ({}))) as { target?: string; texts?: unknown };
    return json(await translateBatch(env, String(body.target ?? ""), body.texts));
  }

  if (path === "/api/combo/rank") {
    // 공개 추천 — "세 분석을 이 비율로 섞으면 지금 어떤 종목이 유리한가".
    // 계좌와 무관한 조회 전용이라 공개한다.
    const w = {
      onto: num(url.searchParams.get("onto"), 34),
      flow: num(url.searchParams.get("flow"), 33),
      chart: num(url.searchParams.get("chart"), 33),
    };
    const limit = Math.min(50, Math.max(1, Math.floor(num(url.searchParams.get("limit"), 20))));
    const key = `combo:rank:${w.onto}-${w.flow}-${w.chart}:${limit}`;
    const { data } = await cached(env, key, 120, () => comboRank(env, w, limit));
    return json(data);
  }

  if (path === "/api/onto/state") {
    // 메인 화면(3D 온톨로지)이 쓰는 살아 있는 그래프 상태.
    // 매매 계획과 분리한 이유는 이건 "분석 화면"이지 "주문 화면"이 아니기 때문이다.
    const { data } = await cached(env, "auto:strategy", 300, () => runStrategy(env));
    return json({
      generatedAt: data.generatedAt,
      dataAsOf: data.dataAsOf ?? null,
      macro: data.macro,
      scores: data.scores,
      riskOff: data.riskOff,
      note: data.note,
      macroNews: data.macroNews ?? { provider: null, headlinesUsed: 0, adjustments: [] },
      sectors: Object.entries(SENSITIVITY).map(([sector, sensitivity]) => ({ sector, sensitivity })),
      universe: UNIVERSE.map((t) => ({ code: t.code, nameKo: t.nameKo, sectors: t.sectors })),
      weights: WEIGHTS,
      // 의미론적 온톨로지 층: 간선의 인과 유형·메커니즘, 거시요인 간 인과, 의미 클러스터
      relations: RELATIONS,
      macroLinks: MACRO_LINKS,
      macroClusters: MACRO_CLUSTERS,
    });
  }

  if (path === "/api/radar/top") {
    const limit = Math.min(100, num(url.searchParams.get("limit"), 30));
    const order = url.searchParams.get("order") === "asc" ? "asc" as const : "desc" as const;
    const sector = url.searchParams.get("sector") || undefined;
    return json(await radarTop(env, limit, order, sector));
  }

  if (path === "/api/radar/find") {
    return json(await radarFind(env, url.searchParams.get("q") ?? "", num(url.searchParams.get("limit"), 8)));
  }

  if (path === "/api/radar/status") {
    return json(await radarStatus(env));
  }

  if (path === "/api/radar/opps") {
    // 기회 탐색: 하락 국면에서도 수혜 경로·상대 강세·약세 경고를 낸다. market=KR|US
    const market = url.searchParams.get("market") ?? undefined;
    return json(await radarOpps(env, Math.min(15, num(url.searchParams.get("limit"), 8)), market));
  }

  if (path === "/api/onto/promote") {
    // 온톨로지 MLOps 승격 — 게이트 통과 후보만, 거래 암호 필요. 자동 승격은 없다.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as Parameters<typeof promoteSensitivity>[1];
    return json({ ok: true, live: await promoteSensitivity(env, body) });
  }

  if (path === "/api/onto/rollback") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json({ ok: true, ...(await rollbackSensitivity(env)) });
  }

  if (path === "/api/onto/sens") {
    // 지금 적용 중인 민감도 표 버전 (조회용)
    const { table, version } = await liveSensitivity(env);
    return json({ version, table });
  }

  if (path === "/api/onto/verdict") {
    // 온톨로지 결론 — 요인 인과 → 국면 → 섹터·종목 추천. 섹터·종목은 출력이지 입력이 아니다.
    const market = url.searchParams.get("market") === "US" ? "US" as const : "KR" as const;
    return json(await getVerdict(env, market));
  }

  if (path === "/api/radar/scan") {
    // 크론이 알아서 돌지만, 초기 적재·수동 갱신용으로 열어 둔다.
    // 인증: 거래 암호(TRADE_TOKEN) 또는 운영용 RADAR_TOKEN — fetch 예산 남용 방지.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!env.RADAR_TOKEN || bearer !== env.RADAR_TOKEN) assertTradeAuth(env, request);
    await radarSeedIfNeeded(env);
    return json(await radarScanChunk(env));
  }

  if (path === "/api/auto/tnews") {
    // 종목별 뉴스 수집 상태 (읽기 전용 진단)
    return json(await tickerNewsStatus(env));
  }

  if (path === "/api/auto/graph") {
    // 온톨로지 그래프 자체(정적 지식)를 그대로 노출한다. 판단 근거를 감출 이유가 없다.
    return jsonCached(
      {
        macro: MACRO.map((m) => ({ id: m.id, nameKo: m.nameKo, symbol: m.symbol, scale: m.scale, upMeansKo: m.upMeansKo })),
        sectors: Object.entries(SENSITIVITY).map(([sector, sens]) => ({ sector, sensitivity: sens })),
        universe: UNIVERSE.map((t) => ({ code: t.code, nameKo: t.nameKo, sectors: t.sectors })),
        weights: WEIGHTS,
      },
      3600,
    );
  }

  if (path === "/api/auto/journal") {
    // 실제 주문 일지 — 자동매매 화면과 함께 비공개(나만 보기)
    assertTradeAuth(env, request);
    return json({ items: await getJournal(env) });
  }

  if (path === "/api/auto/run") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as { shadow?: boolean };
    // 명시적으로 shadow:false 를 보내야 실제 주문 경로를 탄다.
    const result = await runCycle(env, { shadow: body.shadow !== false });
    return json({
      ran: result.ran,
      shadow: result.shadow,
      executed: result.executed,
      results: result.results,
      gate: result.plan.gate,
      orders: result.plan.orders,
    });
  }

  if (path === "/api/auto/deposit") {
    // 입출금 기준선 보정: {"amountKrw": 4000000} 입금 / 음수면 출금
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as { amountKrw?: number };
    const st = await adjustForDeposit(env, Number(body.amountKrw));
    return json({ ok: true, baselineEquity: st.baselineEquity, pnlKrw: st.lastEquity - st.baselineEquity });
  }

  if (path === "/api/auto/resume") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json({ ok: true, state: await resumeAuto(env) });
  }

  if (path === "/api/auto/reset") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json({ ok: true, state: await resetLedger(env) });
  }

  if (path === "/api/backtest") {
    // 엔진별·규칙별 백테스트 성적표 (개발 환경에서 실측한 값을 고정해 둔 것)
    return json(backtestResults());
  }

  if (path === "/api/ta") {
    // 기술적 분석 — 창시자가 있는 차트 전략 13종 판정 + 차트용 지표 시계열.
    // 요청 단위 계산이라 크론 예산을 쓰지 않는다.
    const symbol = (url.searchParams.get("symbol") ?? "").trim();
    if (!symbol) throw new ApiError(400, "symbol_required");
    // num(null, 180) 은 Number(null)=0 이라 기본값이 안 먹는다 — 파라미터 유무를 먼저 본다
    const daysRaw = url.searchParams.get("days");
    const days = Math.min(400, Math.max(60, daysRaw ? Math.floor(num(daysRaw, 180)) : 180));
    return json(await taCached(env, symbol, days));
  }

  /* ── 퀀트 트랙 (수급·차트 전용 · 모의매매) ───────────────── */

  if (path === "/api/lab/overview") {
    // 전략실 — 4개 전략의 모의 원장 성적. 조회는 공개(어떤 근거로 판단하는지 보이게).
    const { data } = await cached(env, "lab:overview", 60, () => labOverview(env));
    return json(data);
  }

  if (path === "/api/quant/status") {
    return json(await quantStatus(env));
  }

  if (path === "/api/quant/rank") {
    const profile = url.searchParams.get("profile") ?? undefined;
    const limit = Math.min(50, Math.max(1, Math.floor(num(url.searchParams.get("limit"), 20))));
    return json({ ...(await quantRank(env, profile, limit)), profiles: QUANT_PROFILE_LIST });
  }

  if (path === "/api/quant/scan") {
    // 수동 스캔 — 크론을 기다리지 않고 조각을 하나 돌린다
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json(await quantScanChunk(env));
  }

  if (path === "/api/quant/run") {
    // 모의매매 한 사이클. 실주문 경로가 없으므로 계좌를 건드리지 않는다.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json(await labCycle(env));
  }

  if (path === "/api/quant/reset") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    return json({ ok: true, state: await resetQuant(env) });
  }

  void ctx;
  throw new ApiError(404, "not_found", { path });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // 정식 주소는 stockontology.cc — 옛 workers.dev 주소와 www 는 301 로 넘겨
    // 그동안 쌓인 검색 색인이 새 도메인으로 승계되게 한다.
    if (url.hostname === "worldnews.sjshin.workers.dev" || url.hostname === "www.stockontology.cc") {
      url.hostname = "stockontology.cc";
      const method = request.method.toUpperCase();
      return Response.redirect(url.toString(), method === "GET" || method === "HEAD" ? 301 : 308);
    }
    // SEO 표면 — 전부 워커가 동적으로 만든다 (SPA 는 크롤러에게 줄 본문이 없다)
    if (url.pathname === "/rss.xml") {
      return rssXml(env).catch(() => new Response("rss unavailable", { status: 503 }));
    }
    if (url.pathname === "/sitemap.xml" || url.pathname === "/sitemap-main.xml") {
      // 브리핑 페이지가 쌓일 때마다 자동으로 사이트맵에 들어가도록 동적 생성.
      // /sitemap-main.xml 은 같은 내용의 별칭 — 서치콘솔에서 "가져올 수 없음" 상태가
      // 안 풀릴 때 새 행으로 제출해 즉시 재수집시키는 용도.
      return sitemapXml(env).catch(() => new Response("sitemap unavailable", { status: 503 }));
    }
    if (url.pathname === "/brief" || url.pathname === "/brief/") {
      return briefIndex(env).catch(() => new Response("unavailable", { status: 503 }));
    }
    const briefMatch = url.pathname.match(/^\/brief\/(\d{4}-\d{2}-\d{2})$/);
    if (briefMatch) {
      return briefPage(env, briefMatch[1]).catch(() => new Response("unavailable", { status: 503 }));
    }
    // 다국어 진입 URL — 검색엔진이 언어별로 색인할 수 있는 주소
    const langMatch = url.pathname.match(/^\/(en|ja|zh)\/?$/);
    if (langMatch) {
      return langIndex(env, url.origin, langMatch[1]).catch(() => env.ASSETS.fetch(request));
    }
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": url.origin,
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }
    try {
      return await router(request, env, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  },

  /**
   * 정규장 시간대에 15분마다 자동매매 사이클을 돈다.
   * AUTOTRADE_ENABLED 가 false 면 runCycle 이 그림자 실행으로 떨어져 일지만 남긴다.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 장중 정각(예: 09:00 KST)에는 15분 크론과 매시간 크론이 동시에 발화해
    // runCycle 이 두 번 돌았다 — 같은 매도가 두 번 나가 "주문 가능 수량 초과"의
    // 원인이 된다. 장중 시간대에는 15분 크론만 매매를 돌린다.
    const now = new Date();
    const marketWindow = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && now.getUTCHours() <= 6;
    const skipTrade = event.cron === "0 * * * *" && marketWindow;

    // 반드시 순차로: 두 작업이 같은 인보케이션의 서브리퀘스트 한도(50)를 나눠 쓴다.
    // 주문(runCycle)이 예산을 먼저 쓰고, 레이더는 남은 예산으로 돈다(실패해도 다음 크론이 재시도).
    ctx.waitUntil(
      (skipTrade ? Promise.resolve() : runCycle(env).then(() => undefined)).catch(() => {
        /* 크론은 조용히 실패한다. 원인은 일지·tail 로 확인 */
      })
        // 전 시장 레이더: 한 번에 80종목씩 순회
        .then(() => radarScanChunk(env))
        .catch(() => undefined)
        // 퀀트 트랙: 코스피200 조각 스캔 → 모의매매 한 사이클.
        // 순서가 마지막인 이유는 서브리퀘스트 예산(50) 때문이다 — 실주문(runCycle)이
        // 먼저 쓰고, 모의매매는 남은 예산으로 돈다(실패해도 손해가 없다).
        .then(() => quantScanChunk(env))
        .then(() => (skipTrade ? undefined : labCycle(env)))
        .catch(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
