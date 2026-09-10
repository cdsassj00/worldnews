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
import { buildDailyMessage, buildGuideMessage, planBlock, tgAnnounce, tgPostGuide, tgSendAlbum, tgTargets, whyLines } from "./telegram";
import { sceneShots, type ShotRequest } from "./shot";
import { CODE_TO_NAME } from "./symbols";

const API = "https://api.telegram.org";
const DISCLAIMER = "공개 데이터 기반 자동 분석이며 투자 자문·권유가 아닙니다.";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HELP = [
  "<b>쓸 수 있는 명령</b>",
  "",
  "/추천 — 오늘 종목 추천 (단타·스윙·장기 전부)",
  "/단타 · /스윙 · /장기 — 그 구간만 (손절·목표·세 관점 근거 포함)",
  "/삼합 — 온톨로지+수급+차트 종합 순위 상위 8",
  "/수급 — 자금흐름·매집·거래대금 순위 상위 8",
  "/지금 — 방금 일어난 변화(합의 형성·급증·돌파 등)",
  "/종목 삼성전자 — 판정·매매 플랜 + 일봉·전략표·온톨로지 이미지",
  "/공지 — 정기 공지를 지금 채널에 올리기(차트 이미지 포함)",
  "/안내 — 방 상단에 고정할 안내문 올리기",
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

/**
 * 구간 하나만 — 전체 공지는 세 구간이 다 들어가 길다.
 * 성적은 좋든 나쁘든 그대로 붙인다. 규칙만 말하고 성적을 빼면 그건 광고다.
 */
async function cmdHorizon(env: Env, id: "day" | "swing" | "long"): Promise<{ text: string; nameKo: string; codes: { code: string; name: string }[] }> {
  const res = (await dailyBrief(env, "KR")) as {
    briefs: {
      targetSession: string;
      horizons?: {
        buckets: {
          id: string; nameKo: string; holdKo: string; ruleKo: string; orderKo: string; cautionKo: string;
          track: { summaryKo: string } | null;
          picks: {
            code: string; name: string; symbol: string | null; sector: string | null; priceLabel: string; changePct: number;
            why: { ontologyKo: string | null; flowKo: string | null; chartKo: string | null };
            plan: {
              stop: number; stopPct: number;
              target: number | null; targetPct: number | null;
              rr: number | null; stopWhyKo: string; targetWhyKo: string; levelNoteKo: string | null;
              nearestSupport: { price: number; label: string; pct: number } | null;
              nearestResistance: { price: number; label: string; pct: number } | null;
            };
          }[];
        }[];
      } | null;
    }[];
  };
  const b = res.briefs[0];
  const k = b?.horizons?.buckets.find((x) => x.id === id);
  if (!k) return { text: "아직 구간별 추천을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.", nameKo: id, codes: [] };
  const cur = "원"; // 이 명령은 한국 시장만 다룬다

  /* 숫자는 문장에서 빼내 등폭 표로 세운다 — 목표·손절·지지·저항을 문장 속에 섞으면
   * 찾으려고 읽어야 한다(2026-09-11 "글이 자글자글하다"). 손익비까지 한 줄에 넣는다. */
  const lines = [
    `${esc(k.nameKo)} <b>관점</b>  <i>${esc(k.holdKo)}</i>`,
    `<i>${esc(k.ruleKo)}</i>`,
    `🕘 매수 <b>${esc(b.targetSession)} 시가</b>`,
  ];
  if (k.track) lines.push("", `📉 <i>${esc(k.track.summaryKo)}</i>`);

  for (const p of k.picks) {
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━");
    lines.push(`<b>▎${esc(p.name)}</b> ${esc(p.priceLabel)} <i>(${p.changePct >= 0 ? "+" : ""}${p.changePct.toFixed(1)}%${p.sector ? ` · ${esc(p.sector)}` : ""})</i>`);
    lines.push(planBlock(p.plan, cur));
    if (p.plan.rr !== null) lines.push(`<i>손익비 ${p.plan.rr}</i>`);
    lines.push(...whyLines(p.why, 70));
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━");
  lines.push(`<i>${esc(k.orderKo)}</i>`);
  lines.push(`<i>⚠ ${esc(k.cautionKo)}</i>`);
  lines.push(`<i>${DISCLAIMER}</i>`);
  let text = lines.join("\n");
  if (text.length > 4000) text = `${text.slice(0, 3880)}</pre>\n…`;
  return { text, nameKo: k.nameKo, codes: k.picks.map((p) => ({ code: p.code, name: p.name })) };
}

async function cmdStock(env: Env, query: string): Promise<{ text: string; code: string | null; market: "KR" | "US" }> {
  const code = findCode(query);
  if (!code) return { text: `"${esc(query)}" 를 찾지 못했습니다. 종목명이나 6자리 코드로 다시 넣어 주세요.`, code: null, market: "KR" };
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
  return { text: lines.join("\n"), code, market: b.market as "KR" | "US" };
}

/**
 * 명령 응답에 붙일 그림. 글만 오면 "표는 어디 있냐"가 되고, 넉 장을 낱장으로 올리면
 * 방이 지저분해진다 — 앨범 한 묶음으로 보낸다. 렌더가 비싸서 등록된 방에서만 부른다.
 */
async function replyShots(env: Env, chatId: number | string, reqs: ShotRequest[]): Promise<void> {
  const shots = await sceneShots(env, reqs);
  if (!shots.length) return;
  await tgSendAlbum(env, shots.map((s) => ({ png: s.png, caption: s.caption })), chatId);
}

/* ── 새로 들어온 사람 맞이 ──────────────────────────────
 * 고정 안내문을 올려 놔도 대부분 안 보고 지나친다. 들어오는 순간 짧은 인사로 명령을
 * 알려 주는 게 확실하다. 다만 두 가지를 지킨다:
 *  ① **짧게.** 긴 글은 새로 들어온 사람이 더 안 읽는다. 자세한 건 고정 안내문에 있다.
 *  ② **몰려 들어와도 한 번만.** 초대로 열 명이 한꺼번에 들어오면 열 번 울린다.
 *     방마다 10분 쿨다운을 두고, 그 사이 들어온 사람은 이름만 묶어 한 번에 인사한다. */

const WELCOME_COOLDOWN_SEC = 600;

/** 봇 자신이 초대됐는지 — 그때는 인사 대신 안내문을 올리고 고정한다 */
async function botUsername(env: Env): Promise<string | null> {
  const cached = await env.CACHE.get("tg:me", "text").catch(() => null);
  if (cached) return cached;
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { username?: string } };
    const name = body.result?.username ?? null;
    if (name) await env.CACHE.put("tg:me", name, { expirationTtl: 86_400 }).catch(() => undefined);
    return name;
  } catch {
    return null;
  }
}

