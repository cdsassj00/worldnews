import "./style.css";
import { Globe, type CountryRef } from "./globe";
import { api, ApiFailure, getTradeToken, setTradeToken, type ConfigResponse, type KisStatus, type Snapshot } from "./api";
import { Panel, type OrderDraft } from "./panel";
import { AutoPanel } from "./autopanel";
import { ComboPanel } from "./combopanel";
import { FlowPanel } from "./flowpanel";
import { LabPanel } from "./labpanel";
import usUniverse from "../shared/us-universe.json";
import { TaPanel } from "./tapanel";
import { Ontology3D } from "./ontology3d";
import { SiteTranslator } from "./translator";
import { Tour } from "./tour";
import type { OntoState, OntoVerdict, RadarItem, RadarOpps, SectorVerdict, StockVerdict, TickerScore } from "./api";
import { dirClass, el, fmtKrw, fmtKst, fmtNum, fmtPct, timeAgo } from "./format";

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
  ai: () => config?.ai ?? null,
  onto: () => ontoState,
  requestOrder: (order, ctx) => openOrderModal(order, ctx.fxToKrw),
  onNeedAuth: () => openAuthModal(),
});

let autoPanel: AutoPanel | null = null;
let labPanel: LabPanel | null = null;
let taPanel: TaPanel | null = null;
let flowPanel: FlowPanel | null = null;
let comboPanel: ComboPanel | null = null;
let onto: Ontology3D | null = null;
let miniGlobe: Globe | null = null;
let ontoState: OntoState | null = null;
let exampleShown = false;

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
  badge.textContent = `${kisStatus.envKo}${kisStatus.dryRun ? " · 검증모드" : kisStatus.ordersEnabled ? " · 주문 ON" : " · 주문 OFF"}${
    kisStatus.overseasEnabled ? "" : " · 국내만"
  }`;
  badge.className = `badge ${real ? "badge-real" : "badge-paper"}`;
  badge.title = `1회 한도 ${fmtKrw(kisStatus.maxOrderNotionalKrw)} · 전송방식 ${kisStatus.transport} · ${kisStatus.overseasReason}`;
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

/* ── 국가 선택 ─────────────────────────────── */

function selectCountry(cc: string, nameKo: string): void {
  if (!globe || !globe.selectByIso2(cc)) {
    // 지도에 없는 코드(예: 소규모 영토)이거나 지구본이 아직 없으면 패널만 연다
    void panel.open(cc, nameKo);
  }
  $("world-modal").hidden = true;
}

