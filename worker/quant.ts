/**
 * 퀀트 트랙 — 수급·차트만 보는 두 번째 매매 엔진 (모의매매).
 *
 * 온톨로지 트랙(worker/autotrade.ts)과 **완전히 분리**되어 있다.
 *   - 자금·상태·손익 원장이 따로다 (KV: quant:*).
 *   - 거시·뉴스·섹터를 일절 보지 않는다. shared/quant.ts 의 점수만 쓴다.
 *   - **주문을 내지 않는다.** 실계좌는 건드리지 않고 장부상으로만 사고판다.
 *
 * 왜 모의인가 — 백테스트에서 이 엔진은 온톨로지 트랙에 모든 구간(3·6·12개월)에서
 * 졌다. 진 전략에 실제 돈을 넣지 않는다. 대신 같은 규칙을 실시간으로 돌려
 * **앞으로의 성적**을 쌓는다. 백테스트는 과거를 설명할 뿐이고, 두 엔진을 같은
 * 시장에서 나란히 굴려 봐야 어느 쪽이 실제로 맞는지 알 수 있다.
 *
 * 매매 규칙은 백테스트에서 유일하게 살아남은 조합을 그대로 옮겼다(QM/QI):
 *   ① 시장 국면 필터 — 코스피가 20일선 아래면 신규 매수 없음
 *   ② 저회전         — 문턱 0.35 · 익절 +15% · 손절 -6% · 시간청산/교체 없음
 * 회전율을 낮춘 이유는 단순하다. 왕복 비용(슬리피지 0.6% + 세금·수수료 0.23%)이
 * 0.83% 라, 하루짜리 매매를 반복하면 신호가 맞아도 비용으로 죽는다.
 */
import type { Env } from "./env";
import seedData from "../shared/radar-universe.json";
import { QUANT_PROFILES, profileById, quantSignal, scoreFromParts, type QuantParts, type QuantSignal } from "../shared/quant";
import { consensus, runStrategies } from "../shared/ta";
import { sma } from "../shared/scoring";
import { getSeries, getSparkMany } from "./quotes";
import { round } from "./util";

/* ── 유니버스 ─────────────────────────────── */

interface Seed { code: string; symbol: string; name: string; market: string; sector: string; src?: string }

/**
 * 퀀트 유니버스 — 코스피200 편입 종목(120개).
 * 온톨로지 레이더(454종목)보다 좁힌 이유는 데이터 때문이다. 수급 지표(MFI·매집강도·
 * 거래대금)에는 거래량이 필요한데, 거래량이 오는 경로는 종목당 호출 1회다
 * (온톨로지 레이더가 쓰는 spark 배치는 종가만 준다). 크론 한 번의 서브리퀘스트
 * 예산이 50이라 조각으로 나눠 돈다.
 */
const UNIVERSE: Seed[] = (seedData as Seed[]).filter((s) => (s.src ?? "").startsWith("k200"));

/** 한 크론에서 훑는 종목 수 — 자동매매·레이더와 예산(50)을 나눠 쓴다 */
const CHUNK = 12;

/* ── 설정 ─────────────────────────────── */

function cfg(env: Env) {
  const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
  return {
    enabled: env.QUANT_ENABLED !== "false",
    profile: profileById(env.QUANT_PROFILE || "breakout"),
    capital: n(env.QUANT_CAPITAL_KRW, 4_000_000),
    maxPositions: n(env.QUANT_MAX_POSITIONS, 5),
    maxPositionPct: n(env.QUANT_MAX_POSITION_PCT, 30),
    maxOrderKrw: n(env.QUANT_MAX_ORDER_KRW, 1_200_000),
    minOrderKrw: n(env.QUANT_MIN_ORDER_KRW, 150_000),
    maxBuysPerDay: n(env.QUANT_MAX_BUYS_PER_DAY, 3),
    buyScore: n(env.QUANT_BUY_SCORE, 0.35),
    sellScore: n(env.QUANT_SELL_SCORE, -0.05),
    stopPct: n(env.QUANT_STOP_LOSS_PCT, 6),
    takePct: n(env.QUANT_TAKE_PROFIT_PCT, 15),
    /** 코스피가 이 이동평균 아래면 신규 매수 정지 (0 이면 끔) */
    marketMaDays: n(env.QUANT_MARKET_MA_DAYS, 20),
    maxDrawdownPct: n(env.QUANT_MAX_DRAWDOWN_PCT, 20),
    /** 모의 체결에 반영하는 슬리피지 — 백테스트와 같은 값이라야 비교가 성립한다 */
    slippage: 0.003,
    roundTripCost: 0.0023,
    /** 이보다 얇은 종목은 후보에서 뺀다(원) */
    minTurnover: 500_000_000,
    /**
     * 후보 풀이 이만큼 차기 전에는 매수하지 않는다.
     * 스캔이 조각 단위라 초기에는 유니버스의 앞부분(가나다순 12종목)만 점수가 있고,
     * 그 상태로 사면 "제일 좋은 종목"이 아니라 "제일 먼저 스캔된 종목"을 사게 된다.
     */
    minPool: n(env.QUANT_MIN_POOL, 60),
  };
}

