/**
 * 기술적 분석 엔진 — 세계적으로 통용되는 차트 전략을 그대로 구현한다.
 *
 * 이 파일이 따로 있는 이유는 **출처가 분명한 규칙만 담기 위해서**다.
 * shared/quant.ts 의 점수는 내가 가중치를 정한 합성물이라 "왜 그 숫자냐"에
 * 답하려면 결국 내 설계를 설명해야 한다. 반면 여기 있는 것들은 창시자가 있고
 * 규칙이 공개되어 있으며 수십 년간 시장에서 검증(또는 반증)된 것들이다.
 * 판정이 틀려도 "일목균형표 기준으로는 구름 아래"라는 사실 자체는 검증 가능하다.
 *
 * 구성
 *   ① 지표   — RSI·MACD·볼린저·스토캐스틱·ADX/DMI·일목·돈치안·슈퍼트렌드·CCI 등
 *   ② 전략   — 위 지표를 창시자의 규칙대로 조합한 13종. 각각 매수/중립/매도를 낸다.
 *   ③ 형태   — 캔들 패턴, 지지·저항, 피보나치 되돌림
 *   ④ 종합   — 전략들의 표를 모아 합의 판정을 낸다(다수결이 아니라 가중 평균)
 *
 * 네트워크·Env 를 모른다. 숫자 배열을 받아 숫자와 문장을 돌려준다 —
 * 백테스트와 운영이 **같은 코드**를 돌리기 위한 제약이다.
 */
import { clamp, round, type PriceHistory } from "./scoring";
import { mfi } from "./quant";

/* ══ ① 지표 ══════════════════════════════════════ */

/** 단순이동평균 배열 (앞쪽 n-1개는 NaN) */
export function smaSeries(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 지수이동평균 배열. 초기값은 첫 n개의 단순평균(표준 관행) */
export function emaSeries(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 평활 (RSI·ATR·ADX 가 쓰는 방식 — EMA(2n-1) 과 같다) */
export function wilderSeries(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  if (v.length < n) return out;
  let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) {
    prev = (prev * (n - 1) + v[i]) / n;
    out[i] = prev;
  }
  return out;
}

export function stdev(v: number[], n: number, at: number): number {
  if (at < n - 1) return NaN;
  const w = v.slice(at - n + 1, at + 1);
  const m = w.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
}

/** RSI — J. Welles Wilder (1978), 기본 14일 */
export function rsiSeries(closes: number[], n = 14): number[] {
  const gains: number[] = [0], losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = wilderSeries(gains.slice(1), n);
  const al = wilderSeries(losses.slice(1), n);
  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < ag.length; i++) {
    if (Number.isNaN(ag[i]) || Number.isNaN(al[i])) continue;
    out[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

/** MACD — Gerald Appel (1979). 기본 12/26/9 */
export function macdSeries(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macd = closes.map((_, i) => (Number.isNaN(ef[i]) || Number.isNaN(es[i]) ? NaN : ef[i] - es[i]));
  const valid = macd.filter((v) => !Number.isNaN(v));
  const sigValid = emaSeries(valid, signal);
  const sig = new Array<number>(closes.length).fill(NaN);
  const offset = macd.findIndex((v) => !Number.isNaN(v));
  for (let i = 0; i < sigValid.length; i++) if (!Number.isNaN(sigValid[i])) sig[offset + i] = sigValid[i];
  const hist = macd.map((v, i) => (Number.isNaN(v) || Number.isNaN(sig[i]) ? NaN : v - sig[i]));
  return { macd, signal: sig, hist };
}

/** 볼린저 밴드 — John Bollinger (1980년대). 기본 20일 ±2σ */
export function bollinger(closes: number[], n = 20, mult = 2) {
  const mid = smaSeries(closes, n);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  const width = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(mid[i])) continue;
    const sd = stdev(closes, n, i);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : NaN;
  }
  return { mid, upper, lower, width };
}

/** True Range 배열 */
export function trueRange(h: number[], l: number[], c: number[]): number[] {
  const out: number[] = [h[0] - l[0]];
  for (let i = 1; i < c.length; i++) {
    out.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  return out;
}

/** ATR — Wilder (1978) */
export function atrSeries(h: number[], l: number[], c: number[], n = 14): number[] {
  return wilderSeries(trueRange(h, l, c), n);
}

/** 스토캐스틱 — George Lane (1950년대). %K(14) 와 %D(3일 SMA) */
export function stochastic(h: number[], l: number[], c: number[], n = 14, d = 3) {
  const k = new Array<number>(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    const hh = Math.max(...h.slice(i - n + 1, i + 1));
    const ll = Math.min(...l.slice(i - n + 1, i + 1));
    k[i] = hh > ll ? ((c[i] - ll) / (hh - ll)) * 100 : 50;
  }
  return { k, d: smaSeries(k.map((v) => (Number.isNaN(v) ? 0 : v)), d) };
}

/**
 * ADX / DMI — Wilder (1978).
 * ADX 는 방향이 아니라 **추세의 강도**를 잰다. 25 위면 추세, 20 아래면 횡보로 본다.
 */
export function adxSeries(h: number[], l: number[], c: number[], n = 14) {
  const plusDM: number[] = [], minusDM: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = trueRange(h, l, c).slice(1);
  const atr = wilderSeries(tr, n);
  const pdm = wilderSeries(plusDM, n);
  const mdm = wilderSeries(minusDM, n);
  const pdi = new Array<number>(c.length).fill(NaN);
  const mdi = new Array<number>(c.length).fill(NaN);
  const dx: number[] = [];
  for (let i = 0; i < atr.length; i++) {
    if (Number.isNaN(atr[i]) || !atr[i]) { dx.push(NaN); continue; }
    const p = (pdm[i] / atr[i]) * 100;
    const m = (mdm[i] / atr[i]) * 100;
    pdi[i + 1] = p; mdi[i + 1] = m;
    dx.push(p + m ? (Math.abs(p - m) / (p + m)) * 100 : NaN);
  }
  const dxValid = dx.filter((v) => !Number.isNaN(v));
  const adxValid = wilderSeries(dxValid, n);
  const adx = new Array<number>(c.length).fill(NaN);
  const off = dx.findIndex((v) => !Number.isNaN(v));
  for (let i = 0; i < adxValid.length; i++) if (!Number.isNaN(adxValid[i])) adx[off + i + 1] = adxValid[i];
  return { adx, pdi, mdi };
}

/**
 * 일목균형표 — 一目均衡表, 호소다 고이치(細田悟一, 필명 一目山人), 1930년대.
 * 전환선(9) · 기준선(26) · 선행스팬A/B · 후행스팬. 구름(선행스팬 사이)이 지지·저항이다.
 * 주의: 선행스팬은 26일 **앞**에 그려지므로, 오늘의 구름은 26일 전에 계산된 값이다.
 */
export function ichimoku(h: number[], l: number[], c: number[], conv = 9, base = 26, spanB = 52) {
  const mid = (from: number, to: number, arrH: number[], arrL: number[]) =>
    (Math.max(...arrH.slice(from, to)) + Math.min(...arrL.slice(from, to))) / 2;
  const n = c.length;
  const tenkan = new Array<number>(n).fill(NaN);
  const kijun = new Array<number>(n).fill(NaN);
  const spanARaw = new Array<number>(n).fill(NaN);
  const spanBRaw = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i >= conv - 1) tenkan[i] = mid(i - conv + 1, i + 1, h, l);
    if (i >= base - 1) kijun[i] = mid(i - base + 1, i + 1, h, l);
    if (!Number.isNaN(tenkan[i]) && !Number.isNaN(kijun[i])) spanARaw[i] = (tenkan[i] + kijun[i]) / 2;
    if (i >= spanB - 1) spanBRaw[i] = mid(i - spanB + 1, i + 1, h, l);
  }
  // 오늘 위치의 구름 = base 일 전에 계산된 선행스팬
  const cloudA = new Array<number>(n).fill(NaN);
  const cloudB = new Array<number>(n).fill(NaN);
  for (let i = base; i < n; i++) {
    cloudA[i] = spanARaw[i - base];
    cloudB[i] = spanBRaw[i - base];
  }
  return { tenkan, kijun, cloudA, cloudB, spanARaw, spanBRaw };
}

/** 돈치안 채널 — Richard Donchian. 터틀 트레이딩의 뼈대 */
export function donchian(h: number[], l: number[], n = 20) {
  const up = new Array<number>(h.length).fill(NaN);
  const dn = new Array<number>(h.length).fill(NaN);
  for (let i = n; i < h.length; i++) {
    up[i] = Math.max(...h.slice(i - n, i)); // 당일 제외 — 당일 고가를 넣으면 돌파가 자기참조가 된다
    dn[i] = Math.min(...l.slice(i - n, i));
  }
  return { up, dn };
}

/** 슈퍼트렌드 — Olivier Seban. ATR 기반 추세 추종선 */
export function supertrend(h: number[], l: number[], c: number[], n = 10, mult = 3) {
  const atr = atrSeries(h, l, c, n);
  const trend = new Array<number>(c.length).fill(NaN); // 1 = 상승, -1 = 하락
  const line = new Array<number>(c.length).fill(NaN);
  let upper = NaN, lower = NaN, dir = 1;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(atr[i])) continue;
    const mid = (h[i] + l[i]) / 2;
    const bu = mid + mult * atr[i];
    const bl = mid - mult * atr[i];
    upper = Number.isNaN(upper) || bu < upper || c[i - 1] > upper ? bu : upper;
    lower = Number.isNaN(lower) || bl > lower || c[i - 1] < lower ? bl : lower;
    if (c[i] > upper) dir = 1;
    else if (c[i] < lower) dir = -1;
    trend[i] = dir;
    line[i] = dir === 1 ? lower : upper;
  }
  return { trend, line };
}

