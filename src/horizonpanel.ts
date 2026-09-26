/**
 * 홈 — 오늘의 추천 (네이버 증권 목록형).
 *
 * 2026-09-26 개편: 큰 카드 네 장(구간당 한 장)에 성적표·근거·주의사항을 전부
 * 펼치던 것을 **구간 탭 + 조밀한 표**로 바꿨다. 사용자 피드백 — "글씨가 너무
 * 크다", "자랑하는 것 같다", "네이버 증권 UI 를 차용해라".
 *
 * 표 한 줄에 남기는 것: 종목 · 현재가 · 등락 · 목표가 · 손절가 · 손익비 · 종합점수
 * · 세 관점 점수. 근거(거시·수급·차트 문장)는 행을 눌러야 펼쳐진다.
 * 백테스트 성적은 한 줄 각주로만 남기고, 주의사항 목록(caveats)은 화면에서 뺐다
 * — 데이터(shared/backtest-results.json)에는 그대로 있다.
 *
 * 오른쪽 사이드: 시장 브리핑 · 지난 추천 결과 · 종합 점수 상위.
 */
import { api, type BriefForHome, type HorizonBucket, type HorizonPick, type ScorecardView } from "./api";
import { el } from "./format";

type Mk = "KR" | "US";
type BucketId = HorizonBucket["id"];

const fmtPrice = (v: number, mk: Mk) =>
  mk === "US" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : Math.round(v).toLocaleString("ko-KR");
const sgn = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const dir = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const arrow = (v: number) => (v > 0 ? "▲" : v < 0 ? "▼" : "");

export class HorizonPanel {
  private readonly root: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly side: HTMLElement | null;
  private readonly hero: HTMLElement | null;
  private readonly onPick: (symbol: string, name: string) => void;
  private market: Mk = "KR";
  private bucket: BucketId = "day";
  private cache: Partial<Record<Mk, BriefForHome>> = {};
  private score: Partial<Record<Mk, ScorecardView>> = {};
  private loading = false;
  private open = new Set<string>();

  constructor(opts: { root: HTMLElement; tabs: HTMLElement; side?: HTMLElement | null; hero?: HTMLElement | null; onPick: (symbol: string, name: string) => void }) {
    this.root = opts.root;
    this.hero = opts.hero ?? null;
    this.tabs = opts.tabs;
    this.side = opts.side ?? null;
    this.onPick = opts.onPick;
    this.tabs.querySelectorAll<HTMLButtonElement>(".hz-mk").forEach((b) => {
      b.addEventListener("click", () => {
        const m: Mk = b.dataset.market === "US" ? "US" : "KR";
        if (m === this.market) return;
        this.market = m;
        this.tabs.querySelectorAll(".hz-mk").forEach((x) => x.classList.toggle("active", x === b));
        this.open.clear();
        void this.load();
      });
    });
  }

  /** 현재 시장·구간의 1위 종목 — 차트 탭 기본값으로 쓴다 */
  topPick(): { symbol: string; name: string } | null {
    const b = this.cache[this.market];
    const k = b?.horizons?.buckets.find((x) => x.id === this.bucket) ?? b?.horizons?.buckets[0];
    const p = k?.picks.find((x) => x.symbol);
    return p?.symbol ? { symbol: p.symbol, name: p.name } : null;
  }

