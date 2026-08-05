/** Worker API 클라이언트 + 거래 암호 보관(세션 스토리지) */

export interface Snapshot {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  currency: string;
  marketState: string;
  sparkline?: number[];
}

export interface KisStatus {
  /** 현재 계좌 모드에서 해외주식 주문·잔고가 가능한지 */
  overseasEnabled: boolean;
  overseasReason: string;
  configured: boolean;
  tradeTokenSet: boolean;
  env: "vts" | "prod";
  envKo: string;
  ordersEnabled: boolean;
  realOrdersAllowed: boolean;
  maxOrderNotionalKrw: number;
  /** true 면 서버가 주문을 전송하지 않고 검증만 한다 */
  dryRun: boolean;
  transport: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: "gemini" | "anthropic" | "workers-ai" | null;
  model: string | null;
  reason: string;
}

export interface AnalysisResult {
  cc: string;
  provider: "gemini" | "anthropic" | "workers-ai";
  model: string;
  generatedAt: number;
  summary: string[];
  picks: { name: string; symbol: string; stance: string; reason: string }[];
  risks: string[];
  checklist: string[];
  disclaimer: string;
}

export interface ConfigResponse {
  kis: KisStatus;
  ai: AiStatus;
  markets: {
    cc: string;
    nameKo: string;
    indexName: string | null;
    tickers: number;
    /** KIS 주문 코드가 등록된 종목 수 */
    orderable: number;
    /** 지금 계좌 모드에서 실제로 주문이 나갈 수 있는 종목 수 */
    orderableNow: number;
  }[];
  disclaimer: string;
}

export interface ProviderStat {
  provider: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  lang: "ko" | "local";
  summary: string;
}

export interface Overview {
  cc: string;
  nameKo: string;
  hasLocalMarket: boolean;
  regionNote: string | null;
  proxyNote: string | null;
  currency: string | null;
  fxToKrw: number | null;
  session: { open: boolean; localTime: string; label: string } | null;
  tz: string | null;
  indices: Snapshot[];
  tickerCount: number;
  orderableCount: number;
  disclaimer: string;
}

export interface Factor {
  key: string;
  label: string;
  value: number;
  weight: number;
  text: string;
}

export interface Recommendation {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  changePct: number;
  score: number;
  action: "BUY" | "ACCUMULATE" | "WATCH" | "REDUCE" | "SELL";
  actionKo: string;
  confidence: number;
  factors: Factor[];
  plan: {
    entry: number;
    stop: number;
    target: number;
    riskPerShare: number;
    rewardPerShare: number;
    rr: number;
    stopPct: number;
    targetPct: number;
  };
  atr: number;
  orderable: boolean;
  kis?: { market: string; code: string };
  newsHits: number;
}

export interface RecommendResponse {
  cc: string;
  generatedAt?: number;
  marketBias?: { score: number; text: string };
  items: Recommendation[];
  universe?: number;
  unsupported?: boolean;
  reason?: string;
  disclaimer: string;
}

export interface Holding {
  symbol: string;
  name: string;
  qty: number;
  avgPrice: number;
  price: number;
  evalAmount: number;
  pnl: number;
  pnlPct: number;
  currency: string;
}

export interface BalanceResponse {
  market: string;
  isPaper: boolean;
  holdings: Holding[];
  summary: {
    cash: number;
    orderableCash: number;
    totalEval: number;
    stockEval: number;
    pnl: number;
    currency: string;
  };
}

export interface OrderResponse {
  ok: true;
  dryRun?: boolean;
  isPaper: boolean;
  market: string;
  code: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  orderNo: string;
  orgNo: string;
  orderTime: string;
  message: string;
  trId: string;
  notionalKrw: number;
  currency: string;
}

/* ── 자동매매 ─────────────────────────────── */

export interface AutoConfigView {
  enabled: boolean;
  capitalKrw: number;
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  dailyLossHaltPct: number;
  maxDrawdownPct: number;
  targetProfitKrw: number;
  maxTradesPerDay: number;
  maxOrdersPerCycle: number;
  maxOrderNotionalKrw: number;
  minOrderKrw: number;
  maxPositions: number;
}

