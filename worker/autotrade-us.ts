/**
 * 미국 실계좌 자동매매 (2026-08-18 사용자 지시 "그냥 해보자 — 400만원으로").
 *
 * 한국 봇(autotrade.ts)과 원장이 완전히 분리된 별도 사이클이다. 공유하는 것은
 * 매매 일지(한 화면에서 다 보이게)와 안전장치의 % 숫자뿐이다.
 *
 *   - 예산   = 미국 배분 슬라이더(auto:reserve, 기본 400만원)를 환율로 나눈 달러 금액.
 *              국내 봇은 같은 금액을 자기 예산에서 빼므로 두 봇이 같은 돈을 두 번 쓰지 않는다.
 *   - 종목   = 온톨로지 레이더의 미국 점수(실계좌 국내와 같은 온톨로지 엔진) 상위.
 *              수급 스캔 행이 있는 종목만 산다 — 시세·거래대금 검증이 없는 데이터에 돈을 태우지 않는다.
 *   - 주문   = KIS 해외주식 지정가. 통합증거금이라 달러 예수금 없이 원화로 매수된다.
 *   - 안전장치 = 국내와 같은 %(종목당 30% · 손절 -5% · 익절 +15% · 당일 -5% · 낙폭 -20% 영구정지)
 *              + S&P500 20일선 아래면 신규 매수 정지(백테스트에서 가장 효과 큰 규칙).
 *
 * US_AUTOTRADE_ENABLED=false 면 그림자 실행 — 잔고·매수가능금액(통합증거금)·환율·
 * 지정가·수량 계산까지 전부 실제 KIS 응답으로 하고, 주문 전송 한 줄만 건너뛴다.
 * 실주문을 켜기 전 마지막 실측 검증 단계다.
 *
 * 일지 도배 방지: 미국 크론은 밤새 15분마다 돈다. 계획·체결·정지 같은 "사건"이 있을
 * 때만 일지에 쓰고, 조용한 사이클은 KV(auto:us:last)에만 남긴다.
 */
import type { Env } from "./env";
import { addUsCashflowKrw, appendJournal, entry, getReserveKrw, type JournalEntry } from "./autotrade";
import { usMarketOpen, usQuantRows } from "./quant";
import { radarTop } from "./radarscan";
import { getSparkMany } from "./quotes";
import { sma } from "../shared/scoring";
import {
  kisConfig,
  kisConfigured,
  overseasBalance,
  overseasPrice,
  overseasPsamount,
  placeOrder,
  type Holding,
  type KisConfig,
  type OrderMarket,
} from "./kis";
import { ApiError, num, round } from "./util";

/* ── 설정 ─────────────────────────────────────────────── */

export interface UsAutoConfig {
  enabled: boolean;
  stopLossPct: number;
  takeProfitPct: number;
  dailyLossHaltPct: number;
  maxDrawdownPct: number;
  maxPositionPct: number;
  maxPositions: number;
  maxOrdersPerCycle: number;
  maxTradesPerDay: number;
  minOrderKrw: number;
  /** 온톨로지 레이더 점수 매수 문턱 — 미국 리그(0.35)와 동일 */
  buyScore: number;
  /** 수급 스캔이 이만큼 차기 전에는 매수하지 않는다(초기 스캔 편향 방지) */
  minPool: number;
}

export function usAutoConfig(env: Env): UsAutoConfig {
  /* 독립 세팅(2026-08-19 사용자 지시 "미국은 별도로 세팅 안 되냐") — US_* 가 있으면
   * 그 값, 없으면 한국(AUTO_*) 값을 따른다. 안전장치의 존재 자체는 공유하되 숫자는
   * 시장별로 다르게 줄 수 있다. */
  const n2 = (us: string | undefined, kr: string | undefined, def: number) => num(us, num(kr, def));
  return {
    enabled: (env.US_AUTOTRADE_ENABLED ?? "false").toLowerCase() === "true",
    stopLossPct: n2(env.US_STOP_LOSS_PCT, env.AUTO_STOP_LOSS_PCT, 5),
    takeProfitPct: n2(env.US_TAKE_PROFIT_PCT, env.AUTO_TAKE_PROFIT_PCT, 15),
    dailyLossHaltPct: n2(env.US_DAILY_LOSS_HALT_PCT, env.AUTO_DAILY_LOSS_HALT_PCT, 5),
    maxDrawdownPct: n2(env.US_MAX_DRAWDOWN_PCT, env.AUTO_MAX_DRAWDOWN_PCT, 20),
    maxPositionPct: n2(env.US_MAX_POSITION_PCT, env.AUTO_MAX_POSITION_PCT, 30),
    // 400만원 × 30% ≈ 종목당 $870 — 4종목이면 예산이 찬다
    maxPositions: num(env.US_MAX_POSITIONS, 4),
    // 사이클당 3건 — 미국 크론은 레이더·수급 스캔과 예산(50)을 나눠 쓴다
    maxOrdersPerCycle: num(env.US_MAX_ORDERS_PER_CYCLE, 3),
    maxTradesPerDay: n2(env.US_MAX_TRADES_PER_DAY, env.AUTO_MAX_TRADES_PER_DAY, 6),
    minOrderKrw: n2(env.US_MIN_ORDER_KRW, env.AUTO_MIN_ORDER_KRW, 150_000),
    buyScore: num(env.US_BUY_SCORE, 0.35),
    minPool: num(env.US_MIN_POOL, 50),
  };
}

