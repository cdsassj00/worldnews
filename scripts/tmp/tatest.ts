import { analyze } from "../../shared/ta";
import { fetchBars } from "../bars";

const sym = process.argv[2] || "069960.KS";
const b = await fetchBars(sym, "2y");
if (!b) throw new Error("no bars");
const s = { price: b.close.at(-1)!, closes: b.close, highs: b.high, lows: b.low, volumes: b.volume };
const r = analyze(s);
console.log(`${sym}  현재가 ${r.price}`);
console.log(`종합: ${r.consensus.verdict} (${r.consensus.score}) — ${r.consensus.text}`);
console.log(`지표: RSI ${r.indicators.rsi} · MACD ${r.indicators.macdHist} · ADX ${r.indicators.adx} · MFI ${r.indicators.mfi} · %B ${r.indicators.bbPercentB}`);
console.log(`지지 ${r.levels.support} / 저항 ${r.levels.resistance} / 손절제안 ${r.suggestedStop}`);
console.log("");
for (const st of r.strategies) console.log(`  [${st.verdict.padEnd(11)}] ${st.score.toFixed(2).padStart(5)}  ${st.nameKo} — ${st.text}`);
console.log("");
console.log("패턴:", r.patterns.map(p => p.nameKo).join(", ") || "없음");