async function welcomeJoiners(
  env: Env,
  chatId: number,
  members: { id: number; is_bot?: boolean; first_name?: string; username?: string }[],
): Promise<void> {
  const me = await botUsername(env);

  // 봇 자신이 방에 들어왔다 — 설치 순간이다. 인사 대신 안내문을 올리고 고정한다.
  if (me && members.some((m) => m.is_bot && m.username === me)) {
    await tgPostGuide(env).catch(() => undefined);
    return;
  }

  const people = members.filter((m) => !m.is_bot);
  if (!people.length) return; // 다른 봇이 들어온 것뿐이면 조용히 넘긴다

  const key = `tg:welcomed:${chatId}`;
  if (await env.CACHE.get(key).catch(() => null)) return; // 쿨다운 중 — 도배 방지
  await env.CACHE.put(key, "1", { expirationTtl: WELCOME_COOLDOWN_SEC }).catch(() => undefined);

  const names = people.slice(0, 5).map((m) => esc(m.first_name ?? m.username ?? "새 멤버")).join(", ");
  const more = people.length > 5 ? ` 외 ${people.length - 5}명` : "";

  await reply(env, chatId, [
    `👋 <b>${names}</b>${more}님 반갑습니다.`,
    "",
    "이 방은 매일 한국장 마감 뒤 <b>단타 · 스윙 · 장기</b> 세 구간으로",
    "종목을 <b>손절·목표 가격과 함께</b> 올립니다.",
    "",
    "<b>바로 써보세요</b>",
    "<pre>" + esc([
      "/추천   오늘 종목 추천 전부",
      "/단타   짧게 (익절 +10% · 손절 -5%)",
      "/스윙   중간 (익절 +15% · 손절 -6%)",
      "/장기   길게 (고점 대비 -25% 추적)",
      "/종목   예: /종목 삼성전자",
      "/도움   전체 명령 목록",
    ].join("\n")) + "</pre>",
    "입력창에 <b>/</b> 만 쳐도 목록이 뜹니다.",
    "",
    "📌 <b>고정된 안내문</b>에 자세한 설명이 있습니다 — 매수 시점, 보유 기간, 백테스트 성적까지.",
    `<i>${DISCLAIMER}</i>`,
  ].join("\n"));
}

