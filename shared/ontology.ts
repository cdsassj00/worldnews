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
  | "건설"
  | "증권"
  | "보험"
  | "해운"
  | "게임엔터"
  | "전력설비";

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
  증권: { KOSPI: 0.75, VIX: -0.5, US10Y: 0.1 },
  보험: { US10Y: 0.6, KOSPI: 0.3, VIX: -0.2 },
  해운: { CHINA: 0.5, KOSPI: 0.3, OIL: -0.25, USDKRW: 0.3 },
  게임엔터: { US10Y: -0.45, KOSPI: 0.4, VIX: -0.4, USDKRW: 0.25, CHINA: 0.3 },
  전력설비: { KOSPI: 0.4, US10Y: -0.15, USDKRW: 0.35, CHINA: 0.2 },
};

/**
 * 인과관계 유형 — 간선이 "숫자"가 아니라 "의미"를 갖게 하는 층.
 * 민감도(SENSITIVITY)의 각 값이 왜 그 부호·크기인지, 어떤 경제적 경로로
 * 전파되는지를 유형과 문장으로 명시한다. 점수 계산은 바꾸지 않는다 —
 * 가중치를 바꾸면 백테스트를 다시 통과해야 하므로, 의미층은 설명·추론용으로 얹는다.
 */
export type RelKind =
  | "원가" // 투입 비용 경로 (예: 유가 → 항공 유류비)
  | "수요" // 최종 수요 경로 (예: 중국 경기 → 철강 수요)
  | "환율" // 환산·채산성 경로 (예: 원화 약세 → 수출 대금 원화 환산 증가)
  | "할인율" // 밸류에이션 경로 (예: 금리 상승 → 미래 이익의 현재가치 하락)
  | "마진" // 이익률 경로 (예: 금리 상승 → 은행 예대마진 확대)
  | "수주" // 발주·계약 경로 (예: 고유가 → 해양플랜트 발주)
  | "위험선호" // 자금 흐름 경로 (예: VIX 급등 → 외국인 순매도)
  | "업황" // 산업 사이클 동행 (예: 반도체지수 → 반도체 실적)
  | "안전자산"; // 방어 자금 이동 (예: 위험회피 → 배당·유틸리티)

export interface CausalRelation {
  rel: RelKind;
  /** 메커니즘 — 민감도 부호가 왜 그 부호인지 한 문장으로 */
  ko: string;
}

const 베타: CausalRelation = { rel: "위험선호", ko: "국내 증시 전반의 자금 유출입에 동행합니다(시장 베타)" };
const 고밸류: CausalRelation = { rel: "위험선호", ko: "고밸류에이션 성장주라 위험회피 국면에서 낙폭이 큽니다" };

