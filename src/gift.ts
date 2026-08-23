import "./gift.css";
import { GIFT_API_PATH } from "../shared/gift";
import { getTradeToken } from "./api";

interface GiftQuote {
  name: string;
  code: string;
  shares: number;
  price: number;
  change: number;
  changePct: number;
  total: number;
  source: string;
  asOf: number;
  notificationReady: boolean;
}

const root = document.getElementById("gift-app");
if (!root) throw new Error("gift app root missing");

root.innerHTML = `
  <div class="sun-orb sun-one" aria-hidden="true"></div>
  <div class="sun-orb sun-two" aria-hidden="true"></div>
  <div class="confetti" aria-hidden="true">
    <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
  </div>
  <article class="gift-card">
    <header class="gift-hello">
      <span class="eyebrow">A BIRTHDAY GIFT · 4 SHARES</span>
      <h1>승철아,<br><em>생일 축하해!</em></h1>
      <p>오늘의 네가 오래오래 빛나길 바라며,<br>삼성전자 4주 상당의 선물을 준비했어.</p>
    </header>

    <figure class="birthday-photo">
      <img src="/gift/seungcheol-birthday-d333ce89.png" alt="생일 케이크 촛불을 부는 승철이" />
      <figcaption>생일의 한 장면을 오래 간직할게 ✦</figcaption>
    </figure>

    <section class="stock-ticket" aria-live="polite">
      <div class="ticket-top">
        <div><span class="ticket-label">YOUR BIRTHDAY STOCK</span><h2>삼성전자 <b>4주</b></h2></div>
        <div class="four-badge">4</div>
      </div>
      <div class="gift-value">
        <span>지금 선물금액</span>
        <strong id="gift-total">불러오는 중…</strong>
      </div>
      <div class="quote-row">
        <span>1주 현재가 <b id="share-price">—</b></span>
        <span id="day-change">—</span>
      </div>
      <div class="live-line"><i></i><span id="quote-time">실시간 시세 연결 중</span></div>
    </section>

    <section class="request-box">
      <label for="gift-note">아빠에게 남길 한마디 <small>선택</small></label>
      <input id="gift-note" maxlength="100" placeholder="예: 고마워! 잘 간직할게 💛" />
      <button id="request-gift" type="button"><span>🎁</span> 지금 선물금 요청하기</button>
      <p id="request-status">누르면 현재 시세 기준 금액과 함께 카카오톡 알림이 가요.</p>
      <div id="kakao-admin" class="kakao-admin" hidden>
        <strong>운영자 설정</strong>
        <p>카카오톡 ‘나에게 보내기’를 한 번 연결합니다.</p>
        <label for="admin-token">거래 암호</label>
        <input id="admin-token" type="password" autocomplete="current-password" placeholder="자동매매 설정 암호" />
        <button id="connect-kakao" type="button">카카오 알림 연결하기</button>
      </div>
    </section>

    <footer>
      <p>가격은 시장에 따라 오르내릴 수 있어. 이 페이지의 숫자는 삼성전자 4주의 현재 평가금액이야.</p>
      <span>사랑을 담아, 승철이의 생일에 ♡</span>
    </footer>
  </article>
`;

const totalEl = document.getElementById("gift-total")!;
const priceEl = document.getElementById("share-price")!;
const changeEl = document.getElementById("day-change")!;
const timeEl = document.getElementById("quote-time")!;
const requestBtn = document.getElementById("request-gift") as HTMLButtonElement;
const noteEl = document.getElementById("gift-note") as HTMLInputElement;
const statusEl = document.getElementById("request-status")!;
const adminEl = document.getElementById("kakao-admin")!;
const connectBtn = document.getElementById("connect-kakao") as HTMLButtonElement;
const adminTokenEl = document.getElementById("admin-token") as HTMLInputElement;

const won = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}원`;

async function refreshQuote(): Promise<void> {
  try {
    const res = await fetch(GIFT_API_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error("시세 응답 오류");
    const q = await res.json() as GiftQuote;
    totalEl.textContent = won(q.total);
    priceEl.textContent = won(q.price);
    changeEl.textContent = `${q.change >= 0 ? "+" : ""}${won(q.change)} · ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`;
    changeEl.className = q.change > 0 ? "up" : q.change < 0 ? "down" : "flat";
    timeEl.textContent = `${new Date(q.asOf).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 갱신 · ${q.source}`;
    if (!q.notificationReady) statusEl.textContent = "카카오 알림 연결을 준비 중이에요. 요청 기록은 안전하게 남겨둘게요.";
  } catch {
    timeEl.textContent = "시세를 잠시 불러오지 못했어요 · 곧 다시 확인할게요";
  }
}

requestBtn.addEventListener("click", async () => {
  requestBtn.disabled = true;
  requestBtn.classList.add("sending");
  statusEl.textContent = "아빠에게 선물 요청을 보내는 중…";
  try {
    const res = await fetch(GIFT_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: noteEl.value }),
    });
    const data = await res.json() as { message?: string; detail?: { saved?: boolean } };
    if (!res.ok) {
      if (data.detail?.saved) throw new Error("요청은 기록했어요. 카카오 연결이 끝나면 알림도 바로 보낼 수 있어요.");
      throw new Error("요청을 보내지 못했어요. 잠시 후 다시 눌러주세요.");
    }
    statusEl.textContent = data.message ?? "아빠에게 요청을 보냈어요! 💛";
    requestBtn.innerHTML = "<span>✓</span> 요청을 보냈어요";
    document.body.classList.add("celebrate");
    window.setTimeout(() => document.body.classList.remove("celebrate"), 2400);
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : "요청을 보내지 못했어요.";
    requestBtn.disabled = false;
    requestBtn.classList.remove("sending");
  }
});

if (new URLSearchParams(location.search).has("admin")) adminEl.hidden = false;
if (new URLSearchParams(location.search).get("kakao") === "connected") {
  statusEl.textContent = "카카오 알림 연결이 완료됐어요. 이제 요청 버튼이 바로 알림을 보냅니다.";
}
connectBtn.addEventListener("click", async () => {
  const token = getTradeToken() || adminTokenEl.value.trim();
  if (!token) {
    statusEl.textContent = "운영자 거래 암호를 입력해주세요.";
    adminTokenEl.focus();
    return;
  }
  connectBtn.disabled = true;
  connectBtn.textContent = "카카오 연결 화면 여는 중…";
  try {
    const res = await fetch(`${GIFT_API_PATH}/kakao/start`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const data = await res.json() as { url?: string; error?: string };
    if (!res.ok || !data.url) throw new Error(data.error ?? "연결 주소를 만들지 못했습니다.");
    location.href = data.url;
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : "카카오 연결을 시작하지 못했습니다.";
    connectBtn.disabled = false;
    connectBtn.textContent = "카카오 알림 연결하기";
  }
});

void refreshQuote();
window.setInterval(() => void refreshQuote(), 30_000);
