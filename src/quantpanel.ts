/**
 * 퀀트 트랙 카드 — 수급·차트만 보는 두 번째 엔진의 화면.
 *
 * 온톨로지 트랙과 나란히 놓고 **어느 쪽이 실제로 맞는지** 보기 위한 섹션이다.
 * 실주문이 없는 모의매매라는 점을 화면에서 숨기지 않는다 — 숫자를 실계좌 수익으로
 * 오해하면 그게 제일 큰 손해다.
 */
import { api, type QuantRank, type QuantRow, type QuantStatus } from "./api";
import { dirClass, el, fmtKrw, fmtKst, fmtPct, timeAgo } from "./format";

export class QuantPanel {
  private readonly root: HTMLElement;
  private readonly sub: HTMLElement;
  private profileId = "";
  private status: QuantStatus | null = null;
  private rank: QuantRank | null = null;
  private tab: "rank" | "book" = "rank";

  constructor(opts: { root: HTMLElement; sub: HTMLElement }) {
    this.root = opts.root;
    this.sub = opts.sub;
  }

  async load(): Promise<void> {
    try {
      const [status, rank] = await Promise.all([
        api.quantStatus(),
        api.quantRank(this.profileId || undefined, 12),
      ]);
      this.status = status;
      this.rank = rank;
      if (!this.profileId) this.profileId = rank.profile.id;
      this.render();
    } catch (err) {
      this.root.replaceChildren(el("p", { class: "note", text: `퀀트 트랙을 불러오지 못했습니다 — ${(err as Error).message}` }));
    }
  }

  private render(): void {
    const s = this.status;
    const r = this.rank;
    if (!s || !r) return;

    this.sub.textContent =
      `거시·뉴스를 안 보고 수급(자금흐름·매집·거래대금)과 차트(추세·모멘텀·상대강도)만으로 판단합니다. ` +
      `코스피200 ${s.universe}종목 중 ${s.scanned}종목 반영 · ${s.scanUpdatedAt ? timeAgo(s.scanUpdatedAt) : "스캔 대기"}`;

    const nodes: HTMLElement[] = [];

    /* 모의매매라는 사실을 맨 위에 못박는다 */
    nodes.push(
      el("p", { class: "quant-warn" }, [
        el("strong", { text: "모의매매(페이퍼)" }),
        " — 실제 주문은 나가지 않습니다. 백테스트에서 온톨로지 트랙에 3·6·12개월 모두 뒤져 실계좌를 붙이지 않았고, 대신 같은 규칙을 실시간으로 돌려 성적을 쌓는 중입니다.",
      ]),
    );

    /* 성적 */
    const sign = s.pnlKrw >= 0 ? "+" : "";
    nodes.push(
      el("div", { class: "quant-stats" }, [
        stat("모의 원금", fmtKrw(s.capital)),
        stat("평가금액", fmtKrw(s.equity)),
        stat("현금", fmtKrw(s.cash)),
        stat("손익", `${sign}${fmtKrw(s.pnlKrw)} (${fmtPct(s.pnlPct)})`, dirClass(s.pnlKrw)),
      ]),
    );
    nodes.push(
      el("p", { class: "note quant-rules" }, [
        `${s.profile.nameKo} · 매수 ${s.rules.buyScore} 이상 · 손절 -${s.rules.stopPct}% · 익절 +${s.rules.takePct}% · ` +
        `코스피 ${s.rules.marketMaDays}일선 아래면 신규 매수 정지 · 최대 ${s.rules.maxPositions}종목` +
        (s.tradeStats.total ? ` · 매도 ${s.tradeStats.total}건 승률 ${s.tradeStats.winRate}%` : ""),
      ]),
    );
    if (s.lastNote) {
      nodes.push(el("p", { class: "note", text: `직전 판단: ${s.lastNote}${s.lastCycleAt ? ` (${fmtKst(s.lastCycleAt)})` : ""}` }));
    }
    if (s.haltedPermanent) {
      nodes.push(el("p", { class: "quant-warn", text: `영구 정지 — ${s.haltReason}` }));
    }

    /* 탭 */
    const tabs = el("div", { class: "radar-tabs" });
    for (const [id, label] of [["rank", "후보 순위"], ["book", "모의 보유·체결"]] as const) {
      const b = el("button", { type: "button", class: `radar-tab${this.tab === id ? " active" : ""}`, text: label });
      b.addEventListener("click", () => { this.tab = id; this.render(); });
      tabs.append(b);
    }
    nodes.push(tabs);

    if (this.tab === "rank") {
      const sel = el("div", { class: "radar-tabs quant-profiles" });
      for (const p of r.profiles) {
        const b = el("button", { type: "button", class: `radar-tab${p.id === r.profile.id ? " active" : ""}`, text: p.nameKo });
        b.addEventListener("click", () => { this.profileId = p.id; void this.load(); });
        sel.append(b);
      }
      nodes.push(sel);
      nodes.push(this.rankList(r.rows));
    } else {
      nodes.push(this.book());
    }

    this.root.replaceChildren(...nodes);
  }

