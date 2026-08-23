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
import { isKrxHoliday } from "./holidays";
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
import { adjustForDeposit, appendJournal, autoStatus, buildPlan, entry, getJournal, loadState, resetLedger, resumeAuto, runCycle, getEngine, getEngineSel, setEngine, setReserveKrw, engineKey, AUTO_ENGINES } from "./autotrade";
import { getUsEngine, setUsEngine, US_ENGINES, usAutoStatus, usRunCycle } from "./autotrade-us";
import { runStrategy } from "./strategy";
import { tickerNewsStatus } from "./tickernews";
import { radarFind, radarOpps, radarScanChunk, radarSeedIfNeeded, radarStatus, radarTop } from "./radarscan";
import { comboRank, labCycle, labOverview, quantRank, quantScanChunk, quantStatus, resetQuant, QUANT_PROFILE_LIST } from "./quant";
import { taCached } from "./ta";
import { backtestResults } from "./backtest";
import { briefIndex, briefPage, rssXml, sitemapXml } from "./rss";
import { getVerdict } from "./verdict";
import { briefCardSvg, dailyBrief } from "./brief";
import { sceneSvg } from "./scenes";
import { liveSensitivity, promoteSensitivity, rollbackSensitivity } from "./senslive";
import { runScalpCycle, setScalpPct } from "./scalptrade";
import { GIFT_API_PATH, GIFT_PAGE_PATH } from "../shared/gift";
import { finishKakaoConnect, giftQuote, requestGift, startKakaoConnect } from "./gift";

export { RadarDB } from "./radar";

/** 국가명(한국어) — 지도 데이터와 별개로 Worker 쪽에서도 필요 */
const CC_NAME_KO: Record<string, string> = Object.fromEntries(
  Object.values(MARKETS).map((m) => [m.cc, m.nameKo]),
);

