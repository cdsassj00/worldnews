import type { Env } from "./env";
import { MARKETS } from "../shared/markets";
import { cached, decodeEntities, fetchText, stripTags } from "./util";

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  /** ko = 한국어 기사, local = 현지어/영어 기사 */
  lang: "ko" | "local";
  summary: string;
}

/** Google News RSS 한 편 파싱 */
function parseRss(xml: string, lang: NewsItem["lang"]): NewsItem[] {
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
      source: source || "Google News",
      publishedAt: date ? Date.parse(date) || 0 : 0,
      lang,
      summary: stripTags(pick("description")).slice(0, 240),
    });
  }
  return items;
}

function rssUrl(query: string, hl: string, gl: string, ceid: string): string {
  const q = encodeURIComponent(`${query} when:7d`);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

async function loadNews(cc: string, nameKo: string): Promise<NewsItem[]> {
  const m = MARKETS[cc];
  const feeds: { url: string; lang: NewsItem["lang"] }[] = [
    // 한국어 독자용: 해당 국가 경제/증시 한국어 기사
    { url: rssUrl(`${nameKo} 증시 OR ${nameKo} 경제 OR ${nameKo} 금리`, "ko", "KR", "KR:ko"), lang: "ko" },
  ];
  if (m) {
    feeds.push({ url: rssUrl(m.news.query, m.news.hl, m.news.gl, m.news.ceid), lang: "local" });
  } else {
    feeds.push({ url: rssUrl(`${cc} economy OR stock market`, "en", "US", "US:en"), lang: "local" });
  }

  const results = await Promise.allSettled(feeds.map((f) => fetchText(f.url, undefined, 7000)));
  const items: NewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...parseRss(r.value, feeds[i].lang));
  });

  // 제목 기준 중복 제거 후 최신순
  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    const key = it.title.replace(/\s+/g, "").slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => b.publishedAt - a.publishedAt);
  return deduped.slice(0, 24);
}

export async function getNews(env: Env, cc: string, nameKo: string) {
  return cached(env, `news:${cc}`, 600, () => loadNews(cc, nameKo));
}

/** 글로벌 헤드라인(국가 선택 전 기본 화면) */
export async function getGlobalNews(env: Env) {
  return cached(env, "news:_global", 600, async () => {
    const feeds = [
      { url: rssUrl("세계 증시 OR 글로벌 경제 OR 연준 OR 유가", "ko", "KR", "KR:ko"), lang: "ko" as const },
      { url: rssUrl("global markets OR world economy OR Federal Reserve", "en", "US", "US:en"), lang: "local" as const },
    ];
    const res = await Promise.allSettled(feeds.map((f) => fetchText(f.url, undefined, 7000)));
    const items: NewsItem[] = [];
    res.forEach((r, i) => {
      if (r.status === "fulfilled") items.push(...parseRss(r.value, feeds[i].lang));
    });
    items.sort((a, b) => b.publishedAt - a.publishedAt);
    return items.slice(0, 20);
  });
}
