/**
 * 자동매매 엔진.
 *
 * strategy.ts 가 "무엇을 살까"를 정하고, 이 파일은 "그래서 실제로 얼마나, 언제, 어떤 조건에서"를 정한다.
 * 신호보다 중요한 건 여기 있는 제동장치다. 대부분의 계좌는 예측이 틀려서가 아니라
 * 틀렸을 때 멈추지 못해서 사라진다.
 *
 * 제동장치 (모두 동시에 작동)
 *   1) AUTOTRADE_ENABLED=false 면 계획만 세우고 주문은 절대 내지 않는다 (기본값).
 *   2) 한국 정규장(평일 09:00~15:20 KST) 밖에서는 주문하지 않는다.
 *   3) 운용 원금은 AUTO_CAPITAL_KRW 로 제한한다. 계좌에 돈이 더 있어도 그 이상 쓰지 않는다.
 *   4) 한 종목 비중은 AUTO_MAX_POSITION_PCT 를 넘지 못한다.
 *   5) 1회 주문 금액은 MAX_ORDER_NOTIONAL_KRW 를 넘지 못한다(→ 여러 번에 나눠 분할 진입).
 *   6) 종목별 -AUTO_STOP_LOSS_PCT 손절 / +AUTO_TAKE_PROFIT_PCT 익절.
 *   7) 당일 -AUTO_DAILY_LOSS_HALT_PCT 손실이면 그날은 신규 매수 정지.
 *   8) 고점 대비 -AUTO_MAX_DRAWDOWN_PCT 면 사람이 풀어 줄 때까지 영구 정지.
 *   9) 봇이 직접 산 종목만 판다. 계좌에 원래 있던 보유분은 건드리지 않는다.
 *
 * 목표 수익(AUTO_TARGET_PROFIT_KRW)에 도달하면 신규 매수를 멈춘다.
 * 목표를 위해 손실 한도를 풀지는 않는다 — 그 조합이 계좌를 없애는 가장 흔한 경로다.
 */
import type { Env } from "./env";
import { isKrxHoliday } from "./holidays";
import { UNIVERSE, roundToTick } from "../shared/ontology";
import { runStrategy, type StrategyResult, type TickerScore } from "./strategy";
import { quantRank } from "./quant";
import {
  domesticBalance,
  isDryRun,
  kisConfig,
  kisConfigured,
  placeOrder,
  type Holding,
} from "./kis";
import { ApiError, cached, num, round } from "./util";

/* ── 설정 ─────────────────────────────────────────────── */

export interface AutoConfig {
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

export function autoConfig(env: Env): AutoConfig {
  return {
    enabled: (env.AUTOTRADE_ENABLED ?? "false").toLowerCase() === "true",
    capitalKrw: num(env.AUTO_CAPITAL_KRW, 2_000_000),
    maxPositionPct: num(env.AUTO_MAX_POSITION_PCT, 25),
    stopLossPct: num(env.AUTO_STOP_LOSS_PCT, 7),
    takeProfitPct: num(env.AUTO_TAKE_PROFIT_PCT, 15),
    dailyLossHaltPct: num(env.AUTO_DAILY_LOSS_HALT_PCT, 5),
    maxDrawdownPct: num(env.AUTO_MAX_DRAWDOWN_PCT, 20),
    targetProfitKrw: num(env.AUTO_TARGET_PROFIT_KRW, 1_000_000),
    maxTradesPerDay: num(env.AUTO_MAX_TRADES_PER_DAY, 6),
    maxOrdersPerCycle: num(env.AUTO_MAX_ORDERS_PER_CYCLE, 3),
    maxOrderNotionalKrw: num(env.MAX_ORDER_NOTIONAL_KRW, 100_000),
    minOrderKrw: num(env.AUTO_MIN_ORDER_KRW, 30_000),
    maxPositions: num(env.AUTO_MAX_POSITIONS, 5),
  };
}

/** 매수 진입 점수 하한 — 어중간한 신호로는 들어가지 않는다 */
const BUY_SCORE = 0.15;
/** 보유 종목 이탈 점수 — 이 밑으로 떨어지면 근거가 사라진 것으로 본다 */
const SELL_SCORE = -0.05;
/** 지정가 슬리피지 허용폭 (체결을 위해 현재가에서 이만큼 양보) */
const SLIPPAGE = 0.003;

const STATE_KEY = "auto:state";
const JOURNAL_KEY = "auto:journal";
const JOURNAL_MAX = 120;

/* ── 시각·장 운영 ─────────────────────────────────────── */

export interface KstNow {
  date: string;
  hhmm: string;
  minutes: number;
  weekday: string;
  weekend: boolean;
}

export function kstNow(now = new Date()): KstNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = get("weekday");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
    weekday,
    weekend: weekday === "Sat" || weekday === "Sun",
  };
}

const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 15 * 60 + 20; // 동시호가 전에 손을 뗀다

export function marketPhase(now = kstNow()): { open: boolean; label: string } {
  if (now.weekend) return { open: false, label: `주말 휴장 (${now.weekday} ${now.hhmm} KST)` };
  if (isKrxHoliday(now.date)) return { open: false, label: `공휴일 휴장 (${now.date})` };
  if (now.minutes < OPEN_MIN) return { open: false, label: `장 시작 전 (${now.hhmm} KST)` };
  if (now.minutes > CLOSE_MIN) return { open: false, label: `장 마감 (${now.hhmm} KST)` };
  return { open: true, label: `정규장 진행중 (${now.hhmm} KST)` };
}

/* ── 상태 ─────────────────────────────────────────────── */

export interface BotPosition {
  code: string;
  nameKo: string;
  qty: number;
  avgPrice: number;
  enteredAt: number;
  lastAddedAt: number;
  reason: string;
}

export interface AutoState {
  startedAt: number;
  /**
   * 실계좌 봇 손익 곡선(원) — 하루 한 점.
   * 전략실이 "백테스트·모의만이 아니라 진짜 돈이 어떻게 돌았나"를 보여주기 위한 기록.
   * 과거는 재구성하지 않는다(정직한 기록만) — 이 필드를 넣은 날부터 쌓인다.
   */
  botPnlCurve?: { d: string; v: number }[];
  /** 봇이 처음 관측한 평가금액 — 목표수익 계산 기준 */
  baselineEquity: number;
  peakEquity: number;
  lastEquity: number;
  day: string;
  dayStartEquity: number;
  tradesToday: number;
  /** 그날 하루만 정지 (일일 손실 한도) */
  haltedDay: string;
  /** 사람이 풀어야 해제되는 정지 (최대 낙폭) */
  haltedPermanent: boolean;
  haltReason: string;
  targetReachedAt: number;
  lastCycleAt: number;
  positions: Record<string, BotPosition>;
  /** 입출금 기준선 보정 이력 (중복 적용 방지 키) */
  depositAdjustments?: Record<string, number>;
  /** 직전 사이클의 주문가능 현금 — 입출금 자동 감지에 쓴다 */
  lastCash?: number;
  /** 봇이 매도로 확정한 누적 손익(원). 평가손익과 합쳐 진짜 손익을 만든다. */
  realizedPnl?: number;
  /** 손익 기준 고점·당일 시작값 — 정지선 판정에 쓴다(평가액 대신) */
  peakPnl?: number;
  dayStartPnl?: number;
  /** 내가 이 계좌에 넣은 돈의 총액(원). 수익 = 현재 평가금액 − 이 값. */
  totalDepositKrw?: number;
}