export interface MacroSignal {
  id: string;
  nameKo: string;
  changePct: number;
  value: number;
  price: number;
  upMeansKo: string;
  /** 1면 뉴스 AI 보정 (-1~1) */
  newsImpact?: number;
  newsReason?: string;
  /** 이 신호가 딛고 선 시세의 마지막 봉 시각(ms) */
  asOf?: number;
}

export interface ScoreReason {
  kind: "ontology" | "price" | "news";
  text: string;
  contribution: number;
}

export interface TickerScore {
  code: string;
  symbol: string;
  nameKo: string;
  price: number;
  changePct: number;
  score: number;
  ontologyScore: number;
  priceScore: number;
  newsScore: number;
  volatility: number;
  atr: number;
  reasons: ScoreReason[];
  /** 온톨로지 그래프 간선 (거시 → 섹터 → 이 종목) */
  edges: { macroId: string; sector: string; contribution: number }[];
  /** 섹터(레이더 종목 표시용) */
  sector?: string | null;
  /** 이 점수가 계산된 시각 (레이더 종목) */
  asOf?: number;
}

export interface PlannedOrder {
  side: "buy" | "sell";
  code: string;
  nameKo: string;
  qty: number;
  price: number;
  notionalKrw: number;
  score: number;
  reason: string;
  detail: string[];
}

export interface BotPosition {
  code: string;
  nameKo: string;
  qty: number;
  avgPrice: number;
  enteredAt: number;
  lastAddedAt: number;
  reason: string;
  price?: number;
  pnlPct?: number;
  heldQty?: number;
}

export interface AutoPlan {
  generatedAt: number;
  kst: { date: string; hhmm: string; weekday: string; weekend: boolean };
  market: { open: boolean; label: string };
  config: AutoConfigView;
  gate: { canTrade: boolean; reasons: string[] };
  account: { connected: boolean; reason: string; cash: number; stockEval: number; totalEval: number; holdings: Holding[] };
  equity: number;
  deployedKrw: number;
  budgetKrw: number;
  pnlKrw: number;
  botPnlKrw: number;
  otherPnlKrw: number;
  targetProgressPct: number;
  riskOff: number;
  macro: MacroSignal[];
  top: TickerScore[];
  positions: BotPosition[];
  orders: PlannedOrder[];
  notes: string[];
}

export interface OntologyGraph {
  macro: { id: string; nameKo: string; symbol: string; scale: number; upMeansKo: string }[];
  sectors: { sector: string; sensitivity: Record<string, number> }[];
  universe: { code: string; nameKo: string; sectors: Record<string, number> }[];
  weights: { ontology: number; price: number; news: number };
}

export interface OntoState {
  generatedAt: number;
  /** 계산에 쓴 시세 중 가장 최신 봉의 시각(ms) */
  dataAsOf: number | null;
  macro: MacroSignal[];
  scores: TickerScore[];
  riskOff: number;
  note: string;
  macroNews: { provider: string | null; headlinesUsed: number; adjustments: { id: string; impact: number; reasonKo: string }[] };
  sectors: { sector: string; sensitivity: Record<string, number> }[];
  universe: { code: string; nameKo: string; sectors: Record<string, number> }[];
  weights: { ontology: number; price: number; news: number };
  /** 의미론적 층: 섹터×거시 간선의 인과 유형·메커니즘 */
  relations?: Record<string, Record<string, { rel: string; ko: string }>>;
  /** 거시요인 사이의 인과 (설명용, 점수 미반영) */
  macroLinks?: { from: string; to: string; sign: 1 | -1; ko: string }[];
  /** 거시 층의 의미론적 클러스터 (금리·통화 / 원자재·원가 / 위험선호 / 실물·업황) */
  macroClusters?: { nameKo: string; ids: string[] }[];
}

