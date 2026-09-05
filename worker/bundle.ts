/**
 * 종목 한 편 묶음 — 영상·게시물 하나를 만드는 데 필요한 재료를 한 번에 준다.
 * (2026-09-05 콘텐츠 파이프라인 요청 2·3번: daily-brief + /api/ta + scene 을 각자 부르고
 *  코드에서 합치는 중이라, 온디맨드 발행이 번거롭다)
 *
 * 여기서 새로 계산하는 것은 없다 — 이미 있는 계산(레이더 온톨로지 점수·수급 행·차트 13종·
 * 지지저항)을 모아 **문장으로 엮기만** 한다. 새 숫자를 만들면 사이트와 영상이 다른 말을 하게 된다.
 */
import type { Env } from "./env";
import { taCached } from "./ta";
import { getManySeries } from "./quotes";
import { computeLevels } from "./levels";
import { radarFind } from "./radarscan";
import { quantRank } from "./quant";
import { sessionStateOf } from "./feed";
import { CODE_TO_NAME, CODE_TO_SYMBOL, symbolFor } from "./symbols";
import { ApiError, round } from "./util";

const SITE = "https://stockontology.cc";

/** 6자리 코드/티커/야후 심볼 아무거나 받아 (code, symbol) 로 정규화한다 */
function resolve(input: string): { code: string; symbol: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const bySymbol = [...CODE_TO_SYMBOL.entries()].find(([, s]) => s.toUpperCase() === raw.toUpperCase());
  if (bySymbol) return { code: bySymbol[0], symbol: bySymbol[1] };
  const sym = symbolFor(raw.toUpperCase());
  if (sym) return { code: raw.toUpperCase(), symbol: sym };
  // 시드 밖 종목도 온디맨드로 다룰 수 있어야 한다 — 심볼을 그대로 쓰고 코드는 심볼에서 뽑는다
  if (/^[A-Z.]+$/i.test(raw) || /^\d{6}\.[A-Z]{2}$/i.test(raw)) return { code: raw.split(".")[0].toUpperCase(), symbol: raw.toUpperCase() };
  return null;
}


/**
 * 근거 문장을 쇼츠 낭독용 한 줄로 바꾼다.
 * "유가(WTI) +9.38% → 정유화학 민감도 +0.65" → "유가가 9.38% 올랐습니다"
 * 규칙에 안 맞으면 원문을 그대로 쓴다 — 억지로 다듬다 뜻이 바뀌는 것보다 낫다.
 */
function hookFromMacro(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/^(.+?)\s*([+-])(\d+(?:\.\d+)?)%/);
  if (!m) return text;
  const factor = m[1].replace(/\(.*?\)/g, "").trim();
  return `${factor}가 ${m[3]}% ${m[2] === "+" ? "올랐습니다" : "내렸습니다"}`;
}

