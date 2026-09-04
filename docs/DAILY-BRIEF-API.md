# Stockontology 데일리 브리프 연동 스펙 v3 (유튜브 자동발행용)

인증 불필요·공개 API. 서버 캐시 5분. **필드는 추가만 되고 삭제·개명되지 않음** (`version` 관리).
2026-09-04 파이프라인 요청서(8항목) 반영판 — v2 대비 추가분은 §7~§10.

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
    "isNew": true, "daysInList": 1,           // 신규/연속 등장일 (2-4)
    "levels": {                               // §7 절대 가격 지지·저항 (2026-09-04 요청 1번) — null 가능
      "support": [{ "price": 33500, "touches": 2, "lastTouchDate": "2026-07-14" }],
      "resistance": [{ "price": 36200, "touches": 3, "lastTouchDate": "2026-08-22" }],
      "ma": { "ma5": 34800, "ma20": 34100, "ma60": 32900, "ma120": 31500 },
      "week52": { "high": 39200, "low": 24100 },
      "atr14": 820,
      "volume": { "today": 1834200, "avg20": 1502300 },
      "levelNote": "36,200은 최근 3번 저항받은 자리(최근 8월)입니다"
    } | null,
    "horizonDays": 7,                         // §8 이 엔진의 실측 평균 보유일 (요청 7번) — null 가능
    "horizonNote": "이 엔진의 최근 1년 백테스트 평균 보유 7일(3개월 3일·6개월 4일) — 실측값이며 종목별 예측이 아닙니다"
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
      "derived": false,                       // §9 다른 엔진의 조합인가 (요청 3번) — fusion만 true
      "leaguePnlPct": -4.29,                  // 실시간 리그(모의) 수익률
      "horizonDays": 7, "horizonNote": "...", // §8 이 엔진의 실측 평균 보유일 — null 가능
      "picks": [{ "code","ticker","name","sector","score","price","priceLabel","changePct",
                  "reasons": ["유가(WTI) +2.14% → 정유화학 민감도 +0.65"] }] },
    { "id": "quant",  "nameKo": "수급·차트",  "derived": false, "picks": [{ "reasons": ["추세 — 20일선 +17.7% · 20/60선 정배열"] }] },
    { "id": "ta",     "nameKo": "차트 거장",  "derived": false, "picks": [{ "reasons": ["차트 거장 13종 전략 합의 점수 +0.43 (이평·MACD·일목·터틀 등)"] }] },
    { "id": "fusion", "nameKo": "융합",       "derived": true,  "picks": [{ "reasons": ["온톨로지 +0.53 와 수급 +0.89 가 모두 긍정 — 반반 평균"] }] }
  ],
  "agreement": [                              // §9 엔진 합의 — API가 직접 계산 (요청 3번)
    { "code": "096770", "name": "SK케미칼", "sector": "정유화학",
      "independentCount": 2,                  // derived=false 인 엔진들끼리만 카운트 (이중 카운트 방지)
      "engines": [
        { "id": "onto", "nameKo": "온톨로지", "derived": false, "reason": "유가(WTI) +2.14% → 정유화학 민감도 +0.65" },
        { "id": "quant", "nameKo": "수급·차트", "derived": false, "reason": "추세 — 20일선 +17.7%" },
        { "id": "fusion", "nameKo": "융합", "derived": true, "reason": "..." }
      ],
      "inHeadlineList": true }
    // 정렬: independentCount desc → 기여(파생 제외) 엔진들의 리그 누적수익률 합 desc → 최고 점수 desc
    // hits(엔진 수) < 2 인 종목은 목록에서 빠짐(합의가 아니므로)
  ],
  "sectors": { "recommend": [...], "avoid": [...], "all": [ /* 상위4 제한 없는 전 섹터 — §11 요청 6번 */ ] },
  "dataSessionDate": "2026-09-04",            // §10 이 데이터가 실제로 속한 거래일 (요청 4·5번)
  "targetSession": "2026-09-05",              // 공휴일 인식 다음 거래일 — 이 픽이 "언제 장"을 향한 것인지
  "sessionClosed": true,                      // basis !== "intraday" 와 동치 — 신선도 판정용 불리언
  "league": { "currency", "strategies": [{ "nameKo", "tagKo", "live", "pnlPct", "equity" }] },
  "dataAsOf": 1787103911000, "generatedAt": 1787103911000
}
```

- `marketCap` 은 현재 시세 소스에 없어 미제공. 초소형주 걱정은 유니버스 자체가 코스피200·KQ150·S&P 주요 종목이라 완화됨.
- `titleSuggestion` 은 참고용 — 재작성 자유.
- 위 `sectors`, `dataSessionDate`, `targetSession`, `sessionClosed`, `agreement` 는 `briefs[]` 각 시장 블록 최상위 필드다(engines/league와 같은 레벨).

## 2) 이미지

```
GET https://stockontology.cc/api/brief-card.svg?market=KR            # 1280×720 (16:9)
GET https://stockontology.cc/api/brief-card.svg?market=KR&ratio=9:16  # 720×1280 (쇼츠)
GET https://stockontology.cc/api/brief-card.svg?market=KR&ratio=1:1   # 1080×1080 (SNS 정사각) — §12 요청 8번
```

- `ratio=1:1` 카드는 상단 국면 헤드라인 + agreement 상위 3종목(합의 엔진 이름 나열)만 담은 짧은 레이아웃 — 정사각 피드용으로 텍스트를 줄였다. 세로형(9:16)은 기존 720×1280 을 그대로 쓰면 된다(스토리·릴스 규격과 동일 비율).

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
| `sessionClosed` | true 권장 | `basis!=="intraday"`와 동치인 불리언 — `basis` 문자열 비교 대신 이 값 하나로 판정 가능 (v3) |

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
GET /api/scene.svg?market=KR&view=chart:010950         # §12 요청 2번 — 일봉 캔들 + MA20/60 + 지지·저항선 + 거래량
GET /api/scene.svg?market=KR&view=consensus             # §12 요청 3번 — agreement 상위 7종목 × 4엔진 합의 그리드
GET /api/scene.svg?market=KR&view=league               # 전략실 리그 4엔진 카드
GET /api/scene.svg?view=backtest                       # 백테스트 성적표 (7전략 × 두 시장, 챔피언 🏆)
공통 옵션: &animate=1  → 간선 3초 흐름 루프(SMIL) — 브라우저 재생·화면 녹화용. 래스터화 시엔 빼세요.
```