/** SENSITIVITY 의 0 아닌 간선마다 하나씩 — 전파 경로의 경제적 의미 */
export const RELATIONS: Record<SectorId, Partial<Record<MacroId, CausalRelation>>> = {
  반도체: {
    SEMI: { rel: "업황", ko: "필라델피아 반도체지수는 글로벌 메모리·파운드리 수요의 선행 지표 — 업황이 곧 실적입니다" },
    USDKRW: { rel: "환율", ko: "매출 대부분이 달러라 원화 약세는 원화 환산 이익을 키웁니다" },
    KOSPI: { rel: "위험선호", ko: "코스피 시총 최상위라 시장 자금 유출입을 가장 크게 받습니다" },
    US10Y: { rel: "할인율", ko: "금리 상승은 미래 이익의 현재가치를 깎아 밸류에이션에 부담입니다" },
    VIX: { rel: "위험선호", ko: "변동성 급등 시 외국인이 유동성 큰 대형 기술주부터 팝니다" },
  },
  "2차전지": {
    US10Y: { rel: "할인율", ko: "이익이 먼 미래에 있는 성장주라 금리 상승이 밸류에이션을 깎습니다" },
    CHINA: { rel: "수요", ko: "중국 전기차 시장과 소재 밸류체인이 수요·가격을 좌우합니다" },
    KOSPI: 베타,
    OIL: { rel: "수요", ko: "고유가는 내연기관 대비 전기차 전환 유인을 키웁니다" },
    VIX: 고밸류,
  },
  자동차: {
    USDKRW: { rel: "환율", ko: "수출 채산성 — 원화 약세면 달러 판매대금의 원화 환산액이 늘어납니다" },
    OIL: { rel: "수요", ko: "기름값 상승은 차량 운행 비용을 올려 구매 심리에 부담입니다" },
    US10Y: { rel: "수요", ko: "금리 상승은 할부 금융 비용을 올려 판매를 위축시킵니다" },
    KOSPI: 베타,
    VIX: { rel: "위험선호", ko: "경기민감 수출주라 위험회피 국면에서 먼저 팔립니다" },
  },
  바이오: {
    US10Y: { rel: "할인율", ko: "신약 이익이 가장 먼 미래에 있는 업종이라 금리에 제일 민감합니다" },
    KOSPI: 베타,
    VIX: 고밸류,
  },
  금융: {
    US10Y: { rel: "마진", ko: "금리가 오르면 예대마진(NIM)이 벌어져 이자 이익이 늘어납니다" },
    KOSPI: { rel: "업황", ko: "시장 활황은 대출·수수료·운용 수익 전반에 우호적입니다" },
    VIX: { rel: "위험선호", ko: "위험회피 심화는 연체·건전성 우려로 이어집니다" },
  },
  정유화학: {
    OIL: { rel: "마진", ko: "유가 상승 국면엔 재고평가이익과 제품가 전가로 정제마진이 개선됩니다" },
    CHINA: { rel: "수요", ko: "최대 수출처인 중국의 화학제품 수요가 가동률을 좌우합니다" },
    USDKRW: { rel: "원가", ko: "원유 수입대금이 달러라 원화 약세는 원가 부담입니다" },
    KOSPI: 베타,
  },
  조선: {
    OIL: { rel: "수주", ko: "고유가는 해양플랜트·LNG선 발주를 자극합니다" },
    USDKRW: { rel: "환율", ko: "수주 대금이 달러라 원화 약세가 채산성을 높입니다" },
    CHINA: { rel: "수요", ko: "글로벌 물동량 기대가 신조선 발주로 이어집니다" },
    KOSPI: 베타,
  },
  방산: {
    VIX: { rel: "수주", ko: "지정학 불안(변동성 상승)이 곧 무기 수요 환경입니다" },
    OIL: { rel: "수주", ko: "고유가는 산유국 재정을 키워 무기 구매 여력을 늘립니다" },
    KOSPI: 베타,
    US10Y: { rel: "할인율", ko: "장기 수주 산업이라 금리 상승이 소폭 부담입니다" },
  },
  인터넷: {
    US10Y: { rel: "할인율", ko: "광고·커머스 성장 기대가 밸류에이션의 핵심이라 금리에 민감합니다" },
    KOSPI: 베타,
    VIX: 고밸류,
  },
  철강: {
    CHINA: { rel: "수요", ko: "중국 부동산·인프라가 세계 철강 수요와 가격을 좌우합니다" },
    OIL: { rel: "수요", ko: "에너지·자원 경기와 동행하는 소재 업종입니다" },
    KOSPI: 베타,
  },
  항공: {
    OIL: { rel: "원가", ko: "유류비가 영업비용의 약 30% — 유가가 이익을 직접 좌우합니다" },
    USDKRW: { rel: "원가", ko: "항공기 리스료·유류비가 달러 결제이고, 원화 약세는 해외여행 수요도 위축시킵니다" },
    KOSPI: 베타,
  },
  유통소비: {
    USDKRW: { rel: "원가", ko: "원화 약세는 수입 물가를 올려 소비 여력을 갉아먹습니다" },
    CHINA: { rel: "수요", ko: "중국 관광객·역직구 수요가 면세·화장품 매출을 좌우합니다" },
    KOSPI: 베타,
  },
  통신유틸: {
    US10Y: { rel: "할인율", ko: "배당 매력이 금리와 경쟁하는 방어주입니다" },
    VIX: { rel: "안전자산", ko: "위험회피 국면에 방어주로 자금이 이동합니다" },
    KOSPI: 베타,
    OIL: { rel: "원가", ko: "발전 연료비 상승이 마진을 압박합니다" },
  },
  건설: {
    US10Y: { rel: "수요", ko: "금리 상승은 부동산 PF와 분양 시장을 얼립니다" },
    KOSPI: 베타,
    OIL: { rel: "원가", ko: "자재·물류비 상승이 원가를 압박합니다" },
  },
  증권: {
    KOSPI: { rel: "업황", ko: "거래대금·브로커리지 수익이 시장과 그대로 동행합니다" },
    VIX: { rel: "위험선호", ko: "변동성 급등은 거래 위축과 운용 손실로 이어집니다" },
    US10Y: { rel: "마진", ko: "금리 상승은 채권 운용엔 부담이나 예탁금 이자엔 소폭 우호입니다" },
  },
  보험: {
    US10Y: { rel: "마진", ko: "금리가 오르면 자산운용 수익률이 개선되고 부채 부담이 줄어듭니다" },
    KOSPI: 베타,
    VIX: { rel: "위험선호", ko: "보유 자산 평가손 우려가 커집니다" },
  },
  해운: {
    CHINA: { rel: "수요", ko: "중국발 물동량이 컨테이너·벌크 운임을 좌우합니다" },
    KOSPI: 베타,
    OIL: { rel: "원가", ko: "연료비(벙커유)가 원가의 큰 몫입니다" },
    USDKRW: { rel: "환율", ko: "운임이 달러 결제라 원화 약세가 환산 이익을 키웁니다" },
  },
  게임엔터: {
    US10Y: { rel: "할인율", ko: "신작·콘텐츠 기대가 밸류에이션의 핵심이라 금리에 민감합니다" },
    KOSPI: 베타,
    VIX: 고밸류,
    USDKRW: { rel: "환율", ko: "해외 매출 비중이 높아 원화 약세가 환산 이익을 키웁니다" },
    CHINA: { rel: "수요", ko: "판호 발급·중국 매출 기대가 실적 변수입니다" },
  },
  전력설비: {
    KOSPI: 베타,
    US10Y: { rel: "수요", ko: "금리는 대규모 전력망 투자 비용을 좌우합니다" },
    USDKRW: { rel: "환율", ko: "미국 전력망·변압기 수출 비중이 높아 원화 약세가 우호적입니다" },
    CHINA: { rel: "수요", ko: "글로벌 설비투자 사이클과 동행합니다" },
  },
};

