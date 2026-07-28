/**
 * 국가 상세 패널: 지수 요약 + 뉴스 / 추천 / 주문 탭.
 */
import {
  api,
  type AiStatus,
  type AnalysisResult,
  ApiFailure,
  type KisStatus,
  type NewsItem,
  type Overview,
  type ProviderStat,
  type OntoState,
  type Recommendation,
  type RecommendResponse,
  type TickerScore,
} from "./api";
import { dirClass, el, fmtKrw, fmtKst, fmtNum, fmtPct, sparkline, timeAgo } from "./format";

export interface OrderIntent {
  market: string;
  code: string;
  name: string;
  currency: string;
  price: number;
  side: "buy" | "sell";
  refPrice: number;
}

export type OrderDraft = OrderIntent & { qty: number; orderType: "limit" | "market" };

export interface PanelDeps {
  root: HTMLElement;
  empty: HTMLElement;
  kis: () => KisStatus | null;
  ai: () => AiStatus | null;
  /** 현재 온톨로지 상태 — 종목 상세에서 거시 신호·뉴스 보정·시간 기준을 문장으로 풀 때 쓴다 */
  onto?: () => OntoState | null;
  requestOrder: (order: OrderDraft, ctx: { fxToKrw: number | null }) => void;
  onNeedAuth: () => void;
}

type Tab = "news" | "reco" | "ai" | "order";

export class Panel {
  private deps: PanelDeps;
  private cc = "";
  private nameKo = "";
  private tab: Tab = "reco";
  private overview: Overview | null = null;
  private news: NewsItem[] | null = null;
  private newsSources: ProviderStat[] = [];
  private reco: RecommendResponse | null = null;
  private analysis: AnalysisResult | null = null;
  private analysisError: string | null = null;
  private analysisLoading = false;
  private expanded = new Set<string>();
  private loadToken = 0;
  private orderDraft: OrderIntent | null = null;
  /** 3D 그래프에서 고른 종목 상세 (국가 패널 대신 표시) */
  private tickerView: TickerScore | null = null;

  constructor(deps: PanelDeps) {
    this.deps = deps;
  }

  async open(cc: string, nameKo: string): Promise<void> {
    const token = ++this.loadToken;
    this.cc = cc;
    this.nameKo = nameKo;
    this.overview = null;
    this.news = null;
    this.newsSources = [];
    this.reco = null;
    this.analysis = null;
    this.analysisError = null;
    this.analysisLoading = false;
    this.expanded.clear();
    this.orderDraft = null;
    this.tickerView = null;
    this.tab = "reco"; // 국가를 새로 고르면 항상 추천부터 보여준다
    this.deps.empty.hidden = true;
    this.deps.root.hidden = false;
    this.render();

    const [ovw, news, reco] = await Promise.allSettled([
      api.overview(cc, nameKo),
      api.news(cc, nameKo),
      api.recommend(cc),
    ]);
    if (token !== this.loadToken) return;
    if (ovw.status === "fulfilled") this.overview = ovw.value;
    if (news.status === "fulfilled") {
      this.news = news.value.items;
      this.newsSources = news.value.sources ?? [];
    }
    if (reco.status === "fulfilled") this.reco = reco.value;
    // 종목 유니버스가 없으면 뉴스 탭이 기본
    if (this.reco?.unsupported || !this.reco?.items.length) this.tab = "news";
    this.render();
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    this.render();
    // AI 분석은 비용이 있으니 탭을 처음 열 때만 불러온다(서버에서 15분 캐시).
    if (tab === "ai" && !this.analysis && !this.analysisLoading && !this.analysisError) void this.loadAnalysis();
  }

  private async loadAnalysis(): Promise<void> {
    const token = this.loadToken;
    const cc = this.cc;
    this.analysisLoading = true;
    this.analysisError = null;
    this.render();
    try {
      const data = await api.analysis(cc);
      if (token !== this.loadToken) return;
      this.analysis = data;
    } catch (err) {
      if (token !== this.loadToken) return;
      this.analysisError = err instanceof ApiFailure ? err.message : String(err);
    } finally {
      if (token === this.loadToken) {
        this.analysisLoading = false;
        this.render();
      }
    }
  }

