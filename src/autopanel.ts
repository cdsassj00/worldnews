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
  type PlannedOrder,
  type TickerScore,
} from "./api";
import { dirClass, el, fmtKrw, fmtNum, fmtPct, timeAgo } from "./format";

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
  private busy = false;

  constructor(deps: AutoPanelDeps) {
    this.deps = deps;
  }

  async load(): Promise<void> {
    this.deps.root.replaceChildren(el("p", { class: "note", text: "자동매매 상태를 불러오는 중… (거시지표·종목 시세를 계산하느라 10초 정도 걸릴 수 있습니다)" }));
    const [status, plan, journal] = await Promise.allSettled([api.autoStatus(), api.autoPlan(), api.autoJournal()]);
    this.status = status.status === "fulfilled" ? status.value : null;
    this.plan = plan.status === "fulfilled" ? plan.value : null;
    this.journal = journal.status === "fulfilled" ? journal.value.items : [];
    if (!this.plan && plan.status === "rejected") {
      const msg = plan.reason instanceof ApiFailure ? plan.reason.message : String(plan.reason);
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
    this.deps.root.replaceChildren(
      this.gateBlock(p),
      this.moneyBlock(p),
      this.macroBlock(p),
      this.positionsBlock(p),
      this.ordersBlock(p),
      this.scoresBlock(p),
      this.controlsBlock(),
      this.journalBlock(),
      el("p", { class: "note", text: `계획 생성 ${timeAgo(p.generatedAt)} · 계획은 2분 캐시됩니다.` }),
    );
  }

  /* ── 블록들 ─────────────────────────────── */

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

  private moneyBlock(p: AutoPlan): HTMLElement {
    const c = p.config;
    const pct = Math.max(-100, Math.min(100, p.targetProgressPct));
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "자금과 목표" })]),
      el("div", { class: "auto-grid" }, [
        stat("평가금액", p.account.connected ? fmtKrw(p.equity) : "계좌 미연결"),
        stat("누적 손익", `${p.pnlKrw >= 0 ? "+" : ""}${fmtKrw(p.pnlKrw)}`, dirClass(p.pnlKrw)),
        stat("운용 투입", fmtKrw(p.deployedKrw)),
        stat("남은 한도", fmtKrw(p.budgetKrw)),
        stat("주문가능 현금", p.account.connected ? fmtKrw(p.account.cash) : "-"),
        stat("위험회피", String(p.riskOff), p.riskOff >= 0.5 ? "down" : "flat"),
      ]),
      el("div", { class: "target-bar", title: `목표 ${fmtKrw(c.targetProfitKrw)} 대비 ${p.targetProgressPct}%` }, [
        el("i", { style: `width:${Math.max(0, pct)}%` }),
      ]),
      el("p", {
        class: "note",
        text: `목표 ${fmtKrw(c.targetProfitKrw)} · 진행 ${p.targetProgressPct}% · 원금한도 ${fmtKrw(c.capitalKrw)} · 종목당 최대 ${c.maxPositionPct}% · 손절 -${c.stopLossPct}% · 익절 +${c.takeProfitPct}% · 당일정지 -${c.dailyLossHaltPct}% · 영구정지 -${c.maxDrawdownPct}%`,
      }),
      el("p", {
        class: "note",
        text: `평가금액·손익·정지선은 계좌 전체 기준입니다(기존 보유 ${p.account.holdings.length}종목 포함). 매매 대상은 아래 ‘봇 보유 종목’과 신규 진입 종목뿐입니다.`,
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
      : [el("p", { class: "note", text: "봇이 보유한 종목이 없습니다. (계좌의 기존 보유분은 봇이 건드리지 않습니다.)" })];
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "봇 보유 종목" })]),
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

    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "수동 제어" })]),
      el("div", { class: "auto-controls" }, [shadowBtn, liveBtn, resumeBtn, resetBtn]),
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
