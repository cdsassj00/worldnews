/**
 * 엔진 합의 — "근거가 다른 분석 방식이 같은 종목에서 만난다"를 한 곳에서만 계산한다.
 *
 * 2026-09-04 유튜브 파이프라인 요청 3번: 이 계산을 파이프라인이 각자 하면 사이트 화면과
 * 영상이 다른 숫자를 말할 위험이 있다("같은 숫자는 한 곳에서만 나와야 한다"). daily-brief
 * API 의 engines[]/agreement 와 scene.svg?view=consensus 가 이 모듈 하나를 함께 쓴다.
 */
import { backtestResults } from "./backtest";
import { symbolFor } from "./symbols";
import { round } from "../shared/scoring";

type BriefMarket = "KR" | "US";

interface LabStrategy {
  id: string; nameKo: string; tagKo: string; descKo: string; liveNow: boolean; pnlPct: number;
  picks: { code: string; name: string; sector: string | null; score: number; price: number; changePct: number; reasons: string[] }[];
}

export interface EngineOut {
  id: string; nameKo: string; tagKo: string; descKo: string;
  /** 다른 엔진들의 조합인가 — agreement 의 independentCount 에서 빠진다.
   * "융합"은 descKo 부터가 온톨로지+수급이라, 그 둘이 고른 종목을 융합이 또 고르는 건
   * 세 번째 의견이 아니라 같은 근거를 두 번 세는 것이다(2026-09-04 요청 3번 지적). */
  derived: boolean;
  live: boolean;
  leaguePnlPct: number;
  horizonDays: number | null;
  horizonNote: string | null;
  picks: { code: string; ticker: string | null; symbol: string | null; name: string; sector: string | null; score: number; price: number; priceLabel: string; changePct: number; reasons: string[] }[];
}

export interface AgreementRow {
  code: string; symbol: string | null; name: string; sector: string | null;
  independentCount: number;
  engines: { id: string; nameKo: string; derived: boolean; reason: string }[];
  inHeadlineList: boolean;
}

/** 엔진별 실측 평균 보유일 — 백테스트에서 얻은 값만 쓴다(추정 금지). [3개월,6개월,1년] 중 1년이 대표값. */
export function holdDaysFor(market: BriefMarket, engineId: string): { days: number; note: string } | null {
  const bt = backtestResults() as {
    engineComparison?: { engines: { id: string; KR: { holdDaysAvg?: number[] }; US: { holdDaysAvg?: number[] } }[] };
  } | null;
  const e = bt?.engineComparison?.engines.find((x) => x.id === engineId);
  const h = market === "KR" ? e?.KR.holdDaysAvg : e?.US.holdDaysAvg;
  if (!h || h.length < 3) return null;
  return {
    days: h[2],
    note: `이 엔진의 최근 1년 백테스트 평균 보유 ${h[2]}일(3개월 ${h[0]}일·6개월 ${h[1]}일) — 실측값이며 종목별 예측이 아닙니다`,
  };
}

export function buildEnginesAndAgreement(
  market: BriefMarket,
  strategies: LabStrategy[] | undefined,
  headlineCodes: Set<string>,
  cur: string,
): { engines: EngineOut[]; agreement: AgreementRow[] } {
  const engines: EngineOut[] = (strategies ?? []).map((st) => {
    const h = holdDaysFor(market, st.id);
    return {
      id: st.id,
      nameKo: st.nameKo,
      tagKo: st.tagKo,
      descKo: st.descKo,
      derived: st.id === "fusion",
      live: st.liveNow,
      leaguePnlPct: st.pnlPct,
      horizonDays: h?.days ?? null,
      horizonNote: h?.note ?? null,
      picks: st.picks.map((p) => ({
        code: p.code,
        ticker: market === "US" ? p.code : null,
        symbol: symbolFor(p.code),
        name: p.name,
        sector: p.sector ?? null,
        score: p.score,
        price: p.price,
        priceLabel: `${p.price.toLocaleString("ko-KR")}${cur}`,
        changePct: p.changePct,
        reasons: p.reasons,
      })),
    };
  });

  const agreementMap = new Map<string, { code: string; name: string; sector: string | null; hits: { id: string; nameKo: string; derived: boolean; reason: string; score: number; leaguePnlPct: number }[] }>();
  for (const e of engines) {
    for (const p of e.picks) {
      const cur2 = agreementMap.get(p.code) ?? { code: p.code, name: p.name, sector: p.sector, hits: [] };
      cur2.hits.push({ id: e.id, nameKo: e.nameKo, derived: e.derived, reason: p.reasons[0] ?? "", score: p.score, leaguePnlPct: e.leaguePnlPct });
      agreementMap.set(p.code, cur2);
    }
  }
  // 정렬: ① independentCount 내림차순 ② 기여(파생 제외) 엔진들의 리그 누적수익률 합 ③ 최고 점수.
  const agreement = [...agreementMap.values()]
    .filter((x) => x.hits.length >= 2)
    .map((x) => {
      const independentCount = x.hits.filter((h) => !h.derived).length;
      const pnlSum = round(x.hits.filter((h) => !h.derived).reduce((s, h) => s + h.leaguePnlPct, 0), 2);
      const bestScore = Math.max(...x.hits.map((h) => h.score));
      return {
        code: x.code, symbol: symbolFor(x.code), name: x.name, sector: x.sector,
        independentCount,
        engines: x.hits.map((h) => ({ id: h.id, nameKo: h.nameKo, derived: h.derived, reason: h.reason })),
        inHeadlineList: headlineCodes.has(x.code),
        _sortPnl: pnlSum, _sortScore: bestScore,
      };
    })
    .sort((a, b) => b.independentCount - a.independentCount || b._sortPnl - a._sortPnl || b._sortScore - a._sortScore)
    .map(({ _sortPnl, _sortScore, ...rest }) => rest);

  return { engines, agreement };
}
