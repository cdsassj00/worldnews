/**
 * 온톨로지 기반 종목 선정 엔진 (운영 진입점).
 *
 *   1) 거시 신호 관측: 유가·환율·금리·반도체업황·중국·변동성·시장 (5일 변화율 → -1~1 정규화)
 *   2) 그래프 전파: 거시 → 섹터 민감도 → 종목 (경로를 그대로 보존해 설명 가능하게)
 *   3) 가격 신호: 모멘텀·추세·밴드 위치·거래량
 *   4) 뉴스 신호: 종목 별칭이 걸린 기사의 감성
 *   5) 합성 점수 → 목표 포트폴리오
 *
 * 세 신호를 합치는 이유는 서로 다른 실패 모드를 갖기 때문이다.
 * 온톨로지는 구조는 알지만 타이밍을 모르고, 모멘텀은 타이밍은 알지만 이유를 모르며,
 * 뉴스는 빠르지만 잡음이 많다. 한 축이 무너져도 나머지가 버티게 한다.
 *
 * 실제 계산식은 shared/scoring.ts 에 있다. 이 파일은 데이터를 모아 넣고 결과를 담는 껍데기다.
 * 백테스트(scripts/backtest.ts)가 같은 계산을 쓰게 하려는 분리다 — 여기서 갈라지면 검증이 무의미해진다.
 */
import type { Env } from "./env";
import { MACRO, SECTOR_KEYWORDS, UNIVERSE, type SectorId } from "../shared/ontology";
import { readTickerNews, refreshTickerNews } from "./tickernews";
import { getMacroNewsAdjust } from "./macronews";
import {
  clamp,
  composite,
  macroSignals,
  priceSignal,
  propagate,
  riskOffFrom,
  round,
  type MacroSignal,
  type ScoreReason,
} from "../shared/scoring";
import { getManySeries, getSeries, getSparkMany } from "./quotes";
import { getNews, type NewsItem } from "./news";
import { scoreForTicker, scoreText } from "./sentiment";

export type { MacroSignal, ScoreReason };

export interface TickerScore {
  code: string;
  symbol: string;
  nameKo: string;
  price: number;
  changePct: number;
  /** 합성 점수 (-1 ~ 1 근처) */
  score: number;
  ontologyScore: number;
  priceScore: number;
  newsScore: number;
  /** 변동성(일간 표준편차 %) */
  volatility: number;
  atr: number;
  reasons: ScoreReason[];
  /** 온톨로지 그래프 간선 (대시보드 시각화용) */
  edges: { macroId: string; sector: string; contribution: number }[];
}

export interface StrategyResult {
  generatedAt: number;
  /** 계산에 쓴 시세 중 가장 최신 봉의 시각(ms). 지연 시세라 generatedAt 보다 이르다. */
  dataAsOf: number | null;
  macro: MacroSignal[];
  scores: TickerScore[];
  /** 시장 전반 위험도 (VIX·지수 기반). 1에 가까울수록 위험회피 */
  riskOff: number;
  note: string;
  /** 1면 뉴스 AI 해석 (거시요인 보정) */
  macroNews: { provider: string | null; headlinesUsed: number; adjustments: { id: string; impact: number; reasonKo: string }[] };
}