/** CCI — Donald Lambert (1980) */
export function cciSeries(h: number[], l: number[], c: number[], n = 20): number[] {
  const tp = c.map((v, i) => (h[i] + l[i] + v) / 3);
  const ma = smaSeries(tp, n);
  const out = new Array<number>(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    const w = tp.slice(i - n + 1, i + 1);
    const md = w.reduce((a, b) => a + Math.abs(b - ma[i]), 0) / n;
    out[i] = md ? (tp[i] - ma[i]) / (0.015 * md) : 0;
  }
  return out;
}

/** OBV — Joseph Granville (1963) */
export function obvSeries(c: number[], v: number[]): number[] {
  const out = [0];
  for (let i = 1; i < c.length; i++) {
    out.push(out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0));
  }
  return out;
}

/* ══ ② 전략 ══════════════════════════════════════ */

export type Verdict = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

export const VERDICT_KO: Record<Verdict, string> = {
  strong_buy: "적극 매수",
  buy: "매수",
  neutral: "중립",
  sell: "매도",
  strong_sell: "적극 매도",
};

export interface StrategySignal {
  id: string;
  /** 전략 이름과 만든 사람 — 근거를 찾아볼 수 있게 남긴다 */
  nameKo: string;
  author: string;
  verdict: Verdict;
  /** -1(강한 매도) ~ +1(강한 매수) */
  score: number;
  /** 왜 그 판정인지 — 숫자를 그대로 넣는다 */
  text: string;
  /** 이 전략이 보는 기준선들 (차트에 그릴 값) */
  levels?: { label: string; value: number }[];
}

function verdictOf(score: number): Verdict {
  if (score >= 0.6) return "strong_buy";
  if (score >= 0.2) return "buy";
  if (score <= -0.6) return "strong_sell";
  if (score <= -0.2) return "sell";
  return "neutral";
}

const last = (a: number[]) => a[a.length - 1];
const prev = (a: number[], k = 1) => a[a.length - 1 - k];
const ok = (v: number) => typeof v === "number" && !Number.isNaN(v);

/**
 * 전략 13종. 각 함수는 데이터가 모자라면 null 을 돌려준다 —
 * 모자란 데이터로 억지 판정을 내는 것이 가장 흔한 기술적 분석 오용이다.
 */
