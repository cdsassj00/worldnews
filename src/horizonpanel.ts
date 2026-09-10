/**
 * 종목 추천 탭 — 단타 / 스윙 / 장기.
 *
 * 다른 탭이 "무엇을 분석했나"라면 이 탭은 **"그래서 뭘 언제 사고 언제 파느냐"** 다.
 * 사이트가 답해야 할 질문이 그거였는데 지금까지 화면 어디에도 없었다.
 *
 * 화면에 반드시 남겨야 하는 것 넷 — 하나라도 빠지면 "그래서 뭘 어쩌라고"가 된다:
 *   ① 매수 시점 (다음 거래일 시가 — 백테스트가 검증한 체결 시점)
 *   ② 청산 규칙 (익절·손절·보유) 과 그 규칙의 **측정 성적**
 *   ③ 종목마다 세 관점 근거 (거시·수급·차트)
 *   ④ 손절·목표 절대 가격
 *
 * 성적은 좋든 나쁘든 그대로 쓴다. 한국 단타·스윙은 코스피 매수 후 보유에 크게 진다 —
 * 그걸 숨기면 화면이 광고가 된다.
 */
import { api, type HorizonBucket, type HorizonPick, type HorizonsBlock } from "./api";
import { dirClass, el } from "./format";

const ICON: Record<string, string> = { day: "⚡", swing: "🌀", long: "🌳" };

export class HorizonPanel {
  private readonly root: HTMLElement;
  private readonly tabs: HTMLElement;
  private market: "KR" | "US" = "KR";
  private loading = false;
  private loaded: Record<string, boolean> = {};

  constructor(opts: { root: HTMLElement; tabs: HTMLElement }) {
    this.root = opts.root;
    this.tabs = opts.tabs;
    this.tabs.querySelectorAll<HTMLButtonElement>(".hz-mk").forEach((b) => {
      b.addEventListener("click", () => {
        const m = b.dataset.market === "US" ? "US" : "KR";
        if (m === this.market) return;
        this.market = m;
        this.tabs.querySelectorAll(".hz-mk").forEach((x) => x.classList.toggle("active", x === b));
        this.loaded = {};
        void this.load();
      });
    });
  }

