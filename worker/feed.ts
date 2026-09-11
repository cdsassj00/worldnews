/**
 * 발행 후보 피드 — "지금 무슨 일이 일어났는가"를 종목 단위 이벤트로 낸다.
 * (2026-09-05 콘텐츠 파이프라인 요청 1번: 505종목을 분석하는데 하루 한 편만 나간다)
 *
 * 설계에서 중요한 두 가지:
 *
 * ① **이벤트는 로그에 쌓는다.** 호출할 때마다 델타를 새로 계산해 돌려주면, 두 번째 호출은
 *    빈 목록이 된다(이미 스냅샷이 갱신됐으므로). 그러면 `since` 로 폴링한다는 전제가 깨진다.
 *    그래서 델타를 구해 **로그에 append** 하고, 응답은 로그를 since 로 잘라 낸다.
 *
 * ② **"어제와 오늘의 차이"만 이벤트다.** 값이 크다고 이벤트가 아니라, 값이 **바뀌었을 때**만
 *    이벤트다(요청서의 whyNowKo 가 핵심이라는 지적). 그래서 직전 스냅샷을 KV 에 두고 비교한다.
 *
 * 넣지 않는 것: 미래 예측, 목표 수익률. 이벤트 문장은 전부 "무엇이 어떻게 바뀌었다"의 실측 서술이다.
 */
import type { Env } from "./env";
import { cached, round } from "./util";
import { quantRank } from "./quant";
import { dailyBrief } from "./brief";
import { taCached } from "./ta";
import { symbolFor } from "./symbols";
import { marketPhase } from "./autotrade";
import { usMarketOpen } from "./quant";

export type SessionState = "pre" | "open" | "closed";
export type FeedKind =
  | "new_agreement" | "agreement_lost" | "breakout" | "volume_surge"
  | "support_test" | "plan_upgrade" | "plan_downgrade" | "regime_shift" | "streak";

export interface FeedEvent {
  id: string;
  at: number;
  code: string | null;
  symbol: string | null;
  name: string;
  sector: string | null;
  kind: FeedKind;
  headlineKo: string;
  /** 왜 하필 지금인가 — 직전 상태와의 차이를 문장으로 */
  whyNowKo: string;
  /** 0~1 — 그 신호 자체의 세기(거래대금 몇 배인지 등) */
  strength: number;
  /** 0~1 — 무엇부터 다룰지 정하는 값. strength × 이벤트 종류 가중치.
   * 거래대금 급증은 매일 여러 건 나오지만 "서로 다른 분석이 처음 겹쳤다"는 드물다 —
   * 세기만으로 줄 세우면 흔한 이벤트가 목록을 도배한다. */
  priority: number;
  price: number | null;
  changePct: number | null;
}

interface Snapshot {
  at: number;
  regimeTone: string;
  regimeLabel: string;
  byCode: Record<string, {
    independentCount: number;
    engineIds: string[];
    surge: number;
    rangePos: number;
    appearances: number;
    planBias?: string;
    price: number;
  }>;
}

/** 이벤트 종류별 희소성·콘텐츠 가치 가중치 — 우선순위 계산에만 쓴다 */
const KIND_WEIGHT: Record<FeedKind, number> = {
  regime_shift: 1, new_agreement: 0.95, plan_upgrade: 0.9, breakout: 0.85,
  agreement_lost: 0.8, support_test: 0.8, streak: 0.75, plan_downgrade: 0.7, volume_surge: 0.6,
};

const SNAP_KEY = (m: string) => `feed:snap:v1:${m}`;
const LOG_KEY = (m: string) => `feed:log:v1:${m}`;
const LOG_KEEP = 200;
const LOG_TTL = 3 * 86_400;

/** 장 상태 — 장중 발행에 "마감 기준"이라고 말하지 않게 하려는 표기(요청 4번) */
export function sessionStateOf(market: "KR" | "US"): { sessionState: SessionState; staleAfterMinutes: number; sessionKo: string } {
  if (market === "KR") {
    const ph = marketPhase();
    if (ph.open) return { sessionState: "open", staleAfterMinutes: 15, sessionKo: "정규장 진행 중 — 숫자가 계속 바뀝니다" };
    const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const pre = hhmm < "09:00";
    return pre
      ? { sessionState: "pre", staleAfterMinutes: 60, sessionKo: "장 시작 전 — 직전 거래일 종가 기준입니다" }
      : { sessionState: "closed", staleAfterMinutes: 720, sessionKo: "장 마감 — 오늘 종가 기준입니다" };
  }
  if (usMarketOpen()) return { sessionState: "open", staleAfterMinutes: 15, sessionKo: "미국 정규장 진행 중 — 숫자가 계속 바뀝니다" };
  const hhmmNY = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const pre = hhmmNY < "09:30";
  return pre
    ? { sessionState: "pre", staleAfterMinutes: 60, sessionKo: "미국 장 시작 전 — 직전 거래일 종가 기준입니다" }
    : { sessionState: "closed", staleAfterMinutes: 720, sessionKo: "미국 장 마감 — 마감 종가 기준입니다" };
}

