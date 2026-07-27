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
import { MACRO, type SectorId, type UniverseTicker } from "../shared/ontology";
import { composite, macroSignals, priceSignal, propagate, round } from "../shared/scoring";
import { getSparkMany, loadSparkFresh } from "./quotes";
import { getMacroNewsAdjust } from "./macronews";
import type { RadarScoreRow, RadarTicker } from "./radar";

const CHUNK = 80;

function stub(env: Env) {
  if (!env.RADAR) return null;
  return env.RADAR.get(env.RADAR.idFromName("main"));
}

export async function radarSeedIfNeeded(env: Env): Promise<number> {
  const s = stub(env);
  if (!s) return 0;
  const status = await s.status();
  if (status.tickers >= (seedData as RadarTicker[]).length) return status.tickers;
  return s.seed(seedData as RadarTicker[]);
}

/** 거시 신호 (전략과 같은 계산·같은 캐시 경로) */
async function macroForRadar(env: Env) {
  const [spark, mnews] = await Promise.all([
    getSparkMany(env, MACRO.map((m) => m.symbol), "3mo"),
    getMacroNewsAdjust(env).catch(() => null),
  ]);
  const bySymbol = new Map(spark.map((x) => [x.symbol.toUpperCase(), { price: x.price, closes: x.closes, highs: [], lows: [], volumes: [] }]));
  const macro = macroSignals((sym) => bySymbol.get(sym.toUpperCase()));
  if (mnews?.adjustments.length) {
    const byId = new Map(mnews.adjustments.map((a) => [a.id, a]));
    for (const m of macro) {
      const adj = byId.get(m.id);
      if (adj) {
        m.newsImpact = adj.impact;
        m.newsReason = adj.reasonKo;
      }
    }
  }
  return macro;
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
  const [{ rows, cursor }, macro] = await Promise.all([s.nextChunk(CHUNK), macroForRadar(env)]);
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
      onto = propagate(fake, macro);
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
      edges: JSON.stringify(onto.edges.slice(0, 6)),
      reasons: JSON.stringify([...onto.reasons, ...price.reasons]),
      updatedAt: now,
    });
  }

  if (out.length) await s.upsertScores(out);
  return { scanned: out.length, cursor, skippedNoData: skipped };
}

export async function radarTop(env: Env, limit: number, order: "desc" | "asc", sector?: string) {
  const s = stub(env);
  if (!s) return { available: false as const, items: [] };
  const rows = await s.top(limit, order, sector);
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
      edges: JSON.parse(r.edges) as { macroId: string; sector: string; contribution: number }[],
      reasons: JSON.parse(r.reasons) as { kind: string; text: string; contribution: number }[],
      updatedAt: r.updatedAt,
    })),
  };
}

export async function radarStatus(env: Env) {
  const s = stub(env);
  if (!s) return { available: false as const };
  return { available: true as const, ...(await s.status()) };
}