export interface RadarItem {
  code: string;
  name: string;
  sector: string | null;
  market: string;
  price: number;
  changePct: number;
  score: number;
  onto: number;
  priceScore: number;
  volatility: number;
  /** 20일 수익률 − KOSPI 20일 수익률(%p). 스캔이 한 바퀴 돌기 전엔 null. */
  relStrength: number | null;
  edges: { macroId: string; sector: string; contribution: number }[];
  reasons: { kind: string; text: string; contribution: number }[];
  updatedAt: number;
}

export interface SectorVerdict {
  sector: string;
  score: number;
  reasons: string[];
  edges: { macroId: string; contribution: number }[];
}
export interface StockVerdict {
  code: string;
  name: string;
  sector: string | null;
  score: number;
  price: number;
  changePct: number;
  reason: string;
}
export interface OntoVerdict {
  market: "KR" | "US";
  generatedAt: number;
  dataAsOf: number | null;
  regime: { label: string; tone: "risk-off" | "caution" | "risk-on"; riskOff: number; lines: string[] };
  causal: string[];
  flow: { available: boolean; days: number; foreignNetBuyKrw: number; institutionNetBuyKrw: number; basis: string } | null;
  sectors: { recommend: SectorVerdict[]; avoid: SectorVerdict[] };
  stocks: { recommend: StockVerdict[]; avoid: StockVerdict[] };
  note: string;
}

export interface RadarOpps {
  available: boolean;
  tailwind: RadarItem[];
  relative: RadarItem[];
  weak: RadarItem[];
}

export interface AutoStatus {
  config: AutoConfigView;
  kst: { date: string; hhmm: string; weekday: string; weekend: boolean };
  market: { open: boolean; label: string };
  kisConfigured: boolean;
  dryRun: boolean;
  universe: number;
  state: {
    baselineEquity: number;
    lastEquity: number;
    peakEquity: number;
    pnlKrw: number;
    day: string;
    tradesToday: number;
    haltedDay: string;
    haltedPermanent: boolean;
    haltReason: string;
    targetReachedAt: number;
    lastCycleAt: number;
    positions: BotPosition[];
  };
}

export interface JournalEntry {
  at: number;
  kstDate: string;
  kind: "cycle" | "order" | "halt" | "resume" | "skip" | "error";
  text: string;
  detail?: unknown;
}

export interface CycleResponse {
  ran: boolean;
  shadow: boolean;
  executed: number;
  results: { code: string; side: string; ok: boolean; message: string }[];
  gate: { canTrade: boolean; reasons: string[] };
  orders: PlannedOrder[];
}

const TOKEN_KEY = "wfg.tradeToken";

export function getTradeToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setTradeToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 프라이빗 모드 등에서 저장 실패는 무시 */
  }
}

