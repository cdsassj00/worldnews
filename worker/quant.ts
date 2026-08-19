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
import { isKrxHoliday, isUsHoliday } from "./holidays";
import seedData from "../shared/radar-universe.json";
import usSeedData from "../shared/us-universe.json";
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

/** 미국 유니버스 — S&P 주요 104종목 (2026-08-17 사용자 지시 "다 해놓자"로 수급·차트·리그 확장) */
const UNIVERSE_US: Seed[] = usSeedData as Seed[];

/** 스캔은 한국+미국을 한 바퀴로 돈다 — 점수 함수는 시장과 무관하게 동일하다 */
const SCAN_UNIVERSE: Seed[] = [...UNIVERSE, ...UNIVERSE_US];

export type QuantMarket = "KR" | "US";
/** 저장된 행의 시장 — 미국 확장 전에 저장된 행에는 market 이 없다(=한국) */
const rowMarket = (r: { market?: string }): QuantMarket => (r.market === "US" ? "US" : "KR");
/** 거래대금 하한 — 한국은 원, 미국은 달러 단위라 문턱이 다르다 */
const turnoverOk = (r: { market?: string; turnover: number }, minKrw: number) =>
  rowMarket(r) === "US" ? r.turnover >= 3_000_000 : r.turnover >= minKrw;

/** 한 크론에서 훑는 종목 수 — 자동매매·레이더와 예산(50)을 나눠 쓴다.
 * 2026-08-19 미국 유니버스 104→155 확장에 맞춰 12→16 (한 바퀴 275종목 ≈ 17크론 ≈ 4.3시간) */
const CHUNK = 16;

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
  /** "KR" | "US" — 미국 확장 전 행에는 없다(한국으로 취급) */
  market?: QuantMarket;
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
  /** 이 원장의 시작 원금 — 생성 시점의 설정값을 고정해 둔다.
   * env 만 믿으면 나중에 원금 설정을 바꿨을 때 기존 원장의 수익률이 왜곡된다
   * (원금 600만으로 바꾸는 순간 400만짜리 원장이 -33%로 보인다). */
  capital?: number;
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