export type QuantConfig = ReturnType<typeof cfg>;

/* ── 저장 구조 ─────────────────────────────── */

export interface QuantRow {
  code: string;
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  /** 프로파일별 점수 */
  scores: Record<string, number>;
  /** 차트 거장 전략 13종 합의 점수 (-1~1) — 전략실 3호가 쓴다 */
  taScore?: number;
  parts: QuantParts;
  raw: QuantSignal["raw"];
  turnover: number;
  atr: number;
  reasons: { text: string; contribution: number }[];
  scannedAt: number;
}

interface RankStore {
  rows: Record<string, QuantRow>;
  cursor: number;
  updatedAt: number;
}

export interface QuantPosition {
  code: string;
  name: string;
  symbol: string;
  qty: number;
  avgPrice: number;
  lastPrice: number;
  peakPrice: number;
  enteredAt: number;
  score: number;
}

export interface QuantTrade {
  at: number;
  code: string;
  name: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  pnl?: number;
  pnlPct?: number;
  reason: string;
}

export interface QuantState {
  cash: number;
  positions: Record<string, QuantPosition>;
  realizedPnl: number;
  trades: QuantTrade[];
  day: string;
  buysToday: number;
  peakEquity: number;
  haltedPermanent: boolean;
  haltReason: string;
  startedAt: number;
  lastCycleAt: number;
  lastNote: string;
  /**
   * 일별 평가금액 기록 — 수익률 곡선용.
   * 하루 한 점만 남긴다(같은 날 다시 돌면 덮어쓴다). 사이클마다 쌓으면 장중 노이즈가
   * 곡선을 뒤덮고 KV 값도 금방 커진다.
   */
  equityCurve?: { d: string; e: number }[];
}

const RANK_KEY = "quant:rank";
// v2 — 후보 풀 게이트를 넣기 전의 초기 매수(스캔 12종목 시점)를 성적에서 제외하려고 키를 올렸다
const STATE_KEY = "quant:state:v2";

async function loadRank(env: Env): Promise<RankStore> {
  const raw = await env.CACHE.get(RANK_KEY, "json");
  if (raw && typeof raw === "object") return raw as RankStore;
  return { rows: {}, cursor: 0, updatedAt: 0 };
}

export async function loadQuantState(env: Env): Promise<QuantState> {
  const raw = await env.CACHE.get(STATE_KEY, "json");
  if (raw && typeof raw === "object") return raw as QuantState;
  const c = cfg(env);
  return {
    cash: c.capital,
    positions: {},
    realizedPnl: 0,
    trades: [],
    day: "",
    buysToday: 0,
    peakEquity: c.capital,
    haltedPermanent: false,
    haltReason: "",
    startedAt: Date.now(),
    lastCycleAt: 0,
    lastNote: "",
  };
}

async function saveQuantState(env: Env, s: QuantState): Promise<void> {
  // 체결 기록은 최근 200건만 남긴다 — KV 값 크기(25MB)보다 읽기 비용이 문제다
  s.trades = s.trades.slice(-200);
  if (s.equityCurve) s.equityCurve = s.equityCurve.slice(-400);
  await env.CACHE.put(STATE_KEY, JSON.stringify(s));
}

/* ── 스캔 ─────────────────────────────── */

