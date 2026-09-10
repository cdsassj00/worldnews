/**
 * 투자 기간별 종목 추천 — 단타 / 스윙 / 장기.
 *
 * 이 사이트의 목적은 분석 자체가 아니라 **"그래서 뭘 언제 사고 언제 파느냐"** 에 답하는 것이다.
 * 그런데 지금까지 발행하던 목록은 기간 구분이 없어서, 같은 종목을 보고도 하루 만에 팔지
 * 석 달을 들지 알 수가 없었다. 그래서 기간별로 나눈다.
 *
 * **셋의 매수 신호는 똑같다.** 삼합(온톨로지+수급+차트 평균) 점수가 문턱 0.35 를 넘는 종목.
 * 다른 것은 **언제 파느냐** 뿐이고, 그 청산 규칙마다 백테스트를 따로 돌려 성적을 쟀다
 * (shared/backtest-results.json 의 horizons — 2026-09-10 측정).
 *
 *   단타 — 익절 +10% / 손절 −5% / 7거래일 안에 수익 없으면 청산
 *   스윙 — 익절 +15% / 손절 −6% / 섹터당 2종목
 *   장기 — 익절 없음 / 고점 대비 −25% 추적손절 / 지수 60일선 필터
 *
 * 좁은 단타 판(익절 6%·손절 3%)은 전 구간 손실이었다 — 왕복비용 0.83% 와 일중 노이즈가
 * 익절 폭을 먹는다. 그래서 채택하지 않았고, 그 사실도 caveats 로 같이 내보낸다.
 *
 * **정직하게 구분해야 하는 것 하나**: 매수 문턱과 청산 규칙은 측정한 그대로다. 다만 같은
 * 삼합 상위 안에서 **어느 종목을 먼저 보여줄지**의 정렬은 그 구간이 기대는 축(단타=수급,
 * 장기=거시) 순으로 세웠고, 이 정렬 자체는 따로 측정하지 않았다. orderKo 에 그렇게 적는다.
 */
import { backtestResults } from "./backtest";
import { nearestLevels, type Levels } from "./levels";
import { symbolFor } from "./symbols";
import { round } from "./util";

const SITE = "https://stockontology.cc";

export type HorizonId = "day" | "swing" | "long";
export type HorizonMarket = "KR" | "US";

/** 백테스트 기록에서 읽는 부분만 최소로 선언한다 */
interface BtHorizons {
  horizons?: {
    entryKo: string;
    note: string;
    windows: string[];
    benchmark: Record<string, { nameKo: string; returns: number[] }>;
    buckets: {
      id: string; nameKo: string; scenario: string; ruleKo: string; holdKo: string;
      KR: BtSide; US: BtSide;
    }[];
    caveats: string[];
  };
}
interface BtSide { returns: number[]; maxDd: number[]; trades: number[]; winRate: number[]; holdDaysAvg: number[] }

/** 이 모듈이 종목 하나에 대해 필요로 하는 재료 — brief 가 이미 들고 있는 것만 받는다 */
export interface HorizonSource {
  code: string;
  name: string;
  sector: string | null;
  price: number;
  changePct: number;
  /** 삼합 종합 점수와 축별 점수 */
  total: number;
  onto: number | null;
  flow: number | null;
  chart: number | null;
  /** 온톨로지가 남긴 거시 인과 문장 (레이더 reasons 중 ontology 종류) */
  macroKo: string | null;
  /** 수급 스캔이 남긴 근거 문장 */
  flowKo: string | null;
  /** 차트 쪽 근거 문장 (전략 합의·추세 정렬) */
  chartKo: string | null;
  levels: Levels | null;
}

export interface HorizonPlan {
  /** 참고 현재가 — 실제 체결은 다음 거래일 시가다 */
  referencePrice: number;
  referenceLabel: string;
  stop: number;
  stopPct: number;
  stopWhyKo: string;
  /** 장기는 목표가를 두지 않는다(추적손절이 대신한다) */
  target: number | null;
  targetPct: number | null;
  targetWhyKo: string;
  /** 손익비 — 목표가가 없으면 null */
  rr: number | null;
  holdKo: string;
  /** 참고 — 계획을 바꾸지는 않지만 어디가 먼저 시험대인지 알려 준다 */
  nearestSupport: { price: number; label: string; pct: number } | null;
  nearestResistance: { price: number; label: string; pct: number } | null;
  /** 규칙 손절·목표와 실제 지지·저항의 관계 한 문장 */
  levelNoteKo: string | null;
}