function marketOpen(tz: string, session?: [string, string]): { open: boolean; localTime: string; label: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const localTime = `${get("hour") || "00"}:${get("minute") || "00"}`;
  const weekday = get("weekday") || "Mon";
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  // 한국 공휴일 휴장 — "휴일인데 정규장 진행중으로 나온다" 버그(2026-08-17 광복절 대체휴일) 수정
  const dateLocal = `${get("year")}-${get("month")}-${get("day")}`;
  const isHoliday = tz === "Asia/Seoul" && isKrxHoliday(dateLocal);
  if (!session) return { open: false, localTime, label: "장시간 정보 없음" };
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = toMin(localTime);
  const open = !isWeekend && !isHoliday && now >= toMin(session[0]) && now <= toMin(session[1]);
  return {
    open,
    localTime,
    label: isWeekend
      ? "주말 휴장"
      : isHoliday
        ? "공휴일 휴장"
        : open
          ? `정규장 진행중 (${session[0]}~${session[1]})`
          : `장 마감 (${session[0]}~${session[1]})`,
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
      // 설정 변경과 주문 실행을 분리한다. 새 엔진은 다음 정규 크론에서 데이터·진입
      // 게이트를 다시 통과한 뒤 적용되며, 설정 버튼 자체는 주문을 만들지 않는다.
      return json({ ok: true, engine: sel.id, engineName: sel.nameKo, weights: sel.w, engines: AUTO_ENGINES, note: "엔진 설정만 저장했습니다. 다음 정규 사이클에서 안전 게이트를 다시 확인합니다." });
    }
    const sel = await getEngineSel(env);
    return json({ engine: sel.id, engineName: sel.nameKo, weights: sel.w, engines: AUTO_ENGINES });
  }

  if (path === "/api/auto/reserve") {
    // 미국 배분(예약 현금) 조절 — 국내 봇이 쓰지 않고 남겨 두는 몫
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as { reserveKrw?: number };
    const v = await setReserveKrw(env, Number(body.reserveKrw));
    // 예약이 바뀌면 예산이 바뀐다 — 옛 계획 캐시를 전부 비운다
    const sel = await getEngineSel(env);
    await Promise.all([
      ...AUTO_ENGINES.map((e) => invalidateCache(env, `auto:plan:${e.id}`)),
      invalidateCache(env, `auto:plan:${engineKey(sel)}`),
    ]);
    return json({ ok: true, reserveKrw: v });
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

  if (path === "/api/auto/scalp") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as { pct?: number };
    const pct = await setScalpPct(env, Number(body.pct));
    const sel = await getEngineSel(env);
    await Promise.all([
      ...AUTO_ENGINES.map((e) => invalidateCache(env, `auto:plan:${e.id}`)),
      invalidateCache(env, `auto:plan:${engineKey(sel)}`),
    ]);
    return json({ ok: true, pct });
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
    // 45초 캐시 — "실시간 최신화" 지시(2026-08-18). 내부의 전략 5분·계좌 60초 캐시가
    // 무거운 호출을 이미 흡수하므로 짧게 가도 서브리퀘스트 부담이 없다.
    const { data } = await cached(env, `auto:plan:${engineKey(sel)}`, 45, () => buildPlan(env));
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
    const market = url.searchParams.get("market") === "US" ? "US" as const : "KR" as const;
    const key = `combo:rank:${market}:${w.onto}-${w.flow}-${w.chart}:${limit}`;
    const { data } = await cached(env, key, 120, () => comboRank(env, w, limit, market));
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

  if (path === "/api/auto/us/run") {
    // 미국 실계좌 사이클 수동 실행 — 기본은 그림자(주문 미전송), shadow:false 를
    // 명시해야 실주문 경로를 탄다. force 로 장 마감 중에도 점검할 수 있다.
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
    assertTradeAuth(env, request);
    const body = (await request.json().catch(() => ({}))) as { shadow?: boolean; force?: boolean };
    return json(await usRunCycle(env, { shadow: body.shadow !== false, force: body.force === true }));
  }

  if (path === "/api/auto/us/engine") {
    // 미국 봇 엔진 — 한국(auto:engine)과 완전 별개. 설정만 저장하고 다음 정규 사이클에 적용한다.
    assertTradeAuth(env, request);
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { engine?: string };
      const e = await setUsEngine(env, String(body.engine ?? ""));
      return json({ ok: true, engine: e, engines: US_ENGINES, note: "미국 엔진 설정을 저장했습니다. 다음 정규 사이클에서 안전 게이트를 다시 확인합니다." });
    }
    return json({ engine: await getUsEngine(env), engines: US_ENGINES });
  }

  if (path === "/api/auto/us/status") {
    // 미국 봇 상태 — 원장·마지막 사이클 결과. 계좌 정보가 섞이므로 운영자 전용.
    assertTradeAuth(env, request);
    return json(await usAutoStatus(env));
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

  if (path === "/api/daily-brief") {
    // 외부 발행 파이프라인(유튜브 등)용 장 마감 요약 — 공개 데이터만, 5분 캐시
    const market = (url.searchParams.get("market") ?? "both").toUpperCase();
    const m = market === "KR" || market === "US" ? (market as "KR" | "US") : "both";
    const date = url.searchParams.get("date") ?? undefined;
    const { data } = await cached(env, `brief:v2:${m}:${date ?? "today"}`, 300, () => dailyBrief(env, m, date));
    return json(data);
  }

  if (path === "/api/scene.svg") {
    // 영상 파이프라인용 장면 렌더 — 공개 데이터만(결론·리그·백테스트), 5분 캐시
    const market = url.searchParams.get("market")?.toUpperCase() === "US" ? "US" : "KR";
    const view = url.searchParams.get("view") ?? "overview";
    const animate = url.searchParams.get("animate") === "1";
    const { data } = await cached(env, `scene:v1:${market}:${view}:${animate ? 1 : 0}`, 300, () =>
      sceneSvg(env, market, view, animate),
    );
    return new Response(data, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
  }

  if (path === "/api/brief-card.svg") {
    // 온톨로지 경로 카드 — 16:9(기본) / 9:16(쇼츠). 발행 파이프라인이 <img>/캡처로 쓴다
    const market = url.searchParams.get("market")?.toUpperCase() === "US" ? "US" : "KR";
    const ratio = url.searchParams.get("ratio") === "9:16" ? "9:16" : "16:9";
    const { data } = await cached(env, `brief:card:v2:${market}:${ratio}`, 300, () => briefCardSvg(env, market, ratio));
    return new Response(data, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
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
    const market = url.searchParams.get("market") === "US" ? "US" as const : "KR" as const;
    const { data } = await cached(env, `lab:overview:${market}`, 60, () => labOverview(env, market));
    return json(data);
  }

  if (path === "/api/quant/status") {
    return json(await quantStatus(env));
  }

  if (path === "/api/quant/rank") {
    const profile = url.searchParams.get("profile") ?? undefined;
    const limit = Math.min(50, Math.max(1, Math.floor(num(url.searchParams.get("limit"), 20))));
    const market = url.searchParams.get("market") === "US" ? "US" as const : "KR" as const;
    return json({ ...(await quantRank(env, profile, limit, market)), profiles: QUANT_PROFILE_LIST });
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
    if (url.pathname === GIFT_PAGE_PATH || url.pathname === `${GIFT_PAGE_PATH}/`) {
      // Cloudflare Assets의 HTML pretty URL을 내부에서 직접 조회해 외부 주소 리디렉션을 피한다.
      const asset = await env.ASSETS.fetch(new Request(`${url.origin}/gift`, request));
      const headers = new Headers(asset.headers);
      headers.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
      headers.set("cache-control", "private, no-store");
      headers.set("referrer-policy", "no-referrer");
      return new Response(asset.body, { status: asset.status, headers });
    }
    // 빌드 산출물의 짧은 이름으로 우회하지 못하게 하고, 사진도 색인 금지 헤더를 붙인다.
    if (url.pathname === "/gift" || url.pathname === "/gift/" || url.pathname === "/gift.html") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/gift/")) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      headers.set("cache-control", "private, max-age=86400");
      return new Response(asset.body, { status: asset.status, headers });
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
    // 분봉 단타는 1분 전용 크론에서 단독 실행한다. 무거운 레이더·저회전 사이클과
    // 같은 인보케이션에 섞으면 KIS 서브리퀘스트 한도를 나눠 갖고 체결 감시가 늦어진다.
    if (event.cron === "* 0-6 * * 1-5" || event.cron === "* 13-21 * * 1-5") {
      const market = event.cron.startsWith("* 0-6") ? "KR" : "US";
      ctx.waitUntil(runScalpCycle(env, market).catch(() => undefined));
      return;
    }
    // 장중 정각(예: 09:00 KST)에는 15분 크론과 매시간 크론이 동시에 발화해
    // runCycle 이 두 번 돌았다 — 같은 매도가 두 번 나가 "주문 가능 수량 초과"의
    // 원인이 된다. 장중 시간대에는 15분 크론만 매매를 돌린다.
    const now = new Date();
    // 15분 크론이 커버하는 창: 한국장(UTC 0~6) + 미국장(UTC 13~21). 이 창에서 정각에
    // 매시간 크론이 겹치면 매매(runCycle·labCycle)가 두 번 돌아 중복 주문이 난다.
    const h = now.getUTCHours();
    const marketWindow = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && (h <= 6 || (h >= 13 && h <= 21));
    // 미국장 15분 크론은 미국 실계좌 사이클(usRunCycle) + 리그·스캔 — 한국 실계좌
    // 봇(runCycle)까지 돌리면 밤새 "그림자 실행" 기록이 15분마다 쌓여 일지(120줄)를
    // 잡음으로 채운다(2026-08-18 실측). 한국 크론은 반대로 runCycle 만 돈다.
    const usWindow = h >= 13 && h <= 21;
    const usCron = event.cron === "*/15 13-21 * * 1-5";
    const skipTrade = usCron || (event.cron === "0 * * * *" && marketWindow);

    /* 2026-08-21 진단용 심박 — 미국 봇이 침묵으로 멈춰 원인을 못 좁혔다.
     * 실패 로그도 안 남는다는 건 usRunCycle 자체가 호출되지 않거나, 호출은 되지만
     * "장 마감"으로 조용히 스킵하는 경로 둘 다일 수 있어 구분이 안 됐다. 그래서
     * 크론이 호출될 때마다 무조건(분기 전에) 기록한다 — 원인이 좁혀지면 지운다. */
    ctx.waitUntil(
      env.CACHE.put(
        "diag:cron:last",
        JSON.stringify({ at: Date.now(), cron: event.cron, usCron, skipTrade, h, utcMin: now.getUTCMinutes() }),
      ).catch(() => undefined),
    );
    // usCron 전용 심박 — 이 키만 보면 "15분 미국 크론이 최근에 실제로 돌았는지"를 딴 크론과 안 섞고 판별할 수 있다.
    if (usCron) ctx.waitUntil(env.CACHE.put("diag:us:15min:heartbeat", String(Date.now())).catch(() => undefined));

    /* 2026-08-21 자동 보완 장치 — 오늘 미국 전용 15분 크론이 개장 후 2시간 반 넘게
     * 한 번도 발화하지 않은 게 확인됐다(클라우드플레어 쪽 크론 전달 문제로 추정,
     * 코드·배포는 정상). 사용자가 자리에 없어 수동 실행도 못 하는 상황이라, 이미
     * 살아있는 걸로 확인된 매시간 크론이 대신 깨우게 한다.
     * 안전장치: 15분 크론의 심박이 20분 이내로 최근이면(=정상 작동 중이면) 절대
     * 끼어들지 않는다 — 두 크론이 겹쳐 같은 매도가 두 번 나가는 중복 주문을 막기
     * 위해서다(2026-08-18 실측으로 skipTrade 를 만든 바로 그 문제). 15분 크론이
     * 다시 살아나면 이 보완 장치는 자동으로 조용해진다. */
    let usFallback = false;
    if (!usCron && event.cron === "0 * * * *" && usWindow) {
      const hb = await env.CACHE.get("diag:us:15min:heartbeat").catch(() => null);
      const lastSeen = hb ? Number(hb) : 0;
      if (Date.now() - lastSeen > 20 * 60 * 1000) {
        usFallback = true;
        ctx.waitUntil(
          appendJournal(env, [
            entry("cycle", `미국 — 15분 크론 미발화 감지(마지막 심박 ${lastSeen ? new Date(lastSeen).toISOString() : "없음"}), 매시간 크론이 대신 사이클을 실행합니다.`),
          ]).catch(() => undefined),
        );
      }
    }

    // 반드시 순차로: 두 작업이 같은 인보케이션의 서브리퀘스트 한도(50)를 나눠 쓴다.
    // 주문(runCycle/usRunCycle)이 예산을 먼저 쓰고, 레이더는 남은 예산으로 돈다(실패해도 다음 크론이 재시도).
    /* 2026-08-21: 미국 봇이 개장 후 두 시간 가까이 아무 기록 없이 멈춰 있었는데
     * 에러 일지도 안 남아 원인을 특정할 수 없었다("조용히 실패"의 대가). 사이클
     * 함수가 던지는 예외를 잡아 최소한 발생 사실은 일지에 남긴다 — 매매 로직은
     * 그대로다, 실패를 보이게만 만든다. */
    const logCycleFailure = (label: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.waitUntil(
        appendJournal(env, [entry("error", `${label} 사이클이 예외로 중단됐습니다 — ${msg.slice(0, 300)}`)]).catch(() => undefined),
      );
    };
    ctx.waitUntil(
      (usCron || usFallback
        ? usRunCycle(env).then(() => undefined).catch(logCycleFailure("미국"))
        : skipTrade
          ? Promise.resolve()
          : runCycle(env).then(() => undefined).catch(logCycleFailure("한국"))
      ).catch(() => {
        /* 위 catch 가 이미 일지에 남겼다. 여기는 체인이 끊기지 않게만 한다. */
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
