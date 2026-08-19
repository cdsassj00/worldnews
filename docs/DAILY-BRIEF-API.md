# Stockontology 데일리 브리프 연동 스펙 (유튜브 자동발행용)

인증 불필요·공개 API. 서버 캐시 5분. 필드는 **추가만 되고 삭제·개명되지 않음** (`version` 필드로 호환성 관리).

## 1) 요약 JSON — 영상 대본 재료

```
GET https://stockontology.cc/api/daily-brief            # 한국+미국 모두 (기본)
GET https://stockontology.cc/api/daily-brief?market=KR  # 한국만
GET https://stockontology.cc/api/daily-brief?market=US  # 미국만
```

응답 구조:

```jsonc
{
  "version": 1,
  "date": "2026-08-19",              // KST 기준 날짜
  "site": "https://stockontology.cc",
  "video": {
    "titleSuggestion": "2026-08-19 온톨로지 데일리 — 위험선호 국면 — 순풍 확산 · SK이노베이션 외 4종목",
    "hashtags": ["#온톨로지", "#주식자동매매", "..."]
  },
  "images": [
    { "market": "KR", "cardSvg": "https://stockontology.cc/api/brief-card.svg?market=KR" },
    { "market": "US", "cardSvg": "https://stockontology.cc/api/brief-card.svg?market=US" }
  ],
  "briefs": [
    {
      "market": "KR", "marketKo": "한국",
      "regime": { "label": "위험선호 국면 — 순풍 확산", "tone": "risk-on|caution|risk-off", "riskOff": 0.1, "lines": ["..."] },
      "causal": ["미 10년 금리 +0.64% → 변동성 +2.68% — ...", "..."],   // 인과 사슬 문장들 (대본 핵심)
      "sectors": { "recommend": [{ "sector": "정유화학", "score": 0.42, "reasons": ["..."] }], "avoid": [ ... ] },
      "picks":  [ { "code": "096770", "name": "SK이노베이션", "sector": "정유화학", "score": 0.49,
                    "price": 123456, "priceLabel": "123,456원", "changePct": 5.8, "reason": "..." } ],  // 최대 5개
      "avoid":  [ ... ],                                   // 피할 종목 최대 3개
      "league": { "currency": "KRW|USD",
                  "strategies": [{ "nameKo": "온톨로지", "tagKo": "거시 인과", "live": true, "pnlPct": -1.74, "equity": 5895600 }] },
      "dataAsOf": 1789..., "generatedAt": 1789...
    }
  ],
  "backtestMeasuredAt": "2026-08-19",
  "disclaimer": "본 내용은 ... 투자 자문·권유가 아닙니다. ..."   // 영상에 반드시 포함 권장
}
```

## 2) 이미지 — 온톨로지 경로 카드 (1280×720)

```
GET https://stockontology.cc/api/brief-card.svg?market=KR
GET https://stockontology.cc/api/brief-card.svg?market=US
```

- `image/svg+xml`, CORS 허용(`*`), 1280×720 고정. 거시요인→섹터→종목 인과 다이어그램 + 오늘의 추천 TOP5 + 피할 곳 + 면책 + 브랜딩이 들어간 완성 카드.
- PNG가 필요하면 파이프라인에서 래스터화: 헤드리스 브라우저로 열어 스크린샷 하거나(`sharp`/`resvg`도 가능), 영상 편집 툴이 SVG를 받으면 그대로 사용.
- 폰트는 시스템 산세리프 폴백 — Pretendard가 설치된 환경에서 래스터화하면 사이트와 동일한 룩.

## 3) 권장 파이프라인

1. 매 거래일 **16:10 KST** (한국 마감 후): `daily-brief?market=KR` + `brief-card.svg?market=KR`
2. 매 거래일 **06:10 KST** (미국 마감 후): `market=US` 세트
3. 대본 = `regime.label`(오프닝) → `causal`(왜) → `picks[].name/reason`(무엇) → `league`(성적 공개) → `disclaimer`(클로징)
4. 실패 대비: 응답이 5xx면 5분 후 1회 재시도(서버 캐시 주기와 동일)

## 4) 주의

- 계좌·주문·실계좌 손익은 이 API에 절대 포함되지 않음(공개 데이터만).
- **수익창출 채널에서 종목추천 반복 발행은 유사투자자문업 신고 대상이 될 수 있음** — 수익화 전 금감원 신고 검토 필수. 무료·비수익 + 면책 고지 상태가 가장 안전.