  private renderAnalysis(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const ai = this.deps.ai();

    if (ai && !ai.enabled) {
      out.push(el("div", { class: "order-warn", text: ai.reason }));
      return out;
    }
    if (this.analysisLoading) {
      out.push(
        el("p", { class: "note", text: "AI가 지수·뉴스·종목 점수를 읽고 브리핑을 쓰고 있습니다… (10~20초)" }),
        el("div", { class: "skeleton-row" }),
        el("div", { class: "skeleton-row" }),
      );
      return out;
    }
    if (this.analysisError) {
      out.push(el("div", { class: "order-warn", text: this.analysisError }));
      const retry = el("button", { class: "btn btn-ghost", type: "button", text: "다시 시도" });
      retry.addEventListener("click", () => {
        this.analysisError = null;
        void this.loadAnalysis();
      });
      out.push(retry);
      return out;
    }
    const a = this.analysis;
    if (!a) {
      out.push(el("p", { class: "note", text: "AI 분석을 불러오는 중입니다." }));
      return out;
    }

    const section = (title: string, items: string[], cls = "") => {
      if (!items.length) return null;
      const box = el("div", { class: `ai-block ${cls}` });
      box.append(el("h3", { class: "ai-title", text: title }));
      const ul = el("ul", { class: "ai-list" });
      for (const it of items) ul.append(el("li", { text: it }));
      box.append(ul);
      return box;
    };

    const s1 = section("지금 이 시장", a.summary);
    if (s1) out.push(s1);

    if (a.picks.length) {
      const box = el("div", { class: "ai-block" });
      box.append(el("h3", { class: "ai-title", text: "주목 종목" }));
      for (const p of a.picks) {
        box.append(
          el("div", { class: "ai-pick" }, [
            el("div", { class: "ai-pick-head" }, [
              el("b", { text: p.name }),
              el("span", { class: "sym", text: p.symbol }),
              el("span", { class: "action-chip action-WATCH", text: p.stance }),
            ]),
            el("p", { class: "ai-pick-reason", text: p.reason }),
          ]),
        );
      }
      out.push(box);
    }

    const s2 = section("리스크", a.risks, "ai-risk");
    if (s2) out.push(s2);
    const s3 = section("확인할 것", a.checklist);
    if (s3) out.push(s3);

    out.push(
      el("p", {
        class: "note",
        text: `${a.disclaimer} · ${a.provider === "anthropic" ? "Claude" : "Workers AI"} (${a.model}) · ${new Date(
          a.generatedAt,
        ).toLocaleString("ko-KR")}`,
      }),
    );
    return out;
  }

  /**
   * 3D 그래프에서 종목 노드를 눌렀을 때 여는 상세.
   * 국가 패널과 달리 네트워크를 타지 않는다 — 점수는 이미 그래프가 들고 있다.
   */
  openTicker(t: TickerScore): void {
    this.loadToken++; // 진행 중인 국가 로딩이 화면을 덮어쓰지 않게 무효화
    this.tickerView = t;
    this.deps.empty.hidden = true;
    this.deps.root.hidden = false;
    this.render();
  }

