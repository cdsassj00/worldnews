# WORLD FINANCE GLOBE

3D 지구본에서 나라를 클릭하면 그 나라의 **금융 뉴스 → 지수·종목 점수 → 매수/매도 주문**까지 한 화면에서 이어지는 Cloudflare Workers 사이트.

- 지구본: Three.js. 175개국을 픽 텍스처 방식으로 정확히 클릭 판정한다.
- 뉴스: Google News → Bing News → Yahoo Finance 3단 폴백 (현지어 + 한국어 기사를 합쳐 중복 제거).
- 시세: Yahoo Finance 차트 API (무인증). 43개 시장의 지수와 대표 종목.
- 추천: 가격 지표 7종 + 뉴스 감성 사전으로 점수화하고 ATR 기반 손절·목표가를 제시한다.
- AI 분석: Claude(키 있으면) 또는 Cloudflare Workers AI(키 없이)로 국가별 한국어 브리핑을 만든다.
- 주문: 한국투자증권(KIS) OpenAPI. 국내(KRX)와 미국·일본·홍콩·상해·심천 종목을 매수/매도한다.

> **투자 자문이 아닙니다.** 화면의 점수·의견은 공개 지표와 뉴스 키워드로 계산한 참고 자료이며 어떤 수익도 보장하지 않습니다. 매매 판단과 책임은 이용자 본인에게 있습니다.

---

## 1. 구조

```
index.html            화면 셸(상단 티커테이프 / 좌측 요약 / 지구본 / 우측 패널)
src/
  main.ts             부트스트랩·상태 연결·모달
  globe.ts            Three.js 지구본, 국가 픽 판정, flyTo
  panel.ts            국가 패널(뉴스 / 추천 / 주문 탭)
  api.ts              Worker API 클라이언트, 거래 암호 보관
  format.ts           숫자·시간 포맷, DOM 헬퍼, 스파크라인
  style.css           다크 데이터덴스 테마(상승 빨강 / 하락 파랑)
worker/
  index.ts            API 라우터 + 정적 자산 서빙
  news.ts             뉴스 제공처 3단 폴백 + 제공처 건강 상태 기억
  quotes.ts           Yahoo Finance 시세/일봉
  recommend.ts        점수 엔진(모멘텀·추세·밴드·거래량·뉴스·변동성)
  sentiment.ts        다국어 금융 감성 사전
  analysis.ts         AI 브리핑(Claude / Workers AI 폴백)
  kis.ts              KIS 토큰·시세·잔고·주문·취소 + 안전장치
  http-socket.ts      9443 포트용 TLS 소켓 HTTP/1.1 클라이언트(폴백)
shared/markets.ts     국가별 지수·종목·뉴스 로케일·KIS 주문 코드 표
scripts/
  build-data.mjs      world-atlas TopoJSON + 국가명(한국어)·중심좌표 생성
  validate-symbols.mjs Yahoo 심볼 생존 확인
  e2e-check.mjs       브라우저 실검증(픽 정확도·패널·모바일)
```

### API

| 메서드 | 경로 | 설명 | 인증 |
|---|---|---|---|
| GET | `/api/config` | KIS 연동 상태 + 시장 목록 | - |
| GET | `/api/tape` | 글로벌 지수·환율·원자재 스냅샷 | - |
| GET | `/api/global/news` | 글로벌 헤드라인 | - |
| GET | `/api/country/:cc/overview` | 지수·환율·장 시간 | - |
| GET | `/api/country/:cc/news` | 국가 금융 뉴스 | - |
| GET | `/api/country/:cc/recommend` | 종목 점수·매매 계획 | - |
| GET | `/api/country/:cc/analysis` | AI 한국어 브리핑(요약·주목종목·리스크·체크리스트) | - |
| GET | `/api/quote?symbol=` | 개별 심볼 시세/일봉 | - |
| GET | `/api/kis/status` | 주문 스위치·계좌 모드 | - |
| GET | `/api/kis/price` | KIS 실시간 현재가 | 거래 암호 |
| POST | `/api/kis/balance` | 잔고·보유종목 | 거래 암호 |
| POST | `/api/kis/order` | 매수/매도 주문 | 거래 암호 |
| POST | `/api/kis/cancel` | 국내 주문 취소 | 거래 암호 |

