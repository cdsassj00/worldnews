/**
 * 한국투자증권 (KIS) OpenAPI 연동.
 *
 * 안전장치
 *  1) 기본값은 모의투자(KIS_ENV=vts). 실전은 KIS_ENV=prod + ORDER_ALLOW_REAL=true 둘 다 필요.
 *  2) 주문 API는 ORDER_ENABLED=true 여야 동작한다.
 *  3) 주문/잔고 API는 TRADE_TOKEN 베어러 인증을 통과해야 한다(공개 사이트이므로 필수).
 *  4) 1회 주문 금액은 MAX_ORDER_NOTIONAL_KRW 로 제한한다.
 *
 * TR_ID 는 KIS 문서 기준 표를 코드에 두고, 필요하면 KIS_TRID_OVERRIDES 시크릿(JSON)으로 덮어쓴다.
 */
import type { Env } from "./env";
import { ApiError, num, safeEqual } from "./util";
import { socketHttpRequest } from "./http-socket";

export interface KisConfig {
  appKey: string;
  appSecret: string;
  cano: string;
  acntPrdtCd: string;
  isPaper: boolean;
  host: string;
  port: number;
}

export type OrderSide = "buy" | "sell";
export type OrderMarket = "KRX" | "NAS" | "NYS" | "AMS" | "TSE" | "HKS" | "SHS" | "SZS";

const HOSTS = {
  prod: { host: "openapi.koreainvestment.com", port: 9443 },
  vts: { host: "openapivts.koreainvestment.com", port: 29443 },
};

/** KIS 문서 기준 TR_ID. prod=실전, vts=모의 */
const TRID: Record<string, { prod: string; vts: string }> = {
  "domestic.buy": { prod: "TTTC0802U", vts: "VTTC0802U" },
  "domestic.sell": { prod: "TTTC0801U", vts: "VTTC0801U" },
  "domestic.cancel": { prod: "TTTC0803U", vts: "VTTC0803U" },
  "domestic.balance": { prod: "TTTC8434R", vts: "VTTC8434R" },
  "domestic.price": { prod: "FHKST01010100", vts: "FHKST01010100" },
  "overseas.price": { prod: "HHDFS00000300", vts: "HHDFS00000300" },
  "overseas.balance": { prod: "TTTS3012R", vts: "VTTS3012R" },
  "overseas.psamount": { prod: "TTTS3007R", vts: "VTTS3007R" },
  // 미국(나스닥/뉴욕/아멕스) — 정규장 TR. JTTT1002U/JTTT1006U 는 주간거래(KST 낮) 전용이다.
  "overseas.NAS.buy": { prod: "TTTT1002U", vts: "VTTT1002U" },
  "overseas.NAS.sell": { prod: "TTTT1006U", vts: "VTTT1001U" },
  // 일본
  "overseas.TSE.buy": { prod: "TTTS0308U", vts: "VTTS0308U" },
  "overseas.TSE.sell": { prod: "TTTS0307U", vts: "VTTS0307U" },
  // 홍콩
  "overseas.HKS.buy": { prod: "TTTS1002U", vts: "VTTS1002U" },
  "overseas.HKS.sell": { prod: "TTTS1001U", vts: "VTTS1001U" },
  // 상해
  "overseas.SHS.buy": { prod: "TTTS0202U", vts: "VTTS0202U" },
  "overseas.SHS.sell": { prod: "TTTS1005U", vts: "VTTS1005U" },
  // 심천
  "overseas.SZS.buy": { prod: "TTTS0305U", vts: "VTTS0305U" },
  "overseas.SZS.sell": { prod: "TTTS0304U", vts: "VTTS0304U" },
};

function trId(env: Env, key: string, isPaper: boolean): string {
  let table = TRID;
  if (env.KIS_TRID_OVERRIDES) {
    try {
      table = { ...TRID, ...(JSON.parse(env.KIS_TRID_OVERRIDES) as typeof TRID) };
    } catch {
      /* 잘못된 JSON은 무시 */
    }
  }
  const row = table[key];
  if (!row) throw new ApiError(400, "unsupported_market", { key });
  return isPaper ? row.vts : row.prod;
}

/** 미국 3거래소는 TR_ID를 공유한다 */
function orderTridKey(market: OrderMarket, side: OrderSide): string {
  if (market === "KRX") return `domestic.${side}`;
  const m = market === "NYS" || market === "AMS" ? "NAS" : market;
  return `overseas.${m}.${side}`;
}

export function kisConfigured(env: Env): boolean {
  return Boolean(env.KIS_APP_KEY && env.KIS_APP_SECRET && env.KIS_ACCOUNT);
}