function onCountryPicked(c: CountryRef): void {
  // E2E 테스트에서 픽 정확도를 확인하려고 마지막 선택을 노출한다.
  (window as unknown as { __wfg?: Record<string, unknown> }).__wfg = {
    ...((window as unknown as { __wfg?: Record<string, unknown> }).__wfg ?? {}),
    lastPick: c,
  };
  if (!c.iso2) {
    showCountryInModal("ZZ", c.ko);
    return;
  }
  // 온톨로지 유니버스가 있는 나라(한국·미국)는 3분할 전체를 그 시장으로 전환하고
  // 모달을 닫는다. 그 외 나라는 모달 안에서 상세를 보여준다 — 무대는 건드리지 않는다.
  if (c.iso2 === "US" || c.iso2 === "KR") {
    setVerdictMarket(c.iso2);
    history.replaceState(null, "", `#${c.iso2}`);
    $("world-modal").hidden = true;
  } else {
    showCountryInModal(c.iso2, c.ko);
  }
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

/* ── 터미널 탭 — 온톨로지 · 차트분석 · 수급분석 · 자동매매 ─────────────
 * 한 화면에 전부 펼치던 것을 탭 전환으로 바꿨다(가독성 피드백).
 * 각 탭의 데이터는 처음 열 때 불러온다 — 안 여는 탭 비용은 0. */
type PaneId = "onto" | "ta" | "flow" | "combo";
const PANE_SUBS: Record<PaneId, string> = {
  onto: "거시요인 → 섹터 → 종목으로 신호가 전파되는 3D 인과 그래프. 확대는 Ctrl(⌘)+스크롤, 일반 스크롤은 페이지를 내립니다.",
  ta: "창시자가 있는 차트 전략 13종이 종목 하나를 두고 각자 판정합니다 — 패턴·매물대·매매 플랜까지.",
  flow: "자금흐름(MFI)·매집(CLV)·거래대금 급증 — 큰손이 사는 흔적을 점수로 만든 수급 순위입니다.",
  combo: "세 분석을 원하는 비율로 섞은 조합 기준으로, 지금 시점 어떤 종목이 유리한지 보여줍니다. 과거 성적(백테스트)은 전략실에.",
};

function selectPane(id: PaneId, scroll = false): void {
  for (const p of ["onto", "ta", "flow", "combo"] as PaneId[]) {
    $(`pane-${p}`).hidden = p !== id;
  }
  document.querySelectorAll<HTMLButtonElement>("#terminal-tabs .tt-tab").forEach((b) => {
    const on = b.dataset.pane === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("terminal-sub").textContent = PANE_SUBS[id];
  if (id === "ta") void taPanel?.load();
  if (id === "flow") void flowPanel?.load();
  if (id === "combo") void comboPanel?.load();
  if (scroll) $("terminal").scrollIntoView({ behavior: "smooth" });
}

function setupTerminalTabs(): void {
  document.querySelectorAll<HTMLButtonElement>("#terminal-tabs .tt-tab").forEach((b) => {
    b.addEventListener("click", () => selectPane(b.dataset.pane as PaneId));
  });
}

/* 자동매매 — 운영자 전용 모달(우측 상단). 공개 터미널에서 분리했다(2026-08-16 지시).
 * 서버(/api/auto/plan 등)가 거래 암호를 요구하므로 화면도 암호부터 받는다. */
function setupAutoModal(): void {
  const modal = $("auto-modal");
  autoPanel = new AutoPanel({
    root: $("auto-body"),
    badge: $("auto-badge"),
    onNeedAuth: () => openAuthModal(),
  });
  const open = () => {
    modal.hidden = false;
    void autoPanel!.load();
  };
  $("btn-auto").addEventListener("click", open);
  $("auto-refresh").addEventListener("click", () => void autoPanel!.load());
  $("auto-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  const w = window as unknown as { __wfg?: Record<string, unknown> };
  w.__wfg = { ...(w.__wfg ?? {}), openAuto: open };
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
  const submitBtn = $<HTMLButtonElement>("order-submit");
  if (kisStatus?.dryRun) {
    status.textContent = "검증 모드입니다. 인증·한도·TR_ID만 확인하고 실제 주문은 전송하지 않습니다.";
    status.className = "modal-status";
    submitBtn.textContent = "검증 실행";
    submitBtn.className = "btn btn-primary";
  } else if (kisStatus?.env === "prod") {
    status.textContent = "실전투자 계좌입니다. 실제 체결되며 취소가 어렵습니다.";
    status.className = "modal-status err";
    submitBtn.textContent = "실전 주문 전송";
    submitBtn.className = "btn btn-danger";
  } else {
    status.textContent = "모의투자 계좌로 전송됩니다.";
    status.className = "modal-status";
    submitBtn.textContent = "주문 전송";
    submitBtn.className = "btn btn-danger";
  }
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
      status.textContent = res.dryRun
        ? res.message
        : `접수 완료 · 주문번호 ${res.orderNo || "-"} (${res.isPaper ? "모의" : "실전"}) ${res.message}`;
      status.className = "modal-status ok";
      pendingOrder = null;
      setTimeout(() => (modal.hidden = true), res.dryRun ? 6000 : 2200);
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
    $("auto-modal").hidden = true;
    $("onto-help-modal").hidden = true;
  });
}

/* ── 3D 온톨로지 (메인) ─────────────────────────────── */

function setupOntology(): void {
  const canvas = $<HTMLCanvasElement>("onto3d");
  const tooltip = $("onto-tooltip");
  onto = new Ontology3D(canvas, {
    onSelect: (kind, id) => {
      if (kind !== "ticker") return;
      const sc = ontoState?.scores.find((s) => s.code === id);
      if (sc) { panel.openTicker(sc); void taPanel?.show(sc.symbol, sc.nameKo); }
    },
    onHover: (label, x, y) => {
      if (!label) {
        tooltip.hidden = true;
        return;
      }
      tooltip.replaceChildren(el("div", { class: "tt-name", text: label }));
      const host = $("onto-host").getBoundingClientRect();
      tooltip.style.left = `${x - host.left}px`;
      tooltip.style.top = `${y - host.top}px`;
      tooltip.hidden = false;
    },
    onScrollHint: (() => {
      // 일반 휠은 페이지 스크롤로 흘려보내고, 확대 방법만 잠깐 알려준다
      let timer = 0;
      const hint = el("div", { class: "stage-scroll-hint", text: "그래프 확대는 Ctrl(⌘) + 스크롤" });
      $("onto-host").append(hint);
      return () => {
        hint.classList.add("show");
        window.clearTimeout(timer);
        timer = window.setTimeout(() => hint.classList.remove("show"), 1200);
      };
    })(),
    // 좌상단 포커스 카드 — 노드를 고르면 범례가 물러나고 그 노드의 정보가 뜬다
    onFocus: (() => {
      const host = $("onto-host");
      const legend = host.querySelector(".onto-legend");
      const card = el("div", { class: "onto-focus", hidden: "hidden" });
      host.append(card);
      const kindKo: Record<string, string> = { macro: "거시 요인", sector: "섹터", ticker: "종목" };
      return (info: { id: string; kind: string; label: string; sub: string; degree: number } | null) => {
        legend?.classList.toggle("faded", Boolean(info));
        if (!info) { card.hidden = true; return; }
        const close = el("button", { class: "onto-focus-x", type: "button", text: "✕", title: "포커스 해제" });
        close.addEventListener("click", () => onto?.setFocus(null));
        card.replaceChildren(
          el("div", { class: "onto-focus-head" }, [
            el("span", { class: `onto-focus-dot ${info.kind}` }),
            el("b", { text: info.label }),
            ...(info.sub ? [el("span", { class: "onto-focus-sub", text: info.sub })] : []),
            close,
          ]),
          el("p", { class: "onto-focus-meta", text: `${kindKo[info.kind] ?? info.kind} · 연결 경로 ${info.degree}개 표시 중${info.kind === "ticker" ? " — 상세 분석은 오른쪽 패널에" : ""}` }),
        );
        card.hidden = false;
      };
    })(),
  });
  onto.init();
  onto.setLightTheme(document.documentElement.dataset.theme === "light");

  const w = window as unknown as { __wfg?: Record<string, unknown> };
  w.__wfg = { ...(w.__wfg ?? {}), onto };

  // 사이드 패널 접기/펴기 — 그래프를 넓게. 선택은 기억한다.
  // 2026-08-17 사용자 지시: 기본값 = 접힘(그래프 전체 화면). 처음 온 사람은
  // 온톨로지부터 크게 보고, 네온 버튼 말풍선이 패널 펼치는 법을 알려준다.
  const layout = document.querySelector<HTMLElement>("main.layout");
  const sideToggle = (btnId: string, cls: string, key: string, openCh: string, closedCh: string) => {
    const btn = $(btnId);
    const apply = (hidden: boolean) => {
      layout?.classList.toggle(cls, hidden);
      btn.textContent = hidden ? closedCh : openCh;
      btn.classList.toggle("collapsed", hidden); // 접힘 상태 = 네온 + 말풍선
      try { localStorage.setItem(key, hidden ? "1" : "0"); } catch { /* 무시 */ }
    };
    let hidden = true; // 저장된 선택이 없으면 접힘이 기본
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) hidden = saved === "1";
    } catch { /* 무시 */ }
    apply(hidden);
    btn.addEventListener("click", () => apply(!layout?.classList.contains(cls)));
  };
  sideToggle("btn-rail-toggle", "no-rail", "wfg-rail-hidden", "◀", "▶");
  sideToggle("btn-panel-toggle", "no-panel", "wfg-panel-hidden", "▶", "◀");

  const spinBtn = $("btn-spin");
  spinBtn.addEventListener("click", () => {
    const next = !onto!.isAutoRotating();
    onto!.setAutoRotate(next);
    spinBtn.setAttribute("aria-pressed", next ? "true" : "false");
  });
  $("btn-zoom-in").addEventListener("click", () => onto?.zoom(-1.4));
  $("btn-zoom-out").addEventListener("click", () => onto?.zoom(1.4));
}

