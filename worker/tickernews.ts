/**
 * 종목별 뉴스 수집기.
 *
 * 국가 피드("대한민국 금융 뉴스") 하나로는 시장 일반 기사만 잡히고
 * 종목 단위 호재·악재("삼성전자 수주", "S-Oil 목표주가 상향")는 거의 걸리지 않는다.
 * 그래서 20종목을 각각 검색한다.
 *
 * 제약: Workers 무료 플랜은 요청당 외부 fetch 50회 한도가 있고, 전략 계산이 이미
 * 시세 28건을 쓴다. 그래서 한 번에 전부 긁지 않고 **호출당 가장 오래된 4종목만 갱신**한다.
 * 크론이 15분마다 돌므로 약 75분 안에 20종목이 모두 45분 이내 신선도로 수렴한다.
 * 결과는 KV 한 키에 모아 두어 전략 계산은 fetch 없이 읽기만 한다.
 */
import type { Env } from "./env";
import { UNIVERSE } from "../shared/ontology";

/** 종목 전용 검색은 코어 종목만 돈다. 확장층은 섹터 뉴스·거시 보정으로 커버한다(사용자 결정: 전 종목 검색은 과함). */
const CORE = UNIVERSE.filter((t) => t.core);
import { bingNews, type NewsItem } from "./news";
import { scoreText } from "./sentiment";
import { round } from "./util";

export interface TickerNewsEntry {
  code: string;
  fetchedAt: number;
  /** 별칭이 실제로 걸린 기사 수 */
  hits: number;
  positive: number;
  negative: number;
  /** -1 ~ 1 감성 점수 (hits 0이면 0) */
  score: number;
  /** 근거 표시용 상위 헤드라인 */
  headlines: { title: string; url: string; source: string; publishedAt: number }[];
  error?: string;
}

export type TickerNewsMap = Record<string, TickerNewsEntry>;

const KEY = "tnews:v1";
/** 이보다 오래된 항목부터 갱신 대상이 된다 */
const FRESH_MS = 45 * 60 * 1000;
/** 한 번의 갱신에서 검색할 종목 수 (fetch 예산) */
const DEFAULT_BUDGET = 4;

/**
 * 아이솔레이트 메모리 사본. KV 쓰기 한도가 소진돼 put 이 실패하는 날에도
 * 같은 아이솔레이트 안에서는 수집분이 누적되게 한다(KV와 병합, 최신 우선).
 */
let memMap: TickerNewsMap = {};
let lastPutError: string | null = null;

export async function readTickerNews(env: Env): Promise<TickerNewsMap> {
  const raw = (await env.CACHE.get(KEY, "json").catch(() => null)) as TickerNewsMap | null;
  const merged: TickerNewsMap = { ...(raw ?? {}) };
  for (const [code, e] of Object.entries(memMap)) {
    if (!merged[code] || merged[code].fetchedAt < e.fetchedAt) merged[code] = e;
  }
  return merged;
}

/** 이보다 오래된 기사는 점수에서 제외 — 이미 가격에 반영된 정보다 */
const MAX_ARTICLE_AGE_MS = 48 * 3600 * 1000;

/** 종목 별칭이 제목/요약에 실제로 들어간 "최근" 기사만 남긴다 (검색이 느슨하게 잡아오는 것 방지) */
function matchArticles(items: NewsItem[], aliases: string[]): NewsItem[] {
  const needles = aliases.map((a) => a.toLowerCase());
  const now = Date.now();
  return items.filter((it) => {
    // 날짜를 모르는(publishedAt=0) 기사는 남긴다 — 검색 결과 대부분은 최신이고, 다 버리면 표본이 사라진다
    if (it.publishedAt > 0 && now - it.publishedAt > MAX_ARTICLE_AGE_MS) return false;
    const hay = `${it.title} ${it.summary}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
}

async function fetchOne(ticker: (typeof UNIVERSE)[number]): Promise<TickerNewsEntry> {
  // "주가"를 붙여 기업 일반 기사(채용·CSR)가 아니라 시장 관련 기사로 좁힌다
  const items = await bingNews(`${ticker.nameKo} 주가`, "ko", "KR", "ko");
  const matched = matchArticles(items, [ticker.nameKo, ...ticker.aliases]).slice(0, 12);
  const sent = scoreText(matched.map((it) => `${it.title} ${it.summary}`));
  return {
    code: ticker.code,
    fetchedAt: Date.now(),
    hits: matched.length,
    positive: sent.positive,
    negative: sent.negative,
    score: round(sent.score, 3),
    headlines: matched.slice(0, 3).map((it) => ({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
    })),
  };
}

/**
 * 가장 오래된 종목부터 budget 개만 갱신한다. 실패한 종목은 이전 값을 유지하되
 * fetchedAt 을 절반만 당겨 다음 사이클에 자연히 재시도되게 한다.
 */
export async function refreshTickerNews(env: Env, budget = DEFAULT_BUDGET): Promise<TickerNewsMap> {
  const map = await readTickerNews(env);
  const now = Date.now();

  const stale = CORE
    .map((t) => ({ t, at: map[t.code]?.fetchedAt ?? 0 }))
    .filter((x) => now - x.at > FRESH_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, budget);
  if (!stale.length) return map;

  const results = await Promise.allSettled(stale.map((x) => fetchOne(x.t)));
  results.forEach((r, i) => {
    const t = stale[i].t;
    if (r.status === "fulfilled") {
      map[t.code] = r.value;
    } else {
      const prev = map[t.code];
      map[t.code] = {
        ...(prev ?? { code: t.code, hits: 0, positive: 0, negative: 0, score: 0, headlines: [] }),
        fetchedAt: now - FRESH_MS / 2,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    }
  });

  memMap = map;
  try {
    await env.CACHE.put(KEY, JSON.stringify(map), { expirationTtl: 86400 });
    lastPutError = null;
  } catch (err) {
    // 무료 플랜 KV 쓰기 한도(1,000/일) 소진 시 여기로 온다. 메모리 사본으로 버틴다.
    lastPutError = String(err);
  }
  return map;
}

/** 진단용 (읽기 전용 — fetch 도 put 도 하지 않는다) */
export async function tickerNewsStatus(env: Env) {
  const map = await readTickerNews(env);
  const now = Date.now();
  return {
    collected: Object.keys(map).length,
    universe: CORE.length,
    lastPutError,
    entries: CORE.map((t) => {
      const e = map[t.code];
      return {
        code: t.code,
        nameKo: t.nameKo,
        hits: e?.hits ?? null,
        score: e?.score ?? null,
        ageMin: e ? Math.round((now - e.fetchedAt) / 60000) : null,
        error: e?.error ?? null,
        top: e?.headlines?.[0]?.title ?? null,
      };
    }),
  };
}
