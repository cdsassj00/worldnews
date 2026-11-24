/**
 * 스윙 관점 목록 — "매일 바뀌는 추천은 신빙성이 떨어진다"에 답하는 블록.
 *
 * **새로운 예측 모델이 아니다.** 며칠 보유를 전제로 한 별도 점수를 만들면 백테스트가 없는
 * 숫자를 새로 지어내는 것이라, 그건 하지 않는다. 대신 이미 있는 기록으로 **순서만** 매긴다:
 *
 *   ① 최근 보관본에서 며칠째 남아 있는가 — 하루 반짝인지 며칠째 같은 결론인지
 *   ② 오늘 어떤 엔진들이 들고 있는가 (파생 엔진 제외한 독립 표 수)
 *   ③ 가장 가까운 지지·저항이 어디인가 — 손절과 목표를 절대 가격으로 말하려고
 *   ④ 처음 등장가 대비 지금 얼마인가 — 참고용 실측(좋든 나쁘든 그대로), **거르는 기준은 아니다**
 *
 * 과거 성과로 종목을 거르지 않는다(2026-09-05 지시). 백테스트가 미래를 보장하지 않는데
 * 그걸로 오늘 목록을 막으면, 근거 없는 확신을 근거 있는 척 파는 것과 같다. 대신 잔류 일수와
 * 엔진 수를 **표시**해 시청자가 스스로 무게를 재게 한다.
 *
 * 그래서 이 목록은 "며칠 오를 종목"이 아니라 **"며칠째 같은 이유로 남아 있는 종목"** 이다.
 * 대본·게시물에서도 그렇게 소개해야 한다 — 보유 기간을 약속하는 순간 근거 없는 말이 된다.
 */
import { nearestLevels, type Levels } from "./levels";
import type { EngineOut } from "./agreement";
import { symbolFor } from "./symbols";
import { round } from "./util";

/** 보관본에서 이 모듈이 실제로 읽는 부분만 최소로 선언한다 */
export interface SwingHistEntry {
  date: string;
  picks: { code: string; name: string; price: number }[];
  full?: unknown;
}

interface FullForSwing {
  agreement?: { code: string; independentCount?: number }[];
  engines?: { picks?: { code: string; price?: number }[] }[];
}

interface Session {
  date: string;
  /** 그날 추천에 올라 있던 코드 — 헤드라인 픽 ∪ 그날 독립 2개 이상 합의 종목 */
  codes: Set<string>;
  price: Map<string, number>;
}

export interface SwingPick {
  code: string;
  symbol: string | null;
  name: string;
  sector: string | null;
  price: number;
  priceLabel: string;
  changePct: number;
  /** 최근 보관본 중 이 종목이 추천에 남아 있던 횟수 */
  appearances: number;
  /** 그 분모 — 지금 가지고 있는 과거 보관본 수 */
  ofSessions: number;
  /** 처음 등장한 보관본 날짜와 그때 가격 — 성과 계산의 기준 */
  firstSeenDate: string | null;
  firstSeenPrice: number | null;
  /** 처음 등장가 대비 현재가 — 실측이며, 마이너스면 마이너스로 나온다 */
  changeSincePct: number | null;
  /** 삼합(온톨로지+수급+차트) 종합 점수와 축별 점수 — 순위의 근거 */
  combo: { total: number; onto: number | null; flow: number | null; chart: number | null } | null;
  /** 오늘 이 종목을 든 엔진 중 파생(융합)을 뺀 수 */
  independentCount: number;
  engines: { id: string; nameKo: string; derived: boolean }[];
  levels: Levels | null;
  /** 가장 가까운(= 바로 아래) 지지 — 강한 자리가 아니라 실제로 먼저 닿는 자리 */
  nearestSupport: number | null;
  /** 그 자리가 어디서 나왔는지 — "20일선" / "3번 지지받은 자리" 등 */
  nearestSupportLabel: string | null;
  /** 가장 가까운(= 바로 위) 저항 */
  nearestResistance: number | null;
  nearestResistanceLabel: string | null;
  /** 현재가에서 지지·저항까지의 거리(%) */
  toSupportPct: number | null;
  toResistancePct: number | null;
  /** 가장 가까운 지지를 아직 지키고 있는가 — 지지 정보가 없으면 null */
  stillAboveSupport: boolean | null;
  /** 이 자리가 깨졌다고 볼 조건 — 지지 가격이 있을 때만 */
  invalidationKo: string | null;
  /** 왜 이 종목인가 — 온톨로지/수급/차트가 남긴 근거 문장 그대로(가공하지 않는다) */
  whyKo: string | null;
  /** 영상·게시물 첫 줄로 쓸 한 문장 — 전부 실측값으로만 만든다 */
  hookKo: string;
}

