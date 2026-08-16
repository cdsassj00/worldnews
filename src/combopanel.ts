/**
 * 조합 전략 탭 — 세 분석(온톨로지·수급·차트)을 원하는 비율로 섞으면
 * "지금 시점" 어떤 종목이 유리한지 보여주는 공개 추천 화면.
 *
 * 백테스트(과거 성적)는 전략실이 담당하고 여기는 현재 순위만 담당한다 —
 * 2026-08-16 사용자 지시: 백스테이징과 추천 종목은 분리한다. 다만 각 조합
 * 카드에는 그 조합의 백테스트 성적을 신용 표시로 붙인다(측정된 조합만).
 *
 * 점수 축은 실계좌 엔진과 같은 값이다(온톨로지=레이더, 수급=돌파, 차트=13종 합의).
 * 실계좌에 이 조합을 적용하는 버튼은 여기 두지 않는다 — 그건 운영자 전용
 * 자동매매 화면(우측 상단)의 일이다.
 */
import { api, type BacktestResults, type ComboRank, type EngineWeights } from "./api";
import { dirClass, el, fmtNum, fmtPct, timeAgo } from "./format";

interface Preset { id: string; nameKo: string; w: EngineWeights; descKo: string }

/** 세 분석의 모든 조합 7가지 — 서버 AUTO_ENGINES 와 같은 id 를 쓴다(백테스트 표와 연결) */
const PRESETS: Preset[] = [
  { id: "onto", nameKo: "온톨로지", w: { onto: 100, flow: 0, chart: 0 }, descKo: "환율·금리·유가 같은 거시 신호가 업종을 거쳐 종목으로 전파되는 인과만 봅니다." },
  { id: "quant", nameKo: "수급", w: { onto: 0, flow: 100, chart: 0 }, descKo: "자금흐름·매집·거래대금·돌파 — 돈이 들어오는 흔적만 봅니다." },
  { id: "ta", nameKo: "차트", w: { onto: 0, flow: 0, chart: 100 }, descKo: "창시자가 있는 차트 전략 13종의 합의만 봅니다." },
  { id: "hybrid", nameKo: "온톨로지+수급", w: { onto: 50, flow: 50, chart: 0 }, descKo: "거시 인과와 수급을 반반 — 거시가 미는 업종에서 돈이 들어오는 종목." },
  { id: "onto_ta", nameKo: "온톨로지+차트", w: { onto: 50, flow: 0, chart: 50 }, descKo: "거시 인과와 차트 합의를 반반 — 거시 순풍 + 차트 신호가 겹치는 종목." },
  { id: "quant_ta", nameKo: "수급+차트", w: { onto: 0, flow: 50, chart: 50 }, descKo: "수급과 차트를 반반 — 돈이 들어오면서 차트 모양도 좋은 종목." },
  { id: "all3", nameKo: "삼합", w: { onto: 34, flow: 33, chart: 33 }, descKo: "세 분석을 같은 무게로 — 셋 다 좋다고 할 때만 위로 올라옵니다." },
];

function sameW(a: EngineWeights, b: EngineWeights): boolean {
  return a.onto === b.onto && a.flow === b.flow && a.chart === b.chart;
}

/**
 * 측정 방법·한계 공개 박스 — "이 숫자는 어떻게 계산했고 왜 그대로 믿으면 안 되는가".
 * 백테스트 숫자를 전면에 내세우는 화면이므로, 근거와 한계를 같은 화면에서
 * 읽을 수 있어야 한다(2026-08-16 사용자 지시: 정확한 시뮬레이션 근거).
 */