const kstDay = (t = Date.now()) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 유니버스 한 조각을 훑어 점수를 갱신한다.
 * 일봉 기반 점수라 조각 단위로 1~2시간에 한 바퀴여도 판단이 흔들리지 않는다.
 */
export async function quantScanChunk(env: Env): Promise<{ scanned: number; cursor: number; skipped: number }> {
  const store = await loadRank(env);
  const start = store.cursor % Math.max(1, UNIVERSE.length);
  const slice: Seed[] = [];
  for (let i = 0; i < CHUNK && i < UNIVERSE.length; i++) slice.push(UNIVERSE[(start + i) % UNIVERSE.length]);

  // 시장 지수 — 상대강도 계산용
  let marketCloses: number[] = [];
  try {
    const [ks] = await getSparkMany(env, ["^KS11"], "6mo");
    if (ks) marketCloses = ks.closes;
  } catch { /* 상대강도만 0 이 된다 */ }

  let scanned = 0;
  let skipped = 0;
  const now = Date.now();
  for (let i = 0; i < slice.length; i += 5) {
    const batch = slice.slice(i, i + 5);
    const got = await Promise.allSettled(batch.map((s) => getSeries(env, s.symbol, "1y")));
    got.forEach((res, k) => {
      const seed = batch[k];
      if (res.status !== "fulfilled") { skipped++; return; }
      const s = res.value;
      if (s.closes.length < 70 || !s.volumes.length) { skipped++; return; }
      const hist = { price: s.price, closes: s.closes, highs: s.highs, lows: s.lows, volumes: s.volumes };
      const sig = quantSignal({ hist, market: marketCloses }, QUANT_PROFILES[0]);
      const scores: Record<string, number> = {};
      for (const p of QUANT_PROFILES) scores[p.id] = scoreFromParts(sig.parts, p);
      // 차트 거장 13종 합의 — 사다리·플랜 계산은 빼고 전략 판정만(속도).
      // 백테스트(quant-backtest.ts ta 엔진)와 정확히 같은 식이라야 성적 비교가 성립한다.
      const taScore = round(consensus(runStrategies(hist)).score, 3);
      store.rows[seed.code] = {
        code: seed.code,
        symbol: seed.symbol,
        name: seed.name,
        sector: seed.sector,
        price: s.price,
        changePct: s.changePct,
        scores,
        taScore,
        parts: sig.parts,
        raw: sig.raw,
        turnover: Math.round(sig.turnover),
        atr: round(sig.atr, 2),
        reasons: sig.reasons,
        scannedAt: now,
      };
      scanned++;
    });
  }

  store.cursor = (start + slice.length) % UNIVERSE.length;
  store.updatedAt = now;
  await env.CACHE.put(RANK_KEY, JSON.stringify(store));
  return { scanned, cursor: store.cursor, skipped };
}

export interface QuantRankResult {
  profile: { id: string; nameKo: string };
  universe: number;
  scanned: number;
  updatedAt: number;
  rows: (QuantRow & { score: number })[];
}