function emptyState(now: KstNow): AutoState {
  return {
    startedAt: Date.now(),
    baselineEquity: 0,
    peakEquity: 0,
    lastEquity: 0,
    day: now.date,
    dayStartEquity: 0,
    tradesToday: 0,
    haltedDay: "",
    haltedPermanent: false,
    haltReason: "",
    targetReachedAt: 0,
    lastCycleAt: 0,
    positions: {},
  };
}

export async function loadState(env: Env): Promise<AutoState> {
  const raw = (await env.CACHE.get(STATE_KEY, "json").catch(() => null)) as AutoState | null;
  const now = kstNow();
  if (!raw) return emptyState(now);
  const state: AutoState = { ...emptyState(now), ...raw, positions: raw.positions ?? {} };

  /* 1회성 보정 (2026-08-03): 사용자가 400만원을 입금했는데 손익으로 잡혀
   * 목표 달성(+100만)이 오발동했다. 입금은 수익이 아니다 — 기준선을 같은 만큼
   * 올려 실매매 손익만 남기고, 오발동한 목표 플래그를 해제한다. */
  /* 2026-08-06 철회: 08-05 에 "입금 1,830,215원"으로 본 현금 증가는 입금이 아니라
   * D+2 정산에 따른 계좌 필드 이동이었다(그날 봇은 매수만 했다). 손익 계산을
   * 평가손익+실현손익 기반으로 바꿔 기준선이 손익에 영향을 주지 않으므로 되돌린다. */
  const ADJ2 = "deposit-2026-08-05";
  if (state.depositAdjustments?.[ADJ2]) {
    const amount = state.depositAdjustments[ADJ2];
    const rest = { ...state.depositAdjustments };
    delete rest[ADJ2];
    state.depositAdjustments = rest;
    state.baselineEquity -= amount;
    state.peakEquity = Math.max(0, state.peakEquity - amount);
    if (state.dayStartEquity > 0) state.dayStartEquity = Math.max(0, state.dayStartEquity - amount);
    await saveState(env, state);
    await appendJournal(env, [entry("resume", `08-05 입금 보정(1,830,215원)을 철회했습니다 — 입금이 아니라 D+2 정산 이동이었습니다. 손익은 이제 보유 평가손익+실현손익으로 계산합니다.`)]);
  }

  /* 입금 총액 초기화 — 사용자 신고 기준: 처음 200만 + 08-03 추가 400만 = 600만.
   * 수익은 "지금 계좌 평가금액 − 이 값"으로 계산한다. 추가 입출금은
   * /api/auto/deposit 으로 갱신한다. */
  if (state.totalDepositKrw === undefined) {
    state.totalDepositKrw = 6_000_000;
    await saveState(env, state);
  }

  const ADJ_KEY = "deposit-2026-08-03";
  if (!state.depositAdjustments?.[ADJ_KEY] && state.baselineEquity > 0 && state.baselineEquity < 3_000_000) {
    const amount = 4_000_000;
    state.depositAdjustments = { ...(state.depositAdjustments ?? {}), [ADJ_KEY]: amount };
    state.baselineEquity += amount;
    // 오늘 시작 평가액도 입금 전에 찍힌 값이면 함께 올린다 (일일 손실 한도 왜곡 방지)
    if (state.day === "2026-08-03" && state.dayStartEquity > 0 && state.dayStartEquity < 3_000_000) {
      state.dayStartEquity += amount;
    }
    // 입금으로 오발동한 목표 달성 해제 (실손익은 목표 근처가 아니다)
    if (state.targetReachedAt) state.targetReachedAt = 0;
    await saveState(env, state);
    await appendJournal(env, [entry("resume", `입금 400만원 기준선 보정 — 입금은 손익에서 제외하고, 오발동한 목표 달성(신규 매수 중단)을 해제합니다.`)]);
  }
  return state;
}

/**
 * 입출금 기준선 보정 — 입금(+)·출금(−)은 손익이 아니므로 기준선을 같은 방향으로
 * 움직여 실매매 손익만 남긴다. /api/auto/deposit (거래 암호) 로 호출.
 */
export async function adjustForDeposit(env: Env, amountKrw: number): Promise<AutoState> {
  if (!Number.isFinite(amountKrw) || Math.abs(amountKrw) < 1000 || Math.abs(amountKrw) > 1_000_000_000) {
    throw new ApiError(400, "invalid_amount");
  }
  const state = await loadState(env);
  const key = `manual-${Date.now()}`;
  state.depositAdjustments = { ...(state.depositAdjustments ?? {}), [key]: amountKrw };
  // 넣은 돈의 총액을 갱신한다 — 수익 계산의 기준
  state.totalDepositKrw = Math.max(0, (state.totalDepositKrw ?? 0) + amountKrw);
  state.baselineEquity += amountKrw;
  if (state.dayStartEquity > 0) state.dayStartEquity += amountKrw;
  if (amountKrw > 0 && state.targetReachedAt) state.targetReachedAt = 0;
  if (amountKrw < 0) state.peakEquity = Math.max(state.baselineEquity, state.peakEquity + amountKrw);
  await saveState(env, state);
  await appendJournal(env, [
    entry("resume", `${amountKrw > 0 ? "입금" : "출금"} ${Math.abs(amountKrw).toLocaleString("ko-KR")}원 기준선 보정 — 입출금은 손익에서 제외합니다.`),
  ]);
  return state;
}

async function saveState(env: Env, state: AutoState): Promise<void> {
  // 자동매매 상태는 만료되면 안 된다(포지션 장부이므로). TTL 없이 저장.
  await env.CACHE.put(STATE_KEY, JSON.stringify(state)).catch(() => undefined);
}

/* ── 매매일지 ─────────────────────────────────────────── */

export interface JournalEntry {
  at: number;
  kstDate: string;
  kind: "cycle" | "order" | "halt" | "resume" | "skip" | "error";
  text: string;
  detail?: unknown;
}

