/**
 * 데일리 브리프 — 외부 발행 파이프라인(유튜브 자동발행 등)용 공개 API.
 *
 *   /api/daily-brief?market=KR|US|both[&date=YYYY-MM-DD]  장 마감 요약 JSON (대본 재료)
 *   /api/brief-card.svg?market=KR|US[&ratio=9:16]         온톨로지 경로 카드 (썸네일·본문 이미지)
 *
 * 원칙
 *  - 공개 데이터만 담는다(결론·리그·백테스트). 계좌·주문·실계좌 손익은 절대 넣지 않는다.
 *  - 필드 계약을 지킨다 — 추가는 자유, 삭제·개명은 금지 (docs/DAILY-BRIEF-API.md).
 *  - 어제 추천은 오늘 채점해서 공개한다(previous 블록). 기준은 응답에 문장으로 명시한다.
 *
 * 2026-08-19 유튜브 파이프라인 요청서 반영:
 *  1-1 미국 causal 분리(verdict.ts) · 1-2 섹터 라벨 교정(radar-universe.json)
 *  1-3 picks[].reasons · 2-1 previous(어제 채점) · 2-2 date 파라미터(과거는 보관본, 없으면 404)
 *  2-3 basis · 2-4 isNew/daysInList/dropped · 2-5 speech · 2-6 ticker · 3 폰트·9:16
 */
import type { Env } from "./env";
import { getVerdict, type OntoVerdict } from "./verdict";
import { labOverview, usMarketOpen } from "./quant";
import { marketPhase } from "./autotrade";
import { radarTop } from "./radarscan";
import { backtestResults } from "./backtest";
import { nextTradingDay } from "./holidays";
import { getManySeries } from "./quotes";
import { computeLevels, type Levels } from "./levels";
import { buildEnginesAndAgreement, holdDaysFor } from "./agreement";
import { ApiError, round } from "./util";
import { CODE_TO_SYMBOL, symbolFor } from "./symbols";

type BriefMarket = "KR" | "US";

const MACRO_KO: Record<string, string> = {
  OIL: "유가", USDKRW: "원/달러", US10Y: "미 10년 금리", SEMI: "반도체 업황",
  KOSPI: "코스피", CHINA: "중국 증시", VIX: "변동성", GOLD: "금",
  DXY: "달러인덱스", COPPER: "구리", NASDAQ: "나스닥", BTC: "비트코인", US2Y: "미 단기금리", JPY: "엔/달러",
};

const DISCLAIMER =
  "본 내용은 운영자 개인 계좌 운용 기록의 공개이며 투자 자문·권유가 아닙니다. 시뮬레이션·백테스트는 과거 데이터 기반으로 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 이용자 본인에게 있습니다.";

const BASIS_NOTE =
  "종목 시세·점수는 레이더 최근 스캔값(장중 최대 약 1시간 전), 거시 신호는 호출 시점 기준입니다. 어제 채점(previous)의 기준가는 어제 마지막 브리프 생성 시점의 시세, 비교가는 이번 응답 생성 시점의 시세입니다 — 유리한 기준을 고르지 않았습니다.";

function kstDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 특정 로컬 날짜(YYYY-MM-DD)를 그 시간대 기준으로 뽑는다 — dataSessionDate 계산용 */
function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** 스냅샷 기준 상태 — 장중이면 intraday, 아니면 KST 시각으로 전/후 판별 */
function basisOf(market: BriefMarket): "prev_close" | "intraday" | "post_close" {
  if (market === "KR") {
    const ph = marketPhase();
    if (ph.open) return "intraday";
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }).format(new Date()));
    return h < 9 ? "prev_close" : "post_close";
  }
  if (usMarketOpen()) return "intraday";
  const hNY = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date()));
  return hNY < 9 ? "prev_close" : "post_close";
}

/* ── 발행 이력 (어제 채점·연속일·과거 조회의 근거) ────────── */

const histKey = (market: BriefMarket, date: string) => `brief:hist:${market}:${date}`;
const HIST_TTL = 45 * 86_400;

interface StoredBrief {
  date: string;
  market: BriefMarket;
  generatedAt: number;
  basis: string;
  picks: { code: string; name: string; sector: string | null; score: number; price: number }[];
  /** 과거 조회(?date=)용 전체 본문 */
  full: unknown;
}

async function loadHist(env: Env, market: BriefMarket, date: string): Promise<StoredBrief | null> {
  return (await env.CACHE.get(histKey(market, date), "json").catch(() => null)) as StoredBrief | null;
}

/** 오늘보다 앞선 가장 최근 보관본 — 주말·공휴일을 건너뛰기 위해 최대 7일 거슬러 본다 */
async function latestHistBefore(env: Env, market: BriefMarket, today: string): Promise<StoredBrief | null> {
  const base = new Date(`${today}T00:00:00Z`);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(base.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const hit = await loadHist(env, market, d);
    if (hit) return hit;
  }
  return null;
}