export function runStrategies(s: PriceHistory): StrategySignal[] {
  const c = s.closes, h = s.highs, l = s.lows, v = s.volumes;
  const out: StrategySignal[] = [];
  if (c.length < 60) return out;

  const px = s.price;

  /* 1) 이동평균 교차 — 골든크로스/데드크로스. 가장 오래된 추세 판별법(다우 이론 계열) */
  {
    const short = smaSeries(c, 50);
    const long = smaSeries(c, Math.min(200, c.length - 1));
    const usable = ok(last(short)) && ok(last(long));
    if (usable) {
      const gap = ((last(short) - last(long)) / last(long)) * 100;
      const crossedUp = ok(prev(short)) && ok(prev(long)) && prev(short) <= prev(long) && last(short) > last(long);
      const crossedDn = ok(prev(short)) && ok(prev(long)) && prev(short) >= prev(long) && last(short) < last(long);
      const score = clamp(gap / 8, -1, 1) * (crossedUp || crossedDn ? 1 : 0.7);
      out.push({
        id: "ma_cross",
        nameKo: "이동평균 교차 (골든/데드크로스)",
        author: "다우 이론 계열 · 200일선은 1930년대부터 표준",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: crossedUp
          ? `골든크로스 발생 — 50일선이 200일선을 위로 뚫었습니다 (이격 ${round(gap, 1)}%)`
          : crossedDn
            ? `데드크로스 발생 — 50일선이 200일선 아래로 내려갔습니다 (이격 ${round(gap, 1)}%)`
            : `50일선이 200일선 ${gap >= 0 ? "위" : "아래"}에 ${Math.abs(round(gap, 1))}% ${gap >= 0 ? "정배열" : "역배열"}`,
        levels: [
          { label: "50일선", value: round(last(short), 0) },
          { label: "200일선", value: round(last(long), 0) },
        ],
      });
    }
  }

  /* 2) MACD — Gerald Appel */
  {
    const m = macdSeries(c);
    if (ok(last(m.macd)) && ok(last(m.signal))) {
      const histNow = last(m.hist), histPrev = prev(m.hist);
      const crossUp = ok(histPrev) && histPrev <= 0 && histNow > 0;
      const crossDn = ok(histPrev) && histPrev >= 0 && histNow < 0;
      const scale = Math.abs(last(c)) * 0.01 || 1;
      let score = clamp(histNow / scale, -1, 1) * 0.7;
      if (crossUp) score = Math.max(score, 0.65);
      if (crossDn) score = Math.min(score, -0.65);
      // 0선 위/아래는 장기 방향
      score = clamp(score + (last(m.macd) > 0 ? 0.15 : -0.15), -1, 1);
      out.push({
        id: "macd",
        nameKo: "MACD (이동평균 수렴·확산)",
        author: "Gerald Appel, 1979",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: crossUp
          ? "시그널선 상향 돌파 — 단기 모멘텀이 위로 꺾였습니다"
          : crossDn
            ? "시그널선 하향 이탈 — 단기 모멘텀이 아래로 꺾였습니다"
            : `히스토그램 ${round(histNow, 1)} · MACD 가 0선 ${last(m.macd) > 0 ? "위" : "아래"}`,
      });
    }
  }

  /* 3) RSI — Wilder. 70/30 과매수·과매도 + 다이버전스 */
  {
    const r = rsiSeries(c, 14);
    if (ok(last(r))) {
      const now = last(r);
      // 다이버전스: 가격은 신저가인데 RSI 는 더 낮지 않다 → 하락 힘 약화
      const look = 20;
      const priceLow = Math.min(...c.slice(-look));
      const rsiAtLow = r[c.length - look + c.slice(-look).indexOf(priceLow)];
      const bullDiv = c[c.length - 1] <= priceLow * 1.01 && ok(rsiAtLow) && now > rsiAtLow + 3;
      let score = now <= 30 ? 0.55 : now >= 70 ? -0.55 : clamp((50 - now) / 40, -0.35, 0.35);
      if (bullDiv) score = Math.max(score, 0.5);
      out.push({
        id: "rsi",
        nameKo: "RSI (상대강도지수)",
        author: "J. Welles Wilder, 1978",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `RSI ${round(now, 1)} — ${now >= 70 ? "과매수 구간(70 이상)" : now <= 30 ? "과매도 구간(30 이하)" : "중립 구간"}` +
          (bullDiv ? " · 강세 다이버전스(가격은 신저가인데 RSI 는 아님)" : ""),
      });
    }
  }

  /* 4) 볼린저 밴드 — John Bollinger. %B 와 스퀴즈(밴드 폭 수축 후 확장) */
  {
    const b = bollinger(c, 20, 2);
    if (ok(last(b.upper))) {
      const pb = (px - last(b.lower)) / (last(b.upper) - last(b.lower));
      const w = last(b.width);
      const wHist = b.width.slice(-120).filter(ok);
      const wRank = wHist.length ? wHist.filter((x) => x < w).length / wHist.length : 0.5;
      const squeeze = wRank < 0.2; // 최근 120일 중 밴드 폭 하위 20% = 스퀴즈
      let score = clamp((pb - 0.5) * 1.2, -1, 1) * 0.6;
      // 스퀴즈 뒤 상단 돌파는 볼린저 본인이 강조한 신호
      if (squeeze && pb > 0.9) score = 0.7;
      if (squeeze && pb < 0.1) score = -0.7;
      if (!squeeze && pb > 1) score = -0.3; // 밴드 밖 과열은 되돌림 위험
      out.push({
        id: "bollinger",
        nameKo: "볼린저 밴드",
        author: "John Bollinger, 1980년대",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `%B ${round(pb * 100, 0)}% · 밴드폭 ${round(w, 1)}%(최근 120일 중 하위 ${round(wRank * 100, 0)}%)` +
          (squeeze ? " — 스퀴즈(변동성 수축) 상태, 방향이 터지면 크게 움직입니다" : ""),
        levels: [
          { label: "상단", value: round(last(b.upper), 0) },
          { label: "중심(20일선)", value: round(last(b.mid), 0) },
          { label: "하단", value: round(last(b.lower), 0) },
        ],
      });
    }
  }

  /* 5) 일목균형표 — 호소다 고이치 */
  {
    const ik = ichimoku(h, l, c);
    if (ok(last(ik.cloudA)) && ok(last(ik.cloudB)) && ok(last(ik.kijun))) {
      const top = Math.max(last(ik.cloudA), last(ik.cloudB));
      const bot = Math.min(last(ik.cloudA), last(ik.cloudB));
      const abovecloud = px > top, belowCloud = px < bot;
      const tkCross = last(ik.tenkan) > last(ik.kijun);
      let score = abovecloud ? 0.55 : belowCloud ? -0.55 : 0;
      score = clamp(score + (tkCross ? 0.25 : -0.25), -1, 1);
      out.push({
        id: "ichimoku",
        nameKo: "일목균형표 (一目均衡表)",
        author: "호소다 고이치(一目山人), 1930년대",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `가격이 구름 ${abovecloud ? "위" : belowCloud ? "아래" : "안"}에 있고, 전환선이 기준선 ${tkCross ? "위" : "아래"}입니다` +
          (abovecloud ? " — 구름 상단이 지지선 역할을 합니다" : belowCloud ? " — 구름 하단이 저항선입니다" : " — 방향 미정 구간"),
        levels: [
          { label: "구름 상단", value: round(top, 0) },
          { label: "구름 하단", value: round(bot, 0) },
          { label: "기준선", value: round(last(ik.kijun), 0) },
        ],
      });
    }
  }

  /* 6) 터틀 / 돈치안 채널 돌파 — Richard Dennis & William Eckhardt (1983) */
  {
    const d20 = donchian(h, l, 20);
    const d55 = donchian(h, l, 55);
    if (ok(last(d20.up))) {
      const broke20 = px > last(d20.up);
      const broke55 = ok(last(d55.up)) && px > last(d55.up);
      const brokeDn = px < last(d20.dn);
      const score = broke55 ? 0.85 : broke20 ? 0.6 : brokeDn ? -0.6 : clamp((px - (last(d20.up) + last(d20.dn)) / 2) / ((last(d20.up) - last(d20.dn)) / 2 || 1), -1, 1) * 0.3;
      out.push({
        id: "turtle",
        nameKo: "터틀 (돈치안 채널 돌파)",
        author: "Richard Dennis · William Eckhardt, 1983 / 채널은 Richard Donchian",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: broke55
          ? "55일 신고가 돌파 — 터틀 시스템2 진입 신호"
          : broke20
            ? "20일 신고가 돌파 — 터틀 시스템1 진입 신호"
            : brokeDn
              ? "20일 신저가 이탈 — 터틀 규칙상 청산 신호"
              : `20일 채널 ${round(last(d20.dn), 0)} ~ ${round(last(d20.up), 0)} 안에서 움직이는 중`,
        levels: [
          { label: "20일 채널 상단", value: round(last(d20.up), 0) },
          { label: "20일 채널 하단", value: round(last(d20.dn), 0) },
        ],
      });
    }
  }

  /* 7) 슈퍼트렌드 — Olivier Seban */
  {
    const st = supertrend(h, l, c, 10, 3);
    if (ok(last(st.trend))) {
      const flipped = ok(prev(st.trend)) && prev(st.trend) !== last(st.trend);
      const score = (last(st.trend) === 1 ? 0.55 : -0.55) * (flipped ? 1.4 : 1);
      out.push({
        id: "supertrend",
        nameKo: "슈퍼트렌드",
        author: "Olivier Seban",
        verdict: verdictOf(clamp(score, -1, 1)),
        score: round(clamp(score, -1, 1), 2),
        text: `${last(st.trend) === 1 ? "상승" : "하락"} 추세${flipped ? " — 오늘 방향이 바뀌었습니다" : ""} · 추세선 ${round(last(st.line), 0)}`,
        levels: [{ label: "슈퍼트렌드선", value: round(last(st.line), 0) }],
      });
    }
  }

  /* 8) 스토캐스틱 — George Lane */
  {
    const stc = stochastic(h, l, c);
    if (ok(last(stc.k)) && ok(last(stc.d))) {
      const k = last(stc.k), dd = last(stc.d);
      const crossUp = ok(prev(stc.k)) && prev(stc.k) <= prev(stc.d) && k > dd;
      let score = k <= 20 ? 0.45 : k >= 80 ? -0.45 : clamp((50 - k) / 60, -0.3, 0.3);
      if (crossUp && k < 40) score = 0.6;
      out.push({
        id: "stochastic",
        nameKo: "스토캐스틱",
        author: "George Lane, 1950년대",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `%K ${round(k, 0)} · %D ${round(dd, 0)} — ${k >= 80 ? "과매수" : k <= 20 ? "과매도" : "중립"}${crossUp ? " · %K가 %D를 상향 돌파" : ""}`,
      });
    }
  }

  /* 9) ADX/DMI — 추세의 강도. 방향이 아니라 "지금 추세가 있느냐"를 본다 */
  {
    const a = adxSeries(h, l, c);
    if (ok(last(a.adx)) && ok(last(a.pdi))) {
      const adx = last(a.adx), p = last(a.pdi), m = last(a.mdi);
      const trending = adx >= 25;
      const score = trending ? clamp(((p - m) / 40), -1, 1) * 0.7 : 0;
      out.push({
        id: "adx",
        nameKo: "ADX / DMI (추세 강도)",
        author: "J. Welles Wilder, 1978",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `ADX ${round(adx, 0)} — ${trending ? "추세 있음(25 이상)" : "횡보(25 미만, 추세추종 전략은 쉬어야 하는 구간)"} · +DI ${round(p, 0)} / -DI ${round(m, 0)}`,
      });
    }
  }

  /* 10) 스테이지 분석 — Stan Weinstein (1988). 30주(=150일) 이평의 기울기로 4단계 */
  {
    const ma150 = smaSeries(c, Math.min(150, c.length - 1));
    if (ok(last(ma150)) && ok(prev(ma150, 10))) {
      const slope = ((last(ma150) - prev(ma150, 10)) / prev(ma150, 10)) * 100;
      const above = px > last(ma150);
      const stage = above && slope > 0.5 ? 2 : above ? 1 : slope < -0.5 ? 4 : 3;
      const score = stage === 2 ? 0.75 : stage === 1 ? 0.15 : stage === 3 ? -0.2 : -0.75;
      out.push({
        id: "weinstein",
        nameKo: "스테이지 분석 (30주 이평)",
        author: "Stan Weinstein, 1988",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `${stage}단계 — ${stage === 1 ? "바닥 다지기(매집)" : stage === 2 ? "상승 국면 — 와인스타인이 유일하게 사라고 한 구간" : stage === 3 ? "천장 다지기(분산)" : "하락 국면 — 사지 말라는 구간"} · 30주선 기울기 ${round(slope, 1)}%`,
        levels: [{ label: "30주선(150일)", value: round(last(ma150), 0) }],
      });
    }
  }

  /* 11) 추세 템플릿 — Mark Minervini. 8개 조건을 몇 개 만족하는지 센다 */
  {
    const ma50 = smaSeries(c, 50), ma150 = smaSeries(c, Math.min(150, c.length - 1)), ma200 = smaSeries(c, Math.min(200, c.length - 1));
    if (ok(last(ma50)) && ok(last(ma150)) && ok(last(ma200))) {
      const look = Math.min(252, c.length);
      const hi52 = Math.max(...c.slice(-look));
      const lo52 = Math.min(...c.slice(-look));
      const ma200Rising = ok(prev(ma200, 20)) && last(ma200) > prev(ma200, 20);
      const conds = [
        { t: "주가가 150일선·200일선 위", v: px > last(ma150) && px > last(ma200) },
        { t: "150일선이 200일선 위", v: last(ma150) > last(ma200) },
        { t: "200일선이 최소 1개월 상승", v: ma200Rising },
        { t: "50일선이 150·200일선 위", v: last(ma50) > last(ma150) && last(ma50) > last(ma200) },
        { t: "주가가 50일선 위", v: px > last(ma50) },
        { t: "52주 저가 대비 +30% 이상", v: px >= lo52 * 1.3 },
        { t: "52주 고가의 75% 이상", v: px >= hi52 * 0.75 },
      ];
      const passed = conds.filter((x) => x.v).length;
      const score = clamp((passed - 3.5) / 3.5, -1, 1) * 0.8;
      out.push({
        id: "minervini",
        nameKo: "추세 템플릿",
        author: "Mark Minervini",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: `${conds.length}개 조건 중 ${passed}개 충족` +
          (passed < conds.length ? ` · 미충족: ${conds.filter((x) => !x.v).map((x) => x.t).join(", ")}` : " — 전 조건 충족"),
        levels: [
          { label: "52주 고가", value: round(hi52, 0) },
          { label: "52주 저가", value: round(lo52, 0) },
        ],
      });
    }
  }

  /* 12) 삼중창 — Alexander Elder (1986). 장기 방향 → 중기 눌림 → 단기 진입 */
  {
    const weekly = emaSeries(c, 26); // 장기(대략 주봉 13주)
    const m = macdSeries(c);
    const stc = stochastic(h, l, c);
    if (ok(last(weekly)) && ok(prev(weekly, 5)) && ok(last(stc.k))) {
      const tideUp = last(weekly) > prev(weekly, 5);
      const waveOversold = last(stc.k) < 35;
      const waveOverbought = last(stc.k) > 65;
      let score = 0;
      let text = "";
      if (tideUp && waveOversold) { score = 0.8; text = "1창(장기) 상승 + 2창(중기) 과매도 — 엘더가 말한 매수 자리"; }
      else if (tideUp) { score = 0.25; text = `1창(장기) 상승이나 2창이 ${waveOverbought ? "과매수" : "중립"} — 눌림을 기다리는 구간`; }
      else if (!tideUp && waveOverbought) { score = -0.8; text = "1창(장기) 하락 + 2창(중기) 과매수 — 반등 매도 자리"; }
      else { score = -0.25; text = "1창(장기) 하락 — 매수를 금지하는 구간"; }
      score = clamp(score + (ok(last(m.hist)) && last(m.hist) > 0 ? 0.1 : -0.1), -1, 1);
      out.push({
        id: "elder",
        nameKo: "삼중창 (Triple Screen)",
        author: "Alexander Elder, 1986",
        verdict: verdictOf(score),
        score: round(score, 2),
        text,
      });
    }
  }

  /* 13) 다바스 박스 — Nicolas Darvas (1960). 박스 상단 돌파 + 거래량 */
  {
    const look = 40;
    if (c.length >= look + 5) {
      const win = c.slice(-look, -1);
      const boxTop = Math.max(...win);
      const boxBot = Math.min(...win);
      const vol20 = v.slice(-21, -1).filter((x) => x > 0);
      const avgV = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
      const volRatio = avgV ? (v[v.length - 1] ?? 0) / avgV : 1;
      const broke = px > boxTop;
      const tight = boxTop / boxBot < 1.25; // 박스가 좁을수록 돌파의 의미가 크다
      let score = broke ? (volRatio >= 1.5 ? 0.85 : 0.45) : px < boxBot ? -0.6 : clamp((px - (boxTop + boxBot) / 2) / ((boxTop - boxBot) / 2 || 1), -1, 1) * 0.25;
      if (broke && !tight) score *= 0.7;
      out.push({
        id: "darvas",
        nameKo: "다바스 박스",
        author: "Nicolas Darvas, 1960",
        verdict: verdictOf(score),
        score: round(score, 2),
        text: broke
          ? `박스 상단 ${round(boxTop, 0)} 돌파 · 거래량 평균의 ${round(volRatio, 1)}배${volRatio >= 1.5 ? " — 거래량이 실린 유효 돌파" : " — 거래량이 부족해 신뢰도가 낮습니다"}`
          : px < boxBot
            ? `박스 하단 ${round(boxBot, 0)} 이탈 — 다바스 규칙상 즉시 청산 자리`
            : `박스 ${round(boxBot, 0)} ~ ${round(boxTop, 0)} 안 · 상단 돌파를 기다리는 구간`,
        levels: [
          { label: "박스 상단", value: round(boxTop, 0) },
          { label: "박스 하단", value: round(boxBot, 0) },
        ],
      });
    }
  }

  return out;
}

