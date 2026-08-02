import "./style.css";
import { Globe, type CountryRef } from "./globe";
import { api, ApiFailure, getTradeToken, setTradeToken, type ConfigResponse, type KisStatus, type Snapshot } from "./api";
import { Panel, type OrderDraft } from "./panel";
import { AutoPanel } from "./autopanel";
import { Ontology3D } from "./ontology3d";
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
    void panel.open("ZZ", c.ko);
    return;
  }
  void panel.open(c.iso2, c.ko);
  history.replaceState(null, "", `#${c.iso2}`);
  // 나라를 골랐으면 모달의 목적은 끝났다. 오른쪽 상세로 시선을 넘긴다.
  $("world-modal").hidden = true;
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
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
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
      if (sc) panel.openTicker(sc);
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
  });
  onto.init();

  const w = window as unknown as { __wfg?: Record<string, unknown> };
  w.__wfg = { ...(w.__wfg ?? {}), onto };

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
    renderScoreList(ontoState);
    renderMacroLinks(ontoState);
    // 첫 방문이면 최고 점수 종목의 분석을 예시로 열어 준다 — 빈 패널만 보고 나가지 않게.
    if (!exampleShown && ontoState.scores.length && $("panel-body").hidden) {
      exampleShown = true;
      panel.openTicker({ ...ontoState.scores[0], asOf: ontoState.generatedAt });
      onto?.showTicker(ontoState.scores[0]);
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
      });
      return el("li", {}, [btn]);
    }),
  );
}

/* ── 온톨로지 결론 — 요인 인과 → 국면 → 섹터·종목 추천 출력 ── */

let verdictMarket: "KR" | "US" = "KR";
let lastVerdict: OntoVerdict | null = null;

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

function setupVerdict(): void {
  const tabs = $("verdict-mkt");
  tabs.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".radar-tab");
    if (!btn) return;
    verdictMarket = (btn.dataset.mkt as "KR" | "US") ?? "KR";
    for (const b of tabs.querySelectorAll(".radar-tab")) b.classList.toggle("active", b === btn);
    void loadVerdict();
    void loadRadar(); // 기회 탐색도 같은 시장으로 따라간다
  });
}

async function loadVerdict(): Promise<void> {
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
          if (r) { const t = radarToTicker(r); onto?.showTicker(t); panel.openTicker(t); }
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

/* ── 언어 전환 (국기 클릭 → 구글 웹사이트 번역) ─────────────────
 * 결론 엔진이 실시간으로 만드는 한국어 문장(국면·인과·근거)까지 통째로
 * 번역하려면 DOM 번역 방식이 유일하게 현실적이다. 3D 캔버스 안 라벨은
 * 그림이라 번역되지 않는다 — 알려진 한계. */

function setupLang(): void {
  const box = $("lang-switch");
  const saved = (() => { try { return localStorage.getItem("wfg-lang") ?? ""; } catch { return ""; } })();

  const mark = (lang: string) => {
    for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
      b.classList.toggle("active", (b.dataset.lang ?? "") === lang);
    }
  };
  mark(saved);

  if (saved) {
    // googtrans 쿠키를 심어 두면 위젯이 로드 즉시 그 언어로 번역한다
    document.cookie = `googtrans=/ko/${saved};path=/`;
    (window as unknown as { googleTranslateElementInit?: () => void }).googleTranslateElementInit = () => {
      const g = (window as unknown as { google?: { translate?: { TranslateElement?: new (o: object, id: string) => void } } }).google;
      if (g?.translate?.TranslateElement) {
        new g.translate.TranslateElement({ pageLanguage: "ko", autoDisplay: false }, "google_translate_element");
      }
    };
    const s = document.createElement("script");
    s.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
    s.async = true;
    document.head.appendChild(s);
  }

  box.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    const lang = btn.dataset.lang ?? "";
    try { localStorage.setItem("wfg-lang", lang); } catch { /* 무시 */ }
    if (lang) document.cookie = `googtrans=/ko/${lang};path=/`;
    else document.cookie = "googtrans=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT";
    location.reload();
  });
}

/* ── 밝은/어두운 테마 토글 (localStorage 에 기억) ─────────────── */

function setupTheme(): void {
  const btn = $("btn-theme");
  const apply = (mode: "light" | "dark") => {
    if (mode === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    btn.textContent = mode === "light" ? "🌙 어둡게" : "☀️ 밝게";
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
function radarToTicker(r: RadarItem): TickerScore {
  return {
    code: r.code,
    symbol: "",
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
  setupAutoModal();
  setupTickerSearch();
  setupOntoHelp();
  setupRadarTabs();
  setupTheme();
  setupVerdict();
  setupLang();

  await Promise.allSettled([loadOntology(), loadTape(), loadRadar(), loadVerdict()]);
  // 시세는 주기적으로 갱신(90초 캐시와 맞춤), 온톨로지는 전략 캐시(5분)에 맞춘다
  setInterval(() => void loadTape(), 90_000);
  setInterval(() => void loadOntology(), 300_000);
  setInterval(() => void loadRadar(), 300_000);
  setInterval(() => void loadVerdict(), 300_000);
}

void boot();
