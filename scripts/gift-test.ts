import assert from "node:assert/strict";
import { GIFT_API_PATH, GIFT_PAGE_PATH, giftRequestMessage, giftValue } from "../shared/gift";

assert.equal(giftValue(78_500), 314_000);
assert.equal(giftValue(-1), 0);
assert.match(giftRequestMessage(78_500, "8월 24일 09:10"), /314,000원/);
assert.match(giftRequestMessage(78_500, "8월 24일 09:10"), /삼성전자 4주/);
assert.ok(GIFT_PAGE_PATH.length > 35, "선물 페이지 주소는 쉽게 추측하기 어려운 길이여야 한다");
assert.ok(GIFT_API_PATH.includes("9c7e3a61d4f2"));
assert.equal(new URL(`https://stockontology.cc${GIFT_API_PATH}/kakao/callback`).origin, "https://stockontology.cc");

console.log("✓ birthday gift tests passed");