  private renderTicker(t: TickerScore): HTMLElement[] {
    const bar = (label: string, v: number, weight: number, meaning: string) =>
      el("div", { class: "tscore-row", title: meaning }, [
        el("span", { class: "k", text: label }),
        el("span", { class: "sbar" }, [
          el("i", { class: dirClass(v), style: `width:${Math.min(100, Math.abs(v) * 100)}%` }),
        ]),
        el("span", { class: `v ${dirClass(v)}`, text: `${v >= 0 ? "+" : ""}${v.toFixed(3)} ×${weight}` }),
      ]);

    // 점수를 말로 풀어 준다 — 처음 온 사람이 숫자만 보고 나가지 않게
    const verdict =
      t.score >= 0.3
        ? { cls: "up", text: "강한 상방 신호", desc: "거시 환경과 가격 흐름이 같은 방향을 가리키고 있습니다." }
        : t.score >= 0.15
          ? { cls: "up", text: "상방 신호 (매수 후보 기준 통과)", desc: "자동매매 기준선(0.15)을 넘는 신호입니다." }
          : t.score > -0.15
            ? { cls: "flat", text: "중립", desc: "뚜렷한 방향이 없습니다. 관망 구간입니다." }
            : { cls: "down", text: "하방 신호", desc: "거시 환경 또는 가격 흐름이 불리한 방향입니다." };

    const MACRO_KO: Record<string, string> = {
      OIL: "유가", USDKRW: "원/달러 환율", US10Y: "미 10년 금리", SEMI: "반도체 업황",
      KOSPI: "코스피", CHINA: "중국 증시", VIX: "변동성(공포지수)", GOLD: "금",
    };

    const head = el("div", { class: "panel-head" }, [
      el("div", { class: "country" }, [
        el("h2", { text: t.nameKo }),
        el("span", { class: "cc-badge", text: t.code }),
        ...(t.sector !== undefined ? [el("span", { class: "cc-badge", text: t.sector ?? "업종 미분류" })] : []),
      ]),
      el("div", { class: "head-meta" }, [
        el("span", { text: `${fmtNum(t.price, 0)}원` }),
        el("span", { class: dirClass(t.changePct), text: fmtPct(t.changePct) }),
      ]),
    ]);

    const backBtn = el("button", { class: "btn btn-ghost", type: "button", text: "← 대한민국 시장 전체 보기" });
    backBtn.addEventListener("click", () => void this.open("KR", "대한민국"));

    const st = this.deps.onto?.() ?? null;
    const macroById = new Map((st?.macro ?? []).map((m) => [m.id, m]));

    // 인과를 문장으로: "무엇이 얼마나 움직였고(왜) → 어떤 경제적 경로로 → 얼마를 보탰나"
    const edgeItems = (t.edges ?? []).map((e) => {
      const m = macroById.get(e.macroId);
      const name = MACRO_KO[e.macroId] ?? e.macroId;
      const rel = st?.relations?.[e.sector]?.[e.macroId];
      const cause = m
        ? `${name}이(가) 5일간 ${fmtPct(m.changePct)} ${m.changePct >= 0 ? "올랐고" : "내렸고"}${
            m.newsReason ? `, 뉴스 보정 ${m.newsImpact! >= 0 ? "+" : ""}${m.newsImpact} (${m.newsReason})` : ""
          }`
        : `${name}의 최근 움직임이`;
      const mechanism = rel ? ` — ${rel.ko}` : " 섹터 민감도를 거쳐";
      return el("li", {}, [
        ...(rel ? [el("span", { class: "rel-chip", text: `${rel.rel} 경로` })] : []),
        el("span", {
          text: `${cause} → ${e.sector}${mechanism} → 이 종목 점수에 ${
            e.contribution >= 0 ? "+" : ""
          }${e.contribution} ${e.contribution >= 0 ? "보탬" : "부담"}`,
        }),
      ]);
    });

    // 요인 분해 — "지금 이 종목을 움직이는 건 무엇인가" 를 첫 문장으로 준다.
    const axes = [
      { name: "온톨로지(거시 전파)", w: t.ontologyScore * 0.35 },
      { name: "가격 흐름", w: t.priceScore * 0.45 },
      { name: "뉴스", w: t.newsScore * 0.2 },
    ].sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    const lead = axes[0];
    const driverText =
      Math.abs(lead.w) < 0.03
        ? "지금은 세 축 모두 약해서 뚜렷한 원인 없이 중립에 가깝습니다."
        : `지금 이 점수를 ${lead.w >= 0 ? "끌어올리는" : "끌어내리는"} 건 주로 ${lead.name} 축(${lead.w >= 0 ? "+" : ""}${lead.w.toFixed(3)})입니다.` +
          (Math.abs(axes[1].w) >= 0.03
            ? ` 그 다음이 ${axes[1].name}(${axes[1].w >= 0 ? "+" : ""}${axes[1].w.toFixed(3)}).`
            : "");

    // 뉴스가 점수에 어떻게 들어갔나 — 이 종목 경로의 거시 뉴스 보정 + 종목/섹터 기사
    const edgeMacroIds = new Set((t.edges ?? []).map((e) => e.macroId));
    const macroAdjs = (st?.macroNews.adjustments ?? []).filter((a) => edgeMacroIds.has(a.id));
    const newsReasons = (t.reasons ?? []).filter((r) => r.kind === "news");
    const newsItems: HTMLElement[] = [
      ...macroAdjs.map((a) =>
        el("li", {
          text: `[거시 뉴스] ${MACRO_KO[a.id] ?? a.id} ${a.impact >= 0 ? "+" : ""}${a.impact} — ${a.reasonKo}`,
        }),
      ),
      ...newsReasons.map((r) => el("li", { text: `[종목·섹터 기사] ${r.text}` })),
    ];
    const newsMeta = st?.macroNews.headlinesUsed
      ? `1면 헤드라인 ${st.macroNews.headlinesUsed}건을 AI가 읽어 거시요인 보정에 반영합니다(30분 주기). `
      : "";
    const newsEmptyNote =
      `${newsMeta}지금 이 종목 경로에 반영된 뉴스가 없습니다. 종목별 기사 검색은 핵심 20종목에만 돌고(약 45분 주기), ` +
      `"코스피 급락" 같은 시장 일반 기사는 이미 가격에 반영된 정보라 의도적으로 점수에서 제외합니다.`;

    // 시간 기준 — 시세가 언제 것이고, 계산이 언제 됐는지.
    const dataTs = t.asOf ?? st?.dataAsOf ?? null;
    const calcTs = t.asOf ?? st?.generatedAt ?? null;
    const basisText = dataTs
      ? `데이터 기준: 시세 ${fmtKst(dataTs)} (야후 지연 시세·일봉)${
          calcTs && calcTs !== dataTs ? ` · 분석 계산 ${fmtKst(calcTs)}` : ""
        }`
      : null;

    return [
      head,
      el("div", { class: "tab-panel" }, [
        el("div", { class: `verdict verdict-${verdict.cls}` }, [
          el("b", { text: verdict.text }),
          el("span", { text: verdict.desc }),
        ]),
        el("p", { class: "driver-note", text: driverText }),
        ...(basisText ? [el("p", { class: "note", text: basisText })] : []),
        el("div", { class: "tscore" }, [
          el("div", { class: "tscore-total" }, [
            el("span", { class: "k", text: "합성 점수" }),
            el("b", { class: dirClass(t.score), text: t.score.toFixed(3) }),
            el("span", { class: "note", text: "-1(강한 하방) ~ +1(강한 상방)" }),
          ]),
          bar("온톨로지", t.ontologyScore, 0.35, "거시 환경(유가·금리·환율 등)이 이 종목의 섹터에 주는 영향"),
          bar("가격", t.priceScore, 0.45, "이 종목 자체의 최근 가격 흐름(모멘텀·추세·거래 위치)"),
          bar("뉴스", t.newsScore, 0.2, "이 종목·섹터 관련 기사의 긍정/부정"),
        ]),
        ...(edgeItems.length
          ? [
              el("h3", { class: "card-title", text: "왜 이 점수인가 — 온톨로지 경로" }),
              el("ul", { class: "plan-detail" }, edgeItems),
            ]
          : [
              el("h3", { class: "card-title", text: "온톨로지 경로" }),
              el("p", {
                class: "note",
                text:
                  t.sector === null
                    ? "이 종목은 업종이 자동 분류되지 않아 거시 전파 없이 가격 흐름만으로 점수를 냅니다."
                    : "지금 유의미하게 움직인 거시요인이 없어 가격·뉴스 축이 점수를 이끕니다.",
              }),
            ]),
        el("h3", { class: "card-title", text: "뉴스가 점수에 어떻게 들어갔나" }),
        ...(newsItems.length
          ? [el("ul", { class: "plan-detail" }, newsItems)]
          : [el("p", { class: "note", text: newsEmptyNote })]),
        el("h3", { class: "card-title", text: "판단 근거 전체" }),
        el(
          "ul",
          { class: "plan-detail" },
          (t.reasons ?? []).map((r) =>
            el("li", { text: `[${r.kind === "ontology" ? "온톨로지" : r.kind === "price" ? "가격" : "뉴스"}] ${r.text}` }),
          ),
        ),
        el("p", {
          class: "note",
          text: `일변동성 ${t.volatility}%${t.atr ? ` · ATR ${fmtNum(t.atr, 0)}` : ""}${
            t.asOf ? ` · 이 분석은 ${timeAgo(t.asOf)} 데이터 기준 (레이더는 종목당 약 75분 주기로 갱신)` : ""
          }`,
        }),
        el("p", { class: "note", text: "참고 자료입니다. 투자 자문이 아니며 수익을 보장하지 않습니다." }),
        backBtn,
      ]),
    ];
  }