/* ══ ③ 형태 — 캔들 패턴 · 지지저항 · 피보나치 ══════════════ */

export interface Pattern {
  nameKo: string;
  bullish: boolean;
  text: string;
}

/** 최근 캔들에서 고전 패턴을 찾는다 (일본 캔들차트 — 혼마 무네히사 계열) */
export function candlePatterns(s: PriceHistory): Pattern[] {
  const n = s.closes.length;
  if (n < 3) return [];
  const o = (i: number) => s.closes[i - 1] ?? s.closes[i]; // 시가 대용 — 전일 종가
  const c = s.closes, h = s.highs, l = s.lows;
  const i = n - 1;
  const out: Pattern[] = [];
  const body = (k: number) => Math.abs(c[k] - o(k));
  const range = (k: number) => Math.max(1e-9, h[k] - l[k]);

  // 장악형 (Engulfing)
  if (body(i) > body(i - 1) * 1.3) {
    if (c[i] > o(i) && c[i - 1] < o(i - 1)) out.push({ nameKo: "상승 장악형", bullish: true, text: "전일 음봉을 덮는 큰 양봉 — 매수 전환 신호로 읽습니다" });
    if (c[i] < o(i) && c[i - 1] > o(i - 1)) out.push({ nameKo: "하락 장악형", bullish: false, text: "전일 양봉을 덮는 큰 음봉 — 매도 전환 신호로 읽습니다" });
  }
  // 망치형 / 유성형
  const lowerWick = Math.min(c[i], o(i)) - l[i];
  const upperWick = h[i] - Math.max(c[i], o(i));
  if (lowerWick > body(i) * 2 && upperWick < body(i)) out.push({ nameKo: "망치형", bullish: true, text: "아래꼬리가 몸통의 2배 이상 — 저가에서 매수가 받쳐 올린 자리" });
  if (upperWick > body(i) * 2 && lowerWick < body(i)) out.push({ nameKo: "유성형", bullish: false, text: "위꼬리가 몸통의 2배 이상 — 고가에서 매도가 눌러 내린 자리" });
  // 도지
  if (body(i) < range(i) * 0.1) out.push({ nameKo: "도지", bullish: c[i] >= c[i - 1], text: "시가와 종가가 거의 같음 — 매수·매도가 팽팽해 방향 전환 가능성" });

  return out;
}

/** 피보나치 되돌림 — 최근 구간 고저 기준 */
export function fibonacci(s: PriceHistory, look = 120): { label: string; value: number }[] {
  const c = s.closes.slice(-look);
  if (c.length < 20) return [];
  const hi = Math.max(...c), lo = Math.min(...c);
  const d = hi - lo;
  return [
    { label: "고점 (0%)", value: round(hi, 0) },
    { label: "23.6%", value: round(hi - d * 0.236, 0) },
    { label: "38.2%", value: round(hi - d * 0.382, 0) },
    { label: "50%", value: round(hi - d * 0.5, 0) },
    { label: "61.8% (황금비)", value: round(hi - d * 0.618, 0) },
    { label: "저점 (100%)", value: round(lo, 0) },
  ];
}

/** 지지·저항 — 최근 스윙 고저를 모아 현재가 위아래에서 가장 가까운 것을 고른다 */
export function supportResistance(s: PriceHistory, look = 120): { support: number | null; resistance: number | null } {
  const n = s.closes.length;
  const from = Math.max(2, n - look);
  const pivotsHi: number[] = [], pivotsLo: number[] = [];
  for (let i = from; i < n - 2; i++) {
    if (s.highs[i] > s.highs[i - 1] && s.highs[i] > s.highs[i - 2] && s.highs[i] > s.highs[i + 1] && s.highs[i] > s.highs[i + 2]) pivotsHi.push(s.highs[i]);
    if (s.lows[i] < s.lows[i - 1] && s.lows[i] < s.lows[i - 2] && s.lows[i] < s.lows[i + 1] && s.lows[i] < s.lows[i + 2]) pivotsLo.push(s.lows[i]);
  }
  const px = s.price;
  const below = [...pivotsLo, ...pivotsHi].filter((v) => v < px).sort((a, b) => b - a);
  const above = [...pivotsLo, ...pivotsHi].filter((v) => v > px).sort((a, b) => a - b);
  return { support: below[0] ?? null, resistance: above[0] ?? null };
}


/* ══ ⑥ 가격 패턴 · 매물대 · 추세선 ══════════════════════════
 *
 * 이 블록은 **주어진 구간만** 본다 — 화면에서 차트를 확대하면 그 구간의 PriceHistory 를
 * 그대로 넣어 재분석할 수 있다. 프런트가 shared 코드를 직접 불러 같은 함수를 돌리므로
 * 서버 판정과 화면 판정이 어긋날 수 없다.
 */

export interface Swing {
  /** closes 배열 기준 인덱스 */
  i: number;
  price: number;
  kind: "H" | "L";
}

/**
 * 지그재그 스윙 추출 — 패턴 인식의 뼈대.
 * 되돌림이 문턱(기본: 3% 또는 1.5×ATR 중 큰 쪽)을 넘어야 스윙으로 인정한다.
 * 문턱이 없으면 잔파도가 전부 "바닥"이 되어 아무 데서나 쌍바닥이 보인다.
 */
export function zigzag(s: PriceHistory, thresholdPct?: number): Swing[] {
  const c = s.closes;
  const n = c.length;
  if (n < 10) return [];
  const atr = last(atrSeries(s.highs, s.lows, c, 14)) || s.price * 0.02;
  const th = thresholdPct ?? Math.max(3, (atr / s.price) * 150);

  const swings: Swing[] = [];
  let dir: 1 | -1 = c[1] >= c[0] ? 1 : -1;
  let extI = 0;
  let extP = c[0];
  for (let i = 1; i < n; i++) {
    const hi = s.highs[i] ?? c[i];
    const lo = s.lows[i] ?? c[i];
    if (dir === 1) {
      if (hi > extP) { extP = hi; extI = i; }
      else if (((extP - lo) / extP) * 100 >= th) {
        swings.push({ i: extI, price: round(extP, 2), kind: "H" });
        dir = -1; extP = lo; extI = i;
      }
    } else {
      if (lo < extP) { extP = lo; extI = i; }
      else if (((hi - extP) / extP) * 100 >= th) {
        swings.push({ i: extI, price: round(extP, 2), kind: "L" });
        dir = 1; extP = hi; extI = i;
      }
    }
  }
  swings.push({ i: extI, price: round(extP, 2), kind: dir === 1 ? "H" : "L" });
  return swings;
}

export interface PricePattern {
  id: string;
  nameKo: string;
  bullish: boolean;
  /** 완성(넥라인 돌파) 여부 — 미완성 패턴은 "형성 중"으로만 말한다 */
  confirmed: boolean;
  confidence: number;
  text: string;
  /** 차트에 이어 그릴 점들 (closes 인덱스, 가격) */
  markers: { i: number; price: number }[];
  /** 넥라인(돌파 기준선) 가격 */
  neckline?: number;
}

