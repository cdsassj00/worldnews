import type { RadarDB } from "./radar";

export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  /** 전 시장 레이더 저장소 (SQLite Durable Object) */
  RADAR?: DurableObjectNamespace<RadarDB>;
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
  RADAR_TOKEN?: string; // 레이더 수동 스캔용 운영 토큰(주문 권한 없음)
  KIS_TRID_OVERRIDES?: string; // TR_ID 표를 덮어쓰는 JSON (선택)

  // 자동매매 (autotrade.ts)
  AUTOTRADE_ENABLED?: string; // "true" 여야 실제 주문이 나간다. 기본 false = 계획만 세움
  AUTO_CAPITAL_KRW?: string; // 운용 원금 상한
  AUTO_MAX_POSITION_PCT?: string; // 한 종목 최대 비중(%)
  AUTO_STOP_LOSS_PCT?: string; // 종목별 손절(%)
  AUTO_TAKE_PROFIT_PCT?: string; // 종목별 익절(%)
  AUTO_DAILY_LOSS_HALT_PCT?: string; // 당일 손실 정지선(%)
  AUTO_MAX_DRAWDOWN_PCT?: string; // 고점 대비 낙폭 영구 정지선(%)
  AUTO_TARGET_PROFIT_KRW?: string; // 목표 수익
  AUTO_MAX_TRADES_PER_DAY?: string;
  AUTO_MAX_ORDERS_PER_CYCLE?: string;
  AUTO_MIN_ORDER_KRW?: string;
  AUTO_MAX_POSITIONS?: string;

  // AI 분석
  US_AUTOTRADE_ENABLED?: string; // 미국 자동매매 — 백테스트 통과 전까지 "false"
  GEMINI_API_KEY?: string; // 있으면 Gemini 를 1순위로 사용 (시크릿, aistudio.google.com/apikey)
  GEMINI_MODEL?: string; // 기본 gemini-2.5-flash
  ANTHROPIC_API_KEY?: string; // 있으면 Claude 사용 (시크릿)
  AI_MODEL?: string; // 기본 claude-haiku-4-5
  WORKERS_AI_MODEL?: string; // 기본 @cf/meta/llama-3.3-70b-instruct-fp8-fast
}
