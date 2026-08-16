/**
 * 퀀트 트랙 백테스트 — **수급과 차트만으로** 매매했을 때 어떻게 되는가.
 *
 * 온톨로지 트랙(scripts/backtest.ts)과 별개의 실험이다. 비교를 공정하게 하려고
 * 같은 유니버스·같은 체결 규칙 위에서 **점수 엔진만 갈아 끼운다.**
 *
 *   engine = chart(차트 중심) | flow(수급 중심) | blend(수급+차트) | onto(온톨로지 — 대조군)
 *
 * 재현 규칙 (온톨로지 백테스트와 동일)
 *  - 그날 종가로 점수 → **다음 거래일 시가** 체결. 슬리피지 ±0.3%, 왕복 비용 0.23%.
 *  - 손절·익절은 장중 저가·고가로 판정한다.
 *  - 워밍업 60거래일은 평가 구간에서 제외한다(BT_EVAL 은 "매매한 기간"을 뜻한다).
 *
 * 한계
 *  - **실제 수급(외국인·기관 순매수)은 과거 재현이 불가능하다.** 여기서 "수급"은
 *    거래대금·자금흐름지수(MFI)·매집강도(CLV) 같은 **가격·거래량 기반 프록시**다.
 *    실전에서 KIS 투자자별 매매동향을 얹으면 백테스트보다 정보가 하나 더 붙는 셈인데,
 *    그 축은 검증된 적이 없으므로 기본 가중치 0 으로 둔다.
 *  - 유니버스는 지금 살아 있는 종목이라 생존편향이 있다.
 *  - 일평균 거래대금 5억원 미만은 후보에서 제외한다(소액이라도 체결·슬리피지가 현실적이도록).
 *
 * 실행:
 *   npx esbuild scripts/quant-backtest.ts --bundle --platform=node --format=esm --outfile=/tmp/qbt.mjs
 *   BT_EVAL=3mo node /tmp/qbt.mjs
 */
import { readFileSync } from "node:fs";
import { MACRO, SENSITIVITY, US_SENSITIVITY, roundToTick, type MacroFactor, type MacroId, type SectorId, type UniverseTicker } from "../shared/ontology";
import { composite, macroSignal, priceSignal, propagate, type MacroSignal, type PriceHistory } from "../shared/scoring";
import { QUANT_PROFILES, profileById, quantSignal, scoreFromParts, type QuantParts } from "../shared/quant";
import { consensus, runStrategies } from "../shared/ta";
import { loadAll, dateKey, makeIdxAsOf, type Bars } from "./bars";

/* ── 설정 (운영값과 맞춘다) ─────────────────────────── */

/** 시장 — KR(코스피200+) | US(S&P100) */
const MARKET = (process.env.BT_MARKET || "KR").toUpperCase() as "KR" | "US";
const IS_US = MARKET === "US";
const INDEX_SYMBOL = IS_US ? "^GSPC" : "^KS11";
const UNIVERSE_FILE = IS_US ? "shared/us-universe.json" : "shared/radar-universe.json";
const INDEX_KO = IS_US ? "S&P500" : "코스피";

/* 미국은 달러로 계산한다(환율을 섞으면 전략 성과와 환차익이 뒤엉킨다).
 * 400만원 ≈ 3,000달러로 두어 종목당 한도·최소 주문의 비율이 국내와 같아지게 맞춘다. */
const CAPITAL = IS_US ? 3_000 : 4_000_000;
const MAX_POSITION_PCT = 30;
const MAX_ORDER_KRW = IS_US ? 900 : 1_200_000;
const MIN_ORDER_KRW = IS_US ? 110 : 150_000;
const MAX_ORDERS_PER_CYCLE = 3;
const MAX_DRAWDOWN_PCT = 20;
const DAILY_LOSS_HALT_PCT = 5;
/* 거래비용 — 시장마다 다르다. 여기를 잘못 잡으면 단타 전략의 결론이 통째로 뒤집힌다.
 *  국내: 슬리피지 0.3%/편도 + 왕복 0.23%(증권거래세 0.18 + 수수료)
 *  미국: 대형주라 슬리피지는 낮지만(0.15%/편도) 한투 해외주식 수수료가 편도 0.25% 라
 *        왕복 0.5% + SEC/TAF 수수료 소액 → 0.52% 로 잡는다. 세금은 매도 시 없음(양도세는 연말 정산). */
