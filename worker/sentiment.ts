/**
 * 사전 기반 금융 뉴스 감성 분석.
 * LLM 없이 결정적으로 동작해야 하므로(캐시·재현성) 다국어 키워드 사전을 쓴다.
 * 점수는 -1 ~ +1 로 정규화한다.
 */

const POS = [
  // 한국어
  "상승", "급등", "강세", "호실적", "사상 최대", "최고치", "돌파", "순매수", "수주", "흑자", "개선", "회복", "확대", "증설",
  "목표주가 상향", "상향", "기대", "훈풍", "반등", "수혜", "체결", "낙관", "완화", "인하", "합의",
  // English
  "rally", "surge", "jump", "beat", "record high", "upgrade", "raise", "outperform", "profit", "growth", "recovery",
  "strong", "optimism", "deal", "approval", "expands", "rebound", "boost", "bullish", "cut rates", "easing",
  // 日本語
  "上昇", "急騰", "最高値", "増益", "好調", "回復", "上方修正", "受注",
  // 中文
  "上涨", "大涨", "创新高", "增长", "利好", "回升", "超预期", "上調",
  // Deutsch / Français / Español / Português
  "steigt", "Rekord", "Gewinn", "erholung", "hausse", "record", "bénéfice", "sube", "récord", "ganancia", "alta", "lucro",
];

const NEG = [
  // 한국어
  "하락", "급락", "약세", "적자", "손실", "쇼크", "부진", "우려", "리스크", "경고", "제재", "규제", "조사", "파업", "리콜",
  "목표주가 하향", "하향", "감산", "구조조정", "디폴트", "부도", "인상", "긴축", "패닉", "폭락", "순매도", "충격",
  // English
  "plunge", "slump", "tumble", "miss", "downgrade", "cut", "loss", "warning", "probe", "lawsuit", "sanction", "recall",
  "strike", "layoff", "default", "bankruptcy", "inflation surge", "hike", "tightening", "bearish", "selloff", "crash", "fears",
  // 日本語
  "下落", "急落", "減益", "赤字", "懸念", "下方修正", "リスク",
  // 中文
  "下跌", "大跌", "亏损", "利空", "下调", "风险", "制裁", "调查",
  // Deutsch / Français / Español / Português
  "fällt", "Verlust", "Sorge", "baisse", "perte", "chute", "cae", "pérdida", "queda", "prejuízo",
];

export interface SentimentResult {
  /** -1 ~ +1 */
  score: number;
  positive: number;
  negative: number;
  matched: string[];
}

export function scoreText(texts: string[]): SentimentResult {
  let pos = 0;
  let neg = 0;
  const matched: string[] = [];
  for (const raw of texts) {
    const t = raw.toLowerCase();
    for (const w of POS) {
      if (t.includes(w.toLowerCase())) {
        pos++;
        if (matched.length < 8) matched.push(`+${w}`);
        break; // 한 기사에서 같은 방향 중복 가산 방지
      }
    }
    for (const w of NEG) {
      if (t.includes(w.toLowerCase())) {
        neg++;
        if (matched.length < 8) matched.push(`-${w}`);
        break;
      }
    }
  }
  const total = pos + neg;
  const score = total === 0 ? 0 : (pos - neg) / Math.max(3, total);
  return { score: Math.max(-1, Math.min(1, score)), positive: pos, negative: neg, matched };
}

/** 특정 종목 관련 기사만 골라 감성 산출 */
export function scoreForTicker(
  headlines: { title: string; summary: string }[],
  names: string[],
): SentimentResult & { hits: number } {
  const needles = names.map((n) => n.toLowerCase()).filter((n) => n.length >= 2);
  const related = headlines.filter((h) => {
    const t = `${h.title} ${h.summary}`.toLowerCase();
    return needles.some((n) => t.includes(n));
  });
  const r = scoreText(related.map((h) => `${h.title} ${h.summary}`));
  return { ...r, hits: related.length };
}