  private rankList(rows: QuantRow[]): HTMLElement {
    if (!rows.length) return el("p", { class: "note", text: "아직 스캔된 종목이 없습니다. 크론이 한 바퀴 돌면 채워집니다." });
    const ul = el("ul", { class: "hot-list" });
    for (const row of rows) {
      ul.append(
        el("li", { class: "hot-row" }, [
          el("div", { class: "hot-main" }, [
            el("span", { class: "hot-name", text: row.name }),
            el("span", { class: "hot-sub", text: `${row.sector || "미분류"} · 점수 ${row.score.toFixed(2)}` }),
          ]),
          el("div", { class: "hot-side" }, [
            el("span", { class: `hot-price ${dirClass(row.changePct)}`, text: `${fmtKrw(row.price)} ${fmtPct(row.changePct)}` }),
            el("span", { class: "hot-sub", text: `MFI ${row.raw.mfi} · 매집 ${row.raw.accum} · 대금 ${row.raw.surge}배 · 상대 ${row.raw.rs20 >= 0 ? "+" : ""}${row.raw.rs20}%p` }),
          ]),
        ]),
      );
    }
    return ul;
  }

  private book(): HTMLElement {
    const s = this.status!;
    const box = el("div", {});
    if (!s.positions.length) box.append(el("p", { class: "note", text: "모의 보유 없음." }));
    else {
      const ul = el("ul", { class: "hot-list" });
      for (const p of s.positions) {
        ul.append(
          el("li", { class: "hot-row" }, [
            el("div", { class: "hot-main" }, [
              el("span", { class: "hot-name", text: p.name }),
              el("span", { class: "hot-sub", text: `${p.qty}주 · 평단 ${fmtKrw(Math.round(p.avgPrice))}` }),
            ]),
            el("div", { class: "hot-side" }, [
              el("span", { class: `hot-price ${dirClass(p.pnl)}`, text: `${p.pnl >= 0 ? "+" : ""}${fmtKrw(p.pnl)}` }),
              el("span", { class: `hot-sub ${dirClass(p.pnl)}`, text: fmtPct(p.pnlPct) }),
            ]),
          ]),
        );
      }
      box.append(ul);
    }

    box.append(el("h3", { class: "quant-h3", text: "최근 모의 체결" }));
    if (!s.trades.length) box.append(el("p", { class: "note", text: "아직 체결 없음." }));
    else {
      const ul = el("ul", { class: "hot-list" });
      for (const t of s.trades.slice(0, 12)) {
        ul.append(
          el("li", { class: "hot-row" }, [
            el("div", { class: "hot-main" }, [
              el("span", { class: "hot-name", text: `${t.side === "BUY" ? "매수" : "매도"} ${t.name}` }),
              el("span", { class: "hot-sub", text: `${t.qty}주 @ ${fmtKrw(t.price)} · ${t.reason}` }),
            ]),
            el("div", { class: "hot-side" }, [
              t.pnl === undefined
                ? el("span", { class: "hot-sub", text: fmtKst(t.at) })
                : el("span", { class: `hot-price ${dirClass(t.pnl)}`, text: `${t.pnl >= 0 ? "+" : ""}${fmtKrw(t.pnl)}` }),
              el("span", { class: "hot-sub", text: timeAgo(t.at) }),
            ]),
          ]),
        );
      }
      box.append(ul);
    }
    return box;
  }
}

function stat(label: string, value: string, cls = ""): HTMLElement {
  return el("div", { class: "quant-stat" }, [
    el("span", { class: "quant-stat-label", text: label }),
    el("span", { class: `quant-stat-value ${cls}`, text: value }),
  ]);
}
