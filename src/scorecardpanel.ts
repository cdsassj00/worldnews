/**
 * 성적표 탭 — "사이트가 추천한 종목을 추천대로 샀다면?" (worker/scorecard.ts)
 *
 * 전략실(과거 시세로 규칙을 흉내 낸 백테스트)을 대신한다. 사용자 지시: "니가 추천한
 * 종목을 샀을 때 그걸 백테스팅 해야지". 여기 숫자는 전부 **실제로 나갔던 추천**의
 * 결과이고, 실제 주문은 나가지 않는다(그림자 운용 B안).
 */
import { api, type ScTrade, type ScorecardView } from "./api";
import { el } from "./format";

type Mk = "KR" | "US";
const pct = (v: number | null, d = 2) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const dir = (v: number | null) => (v === null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const BK: Record<string, string> = { day: "단타", swing: "스윙", mid: "중기", long: "장기" };

export class ScorecardPanel {
  private readonly root: HTMLElement;
  private market: Mk = "KR";
  private cache: Partial<Record<Mk, ScorecardView>> = {};
  private loading = false;

  constructor(opts: { root: HTMLElement }) {
    this.root = opts.root;
  }

  async load(): Promise<void> {
    const hit = this.cache[this.market];
    if (hit) { this.render(hit); return; }
    if (this.loading) return;
    this.loading = true;
    this.root.replaceChildren(el("p", { class: "nv-empty", text: "성적표를 불러오는 중…" }));
    try {
      const v = await api.scorecard(this.market);
      this.cache[this.market] = v;
      this.render(v);
    } catch {
      this.root.replaceChildren(el("p", { class: "nv-empty", text: "성적표를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
    } finally {
      this.loading = false;
    }
  }

  private render(v: ScorecardView): void {
    const mkTabs = el("div", { class: "radar-tabs", role: "tablist" }, (["KR", "US"] as Mk[]).map((m) => {
      const b = el("button", { type: "button", class: `radar-tab${m === this.market ? " active" : ""}`, text: m === "KR" ? "국내" : "미국" });
      b.addEventListener("click", () => { if (m !== this.market) { this.market = m; void this.load(); } });
      return b;
    }));

    const t = v.total;
    const tiles = el("div", { class: "sc-tiles" }, [
      this.tile("끝난 거래", `${t.closed}건`, t.closed ? `익절 ${t.tp} · 손절 ${t.sl}${t.time ? ` · 시간청산 ${t.time}` : ""}` : "아직 없음"),
      this.tile("끝난 거래 평균", pct(t.avgClosed), t.winRateClosed !== null ? `승률 ${(t.winRateClosed * 100).toFixed(0)}%` : "", dir(t.avgClosed)),
      this.tile("보유 중 포함 평균", pct(t.avgAll), `보유 ${t.open}건 · 매수 대기 ${t.waiting}건`, dir(t.avgAll)),
      this.tile(`같은 기간 ${v.market === "KR" ? "코스피" : "S&P500"}`, pct(t.idxAvgAll), t.avgAll !== null && t.idxAvgAll !== null ? `지수 대비 ${pct(t.avgAll - t.idxAvgAll)}` : "", dir(t.idxAvgAll)),
    ]);

    const head = el("tr", {}, ["구간", "끝난 거래", "평균", "승률", "익절", "손절", "시간청산", "보유 중", "보유 포함 평균", "같은 기간 지수"]
      .map((h, i) => el("th", { class: i ? "r" : "", text: h })));
    const rows = v.buckets.map((b) => el("tr", {}, [
      el("td", { class: "nv-name" }, [el("b", { text: b.nameKo })]),
      el("td", { class: "r num", text: `${b.closed}` }),
      el("td", { class: `r num ${dir(b.avgClosed)}`, text: pct(b.avgClosed) }),
      el("td", { class: "r num", text: b.winRateClosed !== null ? `${(b.winRateClosed * 100).toFixed(0)}%` : "—" }),
      el("td", { class: "r num", text: `${b.tp}` }),
      el("td", { class: "r num", text: `${b.sl}` }),
      el("td", { class: "r num", text: `${b.time}` }),
      el("td", { class: "r num", text: `${b.open}` }),
      el("td", { class: `r num ${dir(b.avgAll)}`, text: pct(b.avgAll) }),
      el("td", { class: `r num ${dir(b.idxAvgAll)}`, text: pct(b.idxAvgAll) }),
    ]));
    const bucketTable = el("div", { class: "nv-table-wrap" }, [el("table", { class: "nv-table" }, [el("thead", {}, [head]), el("tbody", {}, rows)])]);

    const tHead = el("tr", {}, ["추천일", "구간", "종목", "매수", "매도", "결과", "수익률", "같은 기간 지수"]
      .map((h, i) => el("th", { class: i >= 3 && i !== 5 ? "r" : "", text: h })));
    const tRows = v.trades.map((x) => this.tradeRow(x, v.market));
    const tradeTable = el("div", { class: "nv-table-wrap" }, [el("table", { class: "nv-table sc-trades" }, [el("thead", {}, [tHead]), el("tbody", {}, tRows)])]);

    const upd = v.updatedAt ? new Date(v.updatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    this.root.replaceChildren(
      mkTabs,
      el("p", { class: "nv-meta" }, [
        el("b", { text: v.since ? `${v.since} ~ ${v.lastRecDate} 추천` : "기록 없음" }),
        el("span", { text: ` · 갱신 ${upd} · ${v.rulesKo}` }),
      ]),
      tiles,
      el("h3", { class: "sc-h", text: "구간별" }),
      bucketTable,
      el("h3", { class: "sc-h", text: "거래 내역" }),
      tradeTable,
      el("p", { class: "nv-foot", text: "실제 주문은 나가지 않는 그림자 운용 기록입니다. 기간이 짧을수록 숫자가 크게 흔들립니다 — 건수를 먼저 보세요." }),
    );
  }

  private tile(label: string, value: string, sub: string, cls = ""): HTMLElement {
    return el("div", { class: "sc-tile" }, [
      el("span", { class: "sc-tile-k", text: label }),
      el("b", { class: `sc-tile-v ${cls}`, text: value }),
      el("span", { class: "sc-tile-s", text: sub }),
    ]);
  }

  private tradeRow(x: ScTrade, mk: Mk): HTMLElement {
    const px = (v: number | null) => (v === null ? "—" : mk === "US" ? `$${v.toFixed(2)}` : Math.round(v).toLocaleString("ko-KR"));
    const md = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "—");
    const tone = x.status === "익절" ? "up" : x.status === "손절" ? "down" : "";
    return el("tr", {}, [
      el("td", { class: "num", text: md(x.recDate) }),
      el("td", { text: BK[x.bucket] ?? x.bucket }),
      el("td", { class: "nv-name" }, [el("b", { text: x.name }), el("i", { text: x.code })]),
      el("td", { class: "r num" }, x.entryDate
        ? [el("span", { text: px(x.entryPx) }), el("i", { text: ` ${md(x.entryDate)}` })]
        : [el("i", { text: "다음 거래일 시가" })]),
      el("td", { class: "r num" }, [el("span", { text: x.exitDate ? px(x.exitPx) : x.status === "보유중" ? `(${px(x.exitPx)})` : "—" }), el("i", { text: x.exitDate ? ` ${md(x.exitDate)}` : "" })]),
      el("td", { class: `sc-status ${tone}`, text: x.status }),
      el("td", { class: `r num ${dir(x.ret)}`, text: pct(x.ret) }),
      el("td", { class: `r num ${dir(x.idxRet)}`, text: pct(x.idxRet) }),
    ]);
  }
}
