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
const SITE = "https://worldnews.sjshin.workers.dev";

interface RssDay {
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

export async function rssXml(env: Env): Promise<Response> {
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

  const items = days
    .map(
      (d) => `  <item>
    <title>${esc(d.title)}</title>
    <link>${SITE}/?d=${d.date}</link>
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