export async function getJournal(env: Env): Promise<JournalEntry[]> {
  const raw = (await env.CACHE.get(JOURNAL_KEY, "json").catch(() => null)) as JournalEntry[] | null;
  return Array.isArray(raw) ? raw : [];
}

async function appendJournal(env: Env, entries: JournalEntry[]): Promise<void> {
  if (!entries.length) return;
  const prev = await getJournal(env);
  const next = [...entries, ...prev].slice(0, JOURNAL_MAX);
  await env.CACHE.put(JOURNAL_KEY, JSON.stringify(next)).catch(() => undefined);
}

function entry(kind: JournalEntry["kind"], text: string, detail?: unknown): JournalEntry {
  return { at: Date.now(), kstDate: kstNow().date, kind, text, detail };
}

/* ── 계좌 ─────────────────────────────────────────────── */

export interface AccountView {
  connected: boolean;
  reason: string;
  cash: number;
  stockEval: number;
  totalEval: number;
  holdings: Holding[];
}

/** 직전 성공한 계좌 조회 (아이솔레이트 메모리). KIS 가 순간적으로 튕겨도 화면이 비지 않게 한다. */
let lastGoodAccount: { at: number; view: AccountView } | null = null;
const ACCOUNT_FRESH_MS = 60_000;

async function readAccount(env: Env): Promise<AccountView> {
  if (!kisConfigured(env)) {
    return { connected: false, reason: "KIS 시크릿이 등록되지 않아 계좌를 읽지 못했습니다.", cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
  }
  // 1분 안에 성공한 조회가 있으면 재사용 — 대시보드 새로고침마다 KIS 를 때리면
  // 초당 유량 제한(EGW00201)에 걸려 간헐적으로 "미연결" 이 뜬다.
  if (lastGoodAccount && Date.now() - lastGoodAccount.at < ACCOUNT_FRESH_MS) return lastGoodAccount.view;

  let lastErr: unknown = null;
  // 유량 제한은 대개 순간적이다. 짧게 한 번 더 시도한다.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    try {
      const bal = await domesticBalance(env, kisConfig(env));
      const view: AccountView = {
        connected: true,
        reason: "",
        cash: bal.summary.orderableCash || bal.summary.cash,
        stockEval: bal.summary.stockEval,
        totalEval: bal.summary.totalEval || bal.summary.cash + bal.summary.stockEval,
        holdings: bal.holdings,
      };
      lastGoodAccount = { at: Date.now(), view };
      return view;
    } catch (err) {
      lastErr = err;
    }
  }

  // 두 번 다 실패 — 최근 성공분이 있으면 그것으로 화면을 채우되 조회 시각을 밝힌다.
  const detail = lastErr instanceof ApiError ? JSON.stringify(lastErr.detail ?? {}) : "";
  const message = lastErr instanceof ApiError ? `${lastErr.message} ${detail}` : String(lastErr);
  if (lastGoodAccount) {
    const ageSec = Math.round((Date.now() - lastGoodAccount.at) / 1000);
    return { ...lastGoodAccount.view, reason: `KIS 일시 오류로 ${ageSec}초 전 조회값 표시 (${message})` };
  }
  return { connected: false, reason: `계좌 조회 실패: ${message}`, cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
}

/* ── 계획 ─────────────────────────────────────────────── */

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

export interface AutoPlan {
  generatedAt: number;
  kst: KstNow;
  market: { open: boolean; label: string };
  config: AutoConfig;
  gate: { canTrade: boolean; reasons: string[] };
  account: AccountView;
  equity: number;
  deployedKrw: number;
  budgetKrw: number;
  pnlKrw: number;
  /** 봇이 산 종목만의 손익 — 기존 보유분과 섞이지 않게 분리해서 보여준다 */
  botPnlKrw: number;
  /** 계좌에 원래 있던(봇이 사지 않은) 종목의 손익 */
  otherPnlKrw: number;
  /** 내가 넣은 돈(입금 총액) */
  depositKrw: number;
  /** 순수익 = 현재 평가금액 − 입금 총액 */
  netProfitKrw: number;
  netProfitPct: number;
  /** 주식에 들어가 있는 돈 / 현금으로 남은 돈 */
  investedKrw: number;
  cashKrw: number;
  targetProgressPct: number;
  /** 지금 어떤 점수 엔진으로 종목을 고르고 있는가 */
  engine: AutoEngine;
  engineName: string;
  engineWeights: EngineWeights;
  engineNote: string;
  /** 실계좌 봇 이력 — 시작일 · 일별 손익 곡선 */
  real: { startedAt: number; botPnlCurve: { d: string; v: number }[] };
  riskOff: number;
  macro: StrategyResult["macro"];
  top: TickerScore[];
  positions: (BotPosition & { price: number; pnlPct: number; heldQty: number })[];
  orders: PlannedOrder[];
  notes: string[];
}

/** 계좌 평가금액 중 봇이 운용하는 부분 */
function deployedValue(state: AutoState, priceOf: (code: string) => number): number {
  return Object.values(state.positions).reduce((sum, p) => sum + p.qty * (priceOf(p.code) || p.avgPrice), 0);
}


/* ── 매매 엔진 선택 ─────────────────────────────────────
 * 무엇을 살지 정하는 "점수"를 어디서 가져올지 사용자가 고를 수 있게 한다.
 *
 *   onto   — 거시 인과(온톨로지) 결론 점수. 기본값.
 *   quant  — 수급·차트 점수(shared/quant.ts, 돌파 프로파일)
 *   hybrid — 둘을 반반 섞은 점수
 *
 * 점수만 갈아 끼우고 **주문·한도·손절 로직은 전부 공유한다.** 안전장치를
 * 엔진마다 따로 두면 어느 하나가 반드시 빠진다.
 *
 * 선택값은 KV 에 둔다(재배포 없이 바꾸려고). 없으면 AUTO_ENGINE 환경변수, 그것도
 * 없으면 onto.
 */
export type AutoEngine = string;

const ENGINE_KEY = "auto:engine";

/** 조합 가중치 — 세 분석(온톨로지·수급·차트)을 몇 %씩 섞는가 (합 100 기준) */
export interface EngineWeights { onto: number; flow: number; chart: number }

export interface EngineSel { id: string; nameKo: string; w: EngineWeights; descKo: string }

/* 세 분석의 모든 조합 7가지 — 단독 3 + 2개 조합 3 + 삼합 1.
 * id 는 기존 KV 저장값(onto/quant/ta/hybrid)과 백테스트 시나리오 id 를 그대로 잇는다.
 * 여기에 없는 비율은 커스텀 가중치("w:온,수,차")로 저장한다. */
