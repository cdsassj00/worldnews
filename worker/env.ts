export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  /** Cloudflare Workers AI (선택). 있으면 Anthropic 키 없이도 AI 분석이 동작한다. */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };

  // vars
  KIS_ENV?: string; // "vts" | "prod"
  ORDER_ENABLED?: string; // "true" | "false"
  ORDER_ALLOW_REAL?: string; // "true" | "false"
  MAX_ORDER_NOTIONAL_KRW?: string;
  ORDER_DRY_RUN?: string; // "true" 면 검증만 하고 실제 주문은 보내지 않는다
  KIS_TRANSPORT?: string; // "auto" | "fetch" | "socket"
  KIS_OVERSEAS?: string; // "auto" | "on" | "off" — 해외주식 주문/잔고 사용 가능 여부

  // secrets
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
  KIS_ACCOUNT?: string; // "12345678-01"
  TRADE_TOKEN?: string; // 주문/잔고 API 접근용 비밀 토큰
  KIS_TRID_OVERRIDES?: string; // TR_ID 표를 덮어쓰는 JSON (선택)

  // AI 분석
  ANTHROPIC_API_KEY?: string; // 있으면 Claude 사용 (시크릿)
  AI_MODEL?: string; // 기본 claude-opus-5
  WORKERS_AI_MODEL?: string; // 기본 @cf/meta/llama-3.3-70b-instruct-fp8-fast
}
