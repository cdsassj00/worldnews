/**
 * 실계좌 분봉 단타 트랙.
 * 기존 저회전 원장과 포지션을 섞지 않고, 실제 남은 현금 안에서만 최대 1종목을 운용한다.
 */
import type { Env } from "./env";
import {
  domesticBalance,
  domesticMinuteBars,
  domesticPrice,
  domesticPsamount,
  kisConfig,
  kisConfigured,
  overseasMinuteBars,
  overseasPrice,
  overseasPsamount,
  overseasUsBalanceAll,
  placeOrder,
  type Holding,
  type OrderMarket,
} from "./kis";
import { quantRank } from "./quant";
import { scalpEntrySignal, scalpExitReason, shouldRunScalpCycle } from "../shared/scalp";
import { ApiError, num, round } from "./util";

export type ScalpMarket = "KR" | "US";

interface ScalpPosition {
  market: ScalpMarket;
  code: string;
  name: string;
  excd: OrderMarket;
  qty: number;
  entryPrice: number;
  enteredAt: number;
  peakPrice: number;
}

interface ScalpPending {
  side: "buy" | "sell";
  market: ScalpMarket;
  code: string;
  name: string;
  excd: OrderMarket;
  qty: number;
  price: number;
  beforeQty: number;
  acceptedAt: number;
  orderNo: string;
}

interface ScalpTrade {
  at: number;
  market: ScalpMarket;
  code: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  reason: string;
  pnlKrw?: number;
}

interface MarketLedger {
  position?: ScalpPosition;
  pending?: ScalpPending;
  realizedPnlKrw: number;
  day: string;
  dayStartRealizedKrw: number;
  haltedDay?: string;
  lastAt: number;
  lastAvailableKrw: number;
  lastTargetKrw: number;
  lastNote: string;
}

interface ScalpState {
  KR: MarketLedger;
  US: MarketLedger;
  trades: ScalpTrade[];
}

const STATE_KEY = "auto:scalp:state:v1";
const PCT_KEY = "auto:scalp:pct";
const DEFAULT_PCT = 10;
const SAFETY_CASH_KRW = 50_000;
const MIN_ORDER_KRW = 150_000;

const emptyLedger = (): MarketLedger => ({
  realizedPnlKrw: 0,
  day: "",
  dayStartRealizedKrw: 0,
  lastAt: 0,
  lastAvailableKrw: 0,
  lastTargetKrw: 0,
  lastNote: "첫 분봉 점검 대기",
});

async function loadState(env: Env): Promise<ScalpState> {
  const raw = await env.CACHE.get(STATE_KEY, "json").catch(() => null) as ScalpState | null;
  if (!raw) return { KR: emptyLedger(), US: emptyLedger(), trades: [] };
  return { KR: { ...emptyLedger(), ...raw.KR }, US: { ...emptyLedger(), ...raw.US }, trades: raw.trades ?? [] };
}

async function saveState(env: Env, state: ScalpState): Promise<void> {
  state.trades = state.trades.slice(-100);
  await env.CACHE.put(STATE_KEY, JSON.stringify(state));
}

export async function getScalpPct(env: Env): Promise<number> {
  const raw = await env.CACHE.get(PCT_KEY).catch(() => null);
  const v = raw === null ? num(env.SCALP_CAPITAL_PCT, DEFAULT_PCT) : Number(raw);
  return Math.max(0, Math.min(30, Math.round((Number.isFinite(v) ? v : DEFAULT_PCT) / 5) * 5));
}

export async function setScalpPct(env: Env, pct: number): Promise<number> {
  const v = Math.max(0, Math.min(30, Math.round((Number(pct) || 0) / 5) * 5));
  await env.CACHE.put(PCT_KEY, String(v)).catch(() => {
    throw new ApiError(503, "kv_write_limit", { hint: "단타 비율 저장 실패 — 잠시 후 다시 시도하세요." });
  });
  return v;
}

async function reserveKrw(env: Env): Promise<number> {
  const raw = await env.CACHE.get("auto:reserve").catch(() => null);
  const v = raw === null ? num(env.AUTO_RESERVE_KRW, 0) : Number(raw);
  return Math.max(0, Number.isFinite(v) ? v : 0);
}

async function totalDepositKrw(env: Env): Promise<number> {
  const raw = await env.CACHE.get("auto:state", "json").catch(() => null) as { totalDepositKrw?: number } | null;
  return Math.max(0, Number(raw?.totalDepositKrw) || 10_000_000);
}

