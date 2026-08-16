/**
 * 실시간 사이트 번역 — 구글 번역 위젯을 대체한다.
 *
 * 왜 자체 구현인가: 위젯은 외부 스크립트 로드가 느리고, 스타일이 깨지고,
 * 결론 엔진이 실시간으로 만드는 문장을 우리가 캐시할 수 없다. 여기서는
 * Workers AI 의 전용 번역 모델(M2M100)로 문장 단위 번역을 하고 KV 사전에
 * 영구 캐시한다 — 같은 문장은 두 번 번역하지 않으므로, UI 문구처럼 반복되는
 * 텍스트는 첫 방문자 이후 사실상 무료·즉시다.
 *
 * 예산 설계
 *  - KV 읽기 1회(언어별 사전 통짜) + 쓰기 최대 1회(새 번역이 있을 때만).
 *  - AI 호출은 요청당 MAX_MISSES 로 제한 — 나머지는 클라이언트가 다음
 *    배치에서 다시 물어본다(화면은 그동안 원문 유지).
 */
import type { Env } from "./env";
import { ApiError } from "./util";

const MODEL = "@cf/meta/m2m100-1.2b";
const MAX_TEXTS = 64;
const MAX_LEN = 300;
const MAX_MISSES = 16;

const TARGETS: Record<string, string> = {
  en: "english",
  ja: "japanese",
  "zh-CN": "chinese",
};

type Dict = Record<string, string>;

/* 간판 문구 손번역 — 히어로·탭·전략실 제목처럼 첫인상을 좌우하는 문장은
 * 기계번역 품질에 맡기지 않는다. 여기 없는 문장만 AI 가 처리한다. */
const STATIC_EN: Dict = {
  "세 가지 눈으로 시장을 읽고,": "Reading the market through three lenses —",
  "실제 내 돈": "with real money",
  "으로 검증한다": "on the line",
  "실계좌 공개 운용 실험 · 한국투자증권 API 직결": "A public real-account experiment · wired straight into the KIS trading API",
  "거시 인과(온톨로지) · 수급 · 차트 — 세 분석과 그 조합을 같은 규칙으로 나란히 돌려 성적을 공개하고, 가장 나은 전략이 15분마다 실계좌를 자동매매합니다.":
    "Macro causality (ontology), money flow, and charts — every combination runs under the same rules with public results, and the best strategy auto-trades a real account every 15 minutes.",
  "챔피언 전략": "Champion strategy",
  "백테스트 최근 1년": "Backtest, last 1 year",
  "실계좌 운용 엔진": "Live account engine",
  "분석 종목": "Stocks covered",
  "전략실 — 4개 전략 성적 보기": "Strategy Room — compare 4 strategies",
  "3D 온톨로지 터미널": "3D Ontology Terminal",
  "종목 차트 분석": "Stock chart analysis",
  "자동매매 현황": "Auto-trading status",
  "전략실": "Strategy Room",
  "시뮬레이션 리그": "Simulation League",
  "분석 터미널": "Analysis Terminal",
  "실시간": "LIVE",
  "온톨로지": "Ontology",
  "차트분석": "Chart Analysis",
  "수급분석": "Money Flow",
  "조합 전략": "Combo Strategy",
  "자동매매": "Auto Trading",
  "거시 인과 3D 그래프": "macro-causality 3D graph",
  "전략 13종 · 패턴 · 플랜": "13 strategies · patterns · trade plans",
  "자금흐름 · 매집 순위": "money flow · accumulation ranks",
  "세 분석을 섞으면 지금 뭐가 유리한가": "blend the three — what wins now",
  "🏆 챔피언": "🏆 Champion",
  "실계좌 운용 중": "LIVE on real account",
  "시뮬레이션": "Simulation",
  "이 전략이 지금 고른 종목": "This strategy's current picks",
  "곡선은 며칠 더 쌓이면 그려집니다": "The curve appears after a few days of data",
  "구간별": "By window",
  "온톨로지 결론": "Ontology verdict",
  "종목 검색": "Stock search",
  "매매 엔진 — 조합 선택": "Trading engine — pick a blend",
  "거래 암호": "Trade passphrase",
  "① 전략실": "① Strategy Room",
  "에서 4개 전략의 시뮬레이션·백테스트 성적을 비교하고": ": compare the four strategies' backtest & simulation records,",
  "② 종목 분석": "② Stock Analysis",
  "에서 관심 종목의 온톨로지 경로·수급·차트 판정을 확인한 뒤": ": check a stock's ontology path, money flow and chart verdicts,",
  "③ 자동매매": "③ Auto Trading",
  "에서 마음에 드는 전략을 실계좌 엔진으로 선택합니다": ": then pick your favorite strategy as the live-account engine",
  "실매매 가동": "LIVE trading",
  "관찰 모드": "Watch mode",
  "온톨로지 가동 중": "Ontology — running",
  "수급 가동 중": "Money Flow — running",
  "차트 가동 중": "Charts — running",
  "온톨로지+수급 가동 중": "Ontology+Flow — running",
  "온톨로지+차트 가동 중": "Ontology+Charts — running",
  "수급+차트 가동 중": "Flow+Charts — running",
  "삼합 가동 중": "Triple blend — running",
  "수급·차트": "Money Flow·Charts",
  "차트 거장": "Chart Masters",
  "융합": "Fusion",
  "차트 분석": "Chart Analysis",
};