export function methodologyBox(): HTMLElement {
  const li = (t: string) => el("li", { text: t });
  return el("details", { class: "method-box" }, [
    el("summary", { text: "이 숫자는 어떻게 계산했나 — 백테스트 방법과 한계 (누르면 펼침)" }),
    el("p", { class: "note", text: "백테스트 = \"그날 그 규칙대로 그 종목을 샀다면\"을 하루 단위로 재현한 모의 실험입니다. 평가 구간의 매 거래일마다:" }),
    el("ol", { class: "method-list" }, [
      li("그날까지의 시세만으로 350종목의 온톨로지·수급·차트 점수를 계산합니다 (미래 데이터 차단 — 조합이면 그 시점 점수의 가중 평균)."),
      li("점수 순위로 후보를 정하고, 다음 거래일 시가 + 슬리피지 0.3%에 산 것으로 가정합니다 (왕복 비용 0.23% 차감)."),
      li("보유 중에는 장중 저가·고가로 손절 -6% / 익절 +15% 도달을 판정하고, 코스피가 20일선 아래면 신규 매수를 멈춥니다 — 실계좌 봇과 같은 규칙."),
      li("이걸 3·6·12개월 내내 반복해 최종 잔고를 냅니다. 재현 명령은 저장소 shared/backtest-results.json 에 있습니다."),
    ]),
    el("p", { class: "note", text: "한계 — 이 숫자를 그대로 믿으면 안 되는 이유:" }),
    el("ul", { class: "method-list" }, [
      li("생존편향: 유니버스가 \"지금 살아남은\" 종목이라 그 사이 퇴출된 종목이 빠져 성적이 부풀 수 있습니다."),
      li("수급 축은 프록시: 과거 외국인·기관 실제 순매수는 재현 불가 — 가격·거래대금의 흔적(MFI·매집·거래대금)으로 추정합니다."),
      li("온톨로지 축의 뉴스는 재현 불가 — 백테스트에서는 뉴스 축을 0으로 둡니다(라이브와 약간 다름)."),
      li("체결 가정: 다음날 시가에 전량 체결됐다고 가정 — 실제 호가·유동성과 다를 수 있습니다."),
      li("과최적화 위험: 매매 규칙 자체를 백테스트로 골랐고, 측정 창이 며칠 이동해도 숫자가 흔들립니다. 순위 비교용이지 미래 수익 예측이 아닙니다."),
    ]),
    el("p", { class: "note", text: "이 한계들 때문에 전략실 실시간 리그(미래를 모르는 상태로 매일 실제 시세로 가상 매매하는 전진 검증)를 함께 돌립니다. 백테스트는 후보를 고르는 도구, 리그는 그 검증입니다." }),
  ]);
}

export class ComboPanel {
  private readonly presetsEl: HTMLElement;
  private readonly slidersEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly onPick: (symbol: string, name: string) => void;
  private w: EngineWeights = { ...PRESETS[6].w }; // 기본 = 삼합 (조합 탭이니 조합부터)
  private bt: BacktestResults | null = null;
  private loadedKey = "";
  private timer = 0;

  constructor(opts: { presets: HTMLElement; sliders: HTMLElement; body: HTMLElement; onPick: (symbol: string, name: string) => void }) {
    this.presetsEl = opts.presets;
    this.slidersEl = opts.sliders;
    this.body = opts.body;
    this.onPick = opts.onPick;
    this.renderPresets();
    this.renderSliders();
  }

  async load(): Promise<void> {
    const key = `${this.w.onto}-${this.w.flow}-${this.w.chart}`;
    if (this.loadedKey === key) return;
    if (!this.bt) this.bt = await api.backtest().catch(() => null);
    try {
      const data = await api.comboRank(this.w, 20);
      this.loadedKey = key;
      this.renderTable(data);
    } catch (err) {
      this.body.replaceChildren(el("p", { class: "note err", text: `조합 순위를 불러오지 못했습니다 — ${(err as Error).message}` }));
    }
  }