export interface HorizonPick {
  rank: number;
  code: string;
  symbol: string | null;
  name: string;
  sector: string | null;
  price: number;
  priceLabel: string;
  changePct: number;
  combo: { total: number; onto: number | null; flow: number | null; chart: number | null };
  /** 세 관점 — 근거가 없는 축은 null 이다(없는 분석을 한 척하지 않는다) */
  why: { ontologyKo: string | null; flowKo: string | null; chartKo: string | null };
  plan: HorizonPlan;
  /** 게시물·영상 첫 줄 — 전부 실측값으로만 만든다 */
  hookKo: string;
  /** 그대로 첨부할 수 있는 장면 주소(PNG 로 찍어 보낸다) */
  views: { chart: string; strategies: string; stock: string | null };
}

export interface HorizonBucket {
  id: HorizonId;
  nameKo: string;
  /** 이 구간이 실제로 며칠짜리였는지 — 백테스트 실측 */
  holdKo: string;
  /** 청산 규칙 한 문장 */
  ruleKo: string;
  /** 매수 시점 */
  entryKo: string;
  /** 이 구간의 정렬 기준과 그 한계 */
  orderKo: string;
  /** 측정 성적 — 창별 수익률·승률·표본수·낙폭 */
  track: {
    scenario: string;
    windows: string[];
    returns: number[];
    winRate: number[];
    trades: number[];
    maxDd: number[];
    holdDaysAvg: number[];
    benchmarkKo: string;
    benchmarkReturns: number[];
    /** 사람이 읽는 한 줄 — 지수를 이겼는지 졌는지까지 그대로 */
    summaryKo: string;
  } | null;
  picks: HorizonPick[];
  headlineKo: string;
  /** 이 구간을 쓸 때 알아야 할 것 — 나쁜 소식도 그대로 */
  cautionKo: string;
}

/* ── 구간별 청산 규칙 — 백테스트에 넣은 값 그대로 ──────────────── */

interface Rule {
  id: HorizonId;
  nameKo: string;
  stopPct: number;
  /** null 이면 익절 없음(추적손절로 나온다) */
  takePct: number | null;
  trailPct: number | null;
  /** 같은 삼합 상위 안에서 무엇을 먼저 보여줄지 */
  orderBy: "flow" | "total" | "onto";
  orderKo: string;
  maxPicks: number;
}

const RULES: Rule[] = [
  {
    id: "day", nameKo: "단타", stopPct: 5, takePct: 10, trailPct: null,
    orderBy: "flow",
    orderKo: "삼합 상위 안에서 수급 축이 강한 순 — 짧게 끊는 규칙이라 거래대금·자금흐름이 먼저 터진 종목을 위에 둡니다. 이 정렬 자체는 따로 측정하지 않았습니다.",
    maxPicks: 3,
  },
  {
    id: "swing", nameKo: "스윙", stopPct: 6, takePct: 15, trailPct: null,
    orderBy: "total",
    orderKo: "삼합 종합 점수 순 — 백테스트가 측정한 순서 그대로입니다.",
    maxPicks: 4,
  },
  {
    id: "long", nameKo: "장기", stopPct: 25, takePct: null, trailPct: 25,
    orderBy: "onto",
    orderKo: "삼합 상위 안에서 온톨로지(거시 인과) 축이 강한 순 — 수개월을 들려면 업종을 미는 거시 국면이 있어야 합니다. 이 정렬 자체는 따로 측정하지 않았습니다.",
    maxPicks: 3,
  },
];

/** 같은 업종 최대 몇 종목 — 백테스트 섹터캡 2 와 같은 값 */
const SECTOR_CAP = 2;

/* ── 계획 만들기 ──────────────────────────────── */

const fmt = (v: number, cur: string) =>
  cur === "$" ? `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}$` : `${Math.round(v).toLocaleString("ko-KR")}원`;