/**
 * 거시요인 사이의 인과 — 그래프 위층 안에서도 힘이 흐른다는 것을 설명하는 층.
 * 점수 전파에는 쓰지 않는다(이중 계상 방지). 화면 설명용.
 */
export const MACRO_LINKS: { from: MacroId; to: MacroId; ko: string }[] = [
  { from: "OIL", to: "USDKRW", ko: "유가 상승은 수입물가·무역수지를 악화시켜 원화 약세 요인이 됩니다" },
  { from: "US10Y", to: "VIX", ko: "급격한 금리 상승은 위험자산 전반의 변동성을 키웁니다" },
  { from: "VIX", to: "KOSPI", ko: "위험회피가 심해지면 외국인 순매도로 코스피에 하락 압력이 걸립니다" },
  { from: "CHINA", to: "KOSPI", ko: "최대 교역국 경기라 국내 수출주 실적 기대를 좌우합니다" },
  { from: "SEMI", to: "KOSPI", ko: "반도체가 코스피 시총의 약 1/4 — 업황이 지수를 끌고 다닙니다" },
  { from: "US10Y", to: "GOLD", ko: "금리 상승은 무이자 자산인 금의 기회비용을 키웁니다" },
];

/**
 * 섹터별 뉴스 매칭 키워드.
 * "삼성전자"라는 글자가 없어도 "반도체株 방어 기대" 같은 기사가 반도체 섹터를 거쳐
 * 소속 종목에 (비중×0.4 로 감쇠되어) 반영되게 한다. 시장 일반 기사("코스피 하락")는
 * 어떤 키워드에도 걸리지 않으므로 자연히 배제된다 — 그게 의도다.
 * 주의: "은행" 단독은 "한국은행"에 걸리므로 넣지 않는다.
 */
