/**
 * 추천 성적표 — "사이트가 추천한 종목을 추천대로 샀다면?" (2026-09-27)
 *
 * 사용자 지시(원문 요지): "니가 추천한 종목을 샀을 때 그걸 백테스팅 해야지, 전략으로
 * 백테스팅이 된다는 게 말이 되냐", "실제 주문 없이 추천대로 샀다면 얼마 벌었나만
 * 기록하라(그림자 운용 B안)".
 *
 * 전략실의 백테스트는 과거 시세로 **규칙**을 흉내 낸 것이었다(뉴스 0, 수급은 가격 역산).
 * 여기는 반대로 **실제로 화면·텔레그램에 나갔던 추천**만 채점한다.
 *
 * 규칙 — 화면이 안내한 그대로:
 *   · 추천일(D)의 마지막 브리프(KV brief:hist:시장:D)가 그날의 추천이다.
 *   · 매수: 그 브리프의 targetSession(다음 거래일) 시가.
 *   · 매도: 화면에 적힌 **손절가·목표가(절대 가격)** 에 장중 저가·고가가 닿으면.
 *     같은 날 둘 다 닿으면 손절로 친다(보수적). 갭으로 넘어가면 시가에 체결.
 *     단타는 7거래일째 종가 시간청산, 장기는 고점 대비 −25% 추적손절.
 *   · 같은 구간·같은 종목을 이미 들고 있으면 다음 날 같은 추천은 새로 사지 않는다
 *     (며칠 연속 추천된 종목을 매번 따로 세면 성적이 부풀거나 쪼그라든다).
 *   · 비용: 국내 왕복 0.5%, 미국 0.3%.
 *   · 비교 기준: 같은 매수일 시가 ~ 매도일 종가의 코스피 / S&P500.
 *
 * 무료 요금제 제약에 맞춘 설계:
 *   · KV 쓰기 — 한 번 갱신에 시장당 1회, 3시간에 한 번만 갱신 → 하루 ≤16회.
 *   · 외부요청 50개/호출 — 종목 시세는 getSeries(KV 캐시 쓰기 발생)가 아니라 loadSeries 로
 *     직접 받고, 한 번에 최대 30종목. 못 받은 종목은 다음 갱신 때 이어서 한다.
 *   · 추천 원본(brief:hist)은 45일 뒤 만료된다 — 그래서 받아 온 추천을 원장에 영구히 옮겨 둔다.
 */
import type { Env } from "./env";
import { loadSeries } from "./quotes";
import { round } from "./util";

type Mk = "KR" | "US";
type Bucket = "day" | "swing" | "mid" | "long";

const KEY = (mk: Mk) => `scorecard:v1:${mk}`;
const LOCK = (mk: Mk) => `scorecard:lock:${mk}`;
const REFRESH_MS = 3 * 3600_000;
const MAX_FETCH = 30;
const COST: Record<Mk, number> = { KR: 0.005, US: 0.003 };
const INDEX: Record<Mk, string> = { KR: "^KS11", US: "^GSPC" };
/** 보유 상한(거래일) — 단타만 규칙상 시간청산, 나머지는 안전 상한(넘으면 평가만) */
const MAX_HOLD: Record<Bucket, number> = { day: 7, swing: 30, mid: 40, long: 250 };
const NAME_KO: Record<Bucket, string> = { day: "단타", swing: "스윙", mid: "중기", long: "장기" };

interface Rec {
  date: string;            // 추천일
  target: string | null;   // 매수 예정일(다음 거래일)
  bucket: Bucket;
  code: string;
  symbol: string;
  name: string;
  stop: number;
  tgt: number | null;
}

export interface ScTrade {
  bucket: Bucket;
  code: string;
  name: string;
  recDate: string;
  entryDate: string | null;
  entryPx: number | null;
  exitDate: string | null;
  exitPx: number | null;
  status: "대기" | "보유중" | "익절" | "손절" | "시간청산";
  ret: number | null;      // 비용 차감 수익률(소수)
  idxRet: number | null;   // 같은 기간 지수
  days: number | null;     // 보유 거래일
}