export class ApiFailure extends Error {
  status: number;
  code: string;
  detail: unknown;
  constructor(status: number, code: string, detail: unknown) {
    super(humanize(code, detail));
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function humanize(code: string, detail: unknown): string {
  const hint = (detail as { hint?: string } | null)?.hint;
  if (hint) return hint;
  const msg = (detail as { msg?: string } | null)?.msg;
  if (msg) return String(msg);
  const table: Record<string, string> = {
    kis_not_configured: "한국투자증권 API 키가 서버에 등록되지 않았습니다.",
    trade_token_not_set: "서버에 거래 암호(TRADE_TOKEN)가 설정되지 않았습니다.",
    unauthorized: "거래 암호가 올바르지 않습니다.",
    orders_disabled: "주문 기능이 비활성화되어 있습니다.",
    kis_unreachable: "한국투자증권 서버에 연결할 수 없습니다.",
    confirm_mismatch: "확인란의 종목코드가 일치하지 않습니다.",
    symbol_not_found: "시세를 찾을 수 없는 종목입니다.",
    upstream_429: "데이터 제공처 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요.",
    overseas_unavailable: "이 계좌 모드에서는 해외주식 주문·잔고가 지원되지 않습니다.",
    ai_disabled: "AI 분석이 비활성 상태입니다.",
    ai_bad_json: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
    ai_refused: "모델이 이 내용에 대한 응답을 거부했습니다.",
    analysis_unsupported: "이 국가는 시장 데이터가 없어 AI 분석을 만들지 않습니다.",
  };
  return table[code] ?? `요청 실패 (${code})`;
}

async function request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["content-type"] = "application/json";
  if (init?.auth) {
    const token = getTradeToken();
    if (!token) throw new ApiFailure(401, "no_local_token", { hint: "먼저 우측 상단 ‘거래 암호’를 입력하세요." });
    headers["authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiFailure(res.status, "bad_json", { snippet: text.slice(0, 120) });
  }
  if (!res.ok) {
    const b = body as { error?: string; detail?: unknown } | null;
    throw new ApiFailure(res.status, b?.error ?? `http_${res.status}`, b?.detail ?? null);
  }
  return body as T;
}

export const api = {
  config: () => request<ConfigResponse>("/api/config"),
  tape: () => request<{ items: Snapshot[]; fetchedAt: number }>("/api/tape"),
  globalNews: () => request<{ items: NewsItem[]; sources: ProviderStat[] }>("/api/global/news"),
  overview: (cc: string, name: string) => request<Overview>(`/api/country/${cc}/overview?name=${encodeURIComponent(name)}`),
  news: (cc: string, name: string) =>
    request<{ items: NewsItem[]; sources: ProviderStat[] }>(`/api/country/${cc}/news?name=${encodeURIComponent(name)}`),
  recommend: (cc: string) => request<RecommendResponse>(`/api/country/${cc}/recommend`),
  analysis: (cc: string) => request<AnalysisResult>(`/api/country/${cc}/analysis`),
  kisStatus: () => request<KisStatus>("/api/kis/status"),
  balance: (market: string, currency?: string) =>
    request<BalanceResponse>("/api/kis/balance", { method: "POST", auth: true, body: JSON.stringify({ market, currency }) }),
  kisPrice: (market: string, code: string) =>
    request<{ price: number; changePct: number; name?: string; upperLimit?: number; lowerLimit?: number }>(
      `/api/kis/price?market=${market}&code=${encodeURIComponent(code)}`,
      { auth: true },
    ),
  order: (payload: {
    market: string;
    code: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    orderType: "limit" | "market";
    currency: string;
    refPrice?: number;
    confirm: string;
  }) => request<OrderResponse>("/api/kis/order", { method: "POST", auth: true, body: JSON.stringify(payload) }),

  autoStatus: () => request<AutoStatus>("/api/auto/status"),
  autoGraph: () => request<OntologyGraph>("/api/auto/graph"),
  ontoState: () => request<OntoState>("/api/onto/state"),
  radarTop: (limit = 12) => request<{ available: boolean; items: RadarItem[] }>(`/api/radar/top?limit=${limit}`),
  radarFind: (q: string) => request<{ available: boolean; items: RadarItem[] }>(`/api/radar/find?q=${encodeURIComponent(q)}`),
  radarStatus: () => request<{ available: boolean; tickers?: number; scored?: number; newestScoreAt?: number }>("/api/radar/status"),
  radarOpps: (limit = 8, market: "KR" | "US" = "KR") => request<RadarOpps>(`/api/radar/opps?limit=${limit}&market=${market}`),
  ontoVerdict: (market: "KR" | "US" = "KR") => request<OntoVerdict>(`/api/onto/verdict?market=${market}`),
  autoPlan: () => request<AutoPlan>("/api/auto/plan"),
  autoJournal: () => request<{ items: JournalEntry[] }>("/api/auto/journal"),
  autoRun: (shadow: boolean) =>
    request<CycleResponse>("/api/auto/run", { method: "POST", auth: true, body: JSON.stringify({ shadow }) }),
  autoResume: () => request<{ ok: true }>("/api/auto/resume", { method: "POST", auth: true, body: "{}" }),
  autoReset: () => request<{ ok: true }>("/api/auto/reset", { method: "POST", auth: true, body: "{}" }),
};
