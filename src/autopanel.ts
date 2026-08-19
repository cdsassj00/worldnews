/**
 * 자동매매 대시보드.
 *
 * 보여줘야 할 것은 "얼마 벌었나"가 아니라 "지금 왜 이걸 사려 하고, 무엇이 막고 있나"다.
 * 그래서 게이트(막는 이유) → 손익 → 거시신호 → 보유 → 계획 → 점수 근거 → 일지 순으로 쌓는다.
 */
import {
  api,
  ApiFailure,
  type AutoPlan,
  type AutoStatus,
  type JournalEntry,
  type OntologyGraph,
  type PlannedOrder,
  type TickerScore,
  setTradeToken,
  type BacktestResults,
} from "./api";
import { dirClass, el, fmtKrw, fmtNum, fmtPct, svgEl, timeAgo } from "./format";

export interface AutoPanelDeps {
  root: HTMLElement;
  badge: HTMLElement;
  onNeedAuth: () => void;
}

export class AutoPanel {
  private deps: AutoPanelDeps;
  private plan: AutoPlan | null = null;
  private status: AutoStatus | null = null;
  private journal: JournalEntry[] = [];
  private graph: OntologyGraph | null = null;
  /** 온톨로지 경로도에서 지금 펼쳐 보고 있는 종목 */
  private focusCode = "";
  private busy = false;
  /** 엔진 전환 상태 문구 — 다시 그려도 살아남게 인스턴스로 들고 있는다 */
  private readonly engineStatus = el("p", { class: "modal-status" });
  /**
   * 인라인 거래 암호 입력.
   *
   * 예전에는 암호가 없으면 "우측 상단 거래 암호를 누르세요" 모달로 튕겼다.
   * 누르려던 자리에서 손이 끊기는 흐름이라, 하려던 동작(엔진 전환)이 무엇이었는지
   * 사용자가 다시 기억해서 되돌아와야 했다. 그 자리에서 바로 입력하고 이어지게 한다.
   */
  private readonly inlineAuth = el("div", { class: "inline-auth", hidden: "hidden" });
  /** 백테스트 성적표 — 서버가 고정해 둔 실측값 */
  private bt: BacktestResults | null = null;
  private btMarket: "KR" | "US" = "KR";
  private readonly btBody = el("div", { class: "bt-body" }, [el("p", { class: "note", text: "성적표 불러오는 중…" })]);
  /** 암호 입력 뒤 이어서 실행할 동작 */
  private pendingAction: (() => Promise<void>) | null = null;

