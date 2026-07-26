import "./style.css";
import { Globe, type CountryRef } from "./globe";
import { api, ApiFailure, getTradeToken, setTradeToken, type ConfigResponse, type KisStatus, type Snapshot } from "./api";
import { Panel, type OrderDraft } from "./panel";
import { dirClass, el, fmtKrw, fmtNum, fmtPct, timeAgo } from "./format";

/** 티커테이프 심볼 → 국가코드 (지금 움직이는 시장 목록용) */
const TAPE_CC: Record<string, string> = {
  "^KS11": "KR",
  "^GSPC": "US",
  "^IXIC": "US",
  "^N225": "JP",
  "^HSI": "HK",
  "^GDAXI": "DE",
  "^FTSE": "GB",
  "^TWII": "TW",
  "^BSESN": "IN",
  "000001.SS": "CN",
};

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`element #${id} not found`);
  return node as T;
};

let kisStatus: KisStatus | null = null;
let config: ConfigResponse | null = null;
let globe: Globe | null = null;
let pendingOrder: (OrderDraft & { fxToKrw: number | null }) | null = null;

const panel = new Panel({
  root: $("panel-body"),
  empty: $("panel-empty"),
  kis: () => kisStatus,
  requestOrder: (order, ctx) => openOrderModal(order, ctx.fxToKrw),
  onNeedAuth: () => openAuthModal(),
});

/* ── 상단 상태/티커 ─────────────────────────────── */

function renderKisBadge(): void {
  const badge = $("kis-badge");
  if (!kisStatus) {
    badge.textContent = "연동 확인 실패";
    badge.className = "badge badge-off";
    return;
  }
  if (!kisStatus.configured) {
    badge.textContent = "KIS 미연동";
    badge.className = "badge badge-off";
    badge.title = "서버에 KIS 시크릿이 등록되지 않았습니다.";
    return;
  }
  const real = kisStatus.env === "prod";
  badge.textContent = `${kisStatus.envKo}${kisStatus.ordersEnabled ? " · 주문 ON" : " · 주문 OFF"}`;
  badge.className = `badge ${real ? "badge-real" : "badge-paper"}`;
  badge.title = `1회 한도 ${fmtKrw(kisStatus.maxOrderNotionalKrw)} · 전송방식 ${kisStatus.transport}`;
}

function renderTape(items: Snapshot[]): void {
  const track = $("tape-track");
  const build = () =>
    items.map((i) =>
      el("span", { class: "tape-item" }, [
        el("span", { class: "label", text: i.label }),
        el("span", { class: "px", text: fmtNum(i.price) }),
        el("span", { class: dirClass(i.changePct), text: fmtPct(i.changePct) }),
      ]),
    );
  // 무한 스크롤을 위해 두 번 이어 붙인다
  track.replaceChildren(...build(), ...build());
}

function renderHotList(items: Snapshot[]): void {
  const list = $("hot-list");
  const named = items
    .map((i) => ({ item: i, cc: TAPE_CC[i.symbol] }))
    .filter((x): x is { item: Snapshot; cc: string } => Boolean(x.cc));
  const byCc = new Map<string, { item: Snapshot; cc: string }>();
  for (const n of named) {
    const prev = byCc.get(n.cc);
    if (!prev || Math.abs(n.item.changePct) > Math.abs(prev.item.changePct)) byCc.set(n.cc, n);
  }
  const rows = [...byCc.values()].sort((a, b) => Math.abs(b.item.changePct) - Math.abs(a.item.changePct)).slice(0, 6);
  if (!rows.length) {
    list.replaceChildren(el("li", { class: "note", text: "시세를 불러오지 못했습니다." }));
    return;
  }
  list.replaceChildren(
    ...rows.map(({ item, cc }) => {
      const name = config?.markets.find((m) => m.cc === cc)?.nameKo ?? cc;
      const btn = el("button", { type: "button" }, [
        el("span", { class: "hot-name" }, [
          el("span", { text: name }),
          el("span", { class: "hot-index", text: `${item.label} ${fmtNum(item.price)}` }),
        ]),
        el("span", { class: dirClass(item.changePct), text: fmtPct(item.changePct) }),
      ]);
      btn.addEventListener("click", () => selectCountry(cc, name));
      return el("li", {}, [btn]);
    }),
  );
}

async function loadTape(): Promise<void> {
  try {
    const { items, fetchedAt } = await api.tape();
    renderTape(items);
    renderHotList(items);
    $("footer-meta").textContent = `시세 갱신 ${timeAgo(fetchedAt)} · 뉴스 Google News · 시세 Yahoo Finance · 주문 KIS OpenAPI`;
  } catch {
    $("tape-track").replaceChildren(el("span", { class: "tape-item", text: "시세 로딩 실패" }));
  }
}

async function loadGlobalNews(): Promise<void> {
  const list = $("global-news");
  try {
    const { items } = await api.globalNews();
    list.replaceChildren(
      ...items.slice(0, 8).map((n) =>
        el("li", {}, [
          el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer", text: n.title }),
          el("div", { class: "news-meta" }, [el("span", { text: n.source }), el("span", { text: timeAgo(n.publishedAt) })]),
        ]),
      ),
    );
  } catch {
    list.replaceChildren(el("li", { class: "note", text: "헤드라인 로딩 실패" }));
  }
}

