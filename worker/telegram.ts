/**
 * 텔레그램 공지 — 봇이 그룹 채팅방에 오늘의 스윙 관점과 주요 변화를 올린다.
 *
 * 구조: 이 워커의 크론 → Telegram Bot API(sendMessage) → 봇이 참여한 그룹방.
 * 외부 서버가 필요 없다. 이미 크론·KV·데이터가 여기 다 있기 때문이다.
 *
 * 원칙 세 가지 — 단톡방은 사람이 매일 읽는 곳이라 더 엄격하게 잡는다.
 *  ① **면책 문구를 매 메시지에 붙인다.** 종목 이야기를 반복 발신하는 채널이라 빠뜨리면 안 된다.
 *  ② **같은 내용을 두 번 보내지 않는다.** 발송 이력을 KV 에 남기고 id 로 거른다 —
 *     크론은 여러 번 도는데 그때마다 같은 공지가 나가면 그냥 스팸이다.
 *  ③ **하루 발송 상한을 둔다.** 이벤트가 쏟아지는 날 방을 도배하지 않도록.
 *
 * 넣지 않는 것: 실계좌 잔고·손익·주문(운영자 전용), 수익 약속, 목표 수익률.
 */
import type { Env } from "./env";
import { dailyBrief } from "./brief";
import { getFeed } from "./feed";
import { buildShowcase } from "./showcase";
import { sceneShots, type ShotRequest } from "./shot";

const API = "https://api.telegram.org";
const SITE = "https://stockontology.cc";
const SENT_KEY = "tg:sent:v1";
const SENT_TTL = 7 * 86_400;
/** 하루 최대 발송 — 정기 공지 1건 + 이벤트 공지 몇 건 */
const DAILY_CAP = 4;
const DISCLAIMER = "공개 데이터 기반 자동 분석이며 투자 자문·권유가 아닙니다. 투자 판단과 책임은 본인에게 있습니다.";

export interface TgResult { ok: boolean; sent: string[]; skipped: string[]; error?: string }

/**
 * 공지 대상 — 쉼표로 여러 곳을 넣을 수 있다("@채널,-100123...").
 * 채널은 공지가 안 묻히고 링크로 뿌리기 좋고, 그룹은 슬래시 명령이 먹는다.
 * 둘 중 하나를 고를 이유가 없어서 둘 다 보낼 수 있게 뒀다(2026-09-09).
 */
