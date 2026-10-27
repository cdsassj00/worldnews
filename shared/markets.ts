/**
 * 국가별 시장 메타데이터.
 * - `index`: Yahoo Finance 지수 심볼(대표 1개 + 보조)
 * - `tickers`: 그 나라 대표 종목(추천 엔진의 유니버스)
 * - `kis`: 한국투자증권 주문 가능 시장 코드. 없으면 주문 미지원 시장.
 * - `news`: Google News RSS 로케일과 검색어
 *
 * 프론트엔드와 Worker가 함께 쓴다.
 */

export type KisMarket = "KRX" | "NAS" | "NYS" | "AMS" | "TSE" | "HKS" | "SHS" | "SZS";

export interface Ticker {
  /** Yahoo Finance 심볼 (시세 조회용) */
  symbol: string;
  /** 표시용 이름 */
  name: string;
  /** 뉴스 감성 매칭용 별칭(회사명 변형) */
  aliases?: string[];
  /** 한국투자증권 주문용 코드. 없으면 주문 불가(조회 전용) */
  kis?: { market: KisMarket; code: string };
}

export interface MarketInfo {
  /** ISO 3166-1 alpha-2 */
  cc: string;
  nameKo: string;
  /** 대표 지수 심볼(Yahoo). 신뢰 가능한 지수가 없는 시장은 비운다 → 지역 대표 지수로 대체 */
  index?: string;
  indexName?: string;
  /** 보조 지수 */
  index2?: string;
  index2Name?: string;
  currency: string;
  /** IANA timezone (장 시간 표시용) */
  tz: string;
  /** 정규장 (현지시간 HH:MM) */
  session?: [string, string];
  news: NewsLocale;
  tickers: Ticker[];
  /** 지수·종목이 현지 통화가 아닌 프록시(ETF 등)일 때 표시 */
  proxyNote?: string;
}

export interface NewsLocale {
  hl: string;
  gl: string;
  ceid: string;
  /** 현지어 금융 검색어 */
  query: string;
}

const L = (hl: string, gl: string, query: string): NewsLocale => ({
  hl,
  gl,
  ceid: `${gl}:${hl.split("-")[0]}`,
  query,
});