const near = (a: number, b: number, tolPct: number) => Math.abs(a - b) / Math.max(a, b) * 100 <= tolPct;

/**
 * 고전 가격 패턴 인식 — 쌍바닥·삼바닥·쌍봉·삼봉·헤드앤숄더·역헤드앤숄더·V자 반등·박스권.
 *
 * 원칙: **완성 조건(넥라인 돌파)을 확인하기 전에는 "형성 중"이라고만 말한다.**
 * 패턴 인식이 사기가 되는 지점은 미완성 모양을 완성된 신호처럼 파는 순간이다.
 */
export function detectPatterns(s: PriceHistory): PricePattern[] {
  const out: PricePattern[] = [];
  const c = s.closes;
  const n = c.length;
  if (n < 30) return out;
  const px = s.price;
  const sw = zigzag(s);
  const lows = sw.filter((x) => x.kind === "L");
  const highs = sw.filter((x) => x.kind === "H");

  /* 쌍바닥 / 삼바닥 — 비슷한 저점 2~3개 + 사이 반등 고점(넥라인) */
  if (lows.length >= 2) {
    const [l2, l1] = [lows[lows.length - 2], lows[lows.length - 1]];
    const mid = highs.find((h) => h.i > l2.i && h.i < l1.i);
    if (mid && near(l1.price, l2.price, 3) && mid.price > Math.max(l1.price, l2.price) * 1.025) {
      const confirmed = px > mid.price;
      const l3 = lows.length >= 3 ? lows[lows.length - 3] : null;
      const triple = l3 && near(l3.price, l1.price, 3.5);
      const mid2 = triple ? highs.find((h) => h.i > l3!.i && h.i < l2.i) : null;
      out.push({
        id: triple ? "triple_bottom" : "double_bottom",
        nameKo: triple ? "삼중 바닥" : "쌍바닥",
        bullish: true,
        confirmed,
        confidence: round((triple ? 0.75 : 0.65) + (confirmed ? 0.15 : 0), 2),
        neckline: round(mid.price, 0),
        text: confirmed
          ? `${triple ? "저점 3개" : "저점 2개"}가 ${round(Math.abs(l1.price - l2.price) / l2.price * 100, 1)}% 이내로 겹치고 넥라인 ${Math.round(mid.price).toLocaleString("ko-KR")}을 돌파 — 완성된 ${triple ? "삼중 바닥" : "쌍바닥"}입니다. 교과서적 목표가는 넥라인 + 바닥 깊이(${Math.round(mid.price + (mid.price - Math.min(l1.price, l2.price))).toLocaleString("ko-KR")}).`
          : `${triple ? "삼중 바닥" : "쌍바닥"} 형성 중 — 넥라인 ${Math.round(mid.price).toLocaleString("ko-KR")}을 종가로 넘어야 완성입니다. 그 전에 사는 것은 패턴 매매가 아니라 추측입니다.`,
        markers: triple && mid2
          ? [l3!, mid2, l2, mid, l1].map((x) => ({ i: x.i, price: x.price }))
          : [l2, mid, l1].map((x) => ({ i: x.i, price: x.price })),
      });
    }
  }

  /* 쌍봉 / 삼봉 — 거울상 */
  if (highs.length >= 2) {
    const [h2, h1] = [highs[highs.length - 2], highs[highs.length - 1]];
    const mid = lows.find((l) => l.i > h2.i && l.i < h1.i);
    if (mid && near(h1.price, h2.price, 3) && mid.price < Math.min(h1.price, h2.price) * 0.975) {
      const confirmed = px < mid.price;
      const h3 = highs.length >= 3 ? highs[highs.length - 3] : null;
      const triple = h3 && near(h3.price, h1.price, 3.5);
      out.push({
        id: triple ? "triple_top" : "double_top",
        nameKo: triple ? "삼중 천장" : "쌍봉(이중 천장)",
        bullish: false,
        confirmed,
        confidence: round((triple ? 0.75 : 0.65) + (confirmed ? 0.15 : 0), 2),
        neckline: round(mid.price, 0),
        text: confirmed
          ? `고점 ${triple ? "3개" : "2개"}가 겹치고 넥라인 ${Math.round(mid.price).toLocaleString("ko-KR")}을 깨고 내려옴 — 완성된 하락 반전 패턴입니다.`
          : `${triple ? "삼중 천장" : "쌍봉"} 형성 중 — 넥라인 ${Math.round(mid.price).toLocaleString("ko-KR")}이 깨지면 하락 반전이 완성됩니다. 보유 중이라면 그 선이 경계선입니다.`,
        markers: [h2, mid, h1].map((x) => ({ i: x.i, price: x.price })),
      });
    }
  }

  /* 헤드앤숄더 / 역헤드앤숄더 — 가운데가 가장 높은(낮은) 봉우리 3개 */
  if (highs.length >= 3 && lows.length >= 2) {
    const [p1, p2, p3] = highs.slice(-3);
    const t1 = lows.find((l) => l.i > p1.i && l.i < p2.i);
    const t2 = lows.find((l) => l.i > p2.i && l.i < p3.i);
    if (t1 && t2 && p2.price > p1.price * 1.02 && p2.price > p3.price * 1.02 && near(p1.price, p3.price, 5)) {
      const neck = (t1.price + t2.price) / 2;
      const confirmed = px < neck;
      out.push({
        id: "head_shoulders",
        nameKo: "헤드앤숄더",
        bullish: false,
        confirmed,
        confidence: round(0.6 + (confirmed ? 0.2 : 0), 2),
        neckline: round(neck, 0),
        text: confirmed
          ? `머리(${Math.round(p2.price).toLocaleString("ko-KR")})보다 낮은 어깨 두 개, 넥라인 ${Math.round(neck).toLocaleString("ko-KR")} 이탈 — 완성된 천장 패턴입니다.`
          : `헤드앤숄더 형성 중 — 넥라인 ${Math.round(neck).toLocaleString("ko-KR")}을 지키면 무효, 깨면 완성입니다.`,
        markers: [p1, t1, p2, t2, p3].map((x) => ({ i: x.i, price: x.price })),
      });
    }
  }
  if (lows.length >= 3 && highs.length >= 2) {
    const [b1, b2, b3] = lows.slice(-3);
    const r1 = highs.find((h) => h.i > b1.i && h.i < b2.i);
    const r2 = highs.find((h) => h.i > b2.i && h.i < b3.i);
    if (r1 && r2 && b2.price < b1.price * 0.98 && b2.price < b3.price * 0.98 && near(b1.price, b3.price, 5)) {
      const neck = (r1.price + r2.price) / 2;
      const confirmed = px > neck;
      out.push({
        id: "inv_head_shoulders",
        nameKo: "역헤드앤숄더",
        bullish: true,
        confirmed,
        confidence: round(0.6 + (confirmed ? 0.2 : 0), 2),
        neckline: round(neck, 0),
        text: confirmed
          ? `가장 깊은 머리(${Math.round(b2.price).toLocaleString("ko-KR")})와 얕은 어깨 두 개, 넥라인 ${Math.round(neck).toLocaleString("ko-KR")} 돌파 — 완성된 바닥 반전 패턴입니다.`
          : `역헤드앤숄더 형성 중 — 넥라인 ${Math.round(neck).toLocaleString("ko-KR")} 돌파가 완성 조건입니다.`,
        markers: [b1, r1, b2, r2, b3].map((x) => ({ i: x.i, price: x.price })),
      });
    }
  }

  /* V자 반등 — 급락 후 급회복. 되돌림 60% 이상이어야 V 라 부른다 */
  {
    const look = Math.min(45, n - 1);
    const win = c.slice(-look);
    let hiI = 0;
    for (let i = 1; i < win.length; i++) if (win[i] > win[hiI]) { if (i < win.length - 5) hiI = i; }
    let loI = hiI;
    for (let i = hiI + 1; i < win.length; i++) if (win[i] < win[loI]) loI = i;
    const drop = ((win[hiI] - win[loI]) / win[hiI]) * 100;
    const barsDown = loI - hiI;
    const recover = win[loI] ? ((px - win[loI]) / (win[hiI] - win[loI])) * 100 : 0;
    const barsUp = win.length - 1 - loI;
    if (drop >= 10 && barsDown <= 20 && barsUp <= 20 && recover >= 60 && loI > hiI) {
      const base = n - look;
      out.push({
        id: "v_reversal",
        nameKo: "V자 반등",
        bullish: true,
        confirmed: recover >= 80,
        confidence: round(0.55 + Math.min(0.25, (recover - 60) / 100), 2),
        text: `${barsDown}거래일에 -${round(drop, 1)}% 급락 후 ${barsUp}거래일 만에 낙폭의 ${round(recover, 0)}%를 회복 — V자 반등${recover >= 80 ? "이 사실상 완성됐습니다" : " 진행 중입니다"}. V자는 되돌림 없이 가는 경우가 많아 눌림 기다리기가 안 통하는 패턴입니다.`,
        markers: [
          { i: base + hiI, price: round(win[hiI], 2) },
          { i: base + loI, price: round(win[loI], 2) },
          { i: n - 1, price: round(px, 2) },
        ],
      });
    }
  }

  /* 박스권 — 최근 30봉 등락폭이 8% 미만이면 횡보 박스 */
  {
    const look = Math.min(30, n);
    const hi = Math.max(...s.highs.slice(-look));
    const lo = Math.min(...s.lows.slice(-look));
    const widthPct = ((hi - lo) / lo) * 100;
    if (widthPct <= 8 && out.length === 0) {
      out.push({
        id: "box",
        nameKo: "박스권 횡보",
        bullish: px > (hi + lo) / 2,
        confirmed: false,
        confidence: 0.5,
        neckline: round(hi, 0),
        text: `최근 ${look}거래일 등락폭이 ${round(widthPct, 1)}%뿐인 박스(${Math.round(lo).toLocaleString("ko-KR")}~${Math.round(hi).toLocaleString("ko-KR")}) — 상단 돌파 전에는 방향이 없습니다.`,
        markers: [
          { i: n - look, price: round(hi, 2) },
          { i: n - 1, price: round(hi, 2) },
        ],
      });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

export interface TrendLine {
  kind: "support" | "resistance";
  nameKo: string;
  /** 선의 양 끝 (closes 인덱스, 가격) — 차트에 그대로 긋는다 */
  from: { i: number; price: number };
  to: { i: number; price: number };
  /** 오늘 위치에서의 선 값 */
  valueNow: number;
  broken: boolean;
  text: string;
}

/** 추세선 — 최근 스윙 저점 2개(상승 지지선) / 스윙 고점 2개(하락 저항선)를 잇는다 */
export function trendlines(s: PriceHistory): TrendLine[] {
  const out: TrendLine[] = [];
  const n = s.closes.length;
  const sw = zigzag(s);
  const lows = sw.filter((x) => x.kind === "L").slice(-3);
  const highs = sw.filter((x) => x.kind === "H").slice(-3);

  const mk = (a: Swing, b: Swing, kind: TrendLine["kind"]): TrendLine | null => {
    if (b.i <= a.i) return null;
    const slope = (b.price - a.price) / (b.i - a.i);
    const valueNow = b.price + slope * (n - 1 - b.i);
    if (valueNow <= 0) return null;
    const broken = kind === "support" ? s.price < valueNow * 0.99 : s.price > valueNow * 1.01;
    const rising = slope > 0;
    return {
      kind,
      nameKo: kind === "support" ? (rising ? "상승 추세선(지지)" : "하락 지지선") : (rising ? "상승 저항선" : "하락 추세선(저항)"),
      from: { i: a.i, price: a.price },
      to: { i: b.i, price: b.price },
      valueNow: round(valueNow, 0),
      broken,
      text: kind === "support"
        ? broken
          ? `저점을 이은 추세선(현재 ${Math.round(valueNow).toLocaleString("ko-KR")})을 깨고 내려왔습니다 — 추세 이탈.`
          : `저점 두 개를 이은 추세선이 ${Math.round(valueNow).toLocaleString("ko-KR")}에서 받치고 있습니다.`
        : broken
          ? `고점을 이은 추세선(현재 ${Math.round(valueNow).toLocaleString("ko-KR")})을 위로 뚫었습니다 — 하락 추세 탈출 신호.`
          : `고점 두 개를 이은 추세선이 ${Math.round(valueNow).toLocaleString("ko-KR")}에서 누르고 있습니다.`,
    };
  };

  if (lows.length >= 2) {
    const line = mk(lows[lows.length - 2], lows[lows.length - 1], "support");
    if (line) out.push(line);
  }
  if (highs.length >= 2) {
    const line = mk(highs[highs.length - 2], highs[highs.length - 1], "resistance");
    if (line) out.push(line);
  }
  return out;
}

export interface VolumeProfile {
  bins: { lo: number; hi: number; mid: number; vol: number; pct: number }[];
  /** 최대 매물대 (Point of Control) */
  poc: number;
  /** 현재가 위에서 가장 두꺼운 매물대 — 뚫어야 할 벽 */
  wallAbove: number | null;
  /** 현재가 아래에서 가장 두꺼운 매물대 — 받쳐 줄 층 */
  wallBelow: number | null;
  text: string;
}

/**
 * 매물대 — 가격대별 거래량 분포.
 * "그 가격에 산 사람이 얼마나 많은가"의 근사다. 현재가 위의 두꺼운 매물대는
 * 본전 매도 물량이 쏟아지는 저항, 아래의 매물대는 지지로 작동하는 경향이 있다.
 */
export function volumeProfile(s: PriceHistory, binCount = 20): VolumeProfile {
  const n = s.closes.length;
  const lo = Math.min(...s.lows.filter((v) => v > 0));
  const hi = Math.max(...s.highs);
  const step = (hi - lo) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, k) => ({
    lo: round(lo + k * step, 2), hi: round(lo + (k + 1) * step, 2),
    mid: round(lo + (k + 0.5) * step, 2), vol: 0, pct: 0,
  }));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const tp = ((s.highs[i] ?? s.closes[i]) + (s.lows[i] ?? s.closes[i]) + s.closes[i]) / 3;
    const v = s.volumes[i] ?? 0;
    const k = Math.min(binCount - 1, Math.max(0, Math.floor((tp - lo) / step)));
    bins[k].vol += v;
    total += v;
  }
  for (const b of bins) b.pct = total ? round((b.vol / total) * 100, 1) : 0;
  const poc = bins.reduce((a, b) => (b.vol > a.vol ? b : a));
  const above = bins.filter((b) => b.mid > s.price);
  const below = bins.filter((b) => b.mid < s.price);
  const wallAbove = above.length ? above.reduce((a, b) => (b.vol > a.vol ? b : a)) : null;
  const wallBelow = below.length ? below.reduce((a, b) => (b.vol > a.vol ? b : a)) : null;
  return {
    bins,
    poc: poc.mid,
    wallAbove: wallAbove ? wallAbove.mid : null,
    wallBelow: wallBelow ? wallBelow.mid : null,
    text:
      `최대 매물대 ${Math.round(poc.mid).toLocaleString("ko-KR")}(전체 거래의 ${poc.pct}%)` +
      (wallAbove ? ` · 위쪽 벽 ${Math.round(wallAbove.mid).toLocaleString("ko-KR")}(${wallAbove.pct}%)` : "") +
      (wallBelow ? ` · 아래 받침 ${Math.round(wallBelow.mid).toLocaleString("ko-KR")}(${wallBelow.pct}%)` : ""),
  };
}