/* ── 미국 엔진 선택 — 한국(auto:engine)과 완전 별개 ─────────
 * onto   = 온톨로지 레이더 점수 (기본)
 * quant  = 수급(돌파 프로파일) 점수
 * ta     = 차트 거장 13종 합의 점수
 * fusion = 온톨로지·수급 반반
 * 재배포 없이 바꾸도록 KV 에 두고, /api/auto/us/engine 으로 조작한다. */
export type UsEngine = "onto" | "quant" | "ta" | "fusion";
export const US_ENGINES: { id: UsEngine; nameKo: string }[] = [
  { id: "onto", nameKo: "온톨로지" },
  { id: "quant", nameKo: "수급" },
  { id: "ta", nameKo: "차트" },
  { id: "fusion", nameKo: "융합" },
];
const US_ENGINE_KEY = "auto:us:engine";

export async function getUsEngine(env: Env): Promise<UsEngine> {
  const v = ((await env.CACHE.get(US_ENGINE_KEY).catch(() => null)) ?? env.US_ENGINE ?? "onto") as string;
  return (US_ENGINES.some((e) => e.id === v) ? v : "onto") as UsEngine;
}

export async function setUsEngine(env: Env, engine: string): Promise<UsEngine> {
  if (!US_ENGINES.some((e) => e.id === engine)) {
    throw new ApiError(400, "bad_engine", { allowed: US_ENGINES.map((e) => e.id) });
  }
  await env.CACHE.put(US_ENGINE_KEY, engine).catch(() => {
    throw new ApiError(503, "kv_write_limit", { hint: "설정 저장 실패 — Cloudflare 저장(KV) 하루 쓰기 한도가 소진됐습니다. 오전 9시(KST) 리셋 후 다시 시도하세요." });
  });
  return engine as UsEngine;
}

/** 지정가 슬리피지 허용폭 — 국내 봇과 동일 */
const SLIPPAGE = 0.003;
/** 온톨로지 점수가 이 밑이면 근거가 사라진 것으로 보고 이탈 */
const SELL_SCORE = -0.05;
/** 미국 종목 거래대금 하한(달러) — quant 트랙과 동일 */
const MIN_TURNOVER_USD = 3_000_000;

const STATE_KEY = "auto:us:state";
const LAST_KEY = "auto:us:last";
/** KIS 해외 잔고 스냅샷 — 대시보드 수익 계산의 유일한 미국 출처(추정 금지, 실측만) */
const BALANCE_KEY = "auto:us:balance";

/* ── 상태 ─────────────────────────────────────────────── */

export interface UsPosition {
  code: string;
  name: string;
  qty: number;
  /** 평단(달러) */
  avgPrice: number;
  /** 마지막 관측 현재가(달러) — 장 마감 중 대시보드 표시용 */
  lastPrice?: number;
  enteredAt: number;
  lastAddedAt: number;
  reason: string;
}

export interface UsAutoState {
  startedAt: number;
  /** 미국 동부 기준 날짜 — 세션이 KST 자정을 넘으므로 KST 로 자르면 하루가 둘로 쪼개진다 */
  day: string;
  tradesToday: number;
  haltedDay: string;
  haltedPermanent: boolean;
  haltReason: string;
  /** 봇이 매도로 확정한 누적 손익(달러) */
  realizedPnlUsd: number;
  peakPnlUsd?: number;
  dayStartPnlUsd?: number;
  positions: Record<string, UsPosition>;
  lastCycleAt: number;
  /** 마지막 관측 환율·보유 평가액(달러) — 국내 대시보드가 총평가에 합산할 때 쓴다 */
  lastFx?: number;
  lastValueUsd?: number;
}

function emptyUsState(): UsAutoState {
  return {
    startedAt: Date.now(),
    day: "",
    tradesToday: 0,
    haltedDay: "",
    haltedPermanent: false,
    haltReason: "",
    realizedPnlUsd: 0,
    positions: {},
    lastCycleAt: 0,
  };
}