/** 텔레그램 업데이트 한 건 처리 — 명령이 아니면 조용히 넘긴다(잡담에 끼어들지 않는다) */
export async function handleTelegramUpdate(env: Env, update: unknown): Promise<{ handled: string | null }> {
  const raw = update as {
    message?: {
      text?: string;
      chat?: { id: number; type?: string; title?: string; username?: string };
      new_chat_members?: { id: number; is_bot?: boolean; first_name?: string; username?: string }[];
    };
    channel_post?: { text?: string; chat?: { id: number; type?: string; title?: string; username?: string } };
  };
  // 채널은 message 가 아니라 channel_post 로 온다 — 설치할 때 채널 id 를 잡으려면 둘 다 봐야 한다
  const u = { message: raw.message ?? raw.channel_post };
  const text = u.message?.text?.trim();
  const chatId = u.message?.chat?.id;
  if (chatId === undefined) return { handled: null };

  /* 새로 들어온 사람 — 고정 안내문을 안 보고 지나치는 사람이 대부분이라,
   * 들어오는 순간 짧은 인사로 명령을 알려 준다(2026-09-11 요청). */
  const joined = raw.message?.new_chat_members;
  if (joined?.length) {
    await welcomeJoiners(env, chatId, joined);
    return { handled: "join" };
  }

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

    if (cmd === "/안내" || cmd === "/guide") {
      /* 방 상단에 고정할 안내문. 등록된 방이면 실제로 올리고 고정까지 하고,
       * 그 밖에서는 내용만 보여 준다(아무 방에나 글을 고정하면 안 된다). */
      if (!isHome) { await reply(env, chatId, buildGuideMessage().text); return { handled: cmd }; }
      const r = await tgPostGuide(env);
      if (!r.ok) await reply(env, chatId, `안내문을 올리지 못했습니다: ${esc(r.error ?? "알 수 없음")}`);
      else if (r.skipped.length) await reply(env, chatId, `안내문을 올렸습니다. 다만: ${esc(r.skipped.join(" / "))}`);
      return { handled: cmd };
    }

    if (cmd === "/추천" || cmd === "/picks") {
      const m = await buildDailyMessage(env, "KR");
      await reply(env, chatId, m?.text ?? "오늘 추천 목록을 만들지 못했습니다.");
      if (isHome) {
        await replyShots(env, chatId, [
          { view: "horizons", caption: "<b>투자 기간별 추천</b> — 단타 · 스윙 · 장기" },
          { view: "combo", caption: "삼합 종합 순위 (세 구간 공통 매수 신호)" },
          { view: "flow", caption: "수급 순위" },
        ]);
      }
      return { handled: cmd };
    }

    /* 구간 하나만 보고 싶을 때 — 전체 공지는 길다 */
    if (cmd === "/단타" || cmd === "/스윙" || cmd === "/장기") {
      const id = cmd === "/단타" ? "day" : cmd === "/스윙" ? "swing" : "long";
      const out = await cmdHorizon(env, id);
      await reply(env, chatId, out.text);
      if (isHome && out.codes.length) {
        await replyShots(env, chatId, [
          { view: "horizons", caption: `<b>${esc(out.nameKo)}</b> 관점` },
          ...out.codes.slice(0, 3).map((c) => ({
            view: `chart:${c.code}`,
            caption: `${esc(c.name)} 일봉 · 지지/저항`,
          })),
        ]);
      }
      return { handled: cmd };
    }
    if (cmd === "/공지" || cmd === "/announce") {
      if (!isHome) { await reply(env, chatId, "이 명령은 등록된 채널·방에서만 씁니다."); return { handled: cmd }; }
      const r = await tgAnnounce(env, { market: "KR", kind: "daily", force: true });
      await reply(env, chatId, r.ok ? `공지 완료 — ${r.sent.join(", ") || "보낸 항목 없음"}` : `실패: ${esc(r.error ?? "알 수 없음")}`);
      return { handled: cmd };
    }
    if (cmd === "/삼합" || cmd === "/combo") {
      await reply(env, chatId, await cmdCombo(env));
      if (isHome) await replyShots(env, chatId, [{ view: "combo", caption: "<b>삼합 종합 순위</b> — 온톨로지+수급+차트" }]);
      return { handled: cmd };
    }
    if (cmd === "/수급" || cmd === "/flow") {
      await reply(env, chatId, await cmdFlow(env));
      if (isHome) await replyShots(env, chatId, [{ view: "flow", caption: "<b>수급 순위</b> — 자금흐름·매집·거래대금" }]);
      return { handled: cmd };
    }
    if (cmd === "/지금" || cmd === "/feed") { await reply(env, chatId, await cmdFeed(env)); return { handled: cmd }; }

    if (cmd === "/종목" || cmd === "/stock") {
      if (!arg) { await reply(env, chatId, "종목명이나 코드를 함께 넣어 주세요. 예: <code>/종목 삼성전자</code>"); return { handled: cmd }; }
      const { text: out, code, market } = await cmdStock(env, arg);
      await reply(env, chatId, out);
      // 그림은 등록된 방에서만 — 렌더가 비싸다. 차트 한 장으로는 "표는 어디 있냐"가 된다.
      if (code && isHome) {
        const nm = esc(CODE_TO_NAME.get(code) ?? code);
        await replyShots(env, chatId, [
          { view: `chart:${code}`, market, caption: `<b>${nm}</b> 일봉 · 이동평균 · 지지/저항` },
          { view: `strategies:${code}`, market, caption: `${nm} 전략 13종 판정` },
          // 온톨로지 카드는 레이더 유니버스 안에서만 그려진다 — 밖이면 조용히 빠진다
          { view: `stock:${code}`, market, caption: `${nm} 온톨로지 · 거시 연결` },
        ]);
      }
      return { handled: cmd };
    }
  } catch (e) {
    await reply(env, chatId, `처리 중 문제가 생겼습니다: ${esc(e instanceof Error ? e.message : String(e))}`);
    return { handled: `${cmd}(error)` };
  }
  return { handled: null };
}
