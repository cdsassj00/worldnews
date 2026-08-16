/**
 * 수급분석 탭 — 자금흐름(MFI)·매집(CLV)·거래대금 급증 등 수급 신호의 종목 순위.
 *
 * 데이터는 퀀트 스캔(/api/quant/rank)을 그대로 쓴다 — 전략실 2호(수급·차트)가
 * 매매에 쓰는 바로 그 점수라서, "보여주는 숫자"와 "매매하는 숫자"가 같다.
 * 프로파일 탭으로 수급 종합 / 돌파(리그 엔진) / 차트 추세를 전환한다.
 */
import { api, type QuantRank, type QuantRow } from "./api";
import { dirClass, el, fmtNum, fmtPct, timeAgo } from "./format";

const PROFILES = [
  { id: "flow", nameKo: "수급 종합", descKo: "자금흐름·매집·거래대금에 무게 — 큰손이 사는 흔적 순" },
  { id: "breakout", nameKo: "돌파 (리그 2호 엔진)", descKo: "수급 + 신고가 돌파 — 전략실 2호가 실제 매매에 쓰는 점수" },
  { id: "chart", nameKo: "차트 추세", descKo: "이평 정렬·모멘텀·상대강도에 무게 — 추세의 힘 순" },
];

/** 축 미니 막대 — -1~1 점수를 좌우 막대로 */
function axisBar(label: string, v: number): HTMLElement {
  const pct = Math.min(100, Math.abs(v) * 100);
  return el("span", { class: "flow-axis", title: `${label} ${v >= 0 ? "+" : ""}${v.toFixed(2)}` }, [
    el("span", { class: "flow-axis-label", text: label }),
    el("span", { class: "flow-axis-track" }, [
      el("span", { class: `flow-axis-fill ${v >= 0 ? "up" : "down"}`, style: `width:${pct.toFixed(0)}%` }),
    ]),
  ]);
}

export class FlowPanel {
  private readonly root: HTMLElement;
  private readonly profileTabs: HTMLElement;
  private profile = "flow";
  private loadedProfile: string | null = null;
  private readonly onPick: (symbol: string, name: string) => void;

  constructor(opts: { root: HTMLElement; profileTabs: HTMLElement; onPick: (symbol: string, name: string) => void }) {
    this.root = opts.root;
    this.profileTabs = opts.profileTabs;
    this.onPick = opts.onPick;
    this.renderTabs();
  }

  private renderTabs(): void {
    this.profileTabs.replaceChildren(
      ...PROFILES.map((p) => {
        const b = el("button", {
          type: "button",
          class: `radar-tab${p.id === this.profile ? " active" : ""}`,
          text: p.nameKo,
          role: "tab",
          title: p.descKo,
        });
        b.addEventListener("click", () => {
          this.profile = p.id;
          this.loadedProfile = null;
          this.renderTabs();
          void this.load();
        });
        return b;
      }),
    );
  }

  /** 탭이 열릴 때 호출 — 같은 프로파일이면 다시 안 불러온다 */
  async load(): Promise<void> {
    if (this.loadedProfile === this.profile) return;
    try {
      const data = await api.quantRank(this.profile, 20);
      this.loadedProfile = this.profile;
      this.render(data);
    } catch (err) {
      this.root.replaceChildren(el("p", { class: "note err", text: `수급 순위를 불러오지 못했습니다 — ${(err as Error).message}` }));
    }
  }

  private render(data: QuantRank): void {
    const prof = PROFILES.find((p) => p.id === data.profile.id);
    const head = el("p", { class: "note flow-meta", text:
      `${prof?.descKo ?? data.profile.nameKo} · ${data.scanned}/${data.universe}종목 스캔 · 갱신 ${timeAgo(data.updatedAt)} · 점수는 -1(강한 이탈) ~ +1(강한 유입)` });

    const table = el("div", { class: "flow-table" });
    table.append(el("div", { class: "flow-row flow-th" }, [
      el("span", { text: "#" }),
      el("span", { text: "종목" }),
      el("span", { text: "현재가" }),
      el("span", { text: "등락" }),
      el("span", { text: "점수" }),
      el("span", { text: "수급 구성" }),
      el("span", { text: "왜 이 순위인가" }),
    ]));
    data.rows.forEach((r: QuantRow, i: number) => {
      const row = el("button", { type: "button", class: "flow-row" }, [
        el("span", { class: "flow-rank", text: String(i + 1) }),
        el("span", { class: "flow-name" }, [
          el("b", { text: r.name }),
          el("i", { text: r.sector || "" }),
        ]),
        el("span", { text: `${fmtNum(r.price, 0)}원` }),
        el("span", { class: dirClass(r.changePct), text: fmtPct(r.changePct) }),
        el("span", { class: `flow-score ${r.score >= 0 ? "up" : "down"}`, text: r.score.toFixed(2) }),
        el("span", { class: "flow-axes" }, [
          axisBar("자금", r.parts.moneyFlow),
          axisBar("매집", r.parts.accum),
          axisBar("대금", r.parts.surge),
          axisBar("추세", r.parts.trend),
        ]),
        el("span", { class: "flow-reason", text: r.reasons[0]?.text ?? "—" }),
      ]);
      row.addEventListener("click", () => this.onPick(r.symbol, r.name));
      table.append(row);
    });

    this.root.replaceChildren(head, table,
      el("p", { class: "note", text: "특정 종목의 매수·매도 권유가 아닙니다. 수급 점수는 가격·거래대금 기반 추정이며 실제 투자자별 매매 동향과 다를 수 있습니다." }));
  }
}