const SLIPPAGE = Number(process.env.BT_SLIPPAGE ?? (IS_US ? 0.0015 : 0.003));
/** 진단용 — 영구 정지(고점대비 -20%)를 끄고 규칙 자체의 성과를 본다. 운영에서는 절대 끄지 않는다. */
const NO_HALT = process.env.BT_NOHALT === "1";
const ROUND_TRIP_COST = Number(process.env.BT_COST ?? (IS_US ? 0.0052 : 0.0023));
/** 일평균 거래대금 하한(원) — 이보다 얇으면 후보에서 뺀다 */
const MIN_TURNOVER = Number(process.env.BT_MIN_TURNOVER ?? (IS_US ? 20_000_000 : 500_000_000));

const RANGE = process.env.BT_RANGE || "2y";
const EVAL = process.env.BT_EVAL || "6mo";
/** 유니버스 상한 — 야후 호출을 줄여 빨리 돌려 볼 때 쓴다 */
const UNI_LIMIT = Number(process.env.BT_UNIVERSE || 350);

function evalStartDate(lastDate: string): string {
  const m = /^(\d+)(mo|y|d)$/.exec(EVAL);
  if (!m) return "0000-00-00";
  const n = Number(m[1]);
  const d = new Date(lastDate + "T00:00:00Z");
  if (m[2] === "mo") d.setUTCMonth(d.getUTCMonth() - n);
  else if (m[2] === "y") d.setUTCFullYear(d.getUTCFullYear() - n);
  else d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/* ── 시나리오 ─────────────────────────────── */

export interface QScenario {
  name: string;
  engine: string; // chart | flow | blend | onto
  /** 매수 문턱 */
  buyScore: number;
  /** 신호 이탈 매도 문턱 (점수가 이 밑이면 판다). null 이면 끔 */
  sellScore: number | null;
  stopPct: number;
  /** 0 이면 익절 없음 */
  takePct: number;
  /** 0 이면 추적손절 없음 (진입가 위로 올라간 뒤에만 작동) */
  trailPct: number;
  /** 0 이면 시간 청산 없음 — N 거래일 지나도 수익이 안 나면 자리 비운다 */
  timeStopDays: number;
  /** 교체 매매 문턱 (0 이면 끔) */
  rotateGap: number;
  maxPositions: number;
  /**
   * 시장 국면 필터 — 코스피가 N일 이동평균 아래면 **신규 매수를 아예 하지 않는다**.
   * 추세추종은 방향 없는 시장에서 손절만 반복하며 비용으로 죽는다. 0 이면 끔.
   */
  marketMaDays?: number;
}

const BASE: Omit<QScenario, "name" | "engine"> = {
  buyScore: 0.2, sellScore: -0.05, stopPct: 5, takePct: 8, trailPct: 0, timeStopDays: 10, rotateGap: 0.15, maxPositions: 5,
};

const SCENARIOS: QScenario[] = [
  /* ① 엔진 비교 — 청산 규칙을 고정하고 점수 엔진만 바꾼다 */
  { name: "Q1 차트중심",              engine: "chart", ...BASE },
  { name: "Q2 수급중심",              engine: "flow",  ...BASE },
  { name: "Q3 수급+차트",             engine: "blend", ...BASE },
  { name: "Q0 온톨로지(대조군)",        engine: "onto",  ...BASE },
  /* ② 청산 규칙 비교 — 제일 나은 엔진 후보(blend)에서 규칙만 바꾼다 */
  { name: "Q4 blend·익절15",         engine: "blend", ...BASE, takePct: 15 },
  { name: "Q5 blend·추적손절 6%",     engine: "blend", ...BASE, takePct: 0, trailPct: 6 },
  { name: "Q6 blend·시간청산 없음",     engine: "blend", ...BASE, timeStopDays: 0 },
  { name: "Q7 blend·교체 없음",        engine: "blend", ...BASE, rotateGap: 0 },
  { name: "Q8 blend·손절 3%",         engine: "blend", ...BASE, stopPct: 3 },
  { name: "Q9 blend·손절 8%",         engine: "blend", ...BASE, stopPct: 8 },
  { name: "QA blend·문턱 0.35",       engine: "blend", ...BASE, buyScore: 0.35 },
  { name: "QB blend·3종목 집중",       engine: "blend", ...BASE, maxPositions: 3 },
  /* ③ 차트중심에도 같은 변주를 한 번 (엔진×규칙 상호작용 확인) */
  { name: "QC chart·문턱 0.35",       engine: "chart", ...BASE, buyScore: 0.35 },
  { name: "QD flow·문턱 0.35",        engine: "flow",  ...BASE, buyScore: 0.35 },
  /* ④ 시장 국면 필터 — 코스피가 20일선 아래면 신규 매수 정지 */
  { name: "QE blend·시장필터 20일",     engine: "blend", ...BASE, marketMaDays: 20 },
  { name: "QF chart·시장필터 20일",     engine: "chart", ...BASE, marketMaDays: 20 },
  { name: "QG flow·시장필터 20일",      engine: "flow",  ...BASE, marketMaDays: 20 },
  { name: "QH onto·시장필터 20일",      engine: "onto",  ...BASE, marketMaDays: 20 },
  /* ⑤ 회전율을 낮춘 판 — 왕복 비용 0.83%(슬리피지 0.6 + 세금·수수료 0.23)를 이기려면
   *    한 번의 기대이익이 그보다 충분히 커야 한다. 문턱↑·익절↑·시간청산/교체 끔. */
  { name: "QI blend·저회전+시장필터",    engine: "blend", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "QJ chart·저회전+시장필터",    engine: "chart", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "QK onto·저회전+시장필터",     engine: "onto",  ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  /* ⑥ 돌파·역추세 엔진 (밴드 상단을 감점하지 않는 판) */
  { name: "QL 돌파",                  engine: "breakout", ...BASE },
  { name: "QM 돌파·저회전+시장필터",     engine: "breakout", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "QN 역추세",                engine: "meanrev",  ...BASE },
  { name: "QO 역추세·저회전+시장필터",    engine: "meanrev",  ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "QP blend·저회전(필터없음)",   engine: "blend", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0 },
  /* ⑧ 차트 거장 13종 합의 — 전략실 3호. 같은 저회전+시장필터 규칙으로 다른 엔진과 공정 비교 */
  { name: "TA 차트합의",               engine: "ta", ...BASE },
  { name: "TB 차트합의·저회전+시장필터",  engine: "ta", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "TC 차트합의·문턱0.25+필터",   engine: "ta", ...BASE, buyScore: 0.25, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  /* ⑦ 하이브리드 — 온톨로지 + 수급·차트 반반 */
  { name: "QQ 하이브리드",             engine: "hybrid", ...BASE },
  { name: "QR 하이브리드·시장필터",      engine: "hybrid", ...BASE, marketMaDays: 20 },
  { name: "QS 하이브리드·저회전+필터",   engine: "hybrid", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "QT 하이브리드·저회전 문턱0.3", engine: "hybrid", ...BASE, buyScore: 0.30, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  /* ⑨ 나머지 2·3개 조합 — 세 분석(온톨로지·수급·차트)의 모든 짝을 채운다.
   *    다른 엔진과 공정 비교를 위해 같은 저회전+시장필터 규칙만 측정한다. */
  { name: "XA 온톨로지+차트·저회전+필터", engine: "onto_ta",  ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "XB 수급+차트·저회전+필터",    engine: "quant_ta", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
  { name: "XC 삼합(온톨+수급+차트)·저회전+필터", engine: "all3", ...BASE, buyScore: 0.35, takePct: 15, stopPct: 6, timeStopDays: 0, rotateGap: 0, marketMaDays: 20 },
];

/* ── 데이터 ─────────────────────────────── */

interface UniRow { code: string; symbol: string; name: string; market: string; sector: string }

interface Cand {
  code: string; symbol: string; name: string;
  score: number; price: number; atr: number; turnover: number;
}

interface Dataset {
  bars: Map<string, Bars>;
  calendar: string[];
  idxAsOf: (sym: string, date: string) => number;
  kospi: Bars;
  startIdx: number;
  /** 날짜 → 엔진 → 점수순 후보 */
  daily: Map<string, Map<string, Cand[]>>;
}

function sliceHistory(b: Bars, upto: number): PriceHistory {
  return {
    price: b.close[upto],
    closes: b.close.slice(0, upto + 1),
    highs: b.high.slice(0, upto + 1),
    lows: b.low.slice(0, upto + 1),
    volumes: b.volume.slice(0, upto + 1),
  };
}

async function buildDataset(): Promise<Dataset> {
  // 저장소 루트에서 실행하는 것을 전제로 한다 (번들 출력 위치와 무관하게 하려고 cwd 기준)
  const uni = (JSON.parse(readFileSync(UNIVERSE_FILE, "utf8")) as UniRow[]).slice(0, UNI_LIMIT);
  process.stderr.write(`데이터 수집 — 종목 ${uni.length} + 지수/거시 (${RANGE})…\n`);

  const bars = await loadAll(
    [...uni.map((u) => u.symbol), INDEX_SYMBOL, ...MACRO.map((m) => m.symbol)],
    RANGE,
    6,
    (done, total) => { if (done % 60 === 0 || done === total) process.stderr.write(`  ${done}/${total}\n`); },
  );

  const kospi = bars.get(INDEX_SYMBOL);
  if (!kospi) throw new Error(`${INDEX_KO} 지수를 받지 못했습니다.`);
  const calendar = kospi.t.map(dateKey);
  const idxAsOf = makeIdxAsOf([bars]);

  const evalFrom = evalStartDate(calendar.at(-1)!);
  const firstEval = calendar.findIndex((d) => d >= evalFrom);
  const startIdx = Math.max(60, firstEval < 0 ? 60 : firstEval);
  if (startIdx >= calendar.length - 2) throw new Error(`평가 구간이 너무 짧습니다 (BT_EVAL=${EVAL}, 수집=${RANGE}).`);

  process.stderr.write(`점수 계산 — ${calendar[startIdx]} ~ ${calendar.at(-1)} …\n`);
  // hybrid = 온톨로지(거시 인과) 와 퀀트(수급·차트) 를 반반 섞은 점수.
  // ta = 차트 거장 전략 13종(이평교차·MACD·일목·터틀 등)의 합의 점수 — 전략실 3호의 검증판.
  const engines = [...QUANT_PROFILES.map((p) => p.id), "onto", "hybrid", "ta", "onto_ta", "quant_ta", "all3"];
  const daily = new Map<string, Map<string, Cand[]>>();
  const have = uni.filter((u) => bars.has(u.symbol.toUpperCase()));

  for (let d = startIdx; d < calendar.length - 1; d++) {
    const today = calendar[d];
    const ki = idxAsOf(INDEX_SYMBOL, today);
    const marketCloses = ki >= 0 ? kospi.close.slice(0, ki + 1) : [];

    // 거시 신호 — 온톨로지 대조군에만 쓴다
    const macro: MacroSignal[] = [];
    for (const f of MACRO as MacroFactor[]) {
      const sym = f.symbol.toUpperCase();
      const i = idxAsOf(sym, today);
      const b = bars.get(sym);
      if (i < 6 || !b) continue;
      macro.push(macroSignal(f, sliceHistory(b, i)));
    }

    const byEngine = new Map<string, Cand[]>();
    for (const e of engines) byEngine.set(e, []);

    for (const u of have) {
      const sym = u.symbol.toUpperCase();
      const i = idxAsOf(sym, today);
      const b = bars.get(sym)!;
      if (i < 60) continue;
      const hist = sliceHistory(b, i);
      // 동전주 제외 — 통화가 다르니 하한도 시장별로 둔다(원화 1,000원 / 달러 3불).
      if (!hist.price || hist.price < (IS_US ? 3 : 1000)) continue;

      // 지표는 한 번만 계산하고 프로파일별로 점수만 다시 합성한다
      const q = quantSignal({ hist, market: marketCloses }, QUANT_PROFILES[0]);
      if (q.turnover < MIN_TURNOVER) continue;
      const parts: QuantParts = q.parts;
      const common = { code: u.code, symbol: sym, name: u.name, price: hist.price, atr: q.atr, turnover: q.turnover };

      for (const p of QUANT_PROFILES) {
        byEngine.get(p.id)!.push({ ...common, score: p.id === QUANT_PROFILES[0].id ? q.score : scoreFromParts(parts, p) });
      }

      // 차트 전략 13종 합의 — 형태 분석(사다리·플랜)은 빼고 전략 판정만 돌린다(속도).
      const taScore = consensus(runStrategies(hist)).score;
      byEngine.get("ta")!.push({ ...common, score: taScore });
      // 수급 축은 돌파 프로파일을 쓴다(퀀트 단독 비교에서 가장 나았던 판).
      const qs = scoreFromParts(parts, profileById("breakout"));
      // 수급+차트 — 거시 신호 없이도 계산 가능한 2개 조합
      byEngine.get("quant_ta")!.push({ ...common, score: (qs + taScore) / 2 });

      if (macro.length >= 4) {
        const fake: UniverseTicker = {
          code: u.code, symbol: sym, nameKo: u.name,
          sectors: { [u.sector as SectorId]: 1 } as Record<SectorId, number>,
        } as UniverseTicker;
        const onto = propagate(fake, macro, IS_US ? (US_SENSITIVITY as Record<string, Partial<Record<MacroId, number>>>) : SENSITIVITY);
        // 온톨로지 트랙과 같은 합성식 (뉴스 축 0)
        const ontoScore = composite(onto.score, priceSignal(hist).score, 0);
        byEngine.get("onto")!.push({ ...common, score: ontoScore });
        // 하이브리드 — 온톨로지 결론과 수급·차트 점수를 반반.
        byEngine.get("hybrid")!.push({ ...common, score: (ontoScore + qs) / 2 });
        // 온톨로지+차트 / 삼합 — 세 분석의 나머지 조합
        byEngine.get("onto_ta")!.push({ ...common, score: (ontoScore + taScore) / 2 });
        byEngine.get("all3")!.push({ ...common, score: (ontoScore + qs + taScore) / 3 });
      }
    }

    for (const list of byEngine.values()) list.sort((a, b) => b.score - a.score);
    daily.set(today, byEngine);
    if ((d - startIdx) % 40 === 0) process.stderr.write(`  ${today}\n`);
  }

  return { bars, calendar, idxAsOf, kospi, startIdx, daily };
}

/* ── 시뮬레이션 ─────────────────────────────── */

interface Position {
  code: string; name: string; symbol: string;
  qty: number; avgPrice: number; openedOn: string; openedIdx: number; peakPrice: number;
}

interface Trade { code: string; name: string; qty: number; buyDate: string; sellDate: string; pnl: number; pnlPct: number; reason: string; holdDays: number }

interface SimResult { scenario: QScenario; finalEquity: number; totalReturn: number; maxDd: number; trades: Trade[]; haltReason: string }

function simulate(ds: Dataset, cfg: QScenario): SimResult {
  const { bars, calendar, idxAsOf } = ds;
  let cash = CAPITAL;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const curve: number[] = [];
  let peak = CAPITAL;
  let halted = false;
  let haltReason = "";
  let haltedDay = "";
  const perPositionCap = (CAPITAL * MAX_POSITION_PCT) / 100;

  const close = (p: Position, date: string, price: number, reason: string) => {
    const gross = p.qty * price;
    const proceeds = gross - gross * ROUND_TRIP_COST;
    cash += proceeds;
    const invested = p.qty * p.avgPrice;
    trades.push({
      code: p.code, name: p.name, qty: p.qty, buyDate: p.openedOn, sellDate: date,
      pnl: Math.round(proceeds - invested), pnlPct: ((proceeds - invested) / invested) * 100, reason,
      holdDays: Math.round((Date.parse(date) - Date.parse(p.openedOn)) / 86400000),
    });
    positions.delete(p.code);
  };

  for (let d = ds.startIdx; d < calendar.length - 1; d++) {
    const today = calendar[d];
    const tomorrow = calendar[d + 1];
    const ranked = ds.daily.get(today)?.get(cfg.engine) ?? [];

    let holdings = 0;
    for (const p of positions.values()) {
      const i = idxAsOf(p.symbol, today);
      const b = bars.get(p.symbol);
      holdings += p.qty * (i >= 0 && b ? b.close[i] : p.avgPrice);
    }
    const equity = cash + holdings;
    const prev = curve.at(-1) ?? CAPITAL;
    curve.push(equity);
    if (equity > peak) peak = equity;
    if (!NO_HALT && !halted && ((peak - equity) / peak) * 100 >= MAX_DRAWDOWN_PCT) {
      halted = true;
      haltReason = `${today} 고점대비 -${(((peak - equity) / peak) * 100).toFixed(1)}%`;
    }
    if (((prev - equity) / prev) * 100 >= DAILY_LOSS_HALT_PCT) haltedDay = today;

    /* 1) 장중 손절·익절·추적손절 */
    for (const p of [...positions.values()]) {
      const i = idxAsOf(p.symbol, today);
      const b = bars.get(p.symbol);
      if (i < 0 || !b) continue;
      if (b.high[i] > p.peakPrice) p.peakPrice = b.high[i];
      const stop = p.avgPrice * (1 - cfg.stopPct / 100);
      let exit = 0, why = "";
      if (b.low[i] <= stop) { exit = stop; why = `손절 -${cfg.stopPct}%`; }
      else if (cfg.takePct && b.high[i] >= p.avgPrice * (1 + cfg.takePct / 100)) { exit = p.avgPrice * (1 + cfg.takePct / 100); why = `익절 +${cfg.takePct}%`; }
      else if (cfg.trailPct && p.peakPrice > p.avgPrice) {
        const t = p.peakPrice * (1 - cfg.trailPct / 100);
        if (b.low[i] <= t && t > stop) { exit = t; why = `추적손절 -${cfg.trailPct}%`; }
      }
      if (exit) close(p, today, exit, why);
    }

    if (halted) continue;

    const scoreByCode = new Map(ranked.map((r) => [r.code, r.score]));
    const sellAt = (p: Position, why: string) => {
      const oi = idxAsOf(p.symbol, tomorrow);
      const b = bars.get(p.symbol);
      if (oi < 0 || !b) return;
      close(p, tomorrow, b.open[oi] * (1 - SLIPPAGE), why);
    };

    /* 2) 신호 이탈 매도 */
    if (cfg.sellScore !== null) {
      for (const p of [...positions.values()]) {
        const sc = scoreByCode.get(p.code);
        if (sc !== undefined && sc <= cfg.sellScore) sellAt(p, `신호 이탈 (${sc.toFixed(2)})`);
      }
    }

    /* 3) 시간 청산 — 단타 규칙. N거래일을 넘겼는데 수익이 없으면 자리를 비운다.
     *    자금이 지지부진한 종목에 묶여 다음 신호를 못 사는 것을 막는 장치다. */
    if (cfg.timeStopDays) {
      for (const p of [...positions.values()]) {
        if (d - p.openedIdx < cfg.timeStopDays) continue;
        const i = idxAsOf(p.symbol, today);
        const b = bars.get(p.symbol);
        if (i < 0 || !b) continue;
        if (b.close[i] <= p.avgPrice * 1.005) sellAt(p, `시간 청산 ${cfg.timeStopDays}일`);
      }
    }

    /* 4) 교체 매매 — 자리가 찼을 때만 */
    if (cfg.rotateGap && positions.size >= cfg.maxPositions) {
      const held = [...positions.values()].map((p) => ({ p, s: scoreByCode.get(p.code) ?? -1 })).sort((a, b) => a.s - b.s);
      const best = ranked.find((r) => !positions.has(r.code) && r.score >= cfg.buyScore);
      if (held[0] && best && best.score - held[0].s >= cfg.rotateGap) {
        sellAt(held[0].p, `교체 매도 (${held[0].s.toFixed(2)} → ${best.name} ${best.score.toFixed(2)})`);
      }
    }

    /* 5) 매수 */
    if (haltedDay === today) continue;
    if (cfg.marketMaDays) {
      const mi = idxAsOf(INDEX_SYMBOL, today);
      if (mi >= cfg.marketMaDays) {
        const win = ds.kospi.close.slice(mi - cfg.marketMaDays + 1, mi + 1);
        const ma = win.reduce((a, b) => a + b, 0) / win.length;
        if (ds.kospi.close[mi] < ma) continue; // 시장이 이평 아래 = 신규 매수 금지
      }
    }
    let buys = 0;
    for (const r of ranked) {
      if (buys >= MAX_ORDERS_PER_CYCLE) break;
      if (r.score < cfg.buyScore) break;
      const existing = positions.get(r.code);
      if (!existing && positions.size >= cfg.maxPositions) continue;
      const oi = idxAsOf(r.symbol, tomorrow);
      const b = bars.get(r.symbol);
      if (oi < 0 || !b) continue;
      const raw = b.open[oi] * (1 + SLIPPAGE);
      const fill = IS_US ? Math.round(raw * 100) / 100 : roundToTick(raw, "up");
      const currentValue = existing ? existing.qty * r.price : 0;
      const room = Math.min(perPositionCap - currentValue, MAX_ORDER_KRW, cash);
      // 점수가 높을수록 크게 — 운영(autotrade.ts)과 같은 형태
      const sized = room * Math.min(1, 0.7 + r.score * 1.5);
      if (sized < MIN_ORDER_KRW) continue;
      const qty = Math.floor(sized / fill);
      if (qty < 1) continue;
      const cost = qty * fill;
      if (cost > cash) continue;
      cash -= cost;
      if (existing) {
        const total = existing.qty + qty;
        existing.avgPrice = (existing.avgPrice * existing.qty + fill * qty) / total;
        existing.qty = total;
      } else {
        positions.set(r.code, { code: r.code, name: r.name, symbol: r.symbol, qty, avgPrice: fill, openedOn: tomorrow, openedIdx: d + 1, peakPrice: fill });
      }
      buys++;
    }
  }

  const last = calendar.at(-1)!;
  for (const p of [...positions.values()]) {
    const i = idxAsOf(p.symbol, last);
    const b = bars.get(p.symbol);
    if (i >= 0 && b) close(p, last, b.close[i] * (1 - SLIPPAGE), "기간 종료 청산");
  }

  let maxDd = 0, runPeak = CAPITAL;
  for (const e of curve) {
    if (e > runPeak) runPeak = e;
    maxDd = Math.max(maxDd, ((runPeak - e) / runPeak) * 100);
  }

  return { scenario: cfg, finalEquity: cash, totalReturn: ((cash - CAPITAL) / CAPITAL) * 100, maxDd, trades, haltReason };
}

/* ── 출력 ─────────────────────────────── */

const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const won = (n: number) => (IS_US ? `$${Math.round(n).toLocaleString("en-US")}` : Math.round(n).toLocaleString("ko-KR") + "원");

function stats(r: SimResult) {
  const wins = r.trades.filter((t) => t.pnl > 0);
  const losses = r.trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    winRate: r.trades.length ? (wins.length / r.trades.length) * 100 : 0,
    pf: gl ? gw / gl : Infinity,
    avgHold: r.trades.length ? r.trades.reduce((a, t) => a + t.holdDays, 0) / r.trades.length : 0,
  };
}

async function main() {
  const ds = await buildDataset();
  const first = ds.calendar[ds.startIdx];
  const last = ds.calendar.at(-1)!;
  const ki = ds.idxAsOf(INDEX_SYMBOL, first);
  const kf = ds.idxAsOf(INDEX_SYMBOL, last);
  const kospiReturn = ((ds.kospi.close[kf] - ds.kospi.close[ki]) / ds.kospi.close[ki]) * 100;

  console.log("\n" + "=".repeat(78));
  console.log(`퀀트 백테스트  ${first} ~ ${last}  (매매 ${ds.calendar.length - 1 - ds.startIdx} 거래일 · 데이터 ${RANGE} · 평가 ${EVAL})`);
  console.log(`벤치마크  ${INDEX_KO} 매수 후 보유 = ${pct(kospiReturn)}   원금 ${won(CAPITAL)}   비용 왕복 ${(ROUND_TRIP_COST * 100).toFixed(2)}% + 슬리피지 ${(SLIPPAGE * 100).toFixed(2)}%/편도`);
  console.log("=".repeat(78));
  console.log(`${"시나리오".padEnd(24)}${"수익률".padStart(10)}${`vs${INDEX_KO}`.padStart(11)}${"최대낙폭".padStart(10)}${"매매".padStart(7)}${"승률".padStart(8)}${"PF".padStart(7)}${"보유".padStart(7)}`);
  console.log("─".repeat(78));

  const results: SimResult[] = [];
  for (const cfg of SCENARIOS) {
    const r = simulate(ds, cfg);
    results.push(r);
    const s = stats(r);
    console.log(
      cfg.name.padEnd(24) +
        pct(r.totalReturn).padStart(10) +
        pct(r.totalReturn - kospiReturn).padStart(11) +
        `-${r.maxDd.toFixed(1)}%`.padStart(10) +
        `${r.trades.length}`.padStart(7) +
        `${s.winRate.toFixed(0)}%`.padStart(8) +
        s.pf.toFixed(2).padStart(7) +
        `${s.avgHold.toFixed(0)}일`.padStart(7),
    );
  }

  const best = results.reduce((a, b) => (b.totalReturn > a.totalReturn ? b : a));
  const s = stats(best);
  console.log("\n" + "─".repeat(78));
  console.log(`최고 — ${best.scenario.name}: ${pct(best.totalReturn)} (${INDEX_KO} 대비 ${pct(best.totalReturn - kospiReturn)}), 낙폭 -${best.maxDd.toFixed(1)}%, 평균 보유 ${s.avgHold.toFixed(1)}일`);
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of best.trades) {
    const k = t.reason.split(" (")[0];
    const cur = byReason.get(k) ?? { n: 0, pnl: 0 };
    cur.n++; cur.pnl += t.pnl;
    byReason.set(k, cur);
  }
  console.log("청산 사유별");
  for (const [k, v] of [...byReason].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(4)}건 ${won(v.pnl).padStart(14)}`);
  }
  console.log("\n※ 여기서 '수급'은 거래대금·MFI·매집강도 등 가격/거래량 프록시다. 실제 외국인·기관 순매수는 과거 재현 불가.");
  console.log("※ 시나리오는 원인 분리용이다. 최고 수치를 그대로 채택하면 과최적화가 된다.");
}

main().catch((e) => { console.error(e); process.exit(1); });
