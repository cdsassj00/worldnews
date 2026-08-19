# Stockontology 데일리 브리프 연동 스펙 v2 (유튜브 자동발행용)

인증 불필요·공개 API. 서버 캐시 5분. **필드는 추가만 되고 삭제·개명되지 않음** (`version` 관리).
2026-08-19 파이프라인 요청서 반영판.

## 1) 요약 JSON

```
GET https://stockontology.cc/api/daily-brief                # 한국+미국 (기본)
GET https://stockontology.cc/api/daily-brief?market=KR|US
GET https://stockontology.cc/api/daily-brief?market=KR&date=2026-08-20   # 과거 보관본
```

- `date` 과거 날짜: **보관본을 그대로 반환**(`archived: true`). 보관이 없으면 **404** `no_archive_for_date` — 조용히 오늘 것을 주지 않음. 보관은 각 날짜의 마지막 계산본, 45일.
- `dataAsOf`, `generatedAt`, `balance`류 타임스탬프는 전부 **밀리초 epoch**.
- `backtestMeasuredAt` 은 매 거래일 16:40 KST 재측정 — 오전 응답에서 전 거래일 날짜인 것이 정상.

### briefs[] 각 시장 블록

```jsonc
{
  "market": "KR", "marketKo": "한국",
  "basis": "prev_close" | "intraday" | "post_close",   // 이 스냅샷의 기준 (2-3)
  "basisNote": "종목 시세·점수는 레이더 최근 스캔값(장중 최대 약 1시간 전), 거시 신호는 호출 시점 기준...",
  "regime": { "label", "tone", "riskOff", "lines": [] },
  "causal": ["미 10년 금리 +0.47% → 변동성 +3.66% — ..."],   // 시장별로 분리됨 (1-1 수정)
  "sectors": { "recommend": [{ "sector", "score", "reasons": [] }], "avoid": [...] },
  "picks": [{
    "code": "096770", "ticker": null,        // 미국은 ticker=거래소 티커, 한국은 null (2-6)
    "name", "sector", "score", "price", "priceLabel", "changePct",
    "reason": "짧은 한 줄",
    "reasons": ["유가(WTI) +2.09% → 에너지 민감도 +0.85", "..."],   // 종목별 실제 기여 (1-3)
    "isNew": true, "daysInList": 1            // 신규/연속 등장일 (2-4)
  }],
  "avoid": [ ...picks 와 동일 구조(isNew 없음)... ],
  "dropped": [{ "code", "name", "reason": "오늘 점수가 상위권에서 밀렸습니다" }],   // (2-4)
  "previous": {                               // 어제 추천 채점 (2-1) — 발행 이력 쌓인 다음 날부터
    "date": "2026-08-19",
    "basisNote": "기준가 = 추천일 마지막 브리프 생성 시점의 시세 · 비교가 = 이번 응답 생성 시점의 레이더 시세",
    "picks": [{ "code", "name", "recPrice", "nowPrice", "changePct" }],
    "hitRate": 0.6, "avgChangePct": 1.8
  } | null,
  "speech": {                                 // TTS 용 완성 문장 (2-5)
    "opening": "오늘 한국 시장은 위험선호 국면, 순풍 확산입니다.",
    "causal": ["..."], "picks": ["첫 번째는 ...입니다. ..."], "closing": "..."
  },

  "engines": [                                // 분석 엔진별 추천 + 근거 (전략실 리그와 동일 점수)
    { "id": "onto",   "nameKo": "온톨로지",   "tagKo": "거시 인과",     "descKo": "...",
      "live": true,                           // 지금 실계좌를 움직이는 엔진인가
      "leaguePnlPct": -4.29,                  // 실시간 리그(모의) 수익률
      "picks": [{ "code","ticker","name","sector","score","price","priceLabel","changePct",
                  "reasons": ["유가(WTI) +2.14% → 정유화학 민감도 +0.65"] }] },
    { "id": "quant",  "nameKo": "수급·차트",  "picks": [{ "reasons": ["추세 — 20일선 +17.7% · 20/60선 정배열"] }] },
    { "id": "ta",     "nameKo": "차트 거장",  "picks": [{ "reasons": ["차트 거장 13종 전략 합의 점수 +0.43 (이평·MACD·일목·터틀 등)"] }] },
    { "id": "fusion", "nameKo": "융합",       "picks": [{ "reasons": ["온톨로지 +0.53 와 수급 +0.89 가 모두 긍정 — 반반 평균"] }] }
  ],
  "league": { "currency", "strategies": [{ "nameKo", "tagKo", "live", "pnlPct", "equity" }] },
  "dataAsOf": 1787103911000, "generatedAt": 1787103911000
}
```

- `marketCap` 은 현재 시세 소스에 없어 미제공. 초소형주 걱정은 유니버스 자체가 코스피200·KQ150·S&P 주요 종목이라 완화됨.
- `titleSuggestion` 은 참고용 — 재작성 자유.

## 2) 이미지

```
GET https://stockontology.cc/api/brief-card.svg?market=KR            # 1280×720 (16:9)
GET https://stockontology.cc/api/brief-card.svg?market=KR&ratio=9:16  # 720×1280 (쇼츠)
```

- SVG 안에 Pretendard 웹폰트 `@import` 포함(jsdelivr) — 래스터화 환경이 네트워크만 되면 사이트와 같은 글꼴. 오프라인 래스터화면 시스템 산세리프 폴백.
- CORS `*`, 캐시 5분.

## 3) 권장 파이프라인

1. 한국편: 장 마감 후 16:10 KST 또는 다음날 개장 전(이때 `basis`가 "prev_close"로 나오니 영상에서 "어제 종가 기준"이라 말하면 됨)
2. 미국편: 마감 후 06:10 KST
3. 대본: `speech`(온톨로지 기준) 또는 `engines[]`(4개 분석 방식별 추천+근거 — 자유 가공) → `previous`(어제 채점, 선택) → `disclaimer`
4. 5xx 시 5분 후 1회 재시도

## 4) 주의
- 계좌·주문·실계좌 손익은 절대 포함되지 않음(공개 데이터만).
- 수익창출 채널에서 종목추천 반복 발행은 유사투자자문업 신고 대상이 될 수 있음 — 무료·비수익 + 면책 고지 권장.