/** 구간 재분석 묶음 — 화면에서 차트를 확대했을 때 그 구간만으로 다시 판정한다 */
export function windowAnalysis(s: PriceHistory) {
  return {
    patterns: detectPatterns(s),
    trendlines: trendlines(s),
    profile: volumeProfile(s),
    trend: trendState(s),
    ladder: levelLadder(s, 3),
  };
}

/* ══ ④ 종합 ══════════════════════════════════════ */

export interface TaReport {
  price: number;
  /** 전략별 판정 */
  strategies: StrategySignal[];
  /** 합의 점수 (-1~1) 와 판정 */
  consensus: { score: number; verdict: Verdict; buy: number; neutral: number; sell: number; text: string };
  patterns: Pattern[];
  fib: { label: string; value: number }[];
  levels: { support: number | null; resistance: number | null };
  /** 참고용 원시 지표값 */
  indicators: { rsi: number; macdHist: number; adx: number; atr: number; mfi: number; bbPercentB: number };
  /** 변동성 기반 손절 제안 (2×ATR) — 전략과 무관하게 위험 관리용 */
  suggestedStop: number | null;
  /** 지지·저항 사다리 (위에서 아래로) */
  ladder: Level[];
  /** 단기·중기·장기 추세 상태 */
  trend: TrendState;
  /** 판정을 숫자로 옮긴 매매 플랜 */
  plan: TradePlan;
  /** 컨센서스를 성격별로 나눈 집계 — 무엇이 엇갈리는지 보이게 */
  groups: { nameKo: string; score: number; buy: number; sell: number; ids: string[] }[];
  /** 고전 가격 패턴 (쌍바닥·헤드앤숄더 등) — 전체 구간 기준 */
  pricePatterns: PricePattern[];
  /** 매물대 요약 */
  profile: VolumeProfile;
}

/**
 * 합의 판정.
 *
 * 단순 다수결을 쓰지 않는다. 전략마다 보는 시간축이 다르고(터틀은 중기, 스토캐스틱은
 * 단기), ADX 는 방향이 아니라 강도를 보므로 표를 똑같이 세면 의미가 왜곡된다.
 * 대신 ① 점수를 평균하고 ② **ADX 가 횡보라고 말하면 추세추종 전략들의 표를 깎는다.**
 * 추세가 없는 구간에서 돌파 신호를 믿는 것이 기술적 분석 최대의 실패 지점이다.
 */
export function consensus(sigs: StrategySignal[]): TaReport["consensus"] {
  if (!sigs.length) return { score: 0, verdict: "neutral", buy: 0, neutral: 0, sell: 0, text: "데이터가 부족해 판정하지 않습니다." };
  const adx = sigs.find((s) => s.id === "adx");
  const choppy = adx ? /횡보/.test(adx.text) : false;
  const trendFollowing = new Set(["ma_cross", "turtle", "supertrend", "weinstein", "minervini", "darvas", "ichimoku"]);

  let sum = 0, wsum = 0;
  for (const s of sigs) {
    const w = choppy && trendFollowing.has(s.id) ? 0.5 : 1;
    sum += s.score * w;
    wsum += w;
  }
  const score = clamp(sum / (wsum || 1), -1, 1);
  const buy = sigs.filter((s) => s.score >= 0.2).length;
  const sell = sigs.filter((s) => s.score <= -0.2).length;
  return {
    score: round(score, 2),
    verdict: verdictOf(score),
    buy,
    sell,
    neutral: sigs.length - buy - sell,
    text: `전략 ${sigs.length}종 중 매수 ${buy} · 중립 ${sigs.length - buy - sell} · 매도 ${sell}` +
      (choppy ? " — ADX가 횡보라 추세추종 전략의 표는 절반만 반영했습니다" : ""),
  };
}