/* ── 나레이션(TTS) 문장 ─────────────────────────────── */

/** 표시용 문자열의 기호를 소리 내어 읽을 수 있게 정리 */
function speakable(s: string): string {
  return s
    .replace(/([+-]?\d+(?:\.\d+)?)%/g, (_, n: string) => `${n.replace("+", "플러스 ").replace("-", "마이너스 ")}퍼센트`)
    .replace(/([+-])(\d+(?:\.\d+)?)/g, (_, sign: string, n: string) => `${sign === "+" ? "플러스" : "마이너스"} ${n}`)
    .replace(/\s*→\s*/g, ", 그 결과 ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/\s*—\s*/g, ". ")
    .replace(/[()]/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildSpeech(marketKo: string, v: OntoVerdict, picks: { name: string; sector: string | null; score: number; reasons: string[] }[]) {
  const regimeKo = v.regime.label.replace("—", ",");
  return {
    opening: `오늘 ${marketKo} 시장은 ${speakable(regimeKo)}입니다.`,
    causal: v.causal.map((c) => speakable(c) + "."),
    picks: picks.map((p, i) => {
      const why = p.reasons[0] ? ` ${speakable(p.reasons[0])}.` : "";
      return `${["첫", "두", "세", "네", "다섯"][i] ?? i + 1} 번째는 ${p.name}입니다. ${p.sector ?? "미분류"} 업종이고 종합 점수는 ${p.score.toFixed(2)}점입니다.${why}`;
    }),
    closing: "이 내용은 자동매매 시스템의 기록 공개이며 투자 자문이나 권유가 아닙니다. 투자 판단과 책임은 여러분 각자에게 있습니다.",
  };
}

/* ── 시장 브리프 ─────────────────────────────────────── */

async function marketBrief(env: Env, market: BriefMarket, today: string) {
  const [verdict, lab, prevStored] = await Promise.all([
    getVerdict(env, market),
    labOverview(env, market).catch(() => null),
    latestHistBefore(env, market, today),
  ]);
  const cur = market === "US" ? "$" : "원";

  /* 어제 채점 — 현재가는 레이더의 최신 스캔값으로 조회 */
  let previous: {
    date: string;
    basisNote: string;
    picks: { code: string; name: string; recPrice: number; nowPrice: number | null; changePct: number | null }[];
    hitRate: number | null;
    avgChangePct: number | null;
  } | null = null;
  const priceByCode = new Map<string, number>();
  /** 이 시장 레이더 행의 가장 최신 갱신 시각 — 외부 구독자의 신선도 검사용 */
  let dataAsOf = 0;
  try {
    const top = (await radarTop(env, 600, "desc", undefined, market === "US" ? "US" : undefined)) as {
      items?: { code: string; market: string; price: number; updatedAt?: number }[];
    };
    for (const it of top.items ?? []) {
      if ((market === "US") === (it.market === "US")) {
        priceByCode.set(it.code, it.price);
        if (it.updatedAt && it.updatedAt > dataAsOf) dataAsOf = it.updatedAt;
      }
    }
  } catch { /* 채점만 빈다 */ }
  if (prevStored?.picks.length) {
    const graded = prevStored.picks.map((p) => {
      const now = priceByCode.get(p.code) ?? null;
      const chg = now && p.price ? round(((now - p.price) / p.price) * 100, 2) : null;
      return { code: p.code, name: p.name, recPrice: p.price, nowPrice: now, changePct: chg };
    });
    const scored = graded.filter((g) => g.changePct !== null) as { changePct: number }[];
    previous = {
      date: prevStored.date,
      basisNote: "기준가 = 추천일 마지막 브리프 생성 시점의 시세 · 비교가 = 이번 응답 생성 시점의 레이더 시세",
      picks: graded,
      hitRate: scored.length ? round(scored.filter((g) => g.changePct > 0).length / scored.length, 2) : null,
      avgChangePct: scored.length ? round(scored.reduce((s, g) => s + g.changePct, 0) / scored.length, 2) : null,
    };
  }

  /* 신규/연속일 — 이력 체인을 한 번만 걸어(최대 5거래일) 연속 등장일을 센다 */
  const prevCodes = new Set(prevStored?.picks.map((p) => p.code) ?? []);
  const chain: StoredBrief[] = [];
  if (prevStored) {
    chain.push(prevStored);
    let cursor = prevStored.date;
    for (let i = 0; i < 4; i++) {
      const st = await latestHistBefore(env, market, cursor);
      if (!st) break;
      chain.push(st);
      cursor = st.date;
    }
  }
  const daysIn = (code: string): number => {
    let days = 1;
    for (const st of chain) {
      if (!st.picks.some((p) => p.code === code)) break;
      days++;
    }
    return days;
  };

  const rawPicks = verdict.stocks.recommend.slice(0, 5);

  /* 절대 가격 레벨(MA·52주·ATR·거래량·지지저항) — 2026-09-04 유튜브 파이프라인 요청 1번.
   * "상대 수익률만 있고 얼마에 사서 얼마에 손절인지 말할 수 없다"는 지적에 답한다.
   * 1y 일봉을 픽마다 다시 받는다(레이더 스캔은 점수만 저장하고 원본 시계열을 안 남기므로) —
   * 픽이 5개뿐이라 사이클 예산에 영향 없다. 심볼을 못 찾거나 데이터가 모자라면 조용히 null. */
  const tz = market === "US" ? "America/New_York" : "Asia/Seoul";
  const symbolToCode = new Map<string, string>();
  for (const s of rawPicks) {
    const sym = CODE_TO_SYMBOL.get(s.code);
    if (sym) symbolToCode.set(sym, s.code);
  }
  const levelSeries = await getManySeries(env, [...symbolToCode.keys()], "1y").catch(() => []);
  const levelsByCode = new Map<string, Levels | null>();
  for (const sr of levelSeries) {
    const code = symbolToCode.get(sr.symbol);
    if (code) levelsByCode.set(code, computeLevels(sr, rawPicks.find((s) => s.code === code)?.price ?? sr.price, tz));
  }
  const ontoHorizon = holdDaysFor(market, "onto");

  const picks = rawPicks.map((s) => ({
    code: s.code,
    /** 미국은 거래소 티커 그대로, 한국은 6자리 종목코드라 별도 티커 없음 */
    ticker: market === "US" ? s.code : null,
    /** 야후 심볼 — 한국은 거래소에 따라 .KS/.KQ 가 갈려 코드만으로는 추측할 수 없다
     * (예: 네오셈 253590 → 253590.KQ). 소비자가 규칙으로 만들지 않게 값으로 준다. */
    symbol: symbolFor(s.code),
    name: s.name,
    sector: s.sector,
    score: s.score,
    price: s.price,
    priceLabel: `${s.price.toLocaleString("ko-KR")}${cur}`,
    changePct: s.changePct,
    reason: s.reason,
    reasons: s.reasons ?? [],
    isNew: prevStored ? !prevCodes.has(s.code) : true,
    daysInList: prevStored && prevCodes.has(s.code) ? daysIn(s.code) : 1,
    levels: levelsByCode.get(s.code) ?? null,
    horizonDays: ontoHorizon?.days ?? null,
    horizonNote: ontoHorizon?.note ?? null,
  }));
  const todayCodes = new Set(picks.map((p) => p.code));
  const dropped = (prevStored?.picks ?? [])
    .filter((p) => !todayCodes.has(p.code))
    .map((p) => ({
      code: p.code,
      name: p.name,
      reason: priceByCode.has(p.code) ? "오늘 점수가 상위권에서 밀렸습니다" : "오늘 후보 집계에 없습니다",
    }));

  /* ── 서사(narrative) — "종목이 매일 비슷해 보인다"는 질문에 답하는 블록(2026-08-20).
   * 온톨로지는 국면 추종이라 국면이 유지되는 동안 같은 섹터 클러스터가 이어지는 게
   * 정상이다. 그 지속/전환을 숫자와 문장으로 만들어 영상이 그대로 말할 수 있게 한다. */
  type FullLite = { regime?: { tone?: string; label?: string }; sectors?: { recommend?: { sector: string }[] } };
  const prevFull = prevStored?.full as FullLite | undefined;
  const tone = verdict.regime.tone;
  let streakDays = 1;
  for (const st of [prevStored, ...chain.slice(1)]) {
    if (!st || (st.full as FullLite | undefined)?.regime?.tone !== tone) break;
    streakDays++;
  }
  const todaySectors = verdict.sectors.recommend.map((s) => s.sector);
  const prevSectors = prevFull?.sectors?.recommend?.map((s) => s.sector) ?? [];
  const kept = todaySectors.filter((s) => prevSectors.includes(s));
  const entered = todaySectors.filter((s) => !prevSectors.includes(s));
  const left = prevSectors.filter((s) => !todaySectors.includes(s));
  const turnover = picks.filter((p) => p.isNew).length;
  const regimeChanged = Boolean(prevFull?.regime?.tone && prevFull.regime.tone !== tone);
  const summaryKo = regimeChanged
    ? `국면이 바뀌었습니다 — ${prevFull?.regime?.label ?? "이전 국면"}에서 ${verdict.regime.label}(으)로. ${left.length ? `${left.join("·")} 섹터에서 나와 ` : ""}${entered.length ? `${entered.join("·")} 섹터로 이동했습니다. ` : ""}온톨로지가 갈아타는 날입니다.`
    : `${verdict.regime.label.split("—")[0].trim()}이 ${streakDays}일째 이어지고 있습니다. 추천 섹터는 ${kept.length ? `${kept.join("·")}이(가) 유지되고` : "오늘 새로 구성되고"}${entered.length ? ` ${entered.join("·")}이(가) 새로 들어왔으며` : ""}, 종목은 5개 중 ${turnover}개가 교체됐습니다${turnover > 0 && kept.length ? " — 같은 순풍 안에서 더 좋은 종목으로 로테이션한 것입니다" : ""}.`;
  const narrative = {
    regime: {
      tone,
      label: verdict.regime.label,
      streakDays,
      changed: regimeChanged,
      prevLabel: prevFull?.regime?.label ?? null,
    },
    sectors: { kept, entered, left },
    pickTurnover: { changed: turnover, total: picks.length },
    summaryKo,
    meaningKo:
      "온톨로지는 국면 추종 전략입니다 — 국면이 유지되는 동안 같은 섹터 클러스터가 이어지는 것은 정상이며(평균 보유 6~13일), 이 방식의 가치는 국면이 꺾이는 날 남보다 먼저 갈아타는 데 있습니다.",
  };

  /* 엔진별 추천 + 엔진 합의 — brief 와 scene.svg?view=consensus 가 같은 모듈을 쓴다
   * (2026-09-04 요청 3번: 따로 계산하면 화면·영상이 다른 숫자를 말할 위험). */
  const headlineCodes = new Set(picks.map((p) => p.code));
  const { engines: enginesOut, agreement } = buildEnginesAndAgreement(market, lab?.strategies, headlineCodes, cur);

  /* 이 계산에 쓴 시세의 실제 거래일 — 레이더 최신 갱신 시각의 로컬 날짜. 갱신 기록이 없으면
   * (레이더 조회 실패) 오늘 날짜로 보수적으로 대체한다. */
  const dataSessionDate = dataAsOf ? localDate(dataAsOf, tz) : today;

  const brief = {
    market,
    marketKo: market === "US" ? "미국" : "한국",
    basis: basisOf(market),
    basisNote: BASIS_NOTE,
    /* 신선도(2026-08-20, 유튜브 파이프라인 요청) — 발행 전 검사용.
     * generatedAt: 이 응답을 계산한 시각(항상 지금).
     * dataAsOf: 이 시장 레이더 시세의 가장 최신 갱신 시각 — 시세 수집이 멈췄으면 여기가 늙는다.
     * 권장 검사: date === 오늘(KST) && basis !== "intraday" && dataAgeMinutes < 720.
     * basis 는 시장별로 다르게 나온다 — 한국 저녁(17시 이후) 기준 KR=post_close,
     * US=prev_close(그날 아침 5시 KST 마감분이 최신이므로 이것이 정상이다). */
    generatedAt: Date.now(),
    dataAsOf: dataAsOf || null,
    dataAgeMinutes: dataAsOf ? Math.round((Date.now() - dataAsOf) / 60000) : null,
    regime: verdict.regime,
    causal: verdict.causal,
    sectors: {
      recommend: verdict.sectors.recommend.map((s) => ({ sector: s.sector, score: s.score, reasons: s.reasons })),
      avoid: verdict.sectors.avoid.map((s) => ({ sector: s.sector, score: s.score, reasons: s.reasons })),
      /** 추천·회피 상위 4개 밖도 포함한 전체 — 오늘 픽의 업종이 추천 리스트에 없을 때도
       * scene.svg?view=sector: 로 그릴 수 있다(2026-09-04 요청 6번). */
      all: verdict.sectors.all.map((s) => ({ sector: s.sector, score: s.score, reasons: s.reasons })),
    },
    picks,
    avoid: verdict.stocks.avoid.slice(0, 3).map((s) => ({
      code: s.code,
      ticker: market === "US" ? s.code : null,
      symbol: symbolFor(s.code),
      name: s.name,
      sector: s.sector,
      score: s.score,
      price: s.price,
      priceLabel: `${s.price.toLocaleString("ko-KR")}${cur}`,
      changePct: s.changePct,
      reason: s.reason,
      reasons: s.reasons ?? [],
    })),
    dropped,
    previous,
    narrative,
    speech: {
      ...buildSpeech(market === "US" ? "미국" : "한국", verdict, picks),
      /** 국면 지속/전환 서사 — 오프닝 바로 뒤에 읽기 좋은 완성 문장 */
      narrative: summaryKo,
    },
    /** 엔진(분석 방식)별 추천 — 온톨로지·수급·차트·융합 각각 "무엇을 보고 골랐는지"
     * 근거 문장 포함. 전략실 리그와 같은 점수 함수라 화면·리그와 어긋나지 않는다.
     * (2026-08-19 유튜브 파이프라인 요청: 엔진별 추천 + 근거) */
    engines: enginesOut,
    league: lab
      ? {
          currency: lab.currency,
          strategies: lab.strategies.map((st) => ({
            nameKo: st.nameKo, tagKo: st.tagKo, live: st.liveNow, pnlPct: st.pnlPct, equity: st.equity,
          })),
        }
      : null,
    agreement,
    /* 이 브리프가 가리키는 실제 거래일 (2026-09-04 유튜브 파이프라인 요청 4번).
     * 발행이 마감 뒤라 "다음 거래일" 기준으로 제목·나레이션을 만드는데, 공휴일을 모르면
     * 잘못된 날짜를 박게 된다. dataSessionDate 는 이 계산에 쓴 시세의 실제 거래일(레이더
     * 최신 갱신 시각의 로컬 날짜), targetSession 은 그 다음 거래일(주말+공휴일 skip)이다. */
    dataSessionDate,
    targetSession: nextTradingDay(dataSessionDate, market),
    /** basis 파생 — "장중이라 낡았을 수 있다"를 문자열 파싱 없이 바로 판별하게 (2026-09-04 요청 5번) */
    sessionClosed: basisOf(market) !== "intraday",
    /** 밀리초 epoch */
    dataAsOf: verdict.dataAsOf,
    generatedAt: verdict.generatedAt,
  };

  /* 오늘 이력 저장 — 같은 날짜는 마지막 계산으로 덮어쓴다(내일 채점의 기준가가 된다) */
  await env.CACHE.put(
    histKey(market, today),
    JSON.stringify({
      date: today, market, generatedAt: Date.now(), basis: brief.basis,
      picks: rawPicks.map((s) => ({ code: s.code, name: s.name, sector: s.sector, score: s.score, price: s.price })),
      full: brief,
    } satisfies StoredBrief),
    { expirationTtl: HIST_TTL },
  ).catch(() => undefined);

  return brief;
}

/* ── 공개 응답 ───────────────────────────────────────── */

export async function dailyBrief(env: Env, market: "KR" | "US" | "both", date?: string) {
  const today = kstDate();

  /* 과거 날짜 — 보관본을 그대로 돌려주고, 없으면 404 로 명확히 거절한다
   * (조용히 오늘 것을 주는 게 가장 위험하다 — 2026-08-19 파이프라인 보고 2-2) */
  if (date && date !== today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "bad_date", { hint: "date=YYYY-MM-DD" });
    const markets: BriefMarket[] = market === "both" ? ["KR", "US"] : [market];
    const stored = await Promise.all(markets.map((m) => loadHist(env, m, date)));
    const briefs = stored.filter(Boolean).map((s) => s!.full);
    if (!briefs.length) throw new ApiError(404, "no_archive_for_date", { date, hint: "보관은 최초 발행일부터 45일" });
    return { version: 1, date, archived: true, site: "https://stockontology.cc", briefs, disclaimer: DISCLAIMER };
  }

  const markets: BriefMarket[] = market === "both" ? ["KR", "US"] : [market];
  const briefs = await Promise.all(markets.map((m) => marketBrief(env, m, today)));
  const bt = backtestResults() as { measuredAt?: string } | null;
  const kr = briefs.find((b) => b.market === "KR");
  const titleBase = kr ?? briefs[0];
  return {
    version: 1,
    date: today,
    archived: false,
    site: "https://stockontology.cc",
    video: {
      titleSuggestion: `${today} 온톨로지 데일리 — ${titleBase.regime.label}${titleBase.picks[0] ? ` · ${titleBase.picks[0].name} 외 ${Math.max(0, titleBase.picks.length - 1)}종목` : ""}`,
      hashtags: ["#온톨로지", "#주식자동매매", "#AI투자", "#매크로", ...(titleBase.picks.slice(0, 3).map((p) => `#${p.name.replace(/\s+/g, "")}`))],
    },
    images: markets.map((m) => ({
      market: m,
      cardSvg: `https://stockontology.cc/api/brief-card.svg?market=${m}`,
      cardSvgShorts: `https://stockontology.cc/api/brief-card.svg?market=${m}&ratio=9:16`,
    })),
    briefs,
    /** 백테스트 재측정은 매 거래일 16:40 KST — 오전 응답에서는 전 거래일 값인 게 정상 */
    backtestMeasuredAt: bt?.measuredAt ?? null,
    disclaimer: DISCLAIMER,
  };
}

/* ── 온톨로지 경로 카드 (SVG) ─────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtSigned = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
/** 래스터화 환경에 Pretendard 가 없어도 같은 글꼴로 굳게 웹폰트를 명시한다 */
const FONT_IMPORT = `<style>@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');</style>`;
const FONT = `font-family="'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif"`;
const GOLD = "#d9a441", UP = "#e0524a", DOWN = "#3b82f6", FG = "#e2e8f0", DIM = "#94a3b8";

export async function briefCardSvg(env: Env, market: BriefMarket, ratio: "16:9" | "9:16" | "1:1" = "16:9"): Promise<string> {
  if (ratio === "1:1") return cardSquare(env, market);
  const v = await getVerdict(env, market);
  return ratio === "9:16" ? cardPortrait(v, market) : cardLandscape(v, market);
}

/** 1080×1080 — 인스타그램·스레드용. 온톨로지 단독이 아니라 "여러 방식이 동시에 지목한
 * 종목"을 주인공으로 삼는다(2026-09-04 요청 8번: "동시 지목 상위 3종목 + 엔진 이름"). */
async function cardSquare(env: Env, market: BriefMarket): Promise<string> {
  const [v, lab] = await Promise.all([getVerdict(env, market), labOverview(env, market).catch(() => null)]);
  const cur = market === "US" ? "$" : "원";
  const headlineCodes = new Set(v.stocks.recommend.slice(0, 5).map((s) => s.code));
  const { agreement } = buildEnginesAndAgreement(market, lab?.strategies, headlineCodes, cur);
  const top3 = agreement.slice(0, 3);
  const toneColor = v.regime.tone === "risk-on" ? UP : v.regime.tone === "risk-off" ? DOWN : GOLD;
  const mkLabel = market === "US" ? "미국" : "한국";
  const W = 1080, H = 1080;

  let body = "";
  let y = 420;
  if (top3.length) {
    body += `<text x="64" y="${y}" fill="${GOLD}" font-size="26" font-weight="900" ${FONT}>오늘 여러 방식이 동시에 지목한 종목</text>`;
    y += 50;
    top3.forEach((r, i) => {
      const h = 118;
      body += `<rect x="52" y="${y - 30}" width="${W - 104}" height="${h}" rx="16" fill="rgba(15,23,42,0.9)" stroke="${GOLD}" stroke-width="1.5"/>`;
      body += `<text x="72" y="${y + 4}" fill="${FG}" font-size="30" font-weight="900" ${FONT}>${i + 1}. ${esc(r.name)}</text>`;
      body += `<text x="72" y="${y + 34}" fill="${DIM}" font-size="17" ${FONT}>${esc(r.sector ?? "미분류")} · 독립 ${r.independentCount}개 방식 일치</text>`;
      const names = r.engines.map((e) => e.nameKo + (e.derived ? "(파생)" : "")).join(" · ");
      body += `<text x="72" y="${y + 62}" fill="${GOLD}" font-size="16" font-weight="700" ${FONT}>${esc(names).slice(0, 60)}</text>`;
      y += h + 22;
    });
  } else {
    body += `<text x="64" y="${y}" fill="${DIM}" font-size="24" ${FONT}>오늘은 두 방식 이상이 겹친 종목이 없습니다</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${FONT_IMPORT}
  <defs><radialGradient id="bg" cx="50%" cy="18%" r="120%"><stop offset="0%" stop-color="#0b1530"/><stop offset="100%" stop-color="#040814"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="64" y="90" fill="${GOLD}" font-size="19" font-weight="900" letter-spacing="3" ${FONT}>STOCKONTOLOGY</text>
  <text x="64" y="126" fill="${DIM}" font-size="16" ${FONT}>온톨로지 데일리 · ${kstDate()}</text>
  <text x="64" y="184" fill="${FG}" font-size="38" font-weight="900" ${FONT}>${mkLabel} 시장</text>
  <text x="64" y="228" fill="${toneColor}" font-size="26" font-weight="900" ${FONT}>${esc(v.regime.label)}</text>
  ${body}
  <text x="64" y="${H - 60}" fill="${DIM}" font-size="13" ${FONT}>${esc(DISCLAIMER.slice(0, 40))}…</text>
  <text x="64" y="${H - 36}" fill="${GOLD}" font-size="15" font-weight="700" ${FONT}>stockontology.cc</text>
</svg>`;
}

function cardHeader(v: OntoVerdict, market: BriefMarket, W: number, titleSize: number) {
  const toneColor = v.regime.tone === "risk-on" ? UP : v.regime.tone === "risk-off" ? DOWN : GOLD;
  const mkLabel = market === "US" ? "미국 시장" : "한국 시장";
  return { toneColor, mkLabel, dateStr: kstDate(), W, titleSize };
}

function cardLandscape(v: OntoVerdict, market: BriefMarket): string {
  const W = 1280, H = 720;
  const { toneColor, mkLabel, dateStr } = cardHeader(v, market, W, 42);
  const sectors = v.sectors.recommend.slice(0, 2);
  const stocksBySector = (sec: string) => v.stocks.recommend.filter((s) => s.sector === sec).slice(0, 2);
  const macroIds = [...new Set(sectors.flatMap((s) => s.edges.slice(0, 3).map((e) => e.macroId)))].slice(0, 4);

  const colX = { macro: 60, sector: 380, ticker: 700 } as const;
  const nodeW = 250, nodeH = 54;
  const diaTop = 190, diaH = 430;
  const yFor = (i: number, n: number) => diaTop + diaH / 2 - (n * (nodeH + 26)) / 2 + i * (nodeH + 26) + nodeH / 2;
  const macroY = new Map(macroIds.map((id, i) => [id, yFor(i, macroIds.length)]));
  const sectorY = new Map(sectors.map((s, i) => [s.sector, yFor(i, sectors.length)]));
  const tickers = sectors.flatMap((s) => stocksBySector(s.sector));
  const tickerY = new Map(tickers.map((x, i) => [x.code, yFor(i, Math.max(1, tickers.length))]));

  let edges = "";
  for (const s of sectors) {
    const sy = sectorY.get(s.sector)!;
    for (const e of s.edges.slice(0, 3)) {
      const my = macroY.get(e.macroId);
      if (my === undefined) continue;
      const cls = e.contribution >= 0 ? UP : DOWN;
      const w = 1.5 + Math.min(6, Math.abs(e.contribution) * 9);
      const x1 = colX.macro + nodeW, x2 = colX.sector;
      edges += `<path d="M${x1},${my} C${x1 + 60},${my} ${x2 - 60},${sy} ${x2},${sy}" fill="none" stroke="${cls}" stroke-width="${w.toFixed(1)}" opacity="0.75"/>`;
      edges += `<text x="${(x1 + x2) / 2}" y="${(my + sy) / 2 - 8}" text-anchor="middle" fill="${cls}" font-size="15" font-weight="700" ${FONT}>${fmtSigned(e.contribution)}</text>`;
    }
    for (const t of stocksBySector(s.sector)) {
      const ty = tickerY.get(t.code)!;
      const x1 = colX.sector + nodeW, x2 = colX.ticker;
      edges += `<path d="M${x1},${sy} C${x1 + 50},${sy} ${x2 - 50},${ty} ${x2},${ty}" fill="none" stroke="${GOLD}" stroke-width="2.5" opacity="0.7"/>`;
    }
  }

  const node = (x: number, y: number, line1: string, line2: string, accent: string) =>
    `<g><rect x="${x}" y="${y - nodeH / 2}" width="${nodeW}" height="${nodeH}" rx="10" fill="rgba(15,23,42,0.9)" stroke="${accent}" stroke-width="1.5"/>` +
    `<text x="${x + 14}" y="${y - 6}" fill="${FG}" font-size="19" font-weight="800" ${FONT}>${esc(line1)}</text>` +
    `<text x="${x + 14}" y="${y + 17}" fill="${DIM}" font-size="14" ${FONT}>${esc(line2)}</text></g>`;

  let nodes = "";
  for (const [id, y] of macroY) nodes += node(colX.macro, y, MACRO_KO[id] ?? id, "거시요인", DIM);
  for (const s of sectors) nodes += node(colX.sector, sectorY.get(s.sector)!, s.sector, `섹터 점수 ${fmtSigned(s.score)}`, GOLD);
  for (const t of tickers) nodes += node(colX.ticker, tickerY.get(t.code)!, t.name, `점수 ${fmtSigned(t.score)} · ${fmtSigned(t.changePct, 1)}%`, t.score >= 0 ? UP : DOWN);

  const listX = 990;
  const rows = v.stocks.recommend.slice(0, 5);
  const avoid = v.stocks.avoid.slice(0, 2);
  let list = `<text x="${listX}" y="${diaTop + 6}" fill="${GOLD}" font-size="18" font-weight="900" ${FONT}>오늘의 온톨로지 추천</text>`;
  rows.forEach((s, i) => {
    const y = diaTop + 46 + i * 58;
    list += `<text x="${listX}" y="${y}" fill="${FG}" font-size="21" font-weight="800" ${FONT}>${i + 1}. ${esc(s.name)}</text>`;
    list += `<text x="${listX}" y="${y + 22}" fill="${DIM}" font-size="14" ${FONT}>${esc(s.sector ?? "")} · 점수 ${fmtSigned(s.score)} · ${fmtSigned(s.changePct, 1)}%</text>`;
  });
  if (avoid.length) {
    const y0 = diaTop + 46 + rows.length * 58 + 14;
    list += `<text x="${listX}" y="${y0}" fill="${DOWN}" font-size="16" font-weight="900" ${FONT}>피할 곳</text>`;
    avoid.forEach((s, i) => {
      list += `<text x="${listX}" y="${y0 + 26 + i * 24}" fill="${DIM}" font-size="15" ${FONT}>${esc(s.name)} (${fmtSigned(s.score)})</text>`;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${FONT_IMPORT}
  <defs><radialGradient id="bg" cx="50%" cy="30%" r="90%"><stop offset="0%" stop-color="#0b1530"/><stop offset="100%" stop-color="#040814"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="60" y="72" fill="${GOLD}" font-size="22" font-weight="900" letter-spacing="4" ${FONT}>STOCKONTOLOGY · 온톨로지 데일리</text>
  <text x="60" y="126" fill="${FG}" font-size="42" font-weight="900" ${FONT}>${dateStr} ${mkLabel} — <tspan fill="${toneColor}">${esc(v.regime.label)}</tspan></text>
  <text x="60" y="158" fill="${DIM}" font-size="17" ${FONT}>${esc((v.causal[0] ?? v.regime.lines[0] ?? "").slice(0, 78))}</text>
  <text x="${colX.macro}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${FONT}>거시요인</text>
  <text x="${colX.sector}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${FONT}>섹터</text>
  <text x="${colX.ticker}" y="${diaTop + 2}" fill="${DIM}" font-size="14" letter-spacing="2" ${FONT}>종목</text>
  ${edges}${nodes}${list}
  <text x="60" y="${H - 36}" fill="${DIM}" font-size="13" ${FONT}>${esc(DISCLAIMER.slice(0, 90))}…</text>
  <text x="${W - 60}" y="${H - 36}" text-anchor="end" fill="${GOLD}" font-size="15" font-weight="700" ${FONT}>stockontology.cc</text>
</svg>`;
}

/** 쇼츠용 9:16 (720×1280) — 다이어그램 대신 국면 + 추천 리스트를 크게 */
function cardPortrait(v: OntoVerdict, market: BriefMarket): string {
  const W = 720, H = 1280;
  const { toneColor, mkLabel, dateStr } = cardHeader(v, market, W, 40);
  const rows = v.stocks.recommend.slice(0, 5);
  const avoid = v.stocks.avoid.slice(0, 2);
  const secs = v.sectors.recommend.slice(0, 2);

  let body = "";
  let y = 330;
  body += `<text x="56" y="${y}" fill="${GOLD}" font-size="24" font-weight="900" ${FONT}>순풍 섹터</text>`;
  y += 44;
  for (const s of secs) {
    body += `<text x="56" y="${y}" fill="${FG}" font-size="28" font-weight="800" ${FONT}>${esc(s.sector)} <tspan fill="${UP}" font-size="22">${fmtSigned(s.score)}</tspan></text>`;
    y += 34;
    if (s.reasons[0]) { body += `<text x="56" y="${y}" fill="${DIM}" font-size="17" ${FONT}>${esc(s.reasons[0].slice(0, 42))}</text>`; y += 40; }
  }
  y += 20;
  body += `<text x="56" y="${y}" fill="${GOLD}" font-size="24" font-weight="900" ${FONT}>오늘의 온톨로지 추천</text>`;
  y += 50;
  rows.forEach((s, i) => {
    body += `<rect x="44" y="${y - 34}" width="${W - 88}" height="82" rx="14" fill="rgba(15,23,42,0.9)" stroke="${s.score >= 0 ? UP : DOWN}" stroke-width="1.5"/>`;
    body += `<text x="64" y="${y}" fill="${FG}" font-size="30" font-weight="900" ${FONT}>${i + 1}. ${esc(s.name)}</text>`;
    body += `<text x="64" y="${y + 30}" fill="${DIM}" font-size="18" ${FONT}>${esc(s.sector ?? "미분류")} · 점수 ${fmtSigned(s.score)} · ${fmtSigned(s.changePct, 1)}%</text>`;
    y += 100;
  });
  if (avoid.length) {
    y += 8;
    body += `<text x="56" y="${y}" fill="${DOWN}" font-size="22" font-weight="900" ${FONT}>피할 곳</text>`;
    y += 34;
    for (const s of avoid) {
      body += `<text x="56" y="${y}" fill="${DIM}" font-size="19" ${FONT}>${esc(s.name)} (${fmtSigned(s.score)})</text>`;
      y += 30;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${FONT_IMPORT}
  <defs><radialGradient id="bg" cx="50%" cy="20%" r="110%"><stop offset="0%" stop-color="#0b1530"/><stop offset="100%" stop-color="#040814"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="56" y="96" fill="${GOLD}" font-size="20" font-weight="900" letter-spacing="3" ${FONT}>STOCKONTOLOGY</text>
  <text x="56" y="132" fill="${DIM}" font-size="18" ${FONT}>온톨로지 데일리 · ${dateStr}</text>
  <text x="56" y="198" fill="${FG}" font-size="40" font-weight="900" ${FONT}>${mkLabel}</text>
  <text x="56" y="252" fill="${toneColor}" font-size="30" font-weight="900" ${FONT}>${esc(v.regime.label)}</text>
  ${body}
  <text x="56" y="${H - 60}" fill="${DIM}" font-size="14" ${FONT}>${esc(DISCLAIMER.slice(0, 46))}…</text>
  <text x="56" y="${H - 36}" fill="${GOLD}" font-size="16" font-weight="700" ${FONT}>stockontology.cc</text>
</svg>`;
}
