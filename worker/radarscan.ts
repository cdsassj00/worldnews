/**
 * 레이더 스캔 — 350종목을 조각 단위로 순회하며 점수를 갱신한다.
 *
 * 한 번의 스캔은 80종목: spark 배치 4회 fetch + 거시 신호(캐시) → 점수 계산 → DO 저장.
 * 크론(15분)마다 한 조각씩 → 약 75분에 전 시장 1바퀴.
 *
 * spark 결과를 KV에 캐시하지 않는 이유: 조각은 15분에 한 번, 한 번 쓰고 버리는
 * 데이터라 캐시가 무의미하고 KV 쓰기 예산(1,000/일)만 축낸다.
 */
import type { Env } from "./env";
import seedData from "../shared/radar-universe.json";
import usSeedData from "../shared/us-universe.json";
import { MACRO, US_SENSITIVITY, type SectorId, type UniverseTicker } from "../shared/ontology";
import { liveSensitivity } from "./senslive";
import { composite, macroSignals, pctChange, priceSignal, propagate, round, shockFastBlend } from "../shared/scoring";
import { getSparkMany, loadSparkFresh } from "./quotes";
import { getMacroNewsAdjust } from "./macronews";
import type { RadarScoreRow, RadarTicker } from "./radar";

const CHUNK = 80;

function stub(env: Env) {
  if (!env.RADAR) return null;
  return env.RADAR.get(env.RADAR.idFromName("main"));
}

const ALL_SEEDS: RadarTicker[] = [...(seedData as RadarTicker[]), ...(usSeedData as RadarTicker[])];

/** 시드 버전 — 종목 수가 그대로여도 섹터 라벨 같은 속성이 바뀌면 올린다.
 * 재시드는 upsert 라 안전하고, 이 값이 바뀌면 tickers 테이블 속성이 갱신된다.
 * (2026-08-20: 코스닥 미분류 120종목 섹터 배정 — 수 불변이라 버전으로 강제) */
const SEED_VERSION = "v2-sectors-2026-08-20";

export async function radarSeedIfNeeded(env: Env): Promise<number> {
  const s = stub(env);
  if (!s) return 0;
  const seededVer = await env.CACHE.get("radar:seedver").catch(() => null);
  const status = await s.status();
  if (status.tickers >= ALL_SEEDS.length && seededVer === SEED_VERSION) return status.tickers;
  const n = await s.seed(ALL_SEEDS);
  await env.CACHE.put("radar:seedver", SEED_VERSION).catch(() => undefined);
  return n;
}

/** 거시 신호 (전략과 같은 계산·같은 캐시 경로) */
async function macroForRadar(env: Env) {
  const [spark, mnews] = await Promise.all([
    getSparkMany(env, MACRO.map((m) => m.symbol), "3mo"),
    getMacroNewsAdjust(env).catch(() => null),
  ]);
  const bySymbol = new Map(spark.map((x) => [x.symbol.toUpperCase(), { price: x.price, closes: x.closes, highs: [], lows: [], volumes: [] }]));
  /* 적응형 1일 블렌드(2026-08-20 실계좌 실손실 → 백테스트 QKA30 검증 후 적용):
   * 시장지수가 급변 국면이면 거시 신호에 1일 축을 50% 섞어 폭락·급반등이 당일
   * 점수에 반영되게 한다. 시장별 지수로 따로 판정한다(한국 ^KS11 / 미국 ^IXIC). */
  const fbKR = shockFastBlend(bySymbol.get("^KS11")?.closes ?? []);
  const fbUS = shockFastBlend(bySymbol.get("^IXIC")?.closes ?? []);
  const macro = macroSignals((sym) => bySymbol.get(sym.toUpperCase()), fbKR);
  const macroUS = fbUS === fbKR ? macro : macroSignals((sym) => bySymbol.get(sym.toUpperCase()), fbUS);
  const applyNews = (arr: typeof macro) => {
    if (!mnews?.adjustments.length) return;
    const byId = new Map(mnews.adjustments.map((a) => [a.id, a]));
    for (const m of arr) {
      const adj = byId.get(m.id);
      if (adj) {
        m.newsImpact = adj.impact;
        m.newsReason = adj.reasonKo;
      }
    }
  };
  applyNews(macro);
  if (macroUS !== macro) applyNews(macroUS);
  // 상대 강세(종목 20일 수익률 − 시장 20일 수익률) 기준선 — 시장별로 다르다.
  const mom20 = (sym: string) => {
    const b = bySymbol.get(sym);
    return b && b.closes.length >= 21 ? pctChange(b.closes, 20) : null;
  };
  return { macro, macroUS, baseline: { KR: mom20("^KS11"), US: mom20("^IXIC") } };
}

export interface RadarScanResult {
  scanned: number;
  cursor: number;
  skippedNoData: number;
}

