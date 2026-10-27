import type { Env } from "./env";
import { MARKETS, type NewsLocale } from "../shared/markets";
import { cached, decodeEntities, fetchJson, fetchText, stripTags } from "./util";

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  /** ko = 한국어 기사, local = 현지어/영어 기사 */
  lang: "ko" | "local";
  summary: string;
}

/** 어떤 제공처가 응답했는지(장애 진단용). 프론트에서 실패 사유를 보여준다. */
export interface ProviderStat {
  provider: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface NewsResult {
  items: NewsItem[];
  sources: ProviderStat[];
}

/* ── RSS 파서 ─────────────────────────────── */

function parseRss(xml: string, lang: NewsItem["lang"], defaultSource: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      if (!r) return "";
      return decodeEntities(r[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
    };
    const rawTitle = pick("title");
    if (!rawTitle) continue;
    const link = pick("link");
    let source = pick("source");
    let title = rawTitle;
    // Google News 제목은 "제목 - 매체" 형태다.
    const dash = rawTitle.lastIndexOf(" - ");
    if (!source && dash > 20) {
      source = rawTitle.slice(dash + 3);
      title = rawTitle.slice(0, dash);
    } else if (source && rawTitle.endsWith(` - ${source}`)) {
      title = rawTitle.slice(0, rawTitle.length - source.length - 3);
    }
    const date = pick("pubDate");
    items.push({
      title,
      url: link,
      source: source || defaultSource,
      publishedAt: date ? Date.parse(date) || 0 : 0,
      lang,
      summary: stripTags(pick("description")).slice(0, 240),
    });
  }
  return items;
}

/* ── 제공처 ─────────────────────────────── */

/** 1순위: Google News RSS. 현지어 로케일까지 잘 맞지만 일부 egress 에서 차단된다. */
async function googleNews(query: string, hl: string, gl: string, ceid: string, lang: NewsItem["lang"]): Promise<NewsItem[]> {
  const q = encodeURIComponent(`${query} when:7d`);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`, undefined, 7000);
  return parseRss(xml, lang, "Google News");
}

/**
 * Bing 뉴스 링크는 apiclick 리다이렉트다. url 파라미터를 풀어 원문 링크와 매체명을 얻는다.
 */
function unwrapBingItem(item: NewsItem): NewsItem {
  try {
    const u = new URL(item.url);
    const target = u.searchParams.get("url");
    if (!target) return item;
    const real = new URL(target);
    return { ...item, url: real.toString(), source: real.hostname.replace(/^www\./, "") };
  } catch {
    return item;
  }
}

/** Bing 검색은 "A OR B" 연산자에서 결과가 0이 되므로 평문 키워드로 바꾼다. */
function plainQuery(query: string): string {
  const words = query
    .split(/\s+OR\s+/i)
    .flatMap((part) => part.trim().split(/\s+/))
    .filter(Boolean);
  return [...new Set(words)].slice(0, 6).join(" ");
}

/**
 * 2순위: Bing News RSS.
 * 빈 결과가 간헐적으로 나오므로 파라미터 조합을 바꿔 한 번 더 시도한다.
 * (tickernews.ts 의 종목별 검색도 이 함수를 그대로 쓴다 — CF egress 에서 유일하게 안정적인 한국어 제공처다)
 */
export async function bingNews(query: string, hl: string, gl: string, lang: NewsItem["lang"]): Promise<NewsItem[]> {
  const q = encodeURIComponent(plainQuery(query));
  const short = hl.split("-")[0];
  const variants = [
    `https://www.bing.com/news/search?q=${q}&format=RSS&cc=${gl}&setlang=${short}&count=20`,
    `https://www.bing.com/news/search?q=${q}&format=RSS&mkt=${short}-${gl}&count=20`,
  ];
  let lastErr: unknown = null;
  for (const url of variants) {
    try {
      const items = parseRss(await fetchText(url, undefined, 7000), lang, "Bing News").map(unwrapBingItem);
      if (items.length) return items;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

interface YahooSearch {
  news?: { title?: string; link?: string; publisher?: string; providerPublishTime?: number }[];
}

/** 3순위: Yahoo Finance 검색 뉴스(영문). 시세와 같은 호스트라 시세가 되면 대체로 함께 된다. */
async function yahooNews(query: string): Promise<NewsItem[]> {
  const data = await fetchJson<YahooSearch>(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=8&enableFuzzyQuery=false`,
    undefined,
    7000,
  );
  return (data.news ?? [])
    .filter((n) => n.title && n.link && !/premium content|why read/i.test(n.title))
    .map((n) => ({
      title: String(n.title),
      url: String(n.link),
      source: n.publisher ?? "Yahoo Finance",
      publishedAt: (n.providerPublishTime ?? 0) * 1000,
      lang: "local" as const,
      summary: "",
    }));
}

/* ── 수집 파이프라인 ─────────────────────────────── */

type Attempt = { provider: string; run: () => Promise<NewsItem[]> };

/**
 * 제공처 건강 상태. 예를 들어 Google News RSS 는 Cloudflare egress 에서 응답하지 않는데,
 * 매 요청마다 7초를 버리지 않도록 실패한 제공처를 30분간 건너뛴다.
 * (실패 기준은 제공처 계열 이름 — "google", "bing", "yahoo")
 */
const HEALTH_KEY = "news:health";
const HEALTH_TTL_MS = 30 * 60 * 1000;

function family(provider: string): string {
  return provider.split(":")[0];
}

async function readHealth(env: Env): Promise<Record<string, number>> {
  const raw = (await env.CACHE.get(HEALTH_KEY, "json").catch(() => null)) as Record<string, number> | null;
  if (!raw) return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
}

/** 제공처를 단계별로 시도하다 충분한 기사가 모이면 멈춘다. */
async function collect(env: Env, stages: Attempt[][], minItems = 5): Promise<NewsResult> {
  const items: NewsItem[] = [];
  const sources: ProviderStat[] = [];
  const health = await readHealth(env);
  const healthUpdates: Record<string, number | null> = {};

  for (const stage of stages) {
    const usable = stage.filter((a) => !health[family(a.provider)]);
    if (!usable.length) {
      for (const a of stage) {
        sources.push({ provider: a.provider, ok: false, count: 0, error: "최근 실패로 건너뜀" });
      }
      continue;
    }
    const results = await Promise.allSettled(usable.map((a) => a.run()));
    results.forEach((r, i) => {
      const provider = usable[i].provider;
      if (r.status === "fulfilled") {
        items.push(...r.value);
        sources.push({ provider, ok: true, count: r.value.length });
        if (r.value.length) healthUpdates[family(provider)] = null;
      } else {
        sources.push({
          provider,
          ok: false,
          count: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        if (healthUpdates[family(provider)] !== null) healthUpdates[family(provider)] = Date.now() + HEALTH_TTL_MS;
      }
    });
    if (items.length >= minItems) break;
  }

  if (Object.keys(healthUpdates).length) {
    const next = { ...health };
    let changed = false;
    for (const [fam, until] of Object.entries(healthUpdates)) {
      if (until === null) {
        // 성공 기록은 "차단 해제"일 때만 의미가 있다. 없는 항목을 지우려고 쓰지 않는다(KV 쓰기 한도 절약).
        if (fam in next) {
          delete next[fam];
          changed = true;
        }
      } else {
        next[fam] = until;
        changed = true;
      }
    }
    if (changed) await env.CACHE.put(HEALTH_KEY, JSON.stringify(next), { expirationTtl: 3600 }).catch(() => undefined);
  }

  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    if (!it.url) return false;
    const key = it.title.replace(/\s+/g, "").slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => b.publishedAt - a.publishedAt);
  return { items: deduped.slice(0, 24), sources };
}

/**
 * 한국어 피드는 검색어가 느슨해서 무관한 기사가 섞인다.
 * 해당 국가를 가리키는 말이 본문/제목에 없으면 버린다.
 */
const KO_ALIASES: Record<string, string[]> = {
  KR: ["한국", "코스피", "코스닥", "국내 증시", "한은", "원화"],
  US: ["미국", "뉴욕", "나스닥", "연준", "S&P", "월가"],
  JP: ["일본", "닛케이", "엔화", "도쿄"],
  CN: ["중국", "상하이", "위안", "본토"],
  HK: ["홍콩", "항셍"],
  TW: ["대만", "타이완", "TSMC"],
  GB: ["영국", "런던", "FTSE"],
  DE: ["독일", "프랑크푸르트", "DAX"],
  FR: ["프랑스", "파리", "CAC"],
  IN: ["인도", "센섹스", "니프티"],
  VN: ["베트남", "호치민"],
  BR: ["브라질", "헤알", "보베스파"],
  RU: ["러시아", "루블", "모스크바"],
  TR: ["튀르키예", "터키", "리라"],
  SA: ["사우디", "아람코"],
  AE: ["아랍에미리트", "UAE", "두바이"],
  MX: ["멕시코", "페소"],
  CA: ["캐나다"],
  AU: ["호주", "오스트레일리아"],
  ID: ["인도네시아"],
  SG: ["싱가포르"],
  TH: ["태국"],
  PH: ["필리핀"],
  MY: ["말레이시아"],
  ZA: ["남아프리카", "남아공"],
};

function filterKoRelevance(items: NewsItem[], cc: string, nameKo: string): NewsItem[] {
  const needles = [nameKo, ...(KO_ALIASES[cc] ?? [])].map((n) => n.toLowerCase());
  return items.filter((it) => {
    if (it.lang !== "ko") return true;
    const hay = `${it.title} ${it.summary}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
}

function localeFor(cc: string): NewsLocale {
  const m = MARKETS[cc];
  if (m) return m.news;
  return { hl: "en", gl: "US", ceid: "US:en", query: "economy OR stock market" };
}

async function loadNews(env: Env, cc: string, nameKo: string): Promise<NewsResult> {
  const m = MARKETS[cc];
  const local = localeFor(cc);
  const koQuery = `${nameKo} 증시 OR ${nameKo} 경제 OR ${nameKo} 금리`;
  // 야후 폴백 질의: 대표 종목/지수 심볼(영문 뉴스)
  const yahooQueries = [m?.index, ...(m?.tickers.slice(0, 2).map((t) => t.symbol) ?? [])].filter(
    (v): v is string => Boolean(v),
  );

  const result = await collect(env, [
    [
      { provider: "google:ko", run: () => googleNews(koQuery, "ko", "KR", "KR:ko", "ko") },
      { provider: `google:${local.hl}`, run: () => googleNews(local.query, local.hl, local.gl, local.ceid, "local") },
    ],
    [
      { provider: "bing:ko", run: () => bingNews(koQuery, "ko", "KR", "ko") },
      { provider: `bing:${local.hl}`, run: () => bingNews(local.query, local.hl, local.gl, "local") },
    ],
    yahooQueries.map((q) => ({ provider: `yahoo:${q}`, run: () => yahooNews(q) })),
  ]);
  return { ...result, items: filterKoRelevance(result.items, cc, nameKo) };
}

export async function getNews(env: Env, cc: string, nameKo: string) {
  // 빈 결과를 10분간 붙잡고 있으면 장애가 길어지므로 짧게만 캐시한다.
  return cached(env, `news:v4:${cc}`, 600, () => loadNews(env, cc, nameKo), (r) => (r.items.length ? 600 : 60));
}

/** 글로벌 헤드라인(국가 선택 전 기본 화면) */
export async function getGlobalNews(env: Env) {
  return cached(
    env,
    "news:v3:_global",
    600,
    () =>
      collect(env, [
        [
          { provider: "google:ko", run: () => googleNews("세계 증시 OR 글로벌 경제 OR 연준 OR 유가", "ko", "KR", "KR:ko", "ko") },
          { provider: "google:en", run: () => googleNews("global markets OR world economy OR Federal Reserve", "en", "US", "US:en", "local") },
        ],
        [
          { provider: "bing:ko", run: () => bingNews("세계 증시 글로벌 경제 연준", "ko", "KR", "ko") },
          { provider: "bing:en", run: () => bingNews("global markets world economy Federal Reserve", "en", "US", "local") },
        ],
        [
          { provider: "yahoo:^GSPC", run: () => yahooNews("^GSPC") },
          { provider: "yahoo:^IXIC", run: () => yahooNews("^IXIC") },
        ],
      ]),
    (r) => (r.items.length ? 600 : 60),
  );
}
