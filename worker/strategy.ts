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
import { MACRO, UNIVERSE } from "../shared/ontology";
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
import { getManySeries, getSeries } from "./quotes";
import { getNews, type NewsItem } from "./news";
import { scoreForTicker } from "./sentiment";

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
  macro: MacroSignal[];
  scores: TickerScore[];
  /** 시장 전반 위험도 (VIX·지수 기반). 1에 가까울수록 위험회피 */
  riskOff: number;
  note: string;
}

export async function runStrategy(env: Env): Promise<StrategyResult> {
  const [macroSeries, priceSeries, newsResult] = await Promise.all([
    getManySeries(env, MACRO.map((m) => m.symbol), "3mo"),
    getManySeries(env, UNIVERSE.map((t) => t.symbol), "6mo"),
    getNews(env, "KR", "대한민국").catch(() => null),
  ]);

  const macroBySymbol = new Map(macroSeries.map((s) => [s.symbol.toUpperCase(), s]));
  const macro = macroSignals((symbol) => macroBySymbol.get(symbol.toUpperCase()));

  const news: NewsItem[] = newsResult?.data.items ?? [];
  const bySymbol = new Map(priceSeries.map((s) => [s.symbol.toUpperCase(), s]));
  const riskOff = riskOffFrom(macro);

  const scores: TickerScore[] = [];
  for (const t of UNIVERSE) {
    const s = bySymbol.get(t.symbol.toUpperCase());
    if (!s || s.closes.length < 30) continue;

    const onto = propagate(t, macro);
    const price = priceSignal(s);
    const sent = scoreForTicker(news, [t.nameKo, ...t.aliases]);
    const newsScore = sent.hits ? clamp(sent.score, -1, 1) : 0;

    const reasons = [...onto.reasons, ...price.reasons];
    if (sent.hits) {
      reasons.push({
        kind: "news",
        text: `관련 기사 ${sent.hits}건 (긍정 ${sent.positive}·부정 ${sent.negative})`,
        contribution: round(newsScore * 0.2, 3),
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

  return {
    generatedAt: Date.now(),
    macro,
    scores,
    riskOff,
    note: `거시 상위 변동: ${top || "없음"} · 위험회피 지수 ${riskOff}`,
  };
}

/** 지수 시세 한 건 (자동매매 상태 화면용) */
export async function kospiSnapshot(env: Env) {
  const s = await getSeries(env, "^KS11", "5d").catch(() => null);
  return s ? { price: s.price, changePct: s.changePct } : null;
}