  async load(force = false): Promise<void> {
    if (this.loading) return;
    const hit = this.cache[this.market];
    if (hit && !force) { this.render(hit); return; }
    this.loading = true;
    if (!hit) this.root.replaceChildren(el("p", { class: "nv-empty", text: "추천을 불러오는 중…" }));
    try {
      const res = await api.horizons(this.market);
      const b = res.briefs[0];
      if (!b?.horizons?.buckets.length) {
        this.root.replaceChildren(el("p", { class: "nv-empty", text: "아직 추천을 만들지 못했습니다. 스캔이 한 바퀴 돈 뒤 다시 시도해 주세요." }));
        return;
      }
      this.cache[this.market] = b;
      this.render(b);
      const mk = this.market;
      if (!this.score[mk]) {
        void api.scorecard(mk).then((v) => {
          this.score[mk] = v;
          if (this.market === mk && this.cache[mk]) this.render(this.cache[mk]!);
        }).catch(() => undefined);
      }
    } catch {
      if (!hit) this.root.replaceChildren(el("p", { class: "nv-empty", text: "추천을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
    } finally {
      this.loading = false;
    }
  }

  private render(b: BriefForHome): void {
    const hz = b.horizons!;
    const k = hz.buckets.find((x) => x.id === this.bucket) ?? hz.buckets[0];
    this.bucket = k.id;

    const meta = el("p", { class: "nv-meta" }, [
      el("b", { text: `매수 기준 ${b.targetSession} 시가` }),
      el("span", { text: b.sessionClosed ? " · 마감 데이터" : " · 장중 데이터(마감 뒤 바뀜)" }),
      el("span", { text: ` · ${b.regime.label}` }),
    ]);

    const btabs = el("div", { class: "nv-seg", role: "tablist" }, hz.buckets.map((x) => {
      const t = el("button", { type: "button", class: `nv-seg-btn${x.id === k.id ? " on" : ""}`, role: "tab", text: x.nameKo });
      t.addEventListener("click", () => { this.bucket = x.id; this.open.clear(); this.render(b); });
      return t;
    }));

    const rule = el("p", { class: "nv-rule" }, [
      el("span", { class: "nv-chip", text: k.ruleKo }),
      el("span", { class: "nv-rule-hold", text: k.holdKo }),
    ]);

    const table = this.table(k);

    /* 각주 — 예전엔 "이 규칙 과거 1년 +24%"(백테스트)였다. 실제로 나갔던 추천의 결과로 바꾼다. */
    const sc = this.score[this.market]?.buckets.find((x) => x.id === k.id);
    const pc = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
    const foot = sc
      ? el("p", { class: "nv-foot" }, [
        el("span", { text: `이 구간 실제 추천 성적(${this.score[this.market]!.since} 이후) — 끝난 거래 ${sc.closed}건 평균 ` }),
        el("b", { class: dir(sc.avgClosed ?? 0), text: pc(sc.avgClosed) }),
        el("span", { text: `${sc.winRateClosed !== null ? ` · 승률 ${(sc.winRateClosed * 100).toFixed(0)}%` : ""} · 보유 중 ${sc.open}건 · ` }),
        (() => { const a = el("a", { href: "#lab", class: "nv-link", text: "성적표 자세히" }); return a; })(),
      ])
      : null;

    this.root.replaceChildren(...[meta, btabs, rule, table, foot].filter(Boolean) as HTMLElement[]);
    this.renderHero(b);
    this.renderSide(b);
  }

  private table(k: HorizonBucket): HTMLElement {
    const mk = this.market;
    const head = el("tr", {}, ["순위", "종목명", "현재가", "전일대비", "목표가", "손절가", "손익비", "종합", "거시", "수급", "차트"]
      .map((h, i) => el("th", { class: i >= 2 ? "r" : "", text: h })));

    const rows: HTMLElement[] = [];
    if (!k.picks.length) {
      rows.push(el("tr", {}, [el("td", { class: "nv-none", colspan: "11", text: "이 구간에서 기준을 넘은 종목이 없습니다." })]));
    }
    for (const p of k.picks) {
      const key = `${k.id}:${p.code}`;
      const isOpen = this.open.has(key);
      const pl = p.plan;
      const tr = el("tr", { class: `nv-row${isOpen ? " open" : ""}` }, [
        el("td", { class: "nv-rank", text: String(p.rank) }),
        el("td", { class: "nv-name" }, [
          el("b", { text: p.name }),
          el("i", { text: `${p.code}${p.sector ? ` · ${p.sector}` : ""}` }),
        ]),
        el("td", { class: "r num", text: fmtPrice(p.price, mk) }),
        el("td", { class: `r num ${dir(p.changePct)}`, text: `${arrow(p.changePct)} ${sgn(p.changePct)}%` }),
        el("td", { class: "r num up" }, pl.target !== null
          ? [el("span", { text: fmtPrice(pl.target, mk) }), el("i", { text: ` +${pl.targetPct}%` })]
          : [el("i", { text: "추적손절" })]),
        el("td", { class: "r num down" }, [el("span", { text: fmtPrice(pl.stop, mk) }), el("i", { text: ` ${pl.stopPct}%` })]),
        el("td", { class: "r num", text: pl.rr !== null ? pl.rr.toFixed(2) : "—" }),
        el("td", { class: `r num nv-score ${dir(p.combo.total)}`, text: p.combo.total.toFixed(2) }),
        this.axisTd(p.combo.onto), this.axisTd(p.combo.flow), this.axisTd(p.combo.chart),
      ]);
      tr.addEventListener("click", () => {
        if (this.open.has(key)) this.open.delete(key); else this.open.add(key);
        this.render(this.cache[this.market]!);
      });
      rows.push(tr);
      if (isOpen) rows.push(this.detail(p));
    }

    return el("div", { class: "nv-table-wrap" }, [
      el("table", { class: "nv-table nv-picks" }, [el("thead", {}, [head]), el("tbody", {}, rows)]),
    ]);
  }

  /** 세 관점 점수 — -1~1. 없으면 대시 */
  private axisTd(v: number | null): HTMLElement {
    if (v === null) return el("td", { class: "r num nv-ax", text: "—" });
    return el("td", { class: `r num nv-ax ${dir(v)}`, text: v.toFixed(2) });
  }

  private detail(p: HorizonPick): HTMLElement {
    const why = [
      p.why.ontologyKo ? ["거시", p.why.ontologyKo] : null,
      p.why.flowKo ? ["수급", p.why.flowKo] : null,
      p.why.chartKo ? ["차트", p.why.chartKo] : null,
    ].filter(Boolean) as [string, string][];
    const go = el("button", { type: "button", class: "nv-btn", text: "차트·종합 분석 보기" });
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      if (p.symbol) this.onPick(p.symbol, p.name);
    });
    return el("tr", { class: "nv-detail" }, [
      el("td", { colspan: "11" }, [
        el("dl", { class: "nv-why" }, why.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
        ...(p.plan.levelNoteKo ? [el("p", { class: "nv-levels", text: p.plan.levelNoteKo })] : []),
        go,
      ]),
    ]);
  }

  /* ── 히어로 예시 카드 — 오늘 단타 1위를 실제 점수로 분해해 보여 준다 ──
   * "어떻게 고르나"를 말로 설명하는 대신 오늘 숫자로 보여 주는 게 제일 강한 후킹이다.
   * 지어낸 예시가 아니라 표 맨 윗줄과 같은 종목·같은 숫자다. */
  private renderHero(b: BriefForHome): void {
    if (!this.hero) return;
    const hz = b.horizons!;
    /* 예시는 세 점수가 가장 고르게 높은 종목 — "합쳐서 고른다"를 보여 주기에 한 축만 튀는
     * 종목(수급 0.98·차트 0.06 같은)보다 정직하다. 방법은 가중 합이지 만장일치가 아니다. */
    let k: typeof hz.buckets[number] | undefined;
    let p: HorizonPick | undefined;
    let best = -Infinity;
    for (const bk of hz.buckets) for (const x of bk.picks) {
      const m = Math.min(x.combo.onto ?? -1, x.combo.flow ?? -1, x.combo.chart ?? -1);
      if (m > best) { best = m; k = bk; p = x; }
    }
    if (!k || !p) { this.hero.replaceChildren(el("p", { class: "hx-demo-k", text: "오늘은 기준을 넘은 종목이 없습니다." })); return; }
    const mk = this.market;
    const distinct = new Set(hz.buckets.flatMap((x) => x.picks.map((y) => y.code))).size;
    const row = (label: string, v: number | null, why: string | null) => {
      const bar = el("span", { class: "hx-bar" }, [el("i", { class: v !== null && v < 0 ? "down" : "up" })]);
      (bar.firstChild as HTMLElement).style.width = `${v === null ? 0 : Math.min(100, Math.abs(v) * 100)}%`;
      return el("div", { class: "hx-axis" }, [
        el("span", { class: "hx-axis-k", text: label }),
        bar,
        el("b", { class: `hx-axis-v ${v !== null && v < 0 ? "down" : "up"}`, text: v === null ? "—" : v.toFixed(2) }),
        ...(why ? [el("span", { class: "hx-axis-why", text: why })] : []),
      ]);
    };
    const pl = p.plan;
    const all = el("button", { type: "button", class: "hx-demo-more", text: `오늘 추천 ${distinct}종목 전부 보기 →` });
    all.addEventListener("click", () => document.getElementById("picks")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const name = el("button", { type: "button", class: "hx-demo-name", text: p.name });
    name.addEventListener("click", () => { if (p.symbol) this.onPick(p.symbol, p.name); });
    this.hero.replaceChildren(
      el("p", { class: "hx-demo-k", text: `오늘의 예시 · 세 점수가 가장 고르게 높은 종목 (${k.nameKo})` }),
      el("div", { class: "hx-demo-head" }, [
        name,
        el("span", { class: "hx-demo-px", text: fmtPrice(p.price, mk) + (mk === "KR" ? "원" : "") }),
        el("span", { class: `hx-demo-chg ${dir(p.changePct)}`, text: `${sgn(p.changePct)}%` }),
      ]),
      row("거시 인과", p.combo.onto, p.why.ontologyKo),
      row("수급", p.combo.flow, p.why.flowKo),
      row("차트", p.combo.chart, p.why.chartKo ? p.why.chartKo.split(",")[0] : null),
      el("div", { class: "hx-sum" }, [
        el("span", { text: "세 점수를 합친 종합 " }),
        el("b", { class: dir(p.combo.total), text: p.combo.total.toFixed(2) }),
        el("span", { text: ` → ${k.nameKo} 추천` }),
      ]),
      el("div", { class: "hx-plan" }, [
        el("span", {}, [el("i", { text: "매수" }), el("b", { text: `${b.targetSession} 시가` })]),
        el("span", {}, [el("i", { text: "목표" }), el("b", { class: "up", text: pl.target !== null ? `${fmtPrice(pl.target, mk)} (+${pl.targetPct}%)` : "추적손절" })]),
        el("span", {}, [el("i", { text: "손절" }), el("b", { class: "down", text: `${fmtPrice(pl.stop, mk)} (${pl.stopPct}%)` })]),
      ]),
      all,
    );
  }

  /* ── 오른쪽 사이드 ───────────────────────────── */
  private renderSide(b: BriefForHome): void {
    if (!this.side) return;
    const mk = this.market;
    const boxes: HTMLElement[] = [];

    // ① 시장 브리핑
    const n = b.narrative;
    const lines = (b.regime.lines ?? []).slice(0, 4);
    boxes.push(el("section", { class: "nv-box" }, [
      el("h3", { class: "nv-box-title", text: "시장 브리핑" }),
      el("p", { class: `nv-regime ${b.regime.tone === "risk-off" ? "down" : "up"}`, text: b.regime.label }),
      ...(n?.summaryKo ? [el("p", { class: "nv-brief", text: n.summaryKo })] : []),
      ...(lines.length ? [el("ul", { class: "nv-bullets" }, lines.map((l) => el("li", { text: l })))] : []),
    ]));

    // ② 지난 추천 결과
    const pv = b.previous;
    if (pv?.picks?.length) {
      const moved = pv.picks.some((x) => x.changePct !== 0);
      boxes.push(el("section", { class: "nv-box" }, [
        el("h3", { class: "nv-box-title" }, [
          el("span", { text: "지난 추천 결과" }),
          el("small", { text: pv.date }),
        ]),
        moved
          ? el("p", { class: "nv-score-line" }, [
            el("span", { text: "적중 " }),
            el("b", { text: `${Math.round(pv.hitRate * pv.picks.length)}/${pv.picks.length}` }),
            el("span", { text: " · 평균 " }),
            el("b", { class: dir(pv.avgChangePct), text: `${sgn(pv.avgChangePct)}%` }),
          ])
          : el("p", { class: "nv-score-line muted", text: "휴장 — 다음 거래일에 채점합니다" }),
        el("ul", { class: "nv-list" }, pv.picks.map((x) => el("li", {}, [
          el("span", { class: "nv-list-name", text: x.name }),
          el("span", { class: "nv-list-px", text: fmtPrice(x.nowPrice, mk) }),
          el("span", { class: `nv-list-chg ${dir(x.changePct)}`, text: `${sgn(x.changePct)}%` }),
        ]))),
      ]));
    }

    // ③ 종합 점수 상위
    if (b.picks?.length) {
      boxes.push(el("section", { class: "nv-box" }, [
        el("h3", { class: "nv-box-title", text: "종합 점수 상위" }),
        el("ul", { class: "nv-list" }, b.picks.slice(0, 6).map((x) => {
          const li = el("li", { class: "click" }, [
            el("span", { class: "nv-list-name" }, [el("b", { text: x.name }), el("i", { text: x.sector ?? "" })]),
            el("span", { class: "nv-list-px", text: x.score.toFixed(2) }),
            el("span", { class: `nv-list-chg ${dir(x.changePct)}`, text: `${sgn(x.changePct)}%` }),
          ]);
          li.addEventListener("click", () => { if (x.symbol) this.onPick(x.symbol, x.name); });
          return li;
        })),
      ]));
    }

    this.side.replaceChildren(...boxes);
  }
}
