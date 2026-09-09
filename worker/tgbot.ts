/**
 * 텔레그램 명령 처리 — 방에서 봇에게 직접 지시한다.
 *
 * 크론 공지만 있으면 "정해진 시각에 나오는 것"만 볼 수 있다. 궁금할 때 바로 물어보려면
 * 방에서 명령을 칠 수 있어야 하고, 그러려면 텔레그램이 우리 워커를 호출해야 한다(webhook).
 *
 * 보안: setWebhook 에 넘긴 secret_token 을 텔레그램이 헤더로 되돌려 준다. 그 값이 맞을 때만
 * 처리한다 — 이 주소는 공개 URL 이라 누구나 POST 할 수 있기 때문이다.
 * 무거운 작업(차트 이미지)은 등록된 방에서만 — 아무 방에서나 되면 렌더 비용이 샌다.
 */
import type { Env } from "./env";
import { dailyBrief } from "./brief";
import { comboRank, quantRank } from "./quant";
import { getFeed } from "./feed";
import { stockBundle } from "./bundle";
import { buildDailyMessage, tgAnnounce, tgSendPhoto, tgTargets } from "./telegram";
import { sceneShot } from "./shot";
import { CODE_TO_NAME } from "./symbols";

const API = "https://api.telegram.org";
const DISCLAIMER = "공개 데이터 기반 자동 분석이며 투자 자문·권유가 아닙니다.";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HELP = [
  "<b>쓸 수 있는 명령</b>",
  "",
  "/추천 — 오늘 스윙 관점 종목 (삼합 종합 순위·업종 분산)",
  "/삼합 — 온톨로지+수급+차트 종합 순위 상위 8",
  "/수급 — 자금흐름·매집·거래대금 순위 상위 8",
  "/지금 — 방금 일어난 변화(합의 형성·급증·돌파 등)",
  "/종목 삼성전자 — 그 종목 판정·매매 플랜·차트 이미지",
  "/공지 — 정기 공지를 지금 채널에 올리기(차트 이미지 포함)",
  "/도움 — 이 목록",
  "",
  `<i>${DISCLAIMER}</i>`,
].join("\n");

async function reply(env: Env, chatId: number | string, text: string): Promise<void> {
  await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  }).catch(() => undefined);
}

/** 이름·코드 아무거나 받아 6자리 코드로 — "삼성전자" 처럼 한글 이름도 찾는다 */
function findCode(q: string): string | null {
  const raw = q.trim();
  if (!raw) return null;
  if (/^\d{6}$/.test(raw) || /^[A-Z.]{1,10}$/i.test(raw)) return raw.toUpperCase();
  const norm = raw.replace(/\s+/g, "");
  for (const [code, name] of CODE_TO_NAME) {
    if (name.replace(/\s+/g, "") === norm) return code;
  }
  for (const [code, name] of CODE_TO_NAME) {
    if (name.replace(/\s+/g, "").includes(norm)) return code;
  }
  return null;
}

async function cmdCombo(env: Env): Promise<string> {
  const r = await comboRank(env, {}, 8, "KR");
  const lines = [`<b>🔀 삼합 종합 순위</b> <i>(온톨로지 ${r.weights.onto}% · 수급 ${r.weights.flow}% · 차트 ${r.weights.chart}%)</i>`, ""];
  r.rows.forEach((x, i) => {
    lines.push(`${i + 1}. <b>${esc(x.name)}</b> ${x.price.toLocaleString("ko-KR")}원 · <b>${x.total >= 0 ? "+" : ""}${x.total.toFixed(2)}</b>`);
    lines.push(`   ${esc(x.sector || "미분류")} · 온톨 ${x.onto ?? "-"} 수급 ${x.flow ?? "-"} 차트 ${x.chart ?? "-"}`);
  });
  lines.push("", `<i>${DISCLAIMER}</i>`);
  return lines.join("\n");
}

async function cmdFlow(env: Env): Promise<string> {
  const r = await quantRank(env, "flow", 8, "KR");
  const lines = ["<b>💰 수급 순위</b> <i>(자금흐름·매집·거래대금)</i>", ""];
  r.rows.forEach((x, i) => {
    lines.push(`${i + 1}. <b>${esc(x.name)}</b> ${x.price.toLocaleString("ko-KR")}원 (${x.changePct >= 0 ? "+" : ""}${x.changePct.toFixed(1)}%) · <b>${x.score.toFixed(2)}</b>`);
    lines.push(`   ${esc(x.reasons[0]?.text ?? "")}`);
  });
  lines.push("", `<i>${DISCLAIMER}</i>`);
  return lines.join("\n");
}

async function cmdFeed(env: Env): Promise<string> {
  const f = await getFeed(env, "KR", { limit: 5 });
  if (!f.events.length) return `지금은 새로 잡힌 변화가 없습니다. (${esc(f.sessionKo)})`;
  const lines = [`<b>⚡ 방금 일어난 변화</b> <i>(${esc(f.sessionKo)})</i>`, ""];
  for (const e of f.events) {
    lines.push(`<b>${esc(e.name)}</b> — ${esc(e.headlineKo)}`);
    lines.push(`   ${esc(e.whyNowKo)}`);
    lines.push("");
  }
  lines.push(`<i>${DISCLAIMER}</i>`);
  return lines.join("\n");
}

