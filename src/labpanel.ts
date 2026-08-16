/**
 * 전략실 — 4개 전략(온톨로지·수급차트·차트거장·융합)이 같은 규칙으로 겨루는 리그 화면.
 *
 * 스탁이지 전략실을 참고한 구성: 전략마다 카드(수익률·곡선·보유수), 카드를 열면
 * 보유 종목 표(편입가·보유일·수익률)와 이탈 종목, 백테스트 성적이 나온다.
 *
 * 프레이밍이 핵심이다 — 여기 숫자는 전부 **가상 원금 시뮬레이션**이고, 화면이 그걸
 * 숨기지 않는다. 게임처럼 보여주되 게임인 것을 명시해야 유사투자자문 시비가 없다.
 */
import { api, type AutoPlan, type BacktestResults, type LabOverview, type LabStrategy } from "./api";
import { dirClass, el, fmtKrw, fmtPct, timeAgo } from "./format";

const NS = "http://www.w3.org/2000/svg";

/** 수익률 곡선 스파크라인 — 원금선(0%)을 기준선으로 깐다 */
function sparkline(curve: { d: string; e: number }[], capital: number, w = 220, h = 56): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "lab-spark");
  if (curve.length < 2) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(w / 2)); t.setAttribute("y", String(h / 2 + 3));
    t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "9");
    t.setAttribute("fill", "rgba(148,163,184,0.7)");
    t.textContent = "곡선은 며칠 더 쌓이면 그려집니다";
    svg.append(t);
    return svg;
  }
  const vals = curve.map((p) => p.e);
  const min = Math.min(...vals, capital), max = Math.max(...vals, capital);
  const pad = (max - min) * 0.1 || 1;
  const y = (v: number) => 4 + ((max + pad - v) / (max - min + 2 * pad)) * (h - 8);
  const x = (i: number) => (i / (curve.length - 1)) * (w - 4) + 2;

  const base = document.createElementNS(NS, "line");
  base.setAttribute("x1", "0"); base.setAttribute("x2", String(w));
  base.setAttribute("y1", String(y(capital))); base.setAttribute("y2", String(y(capital)));
  base.setAttribute("stroke", "rgba(148,163,184,0.35)"); base.setAttribute("stroke-dasharray", "3 3");
  svg.append(base);

  const up = vals[vals.length - 1] >= capital;
  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.e).toFixed(1)}`).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", up ? "#e0524a" : "#3b82f6");
  line.setAttribute("stroke-width", "1.8");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  return svg;
}

export class LabPanel {
  private readonly grid: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly disclaimer: HTMLElement;
  private data: LabOverview | null = null;
  private bt: BacktestResults | null = null;
  /** 실계좌 현황(공개 API) — 실계좌 운용 중인 전략 카드에 진짜 돈 숫자를 붙인다 */
  private plan: AutoPlan | null = null;
  private openId: string | null = null;

  constructor(opts: { grid: HTMLElement; detail: HTMLElement; disclaimer: HTMLElement }) {
    this.grid = opts.grid;
    this.detail = opts.detail;
    this.disclaimer = opts.disclaimer;
  }

  async load(): Promise<void> {
    try {
      const [data, bt, plan] = await Promise.all([
        api.labOverview(),
        this.bt ? Promise.resolve(this.bt) : api.backtest().catch(() => null),
        api.autoPlan().catch(() => null),
      ]);
      this.data = data;
      if (bt) this.bt = bt;
      if (plan) this.plan = plan;
      this.render();
    } catch (err) {
      this.grid.replaceChildren(el("p", { class: "note err", text: `전략실을 불러오지 못했습니다 — ${(err as Error).message}` }));
    }
  }

  private btRow(engineId: string | null): { returns: number[] | null; pending?: string } {
    if (!this.bt || !engineId) return { returns: null };
    const row = this.bt.engineComparison.engines.find((e) => e.id === engineId);
    if (!row) return { returns: null };
    if (row.KR) return { returns: row.KR.returns };
    return { returns: null, pending: row.pending };
  }

  private render(): void {
    const d = this.data;
    if (!d) return;
    this.disclaimer.textContent = d.disclaimer;

    const cards = d.strategies.map((s) => this.card(s));
    this.grid.replaceChildren(...cards);

    if (this.openId) {
      const s = d.strategies.find((x) => x.id === this.openId);
      if (s) {
        this.detail.hidden = false;
        this.detail.replaceChildren(this.detailView(s));
      }
    } else {
      this.detail.hidden = true;
      this.detail.replaceChildren();
    }
  }

  private card(s: LabStrategy): HTMLElement {
    const bt = this.btRow(s.engineId);
    const sign = s.pnlPct >= 0 ? "+" : "";
    const card = el("button", { type: "button", class: `lab-card${this.openId === s.id ? " open" : ""}${s.liveNow ? " live" : ""}` }, [
      el("div", { class: "lab-card-top" }, [
        el("span", { class: "lab-no", text: `${s.no}호` }),
        el("span", { class: "lab-name", text: s.nameKo }),
        s.liveNow
          ? el("span", { class: "lab-badge live", text: "실계좌 운용 중" })
          : el("span", { class: "lab-badge", text: "시뮬레이션" }),
      ]),
      el("p", { class: "lab-desc", text: s.descKo }),
      el("div", { class: `lab-return ${dirClass(s.pnlPct)}`, text: `${sign}${s.pnlPct.toFixed(2)}%` }),
      el("p", { class: "lab-meta", text: `가상 원금 ${fmtKrw(s.capital)} → ${fmtKrw(s.equity)} · 보유 ${s.positions.length}종목${s.tradeStats.total ? ` · 승률 ${s.tradeStats.winRate}%` : ""}` }),
      ...(s.positions.length === 0 && s.tradeStats.total === 0
        ? [el("p", { class: "lab-meta lab-fresh", text: "이 원장은 방금 개설됐습니다 — 다음 거래일 09:00부터 매매를 시작합니다." })]
        : []),
      sparkline(s.equityCurve, s.capital) as unknown as HTMLElement,
      ...this.realBlock(s),
      el("div", { class: "lab-bt" },
        bt.returns
          ? [
              el("span", { class: "lab-bt-label", text: "백테스트" }),
              ...bt.returns.map((v, i) =>
                el("span", { class: `lab-bt-chip ${v >= 0 ? "up" : "down"}`, text: `${["3개월", "6개월", "1년"][i]} ${v >= 0 ? "+" : ""}${v.toFixed(1)}%` })),
            ]
          : [el("span", { class: "lab-bt-label", text: bt.pending ? "백테스트 진행 중" : "백테스트 —" })],
      ),
      s.haltedPermanent ? el("p", { class: "lab-halt", text: `영구 정지 — ${s.haltReason}` }) : el("span", {}),
    ]);
    card.addEventListener("click", () => {
      this.openId = this.openId === s.id ? null : s.id;
      this.render();
      if (this.openId) this.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return card;
  }


  /**
   * 실계좌 블록 — 이 전략이 실제 돈을 움직이고 있으면 카드에 진짜 계좌 숫자를 붙인다.
   * 모의(가상 400만)와 실계좌(봇 상한 400만)를 한 카드에서 구분해 보여주는 것이 핵심이다 —
   * 섞어 버리면 "시뮬레이션 게임" 프레이밍도, 숫자의 정직함도 다 무너진다.
   */
  private realBlock(s: LabStrategy): HTMLElement[] {
    const p = this.plan;
    if (!s.liveNow || !p || !p.account.connected) return [];
    const sign = p.botPnlKrw >= 0 ? "+" : "";
    const started = p.real?.startedAt ? new Date(p.real.startedAt).toISOString().slice(0, 10) : "2026-07-27";
    return [
      el("div", { class: "lab-real" }, [
        el("div", { class: "lab-real-head" }, [
          el("span", { class: "lab-real-tag", text: "실계좌 (진짜 돈)" }),
          el("span", { class: `lab-real-pnl ${dirClass(p.botPnlKrw)}`, text: `봇 손익 ${sign}${fmtKrw(p.botPnlKrw)}` }),
        ]),
        el("p", { class: "lab-real-meta", text: `${started} 시작 · 봇 운용 상한 ${fmtKrw(p.config?.capitalKrw ?? 4000000)} · 보유 ${p.positions.length}종목 · 나머지 계좌 잔액은 개인 보유분` }),
        (p.real?.botPnlCurve?.length ?? 0) >= 2
          ? (sparkline(p.real.botPnlCurve.map((x) => ({ d: x.d, e: x.v })), 0, 220, 40) as unknown as HTMLElement)
          : el("p", { class: "lab-real-meta", text: "실계좌 곡선은 오늘부터 기록을 시작했습니다(과거는 재구성하지 않습니다)." }),
      ]),
    ];
  }

  private detailView(s: LabStrategy): HTMLElement {
    const box = el("div", { class: "lab-detail-inner" });
    box.append(
      el("div", { class: "lab-detail-head" }, [
        el("h3", { text: `${s.no}호 ${s.nameKo} — ${s.tagKo}` }),
        el("span", { class: "note", text: s.lastNote ? `직전 판단: ${s.lastNote}` : "" }),
      ]),
    );

    // 보유 종목 표 — 스탁이지식: 종목·편입가·현재가·보유일·수익률
    if (s.positions.length) {
      const table = el("div", { class: "lab-table" });
      table.append(el("div", { class: "lab-tr lab-th" }, [
        el("span", { text: "보유 종목" }), el("span", { text: "편입가" }), el("span", { text: "현재가" }),
        el("span", { text: "보유일" }), el("span", { text: "수익률" }),
      ]));
      for (const p of s.positions) {
        table.append(el("div", { class: "lab-tr" }, [
          el("span", { class: "lab-td-name", text: `${p.name} ×${p.qty}` }),
          el("span", { text: fmtKrw(Math.round(p.avgPrice)) }),
          el("span", { text: fmtKrw(Math.round(p.lastPrice || p.avgPrice)) }),
          el("span", { text: `${p.holdDays}일` }),
          el("span", { class: dirClass(p.pnlPct), text: fmtPct(p.pnlPct) }),
        ]));
      }
      box.append(table);
    } else {
      box.append(el("p", { class: "note", text: "현재 보유 종목이 없습니다." }));
    }

    // 이탈 종목 — 판 것도 그대로 보여준다(좋은 것만 남기면 기록이 아니라 광고다)
    if (s.exits.length) {
      const table = el("div", { class: "lab-table" });
      table.append(el("div", { class: "lab-tr lab-th" }, [
        el("span", { text: "이탈 종목" }), el("span", { text: "매도가" }), el("span", { text: "사유" }),
        el("span", { text: "손익" }), el("span", { text: "시점" }),
      ]));
      for (const t of s.exits) {
        table.append(el("div", { class: "lab-tr" }, [
          el("span", { class: "lab-td-name", text: t.name }),
          el("span", { text: fmtKrw(t.price) }),
          el("span", { class: "lab-td-reason", text: t.reason }),
          el("span", { class: dirClass(t.pnl ?? 0), text: t.pnl !== undefined ? `${t.pnl >= 0 ? "+" : ""}${fmtKrw(t.pnl)}` : "—" }),
          el("span", { text: timeAgo(t.at) }),
        ]));
      }
      box.append(table);
    }

    if (s.liveNow && this.plan?.account.connected && this.plan.positions.length) {
      const table = el("div", { class: "lab-table" });
      table.append(el("div", { class: "lab-tr lab-th" }, [
        el("span", { text: "실계좌 보유 (진짜 돈)" }), el("span", { text: "평단" }), el("span", { text: "현재가" }),
        el("span", { text: "수량" }), el("span", { text: "수익률" }),
      ]));
      for (const bp of this.plan.positions) {
        table.append(el("div", { class: "lab-tr lab-real-tr" }, [
          el("span", { class: "lab-td-name", text: bp.name ?? bp.code }),
          el("span", { text: fmtKrw(Math.round(bp.avgPrice)) }),
          el("span", { text: fmtKrw(Math.round(bp.price)) }),
          el("span", { text: `${bp.qty}주` }),
          el("span", { class: dirClass(bp.pnlPct), text: fmtPct(bp.pnlPct) }),
        ]));
      }
      box.append(table);
    }

    box.append(
      el("p", { class: "note", text: `최대 낙폭 -${s.maxDrawdownPct}% · 매도 ${s.tradeStats.total}건 · 시뮬레이션 시작 ${new Date(s.startedAt).toISOString().slice(0, 10)}` }),
      el("p", { class: "note lab-cta-note", text: s.liveNow
        ? "이 전략이 지금 실계좌를 움직이고 있습니다. 교체는 자동매매 화면의 매매 엔진에서."
        : "이 전략으로 실계좌를 운용하려면 자동매매 화면 → 매매 엔진에서 선택하세요 (거래 암호 필요)." }),
    );
    return box;
  }
}