export const AUTO_ENGINES: { id: string; nameKo: string; w: EngineWeights; desc: string }[] = [
  { id: "onto", nameKo: "온톨로지", w: { onto: 100, flow: 0, chart: 0 }, desc: "환율·금리·유가 같은 거시 신호가 업종을 거쳐 종목으로 전파되는 인과만 봅니다." },
  { id: "quant", nameKo: "수급", w: { onto: 0, flow: 100, chart: 0 }, desc: "자금흐름·매집·거래대금·돌파 — 돈이 들어오는 흔적만 봅니다." },
  { id: "ta", nameKo: "차트", w: { onto: 0, flow: 0, chart: 100 }, desc: "창시자가 있는 차트 전략 13종의 합의만 봅니다." },
  { id: "hybrid", nameKo: "온톨로지+수급", w: { onto: 50, flow: 50, chart: 0 }, desc: "거시 인과와 수급을 반반 섞습니다." },
  { id: "onto_ta", nameKo: "온톨로지+차트", w: { onto: 50, flow: 0, chart: 50 }, desc: "거시 인과와 차트 합의를 반반 섞습니다." },
  { id: "quant_ta", nameKo: "수급+차트", w: { onto: 0, flow: 50, chart: 50 }, desc: "수급과 차트 합의를 반반 섞습니다." },
  { id: "all3", nameKo: "삼합", w: { onto: 34, flow: 33, chart: 33 }, desc: "세 분석을 같은 무게로 모두 섞습니다." },
];

function normWeights(raw: Partial<EngineWeights>): EngineWeights {
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const w = { onto: clamp(raw.onto), flow: clamp(raw.flow), chart: clamp(raw.chart) };
  if (w.onto + w.flow + w.chart <= 0) throw new ApiError(400, "bad_weights", { hint: "가중치 합이 0입니다" });
  return w;
}

function selFromWeights(w: EngineWeights): EngineSel {
  const preset = AUTO_ENGINES.find((e) => e.w.onto === w.onto && e.w.flow === w.flow && e.w.chart === w.chart);
  if (preset) return { id: preset.id, nameKo: preset.nameKo, w: preset.w, descKo: preset.desc };
  return {
    id: "custom",
    nameKo: `커스텀 ${w.onto}·${w.flow}·${w.chart}`,
    w,
    descKo: `온톨로지 ${w.onto}% · 수급 ${w.flow}% · 차트 ${w.chart}% 가중 평균 — 이 비율의 백테스트는 아직 측정되지 않았습니다.`,
  };
}

function parseEngineValue(v: string | null | undefined): EngineSel | null {
  if (!v) return null;
  const preset = AUTO_ENGINES.find((e) => e.id === v);
  if (preset) return { id: preset.id, nameKo: preset.nameKo, w: preset.w, descKo: preset.desc };
  const m = /^w:(\d+),(\d+),(\d+)$/.exec(v);
  if (m) {
    try { return selFromWeights(normWeights({ onto: Number(m[1]), flow: Number(m[2]), chart: Number(m[3]) })); } catch { return null; }
  }
  return null;
}

export async function getEngineSel(env: Env): Promise<EngineSel> {
  return parseEngineValue(await env.CACHE.get(ENGINE_KEY))
    ?? parseEngineValue(env.AUTO_ENGINE)
    ?? parseEngineValue("onto")!;
}

/** 하위호환 — id 문자열만 필요한 자리 */
export async function getEngine(env: Env): Promise<AutoEngine> {
  return (await getEngineSel(env)).id;
}

/** 계획 캐시 키 조각 — 커스텀 가중치도 서로 다른 키를 갖게 한다 */
export function engineKey(sel: EngineSel): string {
  return sel.id === "custom" ? `w${sel.w.onto}-${sel.w.flow}-${sel.w.chart}` : sel.id;
}

export async function setEngine(env: Env, input: { engine?: string; weights?: Partial<EngineWeights> }): Promise<EngineSel> {
  let sel: EngineSel;
  if (input.weights) {
    sel = selFromWeights(normWeights(input.weights));
  } else {
    const preset = parseEngineValue(String(input.engine ?? ""));
    if (!preset) throw new ApiError(400, "bad_engine", { engine: input.engine, allowed: AUTO_ENGINES.map((e) => e.id) });
    sel = preset;
  }
  await env.CACHE.put(ENGINE_KEY, sel.id === "custom" ? `w:${sel.w.onto},${sel.w.flow},${sel.w.chart}` : sel.id);
  return sel;
}

/**
 * 엔진에 맞게 후보 점수를 다시 매긴다.
 *
 * quant 모드에서 퀀트 점수가 아직 없는 종목(스캔이 한 바퀴 안 돈 경우)은 후보에서
 * 뺀다 — 0점으로 두면 "정보가 없다"가 "나쁘다"로 둔갑한다. 대신 이미 보유 중인
 * 종목의 손절·익절은 가격 기준이라 그대로 작동한다.
 */
async function applyEngine(
  env: Env,
  sel: EngineSel,
  scores: TickerScore[],
): Promise<{ scores: TickerScore[]; note: string }> {
  const { w } = sel;
  const mixKo = `온톨로지 ${w.onto}% · 수급 ${w.flow}% · 차트 ${w.chart}%`;
  if (w.flow === 0 && w.chart === 0) return { scores, note: "온톨로지 점수로 순위를 정합니다." };

  let rows: { code: string; score: number; taScore?: number }[] = [];
  try {
    rows = (await quantRank(env, "breakout", 400)).rows.map((r) => ({ code: r.code, score: r.score, taScore: r.taScore }));
  } catch {
    return { scores, note: `퀀트 점수를 불러오지 못해 온톨로지 점수로 대체했습니다 (목표 조합: ${mixKo}).` };
  }
  const byCode = new Map(rows.map((r) => [r.code, r]));
  if (!byCode.size) return { scores, note: `퀀트 스캔 결과가 아직 없어 온톨로지 점수로 대체했습니다 (목표 조합: ${mixKo}).` };

  const out: TickerScore[] = [];
  let covered = 0;
  for (const s of scores) {
    const q = byCode.get(s.code);
    // 가중 평균 — 점수가 없는 축은 빼고 남은 가중치로 재정규화한다.
    // 0으로 채우면 "정보가 없다"가 "나쁘다"로 둔갑하기 때문이다.
    const comps: { wgt: number; val: number }[] = [{ wgt: w.onto, val: s.score }];
    if (q?.score !== undefined) comps.push({ wgt: w.flow, val: q.score });
    if (q?.taScore !== undefined) comps.push({ wgt: w.chart, val: q.taScore });
    const denom = comps.reduce((a, c) => a + c.wgt, 0);
    if (denom <= 0) continue; // 이 종목엔 이 조합을 매길 정보가 없다
    // 수급·차트 정보가 아예 없는 종목은, 그 축이 조합의 절반 이상이면 후보에서 뺀다
    if (denom < (w.onto + w.flow + w.chart) / 2) continue;
    if (q) covered++;
    const mixed = comps.reduce((a, c) => a + c.wgt * c.val, 0) / denom;
    out.push({ ...s, score: round(mixed, 3) });
  }
  out.sort((a, b) => b.score - a.score);
  return { scores: out, note: `${mixKo} 가중 평균으로 순위를 정합니다 (수급·차트 점수 있는 종목 ${covered}개).` };
}