export function kisConfig(env: Env): KisConfig {
  if (!kisConfigured(env)) {
    throw new ApiError(503, "kis_not_configured", {
      hint: "wrangler secret put KIS_APP_KEY / KIS_APP_SECRET / KIS_ACCOUNT 을 먼저 등록하세요.",
    });
  }
  const account = String(env.KIS_ACCOUNT).trim();
  const m = /^(\d{8})-?(\d{2})$/.exec(account);
  if (!m) throw new ApiError(500, "kis_account_format", { hint: "KIS_ACCOUNT 형식은 12345678-01 입니다." });
  const isPaper = (env.KIS_ENV ?? "vts").toLowerCase() !== "prod";
  const { host, port } = isPaper ? HOSTS.vts : HOSTS.prod;
  return {
    appKey: String(env.KIS_APP_KEY),
    appSecret: String(env.KIS_APP_SECRET),
    cano: m[1],
    acntPrdtCd: m[2],
    isPaper,
    host,
    port,
  };
}

/**
 * 해외주식 주문·잔고 사용 가능 여부.
 *
 * 한국투자증권 모의투자 계좌는 실무적으로 국내주식 위주여서 해외주식 주문이 막히는 경우가 많다.
 * 그래서 기본값(auto)은 "모의투자 = 해외 불가 / 실전 = 해외 가능" 으로 보수적으로 잡는다.
 * 본인 계좌가 모의에서도 해외 주문이 된다면 KIS_OVERSEAS=on 으로 열면 된다.
 */
export function overseasCapability(env: Env): { allowed: boolean; reason: string } {
  const mode = (env.KIS_OVERSEAS ?? "auto").toLowerCase();
  const isPaper = (env.KIS_ENV ?? "vts").toLowerCase() !== "prod";
  if (mode === "on") return { allowed: true, reason: "KIS_OVERSEAS=on 으로 강제 허용됨" };
  if (mode === "off") return { allowed: false, reason: "KIS_OVERSEAS=off 로 해외주식이 차단됨" };
  if (isPaper) {
    return {
      allowed: false,
      reason:
        "모의투자 계좌에서는 해외주식 주문·잔고를 지원하지 않는 것으로 가정합니다(기본값). 실전 계좌로 전환하거나, 모의에서도 해외가 열려 있다면 KIS_OVERSEAS=on 으로 설정하세요.",
    };
  }
  return {
    allowed: true,
    // 이건 **설정상 허용**일 뿐 계좌가 실제로 해외 거래가 열려 있다는 뜻이 아니다.
    // 진짜 확인은 overseasReadiness() 로 KIS 에 직접 물어야 한다.
    reason: "실전 계좌라 설정상 해외주식을 허용합니다(계좌의 실제 개설 여부는 별도 점검 필요).",
  };
}

/**
 * 해외주식 실거래 준비 상태를 **KIS 에 직접 물어서** 확인한다.
 *
 * overseasCapability() 는 우리 쪽 설정만 본다("실전 계좌니까 되겠지"). 그건 가정이지
 * 사실이 아니다. 해외주식은 증권사에서 별도 약정·거래 신청을 해야 열리고, 신청이
 * 안 된 계좌는 시세는 나와도 잔고·주문에서 거부된다. 그래서 세 가지를 나눠 본다.
 *
 *   ① 시세  — 앱키에 해외 시세 권한이 있는가 (계좌와 무관)
 *   ② 잔고  — 계좌에 해외주식 거래가 열려 있는가 (여기서 막히면 신청이 안 된 것)
 *   ③ 외화  — 달러 예수금이 있는가 (없으면 환전 또는 통합증거금 신청이 필요)
 *
 * 잔고·보유 내역은 돌려주지 않는다. 응답 코드와 메시지, 그리고 "달러가 있냐 없냐"만 본다.
 */
export interface OverseasReadiness {
  configAllowed: boolean;
  configReason: string;
  quote: { ok: boolean; detail: string };
  balance: { ok: boolean; detail: string };
  usdCash: number | null;
  hasOverseasHoldings: boolean | null;
  /** 매수가능금액 판정 — 통합증거금이면 달러 0 이어도 ok 가 된다 */
  buyingPower: { ok: boolean; detail: string } | null;
  verdict: string;
  nextSteps: string[];
}

