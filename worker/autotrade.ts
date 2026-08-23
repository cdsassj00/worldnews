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
 *
 * ── 기다리는 매매 원칙 (2026-08-21 사용자 지시로 규칙화) ──────────────
 * 실계좌 6일치 실측에서 확정 손실(-399,224원)이 평가 손실(-80,847원)의 5배였다.
 * 손절당한 3종목 중 2종목이 판 뒤 올랐다(NAVER +6.6%, 한화오션 +2.3%).
 * 즉 방향은 맞았는데 진입이 며칠 일렀고, 그 흔들림에서 팔아 손실을 굳혔다.
 * 그래서 두 축을 함께 고정한다 — 어느 하나만 바꾸면 반대쪽이 무너진다.
 *
 *   A) 적게 사고 제대로 산다 — 매수 문턱 BUY_SCORE 0.35.
 *      백테스트 검증본(QK)과 미국 봇(US_BUY_SCORE)이 쓰는 값이다.
 *      직전까지 한국 봇만 0.15 였고, 그 값으로는 백테스트를 한 적이 없다.
 *   B) 한 번 샀으면 흔들림을 견딘다 — 손절 -7%(AUTO_STOP_LOSS_PCT).
 *      -5% 는 한국 주식 이틀 변동에 닿는다. 실측 비교(shared/backtest-results.json
 *      liveRuleComparison)에서 -7% 가 -5% 보다 3개월·6개월·1년 세 구간 모두 우위
 *      였다(1년 +43.5% vs +27.8%).
 *
 * 이 원칙은 "매매를 줄인다"는 뜻이 아니다. 횟수 한도(AUTO_MAX_TRADES_PER_DAY)는
 * 그대로 열려 있다. 아무거나 사지 않고, 산 것은 성급히 놓지 않는다는 뜻이다.
 */
import type { Env } from "./env";
import { isKrxHoliday } from "./holidays";
import { UNIVERSE, roundToTick } from "../shared/ontology";
import { runStrategy, type StrategyResult, type TickerScore } from "./strategy";
import { quantRank, usMarketOpen } from "./quant";
import {
  domesticBalance,
  domesticPrice,
  domesticPsamount,
  isDryRun,
  kisConfig,
  kisConfigured,
  overseasUsBalanceAll,
  placeOrder,
  type Holding,
} from "./kis";
import { ApiError, cached, num, round } from "./util";
import { getScalpClaims, getScalpPct, scalpView, type ScalpView } from "./scalptrade";
import { strategyLocked, strategyPreference } from "../shared/strategy-settings";

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

/** 매수 진입 점수 하한 — 어중간한 신호로는 들어가지 않는다.
 * 0.35 는 백테스트 검증본(QK: 저회전+시장필터)과 미국 봇이 함께 쓰는 값이다.
 * 2026-08-21 이전에는 한국 봇만 0.15 였다 — 그 문턱은 측정된 적이 없고, 약한
 * 신호로 산 종목이 며칠 안에 흔들려 손절로 빠지는 경로를 만들었다. */
const BUY_SCORE = 0.35;
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

export interface PendingDomesticOrder {
  orderNo: string;
  acceptedAt: number;
  side: "buy" | "sell";
  code: string;
  nameKo: string;
  qty: number;
  limitPrice: number;
  beforeQty: number;
  beforeAvgPrice: number;
  appliedQty: number;
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
  /** 직전 사이클의 종목별 보유 수량 — 수량 그대로 + 현금만 변화 = 입출금으로 판정 */
  qtySnapshot?: Record<string, number>;
  /** 봇이 매도로 확정한 누적 손익(원). 평가손익과 합쳐 진짜 손익을 만든다. */
  realizedPnl?: number;
  /** 손익 기준 고점·당일 시작값 — 정지선 판정에 쓴다(평가액 대신) */
  peakPnl?: number;
  dayStartPnl?: number;
  /** 내가 이 계좌에 넣은 돈의 총액(원). 수익 = 현재 평가금액 − 이 값. */
  totalDepositKrw?: number;
  /** KIS가 접수했지만 아직 잔고 변화로 체결을 확인하지 못한 주문. */
  pendingOrders?: PendingDomesticOrder[];
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
  const state: AutoState = { ...emptyState(now), ...raw, positions: raw.positions ?? {}, pendingOrders: raw.pendingOrders ?? [] };

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
   * 수익은 "지금 계좌 평가금액 − 이 값"으로 계산한다. 이후 입출금은
   * runCycle 이 자동 감지하고, 수동 보정은 /api/auto/deposit. */
  if (state.totalDepositKrw === undefined) {
    state.totalDepositKrw = 6_000_000;
    await saveState(env, state);
  }