/* ══ ⑤ 레벨·추세·매매 플랜 ══════════════════════════════ */

export interface Level {
  price: number;
  /** 현재가 대비 % */
  distPct: number;
  /** 어디서 나온 선인가 — 근거가 여러 개면 그만큼 신뢰도가 높다 */
  sources: string[];
  /** 과거에 몇 번 부딪혔나 (스윙 고저 기준) */
  touches: number;
  /** 0~1 — 근거 수·접촉 횟수·거리로 매긴 신뢰도 */
  strength: number;
  kind: "support" | "resistance";
}

/**
 * 지지·저항 사다리.
 *
 * "가장 가까운 선 하나"만 주면 실전에서 못 쓴다. 손절은 그 아래에, 목표는 그 위에
 * 두어야 하고, 되돌림이 어디서 멈출지 보려면 여러 단계가 필요하다.
 * 그래서 **여러 출처의 선을 모아 가격이 비슷한 것끼리 묶는다**(1.2% 이내면 같은 선).
 * 서로 다른 방식이 같은 가격을 가리키면 그 가격은 실제로 시장이 기억하는 자리다.
 */
export function levelLadder(s: PriceHistory, maxEach = 4): Level[] {
  const px = s.price;
  const n = s.closes.length;
  const raw: { price: number; source: string; touch: number }[] = [];

  // ① 스윙 고저 (좌우 2봉보다 높은/낮은 자리)
  const from = Math.max(2, n - 250);
  const swings: number[] = [];
  for (let i = from; i < n - 2; i++) {
    if (s.highs[i] > s.highs[i - 1] && s.highs[i] > s.highs[i - 2] && s.highs[i] > s.highs[i + 1] && s.highs[i] > s.highs[i + 2]) swings.push(s.highs[i]);
    if (s.lows[i] < s.lows[i - 1] && s.lows[i] < s.lows[i - 2] && s.lows[i] < s.lows[i + 1] && s.lows[i] < s.lows[i + 2]) swings.push(s.lows[i]);
  }
  for (const v of swings) raw.push({ price: v, source: "스윙 고저", touch: 1 });

  // ② 이동평균 — 살아 있는 지지·저항으로 가장 널리 쓰인다
  for (const [n2, ko] of [[20, "20일선"], [60, "60일선"], [120, "120일선"], [200, "200일선"]] as [number, string][]) {
    if (n > n2) {
      const v = last(smaSeries(s.closes, n2));
      if (ok(v)) raw.push({ price: v, source: ko, touch: 0 });
    }
  }

  // ③ 볼린저 상·하단
  const bb = bollinger(s.closes, 20, 2);
  if (ok(last(bb.upper))) raw.push({ price: last(bb.upper), source: "볼린저 상단", touch: 0 });
  if (ok(last(bb.lower))) raw.push({ price: last(bb.lower), source: "볼린저 하단", touch: 0 });

  // ④ 일목 구름 — 일본식 지지·저항의 핵심
  const ik = ichimoku(s.highs, s.lows, s.closes);
  if (ok(last(ik.cloudA)) && ok(last(ik.cloudB))) {
    raw.push({ price: Math.max(last(ik.cloudA), last(ik.cloudB)), source: "구름 상단", touch: 0 });
    raw.push({ price: Math.min(last(ik.cloudA), last(ik.cloudB)), source: "구름 하단", touch: 0 });
  }
  if (ok(last(ik.kijun))) raw.push({ price: last(ik.kijun), source: "일목 기준선", touch: 0 });

  // ⑤ 피보나치 되돌림
  for (const f of fibonacci(s)) if (!/고점|저점/.test(f.label)) raw.push({ price: f.value, source: `피보 ${f.label}`, touch: 0 });

  // ⑥ 돈치안 채널 (20일 신고·신저)
  const d = donchian(s.highs, s.lows, 20);
  if (ok(last(d.up))) raw.push({ price: last(d.up), source: "20일 고점", touch: 0 });
  if (ok(last(d.dn))) raw.push({ price: last(d.dn), source: "20일 저점", touch: 0 });

  // 가격이 비슷한 것끼리 묶는다 (1.2% 이내)
  const sorted = raw.filter((r) => r.price > 0).sort((a, b) => a.price - b.price);
  const clusters: { price: number; sources: string[]; touches: number }[] = [];
  for (const r of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(r.price - c.price) / c.price < 0.012) {
      c.price = (c.price * c.sources.length + r.price) / (c.sources.length + 1);
      if (!c.sources.includes(r.source)) c.sources.push(r.source);
      c.touches += r.touch;
    } else {
      clusters.push({ price: r.price, sources: [r.source], touches: r.touch });
    }
  }

  const out: Level[] = clusters.map((c) => {
    const distPct = ((c.price - px) / px) * 100;
    // 근거가 겹칠수록, 많이 부딪혔을수록, 가까울수록 강하다
    const strength = clamp(
      (Math.min(c.sources.length, 4) / 4) * 0.5 + (Math.min(c.touches, 4) / 4) * 0.3 + (1 - Math.min(Math.abs(distPct), 25) / 25) * 0.2,
      0, 1,
    );
    return {
      price: round(c.price, 0),
      distPct: round(distPct, 1),
      sources: c.sources,
      touches: c.touches,
      strength: round(strength, 2),
      kind: c.price < px ? "support" : "resistance",
    };
  });

  const sup = out.filter((x) => x.kind === "support").sort((a, b) => b.price - a.price).slice(0, maxEach);
  const res = out.filter((x) => x.kind === "resistance").sort((a, b) => a.price - b.price).slice(0, maxEach);
  return [...res.reverse(), ...sup]; // 위에서 아래로
}

export interface TrendState {
  short: "up" | "down" | "flat";
  mid: "up" | "down" | "flat";
  long: "up" | "down" | "flat";
  adx: number;
  /** 추세가 있는 국면인가 (ADX 25 이상) */
  trending: boolean;
  /** 한 줄 요약 */
  text: string;
  /** 정렬 상태 문구 */
  alignment: string;
}

/** 추세 상태 — 단기(20)·중기(60)·장기(120) 세 축을 따로 본다 */
export function trendState(s: PriceHistory): TrendState {
  const dir = (nn: number): "up" | "down" | "flat" => {
    const ma = smaSeries(s.closes, nn);
    if (!ok(last(ma)) || !ok(prev(ma, 5))) return "flat";
    const slope = ((last(ma) - prev(ma, 5)) / prev(ma, 5)) * 100;
    if (s.price > last(ma) && slope > 0.2) return "up";
    if (s.price < last(ma) && slope < -0.2) return "down";
    return "flat";
  };
  const short = dir(20), mid = dir(60), long = dir(Math.min(120, s.closes.length - 1));
  const a = adxSeries(s.highs, s.lows, s.closes);
  const adx = ok(last(a.adx)) ? round(last(a.adx), 0) : 0;
  const trending = adx >= 25;
  const KO = { up: "상승", down: "하락", flat: "횡보" } as const;
  const same = short === mid && mid === long;
  return {
    short, mid, long, adx, trending,
    alignment: same
      ? `${KO[short]} 정렬 — 세 시간축이 모두 같은 방향입니다`
      : `엇갈림 — 단기 ${KO[short]} / 중기 ${KO[mid]} / 장기 ${KO[long]}`,
    text: trending
      ? `ADX ${adx} — 추세가 살아 있는 국면입니다. 돌파·추세추종 신호가 유효합니다.`
      : `ADX ${adx} — 추세가 없는 횡보 국면입니다. 돌파 신호는 속임수가 많고, 지지에서 사서 저항에서 파는 편이 맞습니다.`,
  };
}

export interface TradePlan {
  /** 방향 — 사도 되는 자리인가 */
  bias: "long" | "wait" | "avoid";
  biasKo: string;
  /** 진입 구간 */
  entry: { low: number; high: number; note: string };
  stop: { price: number; pct: number; note: string };
  targets: { price: number; pct: number; note: string }[];
  /** 손익비 — 1회 손실 대비 1차 목표 이익 */
  rr: number;
  /** 원금 대비 1% 를 걸 때 살 수 있는 수량 계산에 쓰는 값 */
  riskPerShare: number;
  /** 이 계획이 깨지는 조건 */
  invalidation: string;
  /** 계획 등급 */
  grade: "good" | "fair" | "poor";
  gradeKo: string;
  checklist: { text: string; pass: boolean }[];
}

/**
 * 매매 플랜 — 판정을 **숫자로 옮긴다.**
 *
 * 기술적 분석이 실전에서 쓸모없어지는 지점은 "매수 의견"에서 끝날 때다.
 * 어디서 사고, 어디서 틀렸다고 인정하고, 어디서 파는지가 없으면 아무 것도 실행할 수 없다.
 * 그래서 손절은 **가장 가까운 지지선 아래 + ATR 여유**로, 목표는 **위쪽 저항선**으로 잡는다.
 * 임의의 -5% 가 아니라 차트가 말하는 자리다.
 */