export async function overseasReadiness(env: Env, cfg: KisConfig): Promise<OverseasReadiness> {
  const cap = overseasCapability(env);
  const out: OverseasReadiness = {
    configAllowed: cap.allowed,
    configReason: cap.reason,
    quote: { ok: false, detail: "미확인" },
    balance: { ok: false, detail: "미확인" },
    usdCash: null,
    hasOverseasHoldings: null,
    buyingPower: null,
    verdict: "",
    nextSteps: [],
  };

  // ① 해외 시세 — 계좌가 아니라 앱키 권한을 본다
  let aaplPrice = 0;
  try {
    const p = await overseasPrice(env, cfg, "NAS", "AAPL");
    aaplPrice = p.price;
    out.quote = { ok: p.price > 0, detail: p.price > 0 ? `애플 현재가 ${p.price} 조회 성공` : "가격이 비어 있음" };
  } catch (err) {
    out.quote = { ok: false, detail: err instanceof ApiError ? `${err.code} — ${JSON.stringify(err.detail)}` : String(err) };
  }

  // ② 해외 잔고 — 계좌에 해외주식이 열려 있는지 판별하는 결정적 신호
  if (!cap.allowed) {
    out.balance = { ok: false, detail: cap.reason };
  } else {
    try {
      const b = await overseasBalance(env, cfg, "NAS" as OrderMarket, "USD");
      out.balance = { ok: true, detail: "해외 잔고 조회 성공 — 계좌에 해외주식이 열려 있습니다." };
      out.usdCash = b.summary.orderableCash;
      out.hasOverseasHoldings = b.holdings.length > 0;
    } catch (err) {
      out.balance = { ok: false, detail: err instanceof ApiError ? `${err.code} — ${JSON.stringify(err.detail)}` : String(err) };
    }
  }

  // ③ 매수가능금액 — 달러 예수금이 0이어도 통합증거금이면 원화로 매수 가능하다.
  //    예수금(잔고)이 아니라 이 값이 "지금 살 수 있는가"의 결정적 판정이다.
  if (out.balance.ok && aaplPrice > 0) {
    try {
      // 실전 매수가능금액 조회의 거래소 코드는 4자리(NASD)다 — 잔고(NAS)와 다르다
      const ps = await overseasPsamount(env, cfg, "NASD", "AAPL", aaplPrice);
      const orderable = Math.max(ps.totalOrderable, ps.frcrOrderable, ps.afterExchangeOrderable);
      out.buyingPower = ps.maxQty > 0 || orderable > 0
        ? { ok: true, detail: `주문가능 ${orderable.toFixed(2)} USD · 애플 기준 최대 ${ps.maxQty}주${ps.fx ? ` · 적용 환율 ${ps.fx}` : ""}${ps.frcrOrderable <= 0 ? " — 달러 예수금 없이 원화(통합증거금)로 계산된 금액입니다" : ""}` }
        : { ok: false, detail: "주문가능금액 0 — 통합증거금 미반영 또는 예수금 부족" };
    } catch (err) {
      out.buyingPower = { ok: false, detail: err instanceof ApiError ? `${err.code} — ${JSON.stringify(err.detail)}` : String(err) };
    }
  }

  if (!out.quote.ok) {
    out.verdict = "해외 시세부터 막힙니다 — API 앱키에 해외주식 권한이 없을 수 있습니다.";
    out.nextSteps.push("KIS Developers 에서 앱키의 해외주식 서비스 신청 여부를 확인하세요.");
  } else if (!out.balance.ok) {
    out.verdict = "시세는 되지만 해외 잔고 조회가 막힙니다 — 계좌에 해외주식 거래가 신청되지 않았을 가능성이 큽니다.";
    out.nextSteps.push("한국투자 앱/HTS 에서 해외주식 거래 약정(신청)을 하세요. 보통 기존 계좌에 신청만 하면 되고 새 계좌를 만들 필요는 없습니다.");
    out.nextSteps.push("신청 직후에는 반영에 시간이 걸릴 수 있으니 다음 영업일에 다시 점검하세요.");
  } else if (out.buyingPower?.ok) {
    out.verdict = out.usdCash
      ? `해외주식 거래 준비 완료 — 주문 가능 외화 ${out.usdCash} USD.`
      : "해외주식 거래 준비 완료 — 달러 예수금은 0이지만 통합증거금으로 원화 매수가 가능합니다.";
    out.nextSteps.push("자동매매를 켜기 전에 US_AUTOTRADE_ENABLED 를 여는 대신 미국 페이퍼(모의) 성적을 먼저 쌓는 것을 권합니다.");
  } else if (!out.usdCash) {
    out.verdict = "해외 거래는 열려 있는데 달러 예수금이 0이고 통합증거금 매수가능금액도 아직 잡히지 않습니다.";
    out.nextSteps.push("통합증거금을 이미 신청했다면 반영(보통 신청 다음 영업일)까지 기다렸다가 다시 점검하세요.");
    out.nextSteps.push("당장 사야 하면 한투 앱 환전 메뉴에서 원화→달러 환전 후 주문하면 됩니다.");
  } else {
    out.verdict = `해외주식 거래 준비 완료 — 주문 가능 외화 ${out.usdCash} USD.`;
    out.nextSteps.push("자동매매를 켜기 전에 US_AUTOTRADE_ENABLED 를 여는 대신 미국 페이퍼(모의) 성적을 먼저 쌓는 것을 권합니다.");
  }
  return out;
}

export function assertOverseasAllowed(env: Env, market: OrderMarket): void {
  if (market === "KRX") return;
  const cap = overseasCapability(env);
  if (!cap.allowed) throw new ApiError(400, "overseas_unavailable", { hint: cap.reason });
}