  /* 1회성 보정(2026-08-17): 08-16 미국주식용 입금 +400만은 자동 감지 코드 배포 전에
   * 들어와 소급 감지가 안 된다 — 사용자 신고값으로 반영한다.
   * 검산: 계좌 10,102,433 = 주식 5,906,260 + 현금 4,196,173 ≒ 입금 1,000만 + 수익 10.2만. */
  const ADJ3 = "deposit-2026-08-16-us4m";
  if (!state.depositAdjustments?.[ADJ3]) {
    state.depositAdjustments = { ...(state.depositAdjustments ?? {}), [ADJ3]: 4_000_000 };
    state.totalDepositKrw = (state.totalDepositKrw ?? 6_000_000) + 4_000_000;
    state.baselineEquity += 4_000_000;
    if (state.dayStartEquity > 0) state.dayStartEquity += 4_000_000;
    await saveState(env, state);
    await appendJournal(env, [
      entry("cycle", "입금 반영 — 08-16 미국주식용 원화 +4,000,000원. 넣은 돈 10,000,000원, 이 중 4,000,000원은 미국 매수 대기 자금으로 국내 예산에서 제외합니다."),
    ]);
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

export async function appendJournal(env: Env, entries: JournalEntry[]): Promise<void> {
  if (!entries.length) return;
  const prev = await getJournal(env);
  const next = [...entries, ...prev].slice(0, JOURNAL_MAX);
  await env.CACHE.put(JOURNAL_KEY, JSON.stringify(next)).catch(() => undefined);
}

export function entry(kind: JournalEntry["kind"], text: string, detail?: unknown): JournalEntry {
  return { at: Date.now(), kstDate: kstNow().date, kind, text, detail };
}

/* ── 계좌 ─────────────────────────────────────────────── */

export interface AccountView {
  connected: boolean;
  reason: string;
  /** KIS 국내 잔고 API를 실제로 읽은 시각 */
  fetchedAt: number;
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
    return { connected: false, reason: "KIS 시크릿이 등록되지 않아 계좌를 읽지 못했습니다.", fetchedAt: 0, cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
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
        fetchedAt: Date.now(),
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
  return { connected: false, reason: `계좌 조회 실패: ${message}`, fetchedAt: 0, cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
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
  /** 신규 진입 전용 게이트. 손절·익절 매도는 이 게이트와 무관하게 계속 보호한다. */
  entryGate: { canBuy: boolean; reasons: string[] };
  account: AccountView;
  equity: number;
  deployedKrw: number;
  budgetKrw: number;
  /** 미국 배분(예약 현금) — 국내 매수 예산에서 제외되는 몫 */
  reserveKrw: number;
  pnlKrw: number;
  /** 한국 실현손익 누적 */
  realizedKrw: number;
  /** 봇이 산 종목만의 손익 — 기존 보유분과 섞이지 않게 분리해서 보여준다 */
  botPnlKrw: number;
  /** 계좌에 원래 있던(봇이 사지 않은) 종목의 손익 */
  otherPnlKrw: number;
  /** 내가 넣은 돈(입금 총액) */
  depositKrw: number;
  /** 순수익 = 현재 평가금액 − 입금 총액 */
  netProfitKrw: number;
  netProfitPct: number;
  /** 계좌 전체 성과. 보유 평가손익이나 봇 내부 장부와 구분한다. */
  performance: {
    complete: boolean;
    netContributionsKrw: number;
    currentAssetsKrw: number;
    cumulativePnlKrw: number;
    cumulativePnlPct: number;
    holdingsPnlKrw: number;
    botLedgerPnlKrw: number;
    reconciliationKrw: number;
    assetsAsOf: number;
    contributionsAsOf: string;
    contributionsSource: string;
  };
  /** 기존 저회전 예산 안에서 따로 떼어 둔 분봉 단타 트랙 */
  scalp: ScalpView;
  /** 주식에 들어가 있는 돈 / 현금으로 남은 돈 */
  investedKrw: number;
  /** 그중 미국 보유분(미국 봇 원장 × 환율) */
  usValueKrw: number;
  /** 증권사 원화 주문가능현금 원본 — 결제 이동분이 포함될 수 있어 표시 현금과 다를 수 있다 */
  bankCashKrw: number;
  cashKrw: number;
  /** 미국 봇 요약 — 값은 전부 KIS 해외 잔고 스냅샷(auto:us:balance) 실측 */
  us: {
    enabled: boolean;
    /** 미국 봇의 매매 엔진 — 한국(engine)과 별개 */
    engine: string;
    engineName: string;
    marketOpen: boolean;
    budgetKrw: number;
    valueKrw: number;
    /** KIS 잔고 조회 시각 — 이 시점 기준 값임을 화면에 밝힌다 */
    balanceAt: number;
    fx: number;
    /** 보유 평가손익(원) — KIS 제공 */
    pnlKrw: number;
    /** 봇 실현손익 누적(원) */
    realizedKrw: number;
    positions: { code: string; name: string; qty: number; avgPriceUsd: number; priceUsd: number; pnlPct: number; valueKrw: number }[];
  };
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
  const locked = strategyLocked(env.AUTO_ENGINE_LOCKED);
  const [first, second] = strategyPreference(locked, env.AUTO_ENGINE, await env.CACHE.get(ENGINE_KEY));
  return parseEngineValue(first)
    ?? parseEngineValue(second)
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

/* ── 미국 결제 대기 현금흐름 ─────────────────────────────
 * 미국 주문(통합증거금)은 원화 예수금에서 나중에 결제된다 — 그 순간 "보유 수량은
 * 그대로인데 현금만 크게 줄어" 입출금 자동 감지가 출금으로 오인한다. 미국 봇이
 * 주문할 때 예상 현금흐름(매수 +, 매도 −)을 여기 적어 두고, 감지가 그만큼을
 * 입출금이 아니라 미국 결제로 설명한다. */
const US_CASHFLOW_KEY = "auto:us:cashflow";

export async function getUsCashflowKrw(env: Env): Promise<number> {
  const raw = await env.CACHE.get(US_CASHFLOW_KEY).catch(() => null);
  const v = raw === null ? 0 : Number(raw);
  return Number.isFinite(v) ? v : 0;
}

export async function addUsCashflowKrw(env: Env, deltaKrw: number): Promise<void> {
  const cur = await getUsCashflowKrw(env);
  await env.CACHE.put(US_CASHFLOW_KEY, String(Math.round(cur + deltaKrw))).catch(() => undefined);
}

async function setUsCashflowKrw(env: Env, krw: number): Promise<void> {
  await env.CACHE.put(US_CASHFLOW_KEY, String(Math.round(krw))).catch(() => undefined);
}

/* ── 미국 배분(예약 현금) — 국내 매수 예산에서 빼 두는 몫. 대시보드 슬라이더로 조절 ── */
const RESERVE_KEY = "auto:reserve";

export async function getReserveKrw(env: Env): Promise<number> {
  const raw = await env.CACHE.get(RESERVE_KEY).catch(() => null);
  const kv = raw === null ? NaN : Number(raw);
  return Math.max(0, Number.isFinite(kv) ? kv : num(env.AUTO_RESERVE_KRW, 0));
}

export async function setReserveKrw(env: Env, krw: number): Promise<number> {
  const v = Math.round(Math.max(0, Math.min(50_000_000, Number(krw) || 0)));
  await env.CACHE.put(RESERVE_KEY, String(v)).catch(() => {
    throw new ApiError(503, "kv_write_limit", { hint: "설정 저장 실패 — Cloudflare 저장(KV) 하루 쓰기 한도가 소진됐습니다. 오전 9시(KST) 리셋 후 다시 시도하세요." });
  });
  return v;
}

export async function setEngine(env: Env, input: { engine?: string; weights?: Partial<EngineWeights> }): Promise<EngineSel> {
  if (strategyLocked(env.AUTO_ENGINE_LOCKED)) {
    throw new ApiError(409, "engine_locked", { hint: "최근 장세 검증을 통과한 국내 QK 엔진이 배포 설정으로 고정되어 있습니다." });
  }
  let sel: EngineSel;
  if (input.weights) {
    sel = selFromWeights(normWeights(input.weights));
  } else {
    const preset = parseEngineValue(String(input.engine ?? ""));
    if (!preset) throw new ApiError(400, "bad_engine", { engine: input.engine, allowed: AUTO_ENGINES.map((e) => e.id) });
    sel = preset;
  }
  await env.CACHE.put(ENGINE_KEY, sel.id === "custom" ? `w:${sel.w.onto},${sel.w.flow},${sel.w.chart}` : sel.id).catch(() => {
    // 무료 요금제 KV 쓰기 한도(1,000회/일, 00:00 UTC 리셋) 소진이 대표 원인
    throw new ApiError(503, "kv_write_limit", { hint: "설정 저장 실패 — Cloudflare 저장(KV) 하루 쓰기 한도가 소진됐습니다. 오전 9시(KST) 리셋 후 다시 시도하세요." });
  });
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
): Promise<{ scores: TickerScore[]; note: string; available: boolean }> {
  const { w } = sel;
  const mixKo = `온톨로지 ${w.onto}% · 수급 ${w.flow}% · 차트 ${w.chart}%`;
  if (w.flow === 0 && w.chart === 0) {
    const onto = scores.map((s) => ({ ...s, score: s.ontologyScore })).sort((a, b) => b.score - a.score);
    return { scores: onto, note: "검증본 QK와 동일하게 온톨로지 점수만으로 순위를 정합니다.", available: onto.length > 0 };
  }

  let rows: { code: string; score: number; taScore?: number }[] = [];
  try {
    rows = (await quantRank(env, "breakout", 400)).rows.map((r) => ({ code: r.code, score: r.score, taScore: r.taScore }));
  } catch {
    return { scores: [], note: `요청한 조합의 수급·차트 점수를 불러오지 못해 신규매수를 차단했습니다 (${mixKo}).`, available: false };
  }
  const byCode = new Map(rows.map((r) => [r.code, r]));
  if (!byCode.size) return { scores: [], note: `요청한 조합의 수급·차트 결과가 없어 신규매수를 차단했습니다 (${mixKo}).`, available: false };

  const out: TickerScore[] = [];
  let covered = 0;
  for (const s of scores) {
    const q = byCode.get(s.code);
    // 실거래 조합은 요청한 축이 하나라도 없으면 후보에서 제외한다. 결측 축을 버리고
    // 남은 점수를 100%로 재정규화하면 화면의 조합과 실제 주문 판단이 달라진다.
    if (w.flow > 0 && q?.score === undefined) continue;
    if (w.chart > 0 && q?.taScore === undefined) continue;
    const comps: { wgt: number; val: number }[] = [];
    if (w.onto > 0) comps.push({ wgt: w.onto, val: s.ontologyScore });
    if (w.flow > 0) comps.push({ wgt: w.flow, val: q!.score });
    if (w.chart > 0) comps.push({ wgt: w.chart, val: q!.taScore! });
    const denom = comps.reduce((a, c) => a + c.wgt, 0);
    if (denom <= 0) continue; // 이 종목엔 이 조합을 매길 정보가 없다
    if (q) covered++;
    const mixed = comps.reduce((a, c) => a + c.wgt * c.val, 0) / denom;
    out.push({ ...s, score: round(mixed, 3) });
  }
  out.sort((a, b) => b.score - a.score);
  const available = out.length > 0;
  return {
    scores: out,
    note: available
      ? `${mixKo} 가중 평균으로 순위를 정합니다 (모든 요청 축이 있는 종목 ${covered}개).`
      : `${mixKo} 조합의 모든 축을 갖춘 종목이 없어 신규매수를 차단했습니다.`,
    available,
  };
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
  const pendingCodes = new Set((state.pendingOrders ?? []).map((o) => o.code));

  /* 운용 한도: AUTO_CAPITAL_KRW=0 이면 "넣은 돈 전액"을 자동 추종한다.
   * 2026-08-17 사용자 지시: "계좌에 있는 모든 돈은 다 봇이 컨트롤한다." */
  if (cfg.capitalKrw <= 0) cfg.capitalKrw = Math.max(2_000_000, Math.round(state.totalDepositKrw ?? 0));
  /* 예약 현금 — 국내 매수 예산에서 빼 두는 몫 (미국주식 대기 자금). KV 슬라이더 값 우선 */
  const [reserveKrw, scalpPct, scalpClaims] = await Promise.all([getReserveKrw(env), getScalpPct(env), getScalpClaims(env)]);
  const scalpKrTargetKrw = Math.round(Math.max(0, cfg.capitalKrw - reserveKrw) * scalpPct / 100);

  /* 미국 보유분(별도 원장) 평가액 — 국내 잔고 조회에는 잡히지 않으므로 총평가·투자금에
   * 더한다. 안 더하면 미국 매수 대금이 결제되는 날 '수익'이 −400만처럼 보인다.
   * 값·환율은 미국 사이클이 저장한 최신 관측값(장 마감 중엔 마지막 값)을 쓴다. */
  /* ── 미국 실측 스냅샷 (auto:us:balance — KIS 해외 잔고 그대로) ──────────
   * 2026-08-18 사용자 보고("수익 -748,587원, 계산이 맞냐")의 교훈: 결제 대기·현금
   * 흐름을 추정으로 맞추려 하면 한국 D+2 정산·미국 결제·매도 대금이 겹치는 순간
   * 반드시 어긋난다. 그래서 수익은 아래에서 **보유 평가손익+실현손익의 합**(전부
   * KIS·체결 실측값)으로만 계산하고, 현금·결제 이동은 손익 계산에서 아예 뺀다. */
  type UsSnap = {
    at: number;
    fx: number;
    holdings: { symbol: string; name: string; qty: number; avgPrice: number; price: number; pnl: number; evalAmount: number }[];
    totalEvalUsd: number;
    holdingsPnlUsd: number;
    realizedPnlUsd: number;
  };
  let usSnap: UsSnap | null = null;
  try {
    usSnap = (await env.CACHE.get("auto:us:balance", "json")) as UsSnap | null;
  } catch { /* 스냅샷 없으면 미국 0 취급 */ }
  /* 미국 사이클은 장 마감이면 잔고 조회 전에 종료하므로 주말에는 스냅샷이 며칠씩
   * 낡을 수 있다. 자동매매 화면을 열 때 10분 넘은 값이면 주문 없이 잔고만 KIS에서
   * 다시 읽는다. 계획 API 자체가 45초 캐시되어 과도한 호출도 막는다. */
  if (kisConfigured(env) && (!usSnap?.at || Date.now() - usSnap.at > 10 * 60_000)) {
    try {
      const liveUs = await overseasUsBalanceAll(env, kisConfig(env));
      usSnap = {
        at: Date.now(),
        fx: usSnap?.fx && usSnap.fx > 800 ? usSnap.fx : 1400,
        holdings: liveUs.holdings,
        totalEvalUsd: round(liveUs.holdings.reduce((s, h) => s + (h.evalAmount || h.qty * h.price), 0), 2),
        holdingsPnlUsd: round(liveUs.holdings.reduce((s, h) => s + (h.pnl || 0), 0), 2),
        realizedPnlUsd: usSnap?.realizedPnlUsd ?? 0,
      };
      await env.CACHE.put("auto:us:balance", JSON.stringify(usSnap)).catch(() => undefined);
    } catch {
      /* KIS가 닫혔거나 유량 제한이면 마지막 성공값을 유지하고 시각으로 오래됨을 밝힌다. */
    }
  }
  const usEngineLocked = (env.US_ENGINE_LOCKED ?? "false").toLowerCase() === "true";
  const usEngineKv = await env.CACHE.get("auto:us:engine").catch(() => null);
  const usEngineRaw = (usEngineLocked ? env.US_ENGINE ?? usEngineKv : usEngineKv ?? env.US_ENGINE) ?? "onto";
  const usEngineId = ["onto", "quant", "ta", "fusion"].includes(usEngineRaw) ? usEngineRaw : "onto";
  const usFx = usSnap?.fx && usSnap.fx > 800 ? usSnap.fx : 1400;
  const usValueKrw = usSnap ? Math.round(usSnap.totalEvalUsd * usFx) : 0;
  /** 미국 손익(원) = KIS 평가손익 + 봇 실현손익 */
  const usPnlKrw = usSnap ? Math.round((usSnap.holdingsPnlUsd + (usSnap.realizedPnlUsd || 0)) * usFx) : 0;

  const deployed = deployedValue(state, priceOf);
  const budget = Math.max(0, cfg.capitalKrw - reserveKrw - scalpKrTargetKrw - deployed);

  /* 손익은 "평가액 − 기준선"이 아니라 **보유 종목 평가손익 + 실현손익**으로 잰다.
   * 평가액 기반은 입출금·D+2 정산으로 총평가가 출렁일 때마다 가짜 손익을 만들었다
   * (2026-08-03 입금 400만이 +390만 수익으로, 08-05 정산 이동이 +189만 수익으로 계상).
   * 종목 평가손익은 계좌가 직접 주는 값이라 돈이 들어오고 나가도 흔들리지 않는다. */
  const holdingsPnl = account.connected ? account.holdings.reduce((sum, h) => sum + (h.pnl || 0), 0) : 0;
  const pnl = account.connected ? holdingsPnl + (state.realizedPnl ?? 0) : state.realizedPnl ?? 0;

  /* 전체 수익(한국+미국) — 전부 실측: 한국 보유 평가손익(KIS) + 한국 실현손익(체결가)
   * + 미국 평가손익(KIS) + 미국 실현손익(체결가). 현금·결제 이동은 여기 안 들어간다.
   * '계좌' 표시값도 잔고 합산이 아니라 넣은 돈 + 이 수익으로 만든다 — 결제가 이동
   * 중인 순간에도 수익이 절대 출렁이지 않는다(2026-08-18 -748,587원 왜곡의 재발 방지). */
  const netProfit = pnl + usPnlKrw;
  const equity = Math.round((state.totalDepositKrw ?? 0) + netProfit);

  /* 게이트 — 하나라도 막히면 매수는 나가지 않는다 */
  const blocked: string[] = [];
  if (!cfg.enabled) blocked.push("AUTOTRADE_ENABLED=false — 계획만 세우고 주문은 보내지 않습니다.");
  if (!phase.open) blocked.push(phase.label);
  if (!account.connected) blocked.push(account.reason);
  if (state.haltedPermanent) blocked.push(`영구 정지: ${state.haltReason} (수동 해제 필요)`);
  if (state.haltedDay === now.date) blocked.push(`당일 정지: ${state.haltReason}`);
  if (state.tradesToday >= cfg.maxTradesPerDay) blocked.push(`당일 매매 횟수 한도(${cfg.maxTradesPerDay}회) 도달`);

  /* 신규 진입은 시초가 잡음·현재 국면·데이터 신선도를 별도로 통과해야 한다.
   * 이 게이트는 손절·익절 매도를 막지 않는다. */
  const entryBlocked: string[] = [];
  const ENTRY_MIN = 9 * 60 + 30;
  if ((env.AUTO_NEW_BUYS_ENABLED ?? "true").toLowerCase() !== "true") {
    entryBlocked.push("최근 1·3·6개월 검증 미통과 — 국내 신규매수 잠금");
  }
  if (now.minutes < ENTRY_MIN) entryBlocked.push(`시초가 유예 — 09:30 KST 이후 신규매수`);
  if (strategy.marketRegime.defensive) {
    entryBlocked.push(`코스피 방어 국면 — 20일선 아래·20일 모멘텀 ${strategy.marketRegime.momentum20Pct}%`);
  }
  if (!engineApplied.available) entryBlocked.push("선택 엔진의 필수 데이터가 없어 신규매수 차단");
  const dataAgeMs = strategy.dataAsOf ? Date.now() - strategy.dataAsOf : Number.POSITIVE_INFINITY;
  if (phase.open && dataAgeMs > 20 * 60_000) entryBlocked.push("전략 시세가 20분 이상 지연되어 신규매수 차단");

  const targetHit = pnl >= cfg.targetProfitKrw && cfg.targetProfitKrw > 0;
  if (targetHit) blocked.push(`목표 수익 ${cfg.targetProfitKrw.toLocaleString("ko-KR")}원 달성 — 신규 매수 중단`);

  const notes: string[] = [];
  const orders: PlannedOrder[] = [];
  /** 점수는 높지만 자본·한도 때문에 못 산 종목 */
  const skipped: string[] = [];

  /* 1) 청산 판단 — 봇이 산 종목만 대상으로 한다 */
  const positionView: AutoPlan["positions"] = [];
  for (const pos of Object.values(state.positions)) {
    if (pendingCodes.has(pos.code)) continue;
    const held = heldQty.get(pos.code) ?? 0;
    const sc = scoreByCode.get(pos.code);
    // 보유분의 손절·익절은 Yahoo 후보 시세보다 KIS 계좌 현재가를 우선한다.
    const price = acctPrice.get(pos.code) ?? sc?.price ?? pos.avgPrice;
    const pnlPct = pos.avgPrice ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : 0;
    positionView.push({ ...pos, price, pnlPct: round(pnlPct, 2), heldQty: held });

    // 계좌가 연결돼 있으면 계좌 보유량이 진실이다. held=0 인데 상태 수량으로
    // 폴백하면(예전 코드) 계좌에 없는 주식을 무한 재매도 시도하게 된다.
    const qty = account.connected ? Math.min(pos.qty, held) : pos.qty;
    if (qty <= 0) continue;

    let why = "";
    if (pnlPct <= -cfg.stopLossPct) why = `손절 (${round(pnlPct, 1)}% ≤ -${cfg.stopLossPct}%)`;
    else if (pnlPct >= cfg.takeProfitPct) why = `익절 (${round(pnlPct, 1)}% ≥ +${cfg.takeProfitPct}%)`;
    else if (
      now.minutes >= ENTRY_MIN && engineApplied.available && sc?.asOf && Date.now() - sc.asOf <= 20 * 60_000 && sc.score <= SELL_SCORE
    ) why = `신호 이탈 (점수 ${sc.score})`;
    else if (now.minutes >= ENTRY_MIN && dataAgeMs <= 20 * 60_000 && strategy.riskOff >= 0.8) why = `시장 위험회피 ${strategy.riskOff} — 비중 축소`;
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
  if (!targetHit && entryBlocked.length === 0) {
    for (const sc of strategy.scores) {
      if (orders.filter((o) => o.side === "buy").length >= cfg.maxOrdersPerCycle) break;
      if (sc.score < BUY_SCORE) break; // 점수 내림차순이라 여기서 끊어도 된다
      if (!sc.asOf || Date.now() - sc.asOf > 20 * 60_000) {
        skipped.push(`${sc.nameKo} 시세 지연으로 제외`);
        continue;
      }
      // 확장 유니버스는 분석·표시 전용이다. 거래량·ATR 없는 데이터에 돈을 태우지 않는다.
      if (!coreCodes.has(sc.code)) continue;
      if (scalpClaims.KR.has(sc.code)) continue;
      if (pendingCodes.has(sc.code)) continue;
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
  if (entryBlocked.length) notes.push(`신규매수 차단: ${entryBlocked.join(" · ")}`);
  if (skipped.length) notes.push(`자금 한도로 제외: ${skipped.join(" · ")}`);
  if (deployed > 0) notes.push(`운용 투입 ${Math.round(deployed).toLocaleString("ko-KR")}원 / 한도 ${cfg.capitalKrw.toLocaleString("ko-KR")}원`);
  if (reserveKrw > 0) notes.push(`미국 배분 ${reserveKrw.toLocaleString("ko-KR")}원은 국내 매수 예산에서 제외합니다(미국 자동매매 예산).`);
  if (usSnap) notes.push(`미국 보유분 ${usValueKrw.toLocaleString("ko-KR")}원은 KIS 해외 잔고 실측값입니다(환율 ${usFx.toLocaleString("ko-KR")}원, ${new Date(usSnap.at).toISOString().slice(11, 16)}Z 조회).`);
  if (isDryRun(env)) notes.push("ORDER_DRY_RUN=true — 주문은 검증만 하고 전송되지 않습니다.");

  /* 봇 성과와 기존 보유분을 분리한다. 계좌 전체 손익만 보면 봇이 잘하고 있어도
   * 원래 갖고 있던 종목의 등락에 묻혀 판단이 안 된다. 봇 지분은 계좌 보유 수량 중
   * 봇 장부 수량만큼을 비례 배분해 계산한다. */
  const deposit = state.totalDepositKrw ?? 0;
  /* 계좌 전체 누적손익의 유일한 대표값.
   * 외부에서 넣은 순현금 1,000만원과 KIS 현재 순자산을 비교한다. 배당·예탁금이용료는
   * 원금이 아니라 계좌 안에서 생긴 수익이므로 현재 자산 쪽에만 포함된다. */
  const currentAssets = account.connected && usSnap?.at
    ? Math.round(account.totalEval + usValueKrw)
    : 0;
  const cumulativePnl = currentAssets ? currentAssets - deposit : 0;
  const holdingsPnlAll = Math.round(holdingsPnl + (usSnap ? usSnap.holdingsPnlUsd * usFx : 0));
  const botLedgerPnl = Math.round(netProfit);
  const scalp = await scalpView(env, deposit, account.connected ? account.cash : 0, usValueKrw);

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
    entryGate: { canBuy: blocked.length === 0 && entryBlocked.length === 0 && !targetHit, reasons: [...blocked, ...entryBlocked] },
    account,
    equity: Math.round(equity),
    deployedKrw: Math.round(deployed),
    budgetKrw: Math.round(budget),
    reserveKrw: Math.round(reserveKrw),
    pnlKrw: Math.round(pnl),
    /** 한국 실현손익 누적(체결가 기준) — 화면에서 보유 평가/실현 분해에 쓴다 */
    realizedKrw: Math.round(state.realizedPnl ?? 0),
    botPnlKrw: Math.round(botPnl),
    otherPnlKrw: Math.round(pnl - botPnl),
    /* 사용자가 실제로 궁금한 네 숫자: 넣은 돈 / 주식 / 현금 / 수익.
     * 수익 = 한국 평가손익(KIS) + 한국 실현손익 + 미국 평가손익(KIS) + 미국 실현손익.
     * 잔고 합산·결제 추정은 쓰지 않는다 — '계좌'는 넣은 돈 + 수익으로 표시한다. */
    depositKrw: Math.round(deposit),
    netProfitKrw: Math.round(cumulativePnl),
    netProfitPct: deposit > 0 && currentAssets ? round((cumulativePnl / deposit) * 100, 2) : 0,
    performance: {
      complete: Boolean(account.connected && usSnap?.at),
      netContributionsKrw: Math.round(deposit),
      currentAssetsKrw: currentAssets,
      cumulativePnlKrw: Math.round(cumulativePnl),
      cumulativePnlPct: deposit > 0 && currentAssets ? round((cumulativePnl / deposit) * 100, 2) : 0,
      holdingsPnlKrw: holdingsPnlAll,
      botLedgerPnlKrw: botLedgerPnl,
      reconciliationKrw: currentAssets ? Math.round(cumulativePnl - botLedgerPnl) : 0,
      assetsAsOf: Math.min(account.fetchedAt || Date.now(), usSnap?.at || Date.now()),
      contributionsAsOf: "2026-08-24",
      contributionsSource: "순수 현금 입금 확인값",
    },
    scalp,
    investedKrw: Math.round((account.connected ? account.stockEval : deployed) + usValueKrw),
    usValueKrw,
    /* 미국 봇 요약 — 전부 KIS 해외 잔고 스냅샷(auto:us:balance) 실측값.
     * 엔진은 KV 직접 읽기 — autotrade-us 를 import 하면 순환 참조가 된다. */
    us: {
      enabled: (env.US_AUTOTRADE_ENABLED ?? "false").toLowerCase() === "true",
      engine: usEngineId,
      engineName: ({ onto: "온톨로지", quant: "수급", ta: "차트", fusion: "융합" } as Record<string, string>)[usEngineId] ?? usEngineId,
      marketOpen: usMarketOpen(),
      budgetKrw: Math.round(reserveKrw),
      valueKrw: usValueKrw,
      balanceAt: usSnap?.at ?? 0,
      fx: usFx,
      pnlKrw: usSnap ? Math.round(usSnap.holdingsPnlUsd * usFx) : 0,
      realizedKrw: usSnap ? Math.round((usSnap.realizedPnlUsd || 0) * usFx) : 0,
      positions: (usSnap?.holdings ?? []).map((h) => ({
        code: h.symbol,
        name: h.name || h.symbol,
        qty: h.qty,
        avgPriceUsd: round(h.avgPrice, 2),
        priceUsd: round(h.price, 2),
        pnlPct: h.avgPrice ? round(((h.price - h.avgPrice) / h.avgPrice) * 100, 2) : 0,
        valueKrw: Math.round((h.evalAmount || h.qty * h.price) * usFx),
      })),
    },
    /* 현금 = 계좌 − 주식 (결제가 다 끝난 뒤 남을 현금). 이렇게 정의해야
     * 주식+현금=계좌가 **항상** 성립한다 — 예수금 원본을 그대로 보여주면 아직
     * 안 빠져나간 미국 매수 대금이 '미국 주식'과 이중으로 보여 합계가 어긋난다
     * (2026-08-19 사용자 보고: 구성 합 1,339만 vs 계좌 970만). 추정이 아니라
     * 항등식(계좌−주식)이라 결제가 진행되어도 스스로 맞아 들어간다.
     * 예수금 원본은 bankCashKrw 로 따로 내려 화면 설명에 쓴다. */
    cashKrw: Math.max(0, Math.round(equity - ((account.connected ? account.stockEval : deployed) + usValueKrw))),
    bankCashKrw: Math.round(account.connected ? account.cash : 0),
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

  /* 주문 접수와 체결을 분리한다. 직전 주문 뒤 실제 KIS 보유수량이 변한 만큼만
   * 장부에 반영한다. 미체결·부분체결이면 나머지는 pending 으로 남아 중복주문을 막는다. */
  reconcilePendingDomesticOrders(state, plan.account.holdings, journal);

  /* 입출금 자동 감지 — 보유 수량은 그대로인데 현금만 크게 변했다면 매매로 설명이
   * 안 되는 돈이 들어오거나 나간 것이다(입금·출금). 넣은 돈(수익 계산 기준)에 자동
   * 반영한다. 2026-08-17 사용자 지시: "계좌의 모든 돈은 봇이 컨트롤한다 — 수동 신고는 이상하다."
   * 배당·수수료 수준의 잔변동은 오탐을 피하려고 30만원 미만은 무시한다. 수동 보정
   * API(/api/auto/deposit)는 감지가 놓친 경우의 비상용으로만 남아 있다(버튼 없음). */
  if (plan.account.connected && state.lastCash !== undefined && state.qtySnapshot) {
    const qtyNow = Object.fromEntries(plan.account.holdings.map((h) => [h.symbol, h.qty]));
    const sameQty =
      Object.keys(qtyNow).length === Object.keys(state.qtySnapshot).length &&
      Object.entries(qtyNow).every(([k, v]) => state.qtySnapshot![k] === v);
    let delta = plan.account.cash - state.lastCash;
    if (sameQty && Math.abs(delta) >= 300_000) {
      /* 미국 주문 결제분 먼저 설명한다 — 미국 매수(통합증거금)는 국내 수량 변화 없이
       * 원화만 빠지므로, 여기서 걸러내지 않으면 출금으로 오인해 넣은 돈을 깎는다. */
      const usPending = await getUsCashflowKrw(env); // 매수 + / 매도 −  (예상 원화 유출)
      if (usPending !== 0 && Math.sign(delta) === -Math.sign(usPending)) {
        const explained = Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(usPending));
        delta -= explained;
        await setUsCashflowKrw(env, usPending + explained); // 설명된 만큼 대기분에서 지운다
        journal.push(
          entry("cycle", `미국 주문 결제 ${explained < 0 ? "" : "+"}${Math.round(explained).toLocaleString("ko-KR")}원 확인 — 입출금이 아니라 미국 ${explained < 0 ? "매수 대금" : "매도 대금"}입니다.`),
        );
      }
    }
    if (sameQty && Math.abs(delta) >= 300_000) {
      state.totalDepositKrw = Math.max(0, (state.totalDepositKrw ?? 0) + delta);
      state.baselineEquity += delta;
      if (state.dayStartEquity > 0) state.dayStartEquity += delta;
      if (delta > 0 && state.targetReachedAt) state.targetReachedAt = 0;
      journal.push(
        entry(
          "cycle",
          `${delta > 0 ? "입금" : "출금"} 자동 감지 ${delta > 0 ? "+" : ""}${Math.round(delta).toLocaleString("ko-KR")}원 — 넣은 돈 ${Math.round(state.totalDepositKrw).toLocaleString("ko-KR")}원으로 갱신했습니다.`,
        ),
      );
    }
  }

  /* 상태 갱신: 일자 롤오버 · 고점 · 정지 판정 */
  if (state.day !== now.date) {
    state.day = now.date;
    state.dayStartEquity = plan.equity;
    state.dayStartPnl = plan.pnlKrw; // 당일 정지선의 기준점
    state.tradesToday = 0;
  }
  if (!state.baselineEquity && plan.equity > 0) state.baselineEquity = plan.equity;
  if (plan.account.connected) {
    state.lastCash = plan.account.cash;
    state.qtySnapshot = Object.fromEntries(plan.account.holdings.map((h) => [h.symbol, h.qty]));
  }

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
  const scalpClaimsForReconcile = await getScalpClaims(env);

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
      if (scalpClaimsForReconcile.KR.has(h.symbol)) continue;
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
        // 전송 직전에 KIS 현재가로 지정가를 다시 만든다. 후보 선정은 일봉이지만
        // 실제 주문 가격까지 Yahoo 지연 시세에 의존하지 않게 한다.
        if (!isDryRun(env)) {
          const live = await domesticPrice(env, kisConfig(env), o.code).catch(() => null);
          if (!live?.price) {
            journal.push(entry("skip", `${o.nameKo} 주문 보류 — KIS 현재가 확인 실패`));
            results.push({ code: o.code, side: o.side, ok: false, message: "KIS 현재가 확인 실패" });
            continue;
          }
          o.price = roundToTick(live.price * (o.side === "buy" ? 1 + SLIPPAGE : 1 - SLIPPAGE), o.side === "buy" ? "up" : "down");
          o.notionalKrw = Math.round(o.price * o.qty);
          if (o.notionalKrw > cfg.maxOrderNotionalKrw) {
            o.qty = Math.floor(cfg.maxOrderNotionalKrw / o.price);
            o.notionalKrw = Math.round(o.price * o.qty);
          }
          if (o.qty < 1) {
            journal.push(entry("skip", `${o.nameKo} 주문 보류 — KIS 현재가 기준 1주가 주문한도를 초과`));
            continue;
          }
        }
        /* 매수는 전송 직전에 매수가능조회로 수량을 한 번 더 누른다.
         * 예수금 기반 cashLeft 는 통합증거금 미국 결제 예정액을 모르기 때문에
         * 그대로 보내면 APBK0952(주문가능금액 초과)로 사이클마다 거절이 반복된다. */
        if (o.side === "buy" && !isDryRun(env)) {
          const ps = await domesticPsamount(env, kisConfig(env), o.code, o.price).catch(() => null);
          if (ps && ps.maxQty < o.qty) {
            if (ps.maxQty < 1) {
              journal.push(entry("skip", `${o.nameKo} 매수 보류 — 주문가능금액 부족(가능 0주, 미국 결제 대기 등). 다음 사이클에 재평가`));
              results.push({ code: o.code, side: o.side, ok: false, message: "주문가능수량 0" });
              continue;
            }
            journal.push(entry("cycle", `${o.nameKo} 매수 ${o.qty}→${ps.maxQty}주 축소 — 주문가능금액 기준`));
            o.qty = ps.maxQty;
            o.notionalKrw = Math.round(o.price * o.qty);
          }
        }
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
        const before = plan.account.holdings.find((h) => h.symbol === o.code);
        state.pendingOrders = [
          ...(state.pendingOrders ?? []).filter((p) => p.code !== o.code),
          {
            orderNo: res.orderNo,
            acceptedAt: Date.now(),
            side: o.side,
            code: o.code,
            nameKo: o.nameKo,
            qty: o.qty,
            limitPrice: o.price,
            beforeQty: before?.qty ?? 0,
            beforeAvgPrice: before?.avgPrice ?? 0,
            appliedQty: 0,
            reason: o.reason,
          },
        ];
        results.push({ code: o.code, side: o.side, ok: true, message: res.message });
        journal.push(
          entry("order", `${o.side === "buy" ? "매수" : "매도"} ${o.nameKo}(${o.code}) ${o.qty}주 @${o.price.toLocaleString("ko-KR")}원 — ${o.reason}`, {
            dryRun: res.dryRun ?? false,
            orderNo: res.orderNo,
            status: "접수 — 다음 계좌 조회에서 체결수량 확인",
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
 * 계좌 보유수량 변화로 확인된 체결분만 장부에 반영한다.
 */
function applyConfirmedFill(state: AutoState, o: PlannedOrder, confirmedQty: number, fillPrice: number): void {
  const pos = state.positions[o.code];
  if (o.side === "buy") {
    if (pos) {
      const totalQty = pos.qty + confirmedQty;
      pos.avgPrice = totalQty ? (pos.avgPrice * pos.qty + fillPrice * confirmedQty) / totalQty : fillPrice;
      pos.qty = totalQty;
      pos.lastAddedAt = Date.now();
      pos.reason = o.reason;
    } else {
      state.positions[o.code] = {
        code: o.code,
        nameKo: o.nameKo,
        qty: confirmedQty,
        avgPrice: fillPrice,
        enteredAt: Date.now(),
        lastAddedAt: Date.now(),
        reason: o.reason,
      };
    }
  } else if (pos) {
    // 매도分은 확정 손익으로 적립한다 (평가손익에서 빠지므로 여기서 잡아야 총액이 맞는다).
    // 왕복 거래비용 0.23% 를 차감해 낙관 편향을 없앤다.
    const qty = Math.min(confirmedQty, pos.qty);
    const gross = (fillPrice - pos.avgPrice) * qty;
    const cost = fillPrice * qty * 0.0023;
    state.realizedPnl = Math.round((state.realizedPnl ?? 0) + gross - cost);
    pos.qty -= qty;
    if (pos.qty <= 0) delete state.positions[o.code];
  }
}

function reconcilePendingDomesticOrders(state: AutoState, holdings: Holding[], journal: JournalEntry[]): void {
  const pending = state.pendingOrders ?? [];
  if (!pending.length) return;
  const held = new Map(holdings.map((h) => [h.symbol, h]));
  const keep: PendingDomesticOrder[] = [];
  for (const p of pending) {
    const h = held.get(p.code);
    const nowQty = h?.qty ?? 0;
    const observed = p.side === "buy"
      ? Math.max(0, nowQty - p.beforeQty)
      : Math.max(0, p.beforeQty - nowQty);
    const confirmed = Math.min(p.qty, observed);
    const delta = Math.max(0, confirmed - p.appliedQty);
    if (delta > 0) {
      let fillPrice = p.limitPrice;
      if (p.side === "buy" && h?.avgPrice) {
        const derived = p.beforeQty > 0
          ? (h.avgPrice * nowQty - p.beforeAvgPrice * p.beforeQty) / Math.max(1, observed)
          : h.avgPrice;
        if (Number.isFinite(derived) && derived > 0) fillPrice = derived;
      }
      applyConfirmedFill(state, {
        side: p.side, code: p.code, nameKo: p.nameKo, qty: delta, price: fillPrice,
        notionalKrw: Math.round(fillPrice * delta), score: 0, reason: p.reason, detail: [],
      }, delta, fillPrice);
      p.appliedQty += delta;
      journal.push(entry("order", `체결 확인 — ${p.nameKo} ${p.side === "buy" ? "매수" : "매도"} ${delta}주 (누적 ${p.appliedQty}/${p.qty}주)`, {
        orderNo: p.orderNo, fillPrice: Math.round(fillPrice), basis: p.side === "buy" ? "KIS 보유수량·평단 변화" : "KIS 보유수량 변화·지정가 보수계상",
      }));
    }
    if (p.appliedQty >= p.qty) continue;
    // 당일 주문은 장 종료 후 소멸한다. 12시간이 지난 잔여분은 미체결로 정리한다.
    if (Date.now() - p.acceptedAt > 12 * 60 * 60 * 1000) {
      journal.push(entry("skip", `미체결 정리 — ${p.nameKo} ${p.side === "buy" ? "매수" : "매도"} 잔여 ${p.qty - p.appliedQty}주`, { orderNo: p.orderNo }));
      continue;
    }
    keep.push(p);
  }
  state.pendingOrders = keep;
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