async function loadOntology(): Promise<void> {
  const hint = $("onto-hint");
  try {
    ontoState = await api.ontoState();
    pushOntoState();
    $("onto-note").textContent = ontoState.note;
    hint.textContent = `${ontoState.scores.length}개 종목 · 시세 ${
      ontoState.dataAsOf ? fmtKst(ontoState.dataAsOf) : "-"
    } 기준 · 계산 ${timeAgo(ontoState.generatedAt)}`;
    hint.style.opacity = "0.75";
    renderMacroList(ontoState);
    // 결론 카드가 '미국'/나라 모드면 점수 상위도 그 시장을 유지한다 — KR 갱신이 덮어쓰지 않게
    if (countryMode) { /* 나라 모드 목록 유지 */ }
    else if (verdictMarket === "US") void renderUsScoreList();
    else renderScoreList(ontoState);
    renderMacroLinks(ontoState);
    // 첫 방문이면 최고 점수 종목의 분석을 예시로 열어 준다 — 빈 패널만 보고 나가지 않게.
    // 3D 포커스는 걸지 않는다: 사용자가 클릭하지 않았는데 그래프에 포커스가 있으면 혼란스럽다(2026-08-17 피드백).
    if (!exampleShown && ontoState.scores.length && $("panel-body").hidden) {
      exampleShown = true;
      panel.openTicker({ ...ontoState.scores[0], asOf: ontoState.generatedAt });
    }
    (window as unknown as { __wfg?: Record<string, unknown> }).__wfg = {
      ...((window as unknown as { __wfg?: Record<string, unknown> }).__wfg ?? {}),
      ontoReady: true,
    };
  } catch (err) {
    hint.textContent = `온톨로지 로드 실패: ${err instanceof ApiFailure ? err.message : String(err)}`;
  }
}

function renderMacroList(s: OntoState): void {
  $("macro-list").replaceChildren(
    ...s.macro.map((m) =>
      el("li", {
        class: "macro-row",
        title: `${m.upMeansKo}${m.newsReason ? `\n뉴스 보정 ${m.newsImpact! >= 0 ? "+" : ""}${m.newsImpact}: ${m.newsReason}` : ""}${
          m.asOf ? `\n시세 ${fmtKst(m.asOf)} 기준` : ""
        }`,
      }, [
        el("span", { class: "m-name" }, [
          el("span", { text: m.nameKo }),
          m.newsImpact ? el("i", { class: `m-news ${m.newsImpact >= 0 ? "up" : "down"}`, text: "뉴스" }) : null,
        ]),
        el("span", { class: "m-bar" }, [
          el("i", {
            class: dirClass(m.value),
            style: `width:${Math.min(100, Math.abs(m.value) * 100)}%;${m.value < 0 ? "margin-left:auto" : ""}`,
          }),
        ]),
        el("span", { class: `m-val ${dirClass(m.changePct)}`, text: fmtPct(m.changePct) }),
      ]),
    ),
  );
}

/** 도움말 모달의 "거시요인 사이의 인과" 목록 — 의미론적 온톨로지 층 */
function renderMacroLinks(s: OntoState): void {
  const list = document.getElementById("oh-macro-links");
  if (!list || !s.macroLinks?.length) return;
  const nameOf = (id: string) => s.macro.find((m) => m.id === id)?.nameKo ?? id;
  list.replaceChildren(
    ...s.macroLinks.map((l) => el("li", { text: `${nameOf(l.from)} → ${nameOf(l.to)}: ${l.ko}` })),
  );
}

/** 미국 점수 상위 — 결론 카드 탭이 '미국'일 때 레이더 DB의 미국 종목으로 채운다 (2026-08-17) */
async function renderUsScoreList(): Promise<void> {
  try {
    const top = await api.radarTop(100);
    const rows = top.items.filter((r) => r.market === "US").slice(0, 8);
    if (!rows.length) return;
    $("score-list").replaceChildren(
      ...rows.map((r) => {
        const t = radarToTicker(r);
        const btn = el("button", { type: "button" }, [
          el("span", { class: "hot-name" }, [
            el("span", { text: r.name }),
            el("span", { class: "hot-index", text: `$${fmtNum(r.price, 2)} · 온톨 ${r.onto}` }),
          ]),
          el("span", { class: dirClass(r.score), text: r.score.toFixed(3) }),
        ]);
        btn.addEventListener("click", () => {
          onto?.showTicker(t);
          panel.openTicker(t);
          void taPanel?.show(t.symbol, t.nameKo);
        });
        return el("li", {}, [btn]);
      }),
    );
  } catch { /* 다음 갱신에서 다시 */ }
}

function renderScoreList(s: OntoState): void {
  const rows = s.scores.slice(0, 8);
  $("score-list").replaceChildren(
    ...rows.map((t) => {
      const btn = el("button", { type: "button" }, [
        el("span", { class: "hot-name" }, [
          el("span", { text: t.nameKo }),
          el("span", { class: "hot-index", text: `${fmtNum(t.price, 0)}원 · 온톨 ${t.ontologyScore}` }),
        ]),
        el("span", { class: dirClass(t.score), text: t.score.toFixed(3) }),
      ]);
      btn.addEventListener("click", () => {
        onto?.showTicker(t);
        panel.openTicker(t);
        void taPanel?.show(t.symbol, t.nameKo);
      });
      return el("li", {}, [btn]);
    }),
  );
}