/** 미국 실계좌 사이클(autotrade-us.ts)용 — 미국 수급 행(시세·거래대금·스캔시각) 전부 */
export async function usQuantRows(env: Env): Promise<QuantRow[]> {
  const store = await loadRank(env);
  return Object.values(store.rows).filter((r) => rowMarket(r) === "US");
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
  /* 스캔 순서: 한 번도 안 훑은 종목 → 가장 오래된 순. 순환 커서는 유니버스가
   * 커질 때(미국 104종목 추가) 새 종목이 하루 뒤에나 채워지는 문제가 있었다. */
  const slice: Seed[] = [...SCAN_UNIVERSE]
    .sort((a, b) => (store.rows[a.code]?.scannedAt ?? 0) - (store.rows[b.code]?.scannedAt ?? 0))
    .slice(0, CHUNK);

  // 시장 지수 — 상대강도 계산용. 이 조각에 미국 종목이 있으면 S&P500 도 받는다.
  let marketCloses: number[] = [];
  let usMarketCloses: number[] = [];
  const needUs = slice.some((s) => s.market === "US");
  try {
    const symbols = needUs ? ["^KS11", "^GSPC"] : ["^KS11"];
    const got = await getSparkMany(env, symbols, "6mo");
    for (const g of got) {
      if (g.symbol.toUpperCase() === "^KS11") marketCloses = g.closes;
      if (g.symbol.toUpperCase() === "^GSPC") usMarketCloses = g.closes;
    }
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
      const sig = quantSignal({ hist, market: seed.market === "US" ? usMarketCloses : marketCloses }, QUANT_PROFILES[0]);
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
        market: seed.market === "US" ? "US" : "KR",
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

  store.cursor = (store.cursor + slice.length) % SCAN_UNIVERSE.length; // 커서는 진단용 카운터로만 남긴다
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

export async function quantRank(env: Env, profileId?: string, limit = 20, market: QuantMarket = "KR"): Promise<QuantRankResult> {
  const c = cfg(env);
  const profile = profileId ? profileById(profileId) : c.profile;
  let store = await loadRank(env);
  /* 이 시장의 풀이 얕으면(방금 유니버스가 확장된 직후) 크론을 기다리지 않고
   * 즉석에서 한 조각을 채운다. 잠금(55초)으로 공개 엔드포인트 남용을 막는다. */
  if (Object.values(store.rows).filter((r) => rowMarket(r) === market).length < 40) {
    const lock = await env.CACHE.get("quant:scanlock").catch(() => null);
    if (!lock) {
      await env.CACHE.put("quant:scanlock", "1", { expirationTtl: 55 }).catch(() => undefined);
      await quantScanChunk(env).catch(() => undefined); // 안 훑은 종목부터라 이 시장이 먼저 채워진다
      store = await loadRank(env);
    }
  }
  const rows = Object.values(store.rows)
    .filter((r) => rowMarket(r) === market && turnoverOk(r, c.minTurnover))
    .map((r) => ({ ...r, score: r.scores[profile.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return {
    profile: { id: profile.id, nameKo: profile.nameKo },
    universe: market === "US" ? UNIVERSE_US.length : UNIVERSE.length,
    scanned: Object.values(store.rows).filter((r) => rowMarket(r) === market).length,
    updatedAt: store.updatedAt,
    rows: rows.slice(0, limit),
  };
}

/* ── 모의매매 ─────────────────────────────── */

/** 시장 지수가 이동평균 위인가 — 신규 매수 게이트 (KR=코스피, US=S&P500) */
async function marketOk(env: Env, c: QuantConfig, market: QuantMarket = "KR"): Promise<{ ok: boolean; note: string }> {
  if (!c.marketMaDays) return { ok: true, note: "시장 필터 꺼짐" };
  const sym = market === "US" ? "^GSPC" : "^KS11";
  const label = market === "US" ? "S&P500" : "코스피";
  try {
    const [ks] = await getSparkMany(env, [sym], "6mo");
    if (!ks || ks.closes.length < c.marketMaDays + 1) return { ok: true, note: "지수 데이터 부족 — 필터 통과" };
    const ma = sma(ks.closes, c.marketMaDays);
    const last = ks.closes.at(-1)!;
    return {
      ok: last >= ma,
      note: `${label} ${Math.round(last)} vs ${c.marketMaDays}일선 ${Math.round(ma)} — ${last >= ma ? "위(매수 허용)" : "아래(신규 매수 정지)"}`,
    };
  } catch {
    return { ok: true, note: "지수 조회 실패 — 필터 통과" };
  }
}

/** 미국 정규장(현지 09:30~16:00, 주말·휴장일 제외)인가 — DST 는 타임존 API가 처리한다 */
export function usMarketOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  if (isUsHoliday(`${get("year")}-${get("month")}-${get("day")}`)) return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
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

/* v2 — 2026-08-16 가상 원금을 400만 → 600만(실계좌와 동일)으로 통일하며 리그 재시작.
 * 예전 퀀트 트랙(400만 기준, 11일)의 기록은 잇지 않는다 — 원금 스케일이 다른 원장을
 * 한 표에 섞으면 수익률 비교가 성립하지 않는다.
 * v3 — 2026-08-17 개장시간 가드를 넣으며 한 번 더 재시작. v2 는 주말 크론에서
 * 금요일 종가(멈춘 시세)로 2호만 매수가 나가, "같은 조건으로 겨룬다"는 전제가
 * 깨졌다. 네 원장 모두 8/18(화) 09:00 같은 출발선에서 시작한다. */
/** 미국 리그 가상 원금(달러) — 실계좌의 미국 배분(약 400만원 ≈ $2,900)과 같은 규모감 */
const US_LAB_CAPITAL = 3_000;

function labStateKey(id: LabId, market: QuantMarket = "KR"): string {
  return market === "US" ? `lab:state:us1:${id}` : `lab:state:v3:${id}`;
}

async function loadLabState(env: Env, id: LabId, market: QuantMarket = "KR"): Promise<QuantState> {
  const raw = await env.CACHE.get(labStateKey(id, market), "json");
  if (raw && typeof raw === "object") return raw as QuantState;
  const capital = market === "US" ? US_LAB_CAPITAL : cfg(env).capital;
  return {
    capital,
    cash: capital, positions: {}, realizedPnl: 0, trades: [], day: "", buysToday: 0,
    peakEquity: capital, haltedPermanent: false, haltReason: "", startedAt: Date.now(),
    lastCycleAt: 0, lastNote: "",
  };
}

async function saveLabState(env: Env, id: LabId, s: QuantState, market: QuantMarket = "KR"): Promise<void> {
  s.trades = s.trades.slice(-200);
  if (s.equityCurve) s.equityCurve = s.equityCurve.slice(-400);
  await env.CACHE.put(labStateKey(id, market), JSON.stringify(s));
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
        .filter((r) => r.scannedAt >= fresh && turnoverOk(r, c.minTurnover))
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

  /* 개장시간 가드 — 시세가 멈춘 시간(밤·주말·공휴일)에 장부를 돌리면
   * 금요일 종가로 사는 왜곡이 생긴다(v2 리그에서 실측). 각 리그는 자기 정규장에만 돈다. */
  const k = new Date(Date.now() + 9 * 3600_000);
  const wd = k.getUTCDay();
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const krOpen = wd >= 1 && wd <= 5 && !isKrxHoliday(kstDay()) && mins >= 9 * 60 && mins <= 15 * 60 + 20;
  const usOpen = usMarketOpen();
  if (!krOpen && !usOpen) return { ran: false, results: {} };

  const results: Record<string, QuantCycleResult> = {};
  if (krOpen) Object.assign(results, await runLeague(env, c, "KR"));
  if (usOpen) {
    /* 미국 원장 설정 — 규칙(문턱·손절·익절·%한도)은 한국과 동일, 금액 단위만 달러 */
    const cUS: QuantConfig = { ...c, capital: US_LAB_CAPITAL, maxOrderKrw: 900, minOrderKrw: 120, minPool: 50 };
    const usResults = await runLeague(env, cUS, "US");
    for (const [id, r] of Object.entries(usResults)) results[`us:${id}`] = r;
  }
  return { ran: true, results };
}

/** 한 시장의 4개 원장을 한 사이클 진행한다 — 공유 데이터는 시장별로 한 번만 받는다 */
async function runLeague(env: Env, c: QuantConfig, market: QuantMarket): Promise<Record<string, QuantCycleResult>> {
  const today = kstDay();
  const now = Date.now();
  const store = await loadRank(env);
  const byCode: Record<string, QuantRow> = {};
  for (const r of Object.values(store.rows)) if (rowMarket(r) === market) byCode[r.code] = r;

  // 온톨로지 점수 — 레이더 DB에서 한 번에.
  // 레이더의 market 값은 "KOSPI"/"KOSDAQ"/"US" 다 — "KR" 로 필터하면 0건이 나온다(실측).
  const ontoByCode = new Map<string, number>();
  try {
    const { radarTop } = await import("./radarscan");
    const top = await radarTop(env, 500, "desc") as { items?: { code: string; score: number; market: string }[] };
    for (const it of top.items ?? []) {
      if ((market === "US") === (it.market === "US")) ontoByCode.set(it.code, it.score);
    }
  } catch { /* onto·fusion 원장만 이번 사이클을 쉰다 */ }

  const gate = await marketOk(env, c, market);

  // 네 원장 상태를 모두 읽고, 보유 종목 현재가를 **한 번에** 받는다
  const states = new Map<LabId, QuantState>();
  for (const st of LAB_STRATEGIES) states.set(st.id, await loadLabState(env, st.id, market));
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
      gate, strat.nameKo, now, today,
    );
    await saveLabState(env, strat.id, state, market);
  }
  return results;
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
  /** 지금 이 전략의 점수 상위 종목 — "이 전략이 지금 고른 종목" 쇼케이스 */
  picks: { code: string; name: string; sector: string; score: number; price: number; changePct: number; reasons: string[] }[];
  equityCurve: { d: string; e: number }[];
  tradeStats: { total: number; wins: number; winRate: number };
  haltedPermanent: boolean;
  haltReason: string;
  lastNote: string;
  lastCycleAt: number;
  startedAt: number;
}

export async function labOverview(env: Env, market: QuantMarket = "KR"): Promise<{
  disclaimer: string;
  universe: number;
  scanned: number;
  scanUpdatedAt: number;
  liveEngine: string;
  market: QuantMarket;
  /** 표기 통화 — 한국 리그 KRW, 미국 리그 USD */
  currency: "KRW" | "USD";
  strategies: LabStrategyView[];
}> {
  const c = cfg(env);
  const store = await loadRank(env);
  const liveEngine = (await env.CACHE.get("auto:engine")) || "onto";
  const now = Date.now();

  // 전략별 현재 추천 종목 — 사이클과 같은 점수 함수를 써서 화면과 매매가 어긋나지 않게 한다
  const ontoByCode = new Map<string, number>();
  // 온톨로지 근거 문장 — 데일리 브리프의 "왜 이 종목인가"에 쓴다
  const ontoReasons = new Map<string, string[]>();
  try {
    const { radarTop } = await import("./radarscan");
    const top = (await radarTop(env, 500, "desc")) as {
      items?: { code: string; score: number; market: string; reasons?: { text: string }[] }[];
    };
    for (const it of top.items ?? []) {
      if ((market === "US") === (it.market === "US")) {
        ontoByCode.set(it.code, it.score);
        ontoReasons.set(it.code, (it.reasons ?? []).slice(0, 2).map((x) => x.text));
      }
    }
  } catch { /* 추천만 빈다 */ }
  const rowsAll = Object.values(store.rows).filter((r) => rowMarket(r) === market && turnoverOk(r, c.minTurnover));
  /** 엔진별 근거 — 각 전략이 "무엇을 보고" 이 종목을 골랐는지 실제 계산 값으로 설명한다 */
  const reasonsFor = (id: LabId, r: QuantRow): string[] => {
    const quantR = (r.reasons ?? []).slice(0, 2).map((x) => x.text);
    const ontoR = ontoReasons.get(r.code) ?? [];
    switch (id) {
      case "onto": return ontoR.length ? ontoR : ["온톨로지 레이더 점수 상위 (경로 상세는 스캔 후 제공)"];
      case "quant": return quantR;
      case "ta": return [`차트 거장 13종 전략 합의 점수 ${r.taScore !== undefined ? (r.taScore >= 0 ? "+" : "") + r.taScore.toFixed(2) : "측정 전"} (이평·MACD·일목·터틀 등)`];
      case "fusion": {
        const o = ontoByCode.get(r.code), q = r.scores["breakout"];
        return [
          ...(o !== undefined && q !== undefined ? [`온톨로지 ${o >= 0 ? "+" : ""}${o.toFixed(2)} 와 수급 ${q >= 0 ? "+" : ""}${q.toFixed(2)} 가 모두 긍정 — 반반 평균`] : []),
          ...(ontoR.slice(0, 1)), ...(quantR.slice(0, 1)),
        ];
      }
    }
  };
  const picksFor = (id: LabId) =>
    rowsAll
      .map((r) => ({ r, score: labScore(id, r, ontoByCode) }))
      .filter((x): x is { r: QuantRow; score: number } => x.score !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ r, score }) => ({
        code: r.code, name: r.name, sector: r.sector, score: round(score, 3), price: r.price, changePct: r.changePct,
        reasons: reasonsFor(id, r),
      }));

  const strategies: LabStrategyView[] = [];
  for (const st of LAB_STRATEGIES) {
    const state = await loadLabState(env, st.id, market);
    const capital = state.capital ?? (market === "US" ? US_LAB_CAPITAL : c.capital);
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
    let peak = capital, dd = 0;
    for (const pt of state.equityCurve ?? []) {
      if (pt.e > peak) peak = pt.e;
      dd = Math.max(dd, ((peak - pt.e) / peak) * 100);
    }
    strategies.push({
      id: st.id, no: st.no, nameKo: st.nameKo, tagKo: st.tagKo, descKo: st.descKo,
      engineId: st.engineId,
      // 실계좌 배지는 한국 리그에만 — 미국은 아직 페이퍼 검증 단계다
      liveNow: market === "KR" && st.engineId !== null && st.engineId === liveEngine,
      capital,
      equity,
      cash: Math.round(state.cash),
      pnlKrw: equity - capital,
      pnlPct: capital ? round(((equity - capital) / capital) * 100, 2) : 0,
      maxDrawdownPct: round(dd, 2),
      positions,
      exits: sells.slice(-10).reverse(),
      picks: picksFor(st.id),
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
      "전략실의 수익률은 계좌 수익률이 아니라, 4개 전략을 같은 가상 원금·같은 규칙으로 돌리는 백테스트·시뮬레이션(모의매매) 기록입니다. " +
      "'실계좌 운용 중' 배지는 그 전략이 현재 운영자 계좌의 매매 엔진이라는 표시일 뿐, 금액은 공개하지 않습니다. " +
      "특정 종목의 매수·매도를 권유하지 않으며, 투자 판단과 책임은 이용자 본인에게 있습니다.",
    universe: market === "US" ? UNIVERSE_US.length : UNIVERSE.length,
    scanned: Object.values(store.rows).filter((r) => rowMarket(r) === market).length,
    scanUpdatedAt: store.updatedAt,
    liveEngine,
    market,
    currency: market === "US" ? "USD" : "KRW",
    strategies,
  };
}

/* ── 조합 순위 — "세 분석을 이 비율로 섞으면 지금 어떤 종목이 유리한가" ────
 * 공개 추천 화면(분석 터미널 · 조합 전략 탭)용. 실계좌와 무관한 조회 전용이며,
 * 점수 축은 실계좌 엔진(applyEngine)과 동일하다: 온톨로지=레이더 온톨로지 점수,
 * 수급=돌파 프로파일, 차트=거장 13종 합의. 보여주는 숫자 = 매매하는 숫자. */

export interface ComboWeights { onto: number; flow: number; chart: number }

export interface ComboRow {
  code: string; symbol: string; name: string; sector: string;
  price: number; changePct: number;
  onto: number | null; flow: number | null; chart: number | null;
  total: number;
}

export async function comboRank(env: Env, wRaw: Partial<ComboWeights>, limit = 20, market: QuantMarket = "KR"): Promise<{
  weights: ComboWeights;
  universe: number; scanned: number; updatedAt: number;
  rows: ComboRow[];
}> {
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const w: ComboWeights = { onto: clamp(wRaw.onto), flow: clamp(wRaw.flow), chart: clamp(wRaw.chart) };
  if (w.onto + w.flow + w.chart <= 0) { w.onto = 34; w.flow = 33; w.chart = 33; }

  const c = cfg(env);
  const store = await loadRank(env);
  const ontoByCode = new Map<string, number>();
  try {
    const { radarTop } = await import("./radarscan");
    const top = await radarTop(env, 500, "desc") as { items?: { code: string; score: number; market: string }[] };
    for (const it of top.items ?? []) {
      if ((market === "US") === (it.market === "US")) ontoByCode.set(it.code, it.score);
    }
  } catch { /* 온톨로지 축만 빈다 */ }

  const totalW = w.onto + w.flow + w.chart;
  const rows: ComboRow[] = [];
  for (const r of Object.values(store.rows)) {
    if (rowMarket(r) !== market || !turnoverOk(r, c.minTurnover)) continue;
    const onto = ontoByCode.get(r.code);
    const flow = r.scores["breakout"];
    const chart = r.taScore;
    // 점수 없는 축은 빼고 남은 가중치로 재정규화 — 정보 없음 ≠ 나쁨
    const comps: { wgt: number; val: number }[] = [];
    if (onto !== undefined) comps.push({ wgt: w.onto, val: onto });
    if (flow !== undefined) comps.push({ wgt: w.flow, val: flow });
    if (chart !== undefined) comps.push({ wgt: w.chart, val: chart });
    const denom = comps.reduce((a, x) => a + x.wgt, 0);
    if (denom < totalW / 2) continue; // 조합의 절반 이상이 깜깜이면 순위에 안 올린다
    rows.push({
      code: r.code, symbol: r.symbol, name: r.name, sector: r.sector,
      price: r.price, changePct: r.changePct,
      onto: onto !== undefined ? round(onto, 3) : null,
      flow: flow !== undefined ? round(flow, 3) : null,
      chart: chart !== undefined ? round(chart, 3) : null,
      total: round(comps.reduce((a, x) => a + x.wgt * x.val, 0) / denom, 3),
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    weights: w,
    universe: market === "US" ? UNIVERSE_US.length : UNIVERSE.length,
    scanned: Object.values(store.rows).filter((r) => rowMarket(r) === market).length,
    updatedAt: store.updatedAt,
    rows: rows.slice(0, Math.min(50, Math.max(1, limit))),
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
