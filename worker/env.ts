export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;

  // vars
  KIS_ENV?: string; // "vts" | "prod"
  ORDER_ENABLED?: string; // "true" | "false"
  ORDER_ALLOW_REAL?: string; // "true" | "false"
  MAX_ORDER_NOTIONAL_KRW?: string;
  KIS_TRANSPORT?: string; // "auto" | "fetch" | "socket"

  // secrets
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
  KIS_ACCOUNT?: string; // "12345678-01"
  TRADE_TOKEN?: string; // 주문/잔고 API 접근용 비밀 토큰
  KIS_TRID_OVERRIDES?: string; // TR_ID 표를 덮어쓰는 JSON (선택)
}