  private setWeights(w: EngineWeights): void {
    this.w = { ...w };
    this.renderPresets();
    this.renderSliders();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.load(), 250);
  }

  private renderPresets(): void {
    this.presetsEl.replaceChildren(...PRESETS.map((p) => {
      const active = sameW(p.w, this.w);
      const year = this.btYear(p.id);
      const b = el("button", { type: "button", class: `combo-preset${active ? " active" : ""}`, role: "tab", title: p.descKo }, [
        el("b", { text: p.nameKo }),
        el("span", { class: year !== null ? `combo-preset-bt ${year >= 0 ? "up" : "down"}` : "combo-preset-bt", text: year !== null ? `1년 ${year >= 0 ? "+" : ""}${year.toFixed(1)}%` : "미측정" }),
      ]);
      b.addEventListener("click", () => this.setWeights(p.w));
      return b;
    }));
  }

  /** 이 조합의 백테스트 최근 1년(KR) — 측정된 프리셋만 숫자가 있다 */
  private btYear(id: string): number | null {
    const row = this.bt?.engineComparison.engines.find((e) => e.id === id);
    const r = row?.KR?.returns;
    return r && r.length >= 3 ? r[2] : null;
  }

  private renderSliders(): void {
    const axes: { key: keyof EngineWeights; label: string }[] = [
      { key: "onto", label: "온톨로지" },
      { key: "flow", label: "수급" },
      { key: "chart", label: "차트" },
    ];
    const rows = axes.map(({ key, label }) => {
      const input = el("input", { type: "range", min: 0, max: 100, step: 5, value: this.w[key] }) as HTMLInputElement;
      const val = el("span", { class: "combo-slider-val", text: `${this.w[key]}%` });
      input.addEventListener("input", () => {
        val.textContent = `${input.value}%`;
        this.setWeights({ ...this.w, [key]: Number(input.value) });
      });
      return el("label", { class: "combo-slider" }, [
        el("span", { class: "combo-slider-label", text: label }),
        input,
        val,
      ]);
    });
    const preset = PRESETS.find((p) => sameW(p.w, this.w));
    this.slidersEl.replaceChildren(
      ...rows,
      el("p", { class: "note combo-desc", text: preset
        ? `${preset.nameKo} — ${preset.descKo}`
        : `커스텀 조합 (온톨로지 ${this.w.onto}% · 수급 ${this.w.flow}% · 차트 ${this.w.chart}%) — 이 비율의 백테스트는 아직 측정되지 않았습니다. 프리셋 성적을 참고하세요.` }),
    );
  }

  private renderTable(data: ComboRank): void {
    const cell = (v: number | null) =>
      v === null
        ? el("span", { class: "combo-na", text: "—" })
        : el("span", { class: `combo-part ${v >= 0 ? "up" : "down"}`, text: v.toFixed(2) });

    const table = el("div", { class: "flow-table" });
    table.append(el("div", { class: "flow-row combo-row flow-th" }, [
      el("span", { text: "#" }),
      el("span", { text: "종목" }),
      el("span", { text: "현재가" }),
      el("span", { text: "등락" }),
      el("span", { text: "온톨로지" }),
      el("span", { text: "수급" }),
      el("span", { text: "차트" }),
      el("span", { text: "종합" }),
    ]));
    data.rows.forEach((r, i) => {
      const row = el("button", { type: "button", class: "flow-row combo-row" }, [
        el("span", { class: "flow-rank", text: String(i + 1) }),
        el("span", { class: "flow-name" }, [el("b", { text: r.name }), el("i", { text: r.sector || "" })]),
        el("span", { text: `${fmtNum(r.price, 0)}원` }),
        el("span", { class: dirClass(r.changePct), text: fmtPct(r.changePct) }),
        cell(r.onto),
        cell(r.flow),
        cell(r.chart),
        el("span", { class: `flow-score ${r.total >= 0 ? "up" : "down"}`, text: r.total.toFixed(2) }),
      ]);
      row.addEventListener("click", () => this.onPick(r.symbol, r.name));
      table.append(row);
    });

    this.body.replaceChildren(
      el("p", { class: "note flow-meta", text: `${data.scanned}/${data.universe}종목 스캔 · 갱신 ${timeAgo(data.updatedAt)} · 각 축 점수는 -1 ~ +1, 종합은 가중 평균 (점수 없는 축은 빼고 재정규화)` }),
      table,
      el("p", { class: "note", text: "지금 시점의 점수 순위일 뿐 특정 종목의 매수·매도 권유가 아닙니다. 조합별 과거 성적(백테스트)은 전략실과 프리셋의 1년 수치를 참고하세요." }),
      methodologyBox(),
    );
  }
}
