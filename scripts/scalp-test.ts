import assert from "node:assert/strict";
import { scalpEntrySignal, scalpExitReason, shouldRunScalpCycle, type MinuteBar } from "../shared/scalp";

const start = Date.UTC(2026, 7, 24, 0, 0);
const bars: MinuteBar[] = Array.from({ length: 12 }, (_, i) => ({
  at: start + i * 60_000,
  open: 100 + i * 0.02,
  high: i < 5 ? 100.5 : 100.7,
  low: 99.8,
  close: i === 11 ? 100.8 : 100.1 + i * 0.02,
  volume: i === 11 ? 3000 : 1000,
}));

const signal = scalpEntrySignal(bars);
assert.equal(signal.enter, true, "시초범위·VWAP·거래량 조건을 모두 통과하면 진입해야 한다");
assert.ok(signal.volumeRatio >= 2.9);

const quiet = scalpEntrySignal(bars.map((b, i) => ({ ...b, volume: i === 11 ? 1100 : 1000 })));
assert.equal(quiet.enter, false, "거래량 확인이 없으면 거짓 돌파로 대기해야 한다");

assert.match(scalpExitReason({ entryPrice: 100, currentPrice: 99.1, peakPrice: 100, enteredAt: start, now: start + 5 * 60_000 }) ?? "", /손절/);
assert.match(scalpExitReason({ entryPrice: 100, currentPrice: 101.4, peakPrice: 101.4, enteredAt: start, now: start + 5 * 60_000 }) ?? "", /익절/);
assert.match(scalpExitReason({ entryPrice: 100, currentPrice: 100.4, peakPrice: 101, enteredAt: start, now: start + 10 * 60_000 }) ?? "", /추적청산/);
assert.match(scalpExitReason({ entryPrice: 100, currentPrice: 100.1, peakPrice: 100.4, enteredAt: start, now: start + 31 * 60_000 }) ?? "", /시간청산/);

assert.equal(shouldRunScalpCycle(0, false, false), false, "0%이고 미결 주문·포지션이 없으면 단타 사이클을 쉬어야 한다");
assert.equal(shouldRunScalpCycle(0, true, false), true, "0%여도 기존 단타 포지션은 청산까지 관리해야 한다");
assert.equal(shouldRunScalpCycle(0, false, true), true, "0%여도 미결 주문은 체결 확인을 계속해야 한다");
assert.equal(shouldRunScalpCycle(10, false, false), true, "운용 비율이 있으면 신규 신호 감시를 계속해야 한다");

console.log("✓ scalp strategy tests passed");
