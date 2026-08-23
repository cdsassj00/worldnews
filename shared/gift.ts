export const GIFT_PAGE_PATH = "/for/seungcheol-birthday-4shares-9c7e3a61d4f2";
export const GIFT_API_PATH = "/api/gift/seungcheol-9c7e3a61d4f2";
export const GIFT_STOCK_CODE = "005930";
export const GIFT_STOCK_SYMBOL = "005930.KS";
export const GIFT_SHARES = 4;

export function giftValue(price: number, shares = GIFT_SHARES): number {
  return Math.max(0, Math.round(price * shares));
}

export function giftRequestMessage(price: number, atKst: string): string {
  const total = giftValue(price).toLocaleString("ko-KR");
  const one = Math.round(price).toLocaleString("ko-KR");
  return `🎂 승철이가 생일선물을 요청했어요!\n삼성전자 4주 상당 선물금 ${total}원\n현재가 ${one}원 × 4주\n요청 시각 ${atKst}`;
}