export const SECTOR_KEYWORDS: Record<SectorId, string[]> = {
  반도체: ["반도체", "메모리", "D램", "HBM", "낸드", "파운드리"],
  "2차전지": ["2차전지", "이차전지", "배터리", "양극재", "전고체"],
  자동차: ["완성차", "전기차", "자동차주", "자동차 판매"],
  바이오: ["바이오", "제약", "신약", "임상"],
  금융: ["금융주", "은행주", "금융지주", "시중은행", "실적주"],
  정유화학: ["정유", "석유화학", "화학주", "나프타", "정제마진"],
  조선: ["조선주", "조선업", "수주잔고", "선박 수주", "LNG선"],
  방산: ["방산", "방위산업", "수출 계약"],
  인터넷: ["플랫폼주", "포털", "인터넷주", "커머스"],
  철강: ["철강", "제철", "철강주", "후판"],
  항공: ["항공주", "항공사", "여객 수요", "국제선"],
  유통소비: ["유통주", "소비재", "면세", "리오프닝"],
  통신유틸: ["통신주", "전력요금", "전기요금", "한전"],
  건설: ["건설주", "건설업", "분양", "부동산 PF", "재건축"],
  증권: ["증권주", "증권사", "거래대금", "브로커리지"],
  보험: ["보험주", "손해보험", "생명보험", "보험사"],
  해운: ["해운", "운임", "컨테이너선", "벌크선"],
  게임엔터: ["게임주", "신작", "엔터주", "K팝", "음반", "콘텐츠"],
  전력설비: ["전력기기", "변압기", "전력망", "원전", "데이터센터"],
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
  /**
   * 코어 종목: 일봉 OHLCV 전체(거래량·ATR 포함)로 점수를 매기고 자동매매 주문 대상이 된다.
   * 나머지(확장)는 종가 배치 조회로 분석·표시만 한다 — 데이터 품질이 낮은 종목에 돈을 태우지 않는다.
   */
  core?: boolean;
}

/**
 * 유니버스 — 국내(KRX·KOSDAQ) 약 80종목.
 *
 * 국내만 다룬다. 해외 주문 TR_ID는 아직 실계좌로 검증되지 않았고,
 * 검증 안 된 경로에 실제 돈을 태우지 않는다.
 *
 * 두 층으로 나뉜다:
 *  - core(20): OHLCV 전체 조회, 종목 전용 뉴스 수집, 자동매매 주문 대상
 *  - 확장(~58): 종가 배치(spark) 조회로 온톨로지 전파·분석·화면 표시
 * fetch 한도(50/요청)와 KV 쓰기 예산 때문에 확장층은 배치로만 다룬다.
 */