export async function runStrategy(env: Env): Promise<StrategyResult> {
  const CORE = UNIVERSE.filter((t) => t.core);
  const EXTENDED = UNIVERSE.filter((t) => !t.core);

  const [macroSpark, priceSeries, extendedSpark, newsResult, tickerNews, mnews] = await Promise.all([
    // 거시 지표는 종가만 필요하다 — 8개를 fetch 한 번에
    getSparkMany(env, MACRO.map((m) => m.symbol), "3mo"),
    // 코어 20종목: OHLCV 전체 (거래량·ATR가 자동매매 품질을 좌우한다)
    getManySeries(env, CORE.map((t) => t.symbol), "6mo"),
    // 확장 ~69종목: 종가 배치 (20심볼/fetch)
    getSparkMany(env, EXTENDED.map((t) => t.symbol), "6mo"),
    getNews(env, "KR", "대한민국").catch(() => null),
    // 종목별 뉴스: 오래된 4종목만 새로 검색하고(fetch 예산) 나머지는 KV에서 읽는다
    refreshTickerNews(env).catch(() => readTickerNews(env)),
    // 1면·거시 뉴스 AI 해석 (30분 캐시)
    getMacroNewsAdjust(env).catch(() => null),
  ]);

  const macroBySymbol = new Map(
    macroSpark.map((s) => [s.symbol.toUpperCase(), { price: s.price, closes: s.closes, highs: [], lows: [], volumes: [] }]),
  );
  const macro = macroSignals((symbol) => macroBySymbol.get(symbol.toUpperCase()));

  // 각 거시 신호가 "언제 시세" 기준인지 붙인다 — 화면에 시간 기준을 밝히기 위해.
  const sparkTs = new Map(macroSpark.map((s) => [s.symbol.toUpperCase(), s.ts]));
  for (const m of macro) {
    const f = MACRO.find((x) => x.id === m.id);
    const ts = f ? sparkTs.get(f.symbol.toUpperCase()) : null;
    if (ts) m.asOf = ts;
  }

  // 1면 뉴스 보정을 거시 신호에 얹는다 (전파는 value + 0.4×impact 를 쓴다)
  if (mnews?.adjustments.length) {
    const byId = new Map(mnews.adjustments.map((a) => [a.id, a]));
    for (const m of macro) {
      const adj = byId.get(m.id);
      if (adj) {
        m.newsImpact = adj.impact;
        m.newsReason = adj.reasonKo;
      }
    }
  }

  const news: NewsItem[] = newsResult?.data.items ?? [];
  const bySymbol = new Map(priceSeries.map((s) => [s.symbol.toUpperCase(), s]));
  const riskOff = riskOffFrom(macro);

  // 시장 피드에서 섹터 키워드가 걸린 기사만 골라 섹터 감성을 만든다.
  // "코스피 하락" 같은 시장 일반 기사는 어느 섹터에도 안 걸려 자연히 빠진다.
  const sectorSent = new Map<SectorId, { score: number; hits: number }>();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS) as [SectorId, string[]][]) {
    const matched = news.filter((it) => {
      const hay = `${it.title} ${it.summary}`;
      return keywords.some((k) => hay.includes(k));
    });
    if (!matched.length) continue;
    const s = scoreText(matched.map((it) => `${it.title} ${it.summary}`));
    sectorSent.set(sector, { score: s.score, hits: matched.length });
  }

  const sparkBySymbol = new Map(extendedSpark.map((s) => [s.symbol.toUpperCase(), s]));

  const scores: TickerScore[] = [];
  for (const t of UNIVERSE) {
    let s: { price: number; changePct: number; closes: number[]; highs: number[]; lows: number[]; volumes: number[]; symbol: string } | undefined;
    if (t.core) {
      s = bySymbol.get(t.symbol.toUpperCase());
    } else {
      const sp = sparkBySymbol.get(t.symbol.toUpperCase());
      // 종가만 있는 시리즈 — ATR·거래량 신호는 자동으로 중립 폴백된다(shared/scoring.ts)
      if (sp) s = { ...sp, highs: [], lows: [], volumes: [], symbol: sp.symbol };
    }
    if (!s || s.closes.length < 30) continue;

    const onto = propagate(t, macro);
    const price = priceSignal(s);

    // 1) 종목 직접 뉴스 — 전용 검색 피드가 우선, 없으면 국가 피드에서 이름 매칭
    const tn = tickerNews[t.code];
    const fallback = scoreForTicker(news, [t.nameKo, ...t.aliases]);
    const direct = tn?.hits ? clamp(tn.score, -1, 1) : fallback.hits ? clamp(fallback.score, -1, 1) : 0;
    const directHits = tn?.hits || fallback.hits || 0;

    // 2) 섹터 경유 뉴스 — 소속 비중을 곱하고 0.4로 감쇠(간접 신호는 약하게)
    let sectorScore = 0;
    const sectorNotes: string[] = [];
    for (const [sector, weight] of Object.entries(t.sectors) as [SectorId, number][]) {
      const ss = sectorSent.get(sector);
      if (!ss) continue;
      sectorScore += weight * ss.score;
      if (Math.abs(ss.score) >= 0.05) {
        sectorNotes.push(`${sector} ${ss.hits}건 ${ss.score >= 0 ? "+" : ""}${round(ss.score, 2)}`);
      }
    }
    const newsScore = clamp(direct + 0.4 * clamp(sectorScore, -1, 1), -1, 1);

    const reasons = [...onto.reasons, ...price.reasons];
    if (directHits) {
      const top = tn?.headlines?.[0];
      reasons.push({
        kind: "news",
        text: `종목 기사 ${directHits}건 (긍정 ${tn?.positive ?? fallback.positive}·부정 ${tn?.negative ?? fallback.negative})${
          top ? ` — “${top.title.slice(0, 42)}”` : ""
        }`,
        contribution: round(direct * 0.2, 3),
      });
    }
    if (sectorNotes.length) {
      reasons.push({
        kind: "news",
        text: `섹터 기사 반영: ${sectorNotes.join(" · ")} (감쇠 0.4)`,
        contribution: round(clamp(sectorScore, -1, 1) * 0.4 * 0.2, 3),
      });
    }

    scores.push({
      code: t.code,
      symbol: s.symbol,
      nameKo: t.nameKo,
      price: s.price,
      changePct: s.changePct,
      score: round(composite(onto.score, price.score, newsScore), 3),
      ontologyScore: round(onto.score, 3),
      priceScore: round(price.score, 3),
      newsScore: round(newsScore, 3),
      volatility: round(price.volatility, 2),
      atr: round(price.atr, 1),
      reasons,
      edges: onto.edges.slice(0, 6),
    });
  }

  scores.sort((a, b) => b.score - a.score);

  const top = macro
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((m) => `${m.nameKo} ${m.changePct >= 0 ? "+" : ""}${m.changePct}%`)
    .join(", ");

  const dataAsOf =
    Math.max(0, ...macroSpark.map((s) => s.ts ?? 0), ...priceSeries.map((p) => p.time || 0)) || null;

  return {
    generatedAt: Date.now(),
    dataAsOf,
    macro,
    scores,
    riskOff,
    note: `거시 상위 변동: ${top || "없음"} · 위험회피 지수 ${riskOff}${mnews?.adjustments.length ? ` · 뉴스 보정 ${mnews.adjustments.length}건` : ""}`,
    macroNews: {
      provider: mnews?.provider ?? null,
      headlinesUsed: mnews?.headlinesUsed ?? 0,
      adjustments: mnews?.adjustments ?? [],
    },
  };
}

/** 지수 시세 한 건 (자동매매 상태 화면용) */
export async function kospiSnapshot(env: Env) {
  const s = await getSeries(env, "^KS11", "5d").catch(() => null);
  return s ? { price: s.price, changePct: s.changePct } : null;
}