export function tradePlan(s: PriceHistory, cons: TaReport["consensus"], trend: TrendState, ladder: Level[]): TradePlan {
  const px = s.price;
  const atr = last(atrSeries(s.highs, s.lows, s.closes, 14)) || px * 0.02;
  const sup = ladder.filter((l) => l.kind === "support");
  const res = ladder.filter((l) => l.kind === "resistance");
  const nearSup = sup[0];
  const nearRes = res[res.length - 1]; // 위에서 아래로 정렬돼 있으므로 마지막이 가장 가깝다

  /* 손절 — **차트가 정한 자리를 우선**한다.
   * 가장 가까운 지지 아래로 ATR 의 절반만큼 여유를 둔다(지지선에 딱 붙이면 꼬리 한 번에 털린다).
   * 다만 두 가지 한계를 둔다.
   *   · 0.6×ATR 보다 가까우면 하루 변동에 그냥 걸린다 → 그만큼 넓힌다
   *   · 3×ATR 보다 멀면 한 번 틀렸을 때 손실이 감당이 안 된다 → 그만큼 좁힌다
   * 처음엔 하한을 1.2×ATR 로 뒀는데, 변동성이 큰 종목(일간 ATR 이 주가의 10%)에서는
   * 이 하한이 지지선을 밀어내 손절이 -13% 까지 벌어졌다. 차트를 이기는 상수는 두지 않는다. */
  let stopUse = nearSup ? nearSup.price - atr * 0.5 : px - atr * 2;
  const dist = px - stopUse;
  if (dist < atr * 0.6) stopUse = px - atr * 0.6;
  if (dist > atr * 3) stopUse = px - atr * 3;

  /* 목표 — 바로 위 저항이 1×ATR(또는 2%) 안쪽이면 그건 잡음이다.
   * 그런 자리를 1차 목표로 잡으면 손익비가 구조적으로 나빠진다. 의미 있는 첫 저항을 찾는다. */
  const minGap = Math.max(px * 0.02, atr * 0.8);
  const upper = res.filter((r) => r.price > px).sort((a, b) => a.price - b.price);
  const meaningful = upper.filter((r) => r.price - px >= minGap);
  // 의미 있는 저항이 없으면(전부 잡음 거리) 사다리에서 가장 먼 저항을 쓴다.
  // 여기서 "가장 가까운 저항"으로 떨어뜨리면 목표가 +0.9% 처럼 잡혀 손익비가 허위로 나빠진다.
  const t1 = meaningful[0]?.price ?? upper[upper.length - 1]?.price ?? px + atr * 2;
  const t2 = meaningful[1]?.price ?? t1 + atr * 2;
  const t1FromLadder = meaningful[0] ?? (meaningful.length ? undefined : upper[upper.length - 1]);

  const risk = Math.max(1, px - stopUse);
  const rr = round((t1 - px) / risk, 2);

  const checklist = [
    { text: "장기 추세가 상승 또는 횡보 (하락 추세에서는 사지 않는다)", pass: trend.long !== "down" },
    { text: "전략 컨센서스가 매도가 아님", pass: cons.score > -0.2 },
    { text: "손익비 1.5 이상", pass: rr >= 1.5 },
    { text: "1차 목표까지 여유가 3% 이상", pass: ((t1 - px) / px) * 100 >= 3 },
    { text: trend.trending ? "ADX 25 이상 — 추세 국면" : "ADX 25 미만 — 횡보 국면(돌파 신호 신뢰도 낮음)", pass: trend.trending },
  ];
  const passed = checklist.filter((c) => c.pass).length;

  let bias: TradePlan["bias"];
  if (trend.long === "down" && cons.score < 0) bias = "avoid";
  else if (cons.score >= 0.2 && passed >= 3) bias = "long";
  else bias = "wait";

  const grade: TradePlan["grade"] = rr >= 2 && passed >= 4 ? "good" : rr >= 1.2 && passed >= 3 ? "fair" : "poor";

  // 진입 구간 — 지금 가격과 가장 가까운 지지 사이에서 눌림을 기다린다
  const entryLow = nearSup ? Math.max(nearSup.price, px - atr) : px - atr;
  const entryHigh = px + atr * 0.3;

  return {
    bias,
    biasKo: bias === "long" ? "매수 검토 가능" : bias === "wait" ? "대기 — 조건 미충족" : "회피 — 하락 추세",
    entry: {
      low: round(entryLow, 0),
      high: round(entryHigh, 0),
      note: nearSup
        ? `가장 가까운 지지 ${Math.round(nearSup.price).toLocaleString("ko-KR")} 위에서 분할 진입. 추격매수보다 눌림을 기다리는 편이 손절폭을 줄입니다.`
        : "지지선이 뚜렷하지 않아 진입 구간을 현재가 ±ATR 로 잡았습니다.",
    },
    stop: {
      price: round(stopUse, 0),
      pct: round(((stopUse - px) / px) * 100, 1),
      note: nearSup
        ? `지지 ${Math.round(nearSup.price).toLocaleString("ko-KR")} 아래로 ATR 의 절반(${Math.round(atr * 0.5).toLocaleString("ko-KR")})만큼 여유. 지지선에 딱 붙이면 꼬리 한 번에 털립니다.`
        : `현재가에서 2×ATR(${Math.round(atr * 2).toLocaleString("ko-KR")}) 아래.`,
    },
    targets: [
      { price: round(t1, 0), pct: round(((t1 - px) / px) * 100, 1), note: t1FromLadder ? `1차 — ${meaningful[0] ? "의미 있는 첫 저항" : "사다리 최상단 저항"} (${t1FromLadder.sources.join("·")})` : "1차 — 현재가 +2×ATR (위쪽 저항이 잡히지 않음)" },
      { price: round(t2, 0), pct: round(((t2 - px) / px) * 100, 1), note: meaningful[1] ? `2차 — 그 위 저항대 (${meaningful[1].sources.join("·")})` : "2차 — 1차 목표 +2×ATR" },
    ],
    rr,
    riskPerShare: round(risk, 0),
    invalidation: nearSup
      ? `종가가 ${Math.round(stopUse).toLocaleString("ko-KR")} 아래로 마감하면 이 계획은 틀린 것입니다. 그때는 손절하고 다시 봅니다.`
      : `종가가 ${Math.round(stopUse).toLocaleString("ko-KR")} 아래면 계획 무효.`,
    grade,
    gradeKo: grade === "good" ? "괜찮은 자리" : grade === "fair" ? "보통 — 비중 축소" : "나쁨 — 진입 보류 권장",
    checklist,
  };
}

export function analyze(s: PriceHistory): TaReport {
  const strategies = runStrategies(s);
  const cons = consensus(strategies);
  const tr = trendState(s);
  const ladder = levelLadder(s);
  const b = bollinger(s.closes, 20, 2);
  const r = rsiSeries(s.closes, 14);
  const m = macdSeries(s.closes);
  const a = adxSeries(s.highs, s.lows, s.closes);
  const atr = atrSeries(s.highs, s.lows, s.closes, 14);
  const atrNow = ok(last(atr)) ? last(atr) : 0;
  const pb = ok(last(b.upper)) && last(b.upper) !== last(b.lower)
    ? ((s.price - last(b.lower)) / (last(b.upper) - last(b.lower))) * 100
    : 50;
  return {
    price: s.price,
    strategies,
    consensus: cons,
    patterns: candlePatterns(s),
    fib: fibonacci(s),
    levels: supportResistance(s),
    indicators: {
      rsi: round(ok(last(r)) ? last(r) : 50, 1),
      macdHist: round(ok(last(m.hist)) ? last(m.hist) : 0, 2),
      adx: round(ok(last(a.adx)) ? last(a.adx) : 0, 1),
      atr: round(atrNow, 2),
      mfi: round(mfi(s, 14), 1),
      bbPercentB: round(pb, 0),
    },
    suggestedStop: atrNow ? round(s.price - 2 * atrNow, 0) : null,
    ladder,
    trend: tr,
    plan: tradePlan(s, cons, tr, ladder),
    groups: groupStrategies(strategies),
    pricePatterns: detectPatterns(s),
    profile: volumeProfile(s),
  };
}

/** 전략을 성격별로 묶어 집계한다 — "추세는 좋은데 모멘텀이 죽었다" 같은 엇갈림이 보이게 */
export function groupStrategies(sigs: StrategySignal[]): TaReport["groups"] {
  const GROUPS: { nameKo: string; ids: string[] }[] = [
    { nameKo: "추세 추종", ids: ["ma_cross", "turtle", "supertrend", "weinstein", "minervini", "darvas", "ichimoku"] },
    { nameKo: "모멘텀", ids: ["macd", "rsi", "stochastic", "elder"] },
    { nameKo: "변동성·강도", ids: ["bollinger", "adx"] },
  ];
  return GROUPS.map((g) => {
    const mine = sigs.filter((s) => g.ids.includes(s.id));
    const score = mine.length ? mine.reduce((a, s) => a + s.score, 0) / mine.length : 0;
    return {
      nameKo: g.nameKo,
      score: round(score, 2),
      buy: mine.filter((s) => s.score >= 0.2).length,
      sell: mine.filter((s) => s.score <= -0.2).length,
      ids: mine.map((s) => s.id),
    };
  });
}