export async function buildPlan(env: Env): Promise<AutoPlan> {
  const cfg = autoConfig(env);
  const now = kstNow();
  const phase = marketPhase(now);

  const [{ data: strategyRaw }, account] = await Promise.all([
    // 전략 계산은 무겁다(시세 28건 + 뉴스). 5분 캐시로 서브리퀘스트를 아낀다.
    cached(env, "auto:strategy", 300, () => runStrategy(env)),
    readAccount(env),
  ]);
  let strategy: StrategyResult = strategyRaw;

  const state = await loadState(env);
  const engineSel = await getEngineSel(env);
  const engineApplied = await applyEngine(env, engineSel, strategy.scores);
  // 이후 로직은 전부 이 재정렬된 점수를 본다. 원본(strategy.scores)은 화면 설명용으로만 남긴다.
  strategy = { ...strategy, scores: engineApplied.scores };
  const scoreByCode = new Map(strategy.scores.map((s) => [s.code, s]));
  const heldQty = new Map(account.holdings.map((h) => [h.symbol, h.qty]));
  // 편입된 종목은 점수 유니버스 밖일 수 있다 — 계좌가 주는 현재가로 손절·익절을 판단한다
  const acctPrice = new Map(account.holdings.map((h) => [h.symbol, h.price]));
  const priceOf = (code: string) => scoreByCode.get(code)?.price ?? acctPrice.get(code) ?? 0;

  const deployed = deployedValue(state, priceOf);
  const equity = account.connected ? account.totalEval : state.lastEquity || cfg.capitalKrw;
  const baseline = state.baselineEquity || equity;
  const budget = Math.max(0, cfg.capitalKrw - deployed);

  /* 손익은 "평가액 − 기준선"이 아니라 **보유 종목 평가손익 + 실현손익**으로 잰다.
   * 평가액 기반은 입출금·D+2 정산으로 총평가가 출렁일 때마다 가짜 손익을 만들었다
   * (2026-08-03 입금 400만이 +390만 수익으로, 08-05 정산 이동이 +189만 수익으로 계상).
   * 종목 평가손익은 계좌가 직접 주는 값이라 돈이 들어오고 나가도 흔들리지 않는다. */
  const holdingsPnl = account.connected ? account.holdings.reduce((sum, h) => sum + (h.pnl || 0), 0) : 0;
  const pnl = account.connected ? holdingsPnl + (state.realizedPnl ?? 0) : equity - baseline;

  /* 게이트 — 하나라도 막히면 매수는 나가지 않는다 */
  const blocked: string[] = [];
  if (!cfg.enabled) blocked.push("AUTOTRADE_ENABLED=false — 계획만 세우고 주문은 보내지 않습니다.");
  if (!phase.open) blocked.push(phase.label);
  if (!account.connected) blocked.push(account.reason);
  if (state.haltedPermanent) blocked.push(`영구 정지: ${state.haltReason} (수동 해제 필요)`);
  if (state.haltedDay === now.date) blocked.push(`당일 정지: ${state.haltReason}`);
  if (state.tradesToday >= cfg.maxTradesPerDay) blocked.push(`당일 매매 횟수 한도(${cfg.maxTradesPerDay}회) 도달`);

  const targetHit = pnl >= cfg.targetProfitKrw && cfg.targetProfitKrw > 0;
  if (targetHit) blocked.push(`목표 수익 ${cfg.targetProfitKrw.toLocaleString("ko-KR")}원 달성 — 신규 매수 중단`);

  const notes: string[] = [];
  const orders: PlannedOrder[] = [];
  /** 점수는 높지만 자본·한도 때문에 못 산 종목 */
  const skipped: string[] = [];

  /* 1) 청산 판단 — 봇이 산 종목만 대상으로 한다 */
  const positionView: AutoPlan["positions"] = [];
  for (const pos of Object.values(state.positions)) {
    const held = heldQty.get(pos.code) ?? 0;
    const sc = scoreByCode.get(pos.code);
    const price = sc?.price ?? acctPrice.get(pos.code) ?? pos.avgPrice;
    const pnlPct = pos.avgPrice ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : 0;
    positionView.push({ ...pos, price, pnlPct: round(pnlPct, 2), heldQty: held });

    // 계좌가 연결돼 있으면 계좌 보유량이 진실이다. held=0 인데 상태 수량으로
    // 폴백하면(예전 코드) 계좌에 없는 주식을 무한 재매도 시도하게 된다.
    const qty = account.connected ? Math.min(pos.qty, held) : pos.qty;
    if (qty <= 0) continue;

    let why = "";
    if (pnlPct <= -cfg.stopLossPct) why = `손절 (${round(pnlPct, 1)}% ≤ -${cfg.stopLossPct}%)`;
    else if (pnlPct >= cfg.takeProfitPct) why = `익절 (${round(pnlPct, 1)}% ≥ +${cfg.takeProfitPct}%)`;
    else if (sc && sc.score <= SELL_SCORE) why = `신호 이탈 (점수 ${sc.score})`;
    else if (strategy.riskOff >= 0.8) why = `시장 위험회피 ${strategy.riskOff} — 비중 축소`;
    if (!why) continue;

    const limit = roundToTick(price * (1 - SLIPPAGE), "down");
    orders.push({
      side: "sell",
      code: pos.code,
      nameKo: pos.nameKo,
      qty,
      price: limit,
      notionalKrw: Math.round(limit * qty),
      score: sc?.score ?? 0,
      reason: why,
      detail: sc ? sc.reasons.slice(0, 2).map((r) => r.text) : [],
    });
  }

  /* 2) 신규·추가 매수 */
  const openPositions = Object.keys(state.positions).length;
  const sellingCodes = new Set(orders.filter((o) => o.side === "sell").map((o) => o.code));
  const perPositionCap = (cfg.capitalKrw * cfg.maxPositionPct) / 100;
  // 위험회피 국면에서는 사이즈를 줄인다 (최대 40%까지 — 예전 50% 는 과했다)
  const riskScale = 1 - Math.min(0.4, strategy.riskOff * 0.5);
  let remaining = budget;
  // 실제 주문가능 현금도 주문별로 차감한다 — 안 하면 두 번째 주문이 KIS에서 잔액 부족으로 거절된다
  let cashLeft = account.connected ? account.cash : Number.POSITIVE_INFINITY;

  const coreCodes = new Set(UNIVERSE.filter((t) => t.core).map((t) => t.code));
  if (!targetHit) {
    for (const sc of strategy.scores) {
      if (orders.filter((o) => o.side === "buy").length >= cfg.maxOrdersPerCycle) break;
      if (sc.score < BUY_SCORE) break; // 점수 내림차순이라 여기서 끊어도 된다
      // 확장 유니버스는 분석·표시 전용이다. 거래량·ATR 없는 데이터에 돈을 태우지 않는다.
      if (!coreCodes.has(sc.code)) continue;
      if (sellingCodes.has(sc.code)) continue;

      const pos = state.positions[sc.code];
      if (!pos && openPositions + orders.filter((o) => o.side === "buy").length >= cfg.maxPositions) continue;

      const currentValue = pos ? pos.qty * sc.price : 0;
      const room = Math.min(perPositionCap - currentValue, remaining, cfg.maxOrderNotionalKrw, cashLeft);
      /* 점수에 따른 사이즈 배분.
       * 예전 (0.5 + score) 은 매수 기준선(0.15)에서 0.65배로 깎여, 위험회피 감쇠까지
       * 겹치면 한도 50만이 32만이 되고 20만원대 고가주는 1주밖에 못 샀다.
       * 기준선을 넘은 신호면 최소 85%, 점수 0.2 이상이면 100% 를 쓴다. */
      const sized = room * riskScale * Math.min(1, 0.7 + sc.score * 1.5);
      const limit = roundToTick(sc.price * (1 + SLIPPAGE), "up");
      if (limit > room) {
        // 1주 값이 한도보다 비싸면 이 종목은 지금 자본으로 살 수 없다. 조용히 넘기지 않고 알린다.
        skipped.push(`${sc.nameKo} 1주 ${Math.round(limit).toLocaleString("ko-KR")}원 > 이번 한도 ${Math.round(room).toLocaleString("ko-KR")}원`);
        continue;
      }
      if (sized < cfg.minOrderKrw) continue;

      const qty = Math.floor(sized / limit);
      if (qty < 1) {
        skipped.push(`${sc.nameKo} 배분액 ${Math.round(sized).toLocaleString("ko-KR")}원 < 1주 ${Math.round(limit).toLocaleString("ko-KR")}원`);
        continue;
      }
      const notional = limit * qty;
      if (notional < cfg.minOrderKrw) continue;
      if (notional > cashLeft) continue;

      remaining -= notional;
      cashLeft -= notional;
      orders.push({
        side: "buy",
        code: sc.code,
        nameKo: sc.nameKo,
        qty,
        price: limit,
        notionalKrw: Math.round(notional),
        score: sc.score,
        reason: pos ? `추가 매수 (점수 ${sc.score})` : `신규 진입 (점수 ${sc.score})`,
        detail: sc.reasons.slice(0, 3).map((r) => r.text),
      });
    }
  }

  if (!orders.length) notes.push("이번 사이클에 조건을 만족하는 매매가 없습니다. 대기합니다.");
  if (skipped.length) notes.push(`자금 한도로 제외: ${skipped.join(" · ")}`);
  if (deployed > 0) notes.push(`운용 투입 ${Math.round(deployed).toLocaleString("ko-KR")}원 / 한도 ${cfg.capitalKrw.toLocaleString("ko-KR")}원`);
  if (isDryRun(env)) notes.push("ORDER_DRY_RUN=true — 주문은 검증만 하고 전송되지 않습니다.");

  /* 봇 성과와 기존 보유분을 분리한다. 계좌 전체 손익만 보면 봇이 잘하고 있어도
   * 원래 갖고 있던 종목의 등락에 묻혀 판단이 안 된다. 봇 지분은 계좌 보유 수량 중
   * 봇 장부 수량만큼을 비례 배분해 계산한다. */
  const deposit = state.totalDepositKrw ?? 0;
  const netProfit = account.connected && deposit > 0 ? equity - deposit : 0;

  let botPnl = state.realizedPnl ?? 0;
  if (account.connected) {
    const byCode = new Map(account.holdings.map((h) => [h.symbol, h]));
    for (const pos of Object.values(state.positions)) {
      const h = byCode.get(pos.code);
      if (!h || !h.qty) continue;
      botPnl += (h.pnl || 0) * (Math.min(pos.qty, h.qty) / h.qty);
    }
  }

  return {
    generatedAt: Date.now(),
    kst: now,
    market: phase,
    config: cfg,
    gate: { canTrade: blocked.length === 0, reasons: blocked },
    account,
    equity: Math.round(equity),
    deployedKrw: Math.round(deployed),
    budgetKrw: Math.round(budget),
    pnlKrw: Math.round(pnl),
    botPnlKrw: Math.round(botPnl),
    otherPnlKrw: Math.round(pnl - botPnl),
    /* 사용자가 실제로 궁금한 네 숫자: 넣은 돈 / 주식 / 현금 / 수익.
     * 수익 = 지금 계좌 평가금액 − 내가 넣은 돈. 여기엔 봇 매매 손익과
     * 기존 보유 종목 등락이 모두 들어간다(계좌에 일어난 일 전부). */
    depositKrw: Math.round(deposit),
    netProfitKrw: Math.round(netProfit),
    netProfitPct: deposit > 0 ? round((netProfit / deposit) * 100, 2) : 0,
    investedKrw: Math.round(account.connected ? account.stockEval : deployed),
    cashKrw: Math.round(account.connected ? account.cash : 0),
    // 목표(+100만)는 봇이 벌어야 하는 돈이다 — 기존 보유분 등락은 목표 진행률에서 뺀다
    targetProgressPct: cfg.targetProfitKrw > 0 ? round((botPnl / cfg.targetProfitKrw) * 100, 1) : 0,
    engine: engineSel.id,
    engineName: engineSel.nameKo,
    engineWeights: engineSel.w,
    engineNote: engineApplied.note,
    real: { startedAt: state.startedAt, botPnlCurve: state.botPnlCurve ?? [] },
    riskOff: strategy.riskOff,
    macro: strategy.macro,
    top: strategy.scores.slice(0, 8),
    positions: positionView,
    orders,
    notes,
  };
}

