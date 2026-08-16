/**
 * RSS 피드 — 일일 시장 브리핑.
 *
 * 네이버 서치어드바이저는 사이트맵과 별도로 RSS 제출을 받는다. SPA 라 글 목록이
 * 없으므로, 온톨로지가 이미 계산하는 것(거시 신호·위험회피·점수 상위)을
 * 하루 한 편의 "브리핑"으로 굳혀 피드 아이템으로 낸다 — 남의 기사 재발행이 아니라
 * 이 사이트의 원본 분석 요약이다.
 *
 * 저장: KV `rss:v1` 에 최근 14일. 장 마감 후(KST 16시 이후) 첫 요청이 그날 항목을
 * 만든다 — KV 쓰기 하루 1회로 예산에 영향 없다.
 */
import type { Env } from "./env";
import { runStrategy } from "./strategy";
import { cached } from "./util";

const KEY = "rss:v1";
const SITE = "https://stockontology.cc";

export interface RssDay {
  date: string; // YYYY-MM-DD (KST)
  title: string;
  desc: string;
  at: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function buildToday(env: Env, today: string): Promise<RssDay | null> {
  try {
    const { data } = await cached(env, "auto:strategy", 300, () => runStrategy(env));
    const kospi = data.macro.find((m) => m.id === "KOSPI");
    const top = data.scores.slice(0, 3).map((t) => `${t.nameKo}(${t.score >= 0 ? "+" : ""}${t.score})`).join(", ");
    const weak = data.scores.slice(-3).map((t) => t.nameKo).join(", ");
    const [, m, d] = today.split("-");
    return {
      date: today,
      title: `${Number(m)}월 ${Number(d)}일 시장 브리핑 — 코스피 5일 ${kospi ? `${kospi.changePct >= 0 ? "+" : ""}${kospi.changePct}%` : "-"} · 위험회피 ${data.riskOff}`,
      desc:
        `${data.note}. ` +
        `온톨로지 점수 상위: ${top}. 약세: ${weak}. ` +
        `거시요인 12개를 섹터 민감도로 전파해 계산한 참고 자료이며 투자 자문이 아닙니다.`,
      at: Date.now(),
    };
  } catch {
    return null;
  }
}

/** 저장된 브리핑을 읽고, 필요하면 오늘 항목을 확정해 채운다 (RSS·브리핑 페이지·사이트맵 공용) */
export async function loadDays(env: Env): Promise<RssDay[]> {
  let days = (((await env.CACHE.get(KEY, "json").catch(() => null)) as RssDay[] | null) ?? []).filter(
    (d) => d && typeof d.date === "string",
  );
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = kst.toISOString().slice(0, 10);
  const hourKst = kst.getUTCHours();
  // 장 마감 후에 그날 브리핑을 확정한다. 피드가 비어 있으면 시간과 무관하게 채운다.
  if (!days.some((d) => d.date === today) && (hourKst >= 16 || days.length === 0)) {
    const item = await buildToday(env, today);
    if (item) {
      days = [item, ...days].slice(0, 14);
      await env.CACHE.put(KEY, JSON.stringify(days)).catch(() => {});
    }
  }
  return days;
}

export async function rssXml(env: Env): Promise<Response> {
  const days = await loadDays(env);

  const items = days
    .map(
      (d) => `  <item>
    <title>${esc(d.title)}</title>
    <link>${SITE}/brief/${d.date}</link>
    <guid isPermaLink="false">wfg-brief-${d.date}</guid>
    <pubDate>${new Date(d.at).toUTCString()}</pubDate>
    <description>${esc(d.desc)}</description>
  </item>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>WORLD FINANCE GLOBE — 일일 시장 브리핑</title>
  <link>${SITE}/</link>
  <description>거시요인→섹터→종목 온톨로지로 계산한 하루 한 편의 시장 브리핑. 투자 자문이 아닌 참고 자료입니다.</description>
  <language>ko</language>
  <lastBuildDate>${new Date(days[0]?.at ?? Date.now()).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=1800" },
  });
}

/* ── 동적 사이트맵 — 메인 + 쌓인 브리핑 페이지 전부 ── */

export async function sitemapXml(env: Env): Promise<Response> {
  const days = await loadDays(env);
  const alt = [
    `<xhtml:link rel="alternate" hreflang="ko" href="${SITE}/"/>`,
    `<xhtml:link rel="alternate" hreflang="en" href="${SITE}/en"/>`,
    `<xhtml:link rel="alternate" hreflang="ja" href="${SITE}/ja"/>`,
    `<xhtml:link rel="alternate" hreflang="zh-Hans" href="${SITE}/zh"/>`,
    `<xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>`,
  ].join("");
  const urls = [
    `  <url><loc>${SITE}/</loc>${alt}<changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    // 언어별 진입 URL — head(title·description·hreflang)가 그 언어로 서빙된다
    `  <url><loc>${SITE}/en</loc>${alt}<changefreq>daily</changefreq><priority>0.9</priority></url>`,
    `  <url><loc>${SITE}/ja</loc>${alt}<changefreq>daily</changefreq><priority>0.9</priority></url>`,
    `  <url><loc>${SITE}/zh</loc>${alt}<changefreq>daily</changefreq><priority>0.9</priority></url>`,
    `  <url><loc>${SITE}/brief</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...days.map(
      (d) =>
        `  <url><loc>${SITE}/brief/${d.date}</loc><lastmod>${new Date(d.at).toISOString().slice(0, 10)}</lastmod><changefreq>never</changefreq><priority>0.6</priority></url>`,
    ),
  ].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=1800" },
  });
}

/* ── 브리핑 페이지 — SPA 가 못 주는 "색인할 실제 콘텐츠" ── */

const PAGE_CSS = `body{margin:0;background:#020617;color:#e2e8f0;font-family:Pretendard,system-ui,'Malgun Gothic',sans-serif;line-height:1.7}
main{max-width:720px;margin:0 auto;padding:40px 20px}
a{color:#7dd3fc;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:24px;line-height:1.4}h2{font-size:17px;margin-top:28px}
.meta{color:#75839b;font-size:13px}
.card{background:#0f172a;border:1px solid #263349;border-radius:10px;padding:18px 20px;margin:20px 0}
.note{color:#75839b;font-size:12.5px;border-top:1px solid #263349;padding-top:14px;margin-top:28px}
ul{padding-left:20px}`;

function pageShell(title: string, desc: string, canonicalPath: string, body: string, jsonLd?: string): Response {
  const html = `<!doctype html>
<html lang="ko">
<head>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5862755346780724" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-X3FVV1GT8F"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-X3FVV1GT8F');</script>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${SITE}${canonicalPath}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${SITE}${canonicalPath}" />
<meta property="og:image" content="${SITE}/og.png" />
<meta name="color-scheme" content="dark" />
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
<style>${PAGE_CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=1800" },
  });
}

/** /brief — 브리핑 목록 */
export async function briefIndex(env: Env): Promise<Response> {
  const days = await loadDays(env);
  const list = days.map((d) => `<li><a href="/brief/${d.date}">${esc(d.title)}</a></li>`).join("\n");
  const body = `
<p class="meta"><a href="/">← WORLD FINANCE GLOBE 홈</a></p>
<h1>일일 시장 브리핑</h1>
<p>거시요인 12개(유가·환율·금리·달러인덱스·구리·나스닥 등)를 섹터 민감도로 전파하는
온톨로지가 매일 장 마감 후 계산한 시장 요약입니다. 점수·의견은 공개 지표와 뉴스로 만든
참고 자료이며 투자 자문이 아닙니다.</p>
<div class="card"><ul>${list || "<li>아직 브리핑이 없습니다.</li>"}</ul></div>
<p class="note">실시간 온톨로지 그래프·기회 탐색·세계 경제 지표는 <a href="/">메인 화면</a>에서 볼 수 있습니다.
<a href="/rss.xml">RSS 구독</a></p>`;
  return pageShell(
    "일일 시장 브리핑 — WORLD FINANCE GLOBE",
    "온톨로지가 매일 계산한 한국 증시 시장 브리핑 모음. 거시 신호, 위험회피 지수, 점수 상위·약세 종목.",
    "/brief",
    body,
  );
}

/** /brief/YYYY-MM-DD — 하루치 브리핑 (색인 대상 본문) */
export async function briefPage(env: Env, date: string): Promise<Response> {
  const days = await loadDays(env);
  const i = days.findIndex((d) => d.date === date);
  if (i < 0) {
    return new Response("브리핑이 없습니다. /brief 에서 목록을 확인하세요.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const d = days[i];
  const prev = days[i + 1];
  const next = days[i - 1];
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: d.title,
    datePublished: new Date(d.at).toISOString(),
    inLanguage: "ko",
    author: { "@type": "Organization", name: "WORLD FINANCE GLOBE" },
    publisher: { "@type": "Organization", name: "WORLD FINANCE GLOBE", url: SITE },
    mainEntityOfPage: `${SITE}/brief/${d.date}`,
  });
  const body = `
<p class="meta"><a href="/brief">← 브리핑 목록</a> · <a href="/">홈</a></p>
<h1>${esc(d.title)}</h1>
<p class="meta">${d.date} · WORLD FINANCE GLOBE 온톨로지 자동 생성</p>
<div class="card"><p>${esc(d.desc)}</p></div>
<h2>이 브리핑은 어떻게 만들어지나</h2>
<p>유가·원/달러·미 10년 금리·달러인덱스·구리·나스닥·비트코인 등 거시요인 12개의 5일 변화율과
1면 뉴스의 AI 해석을, 19개 섹터의 민감도 표(원가·수요·환율·할인율·마진·수주·위험선호·업황·안전자산
9가지 인과 유형)를 거쳐 350개 종목 점수로 전파한 결과의 하루 요약입니다.</p>
<p class="meta">${[prev ? `<a href="/brief/${prev.date}">← ${prev.date}</a>` : "", next ? `<a href="/brief/${next.date}">${next.date} →</a>` : ""].filter(Boolean).join(" · ")}</p>
<p class="note">참고 자료입니다. 투자 자문이 아니며 매매 판단과 책임은 이용자 본인에게 있습니다.</p>`;
  return pageShell(d.title, d.desc.slice(0, 155), `/brief/${d.date}`, body, jsonLd);
}