응답은 KV로 캐시한다(뉴스 10분, 시세 2분, 추천 5분, 티커 90초). 업스트림이 죽으면 만료된 캐시를 stale 로 돌려준다.

---

## 2. 로컬 실행

```bash
npm install
npm run build          # 지도 데이터 생성 + Vite 빌드
npx wrangler dev       # http://127.0.0.1:8787
```

시크릿은 `.dev.vars` 에 넣는다(`.dev.vars.example` 참고, git 에 커밋되지 않음).

검증:

```bash
npm run typecheck            # tsc (웹/워커 프로젝트 분리)
npm run validate:symbols     # Yahoo 심볼 생존 확인
node scripts/e2e-check.mjs   # 실제 브라우저로 지구본·패널·모바일 검증
```

---

## 3. 키를 어디에 넣나 (한눈에)

**모든 키는 Cloudflare 시크릿으로만 넣는다. 코드·저장소·PR에 절대 쓰지 않는다.**

| 넣는 위치 | 이름 | 무엇에 쓰이나 | 없으면 |
|---|---|---|---|
| `wrangler secret put` | `KIS_APP_KEY` | 한국투자증권 앱키 | 주문·잔고·KIS 시세 전체 잠김 |
| `wrangler secret put` | `KIS_APP_SECRET` | 한국투자증권 앱시크릿 | 위와 동일 |
| `wrangler secret put` | `KIS_ACCOUNT` | 계좌번호 `12345678-01` | 위와 동일 |
| `wrangler secret put` | `TRADE_TOKEN` | 주문·잔고 화면 접근 암호(내가 정하는 값) | `/api/kis/*` 가 503으로 잠김 |
| `wrangler secret put` | `ANTHROPIC_API_KEY` | AI 브리핑을 Claude로 처리 | Workers AI로 자동 폴백(키 불필요) |
| `wrangler.jsonc` `vars` | `KIS_ENV` | `prod`=실전(9443) / `vts`=모의(29443) | 기본 `vts` — **실전 키는 `prod` 로 바꿔야 토큰이 나온다** |
| `wrangler.jsonc` `vars` | `ORDER_DRY_RUN` | `true`면 검증만, 주문 전송 안 함 | 기본 `true` (안전) |
| `wrangler.jsonc` `vars` | `ORDER_ENABLED` / `ORDER_ALLOW_REAL` | 실주문 2단 스위치 | 기본 `false` — 실주문 불가 |
| `wrangler.jsonc` `vars` | `MAX_ORDER_NOTIONAL_KRW` | 1회 주문 한도(원) | 기본 `100000` |
| `wrangler.jsonc` `ai` 바인딩 | (키 없음) | Workers AI | 이미 설정돼 있음 |

시세(Yahoo)와 뉴스(Google·Bing)는 **키가 필요 없다**. 로컬 개발에서는 같은 이름을 `.dev.vars` 에 넣는다(git 무시됨).

```bash
# 실전 계좌 + AI(Claude) 조합 예시
npx wrangler secret put KIS_APP_KEY
npx wrangler secret put KIS_APP_SECRET
npx wrangler secret put KIS_ACCOUNT        # 12345678-01
npx wrangler secret put TRADE_TOKEN        # 길게, 추측 불가하게
npx wrangler secret put ANTHROPIC_API_KEY  # 선택 — 없으면 Workers AI 사용
# wrangler.jsonc 에서 KIS_ENV 를 "prod" 로 바꾼 뒤
npm run deploy
```

---

## 4. Cloudflare 배포

현재 배포 주소: **https://worldnews.sjshin.workers.dev**


```bash
# 1) KV 네임스페이스 (이미 wrangler.jsonc 에 id 가 들어있다. 새로 만들려면)
npx wrangler kv namespace create CACHE

# 2) 시크릿 등록 — 저장소에 절대 넣지 않는다
npx wrangler secret put KIS_APP_KEY
npx wrangler secret put KIS_APP_SECRET
npx wrangler secret put KIS_ACCOUNT       # 예: 12345678-01
npx wrangler secret put TRADE_TOKEN       # 주문/잔고 API 접근 암호(길게)

# 3) 배포
npm run deploy
```

### 환경변수 전체 (wrangler.jsonc `vars`)