  private render(): void {
    const root = this.deps.root;
    root.replaceChildren();

    if (this.tickerView) {
      root.append(...this.renderTicker(this.tickerView));
      return;
    }

    root.append(this.renderHead());

    const tabs = el("div", { class: "tabs", role: "tablist" });
    const defs: { id: Tab; label: string }[] = [
      { id: "news", label: `뉴스${this.news ? ` (${this.news.length})` : ""}` },
      { id: "reco", label: `추천${this.reco?.items.length ? ` (${this.reco.items.length})` : ""}` },
      { id: "ai", label: "AI 분석" },
      { id: "order", label: "주문" },
    ];
    for (const d of defs) {
      const b = el("button", {
        class: "tab",
        type: "button",
        role: "tab",
        "aria-selected": this.tab === d.id ? "true" : "false",
        text: d.label,
      });
      b.addEventListener("click", () => this.setTab(d.id));
      tabs.append(b);
    }
    root.append(tabs);

    const body = el("div", { class: "tab-panel", role: "tabpanel" });
    if (this.tab === "news") body.append(this.renderNews());
    else if (this.tab === "reco") body.append(...this.renderReco());
    else if (this.tab === "ai") body.append(...this.renderAnalysis());
    else body.append(this.renderOrder());
    root.append(body);
  }

  private renderHead(): HTMLElement {
    const o = this.overview;
    const head = el("div", { class: "panel-head" });
    const country = el("div", { class: "country" }, [
      el("h2", { text: o?.nameKo ?? this.nameKo }),
      el("span", { class: "cc-code", text: this.cc }),
    ]);
    if (o?.session) {
      country.append(
        el("span", {
          class: `session${o.session.open ? " open" : ""}`,
          text: `${o.session.localTime} · ${o.session.label}`,
        }),
      );
    }
    head.append(country);

    if (!o) {
      head.append(el("div", { class: "skeleton-row" }));
      return head;
    }

    if (o.indices.length) {
      const grid = el("div", { class: "index-grid" });
      for (const ix of o.indices) {
        const card = el("div", { class: "index-card" }, [
          el("span", { class: "ix-label", text: ix.label }),
          el("span", { class: "ix-price", text: fmtNum(ix.price) }),
          el("span", { class: `ix-change ${dirClass(ix.changePct)}`, text: fmtPct(ix.changePct) }),
        ]);
        const sp = ix.sparkline ? sparkline(ix.sparkline) : null;
        if (sp) card.append(sp);
        grid.append(card);
      }
      head.append(grid);
    }

    const meta: string[] = [];
    if (o.currency) meta.push(`통화 ${o.currency}`);
    if (o.fxToKrw) meta.push(`1 ${o.currency} ≈ ${fmtNum(o.fxToKrw, 2)}원`);
    if (o.tickerCount) meta.push(`종목 ${o.tickerCount}개`);
    if (o.orderableCount) meta.push(`주문가능 ${o.orderableCount}개`);
    if (meta.length) head.append(el("span", { class: "note", text: meta.join(" · ") }));
    if (o.regionNote) head.append(el("span", { class: "note", text: `※ ${o.regionNote}` }));
    if (o.proxyNote) head.append(el("span", { class: "note", text: `※ ${o.proxyNote}` }));
    return head;
  }

