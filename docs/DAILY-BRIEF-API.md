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

### 3-1) 신선도 검사 — 발행 전 필수 (2026-08-20 추가)

브리핑은 **호출 시점에 실시간 계산**된다(밤에 도는 별도 배치가 없다). 그래서 "어제 파일이 그대로 남는" 실패는 없지만, 시세 수집이 멈추면 오래된 시세로 계산될 수 있다. 발행 전에 `briefs[]`의 각 항목에서 다음을 검사하고, 하나라도 어긋나면 그날 발행을 건너뛴다:

| 필드 | 검사 | 의미 |
|---|---|---|
| `date` (최상위) | == 오늘(KST) | 오늘자 응답인지 |
| `basis` | != "intraday" | 마감 데이터인지 (장중이면 숫자가 계속 변함) |
| `generatedAt` (ms) | — | 이 응답을 계산한 시각. 항상 지금이므로 검사 불필요 |
| `dataAsOf` (ms) | 존재 | 이 시장 시세의 마지막 갱신 시각 |
| `dataAgeMinutes` | < 720 | 시세가 12시간 이내인지. 초과 = 수집 장애 → 건너뛰기 |

**basis 는 시장별로 다르게 나오는 게 정상이다.** 한국 저녁(17시 이후 KST)에 부르면 KR="post_close", US="prev_close" — 미국장은 그날 아침 5시(KST)에 끝난 것이 최신이므로 prev_close 가 맞다. 영상에서는 "미국은 오늘 아침 마감 기준"이라고 말하면 된다.

**크론 권장 시각: 17:30 KST (월~금).** 근거:
- 한국장 15:30 마감 → 16:00부터 마감 시세 반영 시작, 17시대면 상위 종목은 종가 기준으로 안정.
- 미국장은 그날 아침 05:00 KST(서머타임) 마감 — 17:30이면 이미 12시간 지난 확정 데이터.
- 한 번의 호출로 한국편+미국편 소재를 모두 확보할 수 있는 시각이다.
- 미국편을 미국 마감 직후 따로 만들려면 06:10 KST에 별도 호출(US만 사용).

## 4) 주의
- 계좌·주문·실계좌 손익은 절대 포함되지 않음(공개 데이터만).
- 수익창출 채널에서 종목추천 반복 발행은 유사투자자문업 신고 대상이 될 수 있음 — 무료·비수익 + 면책 고지 권장.

## 5) 장면(Scene) API — 영상용 화면 (v3 방안 A)

```
GET /api/scene.svg?market=KR|US&view=overview          # 전체 그래프 (거시→섹터→종목 3층)
GET /api/scene.svg?market=KR&view=sector:정유화학        # 섹터 하나 강조 + 인과 화살표 + 근거
GET /api/scene.svg?market=KR&view=stock:010950         # 종목 상세: 합성 점수 분해(0.35/0.45/0.2) + 온톨로지 경로 + 근거  ← 매일 5회용
GET /api/scene.svg?market=KR&view=league               # 전략실 리그 4엔진 카드
GET /api/scene.svg?view=backtest                       # 백테스트 성적표 (7전략 × 두 시장, 챔피언 🏆)
공통 옵션: &animate=1  → 간선 3초 흐름 루프(SMIL) — 브라우저 재생·화면 녹화용. 래스터화 시엔 빼세요.
```

- **1920×1080 고정, 완성본만 응답** — 대기·ready 플래그 불필요, UI 크롬 없음, 배치 결정론(정렬 데이터 기반).
- SVG → PNG: `sharp(svg).png()` 또는 `resvg` 한 줄. **브라우저 불필요** (Pretendard 웹폰트만 온라인 필요 — 오프라인이면 시스템 산세리프 폴백).
- `view=stock:` 은 6자리 한국 코드 또는 미국 티커. 없는 종목/섹터는 404.
- 캐시 5분 · CORS `*` · 공개 데이터만. **매매 일지(손절 기록) 장면은 제공하지 않습니다** — 실계좌 데이터는 운영자 전용이라 API 로 내보내지 않는 원칙입니다(대표 영상용은 운영자가 직접 캡처).
- 쇼츠 세로 구도는 기존 `brief-card.svg?ratio=9:16` 사용.

## 6) narrative — 국면 지속·전환 서사 (2026-08-20 추가)

"추천이 매일 비슷해 보인다"에 답하는 블록. 온톨로지는 국면 추종이라 국면이 유지되는 동안
같은 섹터 클러스터가 이어지는 게 정상이며, 그 지속/전환을 숫자와 완성 문장으로 준다.

```jsonc
"narrative": {
  "regime": { "tone": "risk-on", "label": "위험선호 국면 — 순풍 확산",
              "streakDays": 2,            // 같은 국면 연속 일수 (발행 이력 기준)
              "changed": false, "prevLabel": "..." },
  "sectors": { "kept": ["정유화학"], "entered": ["증권","2차전지"], "left": ["금융"] },
  "pickTurnover": { "changed": 5, "total": 5 },
  "summaryKo": "위험선호 국면이 2일째 이어지고 있습니다. 추천 섹터는 정유화학이 유지되고 ... 같은 순풍 안에서 로테이션한 것입니다.",
  "meaningKo": "온톨로지는 국면 추종 전략입니다 — ... 가치는 국면이 꺾이는 날 먼저 갈아타는 데 있습니다."
}
```

- `speech.narrative` 에 같은 문장이 TTS 용으로 들어간다 — 오프닝 바로 뒤에 읽으면 된다.
- 국면 전환일에는 summaryKo 가 "국면이 바뀌었습니다 — ...온톨로지가 갈아타는 날입니다" 형태가 된다.
  이 날이 시리즈의 하이라이트 회차다.
- streakDays·섹터 비교는 발행 이력(45일 보관) 기준 — 발행을 거를수록 어제 비교가 그만큼 멀어진다.