- `view=chart:` 는 최근 최대 90거래일 캔들 + MA20(하늘)/MA60(보라) + 지지(초록 점선)·저항(빨강 점선) 절대가 라벨 + 거래량 막대. 지지·저항은 daily-brief 의 `levels`와 같은 계산(agreement.ts/levels.ts 공유) — 화면과 API 숫자가 어긋나지 않는다.
- `view=consensus` 는 `agreement` 배열 그대로를 격자로 그린 것 — 열은 `ENGINE_ORDER = [onto, quant, ta, fusion]` 고정 순서, 파생 엔진(fusion)은 회색 체크로 독립 엔진과 시각적으로 구분된다.

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

## 7) v3 신규 필드 — 2026-09-04 요청서 8항목 반영 요약

요청서 우선순위(1>3>4>2>5>6>7>8) 순.

| # | 요청 | 필드/엔드포인트 | 위치 |
|---|---|---|---|
| 1 | 지지·저항 절대가 | `picks[].levels` (support/resistance/ma/week52/atr14/volume) | §1 picks 블록 |
| 3 | 엔진 합의 (API가 직접 계산) | `agreement[]`, `engines[].derived` | §1 briefs 블록 |
| 4 | 다음 거래일(공휴일 인식) | `targetSession`, `dataSessionDate` | §1 briefs 블록 |
| 2 | 차트 장면 (캔들+이평+지지저항+거래량) | `GET /api/scene.svg?view=chart:<code>` | §5 |
| 5 | 신선도 판정 보강 | `sessionClosed`(불리언, `basis!=="intraday"`와 동치) | §1 briefs 블록, §3-1 표에 추가 |
| 6 | 섹터 화면 404 수정 | `sectors.all`(상위4 제한 없는 전 섹터), scene.svg?view=sector: 이 여기서도 검색 | §1, §5 |
| 7 | 픽 유효 기간 | `picks[].horizonDays`/`horizonNote`, `engines[].horizonDays`/`horizonNote` — 백테스트 실측 평균 보유일(3/6/12개월 중 1년 대표값). 종목별 예측이 아니라 **그 엔진의 과거 평균 보유 기간**이라는 점 주의 | §1 |
| 8 | SNS 카드 1:1 | `GET /api/brief-card.svg?ratio=1:1` (1080×1080) | §2 |

`agreement`/`sectors.all`/`chart:`/`consensus`는 모두 daily-brief 응답과 계산을 공유한다(`worker/agreement.ts`, `worker/levels.ts`) — 화면·영상·API가 다른 숫자를 말할 위험이 없다.

지지·저항이 없는 종목(상장 1년 미만이거나 유효한 스윙 피벗이 2회 이상 겹치지 않는 경우)은 `levels: null` 이 온다 — **추정으로 채우지 않는다는 원칙**이라 빈 값을 그대로 다뤄야 한다(예: "지지선 정보 없음"으로 대본 분기).
