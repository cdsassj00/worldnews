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