export async function quantRank(env: Env, profileId?: string, limit = 20): Promise<QuantRankResult> {
  const c = cfg(env);
  const profile = profileId ? profileById(profileId) : c.profile;
  const store = await loadRank(env);
  const rows = Object.values(store.rows)
    .filter((r) => r.turnover >= c.minTurnover)
    .map((r) => ({ ...r, score: r.scores[profile.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return {
    profile: { id: profile.id, nameKo: profile.nameKo },
    universe: UNIVERSE.length,
    scanned: Object.keys(store.rows).length,
    updatedAt: store.updatedAt,
    rows: rows.slice(0, limit),
  };
}

/* ── 모의매매 ─────────────────────────────── */

/** 코스피가 이동평균 위인가 — 신규 매수 게이트 */
async function marketOk(env: Env, c: QuantConfig): Promise<{ ok: boolean; note: string }> {
  if (!c.marketMaDays) return { ok: true, note: "시장 필터 꺼짐" };
  try {
    const [ks] = await getSparkMany(env, ["^KS11"], "6mo");
    if (!ks || ks.closes.length < c.marketMaDays + 1) return { ok: true, note: "지수 데이터 부족 — 필터 통과" };
    const ma = sma(ks.closes, c.marketMaDays);
    const last = ks.closes.at(-1)!;
    return {
      ok: last >= ma,
      note: `코스피 ${Math.round(last)} vs ${c.marketMaDays}일선 ${Math.round(ma)} — ${last >= ma ? "위(매수 허용)" : "아래(신규 매수 정지)"}`,
    };
  } catch {
    return { ok: true, note: "지수 조회 실패 — 필터 통과" };
  }
}

export interface QuantCycleResult {
  ran: boolean;
  note: string;
  actions: QuantTrade[];
  equity: number;
}

/* ── 전략실 — 4개 전략의 독립 모의 원장 ─────────────────────
 *
 * 사이트의 목적: 세 가지 분석 방식(온톨로지·수급·차트)과 그 조합을 **같은 규칙으로
 * 나란히 굴려** 성적을 공개하고, 그중 하나를 골라 실계좌 자동매매로 잇는 것이다.
 * 그래서 전략마다 원장(현금·보유·체결·수익률 곡선)이 완전히 분리되어 있다 —
 * 섞이면 어느 방식이 돈을 벌었는지 영영 알 수 없다.
 *
 * 매매 규칙(손절·익절·한도·시장필터)은 네 전략이 동일하다. 다른 것은 오직
 * "무엇을 살 것인가"의 점수 하나다. 규칙까지 다르면 비교가 아니라 각자 놀기다.
 */

export type LabId = "onto" | "quant" | "ta" | "fusion";

export const LAB_STRATEGIES: {
  id: LabId;
  no: number;
  nameKo: string;
  tagKo: string;
  descKo: string;
  /** 이 전략이 지금 실계좌를 움직이고 있는가는 auto:engine 값으로 판정한다 */
  engineId: string | null;
}[] = [
  {
    id: "onto", no: 1, nameKo: "온톨로지", tagKo: "거시 인과",
    descKo: "환율·금리·유가 같은 거시 신호가 업종을 거쳐 종목으로 전파되는 인과를 계산해 고릅니다.",
    engineId: "onto",
  },
  {
    id: "quant", no: 2, nameKo: "수급·차트", tagKo: "돌파+거래대금",
    descKo: "이유는 묻지 않고 돈의 흐름만 봅니다 — 신고가 돌파, 거래대금 급증, 자금흐름·매집강도.",
    engineId: "quant",
  },
  {
    id: "ta", no: 3, nameKo: "차트 거장", tagKo: "전략 13종 합의",
    descKo: "이평교차·MACD·일목균형표·터틀 등 창시자가 있는 차트 전략 13종의 합의로 고릅니다.",
    engineId: "ta",
  },
  {
    id: "fusion", no: 4, nameKo: "융합", tagKo: "온톨로지+수급",
    descKo: "온톨로지와 수급·차트 점수를 반반 섞습니다 — 둘 다 좋다고 할 때만 삽니다.",
    engineId: "hybrid",
  },
];

/** quant 원장은 예전 퀀트 트랙 키를 그대로 이어받는다(쌓인 성적 유지) */
function labStateKey(id: LabId): string {
  return id === "quant" ? STATE_KEY : `lab:state:${id}`;
}

async function loadLabState(env: Env, id: LabId): Promise<QuantState> {
  const raw = await env.CACHE.get(labStateKey(id), "json");
  if (raw && typeof raw === "object") return raw as QuantState;
  const c = cfg(env);
  return {
    cash: c.capital, positions: {}, realizedPnl: 0, trades: [], day: "", buysToday: 0,
    peakEquity: c.capital, haltedPermanent: false, haltReason: "", startedAt: Date.now(),
    lastCycleAt: 0, lastNote: "",
  };
}

async function saveLabState(env: Env, id: LabId, s: QuantState): Promise<void> {
  s.trades = s.trades.slice(-200);
  if (s.equityCurve) s.equityCurve = s.equityCurve.slice(-400);
  await env.CACHE.put(labStateKey(id), JSON.stringify(s));
}

/** 전략별 점수 — 다른 것은 이 함수 하나뿐이다 */
function labScore(id: LabId, row: QuantRow, ontoByCode: Map<string, number>): number | undefined {
  const q = row.scores["breakout"];
  const t = row.taScore;
  const o = ontoByCode.get(row.code);
  switch (id) {
    case "quant": return q;
    case "ta": return t;
    case "onto": return o;
    case "fusion": return o !== undefined && q !== undefined ? round((o + q) / 2, 3) : undefined;
  }
}

/**
 * 원장 하나를 한 사이클 진행한다 — 청산 → 낙폭 정지 → 매수.
 * 실제 주문은 절대 내지 않는다. 장부 갱신이 전부다.
 */
function runLedger(
  c: QuantConfig,
  state: QuantState,
  byCode: Record<string, QuantRow>,
  scoreOf: (row: QuantRow) => number | undefined,
  market: { ok: boolean; note: string },
  labelKo: string,
  now: number,
  today: string,
): QuantCycleResult {
  if (state.day !== today) {
    state.day = today;
    state.buysToday = 0;
  }
  const actions: QuantTrade[] = [];

  const sell = (p: QuantPosition, price: number, reason: string) => {
    const fill = price * (1 - c.slippage);
    const gross = fill * p.qty;
    const proceeds = gross - gross * c.roundTripCost;
    const invested = p.avgPrice * p.qty;
    state.cash += proceeds;
    state.realizedPnl = Math.round(state.realizedPnl + (proceeds - invested));
    const t: QuantTrade = {
      at: now, code: p.code, name: p.name, side: "SELL", qty: p.qty, price: Math.round(fill),
      pnl: Math.round(proceeds - invested), pnlPct: round(((proceeds - invested) / invested) * 100, 2), reason,
    };
    actions.push(t);
    state.trades.push(t);
    delete state.positions[p.code];
  };

  /* 1) 청산 — 손절 · 익절 · 신호 이탈 */
  for (const p of Object.values(state.positions)) {
    const row = byCode[p.code];
    const px = p.lastPrice || row?.price || p.avgPrice;
    const pnlPct = ((px - p.avgPrice) / p.avgPrice) * 100;
    if (pnlPct <= -c.stopPct) { sell(p, px, `손절 -${c.stopPct}%`); continue; }
    if (pnlPct >= c.takePct) { sell(p, px, `익절 +${c.takePct}%`); continue; }
    const sc = row ? scoreOf(row) : undefined;
    if (sc !== undefined && row && now - row.scannedAt < 24 * 3600_000 && sc <= c.sellScore) {
      sell(p, px, `신호 이탈 (${sc.toFixed(2)})`);
    }
  }

  /* 2) 낙폭 영구 정지 */
  let holdings = 0;
  for (const p of Object.values(state.positions)) holdings += p.qty * (p.lastPrice || p.avgPrice);
  const equity = state.cash + holdings;
  if (equity > state.peakEquity) state.peakEquity = equity;
  if (!state.haltedPermanent && state.peakEquity > 0 && ((state.peakEquity - equity) / state.peakEquity) * 100 >= c.maxDrawdownPct) {
    state.haltedPermanent = true;
    state.haltReason = `${today} 고점대비 -${(((state.peakEquity - equity) / state.peakEquity) * 100).toFixed(1)}%`;
  }

  /* 3) 매수 */
  let note = "";
  if (state.haltedPermanent) {
    note = `영구 정지 — ${state.haltReason}`;
  } else if (state.buysToday >= c.maxBuysPerDay) {
    note = `오늘 매수 한도(${c.maxBuysPerDay}건) 소진`;
  } else {
    note = market.note;
    if (market.ok) {
      const fresh = now - 6 * 3600_000;
      const cands = Object.values(byCode)
        .filter((r) => r.scannedAt >= fresh && r.turnover >= c.minTurnover)
        .map((r) => ({ r, score: scoreOf(r) }))
        .filter((x): x is { r: QuantRow; score: number } => x.score !== undefined)
        .sort((a, b) => b.score - a.score);
      if (cands.length < c.minPool) {
        note = `후보 풀 ${cands.length}/${c.minPool}종목 — 스캔이 한 바퀴 돌기 전에는 매수하지 않습니다`;
      } else {
        const perPositionCap = (c.capital * c.maxPositionPct) / 100;
        for (const { r, score } of cands) {
          if (state.buysToday >= c.maxBuysPerDay) break;
          if (score < c.buyScore) break;
          const existing = state.positions[r.code];
          if (!existing && Object.keys(state.positions).length >= c.maxPositions) continue;
          const currentValue = existing ? existing.qty * r.price : 0;
          const room = Math.min(perPositionCap - currentValue, c.maxOrderKrw, state.cash);
          const sized = room * Math.min(1, 0.7 + score * 1.5);
          if (sized < c.minOrderKrw) continue;
          const fill = r.price * (1 + c.slippage);
          const qty = Math.floor(sized / fill);
          if (qty < 1) continue;
          const cost = qty * fill;
          if (cost > state.cash) continue;
          state.cash -= cost;
          if (existing) {
            const total = existing.qty + qty;
            existing.avgPrice = (existing.avgPrice * existing.qty + fill * qty) / total;
            existing.qty = total;
            existing.score = score;
          } else {
            state.positions[r.code] = {
              code: r.code, name: r.name, symbol: r.symbol, qty,
              avgPrice: fill, lastPrice: r.price, peakPrice: r.price, enteredAt: now, score,
            };
          }
          const t: QuantTrade = { at: now, code: r.code, name: r.name, side: "BUY", qty, price: Math.round(fill), reason: `점수 ${score.toFixed(2)} · ${labelKo}` };
          actions.push(t);
          state.trades.push(t);
          state.buysToday++;
        }
      }
    }
  }

  /* 수익률 곡선 — 하루 한 점 */
  let finalHold = 0;
  for (const p of Object.values(state.positions)) finalHold += p.qty * (p.lastPrice || p.avgPrice);
  const eqNow = Math.round(state.cash + finalHold);
  const curve = state.equityCurve ?? [];
  if (curve.length && curve[curve.length - 1].d === today) curve[curve.length - 1].e = eqNow;
  else curve.push({ d: today, e: eqNow });
  state.equityCurve = curve;
  state.lastCycleAt = now;
  state.lastNote = note;

  return { ran: true, note, actions, equity: eqNow };
}

/**
 * 전략실 한 사이클 — 공유 데이터(랭킹·시세·시장필터·온톨로지 점수)를 한 번만 받아
 * 네 원장을 순서대로 진행한다. 서브리퀘스트 예산(50) 때문에 전략마다 따로 받으면 안 된다.
 */
export async function labCycle(env: Env): Promise<{ ran: boolean; results: Record<string, QuantCycleResult> }> {
  const c = cfg(env);
  if (!c.enabled) return { ran: false, results: {} };

  const today = kstDay();
  const now = Date.now();
  const store = await loadRank(env);
  const byCode = store.rows;

  // 온톨로지 점수 — 레이더 DB에서 한 번에 (KR 전 종목)
  const ontoByCode = new Map<string, number>();
  try {
    const { radarTop } = await import("./radarscan");
    // 레이더의 market 값은 "KOSPI"/"KOSDAQ"/"US" 다 — "KR" 로 필터하면 0건이 나온다(실측).
    // 필터 없이 받아서 미국만 걸러낸다.
    const top = await radarTop(env, 500, "desc") as { items?: { code: string; score: number; market: string }[] };
    for (const it of top.items ?? []) if (it.market !== "US") ontoByCode.set(it.code, it.score);
  } catch { /* onto·fusion 원장만 이번 사이클을 쉰다 */ }

  const market = await marketOk(env, c);

  // 네 원장 상태를 모두 읽고, 보유 종목 현재가를 **한 번에** 받는다
  const states = new Map<LabId, QuantState>();
  for (const st of LAB_STRATEGIES) states.set(st.id, await loadLabState(env, st.id));
  const heldSymbols = [...new Set([...states.values()].flatMap((s) => Object.values(s.positions).map((p) => p.symbol)))];
  if (heldSymbols.length) {
    try {
      const sp = await getSparkMany(env, heldSymbols, "1mo");
      const price = new Map(sp.map((x) => [x.symbol.toUpperCase(), x.price]));
      for (const st of states.values()) {
        for (const p of Object.values(st.positions)) {
          const v = price.get(p.symbol.toUpperCase());
          if (v) {
            p.lastPrice = v;
            if (v > p.peakPrice) p.peakPrice = v;
          }
        }
      }
    } catch { /* 직전 가격으로 판단 */ }
  }

  const results: Record<string, QuantCycleResult> = {};
  for (const strat of LAB_STRATEGIES) {
    const state = states.get(strat.id)!;
    results[strat.id] = runLedger(
      c, state, byCode,
      (row) => labScore(strat.id, row, ontoByCode),
      // onto 점수를 못 받았으면 onto·fusion 은 후보가 0이 되어 자연히 매수가 없다
      market, strat.nameKo, now, today,
    );
    await saveLabState(env, strat.id, state);
  }
  return { ran: true, results };
}

/* ── 전략실 조회 ─────────────────────────────── */

export interface LabStrategyView {
  id: LabId;
  no: number;
  nameKo: string;
  tagKo: string;
  descKo: string;
  engineId: string | null;
  /** 지금 실계좌를 이 전략이 움직이고 있는가 */
  liveNow: boolean;
  capital: number;
  equity: number;
  cash: number;
  pnlKrw: number;
  pnlPct: number;
  maxDrawdownPct: number;
  positions: (QuantPosition & { pnl: number; pnlPct: number; holdDays: number })[];
  /** 최근 이탈(매도) 종목 */
  exits: QuantTrade[];
  equityCurve: { d: string; e: number }[];
  tradeStats: { total: number; wins: number; winRate: number };
  haltedPermanent: boolean;
  haltReason: string;
  lastNote: string;
  lastCycleAt: number;
  startedAt: number;
}

export async function labOverview(env: Env): Promise<{
  disclaimer: string;
  universe: number;
  scanned: number;
  scanUpdatedAt: number;
  liveEngine: string;
  strategies: LabStrategyView[];
}> {
  const c = cfg(env);
  const store = await loadRank(env);
  const liveEngine = (await env.CACHE.get("auto:engine")) || "onto";
  const now = Date.now();

  const strategies: LabStrategyView[] = [];
  for (const st of LAB_STRATEGIES) {
    const state = await loadLabState(env, st.id);
    const positions = Object.values(state.positions).map((p) => {
      const px = p.lastPrice || p.avgPrice;
      return {
        ...p,
        pnl: Math.round((px - p.avgPrice) * p.qty),
        pnlPct: round(((px - p.avgPrice) / p.avgPrice) * 100, 2),
        holdDays: Math.max(0, Math.round((now - p.enteredAt) / 86400000)),
      };
    });
    const holdingsValue = positions.reduce((sum, p) => sum + p.qty * (p.lastPrice || p.avgPrice), 0);
    const equity = Math.round(state.cash + holdingsValue);
    const sells = state.trades.filter((t) => t.side === "SELL");
    const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
    let peak = c.capital, dd = 0;
    for (const pt of state.equityCurve ?? []) {
      if (pt.e > peak) peak = pt.e;
      dd = Math.max(dd, ((peak - pt.e) / peak) * 100);
    }
    strategies.push({
      id: st.id, no: st.no, nameKo: st.nameKo, tagKo: st.tagKo, descKo: st.descKo,
      engineId: st.engineId,
      liveNow: st.engineId !== null && st.engineId === liveEngine,
      capital: c.capital,
      equity,
      cash: Math.round(state.cash),
      pnlKrw: equity - c.capital,
      pnlPct: c.capital ? round(((equity - c.capital) / c.capital) * 100, 2) : 0,
      maxDrawdownPct: round(dd, 2),
      positions,
      exits: sells.slice(-10).reverse(),
      equityCurve: state.equityCurve ?? [],
      tradeStats: { total: sells.length, wins, winRate: sells.length ? round((wins / sells.length) * 100, 1) : 0 },
      haltedPermanent: state.haltedPermanent,
      haltReason: state.haltReason,
      lastNote: state.lastNote,
      lastCycleAt: state.lastCycleAt,
      startedAt: state.startedAt,
    });
  }

  return {
    disclaimer:
      "전략실의 모든 수치는 가상 원금 400만원으로 돌리는 시뮬레이션(모의매매) 기록입니다. " +
      "1호가 실계좌 엔진으로 선택된 경우에도 이 카드의 숫자는 모의 원장 기준입니다. " +
      "특정 종목의 매수·매도를 권유하지 않으며, 투자 판단과 책임은 이용자 본인에게 있습니다.",
    universe: UNIVERSE.length,
    scanned: Object.keys(store.rows).length,
    scanUpdatedAt: store.updatedAt,
    liveEngine,
    strategies,
  };
}

/* ── 조회 ─────────────────────────────── */


export interface QuantStatus {
  enabled: boolean;
  mode: "paper";
  profile: { id: string; nameKo: string };
  rules: { buyScore: number; sellScore: number; stopPct: number; takePct: number; marketMaDays: number; maxPositions: number };
  capital: number;
  cash: number;
  holdingsValue: number;
  equity: number;
  pnlKrw: number;
  pnlPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positions: (QuantPosition & { pnl: number; pnlPct: number })[];
  trades: QuantTrade[];
  tradeStats: { total: number; wins: number; winRate: number; avgHoldDays: number };
  haltedPermanent: boolean;
  haltReason: string;
  lastCycleAt: number;
  lastNote: string;
  startedAt: number;
  universe: number;
  scanned: number;
  scanUpdatedAt: number;
  /** 일별 평가금액 — 수익률 곡선 */
  equityCurve: { d: string; e: number }[];
  /** 시작 이후 최대 낙폭(%) */
  maxDrawdownPct: number;
}

export async function quantStatus(env: Env): Promise<QuantStatus> {
  const c = cfg(env);
  const state = await loadQuantState(env);
  const store = await loadRank(env);

  const positions = Object.values(state.positions).map((p) => {
    const px = p.lastPrice || p.avgPrice;
    const pnl = Math.round((px - p.avgPrice) * p.qty);
    return { ...p, pnl, pnlPct: round(((px - p.avgPrice) / p.avgPrice) * 100, 2) };
  });
  const holdingsValue = Math.round(positions.reduce((s, p) => s + p.qty * (p.lastPrice || p.avgPrice), 0));
  const equity = Math.round(state.cash + holdingsValue);
  const unrealized = positions.reduce((s, p) => s + p.pnl, 0);

  const sells = state.trades.filter((t) => t.side === "SELL");
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;

  return {
    enabled: c.enabled,
    mode: "paper",
    profile: { id: c.profile.id, nameKo: c.profile.nameKo },
    rules: { buyScore: c.buyScore, sellScore: c.sellScore, stopPct: c.stopPct, takePct: c.takePct, marketMaDays: c.marketMaDays, maxPositions: c.maxPositions },
    capital: c.capital,
    cash: Math.round(state.cash),
    holdingsValue,
    equity,
    pnlKrw: equity - c.capital,
    pnlPct: c.capital ? round(((equity - c.capital) / c.capital) * 100, 2) : 0,
    realizedPnl: Math.round(state.realizedPnl),
    unrealizedPnl: Math.round(unrealized),
    positions,
    trades: state.trades.slice(-30).reverse(),
    tradeStats: {
      total: sells.length,
      wins,
      winRate: sells.length ? round((wins / sells.length) * 100, 1) : 0,
      avgHoldDays: 0,
    },
    haltedPermanent: state.haltedPermanent,
    haltReason: state.haltReason,
    lastCycleAt: state.lastCycleAt,
    lastNote: state.lastNote,
    startedAt: state.startedAt,
    universe: UNIVERSE.length,
    scanned: Object.keys(store.rows).length,
    scanUpdatedAt: store.updatedAt,
    equityCurve: state.equityCurve ?? [],
    maxDrawdownPct: (() => {
      let peak = c.capital, dd = 0;
      for (const pt of state.equityCurve ?? []) {
        if (pt.e > peak) peak = pt.e;
        dd = Math.max(dd, ((peak - pt.e) / peak) * 100);
      }
      return round(dd, 2);
    })(),
  };
}

/** 원장 초기화 — 규칙을 바꾼 뒤 성적을 처음부터 다시 쌓을 때 */
export async function resetQuant(env: Env): Promise<QuantState> {
  await env.CACHE.delete(STATE_KEY);
  const s = await loadQuantState(env);
  await saveQuantState(env, s);
  return s;
}

export const QUANT_PROFILE_LIST = QUANT_PROFILES.map((p) => ({ id: p.id, nameKo: p.nameKo }));
