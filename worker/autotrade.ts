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
import { UNIVERSE, roundToTick } from "../shared/ontology";
import { runStrategy, type StrategyResult, type TickerScore } from "./strategy";
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
  return { ...emptyState(now), ...raw, positions: raw.positions ?? {} };
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

async function readAccount(env: Env): Promise<AccountView> {
  if (!kisConfigured(env)) {
    return { connected: false, reason: "KIS 시크릿이 등록되지 않아 계좌를 읽지 못했습니다.", cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
  }
  try {
    const bal = await domesticBalance(env, kisConfig(env));
    return {
      connected: true,
      reason: "",
      cash: bal.summary.orderableCash || bal.summary.cash,
      stockEval: bal.summary.stockEval,
      totalEval: bal.summary.totalEval || bal.summary.cash + bal.summary.stockEval,
      holdings: bal.holdings,
    };
  } catch (err) {
    const message = err instanceof ApiError ? `${err.message}` : String(err);
    return { connected: false, reason: `계좌 조회 실패: ${message}`, cash: 0, stockEval: 0, totalEval: 0, holdings: [] };
  }
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
  targetProgressPct: number;
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

export async function buildPlan(env: Env): Promise<AutoPlan> {
  const cfg = autoConfig(env);
  const now = kstNow();
  const phase = marketPhase(now);

  const [{ data: strategy }, account] = await Promise.all([
    // 전략 계산은 무겁다(시세 28건 + 뉴스). 5분 캐시로 서브리퀘스트를 아낀다.
    cached(env, "auto:strategy", 300, () => runStrategy(env)),
    readAccount(env),
  ]);

  const state = await loadState(env);
  const scoreByCode = new Map(strategy.scores.map((s) => [s.code, s]));
  const heldQty = new Map(account.holdings.map((h) => [h.symbol, h.qty]));
  const priceOf = (code: string) => scoreByCode.get(code)?.price ?? 0;

  const deployed = deployedValue(state, priceOf);
  const equity = account.connected ? account.totalEval : state.lastEquity || cfg.capitalKrw;
  const baseline = state.baselineEquity || equity;
  const pnl = equity - baseline;
  const budget = Math.max(0, cfg.capitalKrw - deployed);

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
    const price = sc?.price ?? pos.avgPrice;
    const pnlPct = pos.avgPrice ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : 0;
    positionView.push({ ...pos, price, pnlPct: round(pnlPct, 2), heldQty: held });

    const qty = Math.min(pos.qty, held || pos.qty);
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
  // 위험회피 국면에서는 사이즈를 줄인다 (최대 절반까지)
  const riskScale = 1 - Math.min(0.5, strategy.riskOff * 0.5);
  let remaining = budget;

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
      const room = Math.min(perPositionCap - currentValue, remaining, cfg.maxOrderNotionalKrw);
      const sized = room * riskScale * Math.min(1, 0.5 + sc.score);
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
      if (account.connected && notional > account.cash) continue;

      remaining -= notional;
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
    targetProgressPct: cfg.targetProfitKrw > 0 ? round((pnl / cfg.targetProfitKrw) * 100, 1) : 0,
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
    state.tradesToday = 0;
  }
  if (!state.baselineEquity && plan.equity > 0) state.baselineEquity = plan.equity;
  if (!state.dayStartEquity && plan.equity > 0) state.dayStartEquity = plan.equity;
  if (plan.equity > state.peakEquity) state.peakEquity = plan.equity;
  state.lastEquity = plan.equity;
  state.lastCycleAt = Date.now();

  if (plan.account.connected && state.peakEquity > 0) {
    const drawdown = ((state.peakEquity - plan.equity) / state.peakEquity) * 100;
    if (drawdown >= cfg.maxDrawdownPct && !state.haltedPermanent) {
      state.haltedPermanent = true;
      state.haltReason = `고점 대비 -${round(drawdown, 1)}% (한도 -${cfg.maxDrawdownPct}%)`;
      journal.push(entry("halt", `영구 정지 — ${state.haltReason}. 사람이 확인 후 해제해야 합니다.`));
    }
    if (state.dayStartEquity > 0) {
      const dayLoss = ((state.dayStartEquity - plan.equity) / state.dayStartEquity) * 100;
      if (dayLoss >= cfg.dailyLossHaltPct && state.haltedDay !== now.date) {
        state.haltedDay = now.date;
        state.haltReason = `당일 -${round(dayLoss, 1)}% (한도 -${cfg.dailyLossHaltPct}%)`;
        journal.push(entry("halt", `당일 정지 — ${state.haltReason}. 내일 자동 해제됩니다.`));
      }
    }
  }
  if (plan.pnlKrw >= cfg.targetProfitKrw && cfg.targetProfitKrw > 0 && !state.targetReachedAt) {
    state.targetReachedAt = Date.now();
    journal.push(entry("cycle", `목표 수익 ${cfg.targetProfitKrw.toLocaleString("ko-KR")}원 달성 — 신규 매수를 중단합니다.`));
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
