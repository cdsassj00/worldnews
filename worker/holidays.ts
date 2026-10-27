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

/** 미국 조기 폐장일(오후 1시 ET 마감) — 알려진 날짜만. 정규 휴장은 아니라 매매는 가능하다. */
export const US_EARLY_CLOSE = new Set<string>([
  "2026-11-27", // 추수감사절 다음날(블랙프라이데이)
]);

export function isUsEarlyClose(dateEt: string): boolean {
  return US_EARLY_CLOSE.has(dateEt);
}

/** dateStr(YYYY-MM-DD)로부터 addDays 만큼 뒤 날짜를 같은 형식으로. UTC 자정 기준 — 캘린더 날짜 연산에만 쓴다. */
function shiftDate(dateStr: string, addDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

/**
 * 다음 거래일 — 주말+공휴일을 건너뛴다. fromDateStr 은 "이 날짜 자정 이후 첫 거래일"이
 * 필요하므로, fromDateStr 당일이 거래일이면 그날 자체가 아니라 **다음 날부터** 탐색한다
 * (발행이 마감 뒤라 "이 브리프를 실제로 쓸 수 있는 날"은 항상 발행일보다 뒤이기 때문).
 * 최대 14일 앞까지만 본다 — 그 이상 휴장이 이어지는 경우는 없다(달력 오류 방지용 상한).
 */
export function nextTradingDay(fromDateStr: string, market: "KR" | "US"): string {
  const isHoliday = market === "KR" ? isKrxHoliday : isUsHoliday;
  let d = shiftDate(fromDateStr, 1);
  for (let i = 0; i < 14; i++) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0=일 6=토 — 날짜 문자열 기준이라 시간대 무관
    if (wd !== 0 && wd !== 6 && !isHoliday(d)) return d;
    d = shiftDate(d, 1);
  }
  return d;
}