export function tgTargets(env: Env): string[] {
  return String(env.TELEGRAM_CHAT_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** HTML 파스모드에서 깨지지 않게 — 텔레그램은 &, <, > 만 이스케이프하면 된다 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const kstDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

interface SentLog { day: string; ids: string[] }

async function loadSent(env: Env): Promise<SentLog> {
  const raw = (await env.CACHE.get(SENT_KEY, "json").catch(() => null)) as SentLog | null;
  if (!raw || raw.day !== kstDay()) return { day: kstDay(), ids: [] };
  return raw;
}

async function saveSent(env: Env, log: SentLog): Promise<void> {
  await env.CACHE.put(SENT_KEY, JSON.stringify({ day: log.day, ids: log.ids.slice(-100) }), { expirationTtl: SENT_TTL }).catch(() => undefined);
}

/** 한 건 전송. 토큰·방 번호가 없으면 보내지 않고 그대로 알린다(조용히 실패하지 않는다). */
export async function tgSend(env: Env, text: string): Promise<{ ok: boolean; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const targets = tgTargets(env);
  if (!token || !targets.length) return { ok: false, error: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 가 설정되지 않았습니다" };
  let lastError: string | undefined;
  let anyOk = false;
  for (const chatId of targets) {
    try {
      const res = await fetch(`${API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          // 링크 미리보기가 붙으면 공지가 길어져 방이 지저분해진다
          link_preview_options: { is_disabled: true },
        }),
      });
      // 한 곳이 실패해도 나머지에는 보낸다 — 방 하나 때문에 전체 공지를 접지 않는다
      if (res.ok) anyOk = true;
      else lastError = `${chatId}: telegram ${res.status} ${(await res.text()).slice(0, 120)}`;
    } catch (e) {
      lastError = `${chatId}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: anyOk, error: anyOk ? undefined : lastError };
}

/** 사진 한 장 — 캡션은 텔레그램 상한이 1024자라 본문보다 짧게 넣는다 */
/**
 * 여러 장을 한 묶음(앨범)으로 보낸다 — 낱장으로 네 번 올리면 방이 지저분해지고,
 * 텔레그램 알림도 네 번 울린다. 캡션은 첫 장에만 붙이는 게 텔레그램 규칙이다.
 * `to` 를 주면 그 방에만(명령 응답), 안 주면 등록된 모든 대상에(정기 공지).
 */
export async function tgSendAlbum(
  env: Env,
  photos: { png: ArrayBuffer; caption?: string }[],
  to?: string | number,
): Promise<{ ok: boolean; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const targets = to !== undefined ? [String(to)] : tgTargets(env);
  const items = photos.slice(0, 10); // 텔레그램 앨범 상한
  if (!token || !targets.length) return { ok: false, error: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 가 설정되지 않았습니다" };
  if (!items.length) return { ok: false, error: "보낼 이미지가 없습니다" };
  if (items.length === 1) return tgSendPhoto(env, items[0].png, items[0].caption ?? "", to);

  let lastError: string | undefined;
  let anyOk = false;
  for (const chatId of targets) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("media", JSON.stringify(items.map((p, i) => ({
        type: "photo",
        media: `attach://p${i}`,
        // 앨범 캡션은 1024자 상한이고, 두 번째 장부터는 열어 봐야 보인다 — 첫 장에 몰아 쓴다
        ...(p.caption ? { caption: p.caption.slice(0, 1000), parse_mode: "HTML" } : {}),
      }))));
      items.forEach((p, i) => form.append(`p${i}`, new Blob([p.png], { type: "image/png" }), `scene${i}.png`));
      const res = await fetch(`${API}/bot${token}/sendMediaGroup`, { method: "POST", body: form });
      if (res.ok) anyOk = true;
      else lastError = `${chatId}: telegram ${res.status} ${(await res.text()).slice(0, 120)}`;
    } catch (e) {
      lastError = `${chatId}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: anyOk, error: anyOk ? undefined : lastError };
}

export async function tgSendPhoto(env: Env, png: ArrayBuffer, caption: string, to?: string | number): Promise<{ ok: boolean; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const targets = to !== undefined ? [String(to)] : tgTargets(env);
  if (!token || !targets.length) return { ok: false, error: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 가 설정되지 않았습니다" };
  let lastError: string | undefined;
  let anyOk = false;
  for (const chatId of targets) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption.slice(0, 1000));
      form.append("parse_mode", "HTML");
      form.append("photo", new Blob([png], { type: "image/png" }), "chart.png");
      const res = await fetch(`${API}/bot${token}/sendPhoto`, { method: "POST", body: form });
      if (res.ok) anyOk = true;
      else lastError = `${chatId}: telegram ${res.status} ${(await res.text()).slice(0, 120)}`;
    } catch (e) {
      lastError = `${chatId}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: anyOk, error: anyOk ? undefined : lastError };
}

/* ── 메시지 만들기 ─────────────────────────────── */

/** 공지에 함께 붙일 차트 — 상위 몇 종목의 scene.svg 를 PNG 로 찍는다 */
export async function sendPickCharts(env: Env, market: "KR" | "US", picks: { code?: string; symbol: string | null; name: string; priceLabel: string; nearestSupport: number | null; nearestResistance: number | null }[], max = 2): Promise<string[]> {
  const cur = market === "US" ? "$" : "원";

  /* 차트 낱장만 보내면 "이 종목이 왜 뽑혔는지"가 그림에 없다 — 스윙 목록·삼합 순위·
   * 수급 순위 표를 앞에 세우고 그 뒤에 종목 차트를 붙인다. 앨범 한 묶음이라 알림도 한 번. */
  const reqs: ShotRequest[] = [
    { view: "swing", market, caption: "" },
    { view: "combo", market, caption: "" },
    { view: "flow", market, caption: "" },
  ];
  for (const p of picks.slice(0, max)) {
    const code = p.code ?? (p.symbol ?? "").split(".")[0];
    if (!code) continue;
    const sup = p.nearestSupport ? ` · 지지 ${p.nearestSupport.toLocaleString("ko-KR")}${cur}` : "";
    const res = p.nearestResistance ? ` · 저항 ${p.nearestResistance.toLocaleString("ko-KR")}${cur}` : "";
    reqs.push({ view: `chart:${code}`, market, caption: `${esc(p.name)} ${esc(p.priceLabel)}${esc(sup)}${esc(res)}` });
  }

  const shots = await sceneShots(env, reqs);
  if (!shots.length) return [];
  // 앨범 캡션은 첫 장에만 보인다 — 한 줄 요약을 거기 몰아 쓰고 나머지는 비워 둔다
  const head = `<b>오늘의 분석</b> — 스윙 목록 · 삼합 순위 · 수급 순위 · 상위 종목 일봉 (${shots.length}장)`;
  const r = await tgSendAlbum(env, shots.map((s, i) => ({ png: s.png, caption: i === 0 ? head : s.caption })));
  return r.ok ? shots.map((s) => s.view) : [];
}

interface BriefForTg {
  date?: string;
  regime: { label: string };
  targetSession: string;
  sessionClosed: boolean;
  basis: string;
  swing: {
    headlineKo: string;
    picks: {
      name: string; symbol: string | null; sector: string | null; priceLabel: string;
      appearances: number; independentCount: number; whyKo: string | null;
      nearestSupport: number | null; nearestSupportLabel: string | null; toSupportPct: number | null;
      nearestResistance: number | null; nearestResistanceLabel: string | null; toResistancePct: number | null;
    }[];
  };
}

/** 정기 공지 — 하루 한 번, 마감 뒤. 스윙 관점 목록이 본문이다. */
export async function buildDailyMessage(env: Env, market: "KR" | "US"): Promise<{ id: string; text: string } | null> {
  const res = (await dailyBrief(env, market)) as { date?: string; briefs: BriefForTg[] };
  const b = res.briefs[0];
  if (!b || !b.swing.picks.length) return null;
  const cur = market === "US" ? "$" : "원";
  const mk = market === "US" ? "미국" : "한국";
  const day = res.date ?? kstDay();

  const lines: string[] = [];
  lines.push(`<b>📊 ${esc(mk)} 스윙 관점 · ${esc(day)}</b>`);
  lines.push(`${esc(b.regime.label)}`);
  lines.push(`다음 거래일 <b>${esc(b.targetSession)}</b> 기준 · ${b.sessionClosed ? "마감 데이터" : "장중 데이터(숫자가 계속 바뀝니다)"}`);
  lines.push("");
  lines.push(esc(b.swing.headlineKo));
  lines.push("");

  b.swing.picks.forEach((p, i) => {
    const agree = p.independentCount >= 2 ? ` · <b>독립 ${p.independentCount}개 일치</b>` : "";
    lines.push(`<b>${i + 1}. ${esc(p.name)}</b> <code>${esc(p.symbol ?? "")}</code> ${esc(p.priceLabel)}`);
    lines.push(`   ${p.appearances + 1}거래일째 유지${agree}${p.sector ? ` · ${esc(p.sector)}` : ""}`);
    if (p.whyKo) lines.push(`   💡 ${esc(p.whyKo)}`);
    const sup = p.nearestSupport ? `지지 ${esc(p.nearestSupportLabel ?? "")} ${p.nearestSupport.toLocaleString("ko-KR")}${cur}(${p.toSupportPct}%)` : null;
    const resv = p.nearestResistance ? `저항 ${p.nearestResistance.toLocaleString("ko-KR")}${cur}(+${p.toResistancePct}%)` : null;
    if (sup || resv) lines.push(`   📐 ${[sup, resv].filter(Boolean).join(" / ")}`);
    lines.push("");
  });

  lines.push(`🔗 ${SITE}`);
  lines.push(`<i>${esc(DISCLAIMER)}</i>`);
  return { id: `tg_daily_${market}_${day}`, text: lines.join("\n") };
}

/** 이벤트 공지 — "왜 하필 지금인가"가 있는 변화만. 우선순위 높은 것부터 몇 건. */
export async function buildEventMessages(env: Env, market: "KR" | "US", minPriority = 0.8, max = 2): Promise<{ id: string; text: string }[]> {
  const feed = await getFeed(env, market, { limit: 20 });
  const cur = market === "US" ? "$" : "원";
  return feed.events
    .filter((e) => e.priority >= minPriority)
    .slice(0, max)
    .map((e) => {
      const price = e.price ? ` ${e.price.toLocaleString("ko-KR")}${cur}${e.changePct !== null ? ` (${e.changePct >= 0 ? "+" : ""}${e.changePct.toFixed(1)}%)` : ""}` : "";
      const text = [
        `<b>⚡ ${esc(e.headlineKo)}</b>`,
        `<b>${esc(e.name)}</b>${e.symbol ? ` <code>${esc(e.symbol)}</code>` : ""}${price}${e.sector ? ` · ${esc(e.sector)}` : ""}`,
        "",
        esc(e.whyNowKo),
        "",
        `${esc(feed.sessionKo)}`,
        `🔗 ${SITE}`,
        `<i>${esc(DISCLAIMER)}</i>`,
      ].join("\n");
      return { id: `tg_${e.id}`, text };
    });
}

/** 시스템 소개 — 방에 처음 붙일 때 한 번 쓰는 고정 안내(수동 호출용) */
export function buildIntroMessage(): { id: string; text: string } {
  const sc = buildShowcase();
  const text = [
    "<b>📌 이 방은 무엇을 올리나요</b>",
    "",
    esc(sc.oneLinerKo),
    "",
    ...sc.factsKo.map((f) => `• ${esc(f)}`),
    "",
    `🔗 ${SITE}`,
    `<i>${esc(sc.disclaimerKo)}</i>`,
  ].join("\n");
  return { id: `tg_intro_${kstDay()}`, text };
}

/* ── 발송 ─────────────────────────────── */

/**
 * 공지 발송 — 크론과 수동 엔드포인트가 함께 쓴다.
 * dryRun 이면 만들기만 하고 보내지 않는다(문구 점검용).
 */
export async function tgAnnounce(env: Env, opts: {
  market: "KR" | "US";
  kind: "daily" | "events" | "intro";
  dryRun?: boolean;
  force?: boolean;
}): Promise<TgResult & { preview?: string[] }> {
  if (env.TELEGRAM_ENABLED === "false") return { ok: false, sent: [], skipped: [], error: "TELEGRAM_ENABLED=false 로 꺼져 있습니다" };

  const msgs = opts.kind === "daily"
    ? [await buildDailyMessage(env, opts.market)].filter(Boolean) as { id: string; text: string }[]
    : opts.kind === "intro"
      ? [buildIntroMessage()]
      : await buildEventMessages(env, opts.market);

  if (!msgs.length) return { ok: true, sent: [], skipped: [], preview: [] };
  if (opts.dryRun) return { ok: true, sent: [], skipped: msgs.map((m) => m.id), preview: msgs.map((m) => m.text) };

  const log = await loadSent(env);
  const sent: string[] = [];
  const skipped: string[] = [];
  let error: string | undefined;

  for (const m of msgs) {
    if (!opts.force && log.ids.includes(m.id)) { skipped.push(`${m.id}(중복)`); continue; }
    if (!opts.force && log.ids.length >= DAILY_CAP) { skipped.push(`${m.id}(하루 상한 ${DAILY_CAP}건)`); continue; }
    const r = await tgSend(env, m.text);
    if (r.ok) { sent.push(m.id); log.ids.push(m.id); } else { skipped.push(`${m.id}(실패)`); error = r.error; break; }
  }
  /* 정기 공지에는 상위 2종목 차트를 함께 붙인다 — "숫자만 있고 그림이 없다"는 지적(2026-09-09).
   * 이미지 실패는 공지 자체를 막지 않는다(텍스트는 이미 나갔다). */
  if (!error && sent.length && opts.kind === "daily") {
    const res = (await dailyBrief(env, opts.market)) as { briefs: BriefForTg[] };
    const picks = res.briefs[0]?.swing.picks ?? [];
    const shots = await sendPickCharts(env, opts.market, picks.map((p) => ({ ...p, code: undefined })));
    sent.push(...shots);
  }

  if (sent.length) await saveSent(env, log);
  return { ok: !error, sent, skipped, error };
}

/**
 * 크론에서 부르는 진입점 — 한국 마감 뒤(16시 KST) 정기 공지, 그 외 시각엔 이벤트 공지.
 * 실패해도 다른 크론 작업을 막지 않는다(호출부에서 catch).
 */
export async function tgCron(env: Env): Promise<TgResult> {
  if (env.TELEGRAM_ENABLED !== "true") return { ok: true, sent: [], skipped: ["TELEGRAM_ENABLED 가 true 가 아닙니다"] };
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
  if (weekday === "Sat" || weekday === "Sun") return { ok: true, sent: [], skipped: ["주말"] };

  // 16시대 = 한국장 마감 정리 후. 하루 한 번만 나가도록 id 로 걸러진다.
  if (hhmm >= "16:00" && hhmm < "17:00") return tgAnnounce(env, { market: "KR", kind: "daily" });
  // 장중에는 큰 변화만 — 우선순위 0.8 이상, 하루 상한 안에서
  if (hhmm >= "09:00" && hhmm < "15:30") return tgAnnounce(env, { market: "KR", kind: "events" });
  return { ok: true, sent: [], skipped: ["공지 시각 아님"] };
}