export async function radarScanChunk(env: Env): Promise<RadarScanResult> {
  const s = stub(env);
  if (!s) return { scanned: 0, cursor: 0, skippedNoData: 0 };

  await radarSeedIfNeeded(env);
  const [{ rows, cursor }, { macro, macroUS, baseline }, { table: krTable }] = await Promise.all([
    s.nextChunk(CHUNK),
    macroForRadar(env),
    liveSensitivity(env),
  ]);
  if (!rows.length) return { scanned: 0, cursor, skippedNoData: 0 };

  // spark 는 20심볼/호출 — 80종목 = 4회. 캐시 없이 바로 부른다.
  const series = await loadSparkFresh(rows.map((r) => r.symbol), "6mo");
  const bySymbol = new Map(series.map((x) => [x.symbol.toUpperCase(), x]));

  const out: RadarScoreRow[] = [];
  let skipped = 0;
  const now = Date.now();
  for (const t of rows) {
    const sp = bySymbol.get(t.symbol.toUpperCase());
    if (!sp || sp.closes.length < 30) {
      skipped++;
      continue;
    }
    const hist = { price: sp.price, closes: sp.closes, highs: [], lows: [], volumes: [] };
    const price = priceSignal(hist);

    // 섹터가 분류된 종목만 온톨로지를 태운다. 미분류에 아무 섹터나 씌우는 것보다
    // 가격 신호만으로 순위에 올리는 쪽이 정직하다(화면에 "미분류"로 표시).
    let onto = { score: 0, reasons: [] as { kind: "ontology" | "price" | "news"; text: string; contribution: number }[], edges: [] as { macroId: string; sector: string; contribution: number }[] };
    if (t.sector) {
      const fake: UniverseTicker = { code: t.code, symbol: t.symbol, nameKo: t.name, sectors: { [t.sector as SectorId]: 1 }, aliases: [] };
      // 시장별 민감도 표 — 미국은 정적, 한국은 승격본(MLOps)이 있으면 그것
      onto = propagate(fake, t.market === "US" ? macroUS : macro, t.market === "US" ? US_SENSITIVITY : krTable);
    }

    out.push({
      code: t.code,
      name: t.name,
      sector: t.sector,
      market: t.market,
      price: sp.price,
      changePct: sp.changePct,
      score: round(composite(onto.score, price.score, 0), 3),
      onto: round(onto.score, 3),
      priceScore: round(price.score, 3),
      volatility: round(price.volatility, 2),
      relStrength: (() => {
        const base = t.market === "US" ? baseline.US : baseline.KR;
        return base !== null && sp.closes.length >= 21 ? round(pctChange(sp.closes, 20) - base, 1) : null;
      })(),
      edges: JSON.stringify(onto.edges.slice(0, 6)),
      reasons: JSON.stringify([...onto.reasons, ...price.reasons]),
      updatedAt: now,
    });
  }

  if (out.length) await s.upsertScores(out);
  return { scanned: out.length, cursor, skippedNoData: skipped };
}

export async function radarTop(env: Env, limit: number, order: "desc" | "asc", sector?: string, market?: string) {
  const s = stub(env);
  if (!s) return { available: false as const, items: [] };
  const rows = await s.top(limit, order, sector, market);
  return {
    available: true as const,
    items: rows.map((r) => ({
      code: r.code,
      name: r.name,
      sector: r.sector,
      market: r.market,
      price: r.price,
      changePct: r.changePct,
      score: r.score,
      onto: r.onto,
      priceScore: r.priceScore,
      volatility: r.volatility,
      relStrength: r.relStrength,
      edges: JSON.parse(r.edges) as { macroId: string; sector: string; contribution: number }[],
      reasons: JSON.parse(r.reasons) as { kind: string; text: string; contribution: number }[],
      updatedAt: r.updatedAt,
    })),
  };
}

export async function radarFind(env: Env, q: string, limit = 8) {
  const s = stub(env);
  if (!s || !q.trim()) return { available: Boolean(s), items: [] };
  const rows = await s.find(q.trim(), limit);
  return {
    available: true,
    items: rows.map((r) => ({
      code: r.code, name: r.name, sector: r.sector, market: r.market,
      price: r.price, changePct: r.changePct, score: r.score, onto: r.onto,
      priceScore: r.priceScore, volatility: r.volatility, relStrength: r.relStrength,
      edges: JSON.parse(r.edges) as { macroId: string; sector: string; contribution: number }[],
      reasons: JSON.parse(r.reasons) as { kind: string; text: string; contribution: number }[],
      updatedAt: r.updatedAt,
    })),
  };
}

/** 기회 탐색 — 하락장에서도 ①수혜 경로 ②상대 강세 ③약세 경고를 묶어서 낸다. */
export async function radarOpps(env: Env, limit = 8, market?: string) {
  const s = stub(env);
  if (!s) return { available: false as const, tailwind: [], relative: [], weak: [] };
  const { tailwind, relative, weak } = await s.opportunities(limit, market);
  const mapRow = (r: RadarScoreRow) => ({
    code: r.code, name: r.name, sector: r.sector, market: r.market,
    price: r.price, changePct: r.changePct, score: r.score, onto: r.onto,
    priceScore: r.priceScore, volatility: r.volatility, relStrength: r.relStrength,
    edges: JSON.parse(r.edges) as { macroId: string; sector: string; contribution: number }[],
    reasons: JSON.parse(r.reasons) as { kind: string; text: string; contribution: number }[],
    updatedAt: r.updatedAt,
  });
  return {
    available: true as const,
    tailwind: tailwind.map(mapRow),
    relative: relative.map(mapRow),
    weak: weak.map(mapRow),
  };
}

export async function radarStatus(env: Env) {
  const s = stub(env);
  if (!s) return { available: false as const };
  return { available: true as const, ...(await s.status()) };
}