/* ── 실행 ─────────────────────────────────────────────── */

export interface CycleResult {
  ran: boolean;
  executed: number;
  shadow: boolean;
  plan: AutoPlan;
  results: { code: string; side: string; ok: boolean; message: string }[];
  state: AutoState;
}

/**
 * 한 사이클 실행.
 *
 * shadow 모드(기본)는 계획을 세우고 일지에만 남긴다. 주문은 게이트가 전부 열려 있을 때만 나간다.
 * 손절·익절 매도는 "당일 정지" 상태에서도 실행한다 — 정지는 신규 진입을 막는 장치지
 * 이미 물린 포지션을 방치하라는 뜻이 아니다.
 */
export async function runCycle(env: Env, opts: { shadow?: boolean } = {}): Promise<CycleResult> {
  const plan = await buildPlan(env);
  const cfg = plan.config;
  const state = await loadState(env);
  const now = plan.kst;
  const journal: JournalEntry[] = [];

  /* 상태 갱신: 일자 롤오버 · 고점 · 정지 판정 */
  if (state.day !== now.date) {
    state.day = now.date;
    state.dayStartEquity = plan.equity;
    state.dayStartPnl = plan.pnlKrw; // 당일 정지선의 기준점
    state.tradesToday = 0;
  }
  if (!state.baselineEquity && plan.equity > 0) state.baselineEquity = plan.equity;
  if (plan.account.connected) state.lastCash = plan.account.cash;

  if (!state.dayStartEquity && plan.equity > 0) state.dayStartEquity = plan.equity;
  if (plan.equity > state.peakEquity) state.peakEquity = plan.equity;
  state.lastEquity = plan.equity;
  state.lastCycleAt = Date.now();

  /* 실계좌 봇 손익 곡선 — 하루 한 점(같은 날은 덮어쓴다) */
  if (plan.account.connected) {
    const curve = state.botPnlCurve ?? [];
    if (curve.length && curve[curve.length - 1].d === now.date) curve[curve.length - 1].v = plan.botPnlKrw;
    else curve.push({ d: now.date, v: plan.botPnlKrw });
    state.botPnlCurve = curve.slice(-400);
  }

  /* 정지선도 손익 기준으로 잰다. 평가액 기준이면 입금·정산으로 총평가가 흔들릴 때
   * 멀쩡한데 정지되거나(출금) 위험한데 안 멈추는(입금) 일이 생긴다.
   * 손실폭은 운용 원금 대비 %로 환산한다 — 한도의 의미(원금의 몇 %)가 그대로 유지된다. */
  if (plan.account.connected) {
    if (state.peakPnl === undefined || plan.pnlKrw > state.peakPnl) state.peakPnl = plan.pnlKrw;
    if (state.dayStartPnl === undefined) state.dayStartPnl = plan.pnlKrw;

    const ddPct = ((state.peakPnl - plan.pnlKrw) / Math.max(1, cfg.capitalKrw)) * 100;
    if (ddPct >= cfg.maxDrawdownPct && !state.haltedPermanent) {
      state.haltedPermanent = true;
      state.haltReason = `고점 손익 대비 -${round(ddPct, 1)}% (원금 대비, 한도 -${cfg.maxDrawdownPct}%)`;
      journal.push(entry("halt", `영구 정지 — ${state.haltReason}. 사람이 확인 후 해제해야 합니다.`));
    }
    const dayLossPct = ((state.dayStartPnl - plan.pnlKrw) / Math.max(1, cfg.capitalKrw)) * 100;
    if (dayLossPct >= cfg.dailyLossHaltPct && state.haltedDay !== now.date) {
      state.haltedDay = now.date;
      state.haltReason = `당일 -${round(dayLossPct, 1)}% (원금 대비, 한도 -${cfg.dailyLossHaltPct}%)`;
      journal.push(entry("halt", `당일 정지 — ${state.haltReason}. 내일 자동 해제됩니다.`));
    }
  }
  if (plan.botPnlKrw >= cfg.targetProfitKrw && cfg.targetProfitKrw > 0 && !state.targetReachedAt) {
    state.targetReachedAt = Date.now();
    journal.push(entry("cycle", `목표 수익 ${cfg.targetProfitKrw.toLocaleString("ko-KR")}원 달성 — 신규 매수를 중단합니다.`));
  }

  /* 상태-계좌 대사: 봇 장부와 실제 계좌가 어긋나면(외부 매도·부분 체결) 계좌를
   * 진실로 삼아 장부를 줄인다. 안 하면 없는 주식을 계속 팔려고 시도한다.
   *
   * 두 가지 안전장치 (2026-08-04 실전 사고 반영):
   *  ① 유예 시간: 방금 낸 지정가 주문은 미체결이거나 잔고 반영이 늦다. 이걸
   *     "계좌에 없음"으로 오판해 장부를 지우면, 다음 사이클이 같은 종목을 다시
   *     사서 중복 매수가 된다(실제로 NAVER 가 09:30·10:30 두 번 매수됨).
   *  ② 감소 방향만: 계좌 수량이 장부보다 많아도 올리지 않는다 — 사용자가 직접
   *     보유한 물량을 봇 장부가 흡수해 마음대로 팔면 안 된다. */
  const RECONCILE_GRACE_MS = 2 * 60 * 60 * 1000;

  /* 편입 — 계좌에 있는데 봇 장부에 없는(또는 장부보다 많은) 보유분을 장부로 흡수한다.
   *
   * 2026-08-16 사용자 지시: "개인 보유 주식도 봇 운용으로 바꿔라."
   * 예전에는 정반대(흡수 금지)가 안전장치였다 — 사용자 물량을 봇이 마음대로 팔면
   * 안 됐기 때문이다. 이제 계좌 전체가 봇 운용 대상이므로 흡수가 맞다.
   * 평단은 계좌가 주는 값(전체 매입 평균)을 쓴다. 편입된 종목도 손절·익절·신호이탈
   * 규칙을 그대로 받는다(점수 유니버스 밖이면 신호이탈만 없고 손절·익절은 작동). */
  if (plan.account.connected) {
    for (const h of plan.account.holdings) {
      if (h.qty <= 0) continue;
      const pos = state.positions[h.symbol];
      if (!pos) {
        state.positions[h.symbol] = {
          code: h.symbol,
          nameKo: h.name || h.symbol,
          qty: h.qty,
          avgPrice: h.avgPrice || h.price,
          enteredAt: Date.now(),
          lastAddedAt: Date.now(),
          reason: "계좌 보유분 편입 (사용자 지시 — 계좌 전체 봇 운용)",
        };
        journal.push(entry("cycle", `편입 — ${h.name || h.symbol} ${h.qty}주(평단 ${Math.round(h.avgPrice || h.price).toLocaleString("ko-KR")}원)를 봇 운용으로 흡수합니다.`));
      } else if (h.qty > pos.qty) {
        journal.push(entry("cycle", `편입 — ${pos.nameKo} 장부 ${pos.qty}주 → 계좌 ${h.qty}주로 확장(외부 매수분 흡수).`));
        pos.qty = h.qty;
        if (h.avgPrice) pos.avgPrice = h.avgPrice; // 계좌 평단이 전체 물량의 진짜 평균이다
        pos.lastAddedAt = Date.now();
      }
    }
  }

  if (plan.account.connected) {
    const heldByCode = new Map(plan.account.holdings.map((h) => [h.symbol, h.qty]));
    for (const pos of Object.values(state.positions)) {
      const held = heldByCode.get(pos.code) ?? 0;
      const freshMs = Date.now() - Math.max(pos.enteredAt ?? 0, pos.lastAddedAt ?? 0);
      if (freshMs < RECONCILE_GRACE_MS) continue; // 체결·반영 대기 중일 수 있다
      if (held <= 0) {
        journal.push(entry("cycle", `상태 정리 — ${pos.nameKo} 봇 장부 ${pos.qty}주가 계좌에 없어 제거합니다(외부 매도 등)`));
        delete state.positions[pos.code];
      } else if (held < pos.qty) {
        journal.push(entry("cycle", `상태 정리 — ${pos.nameKo} 수량 ${pos.qty}→${held}주로 보정(계좌 기준)`));
        pos.qty = held;
      }
    }
    // 방금 정리된 포지션을 향한 매도 주문은 계획에서 제거·축소한다
    plan.orders = plan.orders.filter((o) => {
      if (o.side === "buy") return true;
      const pos = state.positions[o.code];
      if (!pos) return false;
      o.qty = Math.min(o.qty, pos.qty);
      return o.qty > 0;
    });
  }

  const shadow = opts.shadow ?? !plan.gate.canTrade;
  const results: CycleResult["results"] = [];

  if (shadow) {
    journal.push(
      entry("skip", `그림자 실행 — ${plan.orders.length}건 계획, 주문 미전송. ${plan.gate.reasons[0] ?? "shadow 요청"}`, {
        orders: plan.orders.map((o) => `${o.side === "buy" ? "매수" : "매도"} ${o.nameKo} ${o.qty}주 @${o.price} — ${o.reason}`),
      }),
    );
  } else {
    // 매도를 먼저 처리한다. 현금을 만든 다음 사야 순서가 맞다.
    const queue = [...plan.orders].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
    for (const o of queue.slice(0, cfg.maxOrdersPerCycle)) {
      if (state.tradesToday >= cfg.maxTradesPerDay) {
        journal.push(entry("skip", `당일 매매 횟수 한도 도달로 ${o.nameKo} ${o.side === "buy" ? "매수" : "매도"} 보류`));
        break;
      }
      try {
        const res = await placeOrder(env, kisConfig(env), {
          market: "KRX",
          code: o.code,
          side: o.side,
          qty: o.qty,
          price: o.price,
          orderType: "limit",
          notionalKrw: o.notionalKrw,
        });
        state.tradesToday += 1;
        applyFill(state, o);
        results.push({ code: o.code, side: o.side, ok: true, message: res.message });
        journal.push(
          entry("order", `${o.side === "buy" ? "매수" : "매도"} ${o.nameKo}(${o.code}) ${o.qty}주 @${o.price.toLocaleString("ko-KR")}원 — ${o.reason}`, {
            dryRun: res.dryRun ?? false,
            orderNo: res.orderNo,
            근거: o.detail,
          }),
        );
      } catch (err) {
        const message = err instanceof ApiError ? `${err.message} ${JSON.stringify(err.detail ?? {})}` : String(err);
        results.push({ code: o.code, side: o.side, ok: false, message });
        journal.push(entry("error", `${o.nameKo} ${o.side === "buy" ? "매수" : "매도"} 실패 — ${message}`));
      }
    }
  }

  journal.push(
    entry("cycle", `평가 ${plan.equity.toLocaleString("ko-KR")}원 · 손익 ${plan.pnlKrw >= 0 ? "+" : ""}${plan.pnlKrw.toLocaleString("ko-KR")}원 · 위험회피 ${plan.riskOff} · ${plan.market.label}`),
  );

  await saveState(env, state);
  await appendJournal(env, journal);

  return { ran: true, executed: results.filter((r) => r.ok).length, shadow, plan, results, state };
}