function kstParts() {
  const d = new Date(Date.now() + 9 * 3600_000);
  const iso = d.toISOString();
  return { day: iso.slice(0, 10), hhmmss: iso.slice(11, 19).replace(/:/g, ""), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

function etParts() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { day: `${get("year")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`, mins: (get("hour") % 24) * 60 + get("minute") };
}

async function findUsQuote(env: Env, code: string): Promise<{ excd: OrderMarket; price: number }> {
  const cfg = kisConfig(env);
  for (const excd of ["NAS", "NYS", "AMS"] as OrderMarket[]) {
    try {
      const q = await overseasPrice(env, cfg, excd, code);
      if (q.price > 0) return { excd, price: q.price };
    } catch { /* 다음 거래소 */ }
  }
  throw new ApiError(502, "us_quote_failed", { code });
}

function qtyOf(holdings: Holding[], code: string): number {
  return holdings.find((h) => h.symbol === code)?.qty ?? 0;
}

function reconcile(ledger: MarketLedger, holdings: Holding[], state: ScalpState): void {
  const p = ledger.pending;
  if (!p) return;
  const nowQty = qtyOf(holdings, p.code);
  if (p.side === "buy" && nowQty > p.beforeQty) {
    const h = holdings.find((x) => x.symbol === p.code);
    const filled = Math.min(p.qty, nowQty - p.beforeQty);
    ledger.position = { market: p.market, code: p.code, name: p.name, excd: p.excd, qty: filled, entryPrice: h?.avgPrice || p.price, enteredAt: Date.now(), peakPrice: h?.price || p.price };
    state.trades.push({ at: Date.now(), market: p.market, code: p.code, side: "buy", qty: filled, price: h?.avgPrice || p.price, reason: "KIS 잔고로 체결 확인" });
    ledger.pending = undefined;
  } else if (p.side === "sell" && nowQty < p.beforeQty) {
    const filled = Math.min(p.qty, p.beforeQty - nowQty);
    const pos = ledger.position;
    const pnl = pos ? Math.round((p.price - pos.entryPrice) * filled * (p.market === "US" ? 1400 : 1)) : 0;
    ledger.realizedPnlKrw += pnl;
    state.trades.push({ at: Date.now(), market: p.market, code: p.code, side: "sell", qty: filled, price: p.price, reason: "KIS 잔고로 체결 확인", pnlKrw: pnl });
    ledger.position = undefined;
    ledger.pending = undefined;
  } else if (Date.now() - p.acceptedAt > 14 * 3600_000) {
    // 일 주문은 다음 거래일까지 살아있지 않는다. 다음 날 잔고 변화가 없으면 잠금 해제.
    ledger.pending = undefined;
  }
}

export async function getScalpClaims(env: Env): Promise<{ KR: Set<string>; US: Set<string> }> {
  const s = await loadState(env);
  return {
    KR: new Set([s.KR.position?.code, s.KR.pending?.code].filter(Boolean) as string[]),
    US: new Set([s.US.position?.code, s.US.pending?.code].filter(Boolean) as string[]),
  };
}

export interface ScalpView {
  enabled: boolean;
  pct: number;
  strategy: string;
  totalTargetKrw: number;
  totalAvailableKrw: number;
  status: string;
  KR: { targetKrw: number; availableKrw: number; position?: ScalpPosition; realizedPnlKrw: number; note: string; at: number };
  US: { targetKrw: number; availableKrw: number; position?: ScalpPosition; realizedPnlKrw: number; note: string; at: number };
}

export async function scalpView(env: Env, totalDepositKrw: number, domesticCashKrw: number, usValueKrw: number): Promise<ScalpView> {
  const [pct, reserve, state] = await Promise.all([getScalpPct(env), reserveKrw(env), loadState(env)]);
  const krBudget = Math.max(0, totalDepositKrw - reserve);
  const krTarget = Math.round(krBudget * pct / 100);
  const usTarget = Math.round(reserve * pct / 100);
  const krAvailable = Math.max(0, Math.min(krTarget, domesticCashKrw - SAFETY_CASH_KRW));
  const usRoom = Math.max(0, reserve - usValueKrw);
  const usAvailable = Math.max(0, Math.min(usTarget, state.US.lastAvailableKrw || usRoom));
  // 통합증거금이면 같은 원화가 국내 주문가능액과 미국 매수가능액에 동시에 보일 수
  // 있으므로 합산하지 않는다. 두 시장은 시간이 겹치지 않고 각 사이클에서 KIS가
  // 다시 준 실제 주문가능액만 사용한다.
  const totalAvailable = Math.max(krAvailable, usAvailable);
  return {
    enabled: pct > 0,
    pct,
    strategy: "5분 시초범위 돌파 + VWAP",
    totalTargetKrw: krTarget + usTarget,
    totalAvailableKrw: totalAvailable,
    status: pct <= 0
      ? (state.KR.position || state.KR.pending || state.US.position || state.US.pending ? "신규진입 꺼짐 · 보유분 관리" : "꺼짐")
      : totalAvailable < MIN_ORDER_KRW ? "자금 부족 · 대기" : "분봉 감시 중",
    KR: { targetKrw: krTarget, availableKrw: krAvailable, position: state.KR.position, realizedPnlKrw: state.KR.realizedPnlKrw, note: state.KR.lastNote, at: state.KR.lastAt },
    US: { targetKrw: usTarget, availableKrw: usAvailable, position: state.US.position, realizedPnlKrw: state.US.realizedPnlKrw, note: state.US.lastNote, at: state.US.lastAt },
  };
}

export async function runScalpCycle(env: Env, market: ScalpMarket): Promise<void> {
  if (!kisConfigured(env)) return;
  const pct = await getScalpPct(env);
  const state = await loadState(env);
  const ledger = state[market];
  // 0%는 신규진입 중지다. 이미 보유하거나 체결 확인 중인 단타가 있으면 보호 로직은 계속 돈다.
  if (!shouldRunScalpCycle(pct, Boolean(ledger.position), Boolean(ledger.pending))) return;
  const cfg = kisConfig(env);
  const reserve = await reserveKrw(env);
  const deposit = await totalDepositKrw(env);
  const kt = kstParts();
  const et = etParts();
  const time = market === "KR" ? kt : et;
  const open = market === "KR" ? kt.weekday >= 1 && kt.weekday <= 5 && kt.mins >= 9 * 60 + 5 && kt.mins <= 15 * 60 + 15 : et.mins >= 9 * 60 + 35 && et.mins <= 15 * 60 + 55;
  if (!open) return;
  if (ledger.day !== time.day) {
    ledger.day = time.day;
    ledger.dayStartRealizedKrw = ledger.realizedPnlKrw;
    ledger.haltedDay = undefined;
  }

  let holdings: Holding[] = [];
  let availableKrw = 0;
  let fx = 1400;
  if (market === "KR") {
    const bal = await domesticBalance(env, cfg);
    holdings = bal.holdings;
    const target = Math.round(Math.max(0, deposit - reserve) * pct / 100);
    availableKrw = Math.max(0, Math.min(target, (bal.summary.orderableCash || bal.summary.cash) - SAFETY_CASH_KRW));
    ledger.lastTargetKrw = target;
  } else {
    holdings = (await overseasUsBalanceAll(env, cfg)).holdings;
    const target = Math.round(reserve * pct / 100);
    ledger.lastTargetKrw = target;
    try {
      const q = await findUsQuote(env, "AAPL");
      const ps = await overseasPsamount(env, cfg, "NASD", "AAPL", q.price);
      fx = ps.fx || fx;
      availableKrw = Math.max(0, Math.min(target, Math.max(ps.totalOrderable, ps.frcrOrderable, ps.afterExchangeOrderable) * fx));
    } catch { availableKrw = 0; }
  }
  reconcile(ledger, holdings, state);
  ledger.lastAt = Date.now();
  ledger.lastAvailableKrw = Math.round(availableKrw);

  const dayLoss = ledger.realizedPnlKrw - ledger.dayStartRealizedKrw;
  if (dayLoss <= -Math.max(10_000, ledger.lastTargetKrw * 0.01)) ledger.haltedDay = time.day;
  if (ledger.pending) {
    ledger.lastNote = `${ledger.pending.side === "buy" ? "매수" : "매도"} 주문 체결 확인 중`;
    await saveState(env, state);
    return;
  }

  // 보유 단타 포지션 관리가 신규 진입보다 항상 먼저다.
  if (ledger.position) {
    const pos = ledger.position;
    let price = 0, vwap = 0;
    if (market === "KR") {
      price = (await domesticPrice(env, cfg, pos.code)).price;
      const bars = await domesticMinuteBars(env, cfg, pos.code, kt.hhmmss);
      const sig = scalpEntrySignal(bars); vwap = sig.vwap;
    } else {
      price = (await overseasPrice(env, cfg, pos.excd, pos.code)).price;
      const bars = await overseasMinuteBars(env, cfg, pos.excd, pos.code);
      const sig = scalpEntrySignal(bars); vwap = sig.vwap;
    }
    pos.peakPrice = Math.max(pos.peakPrice, price);
    const forceClose = market === "KR" ? time.mins >= 15 * 60 + 10 : time.mins >= 15 * 60 + 50;
    const why = forceClose ? "당일 마감청산" : scalpExitReason({ entryPrice: pos.entryPrice, currentPrice: price, peakPrice: pos.peakPrice, enteredAt: pos.enteredAt, now: Date.now(), vwap });
    if (why) {
      const limit = market === "KR" ? Math.max(1, Math.floor(price * 0.997)) : Math.max(0.01, round(price * 0.997, 2));
      const order = await placeOrder(env, cfg, { market: market === "KR" ? "KRX" : pos.excd, code: pos.code, side: "sell", qty: pos.qty, price: limit, orderType: "limit", notionalKrw: Math.round(limit * pos.qty * (market === "US" ? fx : 1)) });
      ledger.pending = { side: "sell", market, code: pos.code, name: pos.name, excd: pos.excd, qty: pos.qty, price: limit, beforeQty: qtyOf(holdings, pos.code), acceptedAt: Date.now(), orderNo: order.orderNo };
      ledger.lastNote = `${why} 주문 접수`;
    } else ledger.lastNote = `${pos.name} 보유 · VWAP/손절 감시`;
    await saveState(env, state);
    return;
  }

  if (ledger.haltedDay === time.day) {
    ledger.lastNote = "단타 당일 손실한도 도달 · 신규진입 정지";
    await saveState(env, state); return;
  }
  const entryOpen = market === "KR" ? time.mins >= 9 * 60 + 10 && time.mins <= 11 * 60 + 30 : time.mins >= 9 * 60 + 40 && time.mins <= 11 * 60 + 30;
  if (!entryOpen || availableKrw < MIN_ORDER_KRW) {
    ledger.lastNote = !entryOpen ? "단타 신규진입 시간 밖 · 보유분만 관리" : `실사용 가능 ${Math.round(availableKrw).toLocaleString("ko-KR")}원 · 최소주문 미달`;
    await saveState(env, state); return;
  }

  const heldCodes = new Set(holdings.map((h) => h.symbol));
  const rank = await quantRank(env, "breakout", 8, market);
  const candidates = rank.rows.filter((r) => !heldCodes.has(r.code) && Date.now() - r.scannedAt < 24 * 3600_000).slice(0, 4);
  for (const c of candidates) {
    try {
      let excd: OrderMarket = "KRX", live = 0, bars;
      if (market === "KR") {
        live = (await domesticPrice(env, cfg, c.code)).price;
        bars = await domesticMinuteBars(env, cfg, c.code, kt.hhmmss);
      } else {
        const q = await findUsQuote(env, c.code); excd = q.excd; live = q.price;
        bars = await overseasMinuteBars(env, cfg, excd, c.code);
      }
      const sig = scalpEntrySignal(bars);
      if (!sig.enter) continue;
      const limit = market === "KR" ? Math.ceil(live * 1.003) : round(live * 1.003, 2);
      let room = availableKrw;
      if (market === "KR") {
        const ps = await domesticPsamount(env, cfg, c.code, limit);
        room = Math.min(room, ps.orderableCash || room);
      } else {
        const ps = await overseasPsamount(env, cfg, excd === "NAS" ? "NASD" : excd === "NYS" ? "NYSE" : "AMEX", c.code, limit);
        fx = ps.fx || fx;
        room = Math.min(room, Math.max(ps.totalOrderable, ps.frcrOrderable, ps.afterExchangeOrderable) * fx || room);
      }
      const qty = Math.floor(room / (limit * (market === "US" ? fx : 1)));
      if (qty < 1) continue;
      const order = await placeOrder(env, cfg, { market: market === "KR" ? "KRX" : excd, code: c.code, side: "buy", qty, price: limit, orderType: "limit", notionalKrw: Math.round(limit * qty * (market === "US" ? fx : 1)) });
      ledger.pending = { side: "buy", market, code: c.code, name: c.name, excd, qty, price: limit, beforeQty: 0, acceptedAt: Date.now(), orderNo: order.orderNo };
      ledger.lastNote = `${c.name} 단타 매수 접수 · ${sig.reason}`;
      break;
    } catch { /* 다음 후보 */ }
  }
  if (!ledger.pending) ledger.lastNote = `상위 ${candidates.length}종목 분봉 확인 · 진입 신호 없음`;
  await saveState(env, state);
}