/* ── 온톨로지 결론 — 요인 인과 → 국면 → 섹터·종목 추천 출력 ── */

let verdictMarket: "KR" | "US" = "KR";
let lastVerdict: OntoVerdict | null = null;
/** 나라 모드 — 온톨로지 유니버스(한국·미국) 밖 나라를 보는 중이면 그 iso2 */
let countryMode: string | null = null;

/* 2026-08-17 구조 정리: 온톨로지 3분할(그래프+양쪽 패널)은 한국·미국 전용이고,
 * 다른 나라 구경은 지구본 모달 안에서 끝낸다(showCountryInModal) — 무대와 오른쪽
 * 패널이 서로 다른 나라를 보여주는 혼란을 없앤다. */
let modalPanel: Panel | null = null;

function showCountryInModal(cc: string, nameKo: string): void {
  if (!modalPanel) {
    modalPanel = new Panel({
      root: $("world-country-body"),
      empty: $("world-country-empty"),
      kis: () => kisStatus,
      ai: () => config?.ai ?? null,
      onto: () => ontoState,
      requestOrder: (order, ctx) => openOrderModal(order, ctx.fxToKrw),
      onNeedAuth: () => openAuthModal(),
    });
    $("world-country-back").addEventListener("click", () => {
      $("world-country").hidden = true;
      $("world-side-main").hidden = false;
    });
  }
  $("world-side-main").hidden = true;
  $("world-country").hidden = false;
  void modalPanel.open(cc, nameKo);
}

/** 그래프는 결론의 시각화 — 온톨로지 상태와 결론이 갱신될 때마다 함께 민다 */
function pushOntoState(): void {
  if (!ontoState) return;
  onto?.setState({
    macro: ontoState.macro,
    scores: ontoState.scores,
    riskOff: ontoState.riskOff,
    macroLinks: ontoState.macroLinks,
    macroClusters: ontoState.macroClusters,
    sectors: ontoState.sectors,
    verdict: lastVerdict
      ? { sectors: lastVerdict.sectors, stocks: lastVerdict.stocks }
      : undefined,
  });
}

/** 시장 전환의 단일 진입점 — 결론 카드·무대 토글·지구본이 전부 이 함수를 부른다.
 *  그래프(결론 층)·결론 카드·종목 점수 상위·기회 탐색이 한 몸으로 바뀐다. */
function setVerdictMarket(mkt: "KR" | "US"): void {
  countryMode = null;
  verdictMarket = mkt;
  // 오른쪽 패널도 같은 시장의 나라 화면으로 — 무대와 패널이 다른 나라를 보는 혼란 방지
  void panel.open(mkt === "US" ? "US" : "KR", mkt === "US" ? "미국" : "대한민국");
  for (const group of ["verdict-mkt", "onto-mkt"]) {
    const elGroup = document.getElementById(group);
    if (!elGroup) continue;
    for (const b of elGroup.querySelectorAll<HTMLButtonElement>(".radar-tab")) {
      b.classList.toggle("active", b.dataset.mkt === mkt);
    }
  }
  void loadVerdict();
  void loadRadar(); // 기회 탐색도 같은 시장으로 따라간다
  if (mkt === "US") void renderUsScoreList();
  else if (ontoState) renderScoreList(ontoState);
}

function setupVerdict(): void {
  const wire = (id: string) => {
    const tabs = document.getElementById(id);
    if (!tabs) return;
    tabs.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".radar-tab");
      if (!btn?.dataset.mkt) return; // 🌍 버튼 등 시장 탭이 아닌 것은 통과
      setVerdictMarket(btn.dataset.mkt as "KR" | "US");
    });
  };
  wire("verdict-mkt");
  wire("onto-mkt"); // 3D 무대 위 토글 — 같은 스위치의 다른 손잡이
  // 오른쪽 패널의 "대한민국으로 돌아가기" — 무대·왼쪽 카드도 함께 한국으로
  document.addEventListener("wfg:market-kr", () => setVerdictMarket("KR"));
}