const ymd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");

/* 이 모듈이 daily-brief 응답에서 실제로 읽는 부분만 선언한다 */
interface BriefLite {
  regime: { tone: string; label: string };
  agreement: { code: string; name: string; sector: string | null; independentCount: number; engines: { id: string; nameKo: string; derived: boolean }[] }[];
  swing: { picks: { code: string; name: string; sector: string | null; appearances: number; price: number;
    nearestSupport: number | null; nearestSupportLabel: string | null; toSupportPct: number | null }[] };
  picks: { code: string; name: string; sector: string | null; price: number; changePct: number }[];
}

async function loadSnap(env: Env, market: string): Promise<Snapshot | null> {
  return (await env.CACHE.get(SNAP_KEY(market), "json").catch(() => null)) as Snapshot | null;
}
async function loadLog(env: Env, market: string): Promise<FeedEvent[]> {
  return ((await env.CACHE.get(LOG_KEY(market), "json").catch(() => null)) as FeedEvent[] | null) ?? [];
}

/**
 * 델타를 계산해 새 이벤트를 로그에 append 한다. 반환은 이번에 새로 생긴 것만.
 * 첫 실행(스냅샷 없음)에는 **이벤트를 만들지 않는다** — 비교 대상이 없는데 "새로 겹쳤다"고
 * 말하면 거짓이다. 스냅샷만 남기고 다음 호출부터 진짜 변화를 낸다.
 */