interface Group { symbol: string; trades: ScTrade[]; recCount: number; computedAt: number }

interface Ledger {
  v: 1;
  market: Mk;
  updatedAt: number;
  /** 지난 갱신이 시세 한도(MAX_FETCH) 때문에 일부만 채웠다 — 1분 뒤 이어서 채운다 */
  partial?: boolean;
  ingested: string[];                 // 원장에 옮긴 추천일
  recs: Rec[];
  groups: Record<string, Group>;      // bucket|code
}

interface Bar { d: string; o: number; h: number; l: number; c: number }

/* ── 시세 ─────────────────────────────── */

/** 거래소 현지 날짜 — 일봉 타임스탬프(개장 시각, UTC ms)에 시차를 더해 날짜만 뗀다 */
function localDate(ms: number, mk: Mk): string {
  return new Date(ms + (mk === "KR" ? 9 : -4) * 3600_000).toISOString().slice(0, 10);
}

async function bars(symbol: string, mk: Mk): Promise<Bar[] | null> {
  try {
    const s = await loadSeries(symbol, "1y", "1d");
    const out: Bar[] = [];
    for (let i = 0; i < s.closes.length; i++) {
      const t = s.timestamps[i];
      if (!t) continue;
      out.push({ d: localDate(t, mk), o: s.opens[i], h: s.highs[i], l: s.lows[i], c: s.closes[i] });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/* ── 원장 ─────────────────────────────── */

async function load(env: Env, mk: Mk): Promise<Ledger> {
  const raw = (await env.CACHE.get(KEY(mk), "json").catch(() => null)) as Ledger | null;
  return raw?.v === 1 ? raw : { v: 1, market: mk, updatedAt: 0, ingested: [], recs: [], groups: {} };
}

/** brief:hist 에서 아직 안 옮긴 추천일을 원장으로 옮긴다. 오늘(아직 바뀔 수 있음)은 제외. */
async function ingest(env: Env, led: Ledger, mk: Mk): Promise<void> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: mk === "KR" ? "Asia/Seoul" : "America/New_York" }).format(new Date());
  const listed = await env.CACHE.list({ prefix: `brief:hist:${mk}:` }).catch(() => null);
  const dates = (listed?.keys ?? []).map((k) => k.name.split(":").pop()!).filter((d) => d < today && !led.ingested.includes(d)).sort();
  for (const d of dates) {
    const h = (await env.CACHE.get(`brief:hist:${mk}:${d}`, "json").catch(() => null)) as {
      full?: { targetSession?: string; horizons?: { buckets: { id: Bucket; picks: { code: string; symbol: string | null; name: string; plan: { stop: number; target: number | null } }[] }[] } };
    } | null;
    led.ingested.push(d);
    const hz = h?.full?.horizons;
    if (!hz) continue; // 구간별 추천이 생기기 전(2026-09-11 이전) 기록
    for (const b of hz.buckets) {
      for (const p of b.picks) {
        const symbol = p.symbol ?? (mk === "US" ? p.code : null);
        if (!symbol) continue;
        led.recs.push({ date: d, target: h?.full?.targetSession ?? null, bucket: b.id, code: p.code, symbol, name: p.name, stop: p.plan.stop, tgt: p.plan.target });
      }
    }
  }
  led.ingested.sort();
}

/* ── 채점 ─────────────────────────────── */