async function loadVerdict(): Promise<void> {
  if (countryMode) return; // 나라 모드에서는 왼쪽 카드가 그 나라를 유지한다
  const body = $("verdict-body");
  try {
    const v = await api.ontoVerdict(verdictMarket);
    lastVerdict = v;
    pushOntoState();
    const toneCls = v.regime.tone === "risk-off" ? "down" : v.regime.tone === "risk-on" ? "up" : "flat";
    const secChip = (s: SectorVerdict, cls: string) =>
      el("span", { class: `vd-chip ${cls}`, title: s.reasons.join("\n"), text: `${s.sector} ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}` });
    const stockRow = (st: StockVerdict) => {
      const btn = el("button", { type: "button", title: st.reason }, [
        el("span", { class: "hot-name" }, [
          el("span", { text: st.name }),
          el("span", { class: "hot-index", text: `${st.sector ?? "미분류"} · ${fmtNum(st.price, 0)}${v.market === "US" ? "$" : "원"}` }),
        ]),
        el("span", { class: dirClass(st.score), text: st.score.toFixed(2) }),
      ]);
      btn.addEventListener("click", () => {
        void (async () => {
          const found = await api.radarFind(st.code).catch(() => null);
          const r = found?.items.find((x) => x.code === st.code) ?? found?.items[0];
          if (r) { const t = radarToTicker(r); onto?.showTicker(t); panel.openTicker(t); void taPanel?.show(t.symbol, t.nameKo); }
        })();
      });
      return el("li", {}, [btn]);
    };
    body.replaceChildren(
      el("p", { class: `verdict-line ${toneCls}` }, [
        el("b", { text: v.regime.label }),
        el("span", { class: "note", text: ` 위험회피 ${v.regime.riskOff}` }),
      ]),
      ...v.regime.lines.map((l) => el("p", { class: "vd-fact", text: l })),
      ...(v.causal.length
        ? [el("p", { class: "vd-h", text: "지금 작동 중인 인과" }), ...v.causal.map((c) => el("p", { class: "vd-fact", text: `· ${c}` }))]
        : []),
      el("p", { class: "vd-h", text: "→ 추천 섹터" }),
      el("div", { class: "vd-chips" },
        v.sectors.recommend.length ? v.sectors.recommend.map((s) => secChip(s, "up")) : [el("span", { class: "note", text: "지금 순풍인 섹터 없음 — 관망" })]),
      el("p", { class: "vd-h", text: "→ 회피 섹터" }),
      el("div", { class: "vd-chips" },
        v.sectors.avoid.length ? v.sectors.avoid.map((s) => secChip(s, "down")) : [el("span", { class: "note", text: "없음" })]),
      el("p", { class: "vd-h", text: "→ 추천 종목" }),
      el("ul", { class: "hot-list" },
        v.stocks.recommend.length
          ? v.stocks.recommend.map(stockRow)
          : [el("li", { class: "note", text: "기준(점수 +0.1)을 넘는 종목 없음 — 현금 관망 구간" })],
      ),
      ...(v.stocks.avoid.length
        ? [el("p", { class: "vd-h", text: "→ 회피·축소 종목" }), el("ul", { class: "hot-list" }, v.stocks.avoid.map(stockRow))]
        : []),
      el("p", { class: "note", text: v.note }),
    );
  } catch (err) {
    body.replaceChildren(el("p", { class: "note", text: `결론 로딩 실패: ${err instanceof ApiFailure ? err.message : String(err)}` }));
  }
}

/* ── 기회 탐색 — 하락장에서도 ①수혜 경로 ②상대 강세 ③약세 경고 ── */

type RadarTab = "tailwind" | "relative" | "weak";
let radarOppsData: RadarOpps | null = null;
let radarTab: RadarTab = "tailwind";

const RADAR_TAB_NOTE: Record<RadarTab, string> = {
  tailwind: "지수와 무관하게 거시 경로가 순풍인 종목 — 매수 검토 관점",
  relative: "최근 20일, KOSPI보다 잘 버틴 종목(%p) — 하락장의 상대 강세",
  weak: "종합 점수 최하위 — 보유 중이면 매도·회피 관점",
};

/* ── 언어 전환 (국기 클릭 → 자체 실시간 번역) ─────────────────
 * 2026-08-17 구글 번역 위젯 제거(사용자 지시). Workers AI 번역 모델 +
 * KV 사전 캐시로 직접 번역한다 — 결론 엔진이 실시간으로 만드는 문장까지
 * 따라가고, 원문 복귀도 새로고침 없이 즉시다. 3D 캔버스 안 라벨은
 * 그림이라 번역되지 않는다 — 알려진 한계. */

const translator = new SiteTranslator();

function setupLang(): void {
  const box = $("lang-switch");
  const saved = (() => { try { return localStorage.getItem("wfg-lang") ?? ""; } catch { return ""; } })();

  const mark = (lang: string) => {
    for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
      b.classList.toggle("active", (b.dataset.lang ?? "") === lang);
      b.classList.remove("busy");
    }
  };
  mark(saved);
  translator.onBusy = (busy) => {
    box.querySelector<HTMLButtonElement>("button.active")?.classList.toggle("busy", busy);
  };

  const applyLang = (lang: string) => {
    if (lang === "en" || lang === "ja" || lang === "zh-CN") translator.enable(lang);
    else translator.disable();
    mark(lang);
  };

  // 저장된 언어는 첫 데이터가 그려진 뒤에 켠다 — 빈 화면을 번역해 봐야 헛돈다
  if (saved) window.setTimeout(() => applyLang(saved), 2500);

  box.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    const lang = btn.dataset.lang ?? "";
    try { localStorage.setItem("wfg-lang", lang); } catch { /* 무시 */ }
    applyLang(lang);
  });
}

/* ── 밝은/어두운 테마 토글 (localStorage 에 기억) ─────────────── */

function setupTheme(): void {
  const btn = $("btn-theme");
  const apply = (mode: "light" | "dark") => {
    if (mode === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    btn.textContent = mode === "light" ? "🌙 어둡게" : "☀️ 밝게";
    onto?.setLightTheme(mode === "light"); // 3D 무대 흐림 강도도 함께
    try { localStorage.setItem("wfg-theme", mode); } catch { /* 사생활 모드 등 */ }
  };
  apply(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  btn.addEventListener("click", () => {
    apply(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });
}

function setupRadarTabs(): void {
  const tabs = $("radar-tabs");
  tabs.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".radar-tab");
    if (!btn) return;
    radarTab = btn.dataset.tab as RadarTab;
    for (const b of tabs.querySelectorAll(".radar-tab")) b.classList.toggle("active", b === btn);
    renderRadarList();
  });
}

