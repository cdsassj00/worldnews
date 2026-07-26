/**
 * 금융 온톨로지.
 *
 * "나라의 금융정보를 온톨로지처럼 분석한다"는 요구를 코드로 옮긴 것.
 * 지식 그래프를 세 층으로 둔다.
 *
 *   거시요인(MacroFactor) ──민감도──▶ 섹터(Sector) ──소속──▶ 종목(Ticker)
 *
 * 관측된 거시 신호(유가·환율·금리·반도체업황·변동성 등)를 그래프로 전파해
 * 종목별 "거시 점수"를 만들고, 왜 그 점수가 나왔는지 경로를 그대로 설명한다.
 * 블랙박스가 아니라 추적 가능한 추론이어야 매매 판단에 쓸 수 있다.
 */

export type MacroId =
  | "OIL" // 유가 (WTI)
  | "USDKRW" // 원/달러 환율 (상승 = 원화 약세)
  | "US10Y" // 미 국채 10년 금리
  | "SEMI" // 반도체 업황 (필라델피아 반도체지수)
  | "KOSPI" // 국내 시장 전반
  | "CHINA" // 중국 경기 (상해종합)
  | "VIX" // 변동성 (공포지수)
  | "GOLD"; // 금 (안전자산 선호)

export interface MacroFactor {
  id: MacroId;
  nameKo: string;
  /** 관측용 Yahoo 심볼 */
  symbol: string;
  /** 이 폭(%)이면 신호 세기 1.0으로 본다 (5일 변화율 기준) */
  scale: number;
  /** 값이 오르는 것이 시장에 통상 어떤 의미인지 (설명 문구용) */
  upMeansKo: string;
}

export const MACRO: MacroFactor[] = [
  { id: "OIL", nameKo: "유가(WTI)", symbol: "CL=F", scale: 6, upMeansKo: "원가 상승·에너지주 수혜" },
  { id: "USDKRW", nameKo: "원/달러", symbol: "KRW=X", scale: 2.5, upMeansKo: "원화 약세·수출주 수혜" },
  { id: "US10Y", nameKo: "미 10년 금리", symbol: "^TNX", scale: 6, upMeansKo: "금융주 수혜·성장주 부담" },
  { id: "SEMI", nameKo: "반도체 업황", symbol: "^SOX", scale: 6, upMeansKo: "반도체 밸류체인 수혜" },
  { id: "KOSPI", nameKo: "코스피", symbol: "^KS11", scale: 4, upMeansKo: "국내 위험선호 개선" },
  { id: "CHINA", nameKo: "중국 증시", symbol: "000001.SS", scale: 4, upMeansKo: "중국 수요 회복" },
  { id: "VIX", nameKo: "변동성(VIX)", symbol: "^VIX", scale: 25, upMeansKo: "위험회피 심화" },
  { id: "GOLD", nameKo: "금", symbol: "GC=F", scale: 4, upMeansKo: "안전자산 선호" },
];

export type SectorId =
  | "반도체"
  | "2차전지"
  | "자동차"
  | "바이오"
  | "금융"
  | "정유화학"
  | "조선"
  | "방산"
  | "인터넷"
  | "철강"
  | "항공"
  | "유통소비"
  | "통신유틸"
  | "건설";

/**
 * 섹터별 거시 민감도. -1 ~ +1.
 * 예) 유가가 오르면 정유화학은 +0.65, 항공은 -0.75.
 * 값은 국내 시장의 통상적인 반응을 보수적으로 반영한 것이며, 실측이 아니라 가정이다.
 */
export const SENSITIVITY: Record<SectorId, Partial<Record<MacroId, number>>> = {
  반도체: { SEMI: 0.95, USDKRW: 0.45, KOSPI: 0.6, US10Y: -0.2, VIX: -0.5 },
  "2차전지": { US10Y: -0.5, CHINA: 0.35, KOSPI: 0.5, OIL: 0.2, VIX: -0.55 },
  자동차: { USDKRW: 0.6, OIL: -0.25, US10Y: -0.15, KOSPI: 0.45, VIX: -0.4 },
  바이오: { US10Y: -0.65, KOSPI: 0.3, VIX: -0.45 },
  금융: { US10Y: 0.6, KOSPI: 0.45, VIX: -0.3 },
  정유화학: { OIL: 0.65, CHINA: 0.35, USDKRW: -0.2, KOSPI: 0.35 },
  조선: { OIL: 0.35, USDKRW: 0.45, CHINA: 0.25, KOSPI: 0.35 },
  방산: { VIX: 0.25, OIL: 0.2, KOSPI: 0.25, US10Y: -0.1 },
  인터넷: { US10Y: -0.55, KOSPI: 0.5, VIX: -0.45 },
  철강: { CHINA: 0.6, OIL: 0.2, KOSPI: 0.35 },
  항공: { OIL: -0.75, USDKRW: -0.6, KOSPI: 0.3 },
  유통소비: { USDKRW: -0.35, CHINA: 0.4, KOSPI: 0.35 },
  통신유틸: { US10Y: -0.25, VIX: 0.2, KOSPI: 0.15, OIL: -0.2 },
  건설: { US10Y: -0.5, KOSPI: 0.3, OIL: -0.15 },
};