function simulateGroup(recs: Rec[], b: Bar[], idx: Bar[] | null, mk: Mk): ScTrade[] {
  const out: ScTrade[] = [];
  let busyUntil = ""; // 이 날짜까지는 보유 중 — 그 사이 추천은 새로 사지 않는다
  for (const r of [...recs].sort((x, y) => x.date.localeCompare(y.date))) {
    const e = b.findIndex((x) => (r.target ? x.d >= r.target : x.d > r.date));
    const base: ScTrade = {
      bucket: r.bucket, code: r.code, name: r.name, recDate: r.date,
      entryDate: null, entryPx: null, exitDate: null, exitPx: null, status: "대기", ret: null, idxRet: null, days: null,
    };
    if (e < 0) { if (!busyUntil) out.push(base); continue; } // 아직 매수일이 오지 않았다
    if (busyUntil === "open" || b[e].d <= busyUntil) continue; // 들고 있는 동안의 재추천
    const entry = b[e].o;
    let exitI = -1, exitPx = 0, status: ScTrade["status"] = "보유중", peak = entry;
    for (let i = e; i < b.length && i < e + MAX_HOLD[r.bucket]; i++) {
      const x = b[i];
      peak = Math.max(peak, x.h);
      const stopPx = r.bucket === "long" ? Math.max(r.stop, peak * 0.75) : r.stop;
      if (x.l <= stopPx) { exitI = i; exitPx = Math.min(stopPx, x.o); status = "손절"; break; }
      if (r.tgt !== null && x.h >= r.tgt) { exitI = i; exitPx = Math.max(r.tgt, x.o); status = "익절"; break; }
      if (r.bucket === "day" && i === e + MAX_HOLD.day - 1) { exitI = i; exitPx = x.c; status = "시간청산"; break; }
    }
    const endI = exitI >= 0 ? exitI : b.length - 1;
    const px = exitI >= 0 ? exitPx : b[endI].c;
    let idxRet: number | null = null;
    if (idx) {
      const ie = idx.findIndex((x) => x.d >= b[e].d);
      const ix = [...idx].reverse().findIndex((x) => x.d <= b[endI].d);
      const ixI = ix >= 0 ? idx.length - 1 - ix : -1;
      if (ie >= 0 && ixI >= ie) idxRet = round(idx[ixI].c / idx[ie].o - 1, 4);
    }
    out.push({
      ...base,
      entryDate: b[e].d, entryPx: round(entry, 2),
      exitDate: exitI >= 0 ? b[exitI].d : null, exitPx: round(px, 2),
      status,
      ret: round(px / entry - 1 - COST[mk], 4),
      idxRet,
      days: endI - e + 1,
    });
    busyUntil = exitI >= 0 ? b[exitI].d : "open";
  }
  return out;
}

