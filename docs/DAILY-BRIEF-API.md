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
    "symbol": "096770.KS",                   // 야후 심볼 — 코드로 추측하지 말 것 (2026-09-05 추가, §9)
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
GET /api/scene.svg?market=KR&view=strategies:010950    # 차트 전략 13종 합의 + 매매 플랜 (분석 터미널 "차트분석" 탭)
GET /api/scene.svg?market=KR&view=consensus             # §12 요청 3번 — agreement 상위 7종목 × 4엔진 합의 그리드
GET /api/scene.svg?market=KR&view=flow                  # 수급(자금흐름·매집·거래대금) 순위 (분석 터미널 "수급분석" 탭)
GET /api/scene.svg?market=KR&view=combo                 # 온톨로지+수급+차트 조합 순위 (분석 터미널 "조합 전략" 탭)
GET /api/scene.svg?market=KR&view=league               # 전략실 리그 4엔진 카드
GET /api/scene.svg?view=backtest                       # 백테스트 성적표 (7전략 × 두 시장, 챔피언 🏆)
공통 옵션: &animate=1  → 간선 3초 흐름 루프(SMIL) — 브라우저 재생·화면 녹화용. 래스터화 시엔 빼세요.
```

- `view=chart:` 는 최근 최대 90거래일 캔들 + MA20(하늘)/MA60(보라) + 지지(초록 점선)·저항(빨강 점선) 절대가 라벨 + 거래량 막대. 지지·저항은 daily-brief 의 `levels`와 같은 계산(agreement.ts/levels.ts 공유) — 화면과 API 숫자가 어긋나지 않는다.
- `view=strategies:` 는 창시자가 있는 차트 전략 13종(이동평균 교차·MACD·RSI·볼린저·일목균형·터틀·슈퍼트렌드·스토캐스틱·ADX·스테이지·추세템플릿·삼중창·다바스박스) 각각의 매수/중립/매도 판정 + 종합 합의 바 + 추세(단기·중기·장기·ADX) + RSI/MACD/ADX/MFI/%B/ATR 지표 타일 + 매매 플랜(진입 구간·손절가·목표1·2차·손익비, 전부 절대 가격). JSON은 `GET /api/ta?symbol=<야후심볼>&days=180`(공개, 캐시 3분) — 화면과 같은 `taReport()` 계산을 쓴다.
- `view=consensus` 는 `agreement` 배열 그대로를 격자로 그린 것 — 열은 `ENGINE_ORDER = [onto, quant, ta, fusion]` 고정 순서, 파생 엔진(fusion)은 회색 체크로 독립 엔진과 시각적으로 구분된다.
- `view=flow` 는 자금흐름(MFI)·매집강도(CLV 누적)·거래대금 급증 세 신호로 만든 상위 7종목 순위표(-1~1 점수, 근거 문장 포함). JSON은 `GET /api/quant/rank?market=KR|US&profile=flow&limit=20`(공개, 120종목 스캔·14분 주기 갱신).
- `view=combo` 는 온톨로지·수급·차트 세 축을 가중치(기본 34/33/33, "삼합")로 섞은 상위 8종목 순위표 — 점수 없는 축은 빼고 남은 가중치로 재정규화한다("정보 없음 ≠ 나쁨"). JSON은 `GET /api/combo/rank?market=KR|US&onto=&flow=&chart=&limit=`(0~100 정수 가중치, 생략 시 34/33/33).

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

## 8) 분석 터미널 4개 탭 — 콘텐츠용 JSON (2026-09-04 추가)

사이트의 "분석 터미널" 4개 탭이 쓰는 데이터는 전부 **인증 없는 공개 REST** 다. daily-brief 가
"오늘의 결론 한 장"이라면, 이쪽은 **같은 종목을 여러 각도로 파고드는 소재**다(영상 한 편을 채우는 용도).

| 탭 | JSON | 대응 장면(SVG) | 핵심 내용 |
|---|---|---|---|
| 온톨로지 | `GET /api/onto/state` | `view=overview`, `view=stock:<코드>` | 거시요인 값·섹터 민감도·인과 간선(RELATIONS)·거시 간 인과·의미 클러스터 |
| 차트분석 | `GET /api/ta?symbol=<야후심볼>` | `view=strategies:<코드>`, `view=chart:<코드>` | 전략 13종 판정(`strategies[]`: nameKo·author·verdict·score·text), `consensus`, `trend`, `indicators`, `ladder`(지지·저항 사다리 + 근거 출처), `plan`(진입·손절·목표·손익비·체크리스트), `chart`(지표 시계열) |
| 수급분석 | `GET /api/quant/rank?market=&profile=&limit=` | `view=flow` | 종목별 `score`(-1~1) + `parts`(trend/momentum/relStrength/moneyFlow/accum/surge/breakout/overheat) + `reasons[]`(기여도 포함) |
| 조합 전략 | `GET /api/combo/rank?market=&onto=&flow=&chart=&limit=` | `view=combo` | 축별 점수(onto/flow/chart, 없으면 null) + 가중 종합 `total`, 가중치 자유 지정 |

- `profile` 값: `flow`(수급 중심) · `chart`(차트 중심) · `blend`(수급+차트) · `breakout`(돌파 — 리그 2호 엔진과 동일) · `meanrev`(역추세). 생략 시 서버 기본값.
- `/api/ta` 의 `symbol` 은 야후 심볼(한국은 `005930.KS`, 미국은 `AAPL`). scene 쪽은 6자리 코드/티커를 받아 내부에서 변환한다.

### 8-1) 모집단 — 무엇이 배치이고 무엇이 온디맨드인가 (2026-09-04 확장)

| 분석 | 방식 | 모집단 |
|---|---|---|
| 차트분석 (`/api/ta`, `view=strategies:`) | **온디맨드** — 호출 시 계산 | **제한 없음.** 야후에 있는 심볼이면 배치 목록 밖도 즉시 판정(실측 확인). 단 `view=strategies:`/`view=chart:` 는 코드→심볼 변환 때문에 시드 505종목 안에서만 동작하므로, 그 밖은 `/api/ta?symbol=` 을 직접 쓴다 |
| 온톨로지 (`/api/onto/state`, 레이더) | 배치 | 한국 350 + 미국 155 = 505 |
| 수급 (`/api/quant/rank`) | 배치 | 한국 350 + 미국 155 = **505** (2026-09-04 확장 — 이전엔 코스피200 120 + 미국 155) |
| 조합 (`/api/combo/rank`) | 배치 | 위와 동일 505 |

- 응답의 `universe` 는 모집단 크기, `scanned` 는 **지금 점수를 갖고 있는 종목 수**다. 확장분(코스닥150·수동 선정 230종목)은 크론마다 4종목씩 채워져 하루 약 1.5바퀴 회전하므로, 확장 직후에는 `scanned < universe` 가 정상이다. 각 행의 `scannedAt`(ms)으로 신선도를 개별 확인할 수 있다.
- **리그·모의매매 성적(`/api/lab/overview`, `/api/quant/status`)의 모집단은 여전히 코스피200 120 + 미국 155다.** 순위표 모집단(505)과 다르며, 이는 의도된 분리다 — 표시용으로 넓힌 종목을 검증 없이 매매 후보로 쓰지 않기 위해서다. 영상·게시물에서 "리그 성적"을 말할 때 "코스닥 종목도 포함된 성적"이라고 하면 사실과 다르다.
- 전략 13종에는 `author` 필드가 있다(예: "J. Welles Wilder, 1978") — 영상에서 근거 출처를 밝힐 때 그대로 쓰면 된다.
- `plan` 은 전부 **절대 가격**이다. `bias`(long/wait/avoid)·`grade`(good/fair/poor)·`invalidation`(계획이 깨지는 조건 문장)까지 완성 문장으로 온다.
- **엣지 캐시 주의**: scene/카드 SVG 는 `cache-control: public, max-age=300` 이라 Cloudflare 엣지가 URL 단위로 캐시한다. 같은 URL 을 5분 안에 다시 부르면 갱신 전 이미지가 올 수 있으니, 반드시 최신본이 필요하면 무의미한 쿼리 하나(`&cb=<타임스탬프>`)를 붙여 우회한다.

## 9) `symbol` 필드 — 코드→심볼 추측 제거 (2026-09-05 추가)

한국 종목은 거래소에 따라 접미사가 갈린다(코스피 `.KS` / 코스닥 `.KQ`). 코드만 보고 규칙으로
만들면 코스닥 종목에서 조용히 틀린 심볼이 되므로(예: 네오셈 `253590` → `253590.KQ`),
**코드가 등장하는 모든 블록에 야후 심볼을 값으로 실어 보낸다.**

| 블록 | 필드 |
|---|---|
| `picks[]` | `symbol` (미국은 티커와 같은 값) |
| `avoid[]` | `symbol` |
| `agreement[]` | `symbol` |
| `engines[].picks[]` | `symbol` |

- 시드에 없는 코드면 `null` 이다 — 규칙으로 만들어 채우지 않는다(틀린 심볼은 다른 종목의 시세를 가져온다).
- 이 값을 그대로 `/api/ta?symbol=` 에 넣으면 그 종목의 전략 13종 판정·매매 플랜이 나온다
  (배치 목록과 무관한 온디맨드 호출이라 코스닥 소형주도 된다).
- 맵은 `worker/symbols.ts` 한 곳에서 만들고 brief·scene·agreement 가 공유한다.

## 10) `swing` — 스윙 관점 목록 (2026-09-05 추가)

"매일 종목이 바뀌면 신빙성이 떨어진다"에 답하는 블록. **새 예측 모델이 아니다** — 며칠 보유를
전제로 한 점수를 새로 만들면 검증한 적 없는 숫자를 파는 것이라 하지 않았다. 대신 이미 있는
기록으로 **순서만** 매긴다.

```jsonc
"swing": {
  "ruleKo": "오늘 추천 중 최근 보관본에 오래 남아 있던 순으로 고른 목록입니다 — ...",
  "headlineKo": "S-Oil은 6거래일째 같은 이유로 추천에 남아 있습니다 — 오늘 스윙 관점 4종목입니다.",
  "lookbackSessions": 5,
  "picks": [{
    "code": "010950", "symbol": "010950.KS", "name": "S-Oil", "sector": "정유화학",
    "price": 157300, "priceLabel": "157,300원", "changePct": 1.2,
    "appearances": 5, "ofSessions": 5,        // 최근 보관본 5회 중 5회 잔류
    "firstSeenDate": "2026-08-31", "firstSeenPrice": 150800, "changeSincePct": 4.31,
    "independentCount": 1,                     // 파생(융합) 제외한 엔진 수
    "engines": [{ "id": "onto", "nameKo": "온톨로지", "derived": false }],
    "nearestSupport": 151580, "nearestSupportLabel": "5일선", "toSupportPct": -3.6,
    "nearestResistance": 177100, "nearestResistanceLabel": "52주 최고", "toResistancePct": 12.6,
    "stillAboveSupport": true,
    "invalidationKo": "종가가 151,580원(5일선) 아래로 마감하면 이 자리는 깨진 것으로 봅니다",
    "hookKo": "S-Oil — 6거래일째 추천에 남아 있는 종목, 온톨로지 기준 상위 · 지지 5일선 151,580원(-3.6%) / 저항 52주 최고 177,100원(+12.6%)"
  }],
  "note": "최근 보관본 5회와 비교해 잔류 일수·독립 엔진 수 순으로 정렬했습니다. 과거 성과로 거르지 않았습니다."
}
```

- **과거 성과로 거르지 않는다.** 백테스트가 미래를 보장하지 않는데 그걸로 오늘 목록을 막으면
  근거 없는 확신을 근거 있는 척 파는 것과 같다. `changeSincePct`(첫 등장가 대비)는 참고용
  실측이며 **선정 기준이 아니다** — 마이너스면 마이너스로 나온다.
- 정렬: 잔류 횟수 → 독립 엔진 수 → 점수. 매일 최대 4종목이 나오며, 조건 미달로 비는 날은 없다.
- `nearestSupport`/`nearestResistance` 는 **가장 가까운** 자리다(가장 강한 자리가 아니다).
  후보에 스윙 피벗·이동평균(5/20/60/120일선)·52주 고저를 모두 넣고 그중 먼저 닿는 것을 고르며,
  어디서 나온 선인지 `...Label` 로 함께 준다. 저항은 잡음을 피하려 현재가 +2%(또는 0.8×ATR)
  안쪽은 제외한다 — `shared/ta.ts` 의 `tradePlan()` 과 같은 기준.
- `hookKo`/`headlineKo` 는 영상 첫 줄·게시물 캡션에 그대로 쓰라고 만든 완성 문장이며,
  전부 실측값으로만 조립한다(보유 기간이나 수익률을 약속하는 표현은 넣지 않는다).
- 대응 장면: `GET /api/scene.svg?market=KR|US&view=swing` (1920×1080, 상위 4종목 카드).

## 11) `showcase` · 콘텐츠 포지셔닝 (2026-09-05 추가)

**사이트와 콘텐츠는 역할이 다르다.** 사이트(stockontology.cc)는 백테스트로 전략을 검증·평가하는
곳이고, SNS·유튜브 콘텐츠는 **스윙 관점 종목 소개 + 시스템 소개**다. 그래서 콘텐츠 파이프라인은
`swing` 과 `showcase` 를 주재료로 쓰고, 리그 성적·백테스트는 근거를 뒷받침할 때만 인용한다.

```jsonc
"showcase": {
  "oneLinerKo": "유가·금리·환율 같은 거시요인 14개가 어떤 업종을 밀고 당기는지 그래프로 연결해 두고, 매일 505종목을 훑어 ...",
  "factsKo": [ "거시요인 14개 · 거시끼리의 인과 20개 · 거시→섹터 민감도 71개(업종 19개)를 ...", "..." ],
  "numbers": { "macroFactors": 14, "macroLinks": 20, "sectorEdges": 71, "sectors": 19,
               "ontologyTickers": 89, "scanUniverse": 505, "engines": 4, "chartStrategies": 13,
               "backtestMeasuredAt": "2026-09-04" },
  "disclaimerKo": "백테스트는 과거 데이터로 규칙을 되돌려 본 실험이며 미래 수익을 보장하지 않습니다. ..."
}
```

- 숫자는 **호출 시점에 코드·시드에서 직접 센다.** 유니버스를 넓히거나 전략을 추가하면 문장도
  같이 바뀐다 — 사람이 고쳐 쓰는 홍보 문구를 두면 언젠가 실제와 어긋나고, 그 순간 과장 광고가 된다.
- 넣지 않는 것: 수익 약속, "적중률 N%" 같은 미래형 표현, 실계좌 금액.

### 11-1) 나레이션 순서 — `speech`

콘텐츠 한 편은 이 순서로 읽으면 완성된다(전부 TTS 용 완성 문장):

| 순서 | 필드 | 내용 |
|---|---|---|
| 1 | `speech.system` | 이 시스템이 무엇인지 (showcase 한 줄) |
| 2 | `speech.opening` · `speech.narrative` | 오늘 국면과 그 지속·전환 |
| 3 | `speech.swingIntro` | 오늘 스윙 관점 요약 ("○○은 6거래일째 남아 있습니다") |
| 4 | `speech.swing[]` | 종목별 — 며칠째 + 왜(온톨로지 인과) + 지지·저항 |
| 5 | `speech.closing` | 면책 |

`swing.picks[].whyKo` 는 그 종목이 뽑힌 근거 문장 그대로다(예: "유가(WTI) +9.38% → 정유화학
민감도 +0.65"). 가공하지 않고 인용하면 "왜 이 종목인지"가 자동으로 설명된다 — 시스템 자랑과
종목 소개가 같은 문장에서 이어지는 지점이라, 콘텐츠에서 가장 중요한 필드다.