  private renderNews(): HTMLElement {
    if (!this.news) return el("div", { class: "skeleton-row" });
    if (!this.news.length) {
      const tried = this.newsSources.map((s) => `${s.provider}${s.ok ? `(${s.count}건)` : `(실패: ${s.error ?? "?"})`}`).join(", ");
      return el("div", {}, [
        el("p", { class: "note", text: "최근 7일 금융 관련 기사를 찾지 못했습니다." }),
        tried ? el("p", { class: "note", text: `시도한 제공처 — ${tried}` }) : null,
      ]);
    }
    const list = el("ul", { class: "news-list" });
    for (const n of this.news) {
      const a = el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer", text: n.title });
      const meta = el("div", { class: "news-meta" }, [
        el("span", { class: "lang-tag", text: n.lang === "ko" ? "KO" : "현지" }),
        el("span", { text: n.source }),
        el("span", { text: timeAgo(n.publishedAt) }),
      ]);
      list.append(el("li", {}, [a, meta]));
    }
    return list;
  }

  private renderReco(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (!this.reco) {
      out.push(el("div", { class: "skeleton-row" }), el("div", { class: "skeleton-row" }));
      return out;
    }
    if (this.reco.unsupported || !this.reco.items.length) {
      out.push(el("p", { class: "note", text: this.reco.reason ?? "이 시장은 종목 점수를 계산하지 않습니다." }));
      return out;
    }
    if (this.reco.marketBias) {
      const b = this.reco.marketBias;
      out.push(
        el("div", {
          class: `market-bias ${b.score > 0.25 ? "pos" : b.score < -0.25 ? "neg" : ""}`,
          text: `시장 분위기 ${b.score > 0 ? "+" : ""}${b.score.toFixed(2)} — ${b.text}`,
        }),
      );
    }
    for (const item of this.reco.items) out.push(this.renderRecoCard(item));
    out.push(
      el("p", {
        class: "note",
        text: `${this.reco.disclaimer} 계산 시각: ${new Date(this.reco.generatedAt ?? Date.now()).toLocaleString("ko-KR")}`,
      }),
    );
    return out;
  }

  private renderRecoCard(item: Recommendation): HTMLElement {
    const open = this.expanded.has(item.symbol);
    const card = el("article", { class: "reco" });
    const head = el("button", {
      class: "reco-head",
      type: "button",
      "aria-expanded": open ? "true" : "false",
    });
    head.append(
      el("div", { class: "reco-name" }, [
        el("b", { text: item.name }),
        el("span", { class: "sym", text: `${item.symbol}${item.kis ? ` · ${item.kis.market} ${item.kis.code}` : ""}` }),
      ]),
      el("div", { class: "reco-right" }, [
        el("div", { class: "reco-px" }, [
          el("div", { text: `${fmtNum(item.price)} ${item.currency}` }),
          el("div", { class: dirClass(item.changePct), text: fmtPct(item.changePct) }),
        ]),
        el("span", { class: `action-chip action-${item.action}`, text: `${item.actionKo} ${item.score > 0 ? "+" : ""}${item.score.toFixed(2)}` }),
      ]),
    );
    head.addEventListener("click", () => {
      if (this.expanded.has(item.symbol)) this.expanded.delete(item.symbol);
      else this.expanded.add(item.symbol);
      this.render();
    });
    card.append(head);

    if (!open) return card;

    const body = el("div", { class: "reco-body" });
    const plan = el("div", { class: "plan-grid" }, [
      el("div", { class: "plan-cell" }, [el("span", { class: "k", text: "진입(현재가)" }), el("span", { class: "v", text: fmtNum(item.plan.entry) })]),
      el("div", { class: "plan-cell" }, [
        el("span", { class: "k", text: `손절 (${fmtPct(item.plan.stopPct)})` }),
        el("span", { class: "v down", text: fmtNum(item.plan.stop) }),
      ]),
      el("div", { class: "plan-cell" }, [
        el("span", { class: "k", text: `목표 (${fmtPct(item.plan.targetPct)})` }),
        el("span", { class: "v up", text: fmtNum(item.plan.target) }),
      ]),
      el("div", { class: "plan-cell" }, [el("span", { class: "k", text: "손익비" }), el("span", { class: "v", text: `${item.plan.rr}:1` })]),
    ]);
    body.append(plan);

    const factors = el("div", { class: "factors" });
    for (const f of item.factors) {
      const bar = el("div", { class: "bar" });
      const fill = el("i", { class: f.value < 0 ? "neg" : "" });
      const pct = Math.min(50, Math.abs(f.value) * 50);
      if (f.value >= 0) {
        fill.style.left = "50%";
        fill.style.width = `${pct}%`;
      } else {
        fill.style.right = "50%";
        fill.style.width = `${pct}%`;
      }
      bar.append(fill);
      factors.append(
        el("div", { class: "factor" }, [
          el("span", { class: "fk", text: f.label }),
          bar,
          el("span", { class: "ft", text: f.text }),
        ]),
      );
    }
    body.append(factors);
    body.append(
      el("p", {
        class: "note",
        text: `가중합 점수 ${item.score.toFixed(2)} · 신뢰도 ${item.confidence}% · ATR ${fmtNum(item.atr)} · 관련기사 ${item.newsHits}건`,
      }),
    );

    const actions = el("div", { class: "reco-actions" });
    const kis = this.deps.kis();
    const overseasBlocked = Boolean(item.kis && item.kis.market !== "KRX" && kis && !kis.overseasEnabled);
    if (item.orderable && item.kis && !overseasBlocked) {
      const buy = el("button", { class: "btn btn-buy", type: "button", text: "매수 주문 담기" });
      buy.addEventListener("click", () => this.intendOrder(item, "buy"));
      const sell = el("button", { class: "btn btn-sell", type: "button", text: "매도 주문 담기" });
      sell.addEventListener("click", () => this.intendOrder(item, "sell"));
      actions.append(buy, sell);
    } else if (overseasBlocked) {
      actions.append(
        el("span", { class: "note", text: `해외주식 주문 불가 — ${kis?.overseasReason ?? "계좌 모드 제한"}` }),
      );
    } else {
      actions.append(el("span", { class: "note", text: "이 종목은 한국투자증권 주문 대상이 아닙니다(조회 전용)." }));
    }
    body.append(actions);
    card.append(body);
    return card;
  }