export const MARKETS: Record<string, MarketInfo> = {
  KR: {
    cc: "KR",
    nameKo: "대한민국",
    index: "^KS11",
    indexName: "KOSPI",
    index2: "^KQ11",
    index2Name: "KOSDAQ",
    currency: "KRW",
    tz: "Asia/Seoul",
    session: ["09:00", "15:30"],
    news: L("ko", "KR", "증시 OR 코스피 OR 금리 OR 환율"),
    tickers: [
      { symbol: "005930.KS", name: "삼성전자", aliases: ["삼성전자", "Samsung Electronics"], kis: { market: "KRX", code: "005930" } },
      { symbol: "000660.KS", name: "SK하이닉스", aliases: ["SK하이닉스", "SK Hynix"], kis: { market: "KRX", code: "000660" } },
      { symbol: "373220.KS", name: "LG에너지솔루션", aliases: ["LG에너지솔루션", "LG Energy"], kis: { market: "KRX", code: "373220" } },
      { symbol: "207940.KS", name: "삼성바이오로직스", aliases: ["삼성바이오로직스"], kis: { market: "KRX", code: "207940" } },
      { symbol: "005380.KS", name: "현대차", aliases: ["현대차", "현대자동차", "Hyundai Motor"], kis: { market: "KRX", code: "005380" } },
      { symbol: "035420.KS", name: "NAVER", aliases: ["네이버", "NAVER"], kis: { market: "KRX", code: "035420" } },
      { symbol: "105560.KS", name: "KB금융", aliases: ["KB금융", "국민은행"], kis: { market: "KRX", code: "105560" } },
      { symbol: "012450.KS", name: "한화에어로스페이스", aliases: ["한화에어로스페이스", "한화에어로"], kis: { market: "KRX", code: "012450" } },
      { symbol: "042660.KS", name: "한화오션", aliases: ["한화오션", "조선"], kis: { market: "KRX", code: "042660" } },
      { symbol: "068270.KS", name: "셀트리온", aliases: ["셀트리온"], kis: { market: "KRX", code: "068270" } },
    ],
  },
  US: {
    cc: "US",
    nameKo: "미국",
    index: "^GSPC",
    indexName: "S&P 500",
    index2: "^IXIC",
    index2Name: "NASDAQ",
    currency: "USD",
    tz: "America/New_York",
    session: ["09:30", "16:00"],
    news: L("en", "US", "stock market OR Federal Reserve OR earnings"),
    tickers: [
      { symbol: "NVDA", name: "NVIDIA", aliases: ["Nvidia", "엔비디아"], kis: { market: "NAS", code: "NVDA" } },
      { symbol: "AAPL", name: "Apple", aliases: ["Apple", "애플"], kis: { market: "NAS", code: "AAPL" } },
      { symbol: "MSFT", name: "Microsoft", aliases: ["Microsoft", "마이크로소프트"], kis: { market: "NAS", code: "MSFT" } },
      { symbol: "GOOGL", name: "Alphabet", aliases: ["Google", "Alphabet", "구글"], kis: { market: "NAS", code: "GOOGL" } },
      { symbol: "AMZN", name: "Amazon", aliases: ["Amazon", "아마존"], kis: { market: "NAS", code: "AMZN" } },
      { symbol: "META", name: "Meta", aliases: ["Meta", "Facebook", "메타"], kis: { market: "NAS", code: "META" } },
      { symbol: "TSLA", name: "Tesla", aliases: ["Tesla", "테슬라"], kis: { market: "NAS", code: "TSLA" } },
      { symbol: "JPM", name: "JPMorgan", aliases: ["JPMorgan", "JP모건"], kis: { market: "NYS", code: "JPM" } },
      { symbol: "XOM", name: "Exxon Mobil", aliases: ["Exxon", "엑슨모빌"], kis: { market: "NYS", code: "XOM" } },
      { symbol: "LLY", name: "Eli Lilly", aliases: ["Eli Lilly", "일라이릴리"], kis: { market: "NYS", code: "LLY" } },
    ],
  },
  JP: {
    cc: "JP",
    nameKo: "일본",
    index: "^N225",
    indexName: "Nikkei 225",
    currency: "JPY",
    tz: "Asia/Tokyo",
    session: ["09:00", "15:00"],
    news: L("ja", "JP", "株式市場 OR 日銀 OR 円相場"),
    tickers: [
      { symbol: "7203.T", name: "トヨタ自動車", aliases: ["Toyota", "토요타"], kis: { market: "TSE", code: "7203" } },
      { symbol: "6758.T", name: "ソニーグループ", aliases: ["Sony", "소니"], kis: { market: "TSE", code: "6758" } },
      { symbol: "8306.T", name: "三菱UFJ", aliases: ["Mitsubishi UFJ"], kis: { market: "TSE", code: "8306" } },
      { symbol: "9984.T", name: "ソフトバンクG", aliases: ["SoftBank", "소프트뱅크"], kis: { market: "TSE", code: "9984" } },
      { symbol: "6501.T", name: "日立製作所", aliases: ["Hitachi", "히타치"], kis: { market: "TSE", code: "6501" } },
      { symbol: "8035.T", name: "東京エレクトロン", aliases: ["Tokyo Electron"], kis: { market: "TSE", code: "8035" } },
    ],
  },
  CN: {
    cc: "CN",
    nameKo: "중국",
    index: "000001.SS",
    indexName: "상하이종합",
    index2: "399001.SZ",
    index2Name: "심천성분",
    currency: "CNY",
    tz: "Asia/Shanghai",
    session: ["09:30", "15:00"],
    news: L("zh-CN", "CN", "股市 OR 央行 OR 经济"),
    tickers: [
      { symbol: "600519.SS", name: "貴州茅台", aliases: ["Kweichow Moutai"], kis: { market: "SHS", code: "600519" } },
      { symbol: "601398.SS", name: "工商銀行", aliases: ["ICBC"], kis: { market: "SHS", code: "601398" } },
      { symbol: "300750.SZ", name: "寧德時代 CATL", aliases: ["CATL", "닝더스다이"], kis: { market: "SZS", code: "300750" } },
      { symbol: "000858.SZ", name: "五粮液", aliases: ["Wuliangye"], kis: { market: "SZS", code: "000858" } },
      { symbol: "601899.SS", name: "紫金鉱業", aliases: ["Zijin Mining"], kis: { market: "SHS", code: "601899" } },
    ],
  },
  HK: {
    cc: "HK",
    nameKo: "홍콩",
    index: "^HSI",
    indexName: "항셍지수",
    currency: "HKD",
    tz: "Asia/Hong_Kong",
    session: ["09:30", "16:00"],
    news: L("zh-HK", "HK", "股市 OR 恒指 OR 經濟"),
    tickers: [
      { symbol: "0700.HK", name: "騰訊 Tencent", aliases: ["Tencent", "텐센트"], kis: { market: "HKS", code: "00700" } },
      { symbol: "9988.HK", name: "阿里巴巴 Alibaba", aliases: ["Alibaba", "알리바바"], kis: { market: "HKS", code: "09988" } },
      { symbol: "0939.HK", name: "建設銀行", aliases: ["China Construction Bank"], kis: { market: "HKS", code: "00939" } },
      { symbol: "1299.HK", name: "友邦保険 AIA", aliases: ["AIA"], kis: { market: "HKS", code: "01299" } },
      { symbol: "3690.HK", name: "美団 Meituan", aliases: ["Meituan", "메이퇀"], kis: { market: "HKS", code: "03690" } },
    ],
  },
  TW: {
    cc: "TW",
    nameKo: "대만",
    index: "^TWII",
    indexName: "가권지수",
    currency: "TWD",
    tz: "Asia/Taipei",
    session: ["09:00", "13:30"],
    news: L("zh-TW", "TW", "股市 OR 台積電 OR 經濟"),
    tickers: [
      { symbol: "2330.TW", name: "台積電 TSMC", aliases: ["TSMC", "TSMC", "대만반도체"] },
      { symbol: "2317.TW", name: "鴻海 Foxconn", aliases: ["Foxconn", "폭스콘"] },
      { symbol: "2454.TW", name: "聯發科 MediaTek", aliases: ["MediaTek"] },
      { symbol: "2308.TW", name: "台達電 Delta", aliases: ["Delta Electronics"] },
    ],
  },
  IN: {
    cc: "IN",
    nameKo: "인도",
    index: "^BSESN",
    indexName: "SENSEX",
    index2: "^NSEI",
    index2Name: "NIFTY 50",
    currency: "INR",
    tz: "Asia/Kolkata",
    session: ["09:15", "15:30"],
    news: L("en-IN", "IN", "stock market OR RBI OR Sensex"),
    tickers: [
      { symbol: "RELIANCE.NS", name: "Reliance Industries", aliases: ["Reliance"] },
      { symbol: "TCS.NS", name: "Tata Consultancy", aliases: ["TCS", "Tata"] },
      { symbol: "HDFCBANK.NS", name: "HDFC Bank", aliases: ["HDFC"] },
      { symbol: "INFY.NS", name: "Infosys", aliases: ["Infosys"] },
      { symbol: "BHARTIARTL.NS", name: "Bharti Airtel", aliases: ["Airtel"] },
    ],
  },
  DE: {
    cc: "DE",
    nameKo: "독일",
    index: "^GDAXI",
    indexName: "DAX",
    currency: "EUR",
    tz: "Europe/Berlin",
    session: ["09:00", "17:30"],
    news: L("de", "DE", "Börse OR Aktien OR EZB OR Konjunktur"),
    tickers: [
      { symbol: "SAP.DE", name: "SAP", aliases: ["SAP"] },
      { symbol: "SIE.DE", name: "Siemens", aliases: ["Siemens", "지멘스"] },
      { symbol: "ALV.DE", name: "Allianz", aliases: ["Allianz"] },
      { symbol: "MBG.DE", name: "Mercedes-Benz", aliases: ["Mercedes"] },
      { symbol: "RHM.DE", name: "Rheinmetall", aliases: ["Rheinmetall"] },
    ],
  },
  FR: {
    cc: "FR",
    nameKo: "프랑스",
    index: "^FCHI",
    indexName: "CAC 40",
    currency: "EUR",
    tz: "Europe/Paris",
    session: ["09:00", "17:30"],
    news: L("fr", "FR", "Bourse OR actions OR BCE OR économie"),
    tickers: [
      { symbol: "MC.PA", name: "LVMH", aliases: ["LVMH"] },
      { symbol: "OR.PA", name: "L'Oréal", aliases: ["L'Oreal", "로레알"] },
      { symbol: "AIR.PA", name: "Airbus", aliases: ["Airbus", "에어버스"] },
      { symbol: "TTE.PA", name: "TotalEnergies", aliases: ["Total"] },
      { symbol: "SU.PA", name: "Schneider Electric", aliases: ["Schneider"] },
    ],
  },
  GB: {
    cc: "GB",
    nameKo: "영국",
    index: "^FTSE",
    indexName: "FTSE 100",
    currency: "GBP",
    tz: "Europe/London",
    session: ["08:00", "16:30"],
    news: L("en-GB", "GB", "stock market OR Bank of England OR FTSE"),
    tickers: [
      { symbol: "SHEL.L", name: "Shell", aliases: ["Shell"] },
      { symbol: "AZN.L", name: "AstraZeneca", aliases: ["AstraZeneca"] },
      { symbol: "HSBA.L", name: "HSBC", aliases: ["HSBC"] },
      { symbol: "ULVR.L", name: "Unilever", aliases: ["Unilever"] },
      { symbol: "RR.L", name: "Rolls-Royce", aliases: ["Rolls-Royce"] },
    ],
  },
  CA: {
    cc: "CA",
    nameKo: "캐나다",
    index: "^GSPTSE",
    indexName: "S&P/TSX",
    currency: "CAD",
    tz: "America/Toronto",
    session: ["09:30", "16:00"],
    news: L("en-CA", "CA", "stock market OR Bank of Canada OR TSX"),
    tickers: [
      { symbol: "RY.TO", name: "Royal Bank of Canada", aliases: ["RBC"] },
      { symbol: "TD.TO", name: "TD Bank", aliases: ["TD Bank"] },
      { symbol: "ENB.TO", name: "Enbridge", aliases: ["Enbridge"] },
      { symbol: "CNR.TO", name: "Canadian National Railway", aliases: ["CN Rail"] },
    ],
  },
  AU: {
    cc: "AU",
    nameKo: "호주",
    index: "^AXJO",
    indexName: "ASX 200",
    currency: "AUD",
    tz: "Australia/Sydney",
    session: ["10:00", "16:00"],
    news: L("en-AU", "AU", "stock market OR RBA OR ASX"),
    tickers: [
      { symbol: "BHP.AX", name: "BHP Group", aliases: ["BHP"] },
      { symbol: "CBA.AX", name: "Commonwealth Bank", aliases: ["Commonwealth Bank"] },
      { symbol: "CSL.AX", name: "CSL", aliases: ["CSL"] },
      { symbol: "FMG.AX", name: "Fortescue", aliases: ["Fortescue"] },
    ],
  },
  BR: {
    cc: "BR",
    nameKo: "브라질",
    index: "^BVSP",
    indexName: "Bovespa",
    currency: "BRL",
    tz: "America/Sao_Paulo",
    session: ["10:00", "17:00"],
    news: L("pt-BR", "BR", "bolsa OR ações OR Banco Central OR economia"),
    tickers: [
      { symbol: "PETR4.SA", name: "Petrobras", aliases: ["Petrobras"] },
      { symbol: "VALE3.SA", name: "Vale", aliases: ["Vale"] },
      { symbol: "ITUB4.SA", name: "Itaú Unibanco", aliases: ["Itau"] },
      { symbol: "BBAS3.SA", name: "Banco do Brasil", aliases: ["Banco do Brasil"] },
    ],
  },
  MX: {
    cc: "MX",
    nameKo: "멕시코",
    index: "^MXX",
    indexName: "IPC",
    currency: "MXN",
    tz: "America/Mexico_City",
    session: ["08:30", "15:00"],
    news: L("es-419", "MX", "bolsa OR acciones OR Banxico OR economía"),
    tickers: [
      { symbol: "WALMEX.MX", name: "Walmart de México", aliases: ["Walmex"] },
      { symbol: "GFNORTEO.MX", name: "Banorte", aliases: ["Banorte"] },
      { symbol: "AMXB.MX", name: "América Móvil", aliases: ["America Movil"] },
    ],
  },
  CH: {
    cc: "CH",
    nameKo: "스위스",
    index: "^SSMI",
    indexName: "SMI",
    currency: "CHF",
    tz: "Europe/Zurich",
    session: ["09:00", "17:30"],
    news: L("de-CH", "CH", "Börse OR Aktien OR SNB"),
    tickers: [
      { symbol: "NESN.SW", name: "Nestlé", aliases: ["Nestle"] },
      { symbol: "RO.SW", name: "Roche", aliases: ["Roche"] },
      { symbol: "NOVN.SW", name: "Novartis", aliases: ["Novartis"] },
      { symbol: "UBSG.SW", name: "UBS", aliases: ["UBS"] },
    ],
  },
  NL: {
    cc: "NL",
    nameKo: "네덜란드",
    index: "^AEX",
    indexName: "AEX",
    currency: "EUR",
    tz: "Europe/Amsterdam",
    session: ["09:00", "17:30"],
    news: L("nl", "NL", "beurs OR aandelen OR ECB OR economie"),
    tickers: [
      { symbol: "ASML.AS", name: "ASML", aliases: ["ASML"] },
      { symbol: "INGA.AS", name: "ING Groep", aliases: ["ING"] },
      { symbol: "AD.AS", name: "Ahold Delhaize", aliases: ["Ahold"] },
    ],
  },
  ES: {
    cc: "ES",
    nameKo: "스페인",
    index: "^IBEX",
    indexName: "IBEX 35",
    currency: "EUR",
    tz: "Europe/Madrid",
    session: ["09:00", "17:30"],
    news: L("es", "ES", "bolsa OR acciones OR BCE OR economía"),
    tickers: [
      { symbol: "SAN.MC", name: "Banco Santander", aliases: ["Santander"] },
      { symbol: "IBE.MC", name: "Iberdrola", aliases: ["Iberdrola"] },
      { symbol: "ITX.MC", name: "Inditex", aliases: ["Inditex", "Zara"] },
    ],
  },
  IT: {
    cc: "IT",
    nameKo: "이탈리아",
    index: "FTSEMIB.MI",
    indexName: "FTSE MIB",
    currency: "EUR",
    tz: "Europe/Rome",
    session: ["09:00", "17:30"],
    news: L("it", "IT", "borsa OR azioni OR BCE OR economia"),
    tickers: [
      { symbol: "ENI.MI", name: "Eni", aliases: ["Eni"] },
      { symbol: "ISP.MI", name: "Intesa Sanpaolo", aliases: ["Intesa"] },
      { symbol: "ENEL.MI", name: "Enel", aliases: ["Enel"] },
      { symbol: "UCG.MI", name: "UniCredit", aliases: ["UniCredit"] },
    ],
  },
  SE: {
    cc: "SE",
    nameKo: "스웨덴",
    index: "^OMX",
    indexName: "OMX Stockholm 30",
    currency: "SEK",
    tz: "Europe/Stockholm",
    session: ["09:00", "17:30"],
    news: L("sv", "SE", "börsen OR aktier OR Riksbanken"),
    tickers: [
      { symbol: "VOLV-B.ST", name: "Volvo", aliases: ["Volvo"] },
      { symbol: "ATCO-A.ST", name: "Atlas Copco", aliases: ["Atlas Copco"] },
      { symbol: "ERIC-B.ST", name: "Ericsson", aliases: ["Ericsson"] },
    ],
  },
  NO: {
    cc: "NO",
    nameKo: "노르웨이",
    index: "OSEBX.OL",
    indexName: "OSEBX",
    currency: "NOK",
    tz: "Europe/Oslo",
    session: ["09:00", "16:20"],
    news: L("no", "NO", "børs OR aksjer OR Norges Bank"),
    tickers: [
      { symbol: "EQNR.OL", name: "Equinor", aliases: ["Equinor"] },
      { symbol: "DNB.OL", name: "DNB Bank", aliases: ["DNB"] },
    ],
  },
  DK: {
    cc: "DK",
    nameKo: "덴마크",
    index: "^OMXC25",
    indexName: "OMX Copenhagen 25",
    currency: "DKK",
    tz: "Europe/Copenhagen",
    session: ["09:00", "17:00"],
    news: L("da", "DK", "børs OR aktier OR Nationalbanken"),
    tickers: [
      { symbol: "NOVO-B.CO", name: "Novo Nordisk", aliases: ["Novo Nordisk"] },
      { symbol: "MAERSK-B.CO", name: "Maersk", aliases: ["Maersk"] },
    ],
  },
  FI: {
    cc: "FI",
    nameKo: "핀란드",
    index: "^OMXH25",
    indexName: "OMX Helsinki 25",
    currency: "EUR",
    tz: "Europe/Helsinki",
    session: ["10:00", "18:30"],
    news: L("fi", "FI", "pörssi OR osakkeet OR talous"),
    tickers: [
      { symbol: "NOKIA.HE", name: "Nokia", aliases: ["Nokia"] },
      { symbol: "NESTE.HE", name: "Neste", aliases: ["Neste"] },
    ],
  },
  SG: {
    cc: "SG",
    nameKo: "싱가포르",
    index: "^STI",
    indexName: "Straits Times",
    currency: "SGD",
    tz: "Asia/Singapore",
    session: ["09:00", "17:00"],
    news: L("en-SG", "SG", "stock market OR MAS OR economy"),
    tickers: [
      { symbol: "D05.SI", name: "DBS Group", aliases: ["DBS"] },
      { symbol: "O39.SI", name: "OCBC", aliases: ["OCBC"] },
      { symbol: "Z74.SI", name: "Singtel", aliases: ["Singtel"] },
    ],
  },
  ID: {
    cc: "ID",
    nameKo: "인도네시아",
    index: "^JKSE",
    indexName: "IDX Composite",
    currency: "IDR",
    tz: "Asia/Jakarta",
    session: ["09:00", "15:50"],
    news: L("id", "ID", "saham OR bursa OR Bank Indonesia OR ekonomi"),
    tickers: [
      { symbol: "BBCA.JK", name: "Bank Central Asia", aliases: ["BCA"] },
      { symbol: "BBRI.JK", name: "Bank Rakyat Indonesia", aliases: ["BRI"] },
      { symbol: "TLKM.JK", name: "Telkom Indonesia", aliases: ["Telkom"] },
    ],
  },
  MY: {
    cc: "MY",
    nameKo: "말레이시아",
    index: "^KLSE",
    indexName: "FTSE Bursa Malaysia KLCI",
    currency: "MYR",
    tz: "Asia/Kuala_Lumpur",
    session: ["09:00", "17:00"],
    news: L("en-MY", "MY", "stock market OR Bursa Malaysia OR economy"),
    tickers: [
      { symbol: "1155.KL", name: "Maybank", aliases: ["Maybank"] },
      { symbol: "1023.KL", name: "CIMB Group", aliases: ["CIMB"] },
    ],
  },
  TH: {
    cc: "TH",
    nameKo: "태국",
    index: "^SET.BK",
    indexName: "SET Index",
    currency: "THB",
    tz: "Asia/Bangkok",
    session: ["10:00", "16:30"],
    news: L("th", "TH", "หุ้น OR ตลาดหลักทรัพย์ OR เศรษฐกิจ"),
    tickers: [
      { symbol: "PTT.BK", name: "PTT", aliases: ["PTT"] },
      { symbol: "AOT.BK", name: "Airports of Thailand", aliases: ["AOT"] },
    ],
  },
  VN: {
    cc: "VN",
    nameKo: "베트남",
    index: "VNM",
    indexName: "VanEck Vietnam ETF (VN 프록시)",
    currency: "VND",
    tz: "Asia/Ho_Chi_Minh",
    session: ["09:00", "15:00"],
    news: L("vi", "VN", "chứng khoán OR cổ phiếu OR kinh tế"),
    tickers: [
      { symbol: "VNM", name: "VanEck Vietnam ETF (프록시)", aliases: ["Vietnam"] },
    ],
    proxyNote: "베트남 개별종목 시세는 Yahoo 커버리지가 불안정해 ETF 프록시로 표시한다.",
  },
  PH: {
    cc: "PH",
    nameKo: "필리핀",
    index: "PSEI.PS",
    indexName: "PSEi",
    currency: "PHP",
    tz: "Asia/Manila",
    session: ["09:30", "15:30"],
    news: L("en-PH", "PH", "stock market OR BSP OR economy"),
    tickers: [],
    proxyNote: "필리핀 개별종목은 Yahoo가 시세를 제공하지 않아 지수·뉴스만 표시한다.",
  },
  SA: {
    cc: "SA",
    nameKo: "사우디아라비아",
    index: "^TASI.SR",
    indexName: "Tadawul All Share",
    currency: "SAR",
    tz: "Asia/Riyadh",
    session: ["10:00", "15:00"],
    news: L("ar", "SA", "الأسهم OR البورصة OR الاقتصاد"),
    tickers: [
      { symbol: "2222.SR", name: "Saudi Aramco", aliases: ["Aramco"] },
      { symbol: "1120.SR", name: "Al Rajhi Bank", aliases: ["Al Rajhi"] },
    ],
  },
  IL: {
    cc: "IL",
    nameKo: "이스라엘",
    index: "^TA125.TA",
    indexName: "TA-125",
    currency: "ILS",
    tz: "Asia/Jerusalem",
    session: ["09:59", "17:14"],
    news: L("he", "IL", "בורסה OR מניות OR כלכלה"),
    tickers: [
      { symbol: "TEVA.TA", name: "Teva Pharmaceutical", aliases: ["Teva"] },
      { symbol: "POLI.TA", name: "Bank Hapoalim", aliases: ["Hapoalim"] },
    ],
  },
  TR: {
    cc: "TR",
    nameKo: "튀르키예",
    index: "XU100.IS",
    indexName: "BIST 100",
    currency: "TRY",
    tz: "Europe/Istanbul",
    session: ["10:00", "18:00"],
    news: L("tr", "TR", "borsa OR hisse OR ekonomi OR Merkez Bankası"),
    tickers: [
      { symbol: "THYAO.IS", name: "Turkish Airlines", aliases: ["Turkish Airlines"] },
      { symbol: "ASELS.IS", name: "Aselsan", aliases: ["Aselsan"] },
    ],
  },
  ZA: {
    cc: "ZA",
    nameKo: "남아프리카공화국",
    index: "^J203.JO",
    indexName: "FTSE/JSE All Share",
    currency: "ZAR",
    tz: "Africa/Johannesburg",
    session: ["09:00", "17:00"],
    news: L("en-ZA", "ZA", "stock market OR JSE OR Reserve Bank"),
    tickers: [
      { symbol: "NPN.JO", name: "Naspers", aliases: ["Naspers"] },
      { symbol: "SOL.JO", name: "Sasol", aliases: ["Sasol"] },
    ],
  },
  PL: {
    cc: "PL",
    nameKo: "폴란드",
    index: "WIG20.WA",
    indexName: "WIG20",
    currency: "PLN",
    tz: "Europe/Warsaw",
    session: ["09:00", "17:00"],
    news: L("pl", "PL", "giełda OR akcje OR gospodarka OR NBP"),
    tickers: [
      { symbol: "PKN.WA", name: "Orlen", aliases: ["Orlen"] },
      { symbol: "PKO.WA", name: "PKO Bank Polski", aliases: ["PKO"] },
    ],
  },
  AT: {
    cc: "AT",
    nameKo: "오스트리아",
    index: "^ATX",
    indexName: "ATX",
    currency: "EUR",
    tz: "Europe/Vienna",
    session: ["09:00", "17:30"],
    news: L("de-AT", "AT", "Börse OR Aktien OR Wirtschaft"),
    tickers: [
      { symbol: "OMV.VI", name: "OMV", aliases: ["OMV"] },
      { symbol: "EBS.VI", name: "Erste Group", aliases: ["Erste Group"] },
    ],
  },
  BE: {
    cc: "BE",
    nameKo: "벨기에",
    index: "^BFX",
    indexName: "BEL 20",
    currency: "EUR",
    tz: "Europe/Brussels",
    session: ["09:00", "17:30"],
    news: L("nl-BE", "BE", "beurs OR aandelen OR economie"),
    tickers: [
      { symbol: "ABI.BR", name: "AB InBev", aliases: ["AB InBev"] },
      { symbol: "KBC.BR", name: "KBC Group", aliases: ["KBC"] },
    ],
  },
  PT: {
    cc: "PT",
    nameKo: "포르투갈",
    index: "PSI20.LS",
    indexName: "PSI",
    currency: "EUR",
    tz: "Europe/Lisbon",
    session: ["08:00", "16:30"],
    news: L("pt-PT", "PT", "bolsa OR ações OR economia"),
    tickers: [
      { symbol: "EDP.LS", name: "EDP", aliases: ["EDP"] },
      { symbol: "GALP.LS", name: "Galp Energia", aliases: ["Galp"] },
    ],
  },
  GR: {
    cc: "GR",
    nameKo: "그리스",
    index: "GD.AT",
    indexName: "Athens General",
    currency: "EUR",
    tz: "Europe/Athens",
    session: ["10:15", "17:20"],
    news: L("el", "GR", "χρηματιστήριο OR μετοχές OR οικονομία"),
    tickers: [
      { symbol: "ETE.AT", name: "National Bank of Greece", aliases: ["National Bank of Greece"] },
      { symbol: "ALPHA.AT", name: "Alpha Bank", aliases: ["Alpha Bank"] },
    ],
  },
  NZ: {
    cc: "NZ",
    nameKo: "뉴질랜드",
    index: "^NZ50",
    indexName: "NZX 50",
    currency: "NZD",
    tz: "Pacific/Auckland",
    session: ["10:00", "16:45"],
    news: L("en-NZ", "NZ", "stock market OR RBNZ OR economy"),
    tickers: [
      { symbol: "AIR.NZ", name: "Air New Zealand", aliases: ["Air New Zealand"] },
      { symbol: "SPK.NZ", name: "Spark New Zealand", aliases: ["Spark"] },
    ],
  },
  AR: {
    cc: "AR",
    nameKo: "아르헨티나",
    index: "^MERV",
    indexName: "MERVAL",
    currency: "ARS",
    tz: "America/Argentina/Buenos_Aires",
    session: ["11:00", "17:00"],
    news: L("es-419", "AR", "bolsa OR acciones OR economía OR BCRA"),
    tickers: [
      { symbol: "GGAL.BA", name: "Grupo Galicia", aliases: ["Galicia"] },
      { symbol: "YPFD.BA", name: "YPF", aliases: ["YPF"] },
    ],
  },
  CL: {
    cc: "CL",
    nameKo: "칠레",
    index: "^IPSA",
    indexName: "IPSA",
    currency: "CLP",
    tz: "America/Santiago",
    session: ["09:30", "16:00"],
    news: L("es-419", "CL", "bolsa OR acciones OR economía"),
    tickers: [{ symbol: "SQM-B.SN", name: "SQM", aliases: ["SQM"] }],
  },
  AE: {
    cc: "AE",
    nameKo: "아랍에미리트",
    currency: "AED",
    tz: "Asia/Dubai",
    session: ["10:00", "15:00"],
    news: L("en-AE", "AE", "stock market OR economy OR ADX OR DFM"),
    tickers: [{ symbol: "EMAAR.AE", name: "Emaar Properties", aliases: ["Emaar"] }],
    proxyNote: "UAE 대표지수는 공개 시세가 없어 지역 지수로 대체 표시한다.",
  },
  EG: {
    cc: "EG",
    nameKo: "이집트",
    index: "^CASE30",
    indexName: "EGX 30",
    currency: "EGP",
    tz: "Africa/Cairo",
    session: ["10:00", "14:30"],
    news: L("ar-EG", "EG", "البورصة OR الأسهم OR الاقتصاد"),
    tickers: [],
  },
  RU: {
    cc: "RU",
    nameKo: "러시아",
    index: "IMOEX.ME",
    indexName: "MOEX",
    currency: "RUB",
    tz: "Europe/Moscow",
    session: ["10:00", "18:40"],
    news: L("ru", "RU", "акции OR биржа OR экономика OR ЦБ"),
    tickers: [],
    proxyNote: "제재 영향으로 시세·주문 데이터가 제한된다. 뉴스 중심으로 본다.",
  },
};