export interface UniverseTicker {
  /** 한국투자증권 주문용 종목코드 */
  code: string;
  /** Yahoo Finance 심볼 (시세·차트) */
  symbol: string;
  nameKo: string;
  /** 섹터 소속 비중 (합 1.0) */
  sectors: Partial<Record<SectorId, number>>;
  /** 뉴스 매칭용 별칭 */
  aliases: string[];
}

/**
 * 자동매매 유니버스 — 국내 대형·중형 20종목.
 *
 * 국내(KRX)만 다룬다. 해외 주문 TR_ID는 아직 실계좌로 검증되지 않았고,
 * 검증 안 된 경로에 실제 돈을 태우지 않는다.
 * 20종목으로 제한한 이유는 Workers 의 요청당 서브리퀘스트 한도 때문이기도 하다.
 */
export const UNIVERSE: UniverseTicker[] = [
  { code: "005930", symbol: "005930.KS", nameKo: "삼성전자", sectors: { 반도체: 1 }, aliases: ["삼성전자"] },
  { code: "000660", symbol: "000660.KS", nameKo: "SK하이닉스", sectors: { 반도체: 1 }, aliases: ["SK하이닉스", "하이닉스"] },
  { code: "042700", symbol: "042700.KS", nameKo: "한미반도체", sectors: { 반도체: 1 }, aliases: ["한미반도체"] },
  { code: "373220", symbol: "373220.KS", nameKo: "LG에너지솔루션", sectors: { "2차전지": 1 }, aliases: ["LG에너지솔루션", "엘지엔솔"] },
  { code: "006400", symbol: "006400.KS", nameKo: "삼성SDI", sectors: { "2차전지": 1 }, aliases: ["삼성SDI"] },
  { code: "005380", symbol: "005380.KS", nameKo: "현대차", sectors: { 자동차: 1 }, aliases: ["현대차", "현대자동차"] },
  { code: "000270", symbol: "000270.KS", nameKo: "기아", sectors: { 자동차: 1 }, aliases: ["기아"] },
  { code: "207940", symbol: "207940.KS", nameKo: "삼성바이오로직스", sectors: { 바이오: 1 }, aliases: ["삼성바이오로직스"] },
  { code: "068270", symbol: "068270.KS", nameKo: "셀트리온", sectors: { 바이오: 1 }, aliases: ["셀트리온"] },
  { code: "105560", symbol: "105560.KS", nameKo: "KB금융", sectors: { 금융: 1 }, aliases: ["KB금융", "국민은행"] },
  { code: "055550", symbol: "055550.KS", nameKo: "신한지주", sectors: { 금융: 1 }, aliases: ["신한지주", "신한금융"] },
  { code: "010950", symbol: "010950.KS", nameKo: "S-Oil", sectors: { 정유화학: 1 }, aliases: ["S-Oil", "에쓰오일"] },
  { code: "051910", symbol: "051910.KS", nameKo: "LG화학", sectors: { 정유화학: 0.6, "2차전지": 0.4 }, aliases: ["LG화학"] },
  { code: "009540", symbol: "009540.KS", nameKo: "HD한국조선해양", sectors: { 조선: 1 }, aliases: ["HD한국조선해양", "한국조선해양"] },
  { code: "042660", symbol: "042660.KS", nameKo: "한화오션", sectors: { 조선: 1 }, aliases: ["한화오션"] },
  { code: "012450", symbol: "012450.KS", nameKo: "한화에어로스페이스", sectors: { 방산: 1 }, aliases: ["한화에어로스페이스", "한화에어로"] },
  { code: "035420", symbol: "035420.KS", nameKo: "NAVER", sectors: { 인터넷: 1 }, aliases: ["네이버", "NAVER"] },
  { code: "005490", symbol: "005490.KS", nameKo: "POSCO홀딩스", sectors: { 철강: 1 }, aliases: ["POSCO", "포스코"] },
  { code: "003490", symbol: "003490.KS", nameKo: "대한항공", sectors: { 항공: 1 }, aliases: ["대한항공"] },
  { code: "015760", symbol: "015760.KS", nameKo: "한국전력", sectors: { 통신유틸: 1 }, aliases: ["한국전력", "한전"] },
];

/** KRX 호가 단위 (2023 개편 기준) */
export function tickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** 호가 단위에 맞춰 내림/올림 */
export function roundToTick(price: number, dir: "up" | "down"): number {
  const t = tickSize(price);
  return dir === "up" ? Math.ceil(price / t) * t : Math.floor(price / t) * t;
}
