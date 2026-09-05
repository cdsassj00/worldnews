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
import type { Levels } from "./levels";
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
  "오늘 추천 중 최근 보관본에 오래 남아 있던 순으로 고른 목록입니다 — 매일 바뀌는 종목이 아니라 며칠째 같은 이유로 남아 있는 종목을 앞에 둡니다. " +
  "과거 성과로 거르지 않으며(백테스트는 미래를 보장하지 않습니다), 잔류 일수·엔진 수·지지·저항을 그대로 보여드립니다. " +
  "보유 기간을 보장하지 않습니다.";

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
  todayPicks: { code: string; name: string; sector: string | null; score: number; price: number; changePct: number }[];
  levelsByCode: Map<string, Levels | null>;
  priceByCode: Map<string, number>;
  maxPicks?: number;
}): SwingBlock {
  const { cur, history, engines, todayPicks, levelsByCode, priceByCode, maxPicks = 4 } = params;

  const sessions = sessionsOf(history);
  const oldestFirst = [...sessions].reverse(); // history 는 최신순 — 첫 등장을 찾으려면 뒤집는다
  const headline = new Set(todayPicks.map((p) => p.code));

  /** 후보 정보 — 헤드라인 픽에 없으면 엔진 픽에서 이름·섹터·가격을 가져온다 */
  const meta = new Map<string, { name: string; sector: string | null; score: number; price: number; changePct: number }>();
  for (const e of engines) {
    for (const p of e.picks) {
      if (!meta.has(p.code)) meta.set(p.code, { name: p.name, sector: p.sector, score: p.score, price: p.price, changePct: p.changePct });
    }
  }
  for (const p of todayPicks) meta.set(p.code, { name: p.name, sector: p.sector, score: p.score, price: p.price, changePct: p.changePct });

  const codes = swingCandidateCodes({ history, engines, todayPickCodes: todayPicks.map((p) => p.code), max: 12 });
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

    /* 가장 가까운 자리를 쓴다 — computeLevels 의 지지·저항은 "많이 부딪힌 순"이라
     * 몇 달 전 바닥이 잡히곤 한다(현재가 대비 -30% 같은 자리). 손절·목표로 쓸 자리는
     * 강한 자리가 아니라 **먼저 닿는 자리**라, 살아 있는 지지·저항으로 널리 쓰이는
     * 이동평균과 52주 고저까지 후보에 넣고 그중 가장 가까운 것을 고른다.
     * 어디서 나온 선인지는 라벨로 같이 낸다 — 근거 없는 숫자를 내지 않기 위해서다. */
    const cands: { price: number; label: string }[] = [
      ...(lv?.support ?? []).map((s) => ({ price: s.price, label: `${s.touches}번 지지받은 자리` })),
      ...(lv?.resistance ?? []).map((s) => ({ price: s.price, label: `${s.touches}번 저항받은 자리` })),
      ...(lv?.ma?.ma5 ? [{ price: lv.ma.ma5, label: "5일선" }] : []),
      ...(lv?.ma?.ma20 ? [{ price: lv.ma.ma20, label: "20일선" }] : []),
      ...(lv?.ma?.ma60 ? [{ price: lv.ma.ma60, label: "60일선" }] : []),
      ...(lv?.ma?.ma120 ? [{ price: lv.ma.ma120, label: "120일선" }] : []),
      ...(lv?.week52?.low ? [{ price: lv.week52.low, label: "52주 최저" }] : []),
      ...(lv?.week52?.high ? [{ price: lv.week52.high, label: "52주 최고" }] : []),
    ];
    /* 저항은 "의미 있는 거리"부터 인정한다 — 현재가 +0.4% 자리를 목표라고 부르면
     * 손익비가 허위로 나빠지고 대본도 우스워진다. shared/ta.ts tradePlan 과 같은 기준
     * (2% 또는 0.8×ATR 중 큰 쪽). 지지는 가까울수록 손절 기준으로 쓸모가 있어 그대로 둔다. */
    const minGap = Math.max(now * 0.02, (lv?.atr14 ?? 0) * 0.8);
    const below = cands.filter((c) => c.price < now).sort((a, b) => b.price - a.price)[0] ?? null;
    const above = cands.filter((c) => c.price > now + minGap).sort((a, b) => a.price - b.price)[0] ?? null;
    const nearestSupport = below?.price ?? null;
    const nearestResistance = above?.price ?? null;
    const supportLabel = below?.label ?? null;
    const resistanceLabel = above?.label ?? null;
    const toSupportPct = nearestSupport ? round(((nearestSupport - now) / now) * 100, 1) : null;
    const toResistancePct = nearestResistance ? round(((nearestResistance - now) / now) * 100, 1) : null;

    const daysKo = appearances >= 2 ? `${appearances + 1}거래일째 추천에 남아 있는 종목` : "오늘 새로 올라온 종목";
    const engineKo = hits.filter((h) => !h.derived).length >= 2
      ? `근거가 다른 분석 ${hits.filter((h) => !h.derived).length}개가 동시에 지목`
      : hits.length ? `${hits[0].nameKo} 기준 상위` : "오늘 추천 목록";
    const supKo = nearestSupport ? `지지 ${supportLabel} ${nearestSupport.toLocaleString("ko-KR")}${cur}(${toSupportPct}%)` : "";
    const resKo = nearestResistance ? `저항 ${resistanceLabel} ${nearestResistance.toLocaleString("ko-KR")}${cur}(+${toResistancePct}%)` : "";
    const levelKo = supKo || resKo ? ` · ${[supKo, resKo].filter(Boolean).join(" / ")}` : "";

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
      hookKo: `${m.name} — ${daysKo}, ${engineKo}${levelKo}`,
      _score: m.score,
    });
  }

  rows.sort((a, b) => b.appearances - a.appearances || b.independentCount - a.independentCount || b._score - a._score);
  const picks = rows.slice(0, maxPicks).map(({ _score, ...rest }) => rest);

  const longest = picks[0];
  const headlineKo = !picks.length
    ? "오늘은 스윙 관점으로 추릴 종목이 없습니다."
    : longest.appearances >= 2
      ? `${longest.name}은 ${longest.appearances + 1}거래일째 같은 이유로 추천에 남아 있습니다 — 오늘 스윙 관점 ${picks.length}종목입니다.`
      : `오늘 스윙 관점 ${picks.length}종목 — 어제까지의 목록에서 얼마나 살아남았는지까지 함께 봅니다.`;

  return {
    ruleKo: RULE_KO,
    lookbackSessions: sessions.length,
    picks,
    headlineKo,
    note: `최근 보관본 ${sessions.length}회와 비교해 잔류 일수·독립 엔진 수 순으로 정렬했습니다. 과거 성과로 거르지 않았습니다.`,
  };
}