export interface SwingBlock {
  ruleKo: string;
  /** 비교에 쓴 과거 보관본 수 */
  lookbackSessions: number;
  picks: SwingPick[];
  /** 블록 전체의 후킹 문장 — 대본 오프닝·게시물 첫 줄용 */
  headlineKo: string;
  note: string;
}

const RULE_KO =
  "온톨로지·수급·차트를 같은 비중으로 섞은 삼합 종합 점수 순위에서 고른 목록입니다. " +
  "한 업종에 몰리지 않게 같은 업종은 최대 2종목까지만 넣고, 며칠째 남아 있는지는 함께 표시합니다. " +
  "과거 성과로 거르지 않으며(백테스트는 미래를 보장하지 않습니다), 보유 기간도 보장하지 않습니다.";

/** 같은 업종 최대 몇 종목까지 — 백테스트에서 섹터당 2종목(QKC2)이 3종목(QKC3)보다 나았다
 * (+5.85% vs -3.76%, 2026-09-08 측정). 한 업종이 꺾이는 날 목록이 통째로 지는 걸 막는다. */
const SECTOR_CAP = 2;

function sessionsOf(history: SwingHistEntry[]): Session[] {
  return history.map((h) => {
    const full = (h.full ?? {}) as FullForSwing;
    const codes = new Set<string>(h.picks.map((p) => p.code));
    for (const a of full.agreement ?? []) if ((a.independentCount ?? 0) >= 2) codes.add(a.code);
    const price = new Map<string, number>();
    for (const p of h.picks) if (p.price) price.set(p.code, p.price);
    for (const e of full.engines ?? []) for (const p of e.picks ?? []) if (p.price && !price.has(p.code)) price.set(p.code, p.price);
    return { date: h.date, codes, price };
  });
}

/**
 * 오늘 이 코드를 든 엔진들.
 *
 * 헤드라인 픽(레이더 온톨로지 상위)은 리그의 "onto" 원장과 종목이 다를 수 있는데, 근거는
 * 같은 온톨로지다 — 그래서 헤드라인이면 onto 를 **하나로 합쳐** 넣는다(둘 다 세면 같은
 * 근거를 두 번 세는 것이고, 아무 데도 안 넣으면 독립 0표로 나와 사실과 다르다).
 */
function sourcesFor(engines: EngineOut[], code: string, inHeadline: boolean) {
  const hits = engines.filter((e) => e.picks.some((p) => p.code === code))
    .map((e) => ({ id: e.id, nameKo: e.nameKo, derived: e.derived }));
  if (inHeadline && !hits.some((h) => h.id === "onto")) hits.unshift({ id: "onto", nameKo: "온톨로지", derived: false });
  return hits;
}

/**
 * 스윙 후보 코드 — 지지·저항 조회 대상을 정하려고 레벨 없이 먼저 계산한다
 * (레벨을 받은 뒤에 고르면 목록에 없는 종목의 시세까지 받게 된다).
 * 거르지 않고 **순서만** 매긴 뒤 위에서 자른다 — 조건을 못 채웠다고 빈 목록을 내면
 * 매일 발행하는 콘텐츠에서는 그냥 쓸모가 없다.
 */
export function swingCandidateCodes(params: {
  history: SwingHistEntry[];
  engines: EngineOut[];
  todayPickCodes: string[];
  max?: number;
}): string[] {
  const { history, engines, todayPickCodes, max = 8 } = params;
  const sessions = sessionsOf(history);
  const headline = new Set(todayPickCodes);
  const pool = new Set<string>([...todayPickCodes, ...engines.flatMap((e) => e.picks.map((p) => p.code))]);
  return [...pool]
    .map((code) => ({
      code,
      appearances: sessions.filter((s) => s.codes.has(code)).length,
      independent: sourcesFor(engines, code, headline.has(code)).filter((h) => !h.derived).length,
    }))
    .sort((a, b) => b.appearances - a.appearances || b.independent - a.independent)
    .slice(0, max)
    .map((x) => x.code);
}