export async function stockBundle(env: Env, input: string) {
  const r = resolve(input);
  if (!r) throw new ApiError(404, "stock_not_found", { input });
  const { code, symbol } = r;
  const market: "KR" | "US" = symbol.endsWith(".KS") || symbol.endsWith(".KQ") ? "KR" : "US";
  const cur = market === "US" ? "$" : "원";

  const [rep, seriesArr, found, rank] = await Promise.all([
    taCached(env, symbol),
    getManySeries(env, [symbol], "1y").catch(() => []),
    radarFind(env, code).catch(() => null) as Promise<{ items?: { code: string; name: string; sector: string | null; score: number; onto: number; reasons: { kind: string; text: string }[] }[] } | null>,
    quantRank(env, "flow", 400, market).catch(() => null),
  ]);

  const series = seriesArr[0];
  const levels = series ? computeLevels(series, rep.price, market === "US" ? "America/New_York" : "Asia/Seoul") : null;
  const onto = found?.items?.find((x) => x.code === code) ?? null;
  const flow = rank?.rows.find((x) => x.code === code) ?? null;
  const name = CODE_TO_NAME.get(code) ?? onto?.name ?? rep.name;
  const session = sessionStateOf(market);

  /* 왜 지금 이 종목인가 — 세 갈래를 각각 한 문장으로. 근거가 없는 축은 null 이다
   * (없는 축을 "특이사항 없음"으로 채우면 있지도 않은 분석을 한 것처럼 보인다). */
  const macroKo = onto?.reasons?.find((x) => x.kind === "ontology")?.text ?? null;
  const flowKo = flow
    ? `거래대금이 평소의 ${flow.raw.surge.toFixed(2)}배이고 자금흐름(MFI) ${flow.raw.mfi.toFixed(0)}, 매집강도 ${flow.raw.accum.toFixed(2)}입니다 — 수급 점수 ${flow.score.toFixed(2)}.`
    : null;
  const chartKo = `${rep.consensus.text}. ${rep.trend.alignment}.`;

  const shortsNumbers = [
    onto ? `온톨로지 ${onto.onto >= 0 ? "+" : ""}${onto.onto.toFixed(2)}` : null,
    flow ? `거래대금 ${flow.raw.surge.toFixed(2)}배` : null,
    `${rep.changePct >= 0 ? "+" : ""}${rep.changePct.toFixed(1)}%`,
    rep.plan.targets[0] ? `목표 ${rep.plan.targets[0].price.toLocaleString("ko-KR")}${cur}` : null,
  ].filter(Boolean) as string[];

  return {
    code, symbol, name,
    sector: onto?.sector ?? flow?.sector ?? null,
    market,
    price: rep.price,
    changePct: rep.changePct,
    priceLabel: `${rep.price.toLocaleString("ko-KR")}${cur}`,
    asOf: rep.asOf,
    ...session,

    /** 이 종목을 지금 다룰 이유 — 세 갈래(거시·수급·차트) */
    why: { macroKo, flowKo, chartKo },

    /** 온톨로지 점수와 인과 경로 근거(레이더와 같은 값) */
    ontology: onto ? { score: onto.score, onto: onto.onto, reasons: onto.reasons.map((x) => x.text) } : null,
    /** 수급 점수와 원시값 */
    flow: flow ? { score: flow.score, parts: flow.parts, raw: flow.raw, reasons: flow.reasons.map((x) => x.text) } : null,

    levels,
    /** /api/ta 의 매매 플랜 — 진입·손절·목표·손익비, 전부 절대 가격 */
    plan: rep.plan,
    /** 창시자가 있는 전략 13종 판정 (author 포함) */
    strategies: rep.strategies,
    consensus: rep.consensus,
    trend: rep.trend,
    indicators: rep.indicators,
    /** 차트 그릴 원본 — 필요 없으면 무시해도 된다(응답이 커지는 유일한 부분) */
    chart: { close: rep.chart.close, ma20: rep.chart.ma20, ma60: rep.chart.ma60, volume: rep.chart.volume },

    /** 30~45초 세로 영상 한 편 분량 — 긴 영상 재료를 잘라 쓰면 문장이 어색해진다는 요청 3번 */
    shortsBrief: {
      hookKo: hookFromMacro(macroKo) ?? `${name}, ${rep.consensus.text}`,
      bodyKo: [
        onto?.sector ? `${name}은 ${onto.sector} 업종입니다.` : `${name} 이야기입니다.`,
        flow ? `거래대금이 평소의 ${flow.raw.surge.toFixed(1)}배로 늘었습니다.` : null,
        `차트 전략 13종 중 매수가 ${rep.consensus.buy}개, 매도가 ${rep.consensus.sell}개입니다.`,
        rep.plan.targets[0]
          ? `지금 ${rep.price.toLocaleString("ko-KR")}${cur}, 위쪽 저항은 ${rep.plan.targets[0].price.toLocaleString("ko-KR")}${cur}입니다.`
          : null,
      ].filter(Boolean) as string[],
      closeKo: rep.plan.bias === "long"
        ? `손절 기준은 ${rep.plan.stop.price.toLocaleString("ko-KR")}${cur}, 손익비 ${rep.plan.rr.toFixed(1)}대 1로 봅니다.`
        : `다만 아직 ${rep.plan.biasKo} 구간입니다 — 종가가 ${rep.plan.stop.price.toLocaleString("ko-KR")}${cur} 아래면 이 계획은 무효입니다.`,
      numbers: shortsNumbers,
    },

    /** 영상에 바로 쓸 화면 주소 — 시드 밖 종목은 scene 이 코드→심볼 변환을 못 해 null */
    views: CODE_TO_SYMBOL.has(code)
      ? {
        chart: `${SITE}/api/scene.svg?market=${market}&view=chart:${code}`,
        strategies: `${SITE}/api/scene.svg?market=${market}&view=strategies:${code}`,
        stock: `${SITE}/api/scene.svg?market=${market}&view=stock:${code}`,
        overview: `${SITE}/api/scene.svg?market=${market}&view=overview`,
      }
      : null,

    disclaimerKo: "공개 데이터 기반 자동 분석이며 투자 자문·권유가 아닙니다. 투자 판단과 책임은 이용자 본인에게 있습니다.",
    generatedAt: Date.now(),
    /** 이 값이 몇 분 지나면 못 쓰는지 — 장중이면 짧다 */
    staleAfterMinutes: session.staleAfterMinutes,
    _debug: { ontoFound: Boolean(onto), flowFound: Boolean(flow), levelsFound: Boolean(levels), atr14: levels?.atr14 ?? null, roundedPrice: round(rep.price, 2) },
  };
}