/** 지수 데이터가 없는 국가에 붙일 지역 대표 지수 */
export const REGION_FALLBACK: Record<string, { index: string; indexName: string }> = {
  EU: { index: "^STOXX50E", indexName: "Euro Stoxx 50" },
  AS: { index: "^HSI", indexName: "항셍지수(아시아 대표)" },
  AF: { index: "^J203.JO", indexName: "JSE All Share(아프리카 대표)" },
  NA: { index: "^GSPC", indexName: "S&P 500(북미 대표)" },
  SA_REGION: { index: "^BVSP", indexName: "Bovespa(남미 대표)" },
  OC: { index: "^AXJO", indexName: "ASX 200(오세아니아 대표)" },
  WORLD: { index: "^GSPC", indexName: "S&P 500(글로벌)" },
};

/** 글로벌 헤더 티커테이프에 항상 띄우는 심볼 */
export const GLOBAL_TAPE: { symbol: string; label: string }[] = [
  { symbol: "^KS11", label: "KOSPI" },
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^N225", label: "NIKKEI" },
  { symbol: "^HSI", label: "HSI" },
  { symbol: "^GDAXI", label: "DAX" },
  { symbol: "KRW=X", label: "USD/KRW" },
  { symbol: "CL=F", label: "WTI" },
  { symbol: "GC=F", label: "GOLD" },
  { symbol: "BTC-USD", label: "BTC" },
  { symbol: "^TNX", label: "US10Y" },
];

export function marketFor(cc: string): MarketInfo | undefined {
  return MARKETS[cc.toUpperCase()];
}