/**
 * 주문 접수를 장부에 반영한다.
 * 실제 체결 확인은 다음 사이클의 잔고 조회가 해 준다 — 여기서는 낙관적으로 기록하되,
 * 잔고에 없는 수량은 buildPlan 이 `heldQty` 로 눌러 준다.
 */
function applyFill(state: AutoState, o: PlannedOrder): void {
  const pos = state.positions[o.code];
  if (o.side === "buy") {
    if (pos) {
      const totalQty = pos.qty + o.qty;
      pos.avgPrice = totalQty ? (pos.avgPrice * pos.qty + o.price * o.qty) / totalQty : o.price;
      pos.qty = totalQty;
      pos.lastAddedAt = Date.now();
      pos.reason = o.reason;
    } else {
      state.positions[o.code] = {
        code: o.code,
        nameKo: o.nameKo,
        qty: o.qty,
        avgPrice: o.price,
        enteredAt: Date.now(),
        lastAddedAt: Date.now(),
        reason: o.reason,
      };
    }
  } else if (pos) {
    // 매도分은 확정 손익으로 적립한다 (평가손익에서 빠지므로 여기서 잡아야 총액이 맞는다).
    // 왕복 거래비용 0.23% 를 차감해 낙관 편향을 없앤다.
    const qty = Math.min(o.qty, pos.qty);
    const gross = (o.price - pos.avgPrice) * qty;
    const cost = o.price * qty * 0.0023;
    state.realizedPnl = Math.round((state.realizedPnl ?? 0) + gross - cost);
    pos.qty -= o.qty;
    if (pos.qty <= 0) delete state.positions[o.code];
  }
}

/* ── 상태 요약 · 수동 제어 ─────────────────────────────── */

export function autoStatus(env: Env) {
  const cfg = autoConfig(env);
  const now = kstNow();
  return {
    config: cfg,
    kst: now,
    market: marketPhase(now),
    kisConfigured: kisConfigured(env),
    dryRun: isDryRun(env),
    universe: UNIVERSE.length,
  };
}

/** 정지 해제 (사람이 확인한 뒤에만) */
export async function resumeAuto(env: Env): Promise<AutoState> {
  const state = await loadState(env);
  state.haltedPermanent = false;
  state.haltedDay = "";
  state.haltReason = "";
  await saveState(env, state);
  await appendJournal(env, [entry("resume", "정지 해제 — 다음 사이클부터 매매를 재개합니다.")]);
  return state;
}

/** 포지션 장부 초기화 (계좌를 직접 정리한 뒤 봇 장부만 맞출 때) */
export async function resetLedger(env: Env): Promise<AutoState> {
  const state = emptyState(kstNow());
  await saveState(env, state);
  await appendJournal(env, [entry("resume", "포지션 장부 초기화 — 봇 기준 보유 종목이 모두 비워졌습니다.")]);
  return state;
}
