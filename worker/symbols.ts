/**
 * 종목코드 ↔ 야후 심볼·한글명 — 한 곳에서만 만든다.
 *
 * 한국은 코드와 심볼이 다르고(005930 → 005930.KS, 253590 → 253590.KQ) 거래소에 따라
 * 접미사가 갈린다(.KS/.KQ). 파이프라인이 이걸 규칙으로 추측하면 코스닥 종목에서 틀린다 —
 * 그래서 daily-brief 응답에 `symbol` 을 직접 실어 보내고(2026-09-05 유튜브 요청), 그 값을
 * 만드는 맵을 brief.ts·scenes.ts·agreement.ts 가 공유한다(각자 만들면 갈라진다).
 *
 * 야후 meta.shortName 은 한국 종목도 영문("SamsungElec")으로 오므로 화면·응답의 이름은
 * 시드의 한글명을 쓴다.
 */
import krSeed from "../shared/radar-universe.json";
import usSeed from "../shared/us-universe.json";

type Seed = { code: string; symbol: string; name: string };

export const CODE_TO_SYMBOL = new Map<string, string>([
  ...(krSeed as Seed[]).map((t): [string, string] => [t.code, t.symbol]),
  ...(usSeed as Seed[]).map((t): [string, string] => [t.code, t.symbol]),
]);

export const CODE_TO_NAME = new Map<string, string>([
  ...(krSeed as Seed[]).map((t): [string, string] => [t.code, t.name]),
  ...(usSeed as Seed[]).map((t): [string, string] => [t.code, t.name]),
]);

/** 시드에 없는 코드면 null — 규칙으로 추측해 만들지 않는다(.KS/.KQ 를 틀리면 조용히 다른 종목이 된다) */
export const symbolFor = (code: string): string | null => CODE_TO_SYMBOL.get(code) ?? null;

/**
 * 6자리 코드 · 티커 · 야후 심볼 아무거나 받아 (code, symbol) 로 정규화한다.
 *
 * 시드 밖 종목도 차트·전략은 심볼만 있으면 계산되므로 여기서 막지 않는다 — 막으면
 * "ING 는 글은 나오는데 그림은 안 나온다" 같은 반쪽 응답이 된다(2026-09-09 실측).
 * 다만 접미사 없는 6자리 코드만은 null: .KS/.KQ 를 찍으면 절반이 빈 차트가 된다.
 */
export function resolveTicker(input: string): { code: string; symbol: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const up = raw.toUpperCase();
  const bySymbol = [...CODE_TO_SYMBOL.entries()].find(([, s]) => s.toUpperCase() === up);
  if (bySymbol) return { code: bySymbol[0], symbol: bySymbol[1] };
  const sym = symbolFor(up);
  if (sym) return { code: up, symbol: sym };
  if (/^[A-Z][A-Z.-]*$/.test(up) || /^\d{6}\.[A-Z]{2}$/.test(up)) {
    return { code: up.split(".")[0], symbol: up };
  }
  return null;
}

/** 심볼 접미사로 시장을 정한다 — 호출자가 넘긴 market 파라미터보다 이쪽이 항상 맞다 */
export const marketOfSymbol = (symbol: string): "KR" | "US" =>
  symbol.endsWith(".KS") || symbol.endsWith(".KQ") ? "KR" : "US";