function renderRadarList(): void {
  const list = $("radar-list");
  $("radar-tab-note").textContent = RADAR_TAB_NOTE[radarTab];
  const d = radarOppsData;
  if (!d) return;
  if (!d.available) {
    list.replaceChildren(el("li", { class: "note", text: "레이더 저장소가 아직 준비되지 않았습니다." }));
    return;
  }
  const items = d[radarTab];
  if (!items.length) {
    const msg = radarTab === "relative"
      ? "상대 강세는 다음 스캔 바퀴부터 채워집니다 — 종목당 약 75분."
      : "첫 스캔 대기 중 — 크론이 15분마다 80종목씩 채웁니다.";
    list.replaceChildren(el("li", { class: "note", text: msg }));
    return;
  }
  list.replaceChildren(
    ...items.map((r) => {
      // 탭마다 오른쪽 수치의 의미가 다르다: 수혜=온톨로지, 상대=%p, 약세=종합 점수.
      const val =
        radarTab === "relative"
          ? { text: `${(r.relStrength ?? 0) >= 0 ? "+" : ""}${(r.relStrength ?? 0).toFixed(1)}%p`, cls: dirClass(r.relStrength ?? 0) }
          : radarTab === "tailwind"
            ? { text: `온톨 +${r.onto.toFixed(3)}`, cls: dirClass(r.onto) }
            : { text: r.score.toFixed(3), cls: dirClass(r.score) };
      const btn = el("button", { type: "button" }, [
        el("span", { class: "hot-name" }, [
          el("span", { text: r.name }),
          el("span", { class: "hot-index", text: `${r.sector ?? "미분류"} · ${fmtNum(r.price, 0)}원 · ${fmtPct(r.changePct)}` }),
        ]),
        el("span", { class: val.cls, text: val.text }),
      ]);
      btn.addEventListener("click", () => {
        const t = radarToTicker(r);
        onto?.showTicker(t);
        panel.openTicker(t);
        void taPanel?.show(t.symbol, t.nameKo);
      });
      return el("li", {}, [btn]);
    }),
  );
}

async function loadRadar(): Promise<void> {
  const list = $("radar-list");
  const sub = $("radar-sub");
  try {
    const [opps, st] = await Promise.all([api.radarOpps(8, verdictMarket), api.radarStatus().catch(() => null)]);
    radarOppsData = opps;
    const regime = ontoState
      ? ontoState.riskOff >= 0.5
        ? `하락 국면(위험회피 ${ontoState.riskOff.toFixed(2)}) — 그 안에서 순풍 받는 곳을 찾습니다`
        : `위험회피 ${ontoState.riskOff.toFixed(2)} — 시장 전반과 별개로 종목별 신호를 봅니다`
      : "";
    const scan = st?.available && st.scored !== undefined
      ? `${st.tickers}종목 중 ${st.scored}개 스캔 · 갱신 ${st.newestScoreAt ? timeAgo(st.newestScoreAt) : "-"}`
      : "";
    sub.textContent = [regime, scan].filter(Boolean).join(" · ") || sub.textContent;
    renderRadarList();
  } catch {
    list.replaceChildren(el("li", { class: "note", text: "레이더 로딩 실패" }));
  }
}

/** 레이더 행을 종목 상세 화면이 이해하는 모양으로 변환 */
/**
 * 레이더 행 → 야후 심볼.
 *
 * 레이더 API 는 종목코드만 주고 심볼은 주지 않는다(DB 에는 있지만 응답에 없다).
 * 유니버스 전체가 `코드 + .KS/.KQ` 규칙을 예외 없이 따르므로 여기서 만든다.
 * 미국 종목은 코드가 곧 심볼이다.
 */
function yahooSymbol(code: string, market?: string): string {
  if (!code) return "";
  if (market === "US" || /^[A-Z.]+$/.test(code)) return code;
  return `${code}.${market === "KOSDAQ" ? "KQ" : "KS"}`;
}

function radarToTicker(r: RadarItem): TickerScore {
  return {
    code: r.code,
    symbol: yahooSymbol(r.code, r.market),
    nameKo: r.name,
    price: r.price,
    changePct: r.changePct,
    score: r.score,
    ontologyScore: r.onto,
    priceScore: r.priceScore,
    newsScore: 0,
    volatility: r.volatility,
    atr: 0,
    reasons: r.reasons as TickerScore["reasons"],
    edges: r.edges,
    sector: r.sector,
    asOf: r.updatedAt,
  };
}


/** 차트분석 탭 열기 — 모달이었던 것을 터미널 탭으로 */
function setupTaPane(): void {
  const open = () => selectPane("ta", true);
  $("btn-ta").addEventListener("click", open);
  const w = window as unknown as { __wfgOpenTa?: () => void };
  w.__wfgOpenTa = open;
}

/* ── 기술적 분석 카드 전용 검색 ─────────────────────────
 * 위쪽 종목 검색과 따로 둔 이유는 쓰임이 다르기 때문이다. 저쪽은 온톨로지 경로를
 * 보러 가는 입구이고, 여기는 차트만 보러 오는 사람의 입구다. 하나로 묶으면
 * 차트를 보려고 스크롤을 위로 올라갔다 다시 내려와야 한다. */
function setupTaSearch(): void {
  const input = $<HTMLInputElement>("ta-search");
  const results = $<HTMLUListElement>("ta-results");
  let timer = 0;
  const close = () => { results.hidden = true; results.replaceChildren(); };
  // 미국 종목은 레이더 DB(국내 전용)에 없어서 번들에 실은 목록(104종목)에서 찾는다.
  const usList = usUniverse as { code: string; symbol: string; name: string; sector: string }[];
  // 유명 종목은 한글로 칠 것이다 — 영문 목록만으로는 "테슬라"가 안 잡힌다(실측)
  const US_KO: Record<string, string> = {
    "테슬라": "TSLA", "애플": "AAPL", "엔비디아": "NVDA", "마이크로소프트": "MSFT", "마소": "MSFT",
    "구글": "GOOGL", "알파벳": "GOOGL", "아마존": "AMZN", "메타": "META", "페이스북": "META",
    "넷플릭스": "NFLX", "브로드컴": "AVGO", "버크셔": "BRK-B", "일라이릴리": "LLY", "릴리": "LLY",
    "코카콜라": "KO", "펩시": "PEP", "코스트코": "COST", "월마트": "WMT", "맥도날드": "MCD",
    "디즈니": "DIS", "비자": "V", "마스터카드": "MA", "인텔": "INTC", "제이피모건": "JPM",
  };
  const run = async () => {
    const q = input.value.trim();
    if (!q) return close();
    const qUp = q.toUpperCase();
    const alias = Object.entries(US_KO).find(([ko]) => ko.includes(q) || q.includes(ko))?.[1];
    const usHits = usList
      .filter((u) => u.symbol === alias || u.symbol.startsWith(qUp) || u.name.toUpperCase().includes(qUp))
      .slice(0, 5);
    try {
      const { items } = await api.radarFind(q).catch(() => ({ items: [] as never[] }));
      if (!items.length && !usHits.length) {
        results.replaceChildren(el("li", { class: "note", text: "일치하는 종목이 없습니다 (국내 350 + 미국 104 종목에서 검색)" }));
        results.hidden = false;
        return;
      }
      const pick = (symbol: string, name: string) => {
        void taPanel?.show(symbol, name);
        input.value = "";
        close();
      };
      results.replaceChildren(
        ...items.map((r) => {
          const btn = el("button", { type: "button" }, [
            el("span", {}, [el("span", { text: r.name }), el("span", { class: "cc", text: ` ${r.code} · ${r.sector ?? "미분류"}` })]),
          ]);
          btn.addEventListener("click", () => pick(yahooSymbol(r.code, r.market), r.name));
          return el("li", {}, [btn]);
        }),
        ...usHits.map((u) => {
          const btn = el("button", { type: "button" }, [
            el("span", {}, [el("span", { text: u.name }), el("span", { class: "cc", text: ` ${u.symbol} · 미국 ${u.sector}` })]),
          ]);
          btn.addEventListener("click", () => pick(u.symbol, u.name));
          return el("li", {}, [btn]);
        }),
      );
      results.hidden = false;
    } catch {
      close();
    }
  };
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 250);
  });
  input.addEventListener("blur", () => window.setTimeout(close, 200));
}

