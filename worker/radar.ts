/**
 * 전 시장 레이더 — SQLite 기반 Durable Object.
 *
 * 유니버스를 89종목으로 손매핑하는 대신, KOSPI200 + KOSDAQ150 = 350종목을
 * 데이터베이스에 넣고 크론이 조각(chunk) 단위로 순회하며 점수를 갱신한다.
 *
 * 왜 D1이 아니라 Durable Object인가: 배포 토큰에 D1 생성 권한이 없었고,
 * SQLite DO는 Worker 배포에 딸려 나가 별도 권한이 필요 없다. 무료 한도도 같은 급이다
 * (KV는 쓰기 1,000/일 — 이 용도로는 불가능했다. 그래서 DB가 필요했던 것).
 *
 * DO 는 저장·조회만 한다. Yahoo 호출과 점수 계산은 워커 쪽(radarscan.ts)이 한다 —
 * DO 안에서 외부 fetch 를 돌리면 CPU·요청 한도 관리가 어려워진다.
 */
import { DurableObject } from "cloudflare:workers";

export interface RadarTicker {
  code: string;
  symbol: string;
  name: string;
  market: string;
  sector: string | null;
}

export interface RadarScoreRow {
  code: string;
  name: string;
  sector: string | null;
  market: string;
  price: number;
  changePct: number;
  score: number;
  onto: number;
  priceScore: number;
  volatility: number;
  /** 20일 수익률 - 코스피 20일 수익률 (%p). 하락장에서 버티는 종목을 찾는 축 */
  relStrength: number | null;
  /** JSON: {macroId,sector,contribution}[] */
  edges: string;
  /** JSON: {kind,text,contribution}[] */
  reasons: string;
  updatedAt: number;
}

export interface RadarStatus {
  tickers: number;
  scored: number;
  cursor: number;
  lastScanAt: number;
  oldestScoreAt: number;
  newestScoreAt: number;
}