| 이름 | 기본값 | 의미 |
|---|---|---|
| `KIS_ENV` | `vts` | `vts`=모의투자, `prod`=실전투자 |
| `ORDER_ENABLED` | `false` | 주문 전송 마스터 스위치 |
| `ORDER_ALLOW_REAL` | `false` | 실전 주문 2차 확인(prod 에서도 이 값이 true 여야 전송) |
| `MAX_ORDER_NOTIONAL_KRW` | `1000000` | 1회 주문 금액 상한(원화 환산) |
| `KIS_TRANSPORT` | `auto` | `auto`/`fetch`/`socket` — KIS 호출 방식 |
| `KIS_TRID_OVERRIDES` | (없음) | TR_ID 표를 덮어쓰는 JSON 시크릿 |
| `KIS_OVERSEAS` | `auto` | 해외주식 주문 허용. `auto`=모의에선 차단·실전에선 허용, `on`/`off` 강제 |
| `ORDER_DRY_RUN` | `true` | `true`면 인증·한도·TR_ID 검증만 하고 주문을 전송하지 않는다 |
| `AI_MODEL` | `claude-opus-5` | Claude 모델 ID |
| `WORKERS_AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI 모델 ID |

### 주문을 실제로 켜는 순서

**모의투자 계좌가 있는 경우**

1. `KIS_ENV=vts`, `ORDER_DRY_RUN=false`, `ORDER_ENABLED=true` 로 배포 → 잔고 조회 → 1주 매수 → 체결 확인.
2. 실전 전환: `KIS_ENV=prod` + `ORDER_ALLOW_REAL=true` 를 **함께** 바꾼다. 하나만 바꾸면 서버가 거부한다.

**실전 계좌 키만 있는 경우(모의 계좌 없음)**

1. `KIS_ENV=prod` 로 배포하고 시크릿을 등록한다. `ORDER_DRY_RUN=true` 가 기본이므로 아직 아무 주문도 나가지 않는다.
2. **조회로 연결 확인**: 거래 암호를 입력하고 잔고 조회를 눌러 실제 보유 종목이 나오는지 본다(주문 스위치와 무관하게 동작).
3. **검증 모드로 전 과정 점검**: 주문 탭에서 1주 주문을 넣어 본다. 인증·한도·TR_ID까지 실제로 확인하고 KIS에는 전송하지 않는다.
4. **실주문**: `ORDER_DRY_RUN=false`, `ORDER_ENABLED=true`, `ORDER_ALLOW_REAL=true` 로 배포한다. 한도(`MAX_ORDER_NOTIONAL_KRW`)는 처음에 10만원 그대로 두고, 1주 체결을 확인한 뒤 올린다.

---

## 5. AI 분석

`/api/country/:cc/analysis` 는 이 서비스가 이미 계산한 지수·뉴스 제목·종목 점수와 근거를 모델에 넣고, 한국어 브리핑(3줄 요약 / 주목 종목 / 리스크 / 확인할 것)을 받아 15분 캐시한다.

- `ANTHROPIC_API_KEY` 가 있으면 **Claude**(`claude-opus-5`, 공식 SDK, JSON 스키마 강제 출력)를 쓴다.
- 없으면 **Cloudflare Workers AI** 로 폴백한다. 별도 키가 필요 없고 배포 환경에서 약 9초에 응답한다.
- 프롬프트에 "입력한 지표·뉴스만 근거로 쓰고 새 수치를 만들지 말 것", "수익을 약속하지 말 것", "한자 없이 한글로 쓸 것"을 명시했다.
- 비용 때문에 탭을 처음 열 때만 호출하고, 결과는 국가별로 캐시한다.

---

## 6. 보안

- **주문 API는 공개하지 않는다.** `/api/kis/*` 는 `TRADE_TOKEN` 베어러 인증을 통과해야 한다. 토큰이 없으면 503으로 잠긴다. 사이트 자체는 공개돼도 주문은 암호를 아는 사람만 낼 수 있다.
- 브라우저는 거래 암호를 `sessionStorage` 에만 두고, 서버는 저장하지 않는다.
- 주문 전송에는 이중 확인이 걸려 있다: 모달에서 **종목코드를 다시 입력**해야 하고, 서버가 그 값을 코드와 다시 비교한다.
- KIS 앱키/시크릿은 저장소·PR·이슈에 절대 넣지 않는다. 채팅·메일 등으로 노출된 키가 있다면 **KIS Developers 에서 즉시 재발급**하고 새 값으로 `wrangler secret put` 하라.
- 접근 토큰은 KV에 캐시한다(만료 10분 전 갱신). KIS는 토큰 발급 호출 빈도를 제한하므로 캐시를 끄지 말 것.

---

## 7. 추천 점수 계산

각 지표를 -1~+1로 정규화해 가중합한 뒤 2.5로 나눠 점수를 만든다.

| 지표 | 가중치 | 산식 |
|---|---|---|
| 단기 모멘텀 | 0.9 | 5일 수익률 / 6% |
| 중기 모멘텀 | 1.1 | 20일 수익률 / 15% |
| 20일선 대비 | 0.8 | (현재가-SMA20)/SMA20 / 6% |
| 20/60일선 배열 | 0.5 | (SMA20-SMA60)/SMA60 / 6% |
| 20일 밴드 위치 | 0.6 | 고저 구간 위치. 0.95 초과(과열)·0.1 미만(급락)은 감점 |
| 거래량 | 0.4 | 최근 거래량 / 20일 평균 |
| 뉴스 감성 | 1.0 | 종목 별칭이 걸린 기사의 긍·부정 키워드 비율(없으면 시장 전반) |
| 변동성 리스크 | 0.7 | 일변동성 2.2% 초과분을 감점 |

판정: `≥1.15` 매수 우선 검토 / `≥0.45` 분할 매수 / `>-0.45` 관망 / `>-1.15` 비중 축소 / 그 이하 매도 검토.
매매 계획은 ATR(14)로 손절 `-2×ATR`, 목표 `+3×ATR`(손익비 1.5:1)을 제시한다.

감성 분석은 LLM이 아니라 다국어 키워드 사전이다. 캐시·재현성 때문에 결정적으로 동작해야 하고, 오탐(반어법·인용)이 섞일 수 있어 점수의 한 축으로만 쓴다.

---

## 8. 알려진 제약

- **KIS 포트**: KIS OpenAPI는 실전 9443 / 모의 29443 포트를 쓴다. **배포된 Worker에서 `fetch()` 로 29443 접속이 정상 동작함을 확인했다**(더미 앱키로 호출 → KIS가 403 "유효하지 않은 AppKey입니다"를 1.7초에 응답). 혹시 `fetch()` 가 막히는 경우를 대비해 `cloudflare:sockets` 로 TLS 직결하는 HTTP/1.1 폴백을 넣어 두었고, 어느 방식이 통했는지 KV에 기억해 다음 호출에서 낭비하지 않는다(`/api/kis/status` 의 `transport`).
- **해외주식 TR_ID**: 국내 주문 TR_ID는 검증됐지만 해외 시장 TR_ID는 KIS 문서 기준 표를 코드에 넣어둔 값이다. 계좌 종류에 따라 다를 수 있으니 첫 주문은 1주로 시험하고, 다르면 `KIS_TRID_OVERRIDES` 로 덮어쓴다. KIS 오류 메시지(`msg1`)는 화면에 그대로 노출된다.
- **해외주식은 지정가만** 지원한다(KIS 제약). 시장가는 국내만 가능하다.
- 필리핀·베트남·UAE 등 일부 시장은 Yahoo 개별종목 시세가 없어 지수·뉴스만 제공하거나 ETF 프록시로 대체한다(`shared/markets.ts` 의 `proxyNote`).
- 시세는 Yahoo 일봉 기준이라 실시간이 아니다. 정확한 실시간 호가는 KIS 연동 후 `/api/kis/price` 를 쓴다.
- **뉴스 제공처**: Cloudflare Workers egress 에서는 Google News RSS 가 응답하지 않는다(요청이 타임아웃된다). 그래서 Google → Bing News RSS → Yahoo Finance 검색뉴스 순으로 폴백하고, 실패한 계열은 30분간 건너뛴다. 실제 배포에서는 Bing 이 한국어·현지어 모두 정상이라 국가별 기사가 채워진다. 뉴스 탭은 어떤 제공처가 응답했는지 함께 보여준다(`sources`).
- 한국어 피드는 검색어가 느슨해 무관한 기사가 섞이므로 국가명·시장 용어가 포함된 기사만 남긴다(`KO_ALIASES`).
- 시세·뉴스 모두 무인증 공개 엔드포인트라 호출 한도나 정책 변경에 영향을 받을 수 있다. 실패 시 만료 캐시로 버티고 화면에 상태를 표시한다.