/* ── 종목 검색 (조회용 사용자의 첫 진입점) ─────────────── */

function setupTickerSearch(): void {
  const input = $<HTMLInputElement>("ticker-search");
  const results = $<HTMLUListElement>("ticker-results");
  let timer = 0;
  const close = () => {
    results.hidden = true;
    results.replaceChildren();
  };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 1) return close();
    try {
      const { items } = await api.radarFind(q);
      if (!items.length) {
        results.replaceChildren(el("li", { class: "note", text: "일치하는 종목이 없습니다 (KOSPI200·KOSDAQ150 안에서 검색)" }));
        results.hidden = false;
        return;
      }
      results.replaceChildren(
        ...items.map((r) => {
          const btn = el("button", { type: "button" }, [
            el("span", {}, [el("span", { text: r.name }), el("span", { class: "cc", text: ` ${r.code} · ${r.sector ?? "미분류"}` })]),
            el("span", { class: dirClass(r.score), text: r.score.toFixed(3) }),
          ]);
          btn.addEventListener("click", () => {
            const t = radarToTicker(r);
            panel.openTicker(t);
            onto?.showTicker(t);
            void taPanel?.show(t.symbol, t.nameKo);
            input.value = "";
            close();
          });
          return el("li", {}, [btn]);
        }),
      );
      results.hidden = false;
    } catch {
      close();
    }
  };
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      e.preventDefault();
      results.querySelector("button")?.click();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".ticker-search")) close();
  });
}