/**
 * 손절·목표는 **백테스트가 측정한 규칙 그대로** 쓴다.
 *
 * 한 번 잘못 만들었다가 되돌린 부분이라 남겨 둔다: 처음에는 "바로 아래 지지가 규칙보다
 * 가까우면 지지를 손절로 쓰자"고 했는데, 그러면 장기 규칙(고점 대비 −25% 추적)의 손절이
 * 5일선 −3.5% 로 나왔다. 며칠이면 잘리는 자리다 — 평균 41일을 들고 +151% 가 나왔다는
 * 그 기록과 아무 상관 없는 계획을 성적표만 붙여 내보내는 꼴이 된다.
 *
 * 그래서 규칙은 규칙대로 두고, 지지·저항은 **참고 정보로 따로** 싣는다. 계획과 성적표가
 * 같은 규칙을 가리켜야 성적표가 의미를 갖는다.
 */
function planFor(src: HorizonSource, rule: Rule, cur: string, holdKo: string): HorizonPlan {
  const price = src.price;
  // 원화에는 소수점이 없다 — "21,327.5원" 은 계산이 아니라 표시 실수로 읽힌다
  const px = (v: number) => (cur === "$" ? round(v, 2) : Math.round(v));

  const stop = price * (1 - rule.stopPct / 100);
  const target = rule.takePct === null ? null : price * (1 + rule.takePct / 100);
  const near = nearestLevels(src.levels, price);

  const stopWhyKo = rule.trailPct !== null
    ? `측정한 규칙 그대로 고점 대비 −${rule.trailPct}% 입니다. 지금 진입한다면 ${fmt(stop, cur)} 이 첫 손절선이고, 오르면 그만큼 따라 올라갑니다.`
    : `측정한 규칙 그대로 −${rule.stopPct}% 입니다.`;

  const targetWhyKo = rule.takePct === null
    ? `목표가를 두지 않습니다. 고점 대비 −${rule.trailPct}% 로 내려올 때 나옵니다 — 수개월을 끌고 가려면 위쪽을 막으면 안 됩니다.`
    : `측정한 규칙 그대로 +${rule.takePct}% 입니다.`;

  const risk = price - stop;
  return {
    referencePrice: px(price),
    referenceLabel: fmt(price, cur),
    stop: px(stop),
    stopPct: -rule.stopPct,
    stopWhyKo,
    target: target === null ? null : px(target),
    targetPct: rule.takePct,
    targetWhyKo,
    rr: target !== null && risk > 0 ? round((target - price) / risk, 2) : null,
    holdKo,
    /* 참고 정보 — 계획을 바꾸지는 않지만, 규칙 손절이 지지선보다 위인지 아래인지는
     * 알고 들어가야 한다. "규칙대로 −6% 인데 바로 아래 지지가 −5% 라 먼저 닿는다" 같은 것. */
    nearestSupport: near.support ? { price: px(near.support.price), label: near.support.label, pct: round(((near.support.price - price) / price) * 100, 1) } : null,
    nearestResistance: near.resistance ? { price: px(near.resistance.price), label: near.resistance.label, pct: round(((near.resistance.price - price) / price) * 100, 1) } : null,
    levelNoteKo: levelNoteFor(price, stop, target, near, cur),
  };
}

/** 규칙 손절·목표와 실제 지지·저항의 관계를 한 문장으로 — 이게 "차트 세부 분석"의 알맹이다 */
function levelNoteFor(
  price: number,
  stop: number,
  target: number | null,
  near: ReturnType<typeof nearestLevels>,
  cur: string,
): string | null {
  const bits: string[] = [];
  if (near.support) {
    const p = near.support.price;
    // 조사(은/는·이/가)는 앞말 받침에 따라 갈린다 — 숫자 뒤에 붙이면 반드시 틀린다.
    // 그래서 "지지 — 값. 판정." 처럼 끊어 쓴다.
    bits.push(p > stop
      ? `바로 아래 지지 — ${near.support.label} ${fmt(p, cur)}. 규칙 손절보다 위라 여기가 먼저 시험대입니다.`
      : `바로 아래 지지 — ${near.support.label} ${fmt(p, cur)}. 규칙 손절보다 아래라 손절이 먼저 걸립니다.`);
  }
  if (near.resistance && target !== null) {
    const p = near.resistance.price;
    bits.push(p < target
      ? `위쪽 저항 — ${near.resistance.label} ${fmt(p, cur)}. 목표보다 가까워 거기서 한 번 막힐 수 있습니다.`
      : `목표까지 걸리는 저항 없음 (다음 저항 ${fmt(p, cur)}).`);
  } else if (near.resistance) {
    bits.push(`위쪽 저항 — ${near.resistance.label} ${fmt(near.resistance.price, cur)}.`);
  }
  return bits.length ? bits.join(" ") : null;
}