export async function loadUsState(env: Env): Promise<UsAutoState> {
  const raw = (await env.CACHE.get(STATE_KEY, "json").catch(() => null)) as UsAutoState | null;
  if (!raw) return emptyUsState();
  const s = { ...emptyUsState(), ...raw, positions: raw.positions ?? {} };
  /* 사고 복구(2026-08-20): num("")=0 버그로 정지 한도가 전부 0%가 되어
   * "당일/고점 -0% (한도 -0%)" 가짜 정지가 걸렸다. 한도 0%는 이제 불가능하므로
   * 이 사유의 정지는 읽는 시점에 스스로 푼다 — KV 쓰기 한도가 소진돼 저장이
   * 실패해도 매 사이클 메모리에서 풀리므로 매매가 막히지 않는다. */
  if (s.haltReason.includes("한도 -0%")) {
    s.haltedPermanent = false;
    s.haltedDay = "";
    s.haltReason = "";
  }
  return s;
}

async function saveUsState(env: Env, s: UsAutoState): Promise<void> {
  await env.CACHE.put(STATE_KEY, JSON.stringify(s)).catch(() => undefined);
}

/** 미국 동부 기준 날짜 (YYYY-MM-DD) */
function etDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/* ── 거래소 판별 ───────────────────────────────────────
 * 유니버스에는 심볼만 있고 나스닥/뉴욕 구분이 없다. 시세가 나오는 거래소를 찾아
 * KV 에 영구 기억한다(거래소는 바뀌지 않는다). 이후에는 호출 1회로 시세까지 얻는다. */
async function usQuote(env: Env, kis: KisConfig, code: string): Promise<{ excd: OrderMarket; price: number }> {
  const key = `us:excd:${code}`;
  const memo = (await env.CACHE.get(key).catch(() => null)) as OrderMarket | null;
  const tryList: OrderMarket[] = memo ? [memo] : ["NAS", "NYS", "AMS"];
  for (const excd of tryList) {
    try {
      const p = await overseasPrice(env, kis, excd, code);
      if (p.price > 0) {
        if (!memo) await env.CACHE.put(key, excd).catch(() => undefined);
        return { excd, price: p.price };
      }
    } catch {
      /* 다음 거래소 시도 */
    }
  }
  throw new ApiError(502, "us_quote_failed", { code });
}

/** 미국 3거래소(나스닥·뉴욕·아멕스) 잔고 합본.
 *
 * 잔고 TR 의 거래소 코드는 **조회 범위**다 — NAS 로만 조회하면 NYSE 종목이 응답에
 * 없어서 "계좌에 없음"으로 오판한다. 2026-08-19 실사고: NYSE 인 Blackstone 6주가
 * 실계좌에 있는데 잔고 대사가 장부에서 제거했고, 대시보드 미국 투입이 0원이 됐다.
 * 코드 체계가 문서(NASD/NYSE/AMEX)와 실측(NAS 성공)이 갈려 있어 둘 다 시도한다. */