/** 원장 갱신 — 3시간에 한 번. 잠금으로 동시 갱신을 막는다. */
export async function refreshScorecard(env: Env, mk: Mk, force = false): Promise<Ledger> {
  const led = await load(env, mk);
  const wait = led.partial ? 60_000 : REFRESH_MS;
  if (!force && Date.now() - led.updatedAt < wait) return led;
  if (await env.CACHE.get(LOCK(mk)).catch(() => null)) return led;
  await env.CACHE.put(LOCK(mk), "1", { expirationTtl: 90 }).catch(() => undefined);

  await ingest(env, led, mk);

  // 다시 계산할 그룹: 추천 수가 늘었거나, 아직 결말이 안 난(대기·보유중) 거래가 있는 그룹
  const byGroup = new Map<string, Rec[]>();
  for (const r of led.recs) {
    const k = `${r.bucket}|${r.code}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(r);
  }
  const need = [...byGroup.entries()].filter(([k, rs]) => {
    const g = led.groups[k];
    return !g || g.recCount !== rs.length || g.trades.some((t) => t.status === "대기" || t.status === "보유중");
  }).sort((a, b) => (led.groups[a[0]]?.computedAt ?? 0) - (led.groups[b[0]]?.computedAt ?? 0));

  // 같은 종목이 여러 구간에 걸쳐 있으면 시세는 한 번만 받는다
  const allSymbols = [...new Set(need.map(([, rs]) => rs[0].symbol))];
  const symbols = allSymbols.slice(0, MAX_FETCH);
  led.partial = allSymbols.length > MAX_FETCH;
  const idx = await bars(INDEX[mk], mk);
  const got = new Map<string, Bar[]>();
  for (let i = 0; i < symbols.length; i += 5) {
    const part = symbols.slice(i, i + 5);
    const res = await Promise.all(part.map((s) => bars(s, mk)));
    part.forEach((s, j) => { if (res[j]) got.set(s, res[j]!); });
  }
  const now = Date.now();
  for (const [k, rs] of need) {
    const b = got.get(rs[0].symbol);
    if (!b) continue;
    led.groups[k] = { symbol: rs[0].symbol, trades: simulateGroup(rs, b, idx, mk), recCount: rs.length, computedAt: now };
  }
  led.updatedAt = now;
  await env.CACHE.put(KEY(mk), JSON.stringify(led)).catch(() => undefined);
  await env.CACHE.delete(LOCK(mk)).catch(() => undefined);
  return led;
}

/* ── 화면용 요약 ─────────────────────────────── */

export interface ScorecardView {
  market: Mk;
  updatedAt: number;
  since: string | null;
  lastRecDate: string | null;
  rulesKo: string;
  total: ScSummary;
  buckets: (ScSummary & { id: Bucket; nameKo: string })[];
  trades: ScTrade[];
}

interface ScSummary {
  closed: number; open: number; waiting: number;
  avgClosed: number | null; winRateClosed: number | null;
  avgAll: number | null;        // 청산 + 보유중 평가
  idxAvgAll: number | null;     // 같은 기간 지수 평균
  tp: number; sl: number; time: number;
}

function summarize(ts: ScTrade[]): ScSummary {
  const closed = ts.filter((t) => t.status === "익절" || t.status === "손절" || t.status === "시간청산");
  const live = ts.filter((t) => t.ret !== null);
  const mean = (a: number[]) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 4) : null);
  return {
    closed: closed.length,
    open: ts.filter((t) => t.status === "보유중").length,
    waiting: ts.filter((t) => t.status === "대기").length,
    avgClosed: mean(closed.map((t) => t.ret!)),
    winRateClosed: closed.length ? round(closed.filter((t) => t.ret! > 0).length / closed.length, 3) : null,
    avgAll: mean(live.map((t) => t.ret!)),
    idxAvgAll: mean(live.filter((t) => t.idxRet !== null).map((t) => t.idxRet!)),
    tp: ts.filter((t) => t.status === "익절").length,
    sl: ts.filter((t) => t.status === "손절").length,
    time: ts.filter((t) => t.status === "시간청산").length,
  };
}

export async function scorecard(env: Env, mk: Mk): Promise<ScorecardView> {
  const led = await refreshScorecard(env, mk);
  const all = Object.values(led.groups).flatMap((g) => g.trades);
  const order: Bucket[] = ["day", "swing", "mid", "long"];
  return {
    market: mk,
    updatedAt: led.updatedAt,
    since: led.recs.length ? led.recs.map((r) => r.date).sort()[0] : null,
    lastRecDate: led.recs.length ? led.recs.map((r) => r.date).sort().at(-1)! : null,
    rulesKo: `추천 다음 거래일 시가에 매수 · 화면에 적힌 목표가·손절가대로 매도 · 단타는 7거래일 시간청산 · 같은 종목 보유 중 재추천은 건너뜀 · 비용 ${mk === "KR" ? "왕복 0.5%" : "왕복 0.3%"} 차감`,
    total: summarize(all),
    buckets: order.filter((id) => all.some((t) => t.bucket === id)).map((id) => ({ id, nameKo: NAME_KO[id], ...summarize(all.filter((t) => t.bucket === id)) })),
    // 매수가 된 거래를 최근 순으로, 아직 매수일이 오지 않은 "대기"는 맨 뒤에
    trades: [
      ...all.filter((t) => t.entryDate).sort((a, b) => b.entryDate!.localeCompare(a.entryDate!) || b.recDate.localeCompare(a.recDate)),
      ...all.filter((t) => !t.entryDate).sort((a, b) => b.recDate.localeCompare(a.recDate)),
    ].slice(0, 80),
  };
}
