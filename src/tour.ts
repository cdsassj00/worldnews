/**
 * 온보딩 투어 — 첫 방문자에게 사이트 구조를 스포트라이트로 안내한다.
 *
 * 라이브러리 없이 구현: 어두운 덮개 + 대상 요소 자리만 밝게 뚫는 스포트라이트
 * (거대한 box-shadow 트릭) + 설명 카드. 단계를 넘길 때 대상을 화면 중앙으로
 * 스크롤한다. 한 번 끝내면 localStorage 에 기록해 다시 자동 실행하지 않고,
 * 상단 "사용법" 버튼으로 언제든 다시 볼 수 있다.
 */
import { el } from "./format";

interface TourStep { sel: string; title: string; body: string }

const DONE_KEY = "wfg-tour-done";

const STEPS: TourStep[] = [
  {
    sel: "#picks .nv-head",
    title: "① 오늘의 추천",
    body: "단타·스윙·중기·장기 탭마다 지금 살 종목과 목표가·손절가를 표로 보여줍니다. 행을 누르면 거시·수급·차트 근거가 펼쳐집니다.",
  },
  {
    sel: ".gnb-search",
    title: "② 종목 검색",
    body: "어느 화면에서든 종목명·코드·미국 티커를 치면 그 종목의 차트 분석(전략 13종 판정·지지·저항·매매 플랜)으로 바로 갑니다.",
  },
  {
    sel: "#gnb-nav",
    title: "③ 분석 화면",
    body: "온톨로지(거시 인과) · 수급(자금흐름 순위) · 차트(전략 13종) · 종합(세 분석을 섞은 순위) · 전략실(전략별 성적)을 탭으로 오갑니다.",
  },
  {
    sel: "#lang-switch",
    title: "실시간 번역",
    body: "EN·日本語·中文을 누르면 새로고침 없이 사이트 전체가 그 언어로 바뀝니다.",
  },
];

export class Tour {
  private idx = 0;
  private dim: HTMLElement | null = null;
  private spot: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private readonly onRelayout = () => this.position();

  get running(): boolean { return this.dim !== null; }

  static seen(): boolean {
    try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return true; }
  }

  start(): void {
    if (this.running) return;
    this.idx = 0;
    this.dim = el("div", { class: "tour-dim" });
    this.spot = el("div", { class: "tour-spot" });
    this.card = el("div", { class: "tour-card", role: "dialog", "aria-live": "polite" });
    document.body.append(this.dim, this.spot, this.card);
    window.addEventListener("resize", this.onRelayout);
    window.addEventListener("scroll", this.onRelayout, { passive: true });
    this.show();
  }

  private finish(): void {
    try { localStorage.setItem(DONE_KEY, "1"); } catch { /* 무시 */ }
    this.dim?.remove(); this.spot?.remove(); this.card?.remove();
    this.dim = this.spot = this.card = null;
    window.removeEventListener("resize", this.onRelayout);
    window.removeEventListener("scroll", this.onRelayout);
  }

  private target(): Element | null {
    // 화면에 없는 대상(반응형으로 숨김 등)은 건너뛴다
    for (; this.idx < STEPS.length; this.idx++) {
      const t = document.querySelector(STEPS[this.idx].sel);
      if (t && (t as HTMLElement).offsetParent !== null) return t;
    }
    return null;
  }

  private show(): void {
    const t = this.target();
    if (!t || !this.card) { this.finish(); return; }
    const step = STEPS[this.idx];
    t.scrollIntoView({ behavior: "smooth", block: "center" });

    this.card.replaceChildren(
      el("p", { class: "tour-step", text: `${this.idx + 1} / ${STEPS.length}` }),
      el("h3", { text: step.title }),
      el("p", { class: "tour-body", text: step.body }),
      el("div", { class: "tour-nav" }, [
        el("button", { class: "btn btn-ghost", type: "button", text: "건너뛰기" }),
        el("span", { class: "spacer" }),
        ...(this.idx > 0 ? [el("button", { class: "btn btn-ghost", type: "button", text: "이전" })] : []),
        el("button", { class: "btn btn-primary", type: "button", text: this.idx === STEPS.length - 1 ? "시작하기" : "다음" }),
      ]),
    );
    const btns = this.card.querySelectorAll("button");
    btns[0].addEventListener("click", () => this.finish());
    if (this.idx > 0) btns[1].addEventListener("click", () => { this.idx--; this.show(); });
    btns[btns.length - 1].addEventListener("click", () => {
      if (this.idx >= STEPS.length - 1) this.finish();
      else { this.idx++; this.show(); }
    });

    // 스크롤 애니메이션이 끝난 뒤 위치를 잡는다 (두 번 재계산으로 안착)
    window.setTimeout(() => this.position(), 380);
    window.setTimeout(() => this.position(), 800);
  }

  private position(): void {
    if (!this.spot || !this.card) return;
    const t = document.querySelector(STEPS[this.idx]?.sel ?? "");
    if (!t) return;
    const r = t.getBoundingClientRect();
    const pad = 8;
    Object.assign(this.spot.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
    // 카드 — 대상 아래 공간이 부족하면 위로
    const cw = Math.min(360, window.innerWidth - 24);
    const ch = this.card.offsetHeight || 180;
    let top = r.bottom + 14;
    if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
    let left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12));
    Object.assign(this.card.style, { top: `${top}px`, left: `${left}px`, width: `${cw}px` });
  }
}
