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

  /* 텔레그램 공지 (telegram.ts) — 봇이 그룹방에 오늘의 스윙 관점·주요 변화를 올린다.
   * 토큰은 시크릿, 방 번호와 스위치는 vars 로 둔다(방을 바꾸는 건 비밀이 아니다). */
  TELEGRAM_ENABLED?: string; // "true" 여야 크론이 공지를 보낸다. 기본 꺼짐
  TELEGRAM_CHAT_ID?: string; // 그룹방 id (예: -1001234567890)
  TELEGRAM_BOT_TOKEN?: string; // 시크릿 — @BotFather 발급 토큰

  // secrets
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
  KIS_ACCOUNT?: string; // "12345678-01"
  TRADE_TOKEN?: string; // 주문/잔고 API 접근용 비밀 토큰
  RADAR_TOKEN?: string; // 레이더 수동 스캔용 운영 토큰(주문 권한 없음)
  KIS_TRID_OVERRIDES?: string; // TR_ID 표를 덮어쓰는 JSON (선택)

  // 자동매매 (autotrade.ts)
  AUTOTRADE_ENABLED?: string; // "true" 여야 실제 주문이 나간다. 기본 false = 계획만 세움
  AUTO_CAPITAL_KRW?: string; // 운용 원금 상한. "0" = 넣은 돈 전액 자동 추종
  AUTO_RESERVE_KRW?: string; // 국내 매수 예산에서 빼 두는 예약 현금(미국주식 대기 자금 등)
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
  /** 종목 선정에 쓸 점수 엔진 — onto | quant | hybrid (KV 값이 있으면 그쪽이 우선) */
  AUTO_ENGINE?: string;

  /* 퀀트 트랙 (quant.ts) — 수급·차트만 보는 별도 엔진. 모의매매라 주문은 나가지 않는다.
   * 백테스트에서 온톨로지 트랙에 졌기 때문에 실계좌를 붙이지 않았다(기록은 계속 쌓는다). */
  QUANT_ENABLED?: string; // "false" 면 스캔·모의매매 모두 정지
  QUANT_PROFILE?: string; // chart | flow | blend | breakout | meanrev (기본 breakout)
  QUANT_CAPITAL_KRW?: string; // 모의 원금 (기본 400만)
  QUANT_MAX_POSITIONS?: string;
  QUANT_MAX_POSITION_PCT?: string;
  QUANT_MAX_ORDER_KRW?: string;
  QUANT_MIN_ORDER_KRW?: string;
  QUANT_MAX_BUYS_PER_DAY?: string;
  QUANT_BUY_SCORE?: string;
  QUANT_SELL_SCORE?: string;
  QUANT_STOP_LOSS_PCT?: string;
  QUANT_TAKE_PROFIT_PCT?: string;
  QUANT_MARKET_MA_DAYS?: string; // 코스피가 N일선 아래면 신규 매수 정지 (0 이면 끔)
  QUANT_MAX_DRAWDOWN_PCT?: string;
  QUANT_MIN_POOL?: string; // 후보 풀이 이만큼 차기 전에는 매수하지 않는다(초기 스캔 편향 방지)

  // AI 분석
  US_AUTOTRADE_ENABLED?: string; // 미국 자동매매 — 백테스트 통과 전까지 "false"
  /* 미국 봇 독립 세팅(2026-08-19) — 비우면 한국(AUTO_*) 값을 그대로 따른다.
   * 값을 넣는 순간부터 미국만 따로 움직인다. 엔진 선택은 KV auto:us:engine. */
  US_STOP_LOSS_PCT?: string;
  US_TAKE_PROFIT_PCT?: string;
  US_DAILY_LOSS_HALT_PCT?: string;
  US_MAX_DRAWDOWN_PCT?: string;
  US_MAX_POSITION_PCT?: string;
  US_MAX_POSITIONS?: string;
  US_MAX_ORDERS_PER_CYCLE?: string;
  US_MAX_TRADES_PER_DAY?: string;
  US_MIN_ORDER_KRW?: string;
  US_BUY_SCORE?: string;
  US_MIN_POOL?: string;
  US_ENGINE?: string; // onto | quant | ta | fusion (KV 미설정 시 폴백)
  GEMINI_API_KEY?: string; // 있으면 Gemini 를 1순위로 사용 (시크릿, aistudio.google.com/apikey)
  GEMINI_MODEL?: string; // 기본 gemini-2.5-flash
  OPENROUTER_API_KEY?: string; // 있으면 OpenRouter 를 1순위 AI 제공자로 (시크릿)
  OPENROUTER_MODEL?: string; // 기본 google/gemini-2.5-flash
  ANTHROPIC_API_KEY?: string; // 있으면 Claude 사용 (시크릿)
  AI_MODEL?: string; // 기본 claude-haiku-4-5
  AI_PROVIDER?: string; // 1순위 제공자 고정: openrouter | gemini | anthropic | workers-ai (실패 시 나머지로 폴백)
  WORKERS_AI_MODEL?: string; // 기본 @cf/meta/llama-3.3-70b-instruct-fp8-fast
}