/** 주문/잔고 API 접근 인증 (Authorization: Bearer <TRADE_TOKEN>) */
export function assertTradeAuth(env: Env, request: Request): void {
  const expected = env.TRADE_TOKEN;
  if (!expected) {
    throw new ApiError(503, "trade_token_not_set", {
      hint: "wrangler secret put TRADE_TOKEN 으로 접근 암호를 설정해야 주문/잔고 API가 열립니다.",
    });
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, expected)) throw new ApiError(401, "unauthorized", { hint: "거래 암호가 올바르지 않습니다." });
}

interface KisCall {
  method: "GET" | "POST";
  path: string;
  trId: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** 주문 API는 hashkey 헤더를 함께 보낸다 */
  useHashkey?: boolean;
  token?: string;
}

interface RawKisResponse {
  status: number;
  json: Record<string, unknown>;
}

/** 전송 전체(fetch 시도 + 소켓 폴백)에 상한을 둔다. 매달린 서브리퀘스트가 요청을 잡아먹지 않게 한다. */
const TRANSPORT_BUDGET_MS = 25_000;

async function transportRequest(
  env: Env,
  cfg: KisConfig,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawKisResponse> {
  let budgetTimer: number | undefined;
  const budget = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(
      () => reject(new ApiError(504, "kis_timeout", { hint: "한국투자증권 응답이 없어 요청을 중단했습니다." })),
      TRANSPORT_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([transportAttempt(env, cfg, method, path, headers, body), budget]);
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
  }
}

/**
 * fetch 가 비표준 포트(9443/29443)에서 막히는 환경이면 매 요청 10초를 낭비하게 되므로
 * 한 번 판별한 전송 방식을 KV에 기억해 둔다.
 */
const TRANSPORT_MEMO_KEY = "kis:transport";

async function transportAttempt(
  env: Env,
  cfg: KisConfig,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawKisResponse> {
  const mode = (env.KIS_TRANSPORT ?? "auto").toLowerCase();
  const url = `https://${cfg.host}:${cfg.port}${path}`;

  const parse = (status: number, text: string): RawKisResponse => {
    try {
      return { status, json: JSON.parse(text) as Record<string, unknown> };
    } catch {
      throw new ApiError(502, "kis_bad_response", { status, snippet: text.slice(0, 300) });
    }
  };

  const memo = mode === "auto" ? await env.CACHE.get(TRANSPORT_MEMO_KEY).catch(() => null) : null;
  const tryFetch = mode === "fetch" || (mode === "auto" && memo !== "socket");

  let fetchErr: unknown = null;
  if (tryFetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000) as unknown as number;
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      if (mode === "auto" && memo !== "fetch") {
        await env.CACHE.put(TRANSPORT_MEMO_KEY, "fetch", { expirationTtl: 21_600 }).catch(() => undefined);
      }
      return parse(res.status, await res.text());
    } catch (err) {
      fetchErr = err;
      if (mode === "fetch") {
        throw new ApiError(502, "kis_fetch_failed", { detail: String(err) });
      }
      // 다음 요청부터는 소켓으로 바로 간다(1시간).
      await env.CACHE.put(TRANSPORT_MEMO_KEY, "socket", { expirationTtl: 3600 }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  // fetch 가 비표준 포트에서 막히는 환경 → TLS 소켓 직결
  try {
    const res = await socketHttpRequest({
      host: cfg.host,
      port: cfg.port,
      method,
      path,
      headers,
      body,
      timeoutMs: 12000,
    });
    return parse(res.status, res.body);
  } catch (err) {
    throw new ApiError(502, "kis_unreachable", {
      fetchError: fetchErr ? String(fetchErr) : null,
      socketError: String(err),
    });
  }
}

/** 접근토큰 발급(KV 캐시). KIS는 토큰 재발급 호출 빈도를 제한하므로 캐시가 필수다. */
export async function kisToken(env: Env, cfg: KisConfig): Promise<string> {
  const keyId = cfg.appKey.slice(0, 8);
  const cacheKey = `kis:token:${cfg.isPaper ? "vts" : "prod"}:${keyId}`;
  const cachedRaw = (await env.CACHE.get(cacheKey, "json").catch(() => null)) as
    | { token: string; expiresAt: number }
    | null;
  if (cachedRaw && cachedRaw.expiresAt - Date.now() > 60_000) return cachedRaw.token;

  const body = JSON.stringify({
    grant_type: "client_credentials",
    appkey: cfg.appKey,
    appsecret: cfg.appSecret,
  });
  const res = await transportRequest(env, cfg, "POST", "/oauth2/tokenP", { "content-type": "application/json" }, body);
  const token = res.json["access_token"];
  if (res.status !== 200 || typeof token !== "string") {
    // 재발급 실패 시 만료 직전 토큰이라도 재사용
    if (cachedRaw && cachedRaw.expiresAt > Date.now()) return cachedRaw.token;
    const message = res.json["error_description"] ?? res.json["msg1"] ?? null;
    throw new ApiError(502, "kis_token_failed", {
      status: res.status,
      message,
      hint: cfg.isPaper
        ? "모의투자 도메인(29443)으로 호출했습니다. 실전 계좌 앱키라면 KIS_ENV=prod 로 바꿔야 합니다."
        : "실전 도메인(9443)으로 호출했습니다. 앱키·시크릿이 실전용인지, KIS Developers 에서 서비스 신청이 완료됐는지 확인하세요.",
    });
  }
  const expiresIn = num(res.json["expires_in"], 86400);
  const expiresAt = Date.now() + Math.max(600, expiresIn - 600) * 1000;
  await env.CACHE.put(cacheKey, JSON.stringify({ token, expiresAt }), {
    expirationTtl: Math.max(120, Math.floor((expiresAt - Date.now()) / 1000)),
  }).catch(() => undefined);
  return token;
}

async function hashkey(env: Env, cfg: KisConfig, body: Record<string, unknown>): Promise<string> {
  const res = await transportRequest(
    env,
    cfg,
    "POST",
    "/uapi/hashkey",
    {
      "content-type": "application/json; charset=utf-8",
      appkey: cfg.appKey,
      appsecret: cfg.appSecret,
    },
    JSON.stringify(body),
  );
  const hash = res.json["HASH"];
  if (typeof hash !== "string") {
    throw new ApiError(502, "kis_hashkey_failed", { status: res.status, detail: res.json });
  }
  return hash;
}

export async function kisCall(env: Env, cfg: KisConfig, call: KisCall): Promise<Record<string, unknown>> {
  const token = call.token ?? (await kisToken(env, cfg));
  const qs = call.query ? `?${new URLSearchParams(call.query).toString()}` : "";
  const bodyText = call.body ? JSON.stringify(call.body) : undefined;

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
    appkey: cfg.appKey,
    appsecret: cfg.appSecret,
    tr_id: call.trId,
    custtype: "P",
  };
  if (call.useHashkey && call.body) headers["hashkey"] = await hashkey(env, cfg, call.body);

  const res = await transportRequest(env, cfg, call.method, `${call.path}${qs}`, headers, bodyText);
  const rtCd = res.json["rt_cd"];
  if (res.status !== 200 || (typeof rtCd === "string" && rtCd !== "0")) {
    throw new ApiError(res.status === 200 ? 400 : res.status, "kis_api_error", {
      status: res.status,
      rt_cd: rtCd ?? null,
      msg_cd: res.json["msg_cd"] ?? null,
      msg: res.json["msg1"] ?? res.json["error_description"] ?? null,
      tr_id: call.trId,
    });
  }
  return res.json;
}

/* ── 조회 ─────────────────────────────────────────────────────────── */

export async function domesticPrice(env: Env, cfg: KisConfig, code: string) {
  const out = await kisCall(env, cfg, {
    method: "GET",
    path: "/uapi/domestic-stock/v1/quotations/inquire-price",
    trId: trId(env, "domestic.price", cfg.isPaper),
    query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
  });
  const o = (out["output"] ?? {}) as Record<string, string>;
  return {
    source: "KIS",
    code,
    price: num(o["stck_prpr"]),
    change: num(o["prdy_vrss"]),
    changePct: num(o["prdy_ctrt"]),
    open: num(o["stck_oprc"]),
    high: num(o["stck_hgpr"]),
    low: num(o["stck_lwpr"]),
    volume: num(o["acml_vol"]),
    per: num(o["per"]),
    pbr: num(o["pbr"]),
    upperLimit: num(o["stck_mxpr"]),
    lowerLimit: num(o["stck_llam"]),
    name: o["hts_kor_isnm"] ?? "",
  };
}

export async function overseasPrice(env: Env, cfg: KisConfig, excd: string, symb: string) {
  const out = await kisCall(env, cfg, {
    method: "GET",
    path: "/uapi/overseas-price/v1/quotations/price",
    trId: trId(env, "overseas.price", cfg.isPaper),
    query: { AUTH: "", EXCD: excd, SYMB: symb },
  });
  const o = (out["output"] ?? {}) as Record<string, string>;
  return {
    source: "KIS",
    code: symb,
    excd,
    price: num(o["last"]),
    change: num(o["diff"]),
    changePct: num(o["rate"]),
    open: num(o["open"]),
    high: num(o["high"]),
    low: num(o["low"]),
    volume: num(o["tvol"]),
    currency: o["curr"] ?? "",
  };
}

export interface Holding {
  symbol: string;
  name: string;
  qty: number;
  avgPrice: number;
  price: number;
  evalAmount: number;
  pnl: number;
  pnlPct: number;
  currency: string;
}

export async function domesticBalance(env: Env, cfg: KisConfig) {
  const out = await kisCall(env, cfg, {
    method: "GET",
    path: "/uapi/domestic-stock/v1/trading/inquire-balance",
    trId: trId(env, "domestic.balance", cfg.isPaper),
    query: {
      CANO: cfg.cano,
      ACNT_PRDT_CD: cfg.acntPrdtCd,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "00",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    },
  });
  const rows = (out["output1"] ?? []) as Record<string, string>[];
  const summaryRow = ((out["output2"] ?? []) as Record<string, string>[])[0] ?? {};
  const holdings: Holding[] = rows
    .filter((r) => num(r["hldg_qty"]) > 0)
    .map((r) => ({
      symbol: r["pdno"] ?? "",
      name: r["prdt_name"] ?? "",
      qty: num(r["hldg_qty"]),
      avgPrice: num(r["pchs_avg_pric"]),
      price: num(r["prpr"]),
      evalAmount: num(r["evlu_amt"]),
      pnl: num(r["evlu_pfls_amt"]),
      pnlPct: num(r["evlu_pfls_rt"]),
      currency: "KRW",
    }));
  return {
    market: "KRX",
    isPaper: cfg.isPaper,
    holdings,
    summary: {
      cash: num(summaryRow["dnca_tot_amt"]),
      orderableCash: num(summaryRow["prvs_rcdl_excc_amt"]),
      totalEval: num(summaryRow["tot_evlu_amt"]),
      stockEval: num(summaryRow["scts_evlu_amt"]),
      pnl: num(summaryRow["evlu_pfls_smtl_amt"]),
      currency: "KRW",
    },
  };
}

export async function overseasBalance(env: Env, cfg: KisConfig, excd: OrderMarket, currency: string) {
  const out = await kisCall(env, cfg, {
    method: "GET",
    path: "/uapi/overseas-stock/v1/trading/inquire-balance",
    trId: trId(env, "overseas.balance", cfg.isPaper),
    query: {
      CANO: cfg.cano,
      ACNT_PRDT_CD: cfg.acntPrdtCd,
      OVRS_EXCG_CD: excd,
      TR_CRCY_CD: currency,
      CTX_AREA_FK200: "",
      CTX_AREA_NK200: "",
    },
  });
  const rows = (out["output1"] ?? []) as Record<string, string>[];
  const summaryRow = (out["output2"] ?? {}) as Record<string, string>;
  const holdings: Holding[] = rows
    .filter((r) => num(r["ovrs_cblc_qty"]) > 0)
    .map((r) => ({
      symbol: r["ovrs_pdno"] ?? "",
      name: r["ovrs_item_name"] ?? "",
      qty: num(r["ovrs_cblc_qty"]),
      avgPrice: num(r["pchs_avg_pric"]),
      price: num(r["now_pric2"]),
      evalAmount: num(r["ovrs_stck_evlu_amt"]),
      pnl: num(r["frcr_evlu_pfls_amt"]),
      pnlPct: num(r["evlu_pfls_rt"]),
      currency: r["tr_crcy_cd"] ?? currency,
    }));
  return {
    market: excd,
    isPaper: cfg.isPaper,
    holdings,
    summary: {
      cash: num(summaryRow["frcr_pchs_amt1"]),
      orderableCash: num(summaryRow["frcr_pchs_amt1"]),
      totalEval: num(summaryRow["tot_evlu_pfls_amt"]),
      stockEval: num(summaryRow["ovrs_tot_pfls"]),
      pnl: num(summaryRow["ovrs_rlzt_pfls_amt"]),
      currency,
    },
  };
}

/**
 * 해외주식 매수가능금액 조회 — 통합증거금 계좌면 달러 예수금이 0이어도
 * 원화 예수금 기준으로 주문가능금액·수량이 잡힌다. "환전 없이 살 수 있나"의
 * 결정적 판정은 예수금이 아니라 이 값이다.
 */
export async function overseasPsamount(env: Env, cfg: KisConfig, excd: string, symb: string, price: number) {
  const out = await kisCall(env, cfg, {
    method: "GET",
    path: "/uapi/overseas-stock/v1/trading/inquire-psamount",
    trId: trId(env, "overseas.psamount", cfg.isPaper),
    query: {
      CANO: cfg.cano,
      ACNT_PRDT_CD: cfg.acntPrdtCd,
      OVRS_EXCG_CD: excd,
      OVRS_ORD_UNPR: String(price),
      ITEM_CD: symb,
    },
  });
  const o = (out["output"] ?? {}) as Record<string, string>;
  return {
    currency: o["tr_crcy_cd"] || "USD",
    /** 외화(달러) 예수금 기준 주문가능금액 */
    frcrOrderable: num(o["ord_psbl_frcr_amt"]),
    /** 통합증거금 포함 주문가능금액(외화 환산) — 원화로 살 수 있으면 여기에 잡힌다 */
    totalOrderable: num(o["ovrs_ord_psbl_amt"]),
    /** 환전 후 주문가능금액 */
    afterExchangeOrderable: num(o["echm_af_ord_psbl_amt"]),
    /** 이 종목을 지금 가격에 살 수 있는 최대 수량 */
    maxQty: num(o["ovrs_max_ord_psbl_qty"] || o["max_ord_psbl_qty"]),
    fx: num(o["exrt"]),
  };
}

/* ── 주문 ─────────────────────────────────────────────────────────── */

export interface OrderRequest {
  market: OrderMarket;
  code: string;
  side: OrderSide;
  qty: number;
  /** 지정가 가격. 시장가면 0 */
  price: number;
  /** "limit" | "market" */
  orderType: "limit" | "market";
  /** 원화 환산 주문금액(한도 검증용) */
  notionalKrw: number;
}

export function assertOrderAllowed(env: Env, cfg: KisConfig, req: OrderRequest): void {
  // 검증 모드는 KIS에 아무것도 보내지 않으므로 주문 스위치 없이도 점검할 수 있게 한다.
  // 값 검증(수량·가격·한도·시장)은 실주문과 동일하게 통과해야 한다.
  if (!isDryRun(env)) {
    if ((env.ORDER_ENABLED ?? "false").toLowerCase() !== "true") {
      throw new ApiError(403, "orders_disabled", {
        hint: "주문 기능이 꺼져 있습니다. ORDER_ENABLED=true 로 배포해야 주문이 전송됩니다.",
      });
    }
    if (!cfg.isPaper && (env.ORDER_ALLOW_REAL ?? "false").toLowerCase() !== "true") {
      throw new ApiError(403, "real_orders_blocked", {
        hint: "실전투자 주문은 ORDER_ALLOW_REAL=true 를 함께 설정해야 허용됩니다.",
      });
    }
  }
  if (!Number.isInteger(req.qty) || req.qty <= 0) throw new ApiError(400, "invalid_qty");
  if (req.orderType === "limit" && !(req.price > 0)) throw new ApiError(400, "invalid_price");
  if (req.market !== "KRX" && req.orderType === "market") {
    throw new ApiError(400, "overseas_market_order_unsupported", {
      hint: "해외주식은 지정가 주문만 지원합니다.",
    });
  }
  const limit = num(env.MAX_ORDER_NOTIONAL_KRW, 100_000);
  if (req.notionalKrw > limit) {
    throw new ApiError(400, "order_limit_exceeded", {
      hint: `1회 주문 한도 ${limit.toLocaleString("ko-KR")}원을 초과했습니다(요청 ${Math.round(req.notionalKrw).toLocaleString("ko-KR")}원).`,
    });
  }
}

export interface OrderResult {
  ok: true;
  /** true 면 검증만 수행하고 KIS에 주문을 보내지 않았다 */
  dryRun?: boolean;
  isPaper: boolean;
  market: OrderMarket;
  code: string;
  side: OrderSide;
  qty: number;
  price: number;
  orderNo: string;
  orgNo: string;
  orderTime: string;
  message: string;
  trId: string;
}

export function isDryRun(env: Env): boolean {
  return (env.ORDER_DRY_RUN ?? "false").toLowerCase() === "true";
}

export async function placeOrder(env: Env, cfg: KisConfig, req: OrderRequest): Promise<OrderResult> {
  assertOverseasAllowed(env, req.market);
  assertOrderAllowed(env, cfg, req);
  const tr = trId(env, orderTridKey(req.market, req.side), cfg.isPaper);

  // 검증 모드: 토큰 발급까지 실제로 해서 연결·인증·한도·TR_ID를 확인하고 주문은 보내지 않는다.
  // 실전 계좌만 있는 경우 위험 없이 전 과정을 점검하는 용도다.
  if (isDryRun(env)) {
    await kisToken(env, cfg); // 인증이 실제로 되는지 확인
    return {
      ok: true,
      dryRun: true,
      isPaper: cfg.isPaper,
      market: req.market,
      code: req.code,
      side: req.side,
      qty: req.qty,
      price: req.price,
      orderNo: "",
      orgNo: "",
      orderTime: "",
      message: `검증 모드(ORDER_DRY_RUN=true) — 주문을 전송하지 않았습니다. 실제로는 ${
        cfg.isPaper ? "모의" : "실전"
      } ${req.market} ${req.code} ${req.side === "buy" ? "매수" : "매도"} ${req.qty}주 (tr_id ${tr}) 가 전송됩니다.`,
      trId: tr,
    };
  }

  let out: Record<string, unknown>;
  if (req.market === "KRX") {
    out = await kisCall(env, cfg, {
      method: "POST",
      path: "/uapi/domestic-stock/v1/trading/order-cash",
      trId: tr,
      useHashkey: true,
      body: {
        CANO: cfg.cano,
        ACNT_PRDT_CD: cfg.acntPrdtCd,
        PDNO: req.code,
        ORD_DVSN: req.orderType === "market" ? "01" : "00",
        ORD_QTY: String(req.qty),
        ORD_UNPR: req.orderType === "market" ? "0" : String(req.price),
      },
    });
  } else {
    /* 주문 TR 의 미국 거래소 코드는 4자리(NASD/NYSE/AMEX)다 — 시세·잔고의 3자리
     * (NAS/NYS/AMS)와 다르다. psamount 도 4자리를 쓴다(위 overseasReadiness 실측). */
    const ORDER_EXCG: Partial<Record<OrderMarket, string>> = { NAS: "NASD", NYS: "NYSE", AMS: "AMEX" };
    out = await kisCall(env, cfg, {
      method: "POST",
      path: "/uapi/overseas-stock/v1/trading/order",
      trId: tr,
      useHashkey: true,
      body: {
        CANO: cfg.cano,
        ACNT_PRDT_CD: cfg.acntPrdtCd,
        OVRS_EXCG_CD: ORDER_EXCG[req.market] ?? req.market,
        PDNO: req.code,
        ORD_QTY: String(req.qty),
        OVRS_ORD_UNPR: String(req.price),
        ORD_SVR_DVSN_CD: "0",
        ORD_DVSN: "00",
      },
    });
  }

  const o = (out["output"] ?? {}) as Record<string, string>;
  return {
    ok: true,
    isPaper: cfg.isPaper,
    market: req.market,
    code: req.code,
    side: req.side,
    qty: req.qty,
    price: req.price,
    orderNo: o["ODNO"] ?? "",
    orgNo: o["KRX_FWDG_ORD_ORGNO"] ?? "",
    orderTime: o["ORD_TMD"] ?? "",
    message: String(out["msg1"] ?? "주문 접수"),
    trId: tr,
  };
}

/** 국내 주식 주문 취소 */
export async function cancelDomesticOrder(
  env: Env,
  cfg: KisConfig,
  params: { orgNo: string; orderNo: string; qty: number; all: boolean },
): Promise<Record<string, unknown>> {
  if ((env.ORDER_ENABLED ?? "false").toLowerCase() !== "true") {
    throw new ApiError(403, "orders_disabled");
  }
  const out = await kisCall(env, cfg, {
    method: "POST",
    path: "/uapi/domestic-stock/v1/trading/order-rvsecncl",
    trId: trId(env, "domestic.cancel", cfg.isPaper),
    useHashkey: true,
    body: {
      CANO: cfg.cano,
      ACNT_PRDT_CD: cfg.acntPrdtCd,
      KRX_FWDG_ORD_ORGNO: params.orgNo,
      ORGN_ODNO: params.orderNo,
      ORD_DVSN: "00",
      RVSE_CNCL_DVSN_CD: "02", // 02 = 취소
      ORD_QTY: String(params.qty),
      ORD_UNPR: "0",
      QTY_ALL_ORD_YN: params.all ? "Y" : "N",
    },
  });
  return out;
}

/**
 * 시크릿 값을 노출하지 않으면서 흔한 입력 실수를 잡아내는 진단.
 * (마스킹된 `****` 값 붙여넣기, 공백 포함, 계좌번호 형식 오류)
 * 길이·불리언만 돌려주며 값 자체는 절대 반환하지 않는다.
 */
function secretChecks(env: Env) {
  const key = env.KIS_APP_KEY ?? "";
  const secret = env.KIS_APP_SECRET ?? "";
  const account = (env.KIS_ACCOUNT ?? "").trim();
  const bad = (v: string) => v.includes("*") || v.includes(" ") || v.includes("\n");
  return {
    appKeyLength: key.length,
    appSecretLength: secret.length,
    // KIS 앱키는 36자, 시크릿은 180자 내외다. 크게 벗어나면 잘린 값일 가능성이 높다.
    appKeyLooksValid: key.length >= 30 && !bad(key),
    appSecretLooksValid: secret.length >= 100 && !bad(secret),
    accountFormatOk: /^\d{8}-?\d{2}$/.test(account),
    maskedValueDetected: bad(key) || bad(secret),
  };
}

export function kisStatus(env: Env) {
  const configured = kisConfigured(env);
  const isPaper = (env.KIS_ENV ?? "vts").toLowerCase() !== "prod";
  const overseas = overseasCapability(env);
  return {
    checks: configured ? secretChecks(env) : null,
    overseasEnabled: overseas.allowed,
    overseasReason: overseas.reason,
    configured,
    tradeTokenSet: Boolean(env.TRADE_TOKEN),
    env: isPaper ? "vts" : "prod",
    envKo: isPaper ? "모의투자" : "실전투자",
    ordersEnabled: (env.ORDER_ENABLED ?? "false").toLowerCase() === "true",
    realOrdersAllowed: (env.ORDER_ALLOW_REAL ?? "false").toLowerCase() === "true",
    maxOrderNotionalKrw: num(env.MAX_ORDER_NOTIONAL_KRW, 100_000),
    dryRun: isDryRun(env),
    transport: (env.KIS_TRANSPORT ?? "auto").toLowerCase(),
  };
}