async function cmdStock(env: Env, query: string): Promise<{ text: string; code: string | null }> {
  const code = findCode(query);
  if (!code) return { text: `"${esc(query)}" 를 찾지 못했습니다. 종목명이나 6자리 코드로 다시 넣어 주세요.`, code: null };
  const b = await stockBundle(env, code);
  const p = b.plan;
  const cur = b.market === "US" ? "$" : "원";
  const lines = [
    `<b>${esc(b.name)}</b> <code>${esc(b.symbol)}</code> ${esc(b.priceLabel)} (${b.changePct >= 0 ? "+" : ""}${b.changePct.toFixed(1)}%)`,
    `${esc(b.sector ?? "미분류")} · ${esc(b.sessionKo)}`,
    "",
  ];
  if (b.why.macroKo) lines.push(`💡 ${esc(b.why.macroKo)}`);
  if (b.why.flowKo) lines.push(`💰 ${esc(b.why.flowKo)}`);
  lines.push(`📊 ${esc(b.why.chartKo)}`);
  lines.push("");
  lines.push(`<b>매매 플랜 — ${esc(p.biasKo)}</b> (${esc(p.gradeKo)})`);
  lines.push(`진입 ${p.entry.low.toLocaleString("ko-KR")}~${p.entry.high.toLocaleString("ko-KR")}${cur}`);
  lines.push(`손절 ${p.stop.price.toLocaleString("ko-KR")}${cur} (${p.stop.pct}%) · 목표 ${p.targets[0].price.toLocaleString("ko-KR")}${cur} (+${p.targets[0].pct}%)`);
  lines.push(`손익비 ${p.rr.toFixed(2)} · ${esc(p.invalidation)}`);
  lines.push("", `<i>${DISCLAIMER}</i>`);
  return { text: lines.join("\n"), code };
}

/** 텔레그램 업데이트 한 건 처리 — 명령이 아니면 조용히 넘긴다(잡담에 끼어들지 않는다) */
export async function handleTelegramUpdate(env: Env, update: unknown): Promise<{ handled: string | null }> {
  const raw = update as {
    message?: { text?: string; chat?: { id: number; type?: string; title?: string; username?: string } };
    channel_post?: { text?: string; chat?: { id: number; type?: string; title?: string; username?: string } };
  };
  // 채널은 message 가 아니라 channel_post 로 온다 — 설치할 때 채널 id 를 잡으려면 둘 다 봐야 한다
  const u = { message: raw.message ?? raw.channel_post };
  const text = u.message?.text?.trim();
  const chatId = u.message?.chat?.id;
  if (chatId === undefined) return { handled: null };

  /* 방 번호를 기록해 둔다 — 설치할 때 chat_id 를 찾는 유일한 방법이다.
   * 웹훅을 걸면 getUpdates 가 막히기 때문에, 방에서 아무 말이나 하면 여기 남게 해 둔다. */
  await env.CACHE.put("tg:lastchat", JSON.stringify({
    id: chatId,
    type: u.message?.chat?.type ?? null,
    title: u.message?.chat?.title ?? null,
    username: u.message?.chat?.username ?? null,
    at: Date.now(),
  }), { expirationTtl: 86_400 }).catch(() => undefined);

  if (!text) return { handled: null };

  // "/추천@stockontologybot" 처럼 봇 이름이 붙어 오는 경우가 있다
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0];
  const arg = rest.join(" ");
  /* 공개 채널은 @username 으로 지정할 수 있다(인원 증가로 숫자 id 가 바뀌어도 안 끊긴다).
   * 그 경우 들어온 숫자 id 와 설정값이 달라지므로, username 도 함께 비교한다. */
  const homes = tgTargets(env).map((t) => t.toLowerCase());
  const uname = u.message?.chat?.username ? `@${u.message.chat.username}`.toLowerCase() : "";
  const isHome = homes.includes(String(chatId)) || (uname !== "" && homes.includes(uname));

  try {
    if (cmd === "/도움" || cmd === "/help" || cmd === "/start") { await reply(env, chatId, HELP); return { handled: cmd }; }

    if (cmd === "/추천" || cmd === "/picks") {
      const m = await buildDailyMessage(env, "KR");
      await reply(env, chatId, m?.text ?? "오늘 스윙 목록을 만들지 못했습니다.");
      return { handled: cmd };
    }
    if (cmd === "/공지" || cmd === "/announce") {
      if (!isHome) { await reply(env, chatId, "이 명령은 등록된 채널·방에서만 씁니다."); return { handled: cmd }; }
      const r = await tgAnnounce(env, { market: "KR", kind: "daily", force: true });
      await reply(env, chatId, r.ok ? `공지 완료 — ${r.sent.join(", ") || "보낸 항목 없음"}` : `실패: ${esc(r.error ?? "알 수 없음")}`);
      return { handled: cmd };
    }
    if (cmd === "/삼합" || cmd === "/combo") { await reply(env, chatId, await cmdCombo(env)); return { handled: cmd }; }
    if (cmd === "/수급" || cmd === "/flow") { await reply(env, chatId, await cmdFlow(env)); return { handled: cmd }; }
    if (cmd === "/지금" || cmd === "/feed") { await reply(env, chatId, await cmdFeed(env)); return { handled: cmd }; }

    if (cmd === "/종목" || cmd === "/stock") {
      if (!arg) { await reply(env, chatId, "종목명이나 코드를 함께 넣어 주세요. 예: <code>/종목 삼성전자</code>"); return { handled: cmd }; }
      const { text: out, code } = await cmdStock(env, arg);
      await reply(env, chatId, out);
      // 차트 이미지는 등록된 방에서만 — 렌더가 비싸다
      if (code && isHome) {
        const png = await sceneShot(env, `chart:${code}`, "KR");
        if (png) await tgSendPhoto(env, png, `<b>${esc(CODE_TO_NAME.get(code) ?? code)}</b> 일봉 · 지지/저항`);
      }
      return { handled: cmd };
    }
  } catch (e) {
    await reply(env, chatId, `처리 중 문제가 생겼습니다: ${esc(e instanceof Error ? e.message : String(e))}`);
    return { handled: `${cmd}(error)` };
  }
  return { handled: null };
}
