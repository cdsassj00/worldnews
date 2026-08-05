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

  constructor(deps: AutoPanelDeps) {
    this.deps = deps;
  }

  async load(): Promise<void> {
    this.deps.root.replaceChildren(el("p", { class: "note", text: "자동매매 상태를 불러오는 중… (거시지표·종목 시세를 계산하느라 10초 정도 걸릴 수 있습니다)" }));
    const [status, plan, journal, graph] = await Promise.allSettled([
      api.autoStatus(),
      api.autoPlan(),
      api.autoJournal(),
      this.graph ? Promise.resolve(this.graph) : api.autoGraph(),
    ]);
    this.status = status.status === "fulfilled" ? status.value : null;
    this.plan = plan.status === "fulfilled" ? plan.value : null;
    this.journal = journal.status === "fulfilled" ? journal.value.items : [];
    if (graph.status === "fulfilled") this.graph = graph.value;
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
    if (!this.focusCode && p.top.length) this.focusCode = p.top[0].code;
    this.deps.root.replaceChildren(
      this.backtestBlock(),
      this.gateBlock(p),
      this.moneyBlock(p),
      this.macroBlock(p),
      this.ontologyBlock(p),
      this.positionsBlock(p),
      this.ordersBlock(p),
      this.scoresBlock(p),
      this.controlsBlock(),
      this.journalBlock(),
      el("p", { class: "note", text: `계획 생성 ${timeAgo(p.generatedAt)} · 계획은 2분 캐시됩니다.` }),
    );
  }

  /* ── 블록들 ─────────────────────────────── */

  /**
   * 백테스트 결과를 대시보드 맨 위에 고정한다.
   * 불리한 결과라서 더더욱 숨기면 안 된다 — 이 화면을 보고 실매매를 켜기 때문이다.
   */
  private backtestBlock(): HTMLElement {
    const row = (period: string, mine: string, bench: string, dd: string, verdict: string) =>
      el("div", { class: "bt-row" }, [
        el("span", { class: "bt-period", text: period }),
        el("span", { class: "bt-num down", text: mine }),
        el("span", { class: "bt-num", text: bench }),
        el("span", { class: "bt-num", text: dd }),
        el("span", { class: "bt-verdict", text: verdict }),
      ]);
    return el("section", { class: "auto-block bt-block" }, [
      el("h3", {}, [
        el("span", { text: "과거 검증 결과 (반드시 읽을 것)" }),
        el("span", { class: "gate-pill off", text: "실매매 비권장" }),
      ]),
      el("div", { class: "bt-table" }, [
        el("div", { class: "bt-row bt-head" }, [
          el("span", { text: "기간" }),
          el("span", { text: "이 전략" }),
          el("span", { text: "코스피 보유" }),
          el("span", { text: "최대낙폭" }),
          el("span", { text: "결과" }),
        ]),
        row("최근 2년", "+50.2%", "+156.3%", "-18.9%", "크게 뒤짐"),
        row("최근 5년", "-23.3%", "+119.9%", "-24.0%", "원금 손실 · 2022-03 영구정지"),
      ]),
      el("p", {
        class: "note err",
        text: "5년 구간에서는 2022년 하락장에 영구정지선(-20%)이 걸려 그 뒤로 4년간 매매가 멈췄습니다. 손절 완화·추적손절 등 8가지 변형을 모두 시험했지만 어느 것도 지수 보유를 이기지 못했습니다.",
      }),
      el("p", {
        class: "note",
        text: "즉 이 시스템은 '설명 가능한 판단 근거를 만드는 도구'로는 작동하지만, 지금 규칙 그대로 돈을 맡길 근거는 없습니다. npm run backtest 로 언제든 직접 재현할 수 있습니다.",
      }),
    ]);
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

  private moneyBlock(p: AutoPlan): HTMLElement {
    const c = p.config;
    const pct = Math.max(-100, Math.min(100, p.targetProgressPct));
    return el("section", { class: "auto-block" }, [
      el("h3", {}, [el("span", { text: "자금과 목표" })]),
      // ① 봇이 굴리는 돈 — 한도 = 투입 + 여유 (여기서 합이 맞는다)
      el("p", { class: "auto-sub", text: `봇 운용 한도 ${fmtKrw(c.capitalKrw)} = 투입 + 여유` }),
      el("div", { class: "auto-grid" }, [
        stat("봇 투입", fmtKrw(p.deployedKrw)),
        stat("봇 여유 한도", fmtKrw(p.budgetKrw)),
        // 계좌를 못 읽으면 손익은 계산할 수 없다 — 숫자를 지어내지 않는다
        stat("봇 손익", p.account.connected ? `${p.botPnlKrw >= 0 ? "+" : ""}${fmtKrw(p.botPnlKrw)}` : "-", p.account.connected ? dirClass(p.botPnlKrw) : ""),
        stat("위험회피", String(p.riskOff), p.riskOff >= 0.5 ? "down" : "flat"),
      ]),
      // ② 계좌 전체 — 주식(봇+기존) + 현금
      el("p", {
        class: "auto-sub",
        text: p.account.connected
          ? `계좌 전체 ${fmtKrw(p.equity)} = 봇 주식 ${fmtKrw(p.deployedKrw)} + 기존 보유 주식 ${fmtKrw(
              Math.max(0, p.account.stockEval - p.deployedKrw),
            )} + 현금 ${fmtKrw(p.account.cash)}`
          : "계좌 전체 — 조회 실패로 표시할 수 없습니다",
      }),
      el("div", { class: "auto-grid" }, [
        stat("계좌 평가금액", p.account.connected ? fmtKrw(p.equity) : "조회 실패"),
        stat("기존 보유 주식", p.account.connected ? fmtKrw(Math.max(0, p.account.stockEval - p.deployedKrw)) : "-"),
        stat("주문가능 현금", p.account.connected ? fmtKrw(p.account.cash) : "-"),
        stat("계좌 전체 손익", p.account.connected ? `${p.pnlKrw >= 0 ? "+" : ""}${fmtKrw(p.pnlKrw)}` : "-", p.account.connected ? dirClass(p.pnlKrw) : ""),
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
        text: `봇은 ‘봇 투입’ 금액만 굴립니다. 기존 보유 ${p.account.holdings.length}종목은 봇이 사거나 팔지 않으며, 손익만 계좌 전체에 합산돼 보입니다. 새로 사려면 여유 한도와 주문가능 현금이 **둘 다** 있어야 합니다.`,
      }),
      // 계좌 조회가 실패했거나 캐시값으로 대체됐으면 이유를 숨기지 않는다
      ...(p.account.reason
        ? [el("p", { class: "note", text: `※ ${p.account.reason}` })]
        : []),
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
