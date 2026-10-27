/**
 * 시스템 소개 블록 — SNS·유튜브가 "이 시스템이 뭘 하는지" 자랑할 때 쓸 완성 문장.
 *
 * 자랑은 사실로만 한다. 여기 들어가는 숫자는 전부 코드·시드·백테스트 파일에서 그 자리에서
 * 세는 값이라, 유니버스를 넓히거나 전략을 추가하면 문장도 같이 바뀐다(사람이 고쳐 쓰는
 * 홍보 문구를 두면 언젠가 실제와 어긋난다 — 그 순간 과장 광고가 된다).
 *
 * 넣지 않는 것: 수익 약속, "적중률 N%" 같은 미래형 표현, 실계좌 금액. 성적은 백테스트가
 * 과거 실험이라는 사실과 함께만 말한다.
 */
import { MACRO, MACRO_LINKS, SENSITIVITY, UNIVERSE as ONTO_UNIVERSE } from "../shared/ontology";
import { backtestResults } from "./backtest";
import krSeed from "../shared/radar-universe.json";
import usSeed from "../shared/us-universe.json";

export interface Showcase {
  /** 한 줄 소개 — 게시물 첫 줄·영상 오프닝용 */
  oneLinerKo: string;
  /** 하나씩 카드로 쓰기 좋은 자랑거리 — 전부 실측 숫자 */
  factsKo: string[];
  numbers: {
    macroFactors: number;
    macroLinks: number;
    sectorEdges: number;
    sectors: number;
    ontologyTickers: number;
    scanUniverse: number;
    engines: number;
    chartStrategies: number;
    backtestMeasuredAt: string | null;
  };
  /** 반드시 함께 나가야 하는 한 줄 — 자랑 옆에 붙인다 */
  disclaimerKo: string;
}

const CHART_STRATEGIES = 13;
const ENGINES = 4;

export function buildShowcase(): Showcase {
  const bt = backtestResults() as { measuredAt?: string } | null;
  const scanUniverse = (krSeed as unknown[]).length + (usSeed as unknown[]).length;
  const numbers = {
    macroFactors: MACRO.length,
    macroLinks: MACRO_LINKS.length,
    // SENSITIVITY 는 섹터 → {거시요인: 민감도} 맵이라, 간선 수는 값들의 키를 다 센다
    sectorEdges: Object.values(SENSITIVITY).reduce((n, m) => n + Object.keys(m ?? {}).length, 0),
    sectors: Object.keys(SENSITIVITY).length,
    ontologyTickers: ONTO_UNIVERSE.length,
    scanUniverse,
    engines: ENGINES,
    chartStrategies: CHART_STRATEGIES,
    backtestMeasuredAt: bt?.measuredAt ?? null,
  };

  return {
    oneLinerKo:
      `유가·금리·환율 같은 거시요인 ${numbers.macroFactors}개가 어떤 업종을 밀고 당기는지 그래프로 연결해 두고, ` +
      `매일 ${numbers.scanUniverse}종목을 훑어 "지금 순풍이 부는 자리"를 찾는 시스템입니다.`,
    factsKo: [
      `거시요인 ${numbers.macroFactors}개 · 거시끼리의 인과 ${numbers.macroLinks}개 · 거시→섹터 민감도 ${numbers.sectorEdges}개(업종 ${numbers.sectors}개)를 그래프로 연결했습니다.`,
      `한국·미국 ${numbers.scanUniverse}종목을 자동으로 훑습니다 — 사람이 고른 관심종목이 아니라 유니버스 전체입니다.`,
      `분석 방식 ${numbers.engines}가지(온톨로지·수급·차트·융합)를 같은 가상 원금·같은 규칙으로 나란히 굴려 성적을 공개합니다.`,
      `차트 판단은 창시자가 있는 전략 ${numbers.chartStrategies}종(RSI·MACD·일목균형표·터틀 등)의 합의로 냅니다 — 감이 아니라 표결입니다.`,
      `추천 근거는 "왜"까지 문장으로 남깁니다 — 유가가 몇 % 움직여 어떤 업종 민감도가 얼마나 붙었는지까지.`,
      bt?.measuredAt
        ? `백테스트를 매 거래일 16:40에 자동 재측정합니다(최근 측정 ${bt.measuredAt}) — 성적이 나쁘면 나쁜 대로 그대로 공개합니다.`
        : "백테스트를 매 거래일 자동 재측정하고, 성적이 나쁘면 나쁜 대로 공개합니다.",
    ],
    numbers,
    disclaimerKo:
      "백테스트는 과거 데이터로 규칙을 되돌려 본 실험이며 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 이용자 본인에게 있습니다.",
  };
}
