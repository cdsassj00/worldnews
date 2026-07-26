/**
 * 국가 상세 패널: 지수 요약 + 뉴스 / 추천 / 주문 탭.
 */
import {
  api,
  ApiFailure,
  type KisStatus,
  type NewsItem,
  type Overview,
  type ProviderStat,
  type Recommendation,
  type RecommendResponse,
} from "./api";
import { dirClass, el, fmtKrw, fmtNum, fmtPct, sparkline, timeAgo } from "./format";

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
  requestOrder: (order: OrderDraft, ctx: { fxToKrw: number | null }) => void;
  onNeedAuth: () => void;
}

type Tab = "news" | "reco" | "order";

export class Panel {
  private deps: PanelDeps;
  private cc = "";
  private nameKo = "";
  private tab: Tab = "reco";
  private overview: Overview | null = null;
  private news: NewsItem[] | null = null;
  private newsSources: ProviderStat[] = [];
  private reco: RecommendResponse | null = null;
  private expanded = new Set<string>();
  private loadToken = 0;
  private orderDraft: OrderIntent | null = null;

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
    this.expanded.clear();
    this.orderDraft = null;
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
  }

  private render(): void {
    const root = this.deps.root;
    root.replaceChildren();
    root.append(this.renderHead());

    const tabs = el("div", { class: "tabs", role: "tablist" });
    const defs: { id: Tab; label: string }[] = [
      { id: "news", label: `뉴스${this.news ? ` (${this.news.length})` : ""}` },
      { id: "reco", label: `추천${this.reco?.items.length ? ` (${this.reco.items.length})` : ""}` },
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
    if (item.orderable && item.kis) {
      const buy = el("button", { class: "btn btn-buy", type: "button", text: "매수 주문 담기" });
      buy.addEventListener("click", () => this.intendOrder(item, "buy"));
      const sell = el("button", { class: "btn btn-sell", type: "button", text: "매도 주문 담기" });
      sell.addEventListener("click", () => this.intendOrder(item, "sell"));
      actions.append(buy, sell);
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
    ]);
    wrap.append(status);

    if (!kis.configured) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "서버에 KIS_APP_KEY / KIS_APP_SECRET / KIS_ACCOUNT 시크릿이 없습니다. README의 배포 절차대로 등록하면 주문 탭이 활성화됩니다.",
        }),
      );
      return wrap;
    }
    if (!kis.ordersEnabled) {
      wrap.append(
        el("div", {
          class: "order-warn",
          text: "주문 전송이 꺼져 있습니다(ORDER_ENABLED=false). 시세·잔고 조회는 가능하지만 주문은 서버에서 거부됩니다.",
        }),
      );
    }

    const candidates = (this.reco?.items ?? []).filter((i) => i.orderable && i.kis);
    if (!candidates.length && !this.orderDraft) {
      wrap.append(el("p", { class: "note", text: "이 국가에는 한국투자증권으로 주문 가능한 등록 종목이 없습니다. 한국·미국·일본·홍콩·중국 시장을 선택해 보세요." }));
      wrap.append(this.renderBalanceBlock("KRX", "KRW"));
      return wrap;
    }

    const draft: OrderIntent =
      this.orderDraft ??
      (() => {
        const c = candidates[0];
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

    const form = el("form", { class: "order-form" });

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
    wrap.append(this.renderBalanceBlock(draft.market, draft.currency));
    wrap.append(
      el("p", {
        class: "note",
        text: "모의투자(KIS_ENV=vts)에서 먼저 체결을 확인하세요. 실전 전환은 서버 환경변수 2개(KIS_ENV=prod, ORDER_ALLOW_REAL=true)를 모두 바꿔야 합니다.",
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
