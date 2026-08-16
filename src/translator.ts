/**
 * 실시간 DOM 번역기 — 구글 번역 위젯 대체.
 *
 * 동작: 화면의 텍스트 노드를 훑어 한국어 문장을 모으고, /api/translate 로
 * 배치 번역(서버 KV 사전 캐시)한 뒤 제자리에서 바꾼다. MutationObserver 로
 * 새로 그려지는 내용(결론·순위표·일지 등 실시간 문장)도 계속 따라간다.
 * 원문은 노드별로 보관해 두므로 🇰🇷 를 누르면 새로고침 없이 즉시 돌아온다.
 *
 * 일부러 번역하지 않는 것
 *  - 숫자 위주 문자열("128,700원", "3종목") — 고유 문자열이 무한히 생겨
 *    캐시가 터진다. 단위 두세 글자 때문에 AI 를 부르지 않는다.
 *  - 3D 캔버스 안 라벨 — 그림이라 DOM 번역이 닿지 않는다(알려진 한계).
 */

const BATCH = 48;
const FLUSH_MS = 1200;

/** 번역할 가치가 있는 문자열인가 */
function worthTranslating(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 300 || !/[가-힣]/.test(t)) return false;
  // 숫자가 섞였는데 한글이 세 글자 이하면 단위 표기다 ("6일", "45개", "128,700원")
  const koLen = (t.match(/[가-힣]/g) ?? []).length;
  if (/\d/.test(t) && koLen <= 3) return false;
  return true;
}

/* 숫자+단위 문자열은 AI 에 보내지 않고(고유 문자열이 무한히 생긴다) 규칙으로
 * 즉시 바꾼다 — "120종목" → "120 stocks", "128,700원" → "₩128,700".
 * 순서 중요: 만원 → 원, 개월 → 개, "N분 전" → 분. */
const UNIT_RULES: Record<string, [RegExp, string][]> = {
  en: [
    [/([\d,.]+)\s*만원/g, "$1×10k KRW"],
    [/([\d,.]+)\s*개월/g, "$1mo"],
    [/([\d,.]+)\s*년/g, "$1y"],
    [/([\d,.]+)\s*분 ?전/g, "$1 min ago"],
    [/([\d,.]+)\s*시간 ?전/g, "$1h ago"],
    [/([\d,.]+)\s*초 ?전/g, "$1s ago"],
    [/([\d,.]+)\s*일/g, "$1d"],
    [/([\d,.]+)\s*종목/g, "$1 stocks"],
    [/([\d,.]+)\s*주(?![가-힣])/g, "$1 sh"],
    [/([\d,.]+)\s*원/g, "₩$1"],
    [/([\d,.]+)\s*건/g, "$1"],
    [/([\d,.]+)\s*개(?!월)/g, "$1"],
    [/([\d,.]+)\s*명/g, "$1"],
  ],
  ja: [
    [/([\d,.]+)\s*만원/g, "$1万ウォン"],
    [/([\d,.]+)\s*개월/g, "$1ヶ月"],
    [/([\d,.]+)\s*년/g, "$1年"],
    [/([\d,.]+)\s*분 ?전/g, "$1分前"],
    [/([\d,.]+)\s*시간 ?전/g, "$1時間前"],
    [/([\d,.]+)\s*초 ?전/g, "$1秒前"],
    [/([\d,.]+)\s*일/g, "$1日"],
    [/([\d,.]+)\s*종목/g, "$1銘柄"],
    [/([\d,.]+)\s*주(?![가-힣])/g, "$1株"],
    [/([\d,.]+)\s*원/g, "$1ウォン"],
    [/([\d,.]+)\s*건/g, "$1件"],
    [/([\d,.]+)\s*개(?!월)/g, "$1個"],
    [/([\d,.]+)\s*명/g, "$1名"],
  ],
  "zh-CN": [
    [/([\d,.]+)\s*만원/g, "$1万韩元"],
    [/([\d,.]+)\s*개월/g, "$1个月"],
    [/([\d,.]+)\s*년/g, "$1年"],
    [/([\d,.]+)\s*분 ?전/g, "$1分钟前"],
    [/([\d,.]+)\s*시간 ?전/g, "$1小时前"],
    [/([\d,.]+)\s*초 ?전/g, "$1秒前"],
    [/([\d,.]+)\s*일/g, "$1天"],
    [/([\d,.]+)\s*종목/g, "$1只"],
    [/([\d,.]+)\s*주(?![가-힣])/g, "$1股"],
    [/([\d,.]+)\s*원/g, "$1韩元"],
    [/([\d,.]+)\s*건/g, "$1件"],
    [/([\d,.]+)\s*개(?!월)/g, "$1个"],
    [/([\d,.]+)\s*명/g, "$1名"],
  ],
};

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE"]);

export class SiteTranslator {
  private lang: "" | "en" | "ja" | "zh-CN" = "";
  private readonly cache = new Map<string, string>();
  /** 원문 → 이 원문을 담고 있는 텍스트 노드들 (번역 도착 시 일괄 적용) */
  private readonly nodesByText = new Map<string, Set<Text>>();
  /** 노드 → 원문 (되돌리기 + 재번역 방지) */
  private readonly originals = new Map<Text, string>();
  /** 노드 → 우리가 써넣은 번역문 — MutationObserver 가 우리 자신의 변경을
   * "새 원문"으로 오인해 되돌리기가 깨지는 것을 막는 결정적 장치.
   * (applying 플래그는 콜백이 비동기라 소용없다 — 실측으로 배운 버그) */
  private readonly appliedText = new Map<Text, string>();
  private readonly queue = new Set<string>();
  /** 문장별 시도 횟수 — 계속 실패하는 문장으로 API 를 무한히 두드리지 않는다 */
  private readonly attempts = new Map<string, number>();
  private inflight = false;
  private applying = false;
  private observer: MutationObserver | null = null;
  private timer = 0;
  /** 번역 큐 상태 알림 — 상단 언어 버튼의 진행 표시용 */
  onBusy: ((busy: boolean) => void) | null = null;