async function usBalanceAll(env: Env, kis: KisConfig): Promise<{ holdings: Holding[] }> {
  const holdings: Holding[] = [];
  const seen = new Set<string>();
  let okCount = 0;
  let lastErr: unknown = null;
  for (const codes of [["NAS", "NASD"], ["NYS", "NYSE"], ["AMS", "AMEX"]]) {
    let got: Awaited<ReturnType<typeof overseasBalance>> | null = null;
    for (const code of codes) {
      try {
        got = await overseasBalance(env, kis, code as OrderMarket, "USD");
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!got) continue; // 이 거래소만 실패 — 나머지는 계속 (아래 okCount 로 판정)
    okCount++;
    // 어떤 코드가 '미국 전체'를 돌려줘도 안전하게 심볼 기준으로 합친다
    for (const h of got.holdings) {
      if (!seen.has(h.symbol)) {
        seen.add(h.symbol);
        holdings.push(h);
      }
    }
  }
  // 세 거래소 전부 실패면 잔고를 모른다 — 빈 목록을 돌려주면 대사가 보유 전체를
  // 지워버리므로 반드시 실패로 처리한다
  if (!okCount) throw lastErr ?? new ApiError(502, "us_balance_failed");
  return { holdings };
}

/* ── 사이클 ───────────────────────────────────────────── */

export interface UsPlannedOrder {
  side: "buy" | "sell";
  code: string;
  name: string;
  excd: OrderMarket;
  qty: number;
  /** 지정가(달러) */
  price: number;
  notionalUsd: number;
  notionalKrw: number;
  score: number;
  reason: string;
}

export interface UsCycleResult {
  ran: boolean;
  shadow: boolean;
  note: string;
  fx: number;
  budgetUsd: number;
  deployedUsd: number;
  orderableUsd: number;
  /** 매수가능금액 원본(진단) — 통합증거금 반영 여부를 판별한다 */
  psDetail?: { frcr: number; total: number; afterExchange: number; maxQty: number };
  pnlUsd: number;
  orders: UsPlannedOrder[];
  results: { code: string; side: string; ok: boolean; message: string }[];
}

/**
 * 미국 실계좌 한 사이클 — 잔고 대사 → 청산 → 시장필터 → 후보 → 예산 → 주문.
 *
 * shadow=true(또는 US_AUTOTRADE_ENABLED=false)면 주문 전송만 건너뛴다. 나머지
 * (잔고·매수가능금액·환율·지정가·수량)는 전부 실제 KIS 응답으로 계산한다.
 * force=true 면 장 마감 중에도 강제로 한 사이클 돈다(수동 점검용).
 */
export async function usRunCycle(env: Env, opts: { shadow?: boolean; force?: boolean } = {}): Promise<UsCycleResult> {
  const cfg = usAutoConfig(env);
  const out: UsCycleResult = {
    ran: false, shadow: true, note: "", fx: 0, budgetUsd: 0, deployedUsd: 0, orderableUsd: 0, pnlUsd: 0,
    orders: [], results: [],
  };
  const finish = async (note: string): Promise<UsCycleResult> => {
    out.note = note;
    // 장 마감 스킵으로 직전의 의미 있는 기록(계획·환율·배치금액)을 덮어쓰지 않는다
    if (out.ran) {
      await env.CACHE.put(LAST_KEY, JSON.stringify({ at: Date.now(), ...out }), { expirationTtl: 86_400 }).catch(() => undefined);
    }
    // 2026-08-21 진단용 — 스킵으로 끝나도 "왜 스킵했는지"는 남긴다(원인 좁혀지면 제거).
    await env.CACHE.put("diag:us:finish", JSON.stringify({ at: Date.now(), note, ran: out.ran })).catch(() => undefined);
    return out;
  };

  if (!kisConfigured(env)) return finish("KIS 미설정");
  if (!usMarketOpen() && !opts.force) return finish("미국장 마감 — 사이클 건너뜀");

  const kis = kisConfig(env);
  const state = await loadUsState(env);
  const journal: JournalEntry[] = [];
  const today = etDay();
  const firstOfDay = state.day !== today;
  if (firstOfDay) {
    state.day = today;
    state.tradesToday = 0;
    state.dayStartPnlUsd = undefined;
  }

  /* 1) 계좌 잔고 — 미국 보유분과 통합증거금의 진실 (3거래소 합본) */
  let bal: { holdings: Holding[] };
  try {
    bal = await usBalanceAll(env, kis);
  } catch (err) {
    const msg = err instanceof ApiError ? `${err.message} ${JSON.stringify(err.detail ?? {})}` : String(err);
    journal.push(entry("error", `미국 — 해외 잔고 조회 실패로 사이클 중단: ${msg}`));
    await appendJournal(env, journal);
    return finish(`잔고 조회 실패: ${msg}`);
  }
  const held = new Map(bal.holdings.map((h) => [h.symbol, h]));

  /* 2) 편입·대사 — 계좌가 진실이다(국내 봇과 같은 규칙: 계좌 전체가 봇 운용) */
  for (const h of bal.holdings) {
    if (h.qty <= 0) continue;
    const pos = state.positions[h.symbol];
    if (!pos) {
      state.positions[h.symbol] = {
        code: h.symbol, name: h.name || h.symbol, qty: h.qty,
        avgPrice: h.avgPrice || h.price, enteredAt: Date.now(), lastAddedAt: Date.now(),
        reason: "계좌 보유분 편입",
      };
      journal.push(entry("cycle", `미국 — 편입: ${h.name || h.symbol} ${h.qty}주(평단 $${(h.avgPrice || h.price).toFixed(2)})를 봇 운용으로 흡수합니다.`));
    } else if (h.qty > pos.qty) {
      pos.qty = h.qty;
      if (h.avgPrice) pos.avgPrice = h.avgPrice;
      pos.lastAddedAt = Date.now();
    }
  }
  // 현재가 기록 — 장 마감 후에도 대시보드가 마지막 관측가로 손익을 보여줄 수 있게
  for (const pos of Object.values(state.positions)) {
    const h = held.get(pos.code);
    if (h?.price) pos.lastPrice = h.price;
  }
  const GRACE_MS = 2 * 60 * 60 * 1000; // 방금 낸 주문의 체결·반영 대기
  for (const pos of Object.values(state.positions)) {
    const h = held.get(pos.code);
    const fresh = Date.now() - Math.max(pos.enteredAt, pos.lastAddedAt) < GRACE_MS;
    if (fresh) continue;
    if (!h || h.qty <= 0) {
      journal.push(entry("cycle", `미국 — 상태 정리: ${pos.name} 장부 ${pos.qty}주가 계좌에 없어 제거합니다.`));
      delete state.positions[pos.code];
    } else if (h.qty < pos.qty) {
      pos.qty = h.qty;
    }
  }

  /* 3) 손익(달러) = 보유 평가손익(계좌가 주는 값) + 실현손익 */
  const holdingsPnl = bal.holdings.reduce((s, h) => s + (h.pnl || 0), 0);
  out.pnlUsd = round(holdingsPnl + state.realizedPnlUsd, 2);

  /* 4) 예산·환율 — 매수가능금액(통합증거금) 조회가 환율까지 준다.
   * 기준 종목은 AAPL(항상 존재)로 고정 — 환율·주문가능 총액은 종목과 무관하다. */
  const reserveKrw = await getReserveKrw(env);
  let fx = 0;
  let orderableUsd = 0;
  try {
    const aapl = await usQuote(env, kis, "AAPL");
    const ps = await overseasPsamount(env, kis, "NASD", "AAPL", aapl.price);
    fx = ps.fx || 0;
    orderableUsd = Math.max(ps.totalOrderable, ps.frcrOrderable, ps.afterExchangeOrderable);
    out.psDetail = { frcr: ps.frcrOrderable, total: ps.totalOrderable, afterExchange: ps.afterExchangeOrderable, maxQty: ps.maxQty };
    // 주문가능금액이 0이면 살 돈이 없다는 뜻이다(통합증거금 미반영 등). maxQty 는
    // 잡히는데 금액만 0인 응답도 실측됐다 — 그때는 수량 기준으로 금액을 역산한다.
    if (orderableUsd <= 0 && ps.maxQty > 0) orderableUsd = ps.maxQty * aapl.price;
  } catch (err) {
    const msg = err instanceof ApiError ? `${err.message} ${JSON.stringify(err.detail ?? {})}` : String(err);
    journal.push(entry("error", `미국 — 매수가능금액 조회 실패: ${msg}. 이번 사이클 매수를 건너뜁니다(매도 판단은 계속).`));
  }
  if (!fx || fx < 800 || fx > 2500) fx = 1400; // 환율이 안 오면 보수적 고정값 — 예산이 뻥튀기되지 않게 높은 쪽
  out.fx = fx;
  out.orderableUsd = round(orderableUsd, 2);
  const budgetUsd = reserveKrw / fx;
  out.budgetUsd = round(budgetUsd, 2);

  const priceOf = (code: string) => held.get(code)?.price ?? state.positions[code]?.avgPrice ?? 0;
  const deployedUsd = Object.values(state.positions).reduce((s, p) => s + p.qty * (priceOf(p.code) || p.avgPrice), 0);
  out.deployedUsd = round(deployedUsd, 2);

  /* 5) 온톨로지 점수(레이더 미국) + 수급 행(시세·거래대금) */
  const ontoByCode = new Map<string, number>();
  try {
    const top = (await radarTop(env, 500, "desc")) as { items?: { code: string; score: number; market: string }[] };
    for (const it of top.items ?? []) if (it.market === "US") ontoByCode.set(it.code, it.score);
  } catch { /* 이번 사이클 매수만 쉰다 */ }
  const qRows = await usQuantRows(env).catch(() => []);
  /* 엔진별 점수 — 한국 봇과 무관하게 미국만의 엔진(auto:us:engine)을 쓴다 */
  const engine = await getUsEngine(env);
  const engineName = US_ENGINES.find((e) => e.id === engine)!.nameKo;
  const rowByCode = new Map(qRows.map((r) => [r.code, r]));
  const scoreOf = (code: string): number | undefined => {
    const o = ontoByCode.get(code);
    const r = rowByCode.get(code);
    const q = r?.scores?.["breakout"];
    const t = r?.taScore;
    switch (engine) {
      case "onto": return o;
      case "quant": return q;
      case "ta": return t;
      case "fusion": return o !== undefined && q !== undefined ? round((o + q) / 2, 3) : undefined;
    }
  };

  /* 6) 청산 판단 — 손절·익절·신호이탈. 정지 상태에서도 실행한다(정지는 신규 매수만 막는다). */
  for (const pos of Object.values(state.positions)) {
    const h = held.get(pos.code);
    const qty = Math.min(pos.qty, h?.qty ?? 0);
    if (qty <= 0) continue;
    const price = h?.price || pos.avgPrice;
    const pnlPct = pos.avgPrice ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : 0;
    const sc = scoreOf(pos.code);
    let why = "";
    if (pnlPct <= -cfg.stopLossPct) why = `손절 (${round(pnlPct, 1)}% ≤ -${cfg.stopLossPct}%)`;
    else if (pnlPct >= cfg.takeProfitPct) why = `익절 (${round(pnlPct, 1)}% ≥ +${cfg.takeProfitPct}%)`;
    else if (sc !== undefined && sc <= SELL_SCORE) why = `신호 이탈 (${engineName} ${sc})`;
    if (!why) continue;
    const limit = Math.max(0.01, round(price * (1 - SLIPPAGE), 2));
    out.orders.push({
      side: "sell", code: pos.code, name: pos.name,
      excd: "NAS", // 실제 거래소는 주문 직전에 usQuote 로 확정한다
      qty, price: limit,
      notionalUsd: round(limit * qty, 2), notionalKrw: Math.round(limit * qty * fx),
      score: sc ?? 0, reason: why,
    });
  }

  /* 7) 정지선 — 손익(달러) 기준, 한도는 예산 대비 % */
  if (state.peakPnlUsd === undefined || out.pnlUsd > state.peakPnlUsd) state.peakPnlUsd = out.pnlUsd;
  if (state.dayStartPnlUsd === undefined) state.dayStartPnlUsd = out.pnlUsd;
  const baseUsd = Math.max(1, budgetUsd);
  const ddPct = ((state.peakPnlUsd - out.pnlUsd) / baseUsd) * 100;
  // 한도 0 이하는 설정 오류 — 그걸로 정지를 걸지는 않는다 (2026-08-20 -0% 사고 재발 방지)
  if (cfg.maxDrawdownPct > 0 && ddPct >= cfg.maxDrawdownPct && !state.haltedPermanent) {
    state.haltedPermanent = true;
    state.haltReason = `고점 손익 대비 -${round(ddPct, 1)}% (예산 대비, 한도 -${cfg.maxDrawdownPct}%)`;
    journal.push(entry("halt", `미국 — 영구 정지: ${state.haltReason}. 사람이 확인 후 해제해야 합니다.`));
  }
  const dayLossPct = ((state.dayStartPnlUsd - out.pnlUsd) / baseUsd) * 100;
  if (cfg.dailyLossHaltPct > 0 && dayLossPct >= cfg.dailyLossHaltPct && state.haltedDay !== today) {
    state.haltedDay = today;
    state.haltReason = `당일 -${round(dayLossPct, 1)}% (예산 대비, 한도 -${cfg.dailyLossHaltPct}%)`;
    journal.push(entry("halt", `미국 — 당일 정지: ${state.haltReason}. 다음 거래일 자동 해제됩니다.`));
  }

  /* 8) 신규 매수 */
  const shadow = opts.shadow ?? !cfg.enabled;
  const blocked: string[] = [];
  if (state.haltedPermanent) blocked.push(`영구 정지: ${state.haltReason}`);
  if (state.haltedDay === today) blocked.push(`당일 정지: ${state.haltReason}`);
  if (state.tradesToday >= cfg.maxTradesPerDay) blocked.push(`당일 매매 한도(${cfg.maxTradesPerDay}회) 도달`);

  // 주문가능금액 0 = 통합증거금 미반영이거나 예수금 부족 — 실주문 모드에서는 매수를
  // 막는다(어차피 KIS 가 거절한다). 그림자 모드에서는 계획을 계속 보여줘 검증을 돕는다.
  if (!shadow && orderableUsd <= 0) {
    blocked.push("KIS 주문가능금액 $0 — 통합증거금 미반영 또는 예수금 부족");
  }

  // 시장 국면 필터 — S&P500 이 20일선 아래면 신규 매수 없음
  let marketNote = "";
  try {
    const [spx] = await getSparkMany(env, ["^GSPC"], "6mo");
    if (spx && spx.closes.length >= 21) {
      const ma = sma(spx.closes, 20);
      const last = spx.closes.at(-1)!;
      if (last < ma) blocked.push(`S&P500 ${Math.round(last)} < 20일선 ${Math.round(ma)} — 신규 매수 정지`);
      marketNote = `S&P500 ${Math.round(last)} vs 20일선 ${Math.round(ma)}`;
    }
  } catch { /* 지수 조회 실패 — 필터 통과 */ }

  if (!blocked.length) {
    /* 신선 창 20시간 — 6시간이면 개장 직후 후보 풀이 말라 매수가 통째로 막힌다
     * (2026-08-19 실측: 개장 15분 후 풀 20/50. 밤새는 시간당 크론 1번이라 스캔이 못 따라감).
     * 미국 종목은 장외에는 가격이 안 움직이므로 전일 장중 스캔값도 선별용으로 유효하고,
     * 실제 지정가는 주문 직전 실시간 시세(usQuote)로 잡으므로 낡은 가격에 사는 일은 없다. */
    const fresh = Date.now() - 20 * 3600_000;
    const cands = qRows
      .filter((r) => r.scannedAt >= fresh && r.turnover >= MIN_TURNOVER_USD && r.price > 0)
      .map((r) => ({ r, score: scoreOf(r.code) }))
      .filter((x): x is { r: (typeof qRows)[number]; score: number } => x.score !== undefined)
      .sort((a, b) => b.score - a.score);
    if (cands.length < cfg.minPool) {
      blocked.push(`후보 풀 ${cands.length}/${cfg.minPool}종목 — 스캔이 찰 때까지 매수하지 않습니다`);
    } else {
      const perPositionCap = (budgetUsd * cfg.maxPositionPct) / 100;
      let remaining = Math.max(0, budgetUsd - deployedUsd);
      let cashLeft = orderableUsd > 0 ? orderableUsd : remaining;
      const minOrderUsd = cfg.minOrderKrw / fx;
      /* 섹터 분산 — 백테스트 검증(2026-08-21 QKC3, 1년 수익 거의 그대로 +63.3%→+63.3%지만
       * 최대낙폭 -18.5%→-15.5%)을 실계좌에 반영한다. 온톨로지는 국면 추종이라 순풍인
       * 섹터가 상위를 도배하기 쉽다 — 실측으로도 미국 픽이 3일 연속 에너지 4~5/5였고
       * 그 섹터가 꺾인 날 보유 4종목 중 3개가 동시에 졌다. 신규 진입만 막는다(이미
       * 보유 중인 종목의 추가 매수는 그대로 허용) — 이미 산 걸 억지로 팔진 않는다. */
      const SECTOR_CAP = 3;
      const sectorOf = (code: string): string | undefined => rowByCode.get(code)?.sector;
      const heldSectorCount = new Map<string, number>();
      for (const code of Object.keys(state.positions)) {
        const s = sectorOf(code);
        if (s) heldSectorCount.set(s, (heldSectorCount.get(s) ?? 0) + 1);
      }
      let buys = 0;
      for (const { r, score } of cands) {
        if (buys >= cfg.maxOrdersPerCycle) break;
        if (score < cfg.buyScore) break;
        const pos = state.positions[r.code];
        if (!pos && Object.keys(state.positions).length + buys >= cfg.maxPositions) continue;
        if (!pos && r.sector && (heldSectorCount.get(r.sector) ?? 0) >= SECTOR_CAP) continue;
        const currentValue = pos ? pos.qty * (priceOf(r.code) || r.price) : 0;
        const room = Math.min(perPositionCap - currentValue, remaining, cashLeft);
        const sized = room * Math.min(1, 0.7 + score * 1.5);
        if (sized < minOrderUsd) continue;
        // 지정가는 스캔 시세가 아니라 **지금** KIS 시세로 잡는다 — 스캔은 최대 6시간 묵었다
        let excd: OrderMarket;
        let live: number;
        try {
          const q = await usQuote(env, kis, r.code);
          excd = q.excd;
          live = q.price;
        } catch {
          continue; // 시세가 안 오는 종목은 건너뛴다
        }
        const limit = round(live * (1 + SLIPPAGE), 2);
        if (limit > room) continue; // 1주 값이 한도 초과
        const qty = Math.floor(sized / limit);
        if (qty < 1) continue;
        const notionalUsd = limit * qty;
        if (notionalUsd < minOrderUsd || notionalUsd > cashLeft) continue;
        remaining -= notionalUsd;
        cashLeft -= notionalUsd;
        buys++;
        if (!pos && r.sector) heldSectorCount.set(r.sector, (heldSectorCount.get(r.sector) ?? 0) + 1);
        out.orders.push({
          side: "buy", code: r.code, name: r.name, excd, qty, price: limit,
          notionalUsd: round(notionalUsd, 2), notionalKrw: Math.round(notionalUsd * fx),
          score, reason: pos ? `추가 매수 (${engineName} ${score})` : `신규 진입 (${engineName} ${score})`,
        });
      }
    }
  }

  /* 9) 실행 — 매도 먼저(현금 확보), 그 다음 매수 */
  out.shadow = shadow;
  out.ran = true;
  const queue = [...out.orders].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));

  if (shadow) {
    if (queue.length) {
      journal.push(
        entry("skip", `미국 그림자 실행 — ${queue.length}건 계획, 주문 미전송 (US_AUTOTRADE_ENABLED=false). 환율 ${fx} · 주문가능 $${round(orderableUsd, 2)} · 예산 $${round(budgetUsd, 2)}`, {
          orders: queue.map((o) => `${o.side === "buy" ? "매수" : "매도"} ${o.name}(${o.code}/${o.excd}) ${o.qty}주 @$${o.price} ≈ ${o.notionalKrw.toLocaleString("ko-KR")}원 — ${o.reason}`),
        }),
      );
    }
  } else {
    for (const o of queue) {
      if (state.tradesToday >= cfg.maxTradesPerDay) break;
      try {
        // 매도는 청산 단계에서 거래소를 확정하지 않았다 — 주문 직전에 확정
        const excd = o.side === "sell" ? (await usQuote(env, kis, o.code)).excd : o.excd;
        const res = await placeOrder(env, kis, {
          market: excd, code: o.code, side: o.side, qty: o.qty, price: o.price,
          orderType: "limit", notionalKrw: o.notionalKrw,
        });
        state.tradesToday += 1;
        applyUsFill(state, o);
        // 결제 예상 현금흐름 기록 — 국내 봇의 입출금 감지가 이 금액을 미국 결제로 설명한다
        await addUsCashflowKrw(env, o.side === "buy" ? o.notionalKrw : -o.notionalKrw);
        out.results.push({ code: o.code, side: o.side, ok: true, message: res.message });
        journal.push(
          entry("order", `미국 ${o.side === "buy" ? "매수" : "매도"} ${o.name}(${o.code}) ${o.qty}주 @$${o.price} ≈ ${o.notionalKrw.toLocaleString("ko-KR")}원 — ${o.reason}`, {
            orderNo: res.orderNo, excd, fx,
          }),
        );
      } catch (err) {
        const msg = err instanceof ApiError ? `${err.message} ${JSON.stringify(err.detail ?? {})}` : String(err);
        out.results.push({ code: o.code, side: o.side, ok: false, message: msg });
        journal.push(entry("error", `미국 ${o.name} ${o.side === "buy" ? "매수" : "매도"} 실패 — ${msg}`));
      }
    }
  }

  /* 하루 한 번은 상태를 일지에 남긴다 — 밤새 15분마다 쓰면 도배가 된다 */
  if (firstOfDay) {
    journal.push(
      entry("cycle", `미국 사이클 시작(${today} ET) — 예산 ${reserveKrw.toLocaleString("ko-KR")}원 ≈ $${round(budgetUsd, 2)} · 보유 ${Object.keys(state.positions).length}종목 · 손익 $${out.pnlUsd} · ${marketNote || "시장필터 데이터 없음"} · ${shadow ? "그림자(주문 미전송)" : "실주문 가동"}`),
    );
  }

  state.lastCycleAt = Date.now();
  state.lastFx = fx;
  state.lastValueUsd = round(
    Object.values(state.positions).reduce((s, p) => s + p.qty * (held.get(p.code)?.price || p.avgPrice), 0),
    2,
  );
  await saveUsState(env, state);

  /* KIS 잔고 스냅샷 — 대시보드는 이 실측값만 본다. 손익도 KIS 가 주는 값(frcr_evlu_pfls)
   * 그대로다. 우리 장부(avgPrice 추정)로 계산해 만든 왜곡(2026-08-18 사용자 보고
   * "-748,587원, 계산이 맞냐")의 재발 방지. 방금 낸 주문은 다음 사이클(≤15분)에 잡힌다. */
  await env.CACHE.put(
    BALANCE_KEY,
    JSON.stringify({
      at: Date.now(),
      fx,
      holdings: bal.holdings,
      totalEvalUsd: round(bal.holdings.reduce((s, h) => s + (h.evalAmount || h.qty * h.price), 0), 2),
      holdingsPnlUsd: round(bal.holdings.reduce((s, h) => s + (h.pnl || 0), 0), 2),
      realizedPnlUsd: state.realizedPnlUsd,
    }),
    { expirationTtl: 7 * 86_400 },
  ).catch(() => undefined);
  await appendJournal(env, journal);
  const noteParts = [
    shadow ? "그림자" : "실주문",
    `계획 ${out.orders.length}건`,
    blocked[0] ?? "",
  ].filter(Boolean);
  return finish(noteParts.join(" · "));
}