export class RadarDB extends DurableObject {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickers(
        code TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL,
        market TEXT NOT NULL, sector TEXT
      );
      CREATE TABLE IF NOT EXISTS scores(
        code TEXT PRIMARY KEY, name TEXT, sector TEXT, market TEXT,
        price REAL, change_pct REAL, score REAL, onto REAL, price_score REAL,
        volatility REAL, edges TEXT, reasons TEXT, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS dict(target TEXT NOT NULL, ko TEXT NOT NULL, tr TEXT NOT NULL, PRIMARY KEY(target, ko));
    `);
    // 기존 테이블에 상대강도 컬럼 추가 (이미 있으면 무시)
    try {
      this.sql.exec(`ALTER TABLE scores ADD COLUMN rel_strength REAL`);
    } catch {
      /* 이미 존재 */
    }
  }

  /** 시드. 이미 있는 코드는 이름·섹터만 갱신한다. */
  seed(rows: RadarTicker[]): number {
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO tickers(code,symbol,name,market,sector) VALUES(?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET symbol=excluded.symbol, name=excluded.name,
           market=excluded.market, sector=excluded.sector`,
        r.code, r.symbol, r.name, r.market, r.sector,
      );
    }
    return this.count();
  }

  count(): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM tickers`).one().n ?? 0);
  }

  /* ── 번역 사전 ────────────────────────────────────────
   * KV 가 아니라 여기 두는 이유: KV 읽기는 엣지에서 60초 캐시돼, 번역이
   * 몰리는 세션 중에는 낡은 사전을 읽고 통짜로 다시 써서 서로의 항목을
   * 덮어썼다(두 번째 방문도 느린 원인). SQLite DO 는 강한 일관성 + 행 단위
   * upsert 라 유실이 없다. */

  dictGet(target: string, texts: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of texts.slice(0, 100)) {
      const rows = this.sql.exec(`SELECT tr FROM dict WHERE target=? AND ko=?`, target, t).toArray() as { tr?: string }[];
      if (rows[0]?.tr) out[t] = rows[0].tr;
    }
    return out;
  }

  dictPut(target: string, entries: Record<string, string>): number {
    let n = 0;
    for (const [ko, tr] of Object.entries(entries).slice(0, 64)) {
      if (!ko || !tr) continue;
      this.sql.exec(
        `INSERT INTO dict(target,ko,tr) VALUES(?,?,?) ON CONFLICT(target,ko) DO UPDATE SET tr=excluded.tr`,
        target, ko, tr,
      );
      n++;
    }
    return n;
  }

  /** 커서 위치부터 n개 반환하고 커서를 전진(끝나면 0으로 되감기). */
  nextChunk(n: number): { rows: RadarTicker[]; cursor: number } {
    const total = this.count();
    if (!total) return { rows: [], cursor: 0 };
    const cur = Number(this.getMeta("cursor") ?? "0");
    const rows = this.sql
      .exec(`SELECT code,symbol,name,market,sector FROM tickers ORDER BY code LIMIT ? OFFSET ?`, n, cur)
      .toArray() as unknown as RadarTicker[];
    const next = cur + rows.length >= total ? 0 : cur + rows.length;
    this.setMeta("cursor", String(next));
    this.setMeta("lastScanAt", String(Date.now()));
    return { rows, cursor: next };
  }

  upsertScores(rows: RadarScoreRow[]): number {
    // INSERT 경로에는 rel_strength 가 없다(구버전 컬럼 순서 유지) — UPDATE 로 함께 채운다.
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO scores(code,name,sector,market,price,change_pct,score,onto,price_score,volatility,edges,reasons,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, sector=excluded.sector, market=excluded.market,
           price=excluded.price, change_pct=excluded.change_pct, score=excluded.score, onto=excluded.onto,
           price_score=excluded.price_score, volatility=excluded.volatility,
           edges=excluded.edges, reasons=excluded.reasons, updated_at=excluded.updated_at,
           rel_strength=?`,
        r.code, r.name, r.sector, r.market, r.price, r.changePct, r.score, r.onto, r.priceScore,
        r.volatility, r.edges, r.reasons, r.updatedAt, r.relStrength,
      );
      this.sql.exec(`UPDATE scores SET rel_strength=? WHERE code=?`, r.relStrength, r.code);
    }
    return rows.length;
  }

  /** 점수 순 상위/하위. sector·market 필터 옵션. */
  top(limit: number, order: "desc" | "asc", sector?: string, market?: string): RadarScoreRow[] {
    // 상한 100 → 600: 리그·조합이 전 유니버스(454) 온톨로지 점수를 조인해야 한다.
    // 100이면 미국 종목은 전체 상위 100에 든 것만 점수를 받아 onto·융합 원장이 굶는다(2026-08-17 실측).
    const lim = Math.min(600, Math.max(1, limit));
    const dir = order === "asc" ? "ASC" : "DESC";
    const conds: string[] = [];
    const args: unknown[] = [];
    if (sector) { conds.push("sector=?"); args.push(sector); }
    if (market) { conds.push("market=?"); args.push(market); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.sql.exec(`SELECT * FROM scores ${where} ORDER BY score ${dir} LIMIT ?`, ...args, lim).toArray();
    return rows.map((r) => ({
      code: String(r.code),
      name: String(r.name),
      sector: (r.sector as string | null) ?? null,
      market: String(r.market),
      price: Number(r.price),
      changePct: Number(r.change_pct),
      score: Number(r.score),
      onto: Number(r.onto),
      priceScore: Number(r.price_score),
      volatility: Number(r.volatility),
      relStrength: r.rel_strength === null || r.rel_strength === undefined ? null : Number(r.rel_strength),
      edges: String(r.edges ?? "[]"),
      reasons: String(r.reasons ?? "[]"),
      updatedAt: Number(r.updated_at),
    }));
  }

  /** 이름·코드 검색 (조회용 사용자를 위한 진입점) */
  find(q: string, limit: number): RadarScoreRow[] {
    const lim = Math.min(20, Math.max(1, limit));
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const rows = this.sql
      .exec(
        `SELECT * FROM scores WHERE name LIKE ? OR code LIKE ? ORDER BY ABS(score) DESC LIMIT ?`,
        like, `${q.replace(/[%_]/g, "")}%`, lim,
      )
      .toArray();
    return rows.map((r) => ({
      code: String(r.code), name: String(r.name), sector: (r.sector as string | null) ?? null,
      market: String(r.market), price: Number(r.price), changePct: Number(r.change_pct),
      score: Number(r.score), onto: Number(r.onto), priceScore: Number(r.price_score),
      volatility: Number(r.volatility),
      relStrength: r.rel_strength === null || r.rel_strength === undefined ? null : Number(r.rel_strength),
      edges: String(r.edges ?? "[]"), reasons: String(r.reasons ?? "[]"),
      updatedAt: Number(r.updated_at),
    }));
  }

  /**
   * 기회 탐색 — 하락 국면에서 가치가 있는 세 관점.
   *   tailwind: 지금 거시 신호에서 온톨로지가 양(+)인 종목 = 역풍 속 순풍
   *   relative: 시장 대비 강세 (20일 상대수익률) = 하락장에서 버티는 힘
   *   weak:     합성 점수 최하위 = 매도·회피 경고
   */
  opportunities(limit: number, market?: string): { tailwind: RadarScoreRow[]; relative: RadarScoreRow[]; weak: RadarScoreRow[] } {
    const lim = Math.min(15, Math.max(1, limit));
    // 시장 필터 — 한국(KOSPI/KOSDAQ)과 미국(US)을 분리해 본다
    const mkt = market === "US" ? "AND market='US'" : market ? "AND market!='US'" : "";
    const mapRow = (r: Record<string, unknown>): RadarScoreRow => ({
      code: String(r.code), name: String(r.name), sector: (r.sector as string | null) ?? null,
      market: String(r.market), price: Number(r.price), changePct: Number(r.change_pct),
      score: Number(r.score), onto: Number(r.onto), priceScore: Number(r.price_score),
      volatility: Number(r.volatility),
      relStrength: r.rel_strength === null || r.rel_strength === undefined ? null : Number(r.rel_strength),
      edges: String(r.edges ?? "[]"), reasons: String(r.reasons ?? "[]"), updatedAt: Number(r.updated_at),
    });
    const tailwind = this.sql
      .exec(`SELECT * FROM scores WHERE onto > 0.05 ${mkt} ORDER BY onto DESC LIMIT ?`, lim)
      .toArray().map(mapRow);
    const relative = this.sql
      .exec(`SELECT * FROM scores WHERE rel_strength IS NOT NULL ${mkt} ORDER BY rel_strength DESC LIMIT ?`, lim)
      .toArray().map(mapRow);
    const weak = this.sql
      .exec(`SELECT * FROM scores WHERE 1=1 ${mkt} ORDER BY score ASC LIMIT ?`, lim)
      .toArray().map(mapRow);
    return { tailwind, relative, weak };
  }

  status(): RadarStatus {
    const scored = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM scores`).one().n ?? 0);
    const range = this.sql.exec(`SELECT MIN(updated_at) AS lo, MAX(updated_at) AS hi FROM scores`).one();
    return {
      tickers: this.count(),
      scored,
      cursor: Number(this.getMeta("cursor") ?? "0"),
      lastScanAt: Number(this.getMeta("lastScanAt") ?? "0"),
      oldestScoreAt: Number(range.lo ?? 0),
      newestScoreAt: Number(range.hi ?? 0),
    };
  }

  private getMeta(k: string): string | null {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray();
    return r.length ? String(r[0].v) : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v);
  }
}
