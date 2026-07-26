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
  configured: boolean;
  tradeTokenSet: boolean;
  env: "vts" | "prod";
  envKo: string;
  ordersEnabled: boolean;
  realOrdersAllowed: boolean;
  maxOrderNotionalKrw: number;
  transport: string;
}

export interface ConfigResponse {
  kis: KisStatus;
  markets: { cc: string; nameKo: string; indexName: string | null; tickers: number; orderable: number }[];
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
};