/** 주문 접수를 장부에 반영 — 체결 확인은 다음 사이클의 잔고 대사가 한다 */
function applyUsFill(state: UsAutoState, o: UsPlannedOrder): void {
  const pos = state.positions[o.code];
  if (o.side === "buy") {
    if (pos) {
      const total = pos.qty + o.qty;
      pos.avgPrice = total ? (pos.avgPrice * pos.qty + o.price * o.qty) / total : o.price;
      pos.qty = total;
      pos.lastAddedAt = Date.now();
      pos.reason = o.reason;
    } else {
      state.positions[o.code] = {
        code: o.code, name: o.name, qty: o.qty, avgPrice: o.price,
        enteredAt: Date.now(), lastAddedAt: Date.now(), reason: o.reason,
      };
    }
  } else if (pos) {
    // 왕복 비용(수수료+환전 스프레드) 0.5% 를 보수적으로 차감
    const qty = Math.min(o.qty, pos.qty);
    const gross = (o.price - pos.avgPrice) * qty;
    const cost = o.price * qty * 0.005;
    state.realizedPnlUsd = round(state.realizedPnlUsd + gross - cost, 2);
    pos.qty -= o.qty;
    if (pos.qty <= 0) delete state.positions[o.code];
  }
}

/** 운영 조회 — /api/auto/us/status */
export async function usAutoStatus(env: Env) {
  const [state, last] = await Promise.all([
    loadUsState(env),
    env.CACHE.get(LAST_KEY, "json").catch(() => null),
  ]);
  return {
    config: usAutoConfig(env),
    marketOpen: usMarketOpen(),
    reserveKrw: await getReserveKrw(env),
    state,
    last,
  };
}