/* ── 국가 선택 ─────────────────────────────── */

function selectCountry(cc: string, nameKo: string): void {
  if (globe && !globe.selectByIso2(cc)) {
    // 지도에 없는 코드(예: 소규모 영토)라도 패널은 열어준다
    void panel.open(cc, nameKo);
  }
  const hint = $("globe-hint");
  hint.style.opacity = "0";
}

function onCountryPicked(c: CountryRef): void {
  // E2E 테스트에서 픽 정확도를 확인하려고 마지막 선택을 노출한다.
  (window as unknown as { __wfg?: Record<string, unknown> }).__wfg = {
    ...((window as unknown as { __wfg?: Record<string, unknown> }).__wfg ?? {}),
    lastPick: c,
  };
  if (!c.iso2) {
    void panel.open("ZZ", c.ko);
    return;
  }
  void panel.open(c.iso2, c.ko);
  history.replaceState(null, "", `#${c.iso2}`);
}

/* ── 검색 ─────────────────────────────── */

function setupSearch(): void {
  const input = $<HTMLInputElement>("country-search");
  const results = $<HTMLUListElement>("search-results");
  const close = () => {
    results.hidden = true;
    results.replaceChildren();
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!globe || q.length < 1) return close();
    const matches = globe.countries
      .filter((c) => c.ko.toLowerCase().includes(q) || c.en.toLowerCase().includes(q) || (c.iso2 ?? "").toLowerCase() === q)
      .slice(0, 12);
    if (!matches.length) return close();
    results.replaceChildren(
      ...matches.map((c) => {
        const hasMarket = c.iso2 ? config?.markets.some((m) => m.cc === c.iso2) : false;
        const btn = el("button", { type: "button" }, [
          el("span", { text: c.ko }),
          el("span", { class: "cc", text: `${c.iso2 ?? "--"}${hasMarket ? " ●" : ""}` }),
        ]);
        btn.addEventListener("click", () => {
          if (c.iso2) selectCountry(c.iso2, c.ko);
          input.value = "";
          close();
        });
        return el("li", {}, [btn]);
      }),
    );
    results.hidden = false;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      e.preventDefault();
      results.querySelector("button")?.click();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".country-search")) close();
  });
}

/* ── 모달 ─────────────────────────────── */

function openAuthModal(): void {
  const modal = $("auth-modal");
  const input = $<HTMLInputElement>("auth-input");
  input.value = getTradeToken();
  $("auth-status").textContent = kisStatus?.tradeTokenSet
    ? ""
    : "서버에 TRADE_TOKEN 이 설정되지 않아 주문/잔고 API가 잠겨 있습니다.";
  $("auth-status").className = "modal-status";
  modal.hidden = false;
  input.focus();
}

function setupAuthModal(): void {
  const modal = $("auth-modal");
  $("auth-cancel").addEventListener("click", () => (modal.hidden = true));
  $("auth-clear").addEventListener("click", () => {
    setTradeToken("");
    $<HTMLInputElement>("auth-input").value = "";
    const s = $("auth-status");
    s.textContent = "저장된 암호를 삭제했습니다.";
    s.className = "modal-status ok";
  });
  $("auth-save").addEventListener("click", () => {
    setTradeToken($<HTMLInputElement>("auth-input").value.trim());
    const s = $("auth-status");
    s.textContent = "저장했습니다. 주문·잔고 조회에 사용됩니다.";
    s.className = "modal-status ok";
    setTimeout(() => (modal.hidden = true), 700);
  });
  $("btn-auth").addEventListener("click", () => openAuthModal());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

function openOrderModal(order: OrderDraft, fxToKrw: number | null): void {
  pendingOrder = { ...order, fxToKrw };
  const notional = order.qty * (order.orderType === "market" ? order.refPrice : order.price);
  const krw = fxToKrw ? notional * fxToKrw : null;
  $("order-summary").replaceChildren(
    row("계좌", `${kisStatus?.envKo ?? "-"} (${kisStatus?.env ?? "-"})`),
    row("종목", `${order.name} · ${order.market} ${order.code}`),
    row("구분", order.side === "buy" ? "매수" : "매도"),
    row("유형", order.orderType === "market" ? "시장가" : "지정가"),
    row("수량", `${fmtNum(order.qty, 0)}주`),
    row("가격", order.orderType === "market" ? "시장가" : `${fmtNum(order.price)} ${order.currency}`),
    row("주문금액", `${fmtNum(notional)} ${order.currency}${krw ? ` ≈ ${fmtKrw(krw)}` : ""}`),
  );
  const status = $("order-status");
  status.textContent = kisStatus?.env === "prod" ? "실전투자 계좌입니다. 실제 체결되며 취소가 어렵습니다." : "모의투자 계좌로 전송됩니다.";
  status.className = `modal-status ${kisStatus?.env === "prod" ? "err" : ""}`;
  const confirmInput = $<HTMLInputElement>("order-confirm-input");
  confirmInput.value = "";
  confirmInput.placeholder = order.code;
  $("order-modal").hidden = false;
  confirmInput.focus();
}

function row(k: string, v: string): HTMLElement {
  return el("div", { class: "row" }, [el("span", { text: k }), el("span", { text: v })]);
}

function setupOrderModal(): void {
  const modal = $("order-modal");
  $("order-cancel").addEventListener("click", () => {
    modal.hidden = true;
    pendingOrder = null;
  });
  $("order-submit").addEventListener("click", async () => {
    if (!pendingOrder) return;
    const btn = $<HTMLButtonElement>("order-submit");
    const status = $("order-status");
    const confirm = $<HTMLInputElement>("order-confirm-input").value.trim();
    if (confirm.toUpperCase() !== pendingOrder.code.toUpperCase()) {
      status.textContent = "종목코드가 일치하지 않습니다.";
      status.className = "modal-status err";
      return;
    }
    btn.disabled = true;
    status.textContent = "주문 전송 중…";
    status.className = "modal-status";
    try {
      const res = await api.order({
        market: pendingOrder.market,
        code: pendingOrder.code,
        side: pendingOrder.side,
        qty: pendingOrder.qty,
        price: pendingOrder.price,
        orderType: pendingOrder.orderType,
        currency: pendingOrder.currency,
        refPrice: pendingOrder.refPrice,
        confirm,
      });
      status.textContent = `접수 완료 · 주문번호 ${res.orderNo || "-"} (${res.isPaper ? "모의" : "실전"}) ${res.message}`;
      status.className = "modal-status ok";
      pendingOrder = null;
      setTimeout(() => (modal.hidden = true), 2200);
    } catch (err) {
      const msg = err instanceof ApiFailure ? err.message : String(err);
      status.textContent = msg;
      status.className = "modal-status err";
      if (err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401)) {
        modal.hidden = true;
        openAuthModal();
      }
    } finally {
      btn.disabled = false;
    }
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.hidden = true;
      pendingOrder = null;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    $("order-modal").hidden = true;
    $("auth-modal").hidden = true;
  });
}

