/**
 * 기술적 분석 카드 — 차트 3단(가격·추세·모멘텀) + 전략 13종 판정.
 *
 * 차트를 직접 그리는 이유는 두 가지다.
 *  1) 판정과 그림이 **같은 숫자**를 써야 한다. 서버가 계산한 지표를 그대로 받아 그린다.
 *     화면이 따로 계산하면 "그림은 골든크로스인데 판정은 매도"가 나온다.
 *  2) 외부 차트 라이브러리를 붙이면 번들이 수백 KB 늘고 CSP·오프라인에서 깨진다.
 *     필요한 건 선·막대·수평선뿐이라 SVG 로 충분하다.
 */
import { api, type TaResponse, type TaStrategy } from "./api";
import { el, fmtKrw, fmtPct, svgEl, timeAgo } from "./format";

const NS = "http://www.w3.org/2000/svg";

interface Scale {
  x: (i: number) => number;
  y: (v: number) => number;
}

/** 값 배열에서 null 을 건너뛰며 선을 그린다 (지표 앞부분은 계산 불가라 비어 있다) */
function linePath(vals: (number | null)[], sc: Scale): string {
  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${sc.x(i).toFixed(1)} ${sc.y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

function path(d: string, stroke: string, width = 1.4, dash?: string): SVGElement {
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", stroke);
  p.setAttribute("stroke-width", String(width));
  p.setAttribute("stroke-linejoin", "round");
  if (dash) p.setAttribute("stroke-dasharray", dash);
  return p;
}

function hLine(y: number, x1: number, x2: number, stroke: string, dash = "4 4"): SVGElement {
  const n = document.createElementNS(NS, "line");
  n.setAttribute("x1", String(x1)); n.setAttribute("x2", String(x2));
  n.setAttribute("y1", String(y)); n.setAttribute("y2", String(y));
  n.setAttribute("stroke", stroke);
  n.setAttribute("stroke-dasharray", dash);
  n.setAttribute("stroke-width", "1");
  return n;
}

function label(x: number, y: number, text: string, fill: string, anchor = "start"): SVGElement {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", String(x)); t.setAttribute("y", String(y));
  t.setAttribute("fill", fill);
  t.setAttribute("font-size", "9");
  t.setAttribute("text-anchor", anchor);
  t.textContent = text;
  return t;
}

const C = {
  up: "#e0524a",      // 국내 관행 — 상승이 빨강
  down: "#3b82f6",
  ma20: "#f0a500",
  ma60: "#8b5cf6",
  band: "#94a3b8",
  grid: "rgba(148,163,184,0.18)",
  sup: "#22c55e",
  res: "#ef4444",
  adx: "#f59e0b",
  pdi: "#e0524a",
  mdi: "#3b82f6",
  st: "#10b981",
  rsi: "#a855f7",
  macd: "#0ea5e9",
  sig: "#f97316",
};

function svg(w: number, h: number): SVGSVGElement {
  const s = document.createElementNS(NS, "svg") as SVGSVGElement;
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("preserveAspectRatio", "none");
  s.setAttribute("class", "ta-chart");
  return s;
}

export class TaPanel {
  private readonly root: HTMLElement;
  private readonly sub: HTMLElement;
  private data: TaResponse | null = null;
  private symbol = "";
  private nameHint = "";
  private tab: "plan" | "chart" | "strategy" = "plan";
  private loading = false;

  constructor(opts: { root: HTMLElement; sub: HTMLElement }) {
    this.root = opts.root;
    this.sub = opts.sub;
  }

  /** 다른 화면(레이더·검색·온톨로지)에서 종목을 고르면 이 카드도 따라간다 */
  async show(symbol: string, nameKo?: string): Promise<void> {
    if (!symbol) return;
    this.symbol = symbol;
    this.nameHint = nameKo ?? "";
    await this.load();
  }

  /** 화면에 쓸 이름 — 야후의 영문 약어("HYUNDAIDEPTST")보다 우리가 아는 한글 이름이 낫다 */
  private get displayName(): string {
    return this.nameHint || this.data?.name || this.symbol;
  }

  /** 통화 인지 금액 표시 — 미국 종목을 "250원"으로 보여주면 그 순간 신뢰가 끝난다 */
  private money(v: number): string {
    if (this.data?.currency === "USD") {
      return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
    }
    return fmtKrw(Math.round(v));
  }

  async load(): Promise<void> {
    if (!this.symbol || this.loading) return;
    this.loading = true;
    this.root.replaceChildren(el("p", { class: "note", text: `${this.nameHint || this.symbol} 차트를 분석하는 중…` }));
    try {
      this.data = await api.ta(this.symbol);
      this.render();
    } catch (err) {
      this.root.replaceChildren(el("p", { class: "note err", text: `기술적 분석 실패 — ${(err as Error).message}` }));
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const d = this.data;
    if (!d) return;
    const v = d.consensus;
    this.sub.textContent =
      `${this.displayName} — 창시자가 있는 차트 전략 13종을 각각 돌려 판정을 모읍니다. ` +
      `시세 기준 ${d.asOf ? timeAgo(d.asOf) : "-"}`;

    const tabs = el("div", { class: "radar-tabs" });
    for (const [id, t] of [["plan", "매매 플랜"], ["chart", "차트"], ["strategy", `전략 판정 (${v.buy}매수/${v.sell}매도)`]] as const) {
      const b = el("button", { type: "button", class: `radar-tab${this.tab === id ? " active" : ""}`, text: t });
      b.addEventListener("click", () => { this.tab = id; this.render(); });
      tabs.append(b);
    }

    this.root.replaceChildren(
      this.headerBlock(d),
      tabs,
      ...(this.tab === "plan" ? this.planBlocks(d) : this.tab === "chart" ? this.chartBlocks(d) : [this.strategyBlock(d)]),
    );
  }

  private headerBlock(d: TaResponse): HTMLElement {
    const v = d.consensus;
    const tone = v.score >= 0.2 ? "up" : v.score <= -0.2 ? "down" : "flat";
    const i = d.indicators;
    return el("div", { class: "ta-head" }, [
      el("div", { class: "ta-head-main" }, [
        el("span", { class: "ta-name", text: `${this.displayName} (${d.symbol})` }),
        el("span", { class: `ta-verdict ${tone}`, text: VERDICT_KO[v.verdict] }),
        el("span", { class: "ta-score", text: `종합 ${v.score >= 0 ? "+" : ""}${v.score.toFixed(2)}` }),
      ]),
      el("p", { class: "note", text: v.text }),
      this.consensusBar(d),
      el("div", { class: "ta-trend" }, [
        el("span", { class: `ta-trend-pill ${d.trend.long}`, text: `장기 ${DIR_KO[d.trend.long]}` }),
        el("span", { class: `ta-trend-pill ${d.trend.mid}`, text: `중기 ${DIR_KO[d.trend.mid]}` }),
        el("span", { class: `ta-trend-pill ${d.trend.short}`, text: `단기 ${DIR_KO[d.trend.short]}` }),
        el("span", { class: `ta-trend-pill ${d.trend.trending ? "up" : "flat"}`, text: `ADX ${d.trend.adx} ${d.trend.trending ? "추세" : "횡보"}` }),
      ]),
      el("p", { class: "note", text: `${d.trend.alignment} · ${d.trend.text}` }),
      el("div", { class: "ta-ind" }, [
        ind("RSI", i.rsi.toFixed(0), i.rsi >= 70 ? "down" : i.rsi <= 30 ? "up" : ""),
        ind("MACD", i.macdHist >= 0 ? "+" + i.macdHist.toFixed(0) : i.macdHist.toFixed(0), i.macdHist >= 0 ? "up" : "down"),
        ind("ADX", i.adx.toFixed(0), i.adx >= 25 ? "up" : ""),
        ind("MFI", i.mfi.toFixed(0), i.mfi >= 80 ? "down" : i.mfi <= 20 ? "up" : ""),
        ind("%B", i.bbPercentB + "%", ""),
        ind("ATR", i.atr.toFixed(0), ""),
      ]),
      el("p", { class: "note" }, [
        `지지 ${d.levels.support ? this.money(d.levels.support) : "-"} · 저항 ${d.levels.resistance ? this.money(d.levels.resistance) : "-"}` +
        (d.suggestedStop ? ` · 변동성 손절 제안 ${this.money(d.suggestedStop)} (2×ATR)` : ""),
      ]),
    ]);
  }


  /** 컨센서스 — 성격별로 나눈 막대. "추세는 좋은데 모멘텀이 죽었다"가 한눈에 보이게 */
  private consensusBar(d: TaResponse): HTMLElement {
    const box = el("div", { class: "ta-cons" });
    const row = (name: string, score: number, buy: number, sell: number) => {
      const pct = Math.min(100, Math.abs(score) * 100);
      const bar = el("div", { class: "ta-cons-track" }, [
        el("div", {
          class: `ta-cons-fill ${score >= 0 ? "up" : "down"}`,
          style: `width:${pct / 2}%; ${score >= 0 ? "left:50%" : `left:${50 - pct / 2}%`}`,
        }),
        el("div", { class: "ta-cons-zero" }),
      ]);
      return el("div", { class: "ta-cons-row" }, [
        el("span", { class: "ta-cons-name", text: name }),
        bar,
        el("span", { class: `ta-cons-num ${score >= 0 ? "up" : score < 0 ? "down" : ""}`, text: `${score >= 0 ? "+" : ""}${score.toFixed(2)}` }),
        el("span", { class: "ta-cons-vote", text: buy || sell ? `${buy}↑ ${sell}↓` : "—" }),
      ]);
    };
    box.append(row("종합", d.consensus.score, d.consensus.buy, d.consensus.sell));
    for (const g of d.groups) box.append(row(g.nameKo, g.score, g.buy, g.sell));
    return box;
  }

  /** 매매 플랜 — 판정을 진입·손절·목표라는 숫자로 옮긴 화면 */
  private planBlocks(d: TaResponse): HTMLElement[] {
    const p = d.plan;
    const w = (n: number) => this.money((n));
    const gradeTone = p.grade === "good" ? "up" : p.grade === "fair" ? "flat" : "down";

    const head = el("div", { class: `ta-plan-head ${gradeTone}` }, [
      el("span", { class: "ta-plan-bias", text: p.biasKo }),
      el("span", { class: "ta-plan-grade", text: p.gradeKo }),
      el("span", { class: "ta-plan-rr", text: `손익비 ${p.rr.toFixed(2)} : 1` }),
    ]);

    const rows = el("div", { class: "ta-plan-rows" }, [
      planRow("목표 2차", w(p.targets[1].price), `+${p.targets[1].pct}%`, p.targets[1].note, "up"),
      planRow("목표 1차", w(p.targets[0].price), `+${p.targets[0].pct}%`, p.targets[0].note, "up"),
      planRow("진입 구간", `${w(p.entry.low)} ~ ${w(p.entry.high)}`, "", p.entry.note, "flat"),
      planRow("현재가", w(d.price), fmtPct(d.changePct), "", "flat"),
      planRow("손절", w(p.stop.price), `${p.stop.pct}%`, p.stop.note, "down"),
    ]);

    const size = el("div", { class: "ta-plan-size" }, [
      el("h4", { class: "ta-h4", text: "수량 계산 (1회 손실을 원금의 1%로 제한할 때)" }),
      el("p", { class: "note", text: `1주를 잃을 때의 손실 = ${w(p.riskPerShare)}. 원금 600만원의 1%(6만원)를 건다면 ${Math.max(0, Math.floor(60000 / Math.max(1, p.riskPerShare)))}주가 상한입니다. 종목당 한도(180만원)와 비교해 더 작은 쪽을 따릅니다.` }),
    ]);

    const check = el("ul", { class: "ta-check" }, p.checklist.map((c) =>
      el("li", { class: c.pass ? "pass" : "fail" }, [
        el("span", { class: "ta-check-mark", text: c.pass ? "충족" : "미충족" }),
        el("span", { text: c.text }),
      ]),
    ));

    return [
      el("div", { class: "ta-panel" }, [head, rows, el("p", { class: "note err-soft", text: p.invalidation })]),
      el("div", { class: "ta-panel" }, [el("h4", { class: "ta-h4", text: "진입 조건 점검" }), check]),
      el("div", { class: "ta-panel" }, [size]),
      el("div", { class: "ta-panel" }, [
        el("h4", { class: "ta-h4", text: "지지·저항 사다리 — 여러 근거가 겹치는 가격일수록 강합니다" }),
        this.ladderBlock(d),
      ]),
    ];
  }

  private ladderBlock(d: TaResponse): HTMLElement {
    const ul = el("div", { class: "ta-ladder" });
    for (const l of d.ladder) {
      const isRes = l.kind === "resistance";
      ul.append(
        el("div", { class: `ta-lvl ${isRes ? "res" : "sup"}` }, [
          el("span", { class: "ta-lvl-tag", text: isRes ? "저항" : "지지" }),
          el("span", { class: "ta-lvl-price", text: this.money(l.price) }),
          el("span", { class: `ta-lvl-dist ${l.distPct >= 0 ? "up" : "down"}`, text: `${l.distPct >= 0 ? "+" : ""}${l.distPct}%` }),
          el("span", { class: "ta-lvl-bar" }, [el("i", { style: `width:${Math.round(l.strength * 100)}%` })]),
          el("span", { class: "ta-lvl-src", text: l.sources.join(" · ") }),
        ]),
      );
      if (!isRes && d.ladder.indexOf(l) === d.ladder.findIndex((x) => x.kind === "support")) {
        // 현재가 위치를 사다리 사이에 끼워 넣는다
        ul.insertBefore(
          el("div", { class: "ta-lvl now" }, [
            el("span", { class: "ta-lvl-tag", text: "현재" }),
            el("span", { class: "ta-lvl-price", text: this.money((d.price)) }),
          ]),
          ul.lastChild,
        );
      }
    }
    return ul;
  }

  /** ① 가격 + 이평 + 볼린저 + 지지/저항 + 거래량 */
  private chartBlocks(d: TaResponse): HTMLElement[] {
    const c = d.chart;
    const n = c.close.length;
    if (!n) return [el("p", { class: "note", text: "차트 데이터가 없습니다." })];

    const W = 720, H = 260, PAD = 34, VOL_H = 46;
    const plotH = H - VOL_H - 18;
    const lows = [...c.low, ...(c.bbLower.filter(Number.isFinite) as number[])];
    const highs = [...c.high, ...(c.bbUpper.filter(Number.isFinite) as number[])];
    const min = Math.min(...lows), max = Math.max(...highs);
    const pad = (max - min) * 0.05 || 1;
    const sc: Scale = {
      x: (i) => PAD + (i / Math.max(1, n - 1)) * (W - PAD - 8),
      y: (v) => 8 + ((max + pad - v) / (max - min + 2 * pad)) * (plotH - 8),
    };

    const s1 = svg(W, H);
    // 가로 격자 + 눈금
    for (let k = 0; k <= 4; k++) {
      const val = min - pad + ((max - min + 2 * pad) * k) / 4;
      s1.append(hLine(sc.y(val), PAD, W - 8, C.grid, "2 3"), label(PAD - 4, sc.y(val) + 3, this.money((val)), "rgba(148,163,184,0.9)", "end"));
    }
    // 볼린저 밴드
    s1.append(path(linePath(c.bbUpper, sc), C.band, 1, "3 3"), path(linePath(c.bbLower, sc), C.band, 1, "3 3"));
    // 캔들 — 봉이 많으면 선으로 떨어뜨린다(720px 에 180봉이면 4px, 그 이하는 뭉갠다)
    const bw = Math.max(1, (W - PAD - 8) / n - 1.2);
    if (bw >= 2) {
      for (let i = 0; i < n; i++) {
        const up = c.close[i] >= c.open[i];
        const col = up ? C.up : C.down;
        const wick = document.createElementNS(NS, "line");
        wick.setAttribute("x1", String(sc.x(i))); wick.setAttribute("x2", String(sc.x(i)));
        wick.setAttribute("y1", String(sc.y(c.high[i]))); wick.setAttribute("y2", String(sc.y(c.low[i])));
        wick.setAttribute("stroke", col); wick.setAttribute("stroke-width", "0.8");
        const body = document.createElementNS(NS, "rect");
        const yTop = sc.y(Math.max(c.open[i], c.close[i]));
        const hBody = Math.max(0.8, Math.abs(sc.y(c.open[i]) - sc.y(c.close[i])));
        body.setAttribute("x", String(sc.x(i) - bw / 2)); body.setAttribute("y", String(yTop));
        body.setAttribute("width", String(bw)); body.setAttribute("height", String(hBody));
        body.setAttribute("fill", col); body.setAttribute("opacity", "0.85");
        s1.append(wick, body);
      }
    } else {
      s1.append(path(linePath(c.close, sc), C.up, 1.4));
    }
    // 이동평균
    s1.append(path(linePath(c.ma20, sc), C.ma20, 1.3), path(linePath(c.ma60, sc), C.ma60, 1.3));
    // 지지·저항 사다리 — 강할수록 진하게. 화면 밖 가격은 건너뛴다
    for (const lv of d.ladder) {
      if (lv.price > max + pad || lv.price < min - pad) continue;
      const col = lv.kind === "support" ? C.sup : C.res;
      const ln = hLine(sc.y(lv.price), PAD, W - 8, col, lv.strength >= 0.5 ? "8 3" : "3 4");
      ln.setAttribute("stroke-width", String(0.8 + lv.strength * 1.4));
      ln.setAttribute("opacity", String(0.35 + lv.strength * 0.5));
      s1.append(ln, label(W - 10, sc.y(lv.price) - 3, `${lv.kind === "support" ? "지지" : "저항"} ${this.money(lv.price)}`, col, "end"));
    }
    // 매매 플랜의 손절·목표를 같은 그림에 겹친다 — 계획과 차트가 따로 놀지 않게
    for (const [v2, txt, col] of [
      [d.plan.stop.price, `손절 ${this.money(d.plan.stop.price)}`, "#f43f5e"],
      [d.plan.targets[0].price, `목표1 ${this.money(d.plan.targets[0].price)}`, "#14b8a6"],
    ] as [number, string, string][]) {
      if (v2 > max + pad || v2 < min - pad) continue;
      const ln = hLine(sc.y(v2), PAD, W - 8, col, "2 2");
      ln.setAttribute("stroke-width", "1.6");
      s1.append(ln, label(PAD + 4, sc.y(v2) - 3, txt, col, "start"));
    }
    // 거래량
    const vmax = Math.max(...c.volume, 1);
    for (let i = 0; i < n; i++) {
      const r = document.createElementNS(NS, "rect");
      const hv = (c.volume[i] / vmax) * VOL_H;
      r.setAttribute("x", String(sc.x(i) - bw / 2)); r.setAttribute("y", String(H - hv - 8));
      r.setAttribute("width", String(Math.max(0.6, bw))); r.setAttribute("height", String(hv));
      r.setAttribute("fill", c.close[i] >= c.open[i] ? C.up : C.down); r.setAttribute("opacity", "0.35");
      s1.append(r);
    }

    /* ② 추세 — ADX / +DI / -DI */
    const s2 = svg(W, 130);
    const sc2: Scale = { x: sc.x, y: (v) => 10 + ((60 - v) / 60) * 100 };
    for (const lv of [20, 25, 40]) s2.append(hLine(sc2.y(lv), PAD, W - 8, C.grid, "2 3"), label(PAD - 4, sc2.y(lv) + 3, String(lv), "rgba(148,163,184,0.9)", "end"));
    s2.append(
      path(linePath(c.adx, sc2), C.adx, 1.6),
      path(linePath(c.pdi, sc2), C.pdi, 1.2),
      path(linePath(c.mdi, sc2), C.mdi, 1.2),
    );

    /* ③ 모멘텀 — RSI 와 MACD */
    const s3 = svg(W, 130);
    const sc3: Scale = { x: sc.x, y: (v) => 10 + ((100 - v) / 100) * 52 };
    for (const lv of [30, 50, 70]) s3.append(hLine(sc3.y(lv), PAD, W - 8, C.grid, "2 3"), label(PAD - 4, sc3.y(lv) + 3, String(lv), "rgba(148,163,184,0.9)", "end"));
    s3.append(path(linePath(c.rsi, sc3), C.rsi, 1.5));

    const hv = c.macdHist.filter((x): x is number => x !== null && Number.isFinite(x));
    const mMax = Math.max(1, ...hv.map(Math.abs), ...c.macd.filter((x): x is number => x !== null).map(Math.abs));
    const sc4: Scale = { x: sc.x, y: (v) => 100 + ((0 - v) / mMax) * 22 };
    s3.append(hLine(sc4.y(0), PAD, W - 8, C.grid, "2 3"));
    c.macdHist.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      const r = document.createElementNS(NS, "rect");
      const y0 = sc4.y(0), y1 = sc4.y(v);
      r.setAttribute("x", String(sc.x(i) - Math.max(0.5, bw / 2)));
      r.setAttribute("y", String(Math.min(y0, y1)));
      r.setAttribute("width", String(Math.max(1, bw)));
      r.setAttribute("height", String(Math.max(0.6, Math.abs(y1 - y0))));
      r.setAttribute("fill", v >= 0 ? C.up : C.down); r.setAttribute("opacity", "0.5");
      s3.append(r);
    });
    s3.append(path(linePath(c.macd, sc4), C.macd, 1.2), path(linePath(c.macdSignal, sc4), C.sig, 1.2));

    const legend = (items: [string, string][]) =>
      el("div", { class: "ta-legend" }, items.map(([t, col]) => el("span", { class: "ta-leg" }, [
        el("i", { style: `background:${col}` }), t,
      ])));

    return [
      el("div", { class: "ta-panel" }, [
        el("h4", { class: "ta-h4", text: "① 주가 · 지지/저항 · 거래량" }),
        legend([["20일선", C.ma20], ["60일선", C.ma60], ["볼린저", C.band], ["지지", C.sup], ["저항", C.res]]),
        s1 as unknown as HTMLElement,
      ]),
      el("div", { class: "ta-panel" }, [
        el("h4", { class: "ta-h4", text: "② 추세 강도 — ADX / DMI" }),
        legend([["ADX(추세강도)", C.adx], ["+DI(상승)", C.pdi], ["-DI(하락)", C.mdi]]),
        s2 as unknown as HTMLElement,
        el("p", { class: "note", text: "ADX 25 위면 추세가 있다고 보고, 아래면 횡보로 봅니다. 횡보 구간에서는 돌파 신호를 믿으면 안 됩니다." }),
      ]),
      el("div", { class: "ta-panel" }, [
        el("h4", { class: "ta-h4", text: "③ 모멘텀 — RSI · MACD" }),
        legend([["RSI", C.rsi], ["MACD", C.macd], ["시그널", C.sig]]),
        s3 as unknown as HTMLElement,
      ]),
    ];
  }

  private strategyBlock(d: TaResponse): HTMLElement {
    const box = el("div", { class: "ta-strategies" });
    for (const s of d.strategies) {
      const tone = s.score >= 0.2 ? "up" : s.score <= -0.2 ? "down" : "flat";
      box.append(
        el("div", { class: `ta-strat ${tone}` }, [
          el("div", { class: "ta-strat-top" }, [
            el("span", { class: "ta-strat-name", text: s.nameKo }),
            el("span", { class: `ta-strat-verdict ${tone}`, text: `${VERDICT_KO[s.verdict]} ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}` }),
          ]),
          el("p", { class: "ta-strat-text", text: s.text }),
          el("p", { class: "ta-strat-author", text: s.author }),
          ...(s.levels?.length
            ? [el("p", { class: "ta-strat-levels", text: s.levels.map((l) => `${l.label} ${this.money(l.value)}`).join(" · ") })]
            : []),
        ]),
      );
    }
    if (d.patterns.length) {
      box.append(el("div", { class: "ta-strat flat" }, [
        el("div", { class: "ta-strat-top" }, [el("span", { class: "ta-strat-name", text: "캔들 패턴" })]),
        ...d.patterns.map((p) => el("p", { class: "ta-strat-text", text: `${p.nameKo} — ${p.text}` })),
      ]));
    }
    if (d.fib.length) {
      box.append(el("div", { class: "ta-strat flat" }, [
        el("div", { class: "ta-strat-top" }, [el("span", { class: "ta-strat-name", text: "피보나치 되돌림" })]),
        el("p", { class: "ta-strat-levels", text: d.fib.map((f) => `${f.label} ${this.money(f.value)}`).join(" · ") }),
      ]));
    }
    return box;
  }
}

const DIR_KO: Record<string, string> = { up: "상승", down: "하락", flat: "횡보" };

function planRow(label2: string, price: string, delta: string, note: string, tone: string): HTMLElement {
  return el("div", { class: `ta-plan-row ${tone}` }, [
    el("span", { class: "ta-plan-label", text: label2 }),
    el("span", { class: "ta-plan-price", text: price }),
    el("span", { class: `ta-plan-delta ${tone}`, text: delta }),
    el("span", { class: "ta-plan-note", text: note }),
  ]);
}

const VERDICT_KO: Record<string, string> = {
  strong_buy: "적극 매수",
  buy: "매수",
  neutral: "중립",
  sell: "매도",
  strong_sell: "적극 매도",
};

function ind(label: string, value: string, tone: string): HTMLElement {
  return el("div", { class: "ta-ind-cell" }, [
    el("span", { class: "ta-ind-label", text: label }),
    el("span", { class: `ta-ind-value ${tone}`, text: value }),
  ]);
}

export type { TaStrategy };