  private intendOrder(item: Recommendation, side: "buy" | "sell"): void {
    if (!item.kis) return;
    this.orderDraft = {
      market: item.kis.market,
      code: item.kis.code,
      name: item.name,
      currency: item.currency || (item.kis.market === "KRX" ? "KRW" : "USD"),
      price: item.price,
      refPrice: item.price,
      side,
    };
    this.setTab("order");
  }

  /* ── 주문 탭 ─────────────────────────────── */

  private renderOrder(): HTMLElement {
    const wrap = el("div", { class: "tab-panel" });
    const kis = this.deps.kis();

    if (!kis) {
      wrap.append(el("div", { class: "skeleton-row" }));
      return wrap;
    }

    const status = el("div", { class: "order-est" }, [
      el("div", { text: `계좌 모드: ${kis.envKo} (${kis.env})` }),
      el("div", { text: `주문 스위치: ${kis.ordersEnabled ? "ON" : "OFF"} · 1회 한도 ${fmtKrw(kis.maxOrderNotionalKrw)}` }),
      el("div", { text: `해외주식: ${kis.overseasEnabled ? "주문 가능" : "주문 불가"}` }),
    ]);
    wrap.append(status);

    if (kis.dryRun) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "검증 모드(ORDER_DRY_RUN=true): 주문 버튼을 눌러도 KIS에 주문이 전송되지 않고 인증·한도·TR_ID 검증만 수행합니다. 실주문은 이 값을 false 로 바꾼 뒤 가능합니다.",
        }),
      );
    } else if (kis.env === "prod" && kis.ordersEnabled) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "실전투자 계좌에 실제 주문이 전송되는 상태입니다. 수량과 가격을 반드시 확인하세요.",
        }),
      );
    }

    if (!kis.configured) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "서버에 KIS_APP_KEY / KIS_APP_SECRET / KIS_ACCOUNT 시크릿이 없습니다. README의 배포 절차대로 등록하면 주문 탭이 활성화됩니다.",
        }),
      );
      return wrap;
    }
    if (!kis.ordersEnabled && !kis.dryRun) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "주문 전송이 꺼져 있습니다(ORDER_ENABLED=false). 시세·잔고 조회는 가능하지만 주문은 서버에서 거부됩니다.",
        }),
      );
    }

    // 해외주식이 막힌 계좌 모드면 국내(KRX) 종목만 주문 후보로 둔다.
    const candidates = (this.reco?.items ?? []).filter(
      (i) => i.orderable && i.kis && (i.kis.market === "KRX" || kis.overseasEnabled),
    );
    const blockedOverseas = (this.reco?.items ?? []).some(
      (i) => i.orderable && i.kis && i.kis.market !== "KRX" && !kis.overseasEnabled,
    );
    if (blockedOverseas) {
      wrap.append(el("div", { class: "order-warn", text: `해외주식 주문이 막혀 있습니다 — ${kis.overseasReason}` }));
    }
    if (!candidates.length) {
      wrap.append(
        el("p", {
          class: "note",
          text: blockedOverseas
            ? "지금 계좌 모드에서는 이 시장에 주문을 낼 수 없습니다. 뉴스·추천은 그대로 보시고, 주문은 국내(대한민국) 종목으로 하세요."
            : "이 국가에는 한국투자증권으로 주문 가능한 등록 종목이 없습니다. 대한민국 시장을 선택해 보세요.",
        }),
      );
      wrap.append(this.renderBalanceBlock("KRX", "KRW"));
      return wrap;
    }

    if (this.orderDraft && this.orderDraft.market !== "KRX" && !kis.overseasEnabled) this.orderDraft = null;

    // 1주 금액이 한도 안에 드는 종목을 기본값으로 고른다.
    // 점수 1위가 고가주여서 첫 화면부터 "한도 초과"가 뜨는 걸 막는다.
    const fx = this.overview?.fxToKrw ?? 1;
    const affordable =
      candidates.find((c) => c.price * (c.currency === "KRW" ? 1 : fx) <= kis.maxOrderNotionalKrw) ??
      [...candidates].sort(
        (a, b) => a.price * (a.currency === "KRW" ? 1 : fx) - b.price * (b.currency === "KRW" ? 1 : fx),
      )[0];

    const draft: OrderIntent =
      this.orderDraft ??
      (() => {
        const c = affordable ?? candidates[0];
        return {
          market: c.kis!.market,
          code: c.kis!.code,
          name: c.name,
          currency: c.currency || (c.kis!.market === "KRX" ? "KRW" : "USD"),
          price: c.price,
          refPrice: c.price,
          side: "buy" as const,
        };
      })();
    this.orderDraft = draft;

    // data-role 은 E2E 검증에서 폼을 찾는 안정적인 훅이다.
    const form = el("form", { class: "order-form", "data-role": "order-form" });

    // 종목 선택
    const select = el("select", { id: "ord-symbol" });
    for (const c of candidates) {
      const opt = el("option", {
        value: `${c.kis!.market}:${c.kis!.code}`,
        text: `${c.name} (${c.kis!.market} ${c.kis!.code})`,
        selected: draft.code === c.kis!.code,
      });
      select.append(opt);
    }
    if (!candidates.some((c) => c.kis!.code === draft.code)) {
      select.append(el("option", { value: `${draft.market}:${draft.code}`, text: `${draft.name} (${draft.market} ${draft.code})`, selected: true }));
    }
    form.append(el("label", { class: "field" }, [el("span", { text: "종목" }), select]));

    // 매수/매도
    const sideWrap = el("div", { class: "side-toggle" });
    const buyBtn = el("button", { class: "btn btn-buy", type: "button", "aria-pressed": draft.side === "buy" ? "true" : "false", text: "매수" });
    const sellBtn = el("button", { class: "btn btn-sell", type: "button", "aria-pressed": draft.side === "sell" ? "true" : "false", text: "매도" });
    buyBtn.addEventListener("click", () => {
      draft.side = "buy";
      this.render();
    });
    sellBtn.addEventListener("click", () => {
      draft.side = "sell";
      this.render();
    });
    sideWrap.append(buyBtn, sellBtn);
    form.append(el("label", { class: "field" }, [el("span", { text: "구분" }), sideWrap]));

    // 주문 유형 / 수량 / 가격
    const typeSel = el("select", { id: "ord-type" }, [
      el("option", { value: "limit", text: "지정가" }),
      el("option", { value: "market", text: "시장가 (국내만)", disabled: draft.market !== "KRX" }),
    ]);
    const qtyInput = el("input", { id: "ord-qty", type: "number", min: "1", step: "1", value: "1", inputmode: "numeric" });
    const priceInput = el("input", { id: "ord-price", type: "number", min: "0", step: "0.01", value: String(draft.price) });

    const row = el("div", { class: "field-row" }, [
      el("label", { class: "field" }, [el("span", { text: "수량(주)" }), qtyInput]),
      el("label", { class: "field" }, [el("span", { text: `가격(${draft.currency})` }), priceInput]),
    ]);
    form.append(el("label", { class: "field" }, [el("span", { text: "주문 유형" }), typeSel]), row);

    const est = el("div", { class: "order-est" });
    const updateEst = () => {
      const qty = Number(qtyInput.value) || 0;
      const isMarket = typeSel.value === "market";
      const unit = isMarket ? draft.refPrice : Number(priceInput.value) || 0;
      const notional = qty * unit;
      const fx = this.overview?.fxToKrw ?? (draft.currency === "KRW" ? 1 : null);
      const krw = fx ? notional * fx : null;
      priceInput.disabled = isMarket;
      est.replaceChildren(
        el("div", { text: `주문금액 ${fmtNum(notional)} ${draft.currency}${krw ? ` ≈ ${fmtKrw(krw)}` : ""}` }),
        el("div", {
          text: krw && krw > kis.maxOrderNotionalKrw ? `한도 초과: 1회 ${fmtKrw(kis.maxOrderNotionalKrw)} 까지` : `1회 한도 ${fmtKrw(kis.maxOrderNotionalKrw)}`,
          class: krw && krw > kis.maxOrderNotionalKrw ? "up" : "",
        }),
      );
    };
    qtyInput.addEventListener("input", updateEst);
    priceInput.addEventListener("input", updateEst);
    typeSel.addEventListener("change", updateEst);
    select.addEventListener("change", () => {
      const [market, code] = select.value.split(":");
      const found = candidates.find((c) => c.kis!.code === code);
      this.orderDraft = {
        market,
        code,
        name: found?.name ?? code,
        currency: found?.currency || (market === "KRX" ? "KRW" : "USD"),
        price: found?.price ?? 0,
        refPrice: found?.price ?? 0,
        side: draft.side,
      };
      this.render();
    });
    updateEst();
    form.append(est);

    const submit = el("button", {
      class: `btn ${draft.side === "buy" ? "btn-buy" : "btn-sell"}`,
      type: "submit",
      text: `${draft.name} ${draft.side === "buy" ? "매수" : "매도"} 주문 확인`,
    });
    form.append(submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const qty = Math.floor(Number(qtyInput.value) || 0);
      const orderType = typeSel.value === "market" ? "market" : "limit";
      if (qty <= 0) {
        qtyInput.focus();
        return;
      }
      this.deps.requestOrder(
        {
          ...draft,
          qty,
          orderType,
          price: orderType === "market" ? 0 : Number(priceInput.value) || 0,
        },
        { fxToKrw: this.overview?.fxToKrw ?? (draft.currency === "KRW" ? 1 : null) },
      );
    });

    wrap.append(form);
    wrap.append(
      kis.overseasEnabled || draft.market === "KRX"
        ? this.renderBalanceBlock(draft.market, draft.currency)
        : this.renderBalanceBlock("KRX", "KRW"),
    );
    wrap.append(
      el("p", {
        class: "note",
        text: kis.env === "prod"
          ? "실전 계좌입니다. 검증 모드(ORDER_DRY_RUN)로 전 과정을 먼저 확인하고, 실주문은 1주·최소 금액부터 시작하세요."
          : "모의투자에서 먼저 체결을 확인하세요. 실전 전환은 KIS_ENV=prod 와 ORDER_ALLOW_REAL=true 를 함께 바꿔야 합니다.",
      }),
    );
    return wrap;
  }

  private renderBalanceBlock(market: string, currency: string): HTMLElement {
    const box = el("div", { class: "card" });
    box.append(el("h2", { class: "card-title", text: "계좌 잔고" }));
    const btn = el("button", { class: "btn btn-ghost", type: "button", text: "잔고 조회" });
    const out = el("div", {});
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.replaceChildren(el("div", { class: "skeleton-row" }));
      try {
        const bal = await api.balance(market, currency);
        const table = el("table", { class: "holdings" });
        table.append(
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "종목" }),
              el("th", { text: "수량" }),
              el("th", { text: "평단" }),
              el("th", { text: "현재가" }),
              el("th", { text: "평가손익" }),
            ]),
          ]),
        );
        const tbody = el("tbody", {});
        for (const h of bal.holdings) {
          tbody.append(
            el("tr", {}, [
              el("td", { text: `${h.name || h.symbol}` }),
              el("td", { text: fmtNum(h.qty, 0) }),
              el("td", { text: fmtNum(h.avgPrice) }),
              el("td", { text: fmtNum(h.price) }),
              el("td", { class: dirClass(h.pnl), text: `${fmtNum(h.pnl, 0)} (${fmtPct(h.pnlPct)})` }),
            ]),
          );
        }
        if (!bal.holdings.length) {
          tbody.append(el("tr", {}, [el("td", { colspan: "5", text: "보유 종목이 없습니다." })]));
        }
        table.append(tbody);
        out.replaceChildren(
          el("div", { class: "order-est" }, [
            el("div", { text: `${bal.isPaper ? "모의" : "실전"} · 예수금 ${fmtNum(bal.summary.cash, 0)} ${bal.summary.currency}` }),
            el("div", { text: `주문가능 ${fmtNum(bal.summary.orderableCash, 0)} · 총평가 ${fmtNum(bal.summary.totalEval, 0)}` }),
          ]),
          table,
        );
      } catch (err) {
        const msg = err instanceof ApiFailure ? err.message : String(err);
        out.replaceChildren(el("div", { class: "order-warn", text: msg }));
        if (err instanceof ApiFailure && (err.code === "no_local_token" || err.status === 401)) this.deps.onNeedAuth();
      } finally {
        btn.disabled = false;
      }
    });
    box.append(btn, out);
    return box;
  }
}