function setupOntoHelp(): void {
  // 네온 원형 버튼 — 범례(온톨로지 분석 설명) 카드를 껐다 켰다 한다
  const fab = $("btn-legend");
  const legend = $("onto-legend");
  const openLegend = localStorage.getItem("wfg-legend-open") === "1";
  legend.hidden = !openLegend;
  fab.setAttribute("aria-expanded", String(openLegend));
  fab.addEventListener("click", () => {
    legend.hidden = !legend.hidden;
    fab.setAttribute("aria-expanded", String(!legend.hidden));
    try { localStorage.setItem("wfg-legend-open", legend.hidden ? "0" : "1"); } catch { /* 무시 */ }
  });

  const modal = $("onto-help-modal");
  $("btn-onto-help").addEventListener("click", () => (modal.hidden = false));
  $("onto-help-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

/* ── 지구본 (아이콘 + 세계 경제 모달) ─────────────────────────────── */

function setupWorldModal(liveCodes: Set<string>): void {
  const modal = $("world-modal");
  const open = () => {
    modal.hidden = false;
    // 모달이 열린 뒤에야 캔버스 크기가 잡히므로 그때 초기화한다
    if (!globe) setupGlobe(liveCodes, new Set());
    window.dispatchEvent(new Event("resize"));
    void loadWorldIndicators();
  };
  $("btn-world").addEventListener("click", open);
  $("world-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  // 돌아가는 지구본 아이콘
  miniGlobe = new Globe($<HTMLCanvasElement>("mini-globe"), {
    liveCodes,
    orderCodes: new Set(),
    onSelect: () => {},
    onHover: () => {},
    mini: true,
  });
  miniGlobe.init().catch(() => {
    $("btn-world").classList.add("orb-fallback");
  });

  const w = window as unknown as { __wfg?: Record<string, unknown> };
  w.__wfg = { ...(w.__wfg ?? {}), openWorld: open };
}

async function loadWorldIndicators(): Promise<void> {
  const grid = $("world-grid");
  const news = $("world-news");
  grid.replaceChildren(el("p", { class: "note", text: "지표를 불러오는 중…" }));
  news.replaceChildren(el("li", { class: "note", text: "헤드라인을 불러오는 중…" }));
  // 둘을 따로 처리한다 — 뉴스가 죽었다고 지표까지 비우면 안 된다
  const [tape, headlines] = await Promise.allSettled([api.tape(), api.globalNews()]);

  if (tape.status === "fulfilled") {
    $("world-time").textContent = `갱신 ${timeAgo(tape.value.fetchedAt)}`;
    grid.replaceChildren(
      ...tape.value.items.map((i) =>
        el("div", { class: "world-cell" }, [
          el("span", { class: "w-label", text: i.label }),
          el("span", { class: "w-price", text: fmtNum(i.price) }),
          el("span", { class: `w-chg ${dirClass(i.changePct)}`, text: fmtPct(i.changePct) }),
        ]),
      ),
    );
  } else {
    $("world-time").textContent = "지표 로드 실패";
    grid.replaceChildren(el("p", { class: "note", text: "지표를 불러오지 못했습니다." }));
  }

  if (headlines.status === "fulfilled") {
    news.replaceChildren(
      ...headlines.value.items.slice(0, 8).map((n) =>
        el("li", {}, [
          el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer", text: n.title }),
          el("div", { class: "news-meta" }, [el("span", { text: n.source }), el("span", { text: timeAgo(n.publishedAt) })]),
        ]),
      ),
    );
  } else {
    news.replaceChildren(el("li", { class: "note", text: "헤드라인을 불러오지 못했습니다." }));
  }
}

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
            ? `${market.indexName ?? "지수"} · 종목 ${market.tickers}개${
                market.orderableNow ? ` · 주문 ${market.orderableNow}개` : market.orderable ? " · 주문 불가(계좌 모드)" : ""
              }`
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
}

/* ── 히어로 — 백테스트 챔피언과 실계좌 가동 상태를 간판으로 ───────────
 * 2026-08-16 사용자 지시: 계좌 금액 대신 "가장 높은 수익률을 낸 조합"을 자랑한다.
 * 백테스트(측정 고정값)에서 1년 성적 1위 엔진을 챔피언으로 뽑아 걸고, 실계좌에는
 * 어떤 엔진이 가동 중인지(금액 없이)만 보여준다. 실패하면 "—" 로 둔다. */
/* ── 온보딩 투어 — 첫 방문 자동 실행 + 상단 "사용법" 버튼 ─────────── */
const tour = new Tour();

function setupTour(): void {
  $("btn-tour").addEventListener("click", () => tour.start());
  // 첫 방문이면 데이터가 어느 정도 그려진 뒤 자동으로 안내를 시작한다
  if (!Tour.seen()) window.setTimeout(() => { if (!tour.running) tour.start(); }, 3500);
}

function setupHero(): void {
  $("hero-goto-lab").addEventListener("click", () => $("lab-strip").scrollIntoView({ behavior: "smooth" }));
  $("hero-goto-terminal").addEventListener("click", () => $("terminal").scrollIntoView({ behavior: "smooth" }));
  $("hero-open-ta").addEventListener("click", () => $("btn-ta").click());
  $("hero-open-auto").addEventListener("click", () => $("btn-auto").click());
  void fillHero();
  setInterval(() => void fillHero(), 300_000);
}

async function fillHero(): Promise<void> {
  const names: Record<string, string> = {
    onto: "온톨로지", quant: "수급", ta: "차트", hybrid: "온톨로지+수급",
    onto_ta: "온톨로지+차트", quant_ta: "수급+차트", all3: "삼합",
  };
  try {
    const bt = await api.backtest();
    // 챔피언 = 국내 백테스트 최근 1년 수익률 1위 엔진 (7개 조합 전부 비교)
    let best: { name: string; year: number } | null = null;
    for (const e of bt.engineComparison.engines) {
      const year = e.KR?.returns?.[2];
      if (year !== undefined && (!best || year > best.year)) best = { name: names[e.id] ?? e.nameKo, year };
    }
    if (best) {
      $("hero-champ").textContent = best.name;
      const yEl = $("hero-btyear");
      yEl.textContent = `${best.year >= 0 ? "+" : ""}${best.year.toFixed(1)}%`;
      yEl.className = `hero-stat-value ${dirClass(best.year)}`;
    }
  } catch { /* 못 채우면 그대로 둔다 */ }
  try {
    const lab = await api.labOverview();
    const engineName = names[lab.liveEngine] ?? (lab.liveEngine.startsWith("w:") ? "커스텀 조합" : lab.liveEngine);
    $("hero-engine").textContent = `${engineName} 가동 중`;
    if (lab.universe) $("hero-universe").textContent = `${lab.universe.toLocaleString("ko-KR")}종목`;
  } catch { /* 못 채우면 그대로 둔다 */ }
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
  // 앰버 마커는 "지금 실제로 주문 가능한" 시장만 표시한다(모의투자면 국내만).
  const orderCodes = new Set<string>((config?.markets ?? []).filter((m) => m.orderableNow > 0).map((m) => m.cc));

  void orderCodes;
  setupOntology();
  setupWorldModal(liveCodes);
  setupSearch();
  setupAuthModal();
  setupOrderModal();
  setupTerminalTabs();
  setupAutoModal();
  setupTickerSearch();
  setupOntoHelp();
  setupRadarTabs();
  setupTheme();
  setupVerdict();
  setupLang();

  labPanel = new LabPanel({ grid: $("lab-grid"), detail: $("lab-detail"), disclaimer: $("lab-disclaimer") });
  setupHero();
  setupTour();
  taPanel = new TaPanel({ root: $("ta-body"), sub: $("ta-sub") });
  setupTaSearch();
  setupTaPane();
  flowPanel = new FlowPanel({
    root: $("flow-body"),
    profileTabs: $("flow-profiles"),
    onPick: (symbol, name) => {
      selectPane("ta", true);
      void taPanel?.show(symbol, name);
    },
  });
  comboPanel = new ComboPanel({
    presets: $("combo-presets"),
    sliders: $("combo-sliders"),
    body: $("combo-body"),
    onPick: (symbol, name) => {
      selectPane("ta", true);
      void taPanel?.show(symbol, name);
    },
  });
  await Promise.allSettled([loadOntology(), loadTape(), loadRadar(), loadVerdict(), labPanel.load()]);
  // 시세는 주기적으로 갱신(90초 캐시와 맞춤), 온톨로지는 전략 캐시(5분)에 맞춘다
  setInterval(() => void loadTape(), 90_000);
  setInterval(() => void loadOntology(), 300_000);
  setInterval(() => void loadRadar(), 300_000);
  setInterval(() => void loadVerdict(), 300_000);
  setInterval(() => void labPanel?.load(), 300_000);
}

void boot();