/* ── 성적 문장 ──────────────────────────────── */

function summarize(nameKo: string, side: BtSide, bench: number[], windows: string[], benchKo: string): string {
  const i = windows.indexOf("1y") >= 0 ? windows.indexOf("1y") : windows.length - 1;
  const r = side.returns[i], b = bench[i], gap = round(r - b, 2);
  const beat = gap >= 0;
  return (
    `${nameKo} 규칙을 최근 1년에 돌리면 ${r >= 0 ? "+" : ""}${r}% 였습니다. ` +
    `같은 기간 ${benchKo}는 ${b >= 0 ? "+" : ""}${b}% 라 ${beat ? `${gap}%p 앞섰습니다` : `${Math.abs(gap)}%p 뒤졌습니다`}. ` +
    `매매 ${side.trades[i]}건, 승률 ${side.winRate[i]}%, 최대낙폭 −${side.maxDd[i]}%, 평균 보유 ${side.holdDaysAvg[i]}일.`
  );
}

/** 표본이 적으면 수익률보다 그 사실을 먼저 말해야 한다 */
function cautionFor(id: HorizonId, side: BtSide, windows: string[]): string {
  const i = windows.length - 1;
  const n = side.trades[i];
  const thin = n < 20 ? `최근 1년 매매가 ${n}건뿐입니다 — 수익률 숫자보다 "몇 건으로 낸 숫자인지"를 먼저 보십시오. ` : "";
  const dd = `최대낙폭은 −${side.maxDd[i]}% 였습니다. `;
  const short = windows.indexOf("3mo") >= 0 && side.returns[windows.indexOf("3mo")] < 0
    ? "최근 3개월 창에서는 손실이었습니다 — 이 규칙은 하락장을 이기지 못합니다. " : "";
  const per: Record<HorizonId, string> = {
    day: "왕복 비용과 일중 노이즈에 가장 취약한 구간입니다. 익절을 더 좁히면(6%·손절 3%) 측정 결과 전 구간 손실이었습니다.",
    swing: "지금 운영 중인 규칙과 같습니다.",
    long: "한국은 평균 보유가 한 달 남짓으로 3개월에 못 미칩니다 — 추적손절 25%가 그 전에 걸립니다.",
  };
  return thin + dd + short + per[id];
}

/* ── 본체 ──────────────────────────────── */

export interface HorizonsBlock {
  market: HorizonMarket;
  /** 세 구간에 공통으로 적용되는 매수 시점 */
  entryKo: string;
  /** 세 구간의 관계를 한 문장으로 */
  noteKo: string;
  buckets: HorizonBucket[];
  caveats: string[];
  measuredAt: string | null;
  disclaimerKo: string;
}

