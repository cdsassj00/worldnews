/**
 * 전략실 — 4개 전략(온톨로지·수급차트·차트거장·융합)이 같은 규칙으로 겨루는 리그 화면.
 *
 * 2026-08-16 사용자 지시로 "쇼케이스" 형태로 개편: 카드의 간판 숫자는 백테스트
 * 1년 수익률이고, 성적순으로 정렬해 1등에 챔피언 배지를 붙인다. 각 전략이 지금
 * 점수 상위로 고른 종목(TOP5)도 카드에 그대로 보여준다 — "이 전략이 뭘 골랐고
 * 그 방식이 과거에 얼마를 벌었는지"가 화면의 전부다. 실계좌 금액은 여기 싣지
 * 않는다(실계좌 운용 중이라는 사실만 배지로 남긴다).
 *
 * 프레이밍이 핵심이다 — 여기 숫자는 전부 **백테스트·가상 원금 시뮬레이션**이고,
 * 화면이 그걸 숨기지 않는다. 게임처럼 보여주되 게임인 것을 명시해야 유사투자자문
 * 시비가 없다.
 */
import { api, type BacktestResults, type LabOverview, type LabStrategy } from "./api";
import { methodologyBox } from "./combopanel";
import { dirClass, el, fmtKrw, fmtNum, fmtPct, timeAgo } from "./format";

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
  private openId: string | null = null;
  private market: "KR" | "US" = "KR";

  constructor(opts: { grid: HTMLElement; detail: HTMLElement; disclaimer: HTMLElement }) {
    this.grid = opts.grid;
    this.detail = opts.detail;
    this.disclaimer = opts.disclaimer;
    // 리그 시장 전환 — 미국 리그(가상 $3,000, 미국장 시간 가동)도 같은 규칙으로 겨룬다 (2026-08-17)
    const tabs = el("div", { class: "radar-tabs lab-mkt", role: "tablist" });
    const mk = (mkt: "KR" | "US", label: string) => {
      const b = el("button", { type: "button", class: `radar-tab${this.market === mkt ? " active" : ""}`, role: "tab", text: label });
      b.addEventListener("click", () => {
        if (this.market === mkt) return;
        this.market = mkt;
        this.openId = null;
        for (const x of tabs.querySelectorAll(".radar-tab")) x.classList.toggle("active", x === b);
        void this.load(true);
      });
      return b;
    };
    tabs.append(mk("KR", "한국 리그"), mk("US", "미국 리그"));
    this.grid.insertAdjacentElement("beforebegin", tabs);
    // 백테스트 숫자를 자랑하는 화면이므로, 어떻게 잰 숫자이고 어떤 한계가 있는지를
    // 같은 화면에서 읽을 수 있게 한다 (2026-08-16 사용자 지시: 정확한 시뮬레이션 근거)
    this.disclaimer.insertAdjacentElement("afterend", methodologyBox());
  }

  /** 통화 표기 — 한국 리그 원, 미국 리그 달러 */
  private money(v: number): string {
    return this.market === "US" ? `$${fmtNum(v, 2)}` : fmtKrw(v);
  }

  async load(force = false): Promise<void> {
    if (force) this.data = null;
    try {
      const [data, bt] = await Promise.all([
        api.labOverview(this.market),
        this.bt ? Promise.resolve(this.bt) : api.backtest().catch(() => null),
      ]);
      this.data = data;
      if (bt) this.bt = bt;
      this.render();
    } catch (err) {
      this.grid.replaceChildren(el("p", { class: "note err", text: `전략실을 불러오지 못했습니다 — ${(err as Error).message}` }));
    }
  }

  private btRow(engineId: string | null): { returns: number[] | null; pending?: string } {
    if (!this.bt || !engineId) return { returns: null };
    const row = this.bt.engineComparison.engines.find((e) => e.id === engineId);
    if (!row) return { returns: null };
    const rec = this.market === "US" ? row.US : row.KR;
    if (rec) return { returns: rec.returns };
    return { returns: null, pending: row.pending };
  }

  /** 백테스트 1년(KR) 수익률 — 쇼케이스 정렬·챔피언 판정 기준 */
  private btYear(s: LabStrategy): number | null {
    const r = this.btRow(s.engineId).returns;
    return r && r.length >= 3 ? r[2] : null;
  }

  private render(): void {
    const d = this.data;
    if (!d) return;
    this.disclaimer.textContent = d.disclaimer;

    // 백테스트 1년 성적순 정렬 — 자랑할 것을 맨 앞에 세운다(미측정은 뒤로)
    const ranked = [...d.strategies].sort((a, b) => (this.btYear(b) ?? -Infinity) - (this.btYear(a) ?? -Infinity));
    const championId = this.btYear(ranked[0]) !== null ? ranked[0].id : null;

    this.grid.replaceChildren(...ranked.map((s) => this.card(s, s.id === championId)));

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

  private card(s: LabStrategy, champion: boolean): HTMLElement {
    const bt = this.btRow(s.engineId);
    const year = this.btYear(s);
    const simSign = s.pnlPct >= 0 ? "+" : "";
    const card = el("button", {
      type: "button",
      class: `lab-card${this.openId === s.id ? " open" : ""}${s.liveNow ? " live" : ""}${champion ? " champ" : ""}`,
    }, [
      el("div", { class: "lab-card-top" }, [
        el("span", { class: "lab-no", text: `${s.no}호` }),
        el("span", { class: "lab-name", text: s.nameKo }),
        ...(champion ? [el("span", { class: "lab-badge champ", text: "🏆 챔피언" })] : []),
        s.liveNow
          ? el("span", { class: "lab-badge live", text: "실계좌 운용 중" })
          : el("span", { class: "lab-badge", text: "시뮬레이션" }),
      ]),
      el("p", { class: "lab-desc", text: s.descKo }),
      // 간판 숫자 = 백테스트 1년 수익률. 이 전략 규칙으로 지난 1년을 돌렸다면 얼마였나.
      year !== null
        ? el("div", { class: "lab-headline" }, [
            el("div", { class: `lab-return ${dirClass(year)}`, text: `${year >= 0 ? "+" : ""}${year.toFixed(1)}%` }),
            el("span", { class: "lab-headline-label", text: "백테스트 최근 1년" }),
          ])
        : el("div", { class: "lab-headline" }, [
            el("div", { class: "lab-return", text: "측정 중" }),
            el("span", { class: "lab-headline-label", text: bt.pending ?? "백테스트 준비 중" }),
          ]),
      el("div", { class: "lab-bt" },
        bt.returns
          ? [
              el("span", { class: "lab-bt-label", text: "구간별" }),
              ...bt.returns.map((v, i) =>
                el("span", { class: `lab-bt-chip ${v >= 0 ? "up" : "down"}`, text: `${["3개월", "6개월", "1년"][i]} ${v >= 0 ? "+" : ""}${v.toFixed(1)}%` })),
            ]
          : [el("span", { class: "lab-bt-label", text: "" })],
      ),
      // 실전 리그(가상 원금 실시간 모의)는 보조 지표로 한 줄
      el("p", { class: "lab-meta", text: s.positions.length === 0 && s.tradeStats.total === 0
        ? "실시간 리그 — 다음 거래일 09:00 개막 (4개 전략이 같은 가상 원금으로 겨룹니다)"
        : `실시간 리그 ${simSign}${s.pnlPct.toFixed(2)}% · 보유 ${s.positions.length}종목${s.tradeStats.total ? ` · 승률 ${s.tradeStats.winRate}%` : ""}` }),
      sparkline(s.equityCurve, s.capital) as unknown as HTMLElement,
      ...this.picksBlock(s),
      s.haltedPermanent ? el("p", { class: "lab-halt", text: `영구 정지 — ${s.haltReason}` }) : el("span", {}),
    ]);
    card.addEventListener("click", () => {
      this.openId = this.openId === s.id ? null : s.id;
      this.render();
      if (this.openId) this.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return card;
  }

  /** 이 전략이 지금 점수 상위로 고른 종목 — 쇼케이스의 "그래서 뭘 샀는데?" 답 */
  private picksBlock(s: LabStrategy): HTMLElement[] {
    if (!s.picks?.length) return [];
    return [
      el("div", { class: "lab-picks" }, [
        el("span", { class: "lab-picks-label", text: "이 전략이 지금 고른 종목" }),
        ...s.picks.slice(0, 5).map((p) =>
          el("span", { class: "lab-pick" }, [
            el("b", { text: p.name }),
            el("span", { class: `lab-pick-chg ${dirClass(p.changePct)}`, text: fmtPct(p.changePct) }),
          ])),
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

    // 지금 고른 종목 상세 — 점수까지 (카드에는 이름·등락만)
    if (s.picks?.length) {
      const table = el("div", { class: "lab-table" });
      table.append(el("div", { class: "lab-tr lab-th" }, [
        el("span", { text: "지금 고른 종목" }), el("span", { text: "섹터" }), el("span", { text: "현재가" }),
        el("span", { text: "전략 점수" }), el("span", { text: "오늘 등락" }),
      ]));
      for (const p of s.picks.slice(0, 5)) {
        table.append(el("div", { class: "lab-tr" }, [
          el("span", { class: "lab-td-name", text: p.name }),
          el("span", { text: p.sector || "—" }),
          el("span", { text: this.money(Math.round(p.price)) }),
          el("span", { text: p.score.toFixed(2) }),
          el("span", { class: dirClass(p.changePct), text: fmtPct(p.changePct) }),
        ]));
      }
      box.append(table);
    }

    // 보유 종목 표 — 스탁이지식: 종목·편입가·현재가·보유일·수익률
    if (s.positions.length) {
      const table = el("div", { class: "lab-table" });
      table.append(el("div", { class: "lab-tr lab-th" }, [
        el("span", { text: "리그 보유 종목" }), el("span", { text: "편입가" }), el("span", { text: "현재가" }),
        el("span", { text: "보유일" }), el("span", { text: "수익률" }),
      ]));
      for (const p of s.positions) {
        table.append(el("div", { class: "lab-tr" }, [
          el("span", { class: "lab-td-name", text: `${p.name} ×${p.qty}` }),
          el("span", { text: this.money(Math.round(p.avgPrice)) }),
          el("span", { text: this.money(Math.round(p.lastPrice || p.avgPrice)) }),
          el("span", { text: `${p.holdDays}일` }),
          el("span", { class: dirClass(p.pnlPct), text: fmtPct(p.pnlPct) }),
        ]));
      }
      box.append(table);
    } else {
      box.append(el("p", { class: "note", text: "리그 보유 종목이 아직 없습니다 — 다음 거래일 09:00부터 매매를 시작합니다." }));
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
          el("span", { text: this.money(t.price) }),
          el("span", { class: "lab-td-reason", text: t.reason }),
          el("span", { class: dirClass(t.pnl ?? 0), text: t.pnl !== undefined ? `${t.pnl >= 0 ? "+" : ""}${this.money(t.pnl)}` : "—" }),
          el("span", { text: timeAgo(t.at) }),
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
