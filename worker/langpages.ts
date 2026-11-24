/**
 * 다국어 진입 URL (/en /ja /zh) — 검색엔진용.
 *
 * 검색엔진은 "언어 토글"이 아니라 URL 단위로 색인한다. 같은 SPA 를 언어별
 * 주소로 서빙하되 <head>(title·description·og·canonical·html lang)만 그 언어로
 * 바꾸고, 본문은 로드 직후 자체 번역기가 그 언어로 켜지도록 wfg-lang 을
 * 심는다. hreflang 상호 링크는 모든 버전에 공통으로 들어간다.
 */
import type { Env } from "./env";

const SITE = "https://stockontology.cc";

export const LANG_META: Record<string, {
  htmlLang: string; ogLocale: string; wfgLang: string;
  title: string; desc: string; ogTitle: string; ogDesc: string;
}> = {
  en: {
    htmlLang: "en", ogLocale: "en_US", wfgLang: "en",
    title: "Stockontology — Real-money AI trading lab: ontology × money flow × charts",
    desc: "A public real-account experiment: macro-causality ontology, money-flow and chart strategies are backtested, raced in a live simulation league, and the champion auto-trades a real Korean brokerage account every 15 minutes.",
    ogTitle: "Stockontology — Real-money AI trading lab",
    ogDesc: "Ontology, money flow and chart strategies compete under identical rules — the champion trades a real account. All results public.",
  },
  ja: {
    htmlLang: "ja", ogLocale: "ja_JP", wfgLang: "ja",
    title: "Stockontology — オントロジー×需給×チャートのリアルマネーAI取引実験",
    desc: "マクロ因果オントロジー・需給・チャート戦略をバックテストし、リアルタイムリーグで検証。優勝戦略が実際の証券口座を15分ごとに自動売買する公開実験。",
    ogTitle: "Stockontology — リアルマネーAI取引ラボ",
    ogDesc: "3つの分析とその組み合わせが同一ルールで競い、チャンピオン戦略が実口座を運用。全成績を公開。",
  },
  zh: {
    htmlLang: "zh-Hans", ogLocale: "zh_CN", wfgLang: "zh-CN",
    title: "Stockontology — 本体论×资金流×图表的真实资金AI交易实验",
    desc: "公开的真实账户实验：宏观因果本体论、资金流与图表策略经过回测，并在实时联赛中对决，冠军策略每15分钟自动交易真实证券账户。",
    ogTitle: "Stockontology — 真实资金AI交易实验室",
    ogDesc: "三种分析及其组合在相同规则下竞争，冠军策略运作真实账户，全部成绩公开。",
  },
};

export const HREFLANG_BLOCK = [
  `<link rel="alternate" hreflang="ko" href="${SITE}/" />`,
  `<link rel="alternate" hreflang="en" href="${SITE}/en" />`,
  `<link rel="alternate" hreflang="ja" href="${SITE}/ja" />`,
  `<link rel="alternate" hreflang="zh-Hans" href="${SITE}/zh" />`,
  `<link rel="alternate" hreflang="x-default" href="${SITE}/" />`,
].join("\n    ");

/** /en /ja /zh — 루트 SPA 의 head 를 언어에 맞게 바꿔 서빙 */
export async function langIndex(env: Env, origin: string, code: string): Promise<Response> {
  const m = LANG_META[code];
  const base = await env.ASSETS.fetch(new Request(`${origin}/`));
  let html = await base.text();

  html = html
    .replace(`<html lang="ko">`, `<html lang="${m.htmlLang}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${m.title}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${m.desc}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${SITE}/${code}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${m.ogTitle}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${m.ogDesc}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${SITE}/${code}$2`)
    .replace(/(<meta property="og:locale" content=")[^"]*(")/, `$1${m.ogLocale}$2`)
    // 로드 직후 자체 번역기가 이 언어로 켜지게 한다 (main.ts 의 setupLang 이 읽는다)
    .replace(
      "</head>",
      `<script>try{localStorage.setItem("wfg-lang",${JSON.stringify(m.wfgLang)})}catch(e){}</script>\n  </head>`,
    );

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