export async function refreshFeed(env: Env, market: "KR" | "US"): Promise<{ added: number; total: number }> {
  const [briefRes, rank] = await Promise.all([
    dailyBrief(env, market) as Promise<{ briefs: BriefLite[] }>,
    quantRank(env, "flow", 400, market).catch(() => null),
  ]);
  const brief = briefRes.briefs[0];
  if (!brief) return { added: 0, total: 0 };

  const rows = new Map((rank?.rows ?? []).map((r) => [r.code, r]));
  const agreeByCode = new Map(brief.agreement.map((a) => [a.code, a]));
  const swingByCode = new Map(brief.swing.picks.map((p) => [p.code, p]));
  const priceOf = (code: string) => rows.get(code)?.price ?? swingByCode.get(code)?.price ?? brief.picks.find((p) => p.code === code)?.price ?? null;
  const changeOf = (code: string) => rows.get(code)?.changePct ?? brief.picks.find((p) => p.code === code)?.changePct ?? null;
  const nameOf = (code: string) => agreeByCode.get(code)?.name ?? swingByCode.get(code)?.name ?? rows.get(code)?.name ?? brief.picks.find((p) => p.code === code)?.name ?? code;
  const sectorOf = (code: string) => agreeByCode.get(code)?.sector ?? swingByCode.get(code)?.sector ?? rows.get(code)?.sector ?? null;

  /* 매매 플랜 판정 변화는 종목당 시세 호출이 필요해, 오늘 이미 주목한 소수만 본다
   * (스윙 목록 + 합의 상위) — 505종목에 전부 돌리면 크론 예산이 남아나지 않는다. */
  const watch = [...new Set([...brief.swing.picks.map((p) => p.code), ...brief.agreement.slice(0, 3).map((a) => a.code)])].slice(0, 6);
  const planBias = new Map<string, string>();
  await Promise.all(watch.map(async (code) => {
    const sym = symbolFor(code);
    if (!sym) return;
    const rep = await taCached(env, sym).catch(() => null);
    if (rep?.plan?.bias) planBias.set(code, rep.plan.bias);
  }));

  const snap = await loadSnap(env, market);
  const now = Date.now();
  const day = ymd();
  const events: FeedEvent[] = [];
  const push = (e: Omit<FeedEvent, "id" | "at" | "symbol" | "name" | "sector"> & { code: string | null; name?: string }) => {
    const code = e.code;
    events.push({
      id: `evt_${day}_${code ?? market}_${e.kind}`,
      at: now,
      code,
      symbol: code ? symbolFor(code) : null,
      name: e.name ?? (code ? nameOf(code) : market === "US" ? "미국 시장" : "한국 시장"),
      sector: code ? sectorOf(code) : null,
      kind: e.kind,
      headlineKo: e.headlineKo,
      whyNowKo: e.whyNowKo,
      strength: round(Math.max(0, Math.min(1, e.strength)), 2),
      priority: round(Math.max(0, Math.min(1, e.strength)) * KIND_WEIGHT[e.kind], 3),
      price: e.price,
      changePct: e.changePct,
    });
  };

  // 새 스냅샷은 이벤트 유무와 무관하게 만든다
  const byCode: Snapshot["byCode"] = {};
  const codes = new Set<string>([...agreeByCode.keys(), ...swingByCode.keys(), ...rows.keys()]);
  for (const code of codes) {
    const r = rows.get(code);
    byCode[code] = {
      independentCount: agreeByCode.get(code)?.independentCount ?? 0,
      engineIds: (agreeByCode.get(code)?.engines ?? []).filter((e) => !e.derived).map((e) => e.id),
      surge: r?.raw?.surge ?? 0,
      rangePos: r?.raw?.rangePos ?? 0,
      appearances: swingByCode.get(code)?.appearances ?? 0,
      planBias: planBias.get(code),
      price: r?.price ?? priceOf(code) ?? 0,
    };
  }
  const nextSnap: Snapshot = { at: now, regimeTone: brief.regime.tone, regimeLabel: brief.regime.label, byCode };

  if (snap) {
    const prev = (code: string) => snap.byCode[code];

    // ① 국면 전환 — 시장 단위
    if (snap.regimeTone && snap.regimeTone !== brief.regime.tone) {
      push({
        code: null, kind: "regime_shift", strength: 0.95, price: null, changePct: null,
        headlineKo: `국면이 바뀌었습니다 — ${brief.regime.label}`,
        whyNowKo: `직전 확인 때는 "${snap.regimeLabel}"이었는데 지금은 "${brief.regime.label}"입니다. 추천 섹터가 함께 바뀌는 날입니다.`,
      });
    }

    for (const code of codes) {
      const p = prev(code);
      const cur = byCode[code];
      const price = priceOf(code), chg = changeOf(code);
      const ag = agreeByCode.get(code);

      // ② 합의 형성 / 해제
      if (cur.independentCount >= 2 && (!p || p.independentCount < 2)) {
        const added = ag?.engines.filter((e) => !e.derived && !(p?.engineIds ?? []).includes(e.id)).map((e) => e.nameKo) ?? [];
        const kept = (p?.engineIds ?? []).length ? ag?.engines.filter((e) => (p?.engineIds ?? []).includes(e.id)).map((e) => e.nameKo) ?? [] : [];
        const surgeKo = cur.surge >= 1.5 ? ` 거래대금이 평소의 ${cur.surge.toFixed(2)}배로 늘어난 시점입니다.` : "";
        push({
          code, kind: "new_agreement", strength: 0.6 + 0.1 * cur.independentCount, price, changePct: chg,
          headlineKo: `근거가 다른 분석 ${cur.independentCount}개가 같은 종목을 지목했습니다`,
          whyNowKo: kept.length
            ? `직전까지는 ${kept.join("·")}만 들고 있었는데, ${added.join("·")}이(가) 새로 들어왔습니다.${surgeKo}`
            : `${(ag?.engines ?? []).filter((e) => !e.derived).map((e) => e.nameKo).join("·")}이(가) 오늘 같은 종목에서 만났습니다.${surgeKo}`,
        });
      } else if (p && p.independentCount >= 2 && cur.independentCount < 2) {
        const left = p.engineIds.filter((id) => !cur.engineIds.includes(id));
        push({
          code, kind: "agreement_lost", strength: 0.55, price, changePct: chg,
          headlineKo: "겹쳤던 분석 중 하나가 손을 뗐습니다",
          whyNowKo: `직전까지 독립 ${p.independentCount}개가 지목하던 종목인데, 지금은 ${cur.independentCount}개만 남았습니다${left.length ? ` (빠진 쪽: ${left.join("·")})` : ""}.`,
        });
      }

      // ③ 거래대금 급증 — 값이 큰 게 아니라 "새로 넘어섰을 때"만
      if (cur.surge >= 2 && (!p || p.surge < 2)) {
        push({
          code, kind: "volume_surge", strength: Math.min(1, 0.5 + cur.surge / 6), price, changePct: chg,
          headlineKo: `거래대금이 평소의 ${cur.surge.toFixed(2)}배로 늘었습니다`,
          whyNowKo: `최근 5일 평균 거래대금이 그 이전 60일 평균의 ${cur.surge.toFixed(2)}배입니다(직전 확인 때 ${(p?.surge ?? 0).toFixed(2)}배). 돈이 갑자기 몰리기 시작한 자리입니다.`,
        });
      }

      // ④ 돌파 — 20일 박스 상단 도달
      if (cur.rangePos >= 0.98 && (!p || p.rangePos < 0.98)) {
        push({
          code, kind: "breakout", strength: 0.7 + (cur.surge >= 2 ? 0.15 : 0), price, changePct: chg,
          headlineKo: "20일 박스 상단을 뚫었습니다",
          whyNowKo: `최근 20거래일 고점 구간까지 올라왔습니다(직전 확인 때는 박스의 ${Math.round((p?.rangePos ?? 0) * 100)}% 위치).${cur.surge >= 2 ? ` 거래대금도 ${cur.surge.toFixed(2)}배로 붙었습니다.` : ""}`,
        });
      }

      // ⑤ 잔류 갱신 — 3거래일 이상부터, 늘어난 날에만
      if (cur.appearances >= 3 && (!p || cur.appearances > p.appearances)) {
        push({
          code, kind: "streak", strength: Math.min(1, 0.5 + cur.appearances * 0.08), price, changePct: chg,
          headlineKo: `${cur.appearances + 1}거래일째 추천 목록에 남아 있습니다`,
          whyNowKo: `매일 목록이 바뀌는 와중에 이 종목만 ${cur.appearances + 1}거래일째 같은 이유로 남았습니다(직전 확인 때 ${(p?.appearances ?? 0) + 1}거래일째).`,
        });
      }

      // ⑥ 매매 플랜 판정 변화
      const nb = cur.planBias, pb = p?.planBias;
      if (nb && pb && nb !== pb) {
        const rank = { avoid: 0, wait: 1, long: 2 } as Record<string, number>;
        const up = (rank[nb] ?? 1) > (rank[pb] ?? 1);
        const ko = (b: string) => (b === "long" ? "매수 검토 가능" : b === "wait" ? "대기" : "회피");
        push({
          code, kind: up ? "plan_upgrade" : "plan_downgrade", strength: up ? 0.75 : 0.6, price, changePct: chg,
          headlineKo: `매매 플랜 판정이 ${ko(pb)}에서 ${ko(nb)}(으)로 바뀌었습니다`,
          whyNowKo: `차트 전략 13종 합의와 추세·손익비를 다시 계산한 결과, 판정이 ${ko(pb)} → ${ko(nb)} 로 바뀌었습니다.`,
        });
      }

      // ⑦ 지지 시험 — 스윙 목록 종목 중 지지선 2% 이내로 내려온 것
      const sw = swingByCode.get(code);
      if (sw?.nearestSupport && sw.toSupportPct !== null && sw.toSupportPct > -2.5 && price && price > sw.nearestSupport) {
        const already = p && Math.abs((p.price - sw.nearestSupport) / sw.nearestSupport) * 100 <= 2.5;
        if (!already) {
          push({
            code, kind: "support_test", strength: 0.65, price, changePct: chg,
            headlineKo: `${sw.nearestSupportLabel ?? "지지"} ${sw.nearestSupport.toLocaleString("ko-KR")}${market === "US" ? "$" : "원"}에 다시 닿았습니다`,
            whyNowKo: `지지로 보던 자리까지 ${Math.abs(sw.toSupportPct).toFixed(1)}% 거리로 내려왔습니다. 여기서 버티는지 깨지는지가 이 종목의 다음 방향을 가릅니다.`,
          });
        }
      }
    }
  }

  // 로그에 append (같은 id 는 갱신하지 않고 버린다 — 하루 한 번만 나가는 이벤트가 되게)
  const log = await loadLog(env, market);
  const known = new Set(log.map((e) => e.id));
  const fresh = events.filter((e) => !known.has(e.id));
  const merged = [...fresh, ...log].slice(0, LOG_KEEP);

  await Promise.all([
    env.CACHE.put(SNAP_KEY(market), JSON.stringify(nextSnap), { expirationTtl: LOG_TTL }).catch(() => undefined),
    fresh.length ? env.CACHE.put(LOG_KEY(market), JSON.stringify(merged), { expirationTtl: LOG_TTL }).catch(() => undefined) : Promise.resolve(),
  ]);
  return { added: fresh.length, total: merged.length };
}

export async function getFeed(env: Env, market: "KR" | "US", opts: { since?: number; limit?: number; excludeCodes?: Set<string> }) {
  // 갱신은 3분에 한 번만 — 공개 엔드포인트라 호출마다 델타를 돌리면 예산이 샌다
  await cached(env, `feed:refresh:${market}`, 180, () => refreshFeed(env, market)).catch(() => undefined);

  const log = await loadLog(env, market);
  const { sessionState, staleAfterMinutes, sessionKo } = sessionStateOf(market);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const events = log
    .filter((e) => (opts.since ? e.at > opts.since : true))
    .filter((e) => !(e.code && opts.excludeCodes?.has(e.code)))
    .sort((a, b) => b.priority - a.priority || b.at - a.at)
    .slice(0, limit);

  return {
    market,
    asOf: Date.now(),
    sessionState,
    sessionKo,
    staleAfterMinutes,
    /** 로그 보관 기간 — 이보다 오래된 since 를 주면 그 이전 것은 이미 없다 */
    logRetentionDays: 3,
    events,
  };
}