const STATICS: Record<string, Dict> = { en: STATIC_EN };

export async function translateBatch(env: Env, targetRaw: string, textsRaw: unknown): Promise<{
  target: string;
  map: Dict;
  /** 이번 요청에서 시도조차 못 한 문장(미스 상한 초과) — 클라이언트가 그대로 재요청한다 */
  skipped: string[];
}> {
  const target = TARGETS[targetRaw] ? targetRaw : "";
  if (!target) throw new ApiError(400, "bad_target", { allowed: Object.keys(TARGETS) });
  if (!env.AI) throw new ApiError(503, "ai_unavailable", { hint: "Workers AI 바인딩이 없습니다." });

  const texts = (Array.isArray(textsRaw) ? textsRaw : [])
    .filter((t): t is string => typeof t === "string")
    // HTML 개행·들여쓰기로 같은 문장이 다른 키가 되지 않게 공백을 접는다
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter((t) => t.length > 0 && t.length <= MAX_LEN && /[가-힣]/.test(t))
    .slice(0, MAX_TEXTS);
  if (!texts.length) return { target, map: {}, skipped: [] };

  // 사전은 레이더와 같은 SQLite DO 에 둔다 — KV 는 읽기 60초 엣지 캐시 때문에
  // 번역 세션 중 통짜 덮어쓰기로 항목이 유실됐다(재방문도 느린 원인이었다).
  if (!env.RADAR) throw new ApiError(503, "dict_unavailable", { hint: "RadarDB 바인딩이 없습니다." });
  const db = env.RADAR.get(env.RADAR.idFromName("main"));
  const statics = STATICS[target] ?? {};

  const unique = [...new Set(texts)];
  const stored = await db.dictGet(target, unique.filter((t) => !statics[t]));
  const out: Dict = {};
  const misses: string[] = [];
  for (const t of unique) {
    const hit = statics[t] ?? stored[t];
    if (hit) out[t] = hit;
    else misses.push(t);
  }

  const todo = misses.slice(0, MAX_MISSES);
  if (todo.length) {
    const results = await Promise.allSettled(todo.map(async (t) => {
      const r = (await env.AI!.run(MODEL, {
        text: t,
        source_lang: "korean",
        target_lang: TARGETS[target],
      })) as { translated_text?: string };
      const tr = (r.translated_text ?? "").trim();
      if (!tr) throw new Error("empty");
      return [t, tr] as const;
    }));
    const fresh: Dict = {};
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const [ko, tr] = r.value;
      out[ko] = tr;
      fresh[ko] = tr;
    }
    // 행 단위 upsert — 동시 요청이 있어도 서로의 항목을 지우지 않는다
    if (Object.keys(fresh).length) await db.dictPut(target, fresh);
  }

  return { target, map: out, skipped: misses.slice(MAX_MISSES) };
}
