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
  private tab: "chart" | "strategy" = "chart";
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
    for (const [id, t] of [["chart", "차트"], ["strategy", `전략 판정 (${v.buy}매수/${v.sell}매도)`]] as const) {
      const b = el("button", { type: "button", class: `radar-tab${this.tab === id ? " active" : ""}`, text: t });
      b.addEventListener("click", () => { this.tab = id; this.render(); });
      tabs.append(b);
    }

    this.root.replaceChildren(
      this.headerBlock(d),
      tabs,
      ...(this.tab === "chart" ? this.chartBlocks(d) : [this.strategyBlock(d)]),
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
      el("div", { class: "ta-ind" }, [
        ind("RSI", i.rsi.toFixed(0), i.rsi >= 70 ? "down" : i.rsi <= 30 ? "up" : ""),
        ind("MACD", i.macdHist >= 0 ? "+" + i.macdHist.toFixed(0) : i.macdHist.toFixed(0), i.macdHist >= 0 ? "up" : "down"),
        ind("ADX", i.adx.toFixed(0), i.adx >= 25 ? "up" : ""),
        ind("MFI", i.mfi.toFixed(0), i.mfi >= 80 ? "down" : i.mfi <= 20 ? "up" : ""),
        ind("%B", i.bbPercentB + "%", ""),
        ind("ATR", i.atr.toFixed(0), ""),
      ]),
      el("p", { class: "note" }, [
        `지지 ${d.levels.support ? fmtKrw(d.levels.support) : "-"} · 저항 ${d.levels.resistance ? fmtKrw(d.levels.resistance) : "-"}` +
        (d.suggestedStop ? ` · 변동성 손절 제안 ${fmtKrw(d.suggestedStop)} (2×ATR)` : ""),
      ]),
    ]);
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
      s1.append(hLine(sc.y(val), PAD, W - 8, C.grid, "2 3"), label(PAD - 4, sc.y(val) + 3, fmtKrw(Math.round(val)), "rgba(148,163,184,0.9)", "end"));
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
    // 지지·저항
    if (d.levels.support) s1.append(hLine(sc.y(d.levels.support), PAD, W - 8, C.sup, "6 3"), label(W - 10, sc.y(d.levels.support) - 3, `지지 ${fmtKrw(d.levels.support)}`, C.sup, "end"));
    if (d.levels.resistance) s1.append(hLine(sc.y(d.levels.resistance), PAD, W - 8, C.res, "6 3"), label(W - 10, sc.y(d.levels.resistance) - 3, `저항 ${fmtKrw(d.levels.resistance)}`, C.res, "end"));
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
            ? [el("p", { class: "ta-strat-levels", text: s.levels.map((l) => `${l.label} ${fmtKrw(l.value)}`).join(" · ") })]
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
        el("p", { class: "ta-strat-levels", text: d.fib.map((f) => `${f.label} ${fmtKrw(f.value)}`).join(" · ") }),
      ]));
    }
    return box;
  }
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
