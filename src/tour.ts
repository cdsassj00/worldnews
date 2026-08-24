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

const DONE_KEY = "wfg-tour-done-v2";

const STEPS: TourStep[] = [
  {
    sel: ".brand",
    title: "WORLD FINANCE GLOBE 한눈에 보기",
    body: "이 사이트는 거시 인과로 방향을, 수급으로 힘을, 차트로 타이밍을 읽습니다. 전략 성적을 비교한 뒤 종목 분석과 자동매매 현황까지 이어서 볼 수 있습니다.",
  },
  {
    sel: "#lab-strip .lab-head",
    title: "① 전략실 — 전략 성적 비교",
    body: "온톨로지·수급차트·차트거장·융합 전략을 같은 조건에서 비교합니다. 아래 전략 카드를 누르면 최근 성적과 선택 종목을 자세히 볼 수 있습니다.",
  },
  {
    sel: "#terminal-tabs",
    title: "② 분석 터미널 — 화면 전환",
    body: "온톨로지(거시 인과 3D 그래프) · 차트분석 · 수급분석 · 조합 전략, 네 화면을 탭으로 오갑니다.",
  },
  {
    sel: '#terminal-tabs .tt-tab[data-pane="onto"]',
    title: "온톨로지",
    body: "금리·환율·유가 같은 거시 요인이 업종과 종목으로 어떻게 전파되는지 3D 인과 그래프로 확인합니다.",
  },
  {
    sel: '#terminal-tabs .tt-tab[data-pane="ta"]',
    title: "차트분석",
    body: "종목을 검색하면 창시자가 있는 차트 전략 13종이 각자 판정하고, 지지·저항 사다리·패턴·매매 플랜까지 그려줍니다.",
  },
  {
    sel: '#terminal-tabs .tt-tab[data-pane="flow"]',
    title: "수급분석",
    body: "자금흐름(MFI)·매집(CLV)·거래대금 급증 — 큰손이 사는 흔적을 점수로 만든 종목 순위입니다.",
  },
  {
    sel: '#terminal-tabs .tt-tab[data-pane="combo"]',
    title: "조합 전략",
    body: "세 분석을 원하는 비율로 섞으면 그 조합 기준으로 지금 유리한 종목을 보여줍니다. 슬라이더로 나만의 조합도 만들 수 있습니다.",
  },
  {
    sel: "#lang-switch",
    title: "실시간 번역",
    body: "EN·日本語·中文 버튼을 누르면 새로고침 없이 사이트 전체가 그 언어로 바뀝니다.",
  },
  {
    sel: "#btn-auto",
    title: "자동매매 — 운영자 전용",
    body: "실제 주문·계좌 현황은 거래 암호가 있어야 열립니다. 화면의 전략들이 지금 이 계좌에서 검증되고 있습니다.",
  },
];

export class Tour {
  private idx = 0;
  private dim: HTMLElement | null = null;
  private spot: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private readonly onRelayout = () => this.position();
  private readonly onKeydown = (event: KeyboardEvent) => { if (event.key === "Escape") this.finish(); };

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
    window.addEventListener("keydown", this.onKeydown);
    this.show();
  }

  private finish(): void {
    try { localStorage.setItem(DONE_KEY, "1"); } catch { /* 무시 */ }
    this.dim?.remove(); this.spot?.remove(); this.card?.remove();
    this.dim = this.spot = this.card = null;
    window.removeEventListener("resize", this.onRelayout);
    window.removeEventListener("scroll", this.onRelayout);
    window.removeEventListener("keydown", this.onKeydown);
  }

  private visibleTarget(selector: string): Element | null {
    const target = document.querySelector(selector);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    for (let node: Element | null = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05) return null;
    }
    return target;
  }

  private target(): Element | null {
    // 반응형으로 숨겨졌거나 스크롤 히어로에서 현재 투명한 대상은 건너뛴다.
    for (; this.idx < STEPS.length; this.idx++) {
      const target = this.visibleTarget(STEPS[this.idx].sel);
      if (target) return target;
    }
    return null;
  }

  private show(): void {
    const t = this.target();
    if (!t || !this.card) { this.finish(); return; }
    const step = STEPS[this.idx];
    const firstRect = t.getBoundingClientRect();
    const headerBottom = document.querySelector(".top-fixed")?.getBoundingClientRect().bottom ?? 0;
    const alreadyVisible = firstRect.top >= headerBottom + 8 && firstRect.bottom <= window.innerHeight - 8;
    if (!alreadyVisible) t.scrollIntoView({ behavior: "smooth", block: "center" });

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
    (btns[btns.length - 1] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });

    // 스크롤 애니메이션이 끝난 뒤 위치를 잡는다 (두 번 재계산으로 안착)
    window.setTimeout(() => this.position(), 380);
    window.setTimeout(() => this.position(), 800);
  }

  private position(): void {
    if (!this.spot || !this.card) return;
    const t = this.visibleTarget(STEPS[this.idx]?.sel ?? "");
    if (!t) return;
    const r = t.getBoundingClientRect();
    const pad = 8;
    const leftEdge = Math.max(8, r.left - pad);
    const topEdge = Math.max(8, r.top - pad);
    const rightEdge = Math.min(window.innerWidth - 8, r.right + pad);
    const bottomEdge = Math.min(window.innerHeight - 8, r.bottom + pad);
    Object.assign(this.spot.style, {
      left: `${leftEdge}px`,
      top: `${topEdge}px`,
      width: `${Math.max(0, rightEdge - leftEdge)}px`,
      height: `${Math.max(0, bottomEdge - topEdge)}px`,
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