/* ── 지구본 ─────────────────────────────── */

function setupGlobe(liveCodes: Set<string>, orderCodes: Set<string>): void {
  const canvas = $<HTMLCanvasElement>("globe");
  const tooltip = $("globe-tooltip");
  globe = new Globe(canvas, {
    liveCodes,
    orderCodes,
    onSelect: onCountryPicked,
    onHover: (c, x, y) => {
      if (!c) {
        tooltip.hidden = true;
        return;
      }
      const market = c.iso2 ? config?.markets.find((m) => m.cc === c.iso2) : undefined;
      tooltip.replaceChildren(
        el("div", { class: "tt-name", text: c.ko }),
        el("div", {
          class: "tt-meta",
          text: market
            ? `${market.indexName ?? "지수"} · 종목 ${market.tickers}개${market.orderable ? ` · 주문 ${market.orderable}개` : ""}`
            : "뉴스 제공",
        }),
      );
      const host = $("globe-host").getBoundingClientRect();
      tooltip.style.left = `${x - host.left}px`;
      tooltip.style.top = `${y - host.top}px`;
      tooltip.hidden = false;
    },
  });

  const w = window as unknown as { __wfg?: Record<string, unknown> };
  w.__wfg = { ...(w.__wfg ?? {}), globe, panel };

  globe
    .init()
    .then(() => {
      w.__wfg = { ...(w.__wfg ?? {}), ready: true };
      const hash = location.hash.replace("#", "").toUpperCase();
      if (hash.length === 2) globe?.selectByIso2(hash);
    })
    .catch((err) => {
      $("globe-hint").textContent = `지구본 로드 실패: ${err instanceof Error ? err.message : String(err)}`;
    });

  const spinBtn = $("btn-spin");
  spinBtn.addEventListener("click", () => {
    const next = !globe!.isAutoRotating();
    globe!.setAutoRotate(next);
    spinBtn.setAttribute("aria-pressed", next ? "true" : "false");
  });
  $("btn-zoom-in").addEventListener("click", () => globe?.zoom(-0.5));
  $("btn-zoom-out").addEventListener("click", () => globe?.zoom(0.5));
}

/* ── 부트스트랩 ─────────────────────────────── */

async function boot(): Promise<void> {
  try {
    config = await api.config();
    kisStatus = config.kis;
  } catch {
    kisStatus = null;
  }
  renderKisBadge();
  $("disclaimer").textContent = config?.disclaimer ?? $("disclaimer").textContent;

  const liveCodes = new Set<string>((config?.markets ?? []).filter((m) => m.tickers > 0 || m.indexName).map((m) => m.cc));
  const orderCodes = new Set<string>((config?.markets ?? []).filter((m) => m.orderable > 0).map((m) => m.cc));

  setupGlobe(liveCodes, orderCodes);
  setupSearch();
  setupAuthModal();
  setupOrderModal();

  await Promise.allSettled([loadTape(), loadGlobalNews()]);
  // 시세는 주기적으로 갱신(90초 캐시와 맞춤)
  setInterval(() => void loadTape(), 90_000);
}

void boot();