export function buildSwing(params: {
  cur: string;
  history: SwingHistEntry[];
  engines: EngineOut[];
  /** 오늘 헤드라인 픽(온톨로지 상위) */
  todayPicks: { code: string; name: string; sector: string | null; score: number; price: number; changePct: number; reason?: string | null }[];
  levelsByCode: Map<string, Levels | null>;
  priceByCode: Map<string, number>;
  /** 삼합 순위(조합 전략 탭과 같은 계산) — 이 목록의 정렬 기준이다 */
  comboRows?: { code: string; name: string; sector: string | null; price: number; changePct: number; total: number; onto: number | null; flow: number | null; chart: number | null; reason?: string | null }[];
  maxPicks?: number;
}): SwingBlock {
  const { cur, history, engines, todayPicks, levelsByCode, priceByCode, comboRows = [], maxPicks = 4 } = params;

  const sessions = sessionsOf(history);
  const oldestFirst = [...sessions].reverse(); // history 는 최신순 — 첫 등장을 찾으려면 뒤집는다
  const headline = new Set(todayPicks.map((p) => p.code));

  /** 후보 정보 — 헤드라인 픽에 없으면 엔진 픽에서 이름·섹터·가격을 가져온다 */
  const meta = new Map<string, { name: string; sector: string | null; score: number; price: number; changePct: number; reason: string | null }>();
  for (const e of engines) {
    for (const p of e.picks) {
      if (!meta.has(p.code)) meta.set(p.code, { name: p.name, sector: p.sector, score: p.score, price: p.price, changePct: p.changePct, reason: p.reasons[0] ?? null });
    }
  }
  for (const p of todayPicks) {
    const prev = meta.get(p.code);
    meta.set(p.code, { name: p.name, sector: p.sector, score: p.score, price: p.price, changePct: p.changePct, reason: p.reason ?? prev?.reason ?? null });
  }

  /* 후보 = 삼합 상위 + 오늘 헤드라인/엔진 픽. 삼합을 먼저 넣는 이유는 이 목록의 순위 기준이
   * 삼합 종합 점수이기 때문이다(2026-09-09: 잔류 일수로 줄 세우니 같은 종목만 며칠씩 남았다). */
  const comboByCode = new Map(comboRows.map((r) => [r.code, r]));
  for (const r of comboRows) {
    if (!meta.has(r.code)) meta.set(r.code, { name: r.name, sector: r.sector, score: r.total, price: r.price, changePct: r.changePct, reason: r.reason ?? null });
  }
  const codes = [...new Set([
    ...comboRows.slice(0, 12).map((r) => r.code),
    ...swingCandidateCodes({ history, engines, todayPickCodes: todayPicks.map((p) => p.code), max: 8 }),
  ])];
  const rows: (SwingPick & { _score: number })[] = [];
  for (const code of codes) {
    const m = meta.get(code);
    if (!m) continue;
    const hits = sourcesFor(engines, code, headline.has(code));
    const appearances = sessions.filter((s) => s.codes.has(code)).length;
    const first = oldestFirst.find((s) => s.codes.has(code));
    const firstSeenPrice = first?.price.get(code) ?? null;
    const now = priceByCode.get(code) ?? m.price;
    const lv = levelsByCode.get(code) ?? null;

    const near = nearestLevels(lv, now);
    const nearestSupport = near.support?.price ?? null;
    const nearestResistance = near.resistance?.price ?? null;
    const supportLabel = near.support?.label ?? null;
    const resistanceLabel = near.resistance?.label ?? null;
    const toSupportPct = nearestSupport ? round(((nearestSupport - now) / now) * 100, 1) : null;
    const toResistancePct = nearestResistance ? round(((nearestResistance - now) / now) * 100, 1) : null;

    const daysKo = appearances >= 2 ? `${appearances + 1}거래일째 추천에 남아 있는 종목` : "오늘 새로 올라온 종목";
    const engineKo = hits.filter((h) => !h.derived).length >= 2
      ? `근거가 다른 분석 ${hits.filter((h) => !h.derived).length}개가 동시에 지목`
      : hits.length ? `${hits[0].nameKo} 기준 상위` : "오늘 추천 목록";
    const supKo = nearestSupport ? `지지 ${supportLabel} ${nearestSupport.toLocaleString("ko-KR")}${cur}(${toSupportPct}%)` : "";
    const resKo = nearestResistance ? `저항 ${resistanceLabel} ${nearestResistance.toLocaleString("ko-KR")}${cur}(+${toResistancePct}%)` : "";
    const levelKo = supKo || resKo ? ` · ${[supKo, resKo].filter(Boolean).join(" / ")}` : "";

    const cb = comboByCode.get(code);
    rows.push({
      code,
      symbol: symbolFor(code),
      name: m.name,
      sector: m.sector,
      price: now,
      priceLabel: `${now.toLocaleString("ko-KR")}${cur}`,
      changePct: m.changePct,
      appearances,
      ofSessions: sessions.length,
      firstSeenDate: first?.date ?? null,
      firstSeenPrice,
      changeSincePct: firstSeenPrice ? round(((now - firstSeenPrice) / firstSeenPrice) * 100, 2) : null,
      combo: cb ? { total: cb.total, onto: cb.onto, flow: cb.flow, chart: cb.chart } : null,
      independentCount: hits.filter((h) => !h.derived).length,
      engines: hits,
      levels: lv,
      nearestSupport,
      nearestSupportLabel: supportLabel,
      nearestResistance,
      nearestResistanceLabel: resistanceLabel,
      toSupportPct,
      toResistancePct,
      stillAboveSupport: nearestSupport === null ? null : now > nearestSupport,
      invalidationKo: nearestSupport === null
        ? null
        : `종가가 ${nearestSupport.toLocaleString("ko-KR")}${cur}(${supportLabel}) 아래로 마감하면 이 자리는 깨진 것으로 봅니다`,
      whyKo: m.reason ?? (cb
        ? `삼합 종합 ${cb.total >= 0 ? "+" : ""}${cb.total.toFixed(2)} — 온톨로지 ${cb.onto ?? "-"} · 수급 ${cb.flow ?? "-"} · 차트 ${cb.chart ?? "-"}`
        : null),
      hookKo: `${m.name} — ${daysKo}, ${engineKo}${levelKo}`,
      _score: m.score,
    });
  }

  /* 정렬은 삼합 종합 점수 — 잔류 일수는 동점일 때만 본다. 잔류를 1순위로 두면 한 번 오른
   * 종목이 계속 자리를 차지해 "며칠째 같은 종목"이 되고, 점수가 더 높은 종목이 밀린다. */
  rows.sort((a, b) =>
    (b.combo?.total ?? -9) - (a.combo?.total ?? -9)
    || b.independentCount - a.independentCount
    || b.appearances - a.appearances
    || b._score - a._score);

  /* 같은 업종은 최대 SECTOR_CAP 개까지 — 오늘처럼 상위 4개 중 3개가 정유화학이면
   * 그 업종이 꺾이는 날 목록이 통째로 진다(백테스트 QKC2 > QKC3 으로도 확인). */
  const bySector = new Map<string, number>();
  const capped: typeof rows = [];
  for (const r of rows) {
    const key = r.sector ?? "미분류";
    const n = bySector.get(key) ?? 0;
    if (n >= SECTOR_CAP) continue;
    bySector.set(key, n + 1);
    capped.push(r);
    if (capped.length >= maxPicks) break;
  }
  const picks = capped.map(({ _score, ...rest }) => rest);

  const top = picks[0];
  const headlineKo = !picks.length
    ? "오늘은 스윙 관점으로 추릴 종목이 없습니다."
    : `오늘 삼합 종합 1위는 ${top.name}(${top.combo ? (top.combo.total >= 0 ? "+" : "") + top.combo.total.toFixed(2) : "-"})입니다 — 업종이 겹치지 않게 고른 ${picks.length}종목입니다.`;

  return {
    ruleKo: RULE_KO,
    lookbackSessions: sessions.length,
    picks,
    headlineKo,
    note: `삼합 종합 점수 순으로 고르고 같은 업종은 최대 ${SECTOR_CAP}종목까지만 넣었습니다. 잔류 일수는 최근 보관본 ${sessions.length}회와 비교한 값이며, 과거 성과로 거르지 않았습니다.`,
  };
}