export function buildHorizons(params: {
  market: HorizonMarket;
  cur: string;
  /** 삼합 상위 후보 — 점수 높은 순으로 이미 정렬돼 있어야 한다 */
  sources: HorizonSource[];
}): HorizonsBlock | null {
  const { market, cur, sources } = params;
  if (!sources.length) return null;

  const bt = backtestResults() as (BtHorizons & { measuredAt?: string }) | null;
  const h = bt?.horizons ?? null;
  const windows = h?.windows ?? ["3mo", "6mo", "1y"];
  const bench = h?.benchmark?.[market] ?? null;

  const buckets: HorizonBucket[] = RULES.map((rule) => {
    const meta = h?.buckets.find((b) => b.nameKo === rule.nameKo) ?? null;
    const side: BtSide | null = meta ? (market === "KR" ? meta.KR : meta.US) : null;
    const holdKo = meta?.holdKo ?? "백테스트 기록 없음";

    /* 정렬 — 그 구간이 기대는 축 순. 축 점수가 없는 종목은 삼합 총점으로 내려간다
     * (없는 축을 0 으로 치면 정보 없음이 나쁨으로 둔갑한다). */
    const key = (s: HorizonSource): number => {
      const v = rule.orderBy === "flow" ? s.flow : rule.orderBy === "onto" ? s.onto : s.total;
      return v ?? s.total - 1;
    };
    const ordered = [...sources].sort((a, b) => key(b) - key(a) || b.total - a.total);

    const picks: HorizonPick[] = [];
    const bySector = new Map<string, number>();
    for (const s of ordered) {
      if (picks.length >= rule.maxPicks) break;
      const sec = s.sector ?? "";
      if (sec) {
        const n = bySector.get(sec) ?? 0;
        if (n >= SECTOR_CAP) continue;
        bySector.set(sec, n + 1);
      }
      const plan = planFor(s, rule, cur, holdKo);
      picks.push({
        rank: picks.length + 1,
        code: s.code,
        symbol: symbolFor(s.code),
        name: s.name,
        sector: s.sector,
        price: round(s.price, 2),
        priceLabel: fmt(s.price, cur),
        changePct: round(s.changePct, 2),
        combo: { total: s.total, onto: s.onto, flow: s.flow, chart: s.chart },
        why: { ontologyKo: s.macroKo, flowKo: s.flowKo, chartKo: s.chartKo },
        plan,
        hookKo: hookFor(rule, s, plan, cur),
        views: {
          chart: `${SITE}/api/scene.svg?market=${market}&view=chart:${s.code}`,
          strategies: `${SITE}/api/scene.svg?market=${market}&view=strategies:${s.code}`,
          stock: symbolFor(s.code) ? `${SITE}/api/scene.svg?market=${market}&view=stock:${s.code}` : null,
        },
      });
    }

    return {
      id: rule.id,
      nameKo: rule.nameKo,
      holdKo,
      ruleKo: meta?.ruleKo ?? `익절 ${rule.takePct ? `+${rule.takePct}%` : "없음"} · 손절 −${rule.stopPct}%`,
      entryKo: h?.entryKo ?? "장 마감 후 점수를 내고 다음 거래일 시가에 매수합니다.",
      orderKo: rule.orderKo,
      track: side && bench && meta
        ? {
          scenario: meta.scenario,
          windows,
          returns: side.returns, winRate: side.winRate, trades: side.trades,
          maxDd: side.maxDd, holdDaysAvg: side.holdDaysAvg,
          benchmarkKo: bench.nameKo, benchmarkReturns: bench.returns,
          summaryKo: summarize(rule.nameKo, side, bench.returns, windows, bench.nameKo),
        }
        : null,
      picks,
      headlineKo: picks.length
        ? `${rule.nameKo} 관점 ${picks.length}종목 — ${picks.map((p) => p.name).join(" · ")}`
        : `${rule.nameKo} 관점에서 문턱을 넘은 종목이 없습니다.`,
      cautionKo: side ? cautionFor(rule.id, side, windows) : "이 구간은 아직 백테스트 기록이 없습니다.",
    };
  });

  return {
    market,
    entryKo: h?.entryKo ?? "장 마감 후 점수를 내고 다음 거래일 시가에 매수합니다.",
    noteKo:
      "세 구간의 매수 신호는 같습니다 — 삼합(온톨로지+수급+차트 평균) 점수가 문턱을 넘은 종목입니다. " +
      "다른 것은 언제 파느냐뿐이고, 그 청산 규칙마다 백테스트를 따로 돌려 성적을 쟀습니다.",
    buckets,
    caveats: h?.caveats ?? [],
    measuredAt: bt?.measuredAt ?? null,
    disclaimerKo:
      "공개 데이터 기반 자동 분석이며 투자 자문·권유가 아닙니다. 백테스트는 과거 시세로 규칙을 되돌려 본 " +
      "모의 실험이고 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 본인에게 있습니다.",
  };
}

/** 첫 줄 — 지어낸 수식어 없이 숫자만으로 만든다 */
function hookFor(rule: Rule, s: HorizonSource, plan: HorizonPlan, cur: string): string {
  const head = `${s.name} ${plan.referenceLabel}`;
  const move = `${s.changePct >= 0 ? "+" : ""}${round(s.changePct, 1)}%`;
  if (rule.id === "long") {
    return `${head} (${move}) — 삼합 ${s.total.toFixed(2)}${s.onto !== null ? `, 거시 축 ${s.onto.toFixed(2)}` : ""}. 목표 없이 고점 대비 −${rule.trailPct}% 까지 끌고 갑니다.`;
  }
  const tgt = plan.target !== null ? `목표 ${fmt(plan.target, cur)}(${plan.targetPct! >= 0 ? "+" : ""}${plan.targetPct}%)` : "";
  return `${head} (${move}) — 삼합 ${s.total.toFixed(2)}. ${tgt} · 손절 ${fmt(plan.stop, cur)}(${plan.stopPct}%)${plan.rr !== null ? ` · 손익비 ${plan.rr}` : ""}.`;
}