  get active(): string { return this.lang; }

  private notifyBusy(): void {
    this.onBusy?.(Boolean(this.lang) && (this.queue.size > 0 || this.inflight));
  }

  enable(lang: "en" | "ja" | "zh-CN"): void {
    if (this.lang === lang) return;
    if (this.lang) this.restoreAll(); // 언어 갈아탈 때는 원문 기준으로 다시
    this.lang = lang;
    this.cache.clear();
    this.scan(document.body);
    this.observer ??= new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
          const tn = m.target as Text;
          // 우리가 방금 써넣은 번역문의 메아리면 무시
          if (this.appliedText.get(tn) === tn.data) continue;
          // 코드가 텍스트를 갈아끼웠다 = 원문이 바뀌었다. 기존 기록을 버리고 다시 등록
          this.originals.delete(tn);
          this.appliedText.delete(tn);
          this.track(tn);
        }
        for (const n of m.addedNodes) this.scan(n);
      }
      this.scheduleFlush();
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    void this.flush();
  }

  disable(): void {
    this.lang = "";
    this.observer?.disconnect();
    this.observer = null;
    window.clearTimeout(this.timer);
    this.queue.clear();
    this.restoreAll();
    this.notifyBusy();
  }

  private restoreAll(): void {
    for (const [node, ko] of this.originals) {
      if (node.isConnected) node.data = ko;
    }
    this.originals.clear();
    this.appliedText.clear();
    this.nodesByText.clear();
    this.attempts.clear();
    // 방금 우리가 만든 변경 기록을 버린다 — 콜백이 재등록하는 것을 막는다
    this.observer?.takeRecords();
  }

  private scan(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) { this.track(root as Text); return; }
    if (!(root instanceof Element) || SKIP_TAGS.has(root.tagName)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = (n as Text).parentElement;
        return p && !SKIP_TAGS.has(p.tagName) && !p.closest("[data-no-translate]")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) this.track(n as Text);
  }

  private track(node: Text): void {
    if (this.originals.has(node)) return; // 이미 등록(또는 우리가 번역해 둔) 노드
    const raw = node.data;
    if (this.appliedText.get(node) === raw) return; // 우리가 써넣은 번역문
    if (!worthTranslating(raw)) { this.tryUnits(node, raw); return; }
    // 서버 사전 키와 맞도록 공백을 접는다 (HTML 개행·들여쓰기 무시)
    const ko = raw.trim().replace(/\s+/g, " ");
    this.originals.set(node, raw);
    let set = this.nodesByText.get(ko);
    if (!set) { set = new Set(); this.nodesByText.set(ko, set); }
    set.add(node);
    const hit = this.cache.get(ko);
    if (hit) this.apply(ko, hit);
    else this.queue.add(ko);
  }

  /** 숫자+단위 문자열의 로컬 치환 — 남는 한글이 없을 때만 적용한다 */
  private tryUnits(node: Text, raw: string): void {
    const rules = UNIT_RULES[this.lang];
    if (!rules || !/[가-힣]/.test(raw) || !/\d/.test(raw)) return;
    let next = raw;
    for (const [re, rep] of rules) next = next.replace(re, rep);
    if (next === raw) return;
    if (this.lang === "en" && /[가-힣]/.test(next)) return; // 못 소화한 한글이 남으면 원문 유지
    this.originals.set(node, raw);
    this.appliedText.set(node, next);
    node.data = next;
  }

  private apply(ko: string, translated: string): void {
    const set = this.nodesByText.get(ko);
    if (!set) return;
    for (const node of set) {
      if (!node.isConnected) { set.delete(node); this.originals.delete(node); this.appliedText.delete(node); continue; }
      const raw = this.originals.get(node) ?? node.data;
      // 앞뒤 공백은 원문 모양대로 보존한다
      const next = raw.replace(raw.trim(), translated);
      this.appliedText.set(node, next);
      node.data = next;
    }
  }

  private scheduleFlush(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), FLUSH_MS);
  }

  private async flush(): Promise<void> {
    if (!this.lang || this.inflight || this.queue.size === 0) { this.notifyBusy(); return; }
    this.inflight = true;
    this.notifyBusy();
    const batch = [...this.queue].slice(0, BATCH);
    for (const t of batch) this.queue.delete(t);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: this.lang, texts: batch }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data = (await res.json()) as { map: Record<string, string>; skipped?: string[] };
      for (const [ko, tr] of Object.entries(data.map)) {
        this.cache.set(ko, tr);
        this.apply(ko, tr);
      }
      if (!this.lang) return;
      // 서버가 시도조차 못 한 문장(상한 초과)은 카운트 없이 재요청,
      // 시도했는데 실패한 문장은 4번까지만 재시도 — 그 뒤엔 원문으로 둔다.
      const skipped = new Set(data.skipped ?? []);
      for (const t of batch) {
        if (data.map[t]) continue;
        if (skipped.has(t)) { this.queue.add(t); continue; }
        const n = (this.attempts.get(t) ?? 0) + 1;
        this.attempts.set(t, n);
        if (n < 4) this.queue.add(t);
      }
    } catch {
      for (const t of batch) this.queue.add(t); // 네트워크 오류 — 다음 기회에
    } finally {
      this.inflight = false;
      if (this.queue.size && this.lang) this.scheduleFlush();
      this.notifyBusy();
    }
  }
}
