/**
 * 국내 증시(KRX) 휴장일 — 주말 제외, 날짜는 KST "YYYY-MM-DD".
 *
 * 캘린더 API 를 따로 두지 않고 목록으로 박는다(연초에 다음 해 목록으로 갱신).
 * 여기 빠진 휴장일이 있으면: 실계좌 봇은 KIS 가 주문을 거부해 일지에 오류만 남고(무해),
 * 여기 잘못 들어간 개장일이 있으면: 그날 손절 점검이 쉬므로 **확실한 날만 넣는다.**
 */
export const KRX_HOLIDAYS = new Set<string>([
  "2026-08-17", // 광복절(8/15 토) 대체휴일
  "2026-09-24", // 추석 연휴
  "2026-09-25", // 추석
  "2026-10-05", // 개천절(10/3 토) 대체휴일
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 휴장(KRX)
]);

export function isKrxHoliday(dateKst: string): boolean {
  return KRX_HOLIDAYS.has(dateKst);
}

/** 미국 증시(NYSE·NASDAQ) 휴장일 — 날짜는 미 동부시간 "YYYY-MM-DD". 2026 잔여분만. */
export const US_HOLIDAYS = new Set<string>([
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

export function isUsHoliday(dateEt: string): boolean {
  return US_HOLIDAYS.has(dateEt);
}