  constructor(deps: AutoPanelDeps) {
    this.deps = deps;
    /* 실시간 최신화(2026-08-18 사용자 지시) — 화면이 보이는 동안 60초마다 계획을
     * 다시 받는다. 서버 계획 캐시가 45초라 매번 새 숫자가 온다. 탭이 숨겨져 있거나
     * 아직 한 번도 로드하지 않았거나 작업 중이면 건너뛴다. */
    window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!this.plan || this.busy) return;
      if (!this.deps.root.isConnected || this.deps.root.closest("[hidden]")) return;
      void this.refresh();
    }, 60_000);
  }

  /** 조용한 갱신 — load()와 달리 "불러오는 중" 화면으로 갈아엎지 않는다 */
  private async refresh(): Promise<void> {
    try {
      const [plan, journal] = await Promise.all([api.autoPlan(), api.autoJournal()]);
      this.plan = plan;
      this.journal = journal.items;
      this.render();
    } catch { /* 다음 주기에 재시도 — 조용한 갱신은 실패를 떠들지 않는다 */ }
  }

  async load(): Promise<void> {
    this.deps.root.replaceChildren(el("p", { class: "note", text: "자동매매 상태를 불러오는 중… (거시지표·종목 시세를 계산하느라 10초 정도 걸릴 수 있습니다)" }));
    const [status, plan, journal, graph, bt] = await Promise.allSettled([
      api.autoStatus(),
      api.autoPlan(),
      api.autoJournal(),
      this.graph ? Promise.resolve(this.graph) : api.autoGraph(),
      // 엔진 프리셋 카드가 백테스트 성적을 붙이므로 렌더 전에 받아 둔다
      this.bt ? Promise.resolve(this.bt) : api.backtest(),
    ]);
    this.status = status.status === "fulfilled" ? status.value : null;
    this.plan = plan.status === "fulfilled" ? plan.value : null;
    this.journal = journal.status === "fulfilled" ? journal.value.items : [];
    if (graph.status === "fulfilled") this.graph = graph.value;
    if (bt.status === "fulfilled") this.bt = bt.value;
    if (!this.plan && plan.status === "rejected") {
      const err = plan.reason;
      // 2026-08-16 이후 이 화면은 운영자 전용 — 암호가 없거나 틀리면 그 자리에서 받는다
      const needsAuth = err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401);
      if (needsAuth) {
        this.deps.root.replaceChildren(
          el("p", { class: "note", text: "자동매매 화면은 운영자 전용입니다. 거래 암호를 입력하면 열립니다." }),
          this.inlineAuth,
        );
        this.renderBadge();
        this.askAuthInline("자동매매 화면을 엽니다", () => this.load());
        return;
      }
      const msg = err instanceof ApiFailure ? err.message : String(err);
      this.deps.root.replaceChildren(el("p", { class: "note err", text: `계획을 만들지 못했습니다: ${msg}` }));
      this.renderBadge();
      return;
    }
    this.render();
  }

  renderBadge(): void {
    const badge = this.deps.badge;
    const s = this.status;
    if (!s) {
      badge.textContent = "자동매매 상태 없음";
      badge.className = "badge badge-muted";
      return;
    }
    if (s.state.haltedPermanent) {
      badge.textContent = "영구 정지";
      badge.className = "badge badge-off";
    } else if (s.state.haltedDay === s.kst.date) {
      badge.textContent = "당일 정지";
      badge.className = "badge badge-off";
    } else if (!s.config.enabled) {
      badge.textContent = "관찰 모드";
      badge.className = "badge badge-paper";
    } else if (s.dryRun) {
      badge.textContent = "검증 모드";
      badge.className = "badge badge-paper";
    } else {
      badge.textContent = "실매매 가동";
      badge.className = "badge badge-real";
    }
    badge.title = `${s.market.label} · 유니버스 ${s.universe}종목`;
  }

  private render(): void {
    const p = this.plan;
    if (!p) return;
    this.renderBadge();
    if (!this.focusCode && p.top.length) this.focusCode = p.top[0].code;
    /* 화면 순서 (2026-08-18 사용자 지시): ① 계좌 전체 → ② 한국·미국 배분 →
     * ③ 🇰🇷 한국 봇(전략·게이트·자금·보유·계획) → ④ 🇺🇸 미국 봇(전략·자금·보유)
     * → 성적표·분석 상세·수동 제어·일지. 한국 것과 미국 것을 섞지 않는다. */
    this.deps.root.replaceChildren(
      this.moneyBlock(p),
      this.allocBlock(p),
      this.marketGroup("kr", "🇰🇷 한국 봇", [
        el("span", { class: `gate-pill ${p.gate.canTrade ? "on" : "off"}`, text: p.gate.canTrade ? "가동" : "대기" }),
        el("span", { class: "mg-sub", text: `전략 ${p.engineName} · ${p.market.label}` }),
      ], [
        this.engineBlock(p),
        this.gateBlock(p),
        this.krFundsBlock(p),
        this.positionsBlock(p),
        this.ordersBlock(p),
      ]),
      this.marketGroup("us", "🇺🇸 미국 봇", [
        el("span", { class: `gate-pill ${p.us.enabled ? "on" : "off"}`, text: p.us.enabled ? "가동" : "꺼짐" }),
        el("span", { class: "mg-sub", text: `전략 ${p.us.engineName} (한국과 독립) · ${p.us.marketOpen ? "정규장 진행중" : "장 마감 (개장 22:30 KST)"}` }),
      ], [
        this.usBlock(p),
      ]),
      this.backtestBlock(),
      this.macroBlock(p),
      this.ontologyBlock(p),
      this.scoresBlock(p),
      this.controlsBlock(),
      this.journalBlock(),
      el("p", { class: "note", text: `계획 생성 ${timeAgo(p.generatedAt)} · 계획은 2분 캐시됩니다.` }),
    );
  }

  /** 시장 그룹 래퍼 — 한국/미국 봇을 시각적으로 확실히 분리한다 */
  private marketGroup(id: "kr" | "us", title: string, badges: HTMLElement[], blocks: HTMLElement[]): HTMLElement {
    return el("section", { class: `market-group mg-${id}` }, [
      el("div", { class: "mg-head" }, [el("h2", { text: title }), ...badges]),
      ...blocks,
    ]);
  }

  /* ── 블록들 ─────────────────────────────── */

  /**
   * 백테스트 결과를 대시보드 맨 위에 고정한다.
   * 불리한 결과라서 더더욱 숨기면 안 된다 — 이 화면을 보고 실매매를 켜기 때문이다.
   */
  private backtestBlock(): HTMLElement {
    const box = el("section", { class: "auto-block bt-block" }, [
      el("h3", {}, [
        el("span", { text: "과거 검증 결과 (반드시 읽을 것)" }),
        el("span", { class: "gate-pill off", text: "모의 실험" }),
      ]),
      this.btBody,
    ]);
    if (!this.bt) void this.loadBacktest();
    else this.renderBacktest();
    return box;
  }

  private async loadBacktest(): Promise<void> {
    try {
      this.bt = await api.backtest();
      this.renderBacktest();
    } catch {
      this.btBody.replaceChildren(el("p", { class: "note", text: "성적표를 불러오지 못했습니다." }));
    }
  }

  /**
   * 엔진별·규칙별 성적표.
   * 예전에는 2년·5년 두 줄만 있었는데, 사용자는 단타를 하므로 3·6·12개월이 필요하고
   * 엔진이 넷으로 늘어난 이상 엔진별로 나눠야 고를 수가 있다.
   */
  private renderBacktest(): void {
    const b = this.bt;
    if (!b) return;
    const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const cls = (v: number) => (v >= 0 ? "up" : "down");

    const table = (windows: string[], rows: { name: string; returns: number[] | null; dd?: number[]; note?: string; live?: boolean; pending?: string }[]) => {
      const head = el("div", { class: "bt-row bt-head" }, [
        el("span", { text: "" }),
        ...windows.map((w) => el("span", { text: w === "3mo" ? "3개월" : w === "6mo" ? "6개월" : "1년" })),
      ]);
      const body = rows.map((r) =>
        el("div", { class: `bt-row${r.live ? " bt-live" : ""}` }, [
          el("span", { class: "bt-period", text: r.live ? `${r.name} ← 지금` : r.name }),
          ...(r.returns
            ? r.returns.map((v, i) =>
                el("span", { class: `bt-num ${cls(v)}`, title: r.dd ? `최대낙폭 -${r.dd[i]}%` : "", text: pct(v) }))
            : [el("span", { class: "bt-num", style: "grid-column: span 3; opacity:.7", text: r.pending ?? "미측정" })]),
        ]),
      );
      const notes = rows.filter((r) => r.note).map((r) => el("p", { class: "note", text: `· ${r.name} — ${r.note}` }));
      return el("div", { class: "bt-table" }, [head, ...body, ...notes]);
    };

    const ec = b.engineComparison;
    const lr = b.liveRuleComparison;
    const market = this.btMarket;

    const marketTabs = el("div", { class: "radar-tabs" });
    for (const m of ["KR", "US"] as const) {
      const btn = el("button", { type: "button", class: `radar-tab${market === m ? " active" : ""}`, text: m === "KR" ? "국내" : "미국" });
      btn.addEventListener("click", () => { this.btMarket = m; this.renderBacktest(); });
      marketTabs.append(btn);
    }

    this.btBody.replaceChildren(
      el("p", { class: "note err", text: b.disclaimer + ` (측정 ${b.measuredAt})` }),
      el("h4", { class: "bt-h4", text: `① ${ec.title}` }),
      marketTabs,
      table(
        ec.windows,
        ec.engines.map((e) => {
          const m = market === "KR" ? e.KR : e.US;
          return { name: e.nameKo, returns: m ? m.returns : null, dd: m?.maxDd, pending: e.pending };
        }),
      ),
      el("p", { class: "note", text: `규칙: ${ec.rules}` }),
      el("p", { class: "note", text: `유니버스 ${ec.universe[market]} · 비용 ${ec.cost[market]}` }),

      el("h4", { class: "bt-h4", text: `② ${lr.title}` }),
      table(lr.windows,
        lr.variants.map((v) => ({ name: v.nameKo, returns: v.returns, dd: v.maxDd, note: v.note, live: v.live }))),
      el("p", { class: "note err-soft", text: lr.verdict }),
      el("p", { class: "note", text: `재현: ${lr.command}` }),
    );
  }

  /**
   * 매매 엔진 선택 — 무엇을 살지 정하는 점수를 어디서 가져올지 고른다.
   * 실제 돈이 걸린 선택이라 각 엔진의 검증 성적을 바로 옆에 붙인다.
   * 숫자를 감추고 고르게 하면 그건 선택이 아니라 도박이다.
   */
  /* 세 분석(온톨로지·수급·차트)의 7개 조합 + 커스텀 가중치.
   * 각 프리셋에는 백테스트(고정 실측값)의 국내·미국 수익률을 그대로 붙인다 —
   * 숫자를 감추고 고르게 하면 그건 선택이 아니라 도박이다. */
  private static readonly ENGINE_PRESETS: { id: string; nameKo: string; w: { onto: number; flow: number; chart: number } }[] = [
    { id: "onto", nameKo: "온톨로지", w: { onto: 100, flow: 0, chart: 0 } },
    { id: "quant", nameKo: "수급", w: { onto: 0, flow: 100, chart: 0 } },
    { id: "ta", nameKo: "차트", w: { onto: 0, flow: 0, chart: 100 } },
    { id: "hybrid", nameKo: "온톨로지+수급", w: { onto: 50, flow: 50, chart: 0 } },
    { id: "onto_ta", nameKo: "온톨로지+차트", w: { onto: 50, flow: 0, chart: 50 } },
    { id: "quant_ta", nameKo: "수급+차트", w: { onto: 0, flow: 50, chart: 50 } },
    { id: "all3", nameKo: "삼합", w: { onto: 34, flow: 33, chart: 33 } },
  ];

  private perfLine(id: string, mkt: "KR" | "US"): string {
    const row = this.bt?.engineComparison.engines.find((e) => e.id === id);
    const r = mkt === "KR" ? row?.KR?.returns : row?.US?.returns;
    if (!r || r.length < 3) return `${mkt === "KR" ? "국내" : "미국"} 미측정`;
    const f = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    return `${mkt === "KR" ? "국내" : "미국"} ${f(r[0])} / ${f(r[1])} / ${f(r[2])}`;
  }

  private engineBlock(p: AutoPlan): HTMLElement {
    const buttons = el("div", { class: "engine-picker" });
    for (const preset of AutoPanel.ENGINE_PRESETS) {
      const active = p.engine === preset.id;
      const b = el("button", {
        type: "button",
        class: `engine-btn${active ? " active" : ""}`,
        "aria-pressed": active ? "true" : "false",
      }, [
        el("span", { class: "engine-name", text: preset.nameKo }),
        el("span", { class: "engine-perf", text: this.perfLine(preset.id, "KR") }),
        el("span", { class: "engine-perf", text: this.perfLine(preset.id, "US") }),
      ]);
      b.addEventListener("click", () => {
        if (active) return; // 이미 쓰고 있는 엔진
        // 먼저 눌린 티를 낸다 — 서버 왕복 동안 아무 반응이 없으면 "안 눌린다"로 읽힌다
        buttons.querySelectorAll(".engine-btn").forEach((n) => n.classList.remove("active"));
        b.classList.add("active");
        this.engineStatus.textContent = `${preset.nameKo} 로 바꾸는 중…`;
        this.engineStatus.className = "modal-status";
        void this.switchEngine({ engine: preset.id }, preset.nameKo);
      });
      buttons.append(b);
    }

    // 커스텀 가중치 — 조합의 비율을 직접 정한다. 적용 버튼을 눌러야 실계좌에 반영.
    const w = { ...p.engineWeights };
    const sliderRow = (key: "onto" | "flow" | "chart", label: string) => {
      const input = el("input", { type: "range", min: 0, max: 100, step: 5, value: w[key] }) as HTMLInputElement;
      const val = el("span", { class: "combo-slider-val", text: `${w[key]}%` });
      input.addEventListener("input", () => { w[key] = Number(input.value); val.textContent = `${w[key]}%`; });
      return el("label", { class: "combo-slider" }, [el("span", { class: "combo-slider-label", text: label }), input, val]);
    };
    const applyBtn = el("button", { class: "btn btn-ghost", type: "button", text: "이 비율로 실계좌 적용" });
    applyBtn.addEventListener("click", () => {
      if (w.onto + w.flow + w.chart <= 0) {
        this.engineStatus.textContent = "가중치 합이 0입니다 — 적어도 한 축은 올려야 합니다.";
        this.engineStatus.className = "modal-status err";
        return;
      }
      this.engineStatus.textContent = `온톨로지 ${w.onto}% · 수급 ${w.flow}% · 차트 ${w.chart}% 로 바꾸는 중…`;
      this.engineStatus.className = "modal-status";
      void this.switchEngine({ weights: { ...w } }, `커스텀 ${w.onto}·${w.flow}·${w.chart}`);
    });
    const custom = el("div", { class: "engine-custom" }, [
      el("p", { class: "note", text: "직접 조합 — 세 분석의 비율을 정하면 그 가중 평균 점수로 종목을 고릅니다. 프리셋 밖 비율은 백테스트 미측정입니다." }),
      sliderRow("onto", "온톨로지"),
      sliderRow("flow", "수급"),
      sliderRow("chart", "차트"),
      applyBtn,
    ]);

    return el("section", { class: "auto-block engine-block" }, [
      el("h3", {}, [
        el("span", { text: "매매 엔진 — 조합 선택" }),
        el("span", { class: "gate-pill", text: `${p.engineName} (${p.engineWeights.onto}·${p.engineWeights.flow}·${p.engineWeights.chart})` }),
      ]),
      buttons,
      custom,
      this.engineStatus,
      this.inlineAuth,
      el("p", { class: "note", text: p.engineNote }),
      el("p", {
        class: "note",
        text: "프리셋 성적은 3개월/6개월/1년 백테스트 수익률(저회전+시장국면 필터 규칙, 2026-08-16 재측정)입니다. 바꾸는 즉시 한 사이클이 돌아 장중이면 실주문까지 나갑니다. 주문·손절·한도 같은 안전장치는 조합과 무관하게 동일하게 작동합니다.",
      }),
    ]);
  }

  /**
   * 암호를 그 자리에서 받는다. 입력하면 원래 하려던 동작을 이어서 실행한다.
   * 실패해도 창을 닫지 않는다 — 오타 한 번에 처음부터 다시 하게 만들면 안 된다.
   */
  private askAuthInline(reason: string, retry: () => Promise<void>): void {
    this.pendingAction = retry;
    const input = el("input", { type: "password", placeholder: "거래 암호", autocomplete: "current-password" }) as HTMLInputElement;
    const ok = el("button", { class: "btn btn-primary", type: "button", text: "확인하고 계속" });
    const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "취소" });
    const submit = async () => {
      const v = input.value.trim();
      if (!v) return;
      setTradeToken(v);
      const go = this.pendingAction;
      this.pendingAction = null;
      this.inlineAuth.hidden = true;
      this.inlineAuth.replaceChildren();
      if (go) await go();
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
    cancel.addEventListener("click", () => {
      this.pendingAction = null;
      this.inlineAuth.hidden = true;
      this.inlineAuth.replaceChildren();
      this.engineStatus.textContent = "";
    });
    this.inlineAuth.replaceChildren(
      el("span", { class: "inline-auth-label", text: reason }),
      input, ok, cancel,
    );
    this.inlineAuth.hidden = false;
    input.focus();
  }

  private async switchEngine(payload: { engine?: string; weights?: { onto: number; flow: number; chart: number } }, label: string): Promise<void> {
    try {
      const res = await api.autoSetEngine(payload);
      await this.load();
      // load() 가 새로 그리므로 이 노드는 살아남는다(같은 인스턴스를 다시 붙인다)
      this.engineStatus.textContent = `엔진을 ${res.engineName} 로 바꿨습니다 — 즉시 사이클이 실행됩니다.`;
      this.engineStatus.className = "modal-status ok";
    } catch (err) {
      const failed = err instanceof ApiFailure;
      const needsAuth = failed && (err.code === "no_local_token" || err.status === 401);
      this.engineStatus.textContent = needsAuth
        ? "엔진을 바꾸려면 거래 암호가 필요합니다."
        : failed ? `엔진 변경 실패 — ${err.message}` : String(err);
      this.engineStatus.className = "modal-status err";
      await this.load(); // 낙관적으로 바꿔 둔 표시를 서버 상태로 되돌린다
      if (needsAuth) this.askAuthInline(`${label} 엔진으로 바꿉니다`, () => this.switchEngine(payload, label));
    }
  }

  private gateBlock(p: AutoPlan): HTMLElement {
    const items = p.gate.canTrade
      ? [el("li", { class: "gate-ok", text: "모든 안전장치를 통과했습니다 — 계획된 주문이 전송됩니다." })]
      : p.gate.reasons.map((r) => el("li", { text: r }));
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [
        el("span", { text: "지금 주문이 나가는가" }),
        el("span", { class: `gate-pill ${p.gate.canTrade ? "on" : "off"}`, text: p.gate.canTrade ? "가동" : "차단" }),
      ]),
      el("ul", { class: "gate-list" }, items),
      el("p", { class: "note", text: p.market.label + " · " + p.kst.date + " " + p.kst.hhmm + " KST" }),
    ]);
  }

  /** ① 계좌 전체 — 넣은 돈이 지금 어디에 얼마로 있고, 얼마를 벌었나. 봇 얘기는 아래 섹션에서. */
  private moneyBlock(p: AutoPlan): HTMLElement {
    const krStockKrw = p.investedKrw - p.usValueKrw;
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "① 내 계좌 전체" })]),
      el("div", { class: "auto-grid" }, [
        stat("내가 넣은 돈", fmtKrw(p.depositKrw)),
        stat("주식", p.account.connected ? fmtKrw(p.investedKrw) : "-"),
        stat("현금", p.account.connected ? fmtKrw(p.cashKrw) : "-"),
        stat(
          "수익",
          p.account.connected
            ? `${p.netProfitKrw >= 0 ? "+" : ""}${fmtKrw(p.netProfitKrw)} (${p.netProfitPct >= 0 ? "+" : ""}${p.netProfitPct}%)`
            : "-",
          p.account.connected ? dirClass(p.netProfitKrw) : "",
        ),
      ]),
      el("p", {
        class: "auto-sub",
        text: p.account.connected
          ? `계좌 ${fmtKrw(p.equity)} = 한국 주식 ${fmtKrw(krStockKrw)} + 미국 주식 ${fmtKrw(p.usValueKrw)} + 현금 ${fmtKrw(p.cashKrw)}  ·  넣은 돈 ${fmtKrw(p.depositKrw)} 대비 ${p.netProfitKrw >= 0 ? "+" : "−"}${fmtKrw(Math.abs(p.netProfitKrw))}`
          : "계좌 조회 실패로 표시할 수 없습니다",
      }),
      el("p", {
        class: "note",
        text: `‘수익’은 추정 없이 실측값만 더한 것입니다: 한국 보유 평가손익(증권사 제공) + 한국 실현손익(체결가) + 미국 보유 평가손익(증권사 제공) + 미국 실현손익.`,
      }),
      // 예수금 원본과 표시 현금이 다르면 이유를 밝힌다 — 결제(1~2영업일) 이동 중인 돈
      ...(p.account.connected && Math.abs(p.bankCashKrw - p.cashKrw) > 10_000
        ? [el("p", {
            class: "note",
            text: `※ 증권사 앱의 원화 예수금은 ${fmtKrw(p.bankCashKrw)}으로 보입니다 — 아직 결제(1~2영업일)가 끝나지 않은 매수 대금 ${fmtKrw(Math.abs(p.bankCashKrw - p.cashKrw))}이 포함된 값이라서, 여기서는 결제 후 남을 현금(${fmtKrw(p.cashKrw)})으로 표시합니다.`,
          })]
        : []),
      ...(p.account.reason ? [el("p", { class: "note", text: `※ ${p.account.reason}` })] : []),
    ]);
  }

  /** ② 한국·미국 배분 — 넣은 돈을 두 봇이 어떻게 나눠 쓰는가 + 슬라이더 */
  private allocBlock(p: AutoPlan): HTMLElement {
    const total = Math.max(1, p.depositKrw);
    const usPct = Math.round(((p.reserveKrw || 0) / total) * 100);
    const krKrw = Math.max(0, p.depositKrw - p.reserveKrw);
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "② 한국 · 미국 배분" })]),
      el("div", { class: "alloc-bar", title: `한국 ${100 - usPct}% · 미국 ${usPct}%` }, [
        el("i", { class: "kr", style: `width:${100 - usPct}%` }),
        el("i", { class: "us", style: `width:${usPct}%` }),
      ]),
      el("div", { class: "alloc-legend" }, [
        el("span", {}, [el("b", { text: `🇰🇷 한국 ${100 - usPct}%` }), el("i", { text: ` · ${fmtKrw(krKrw)}` })]),
        el("span", {}, [el("b", { text: `🇺🇸 미국 ${usPct}%` }), el("i", { text: ` · ${fmtKrw(p.reserveKrw)}` })]),
      ]),
      this.reserveRow(p),
    ]);
  }

  /** 🇰🇷 한국 봇의 자금·목표·규칙 */
  private krFundsBlock(p: AutoPlan): HTMLElement {
    const c = p.config;
    const pct = Math.max(-100, Math.min(100, p.targetProgressPct));
    // 타일 구성은 미국 섹션과 완전히 동일해야 한다(2026-08-19 사용자 지시 "왜 계산법이 다르냐")
    const holdPnl = p.pnlKrw - p.realizedKrw;
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "한국 봇 자금" })]),
      el("div", { class: "auto-grid" }, [
        stat("예산(한국 몫)", fmtKrw(Math.max(0, c.capitalKrw - p.reserveKrw))),
        stat("주식에 투입", fmtKrw(p.deployedKrw)),
        stat("매수 여유", fmtKrw(p.budgetKrw)),
        stat(
          "손익(실현 포함)",
          p.account.connected ? `${p.pnlKrw >= 0 ? "+" : ""}${fmtKrw(p.pnlKrw)}` : "-",
          p.account.connected ? dirClass(p.pnlKrw) : "",
        ),
      ]),
      el("p", {
        class: "note",
        text: `손익 = 보유 평가손익 ${holdPnl >= 0 ? "+" : ""}${fmtKrw(holdPnl)} + 실현손익 ${p.realizedKrw >= 0 ? "+" : ""}${fmtKrw(p.realizedKrw)} (증권사 실측·체결가 기준, 미국 섹션과 같은 계산법).`,
      }),
      el("div", { class: "target-bar", title: `목표 ${fmtKrw(c.targetProfitKrw)} 대비 ${p.targetProgressPct}%` }, [
        el("i", { style: `width:${Math.max(0, pct)}%` }),
      ]),
      el("p", {
        class: "note",
        text: `목표 ${fmtKrw(c.targetProfitKrw)} · 진행 ${p.targetProgressPct}% · 종목당 최대 ${c.maxPositionPct}% · 손절 -${c.stopLossPct}% · 익절 +${c.takeProfitPct}% · 당일정지 -${c.dailyLossHaltPct}% · 영구정지 -${c.maxDrawdownPct}% · 위험회피 ${p.riskOff}`,
      }),
    ]);
  }

  /** 🇺🇸 미국 봇 — 자금·보유 종목. 원장이 한국과 완전히 분리되어 있다. */
  private usBlock(p: AutoPlan): HTMLElement {
    const u = p.us;
    const investedKrw = u.valueKrw;
    const freeKrw = Math.max(0, u.budgetKrw - investedKrw);
    const rows = u.positions.length
      ? u.positions.map((pos) =>
          el("div", { class: "pos-row" }, [
            el("div", { class: "pos-name" }, [
              el("b", { text: pos.name }),
              el("span", { class: "mono", text: pos.code }),
            ]),
            el("div", { class: "pos-qty", text: `${fmtNum(pos.qty, 0)}주 · 평단 $${pos.avgPriceUsd.toFixed(2)} · 현재 $${pos.priceUsd.toFixed(2)}` }),
            el("div", { class: `pos-pnl ${dirClass(pos.pnlPct)}`, text: fmtPct(pos.pnlPct) }),
            el("div", { class: "pos-reason", text: `≈ ${fmtKrw(pos.valueKrw)}` }),
          ]),
        )
      : [el("p", { class: "note", text: "미국 봇이 보유한 종목이 없습니다. 개장(22:30 KST) 후 첫 사이클부터 매수를 검토합니다." })];
    const totalPnl = u.pnlKrw + u.realizedKrw;
    /* 미국 엔진 선택 칩 — 한국 엔진과 완전 별개(2026-08-19 사용자 지시 "미국 별도 세팅") */
    const engineStatus = el("span", { class: "reserve-status", text: "" });
    const engineRow = el("div", { class: "radar-tabs us-engine" },
      [["onto", "온톨로지"], ["quant", "수급"], ["ta", "차트"], ["fusion", "융합"]].map(([id, name]) => {
        const btn = el("button", { class: `radar-tab ${u.engine === id ? "active" : ""}`, type: "button", text: name });
        btn.addEventListener("click", () => {
          if (u.engine === id) return;
          engineStatus.textContent = `${name} 엔진으로 전환 중…`;
          void api.usSetEngine(id)
            .then(() => { engineStatus.textContent = `전환됨 — 다음 사이클부터 ${name} 점수로 매매합니다`; engineStatus.className = "reserve-status ok"; void this.load(); })
            .catch((e) => { engineStatus.textContent = `실패: ${e instanceof Error ? e.message : e}`; engineStatus.className = "reserve-status err"; });
        });
        return btn;
      }));
    // 타일 구성은 한국 섹션과 완전히 동일 — 예산 / 투입 / 여유 / 손익(실현 포함)
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "미국 봇 자금 · 보유 종목" })]),
      el("div", { class: "us-engine-row" }, [el("span", { class: "k", text: "미국 엔진" }), engineRow, engineStatus]),
      el("div", { class: "auto-grid" }, [
        stat("예산(미국 몫)", fmtKrw(u.budgetKrw)),
        stat("주식에 투입", fmtKrw(investedKrw)),
        stat("매수 여유", fmtKrw(freeKrw)),
        stat("손익(실현 포함)", `${totalPnl >= 0 ? "+" : ""}${fmtKrw(totalPnl)}`, dirClass(totalPnl)),
      ]),
      el("p", {
        class: "note",
        text: `손익 = 보유 평가손익 ${u.pnlKrw >= 0 ? "+" : ""}${fmtKrw(u.pnlKrw)} + 실현손익 ${u.realizedKrw >= 0 ? "+" : ""}${fmtKrw(u.realizedKrw)} (KIS 실측·체결가 기준, 한국 섹션과 같은 계산법).`,
      }),
      el("div", { class: "pos-list" }, rows),
      el("p", {
        class: "note",
        text: `보유·평가손익은 KIS 해외 잔고 실측값입니다 (${u.balanceAt ? timeAgo(u.balanceAt) + " 조회" : "조회 전"}, 장중 15분마다 갱신 · 방금 낸 주문은 다음 갱신에 반영). 환율 ${u.fx.toLocaleString("ko-KR")}원 · 손절·익절·정지 규칙은 한국과 동일.`,
      }),
    ]);
  }

  /** 미국 배분 슬라이더 — 넣은 돈 중 얼마를 미국 자동매매 예산으로 떼어 둘지.
   * 적용 버튼 없이 손을 떼는 즉시 저장된다(2026-08-18 사용자 지시). 서버는 매 사이클
   * KV 값을 새로 읽으므로 다음 매매부터 바로 반영된다. */
  private reserveRow(p: AutoPlan): HTMLElement {
    const total = Math.max(1, p.depositKrw);
    const pct = Math.round(((p.reserveKrw || 0) / total) * 100);
    const slider = el("input", { type: "range", min: "0", max: "80", step: "5", value: String(Math.min(80, pct)) }) as HTMLInputElement;
    const label = el("b", {});
    const status = el("span", { class: "reserve-status", text: "" });
    const show = () => {
      const krw = Math.round((total * Number(slider.value)) / 100 / 10000) * 10000;
      label.textContent = `${slider.value}% · ${fmtKrw(krw)}`;
      return krw;
    };
    show();
    slider.addEventListener("input", show);
    // "change" 는 손을 뗄 때 한 번만 온다 — 드래그 중(input) 저장하면 요청이 수십 번 나간다
    slider.addEventListener("change", () => {
      const krw = show();
      status.textContent = "저장 중…";
      status.className = "reserve-status";
      void api
        .autoSetReserve(krw)
        .then(() => {
          status.textContent = "저장됨 — 다음 사이클부터 이 예산으로 매매합니다";
          status.className = "reserve-status ok";
          if (this.plan) this.plan.reserveKrw = krw;
        })
        .catch((e) => {
          status.textContent = `저장 실패: ${e instanceof Error ? e.message : e}`;
          status.className = "reserve-status err";
          // 서버에 안 올라간 값을 화면에 남기지 않는다
          slider.value = String(Math.min(80, pct));
          show();
        });
    });
    return el("div", { class: "reserve-row" }, [
      el("span", { class: "k", text: "미국 배분(자동매매 예산)" }),
      slider,
      label,
      status,
      el("span", {
        class: "note",
        text: "이 몫은 국내 봇이 쓰지 않습니다 — 미국 자동매매의 예산입니다. 움직이면 바로 저장됩니다.",
      }),
    ]);
  }

  private macroBlock(p: AutoPlan): HTMLElement {
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "거시 신호 (온톨로지 입력)" })]),
      el(
        "div",
        { class: "macro-chips" },
        p.macro.map((m) =>
          el("span", { class: `macro-chip ${dirClass(m.value)}`, title: `${m.upMeansKo} · 신호세기 ${m.value}` }, [
            el("b", { text: m.nameKo }),
            el("span", { text: fmtPct(m.changePct) }),
          ]),
        ),
      ),
      el("p", { class: "note", text: "5일 변화율을 요인별 기준폭으로 나눠 -1~1 로 정규화한 값입니다. 이 신호가 섹터 민감도를 거쳐 종목 점수로 전파됩니다." }),
    ]);
  }

  /**
   * 온톨로지 경로도 — "왜 이 종목인가"를 그림으로 보여 준다.
   * 거시요인 → 섹터 → 종목 세 열을 잇고, 선 굵기·색이 기여도의 크기와 방향이다.
   */
  private ontologyBlock(p: AutoPlan): HTMLElement {
    const focus = p.top.find((t) => t.code === this.focusCode) ?? p.top[0];
    const chips = el(
      "div",
      { class: "onto-chips" },
      p.top.slice(0, 8).map((t) => {
        const btn = el("button", {
          type: "button",
          class: `onto-chip${t.code === focus?.code ? " on" : ""}`,
          text: t.nameKo,
        });
        btn.addEventListener("click", () => {
          this.focusCode = t.code;
          this.render();
        });
        return btn;
      }),
    );

    const body = focus
      ? this.ontologyDiagram(focus, p)
      : el("p", { class: "note", text: "표시할 종목이 없습니다." });

    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "온톨로지 경로 — 왜 이 종목인가" })]),
      chips,
      body,
    ]);
  }

  private ontologyDiagram(t: TickerScore, p: AutoPlan): HTMLElement {
    const macroById = new Map(p.macro.map((m) => [m.id, m]));
    const sectorWeights = this.graph?.universe.find((u) => u.code === t.code)?.sectors ?? {};
    const edges = t.edges;

    // 배포 직후에는 이전 버전이 만든 캐시(경로 정보 없음)가 잠깐 남을 수 있다. 둘을 구분해서 알린다.
    if (!edges) {
      return el("p", {
        class: "note",
        text: "이전 계산 결과라 경로 정보가 없습니다. 몇 분 뒤 새 사이클이 돌면 표시됩니다.",
      });
    }

    // 실제로 신호가 흐른 요인·섹터만 그린다. 0인 간선을 그리면 그림만 복잡해진다.
    const macroIds = [...new Set(edges.map((e) => e.macroId))].slice(0, 6);
    const sectors = [...new Set(edges.map((e) => e.sector))];
    if (!macroIds.length) {
      return el("p", {
        class: "note",
        text: `${t.nameKo}: 지금 유의미하게 움직인 거시요인이 없습니다(모든 신호 세기 0.05 미만). 이 종목의 점수는 가격·뉴스 축에서 나왔습니다.`,
      });
    }

    const W = 660;
    const rowH = 46;
    const rows = Math.max(macroIds.length, sectors.length, 1);
    const H = 34 + rows * rowH + 26;
    const colX = { macro: 6, sector: 248, ticker: 486 };
    const colW = 168;
    const yOf = (i: number, n: number) => 34 + (rows * rowH) / 2 - (n * rowH) / 2 + i * rowH + rowH / 2;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "onto-svg",
      role: "img",
      "aria-label": `${t.nameKo} 온톨로지 경로도`,
    });

    // 열 제목
    for (const [x, label] of [
      [colX.macro, "거시요인 (5일 변화 → 신호)"],
      [colX.sector, "섹터 민감도"],
      [colX.ticker, "종목"],
    ] as [number, string][]) {
      svg.append(svgEl("text", { x: x + 4, y: 18, class: "onto-col", text: label }));
    }

    const macroY = new Map(macroIds.map((id, i) => [id, yOf(i, macroIds.length)]));
    const sectorY = new Map(sectors.map((s, i) => [s, yOf(i, sectors.length)]));
    const tickerY = yOf(0, 1);

    // 간선을 먼저 그려 노드 뒤로 보낸다
    for (const e of edges) {
      const y1 = macroY.get(e.macroId);
      const y2 = sectorY.get(e.sector);
      if (y1 === undefined || y2 === undefined) continue;
      const w = 1 + Math.min(6, Math.abs(e.contribution) * 8);
      const cls = e.contribution >= 0 ? "up" : "down";
      const x1 = colX.macro + colW;
      const x2 = colX.sector;
      svg.append(
        svgEl("path", {
          d: `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`,
          class: `onto-edge ${cls}`,
          "stroke-width": w.toFixed(1),
        }),
      );
      svg.append(
        svgEl("text", {
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2 - 5,
          class: `onto-edge-label ${cls}`,
          "text-anchor": "middle",
          text: (e.contribution >= 0 ? "+" : "") + e.contribution,
        }),
      );
    }
    for (const [s, y] of sectorY) {
      const weight = sectorWeights[s] ?? 1;
      const x1 = colX.sector + colW;
      const x2 = colX.ticker;
      svg.append(
        svgEl("path", {
          d: `M${x1},${y} C${x1 + 30},${y} ${x2 - 30},${tickerY} ${x2},${tickerY}`,
          class: "onto-edge neutral",
          "stroke-width": (1 + weight * 3).toFixed(1),
        }),
      );
      svg.append(
        svgEl("text", {
          x: (x1 + x2) / 2,
          y: (y + tickerY) / 2 - 5,
          class: "onto-edge-label",
          "text-anchor": "middle",
          text: `비중 ${Math.round(weight * 100)}%`,
        }),
      );
    }

    const node = (x: number, y: number, title: string, sub: string, cls: string) => {
      const g = svgEl("g", { class: `onto-node ${cls}` });
      g.append(svgEl("rect", { x, y: y - 17, width: colW, height: 34, rx: 6 }));
      g.append(svgEl("text", { x: x + 10, y: y - 2, class: "n1", text: title }));
      g.append(svgEl("text", { x: x + 10, y: y + 12, class: "n2", text: sub }));
      return g;
    };

    for (const [id, y] of macroY) {
      const m = macroById.get(id);
      if (!m) continue;
      svg.append(
        node(
          colX.macro,
          y,
          m.nameKo,
          `${m.changePct >= 0 ? "+" : ""}${m.changePct}% → 신호 ${m.value >= 0 ? "+" : ""}${m.value}`,
          m.value >= 0 ? "up" : "down",
        ),
      );
    }
    for (const [s, y] of sectorY) {
      svg.append(node(colX.sector, y, s, `민감도 경로 ${edges.filter((e) => e.sector === s).length}개`, "sector"));
    }
    svg.append(
      node(colX.ticker, tickerY, t.nameKo, `온톨로지 점수 ${t.ontologyScore >= 0 ? "+" : ""}${t.ontologyScore}`, t.ontologyScore >= 0 ? "up" : "down"),
    );

    const w = this.graph?.weights ?? { ontology: 0.35, price: 0.45, news: 0.2 };
    const term = (label: string, v: number, weight: number) =>
      el("span", { class: "term" }, [
        el("b", { class: dirClass(v), text: (v >= 0 ? "+" : "") + v.toFixed(3) }),
        el("i", { text: `×${weight}` }),
        el("u", { text: label }),
      ]);

    return el("div", { class: "onto-wrap" }, [
      svg,
      el("div", { class: "onto-math" }, [
        term("온톨로지", t.ontologyScore, w.ontology),
        el("span", { class: "op", text: "+" }),
        term("가격", t.priceScore, w.price),
        el("span", { class: "op", text: "+" }),
        term("뉴스", t.newsScore, w.news),
        el("span", { class: "op", text: "=" }),
        el("b", { class: `total ${dirClass(t.score)}`, text: t.score.toFixed(3) }),
      ]),
      el("p", {
        class: "note",
        text: "선 굵기 = 기여도 크기, 빨강 = 점수를 올리는 방향, 파랑 = 내리는 방향. 합성 점수가 0.15 이상이어야 매수 후보가 됩니다.",
      }),
    ]);
  }

  private positionsBlock(p: AutoPlan): HTMLElement {
    const rows = p.positions.length
      ? p.positions.map((pos) =>
          el("div", { class: "pos-row" }, [
            el("div", { class: "pos-name" }, [
              el("b", { text: pos.nameKo }),
              el("span", { class: "mono", text: pos.code }),
            ]),
            el("div", { class: "pos-qty", text: `${fmtNum(pos.qty, 0)}주 · 평단 ${fmtKrw(pos.avgPrice)}` }),
            el("div", { class: `pos-pnl ${dirClass(pos.pnlPct ?? 0)}`, text: fmtPct(pos.pnlPct ?? 0) }),
            el("div", { class: "pos-reason", text: pos.reason }),
          ]),
        )
      : [el("p", { class: "note", text: "한국 봇이 보유한 종목이 없습니다." })];
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "한국 봇 보유 종목" })]),
      el("div", { class: "pos-list" }, rows),
    ]);
  }

  private ordersBlock(p: AutoPlan): HTMLElement {
    const rows: HTMLElement[] = p.orders.length
      ? p.orders.map((o) => this.orderCard(o))
      : [el("p", { class: "note", text: p.notes[0] ?? "이번 사이클 매매 계획이 없습니다." })];
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "이번 사이클 계획" }), el("span", { class: "count", text: `${p.orders.length}건` })]),
      el("div", { class: "order-plan" }, rows),
      ...p.notes.slice(1).map((n) => el("p", { class: "note", text: n })),
    ]);
  }

  private orderCard(o: PlannedOrder): HTMLElement {
    return el("article", { class: `plan-card ${o.side}` }, [
      el("div", { class: "plan-head" }, [
        el("span", { class: `side-tag ${o.side}`, text: o.side === "buy" ? "매수" : "매도" }),
        el("b", { text: o.nameKo }),
        el("span", { class: "mono", text: o.code }),
        el("span", { class: "spacer" }),
        el("span", { class: "plan-amt", text: `${fmtNum(o.qty, 0)}주 × ${fmtKrw(o.price)} = ${fmtKrw(o.notionalKrw)}` }),
      ]),
      el("p", { class: "plan-reason", text: o.reason }),
      ...(o.detail.length ? [el("ul", { class: "plan-detail" }, o.detail.map((d) => el("li", { text: d })))] : []),
    ]);
  }

  private scoresBlock(p: AutoPlan): HTMLElement {
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "종목 점수 상위" })]),
      el("div", { class: "score-list" }, p.top.map((s) => this.scoreRow(s))),
      el("p", { class: "note", text: "합성 점수 = 온톨로지 0.35 + 가격신호 0.45 + 뉴스감성 0.20. 0.15 이상이어야 매수 후보가 됩니다." }),
    ]);
  }

  private scoreRow(s: TickerScore): HTMLElement {
    const bar = (label: string, v: number) =>
      el("span", { class: "sbar", title: `${label} ${v}` }, [
        el("i", { class: dirClass(v), style: `width:${Math.min(100, Math.abs(v) * 100)}%` }),
      ]);
    return el("details", { class: "score-row" }, [
      el("summary", {}, [
        el("b", { text: s.nameKo }),
        el("span", { class: "mono", text: s.code }),
        el("span", { class: dirClass(s.changePct), text: fmtPct(s.changePct) }),
        el("span", { class: "spacer" }),
        el("span", { class: `score-val ${dirClass(s.score)}`, text: s.score.toFixed(3) }),
      ]),
      el("div", { class: "score-detail" }, [
        el("div", { class: "score-bars" }, [
          el("span", { class: "k", text: "온톨로지" }),
          bar("온톨로지", s.ontologyScore),
          el("span", { class: "k", text: "가격" }),
          bar("가격", s.priceScore),
          el("span", { class: "k", text: "뉴스" }),
          bar("뉴스", s.newsScore),
        ]),
        el("ul", { class: "plan-detail" }, s.reasons.map((r) => el("li", { text: `[${labelOf(r.kind)}] ${r.text}` }))),
        el("p", { class: "note", text: `현재가 ${fmtKrw(s.price)} · 일변동성 ${s.volatility}% · ATR ${fmtNum(s.atr, 0)}` }),
      ]),
    ]);
  }

  private controlsBlock(): HTMLElement {
    const status = el("p", { class: "modal-status", text: "" });
    const run = (shadow: boolean, label: string) => async () => {
      if (this.busy) return;
      this.busy = true;
      status.textContent = `${label} 실행 중…`;
      status.className = "modal-status";
      try {
        const res = await api.autoRun(shadow);
        status.textContent = res.shadow
          ? `그림자 실행 완료 — 계획 ${res.orders.length}건을 일지에 기록했고 주문은 보내지 않았습니다.`
          : `실행 완료 — ${res.executed}건 전송, ${res.results.filter((r) => !r.ok).length}건 실패.`;
        status.className = "modal-status ok";
        await this.load();
      } catch (err) {
        status.textContent = err instanceof ApiFailure ? err.message : String(err);
        status.className = "modal-status err";
        if (err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401)) this.deps.onNeedAuth();
      } finally {
        this.busy = false;
      }
    };
    const simple = (fn: () => Promise<unknown>, label: string, confirmText?: string) => async () => {
      if (confirmText && !confirm(confirmText)) return;
      status.textContent = `${label} 처리 중…`;
      status.className = "modal-status";
      try {
        await fn();
        status.textContent = `${label} 완료.`;
        status.className = "modal-status ok";
        await this.load();
      } catch (err) {
        status.textContent = err instanceof ApiFailure ? err.message : String(err);
        status.className = "modal-status err";
        if (err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401)) this.deps.onNeedAuth();
      }
    };

    const shadowBtn = el("button", { class: "btn btn-ghost", type: "button", text: "그림자 실행 (주문 없음)" });
    shadowBtn.addEventListener("click", run(true, "그림자 실행"));
    const liveBtn = el("button", { class: "btn btn-danger", type: "button", text: "지금 사이클 실행" });
    liveBtn.addEventListener("click", run(false, "사이클"));
    const resumeBtn = el("button", { class: "btn btn-ghost", type: "button", text: "정지 해제" });
    resumeBtn.addEventListener("click", simple(() => api.autoResume(), "정지 해제"));
    const resetBtn = el("button", { class: "btn btn-ghost", type: "button", text: "장부 초기화" });
    resetBtn.addEventListener(
      "click",
      simple(() => api.autoReset(), "장부 초기화", "봇의 포지션 장부를 모두 비웁니다. 실제 계좌 잔고는 바뀌지 않습니다. 계속할까요?"),
    );

    /* 해외주식 점검 — "내 계좌로 미국장이 되나?"를 우리 설정이 아니라 KIS 응답으로 답한다.
     * 결과는 별도 영역에 쌓는다(다른 버튼 상태 메시지에 묻히면 읽을 수가 없다). */
    const overseasOut = el("div", { class: "overseas-out" });
    const overseasBtn = el("button", { class: "btn btn-ghost", type: "button", text: "해외주식 거래 가능 점검" });
    overseasBtn.addEventListener("click", async () => {
      if (this.busy) return;
      this.busy = true;
      overseasOut.replaceChildren(el("p", { class: "note", text: "KIS 에 물어보는 중…" }));
      try {
        const r = await api.overseasCheck();
        const line = (label: string, ok: boolean, detail: string) =>
          el("li", { class: ok ? "gate-ok" : "" }, [
            el("strong", { text: `${ok ? "가능" : "막힘"} · ${label}` }),
            el("span", { text: ` — ${detail}` }),
          ]);
        const ready = r.balance.ok && (Boolean(r.usdCash) || Boolean(r.buyingPower?.ok));
        overseasOut.replaceChildren(
          el("p", { class: `modal-status ${ready ? "ok" : "err"}`, text: r.verdict }),
          el("ul", { class: "gate-list" }, [
            line("해외 시세(앱키 권한)", r.quote.ok, r.quote.detail),
            line("해외 잔고(계좌 개설)", r.balance.ok, r.balance.detail),
            line("달러 예수금", Boolean(r.usdCash), r.usdCash === null ? "잔고 조회가 막혀 확인 불가" : `${r.usdCash} USD`),
            ...(r.buyingPower
              ? [line("매수가능금액 (통합증거금 포함)", r.buyingPower.ok, r.buyingPower.detail)]
              : []),
          ]),
          el("ul", { class: "gate-list" }, r.nextSteps.map((t) => el("li", { text: `다음 할 일 — ${t}` }))),
        );
      } catch (err) {
        overseasOut.replaceChildren(el("p", { class: "modal-status err", text: err instanceof ApiFailure ? err.message : String(err) }));
        if (err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401)) this.deps.onNeedAuth();
      } finally {
        this.busy = false;
      }
    });

    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "수동 제어" })]),
      el("div", { class: "auto-controls" }, [shadowBtn, liveBtn, resumeBtn, resetBtn, overseasBtn]),
      overseasOut,
      el("p", {
        class: "note",
        text: "‘지금 사이클 실행’은 안전장치를 모두 통과했을 때만 실제 주문을 보냅니다. 하나라도 막혀 있으면 자동으로 그림자 실행으로 떨어집니다.",
      }),
      status,
    ]);
  }

  private journalBlock(): HTMLElement {
    const rows = this.journal.length
      ? this.journal.slice(0, 30).map((j) =>
          el("li", { class: `jr jr-${j.kind}` }, [
            el("span", { class: "jr-time", text: timeAgo(j.at) }),
            el("span", { class: "jr-text", text: j.text }),
          ]),
        )
      : [el("li", { class: "note", text: "기록이 없습니다. 사이클이 한 번도 돌지 않았습니다." })];
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "매매 일지" })]),
      el("ul", { class: "journal" }, rows),
    ]);
  }
}

function stat(k: string, v: string, dir?: string): HTMLElement {
  return el("div", { class: "auto-stat" }, [
    el("span", { class: "k", text: k }),
    el("span", { class: `v ${dir ?? ""}`, text: v }),
  ]);
}

function labelOf(kind: string): string {
  return kind === "ontology" ? "온톨로지" : kind === "price" ? "가격" : "뉴스";
}