  async load(): Promise<void> {
    if (this.loading || this.loaded[this.market]) return;
    this.loading = true;
    this.root.replaceChildren(el("p", { class: "note", text: "구간별 추천을 계산하는 중…" }));
    try {
      const res = await api.horizons(this.market);
      const b = res.briefs[0];
      const hz = b?.horizons ?? null;
      if (!hz?.buckets.length) {
        this.root.replaceChildren(el("p", { class: "note", text: "아직 구간별 추천을 만들지 못했습니다. 스캔이 한 바퀴 돈 뒤 다시 시도해 주세요." }));
        return;
      }
      this.render(hz, b.targetSession, b.sessionClosed, b.regime.label);
      this.loaded[this.market] = true;
    } catch {
      this.root.replaceChildren(el("p", { class: "note", text: "추천을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
    } finally {
      this.loading = false;
    }
  }

  private render(hz: HorizonsBlock, targetSession: string, sessionClosed: boolean, regimeKo: string): void {
    const head = el("div", { class: "hz-head" }, [
      el("p", { class: "hz-entry" }, [
        el("b", { text: "매수 시점 — " }),
        el("span", { text: `${targetSession} 시가` }),
        el("span", { class: "hz-basis", text: sessionClosed ? " · 마감 데이터 기준" : " · 장중 데이터 — 마감 뒤 숫자가 바뀝니다" }),
      ]),
      el("p", { class: "card-sub", text: hz.noteKo }),
      el("p", { class: "card-sub", text: `국면: ${regimeKo}` }),
    ]);

    const grid = el("div", { class: "hz-grid" }, hz.buckets.map((k) => this.bucketCard(k)));

    const caveats = hz.caveats.length
      ? el("details", { class: "method-box" }, [
        el("summary", { text: "이 규칙들을 그대로 믿으면 안 되는 이유 (누르면 펼침)" }),
        el("ul", { class: "method-list" }, hz.caveats.map((c) => el("li", { text: c }))),
        el("p", { class: "note", text: hz.measuredAt ? `측정일 ${hz.measuredAt}. 재현 명령은 저장소 shared/backtest-results.json 에 있습니다.` : "" }),
      ])
      : null;

    this.root.replaceChildren(...[
      head,
      grid,
      caveats,
      el("p", { class: "note", text: hz.disclaimerKo }),
    ].filter(Boolean) as HTMLElement[]);
  }

  private bucketCard(k: HorizonBucket): HTMLElement {
    const t = k.track;
    const li = t ? t.windows.length - 1 : 0;
    const ret = t ? t.returns[li] : null;
    const gap = t ? Math.round((t.returns[li] - t.benchmarkReturns[li]) * 10) / 10 : null;

    const trackBox = t
      ? el("div", { class: "hz-track" }, [
        el("div", { class: "hz-track-top" }, [
          el("b", { class: dirClass(ret ?? 0), text: `${(ret ?? 0) >= 0 ? "+" : ""}${ret}%` }),
          el("span", { class: "hz-track-lbl", text: "1년 백테스트" }),
        ]),
        el("div", {
          class: `hz-gap ${(gap ?? 0) >= 0 ? "up" : "down"}`,
          text: (gap ?? 0) >= 0 ? `${t.benchmarkKo} 대비 +${gap}%p` : `${t.benchmarkKo} 대비 ${gap}%p`,
        }),
        el("div", { class: "hz-track-sub", text: `${t.trades[li]}건 · 승률 ${t.winRate[li]}% · 최대낙폭 −${t.maxDd[li]}% · 평균 보유 ${t.holdDaysAvg[li]}일` }),
      ])
      : el("p", { class: "note", text: "이 구간은 아직 백테스트 기록이 없습니다." });

    return el("section", { class: `hz-card hz-${k.id}` }, [
      el("header", { class: "hz-card-head" }, [
        el("h3", {}, [el("span", { class: "hz-icon", text: ICON[k.id] ?? "•" }), el("span", { text: k.nameKo })]),
        el("p", { class: "hz-hold", text: k.holdKo }),
        el("p", { class: "hz-rule", text: k.ruleKo }),
      ]),
      trackBox,
      el("div", { class: "hz-picks" }, k.picks.length
        ? k.picks.map((p) => this.pickRow(p))
        : [el("p", { class: "note", text: "이 구간에서 문턱을 넘은 종목이 없습니다." })]),
      el("details", { class: "hz-more" }, [
        el("summary", { text: "정렬 기준과 주의사항" }),
        el("p", { class: "note", text: k.orderKo }),
        el("p", { class: "note", text: `⚠ ${k.cautionKo}` }),
      ]),
    ]);
  }

  private pickRow(p: HorizonPick): HTMLElement {
    const pl = p.plan;
    const target = pl.target !== null
      ? `목표 ${pl.target.toLocaleString("ko-KR")} (${(pl.targetPct ?? 0) >= 0 ? "+" : ""}${pl.targetPct}%)`
      : "목표 없음 — 고점 대비 −25% 추적";

    const why = [
      p.why.ontologyKo ? { k: "거시", v: p.why.ontologyKo } : null,
      p.why.flowKo ? { k: "수급", v: p.why.flowKo } : null,
      p.why.chartKo ? { k: "차트", v: p.why.chartKo } : null,
    ].filter(Boolean) as { k: string; v: string }[];

    return el("article", { class: "hz-pick" }, [
      el("div", { class: "hz-pick-top" }, [
        el("b", { class: "hz-name", text: p.name }),
        el("span", { class: "hz-price", text: p.priceLabel }),
        el("span", { class: `hz-chg ${dirClass(p.changePct)}`, text: `${p.changePct >= 0 ? "+" : ""}${p.changePct.toFixed(1)}%` }),
      ]),
      el("div", { class: "hz-sector", text: `${p.sector ?? "미분류"} · 삼합 ${p.combo.total.toFixed(2)}` }),
      el("div", { class: "hz-plan" }, [
        el("span", { class: "hz-target", text: target }),
        el("span", { class: "hz-stop", text: `손절 ${pl.stop.toLocaleString("ko-KR")} (${pl.stopPct}%)` }),
        ...(pl.rr !== null ? [el("span", { class: "hz-rr", text: `손익비 ${pl.rr}` })] : []),
      ]),
      ...(pl.levelNoteKo ? [el("p", { class: "hz-levels", text: pl.levelNoteKo })] : []),
      el("ul", { class: "hz-why" }, why.map((w) => el("li", {}, [
        el("span", { class: "hz-why-k", text: w.k }),
        el("span", { text: w.v }),
      ]))),
    ]);
  }
}