export const UNIVERSE: UniverseTicker[] = [
  { code: "005930", symbol: "005930.KS", nameKo: "삼성전자", sectors: { 반도체: 1}, aliases: ["삼성전자", "삼전"], core: true },
  { code: "000660", symbol: "000660.KS", nameKo: "SK하이닉스", sectors: { 반도체: 1}, aliases: ["SK하이닉스", "하이닉스"], core: true },
  { code: "042700", symbol: "042700.KS", nameKo: "한미반도체", sectors: { 반도체: 1}, aliases: ["한미반도체"], core: true },
  { code: "373220", symbol: "373220.KS", nameKo: "LG에너지솔루션", sectors: { "2차전지": 1}, aliases: ["LG에너지솔루션", "엘지엔솔", "LG엔솔"], core: true },
  { code: "006400", symbol: "006400.KS", nameKo: "삼성SDI", sectors: { "2차전지": 1}, aliases: ["삼성SDI"], core: true },
  { code: "005380", symbol: "005380.KS", nameKo: "현대차", sectors: { 자동차: 1}, aliases: ["현대차", "현대자동차"], core: true },
  { code: "000270", symbol: "000270.KS", nameKo: "기아", sectors: { 자동차: 1}, aliases: ["기아"], core: true },
  { code: "207940", symbol: "207940.KS", nameKo: "삼성바이오로직스", sectors: { 바이오: 1}, aliases: ["삼성바이오로직스", "삼바"], core: true },
  { code: "068270", symbol: "068270.KS", nameKo: "셀트리온", sectors: { 바이오: 1}, aliases: ["셀트리온"], core: true },
  { code: "105560", symbol: "105560.KS", nameKo: "KB금융", sectors: { 금융: 1}, aliases: ["KB금융", "국민은행", "KB금융지주"], core: true },
  { code: "055550", symbol: "055550.KS", nameKo: "신한지주", sectors: { 금융: 1}, aliases: ["신한지주", "신한금융"], core: true },
  { code: "010950", symbol: "010950.KS", nameKo: "S-Oil", sectors: { 정유화학: 1}, aliases: ["S-Oil", "에쓰오일", "S오일"], core: true },
  { code: "051910", symbol: "051910.KS", nameKo: "LG화학", sectors: { 정유화학: 0.6, "2차전지": 0.4}, aliases: ["LG화학"], core: true },
  { code: "009540", symbol: "009540.KS", nameKo: "HD한국조선해양", sectors: { 조선: 1}, aliases: ["HD한국조선해양", "한국조선해양", "HD현대"], core: true },
  { code: "042660", symbol: "042660.KS", nameKo: "한화오션", sectors: { 조선: 1}, aliases: ["한화오션"], core: true },
  { code: "012450", symbol: "012450.KS", nameKo: "한화에어로스페이스", sectors: { 방산: 1}, aliases: ["한화에어로스페이스", "한화에어로"], core: true },
  { code: "035420", symbol: "035420.KS", nameKo: "NAVER", sectors: { 인터넷: 1}, aliases: ["네이버", "NAVER"], core: true },
  { code: "005490", symbol: "005490.KS", nameKo: "POSCO홀딩스", sectors: { 철강: 1}, aliases: ["POSCO홀딩스", "포스코", "POSCO"], core: true },
  { code: "003490", symbol: "003490.KS", nameKo: "대한항공", sectors: { 항공: 1}, aliases: ["대한항공"], core: true },
  { code: "015760", symbol: "015760.KS", nameKo: "한국전력", sectors: { 통신유틸: 1}, aliases: ["한국전력", "한전"], core: true },

  /* ── 확장 유니버스 (spark 배치 조회 · 분석 전용) ── */
  // 금융 확장
  { code: "086790", symbol: "086790.KS", nameKo: "하나금융지주", sectors: { 금융: 1 }, aliases: ["하나금융", "하나은행"] },
  { code: "316140", symbol: "316140.KS", nameKo: "우리금융지주", sectors: { 금융: 1 }, aliases: ["우리금융", "우리은행"] },
  { code: "323410", symbol: "323410.KS", nameKo: "카카오뱅크", sectors: { 금융: 0.7, 인터넷: 0.3 }, aliases: ["카카오뱅크", "카뱅"] },
  { code: "006800", symbol: "006800.KS", nameKo: "미래에셋증권", sectors: { 증권: 1 }, aliases: ["미래에셋증권", "미래에셋"] },
  { code: "071050", symbol: "071050.KS", nameKo: "한국금융지주", sectors: { 증권: 1 }, aliases: ["한국금융지주", "한국투자증권"] },
  { code: "039490", symbol: "039490.KS", nameKo: "키움증권", sectors: { 증권: 1 }, aliases: ["키움증권", "키움"] },
  { code: "138040", symbol: "138040.KS", nameKo: "메리츠금융지주", sectors: { 금융: 0.5, 보험: 0.5 }, aliases: ["메리츠금융", "메리츠"] },
  { code: "032830", symbol: "032830.KS", nameKo: "삼성생명", sectors: { 보험: 1 }, aliases: ["삼성생명"] },
  { code: "000810", symbol: "000810.KS", nameKo: "삼성화재", sectors: { 보험: 1 }, aliases: ["삼성화재"] },
  { code: "005830", symbol: "005830.KS", nameKo: "DB손해보험", sectors: { 보험: 1 }, aliases: ["DB손해보험", "DB손보"] },
  // 반도체·전자부품 확장
  { code: "009150", symbol: "009150.KS", nameKo: "삼성전기", sectors: { 반도체: 0.6, 자동차: 0.4 }, aliases: ["삼성전기"] },
  { code: "011070", symbol: "011070.KS", nameKo: "LG이노텍", sectors: { 반도체: 0.6, 자동차: 0.4 }, aliases: ["LG이노텍"] },
  { code: "000990", symbol: "000990.KS", nameKo: "DB하이텍", sectors: { 반도체: 1 }, aliases: ["DB하이텍"] },
  { code: "058470", symbol: "058470.KQ", nameKo: "리노공업", sectors: { 반도체: 1 }, aliases: ["리노공업"] },
  { code: "402340", symbol: "402340.KS", nameKo: "SK스퀘어", sectors: { 반도체: 0.7, 인터넷: 0.3 }, aliases: ["SK스퀘어"] },
  // 2차전지·화학 확장
  { code: "003670", symbol: "003670.KS", nameKo: "포스코퓨처엠", sectors: { "2차전지": 0.8, 철강: 0.2 }, aliases: ["포스코퓨처엠"] },
  { code: "247540", symbol: "247540.KQ", nameKo: "에코프로비엠", sectors: { "2차전지": 1 }, aliases: ["에코프로비엠"] },
  { code: "086520", symbol: "086520.KQ", nameKo: "에코프로", sectors: { "2차전지": 1 }, aliases: ["에코프로"] },
  { code: "096770", symbol: "096770.KS", nameKo: "SK이노베이션", sectors: { 정유화학: 0.5, "2차전지": 0.5 }, aliases: ["SK이노베이션", "SK이노"] },
  { code: "011170", symbol: "011170.KS", nameKo: "롯데케미칼", sectors: { 정유화학: 1 }, aliases: ["롯데케미칼", "롯데켐"] },
  { code: "011780", symbol: "011780.KS", nameKo: "금호석유", sectors: { 정유화학: 1 }, aliases: ["금호석유", "금호석유화학"] },
  // 자동차 부품
  { code: "012330", symbol: "012330.KS", nameKo: "현대모비스", sectors: { 자동차: 1 }, aliases: ["현대모비스", "모비스"] },
  { code: "018880", symbol: "018880.KS", nameKo: "한온시스템", sectors: { 자동차: 1 }, aliases: ["한온시스템"] },
  { code: "204320", symbol: "204320.KS", nameKo: "HL만도", sectors: { 자동차: 1 }, aliases: ["HL만도", "만도"] },
  // 바이오·제약 확장
  { code: "326030", symbol: "326030.KS", nameKo: "SK바이오팜", sectors: { 바이오: 1 }, aliases: ["SK바이오팜"] },
  { code: "000100", symbol: "000100.KS", nameKo: "유한양행", sectors: { 바이오: 1 }, aliases: ["유한양행"] },
  { code: "128940", symbol: "128940.KS", nameKo: "한미약품", sectors: { 바이오: 1 }, aliases: ["한미약품"] },
  { code: "196170", symbol: "196170.KQ", nameKo: "알테오젠", sectors: { 바이오: 1 }, aliases: ["알테오젠"] },
  // 인터넷·게임·엔터
  { code: "035720", symbol: "035720.KS", nameKo: "카카오", sectors: { 인터넷: 1 }, aliases: ["카카오"] },
  { code: "259960", symbol: "259960.KS", nameKo: "크래프톤", sectors: { 게임엔터: 1 }, aliases: ["크래프톤", "배틀그라운드"] },
  { code: "036570", symbol: "036570.KS", nameKo: "엔씨소프트", sectors: { 게임엔터: 1 }, aliases: ["엔씨소프트", "엔씨"] },
  { code: "251270", symbol: "251270.KS", nameKo: "넷마블", sectors: { 게임엔터: 1 }, aliases: ["넷마블"] },
  { code: "263750", symbol: "263750.KQ", nameKo: "펄어비스", sectors: { 게임엔터: 1 }, aliases: ["펄어비스"] },
  { code: "352820", symbol: "352820.KS", nameKo: "하이브", sectors: { 게임엔터: 1 }, aliases: ["하이브", "BTS"] },
  { code: "035900", symbol: "035900.KQ", nameKo: "JYP엔터", sectors: { 게임엔터: 1 }, aliases: ["JYP", "JYP엔터테인먼트"] },
  { code: "041510", symbol: "041510.KQ", nameKo: "에스엠", sectors: { 게임엔터: 1 }, aliases: ["에스엠", "SM엔터"] },
  // 조선·방산·기계 확장
  { code: "329180", symbol: "329180.KS", nameKo: "HD현대중공업", sectors: { 조선: 0.8, 방산: 0.2 }, aliases: ["HD현대중공업", "현대중공업"] },
  { code: "010140", symbol: "010140.KS", nameKo: "삼성중공업", sectors: { 조선: 1 }, aliases: ["삼성중공업"] },
  { code: "272210", symbol: "272210.KS", nameKo: "한화시스템", sectors: { 방산: 1 }, aliases: ["한화시스템"] },
  { code: "079550", symbol: "079550.KS", nameKo: "LIG넥스원", sectors: { 방산: 1 }, aliases: ["LIG넥스원"] },
  { code: "064350", symbol: "064350.KS", nameKo: "현대로템", sectors: { 방산: 0.7, 전력설비: 0.3 }, aliases: ["현대로템"] },
  { code: "103140", symbol: "103140.KS", nameKo: "풍산", sectors: { 방산: 0.6, 철강: 0.4 }, aliases: ["풍산"] },
  // 전력설비
  { code: "034020", symbol: "034020.KS", nameKo: "두산에너빌리티", sectors: { 전력설비: 1 }, aliases: ["두산에너빌리티", "두산에너"] },
  { code: "267260", symbol: "267260.KS", nameKo: "HD현대일렉트릭", sectors: { 전력설비: 1 }, aliases: ["HD현대일렉트릭", "현대일렉트릭"] },
  { code: "010120", symbol: "010120.KS", nameKo: "LS일렉트릭", sectors: { 전력설비: 1 }, aliases: ["LS일렉트릭", "LS ELECTRIC"] },
  { code: "298040", symbol: "298040.KS", nameKo: "효성중공업", sectors: { 전력설비: 0.7, 건설: 0.3 }, aliases: ["효성중공업"] },
  { code: "052690", symbol: "052690.KS", nameKo: "한전기술", sectors: { 전력설비: 1 }, aliases: ["한전기술"] },
  // 철강·소재 확장
  { code: "004020", symbol: "004020.KS", nameKo: "현대제철", sectors: { 철강: 1 }, aliases: ["현대제철"] },
  { code: "010130", symbol: "010130.KS", nameKo: "고려아연", sectors: { 철강: 1 }, aliases: ["고려아연"] },
  // 해운·운송
  { code: "011200", symbol: "011200.KS", nameKo: "HMM", sectors: { 해운: 1 }, aliases: ["HMM", "현대상선"] },
  { code: "028670", symbol: "028670.KS", nameKo: "팬오션", sectors: { 해운: 1 }, aliases: ["팬오션"] },
  { code: "086280", symbol: "086280.KS", nameKo: "현대글로비스", sectors: { 해운: 0.5, 자동차: 0.5 }, aliases: ["현대글로비스", "글로비스"] },
  { code: "000120", symbol: "000120.KS", nameKo: "CJ대한통운", sectors: { 유통소비: 0.6, 해운: 0.4 }, aliases: ["CJ대한통운", "대한통운"] },
  // 항공 확장
  { code: "089590", symbol: "089590.KS", nameKo: "제주항공", sectors: { 항공: 1 }, aliases: ["제주항공"] },
  // 유통·소비 확장
  { code: "090430", symbol: "090430.KS", nameKo: "아모레퍼시픽", sectors: { 유통소비: 1 }, aliases: ["아모레퍼시픽", "아모레"] },
  { code: "051900", symbol: "051900.KS", nameKo: "LG생활건강", sectors: { 유통소비: 1 }, aliases: ["LG생활건강", "LG생건"] },
  { code: "004170", symbol: "004170.KS", nameKo: "신세계", sectors: { 유통소비: 1 }, aliases: ["신세계"] },
  { code: "139480", symbol: "139480.KS", nameKo: "이마트", sectors: { 유통소비: 1 }, aliases: ["이마트"] },
  { code: "097950", symbol: "097950.KS", nameKo: "CJ제일제당", sectors: { 유통소비: 1 }, aliases: ["CJ제일제당"] },
  { code: "033780", symbol: "033780.KS", nameKo: "KT&G", sectors: { 유통소비: 1 }, aliases: ["KT&G", "케이티앤지"] },
  { code: "008770", symbol: "008770.KS", nameKo: "호텔신라", sectors: { 유통소비: 1 }, aliases: ["호텔신라", "신라면세점"] },
  // 통신 확장
  { code: "030200", symbol: "030200.KS", nameKo: "KT", sectors: { 통신유틸: 1 }, aliases: ["KT", "케이티"] },
  { code: "017670", symbol: "017670.KS", nameKo: "SK텔레콤", sectors: { 통신유틸: 1 }, aliases: ["SK텔레콤", "SKT"] },
  { code: "032640", symbol: "032640.KS", nameKo: "LG유플러스", sectors: { 통신유틸: 1 }, aliases: ["LG유플러스", "LG유플"] },
  // 건설 확장
  { code: "000720", symbol: "000720.KS", nameKo: "현대건설", sectors: { 건설: 1 }, aliases: ["현대건설"] },
  { code: "006360", symbol: "006360.KS", nameKo: "GS건설", sectors: { 건설: 1 }, aliases: ["GS건설"] },
  { code: "375500", symbol: "375500.KS", nameKo: "DL이앤씨", sectors: { 건설: 1 }, aliases: ["DL이앤씨"] },
  // 전자·복합
  { code: "066570", symbol: "066570.KS", nameKo: "LG전자", sectors: { 유통소비: 0.6, 자동차: 0.4 }, aliases: ["LG전자"] },
  { code: "028260", symbol: "028260.KS", nameKo: "삼성물산", sectors: { 건설: 0.5, 유통소비: 0.5 }, aliases: ["삼성물산"] },
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
