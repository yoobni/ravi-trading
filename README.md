# 업비트 AI 자동 매매 시스템

Claude AI 기반 업비트 모의 자동 매매 프로그램입니다.
5분 주기로 시장을 분석하고, AI가 매수/매도를 판단하며, 판단 근거를 모두 기록합니다.

> **⚠️ 주의: 현재 모의 매매(Paper Trading) 전용입니다. 실계좌 주문은 실행되지 않습니다.**

---

## 목차

1. [사전 요구사항](#사전-요구사항)
2. [업비트 API 키 발급](#업비트-api-키-발급)
3. [Anthropic API 키 발급](#anthropic-api-키-발급)
4. [설치 및 설정](#설치-및-설정)
5. [실행 방법](#실행-방법)
6. [설정 파라미터 설명](#설정-파라미터-설명)
7. [웹 대시보드 사용법](#웹-대시보드-사용법)
8. [데이터 파일 구조](#데이터-파일-구조)
9. [주의사항 및 한계](#주의사항-및-한계)

---

## 사전 요구사항

| 항목 | 버전 |
|------|------|
| Node.js | 20.x 이상 |
| npm | 10.x 이상 |
| PM2 (선택) | `npm install -g pm2` |

---

## 업비트 API 키 발급

1. [업비트 로그인](https://upbit.com) → 우측 상단 **내 정보** 클릭
2. **Open API 관리** 메뉴 진입
3. **자산 조회**, **주문 조회** 권한 체크 (실거래 전환 시 **주문하기** 추가)
4. 허용 IP 입력 (개발 중에는 본인 IP, 서버 배포 시 서버 IP)
5. **발급하기** → `Access Key`와 `Secret Key` 저장

> **개발 API 한계**: 업비트는 별도 샌드박스 환경을 제공하지 않습니다.
> 이 프로그램은 **시세 조회만** API를 사용하며, 주문은 내부 파일에 기록합니다.
> 따라서 **주문 권한 없이** 자산 조회 권한만으로도 동작합니다.

---

## Anthropic API 키 발급

1. [console.anthropic.com](https://console.anthropic.com) 접속 후 회원가입/로그인
2. **API Keys** 메뉴 → **Create Key**
3. 키 이름 입력 후 생성 → 키 값 즉시 복사 (이후 재조회 불가)

> **비용 참고**: AI 판단은 5분마다 호출됩니다. `claude-sonnet-4` 기준 회당 약 $0.001~0.003 수준.
> `data/config.json`의 `ai.model`을 `claude-haiku-4-5` 로 변경하면 비용을 대폭 절감할 수 있습니다.

---

## 설치 및 설정

### 1. 의존성 설치

```bash
cd /Users/goyubin/Desktop/ai/upbit-trading
npm install
```

### 2. 환경 변수 설정

`.env.local` 파일을 프로젝트 루트에 생성합니다:

```bash
# 업비트 API
UPBIT_ACCESS_KEY=your_access_key_here
UPBIT_SECRET_KEY=your_secret_key_here

# Anthropic API (Claude AI)
ANTHROPIC_API_KEY=your_anthropic_key_here

# 선택: Next.js 내부 API 보호용 (설정하면 /api/* 접근 시 검증)
# INTERNAL_API_SECRET=random_secret_string
```

> `.env.local`은 `.gitignore`에 포함되어 있으므로 절대 커밋되지 않습니다.

### 3. 빌드

```bash
npm run build
```

---

## 실행 방법

### 개발 모드 (핫 리로드)

```bash
npm run dev
# → http://localhost:3000
```

### 프로덕션 모드

```bash
npm run build
npm run start
```

### PM2로 백그라운드 실행 (권장)

```bash
# 시작
pm2 start ecosystem.config.js

# 상태 확인
pm2 status

# 로그 실시간 확인
pm2 logs upbit-trading

# 재시작
pm2 restart upbit-trading

# 중지
pm2 stop upbit-trading

# 시스템 재부팅 시 자동 시작 등록
pm2 save
pm2 startup
```

### 터미널 대시보드

```bash
npm run dashboard         # 1회 출력
npm run dashboard:watch   # 5초마다 갱신
```

### 24시간 시뮬레이션

```bash
npm run sim:24h
```

---

## 설정 파라미터 설명

모든 전략 파라미터는 `data/config.json` 단일 파일로 관리됩니다.
파일 저장 즉시 **재시작 없이 자동 적용**됩니다.

```json
{
  "scheduler": {
    "intervalMs": 300000,        // 매매 주기 (ms). 기본 5분 = 300000
    "targetMarketCount": 5,      // 매 사이클 분석할 종목 수
    "candleUnit": 5,             // 캔들 단위 (분). 5분봉
    "candleCount": 200,          // 가져올 캔들 개수
    "enabled": true              // false 로 변경하면 스케줄러 일시 정지
  },
  "trading": {
    "buyThreshold": 25,          // 매수 신호 임계값 (0~100). 높을수록 보수적
    "sellThreshold": -25,        // 매도 신호 임계값 (-100~0). 낮을수록 보수적
    "minConfidence": 40,         // AI 최소 신뢰도 (%). 미달 시 관망
    "strategyWeights": {
      "rsi": 0.2,                // RSI 지표 가중치
      "macd": 0.2,               // MACD 지표 가중치
      "bollinger": 0.15,         // 볼린저 밴드 가중치
      "movingAverage": 0.15,     // 이동평균선 가중치
      "volume": 0.15,            // 거래량 가중치
      "sentiment": 0.15          // 시장 심리 가중치
    }
  },
  "marketSelector": {
    "minTradePrice24h": 1000000000, // 최소 24시간 거래대금 (원). 유동성 필터
    "maxChangeRate": 25,            // 최대 변동률 (%). 급등주 제외
    "excludeCaution": true,         // 유의종목 제외 여부
    "selectCount": 5,               // 최종 선택 종목 수
    "watchlistMaxSize": 15,         // 관심 종목 최대 보관 수
    "watchlistRetainCycles": 12     // 관심 종목 유지 사이클 수 (12 * 5분 = 1시간)
  },
  "risk": {
    "totalCapital": 10000000,       // 총 운용 자금 (원)
    "stopLoss": {
      "stopLossRate": -3,           // 손절 기준 (%). -3 = 3% 손실 시 손절
      "takeProfitRate": 5,          // 익절 기준 (%). 5 = 5% 수익 시 익절
      "useTrailingStop": true,      // 트레일링 스탑 사용 여부
      "trailingStopRate": 2         // 트레일링 스탑 폭 (%). 고점 대비 2% 하락 시 매도
    },
    "positionSize": {
      "maxAmountPerTrade": 1000000, // 1회 최대 매수 금액 (원)
      "maxRatePerTrade": 10,        // 1회 최대 매수 비율 (%). 총자금 대비
      "maxTotalPosition": 7000000,  // 전체 포지션 최대 금액 (원)
      "maxTotalPositionRate": 70    // 전체 포지션 최대 비율 (%)
    },
    "dailyLoss": {
      "maxDailyLossAmount": 500000, // 일일 최대 손실 금액 (원). 초과 시 당일 매매 중단
      "maxDailyLossRate": 5,        // 일일 최대 손실률 (%)
      "maxDailyTrades": 20          // 일일 최대 매매 횟수
    },
    "diversification": {
      "maxHoldings": 5,             // 최대 보유 종목 수
      "maxSingleAssetRate": 30,     // 단일 종목 최대 비중 (%)
      "blockSurgeCoins": true,      // 급등 코인 매수 차단 여부
      "minTradeVolume24h": 500000000 // 최소 24시간 거래량 (원)
    }
  },
  "paperTrading": {
    "initialCapital": 10000000,     // 모의 초기 자금 (원)
    "fee": {
      "feeRate": 0.0005,            // 거래 수수료율 (0.05%)
      "slippageRate": 0.0005        // 슬리피지율 (0.05%)
    }
  },
  "ai": {
    "model": "claude-sonnet-4-20250514", // 사용할 Claude 모델
    "maxTokens": 1024,              // AI 응답 최대 토큰
    "temperature": 0.1,             // AI 창의성 (0=결정적, 1=창의적). 매매는 낮게 유지
    "minIntervalMs": 10000,         // AI 호출 최소 간격 (ms). 과호출 방지
    "timeoutMs": 30000,             // AI 호출 타임아웃 (ms)
    "fallbackToAlgorithm": true     // AI 실패 시 알고리즘 폴백 여부
  }
}
```

---

## 웹 대시보드 사용법

브라우저에서 `http://localhost:3000` 접속

### 메인 페이지 (`/`)

| 섹션 | 내용 |
|------|------|
| 성과 요약 KPI | 총 수익률, 승률, 총 거래 수, 최대 낙폭(MDD) 등 8개 지표 |
| 보유 포지션 | 현재 보유 중인 종목, 평균 매수가, 평가손익 |
| 일별 통계 | 날짜별 거래 수, 수익률 테이블 |
| 종목별 통계 | 종목별 누적 손익, 승률 |
| 최근 거래 | 매수/매도 내역 + AI 판단 근거 요약 |
| 실거래 전환 체크리스트 | 실계좌 전환 전 확인 항목 |

### 기타 페이지

| 경로 | 내용 |
|------|------|
| `/activity` | 실시간 스케줄러 활동 로그 |
| `/decisions` | AI 판단 상세 내역 (지표 수치, 판단 이유 전문) |
| `/backtest` | 과거 데이터 기반 전략 백테스트 |

### API 엔드포인트

| 경로 | 설명 |
|------|------|
| `GET /api/dashboard` | 대시보드 전체 데이터 |
| `GET /api/decision-logs` | AI 판단 로그 목록 |
| `GET /api/activity` | 활동 로그 |
| `GET /api/config` | 현재 설정 조회 |
| `POST /api/config` | 설정 변경 (핫 리로드) |
| `GET /api/risk` | 리스크 현황 |
| `POST /api/pipeline` | 수동 매매 사이클 실행 |
| `GET /api/reports` | 성과 리포트 |
| `POST /api/backtest` | 백테스트 실행 |

---

## 데이터 파일 구조

모든 상태는 `data/` 디렉토리에 JSON 파일로 저장됩니다.

```
data/
├── config.json              # 전략 파라미터 (핫 리로드 지원)
├── orders.json              # 전체 주문 내역
├── balance.json             # 현재 잔고 (KRW + 보유 코인)
├── account-balance.json     # 모의 계좌 잔고
├── watchlist.json           # 관심 종목 목록
├── daily-stats.json         # 일별 성과 통계
├── high-prices.json         # 종목별 최고가 (트레일링 스탑용)
├── risk-config.json         # 리스크 설정
├── risk-events.json         # 리스크 이벤트 로그
├── circuit-breaker-state.json  # 서킷 브레이커 상태
├── ai-judgments/            # AI 판단 원본 로그 (날짜별)
├── decision-logs/           # 매매 결정 로그
├── cycle-logs/              # 사이클별 실행 로그
└── simulation/              # 시뮬레이션 결과
```

> `data/` 디렉토리는 `.gitignore`에 포함되어 있습니다.
> 운영 중 수동으로 수정하면 잔고 불일치가 발생할 수 있으므로 주의하십시오.

---

## 주의사항 및 한계

### 개발 API 한계

- 업비트는 **별도 테스트 환경(샌드박스)을 제공하지 않습니다**.
- 이 프로그램은 **시세 조회 API만** 사용하며, 모든 주문은 파일에만 기록합니다.
- 업비트 API 요청 제한: 초당 10회 (시세 조회), 초당 8회 (주문). 과도한 호출 시 IP 차단 가능.

### AI 판단 한계

- Claude AI는 단기 시장 예측에 최적화된 모델이 아닙니다.
- `minConfidence` 미달 시 알고리즘 폴백(`fallbackToAlgorithm: true`)으로 전환됩니다.
- AI API 장애 시에도 알고리즘 기반으로 동작을 유지합니다.

### 실거래 전환 전 필수 확인

- [ ] 30일 이상 모의 매매로 전략 검증 완료
- [ ] 최대 낙폭(MDD) 허용 범위 내 확인
- [ ] 소액(10만원 이하)으로 실거래 검증
- [ ] 업비트 API 키에 **주문 권한** 추가
- [ ] `stopLoss`, `dailyLoss` 파라미터 재검토
- [ ] 서버 장애 시 수동 대응 절차 수립

### 보안

- `.env.local` 파일은 절대 외부에 노출하지 마십시오.
- PM2로 운영 시 로그 파일(`logs/`)에 민감 정보가 출력되지 않는지 주기적으로 확인하십시오.
- API 키는 최소 권한 원칙에 따라 **조회 권한만** 발급하는 것을 권장합니다.

---

## 라이선스

개인 사용 목적으로만 제작되었습니다. 무단 배포 및 상업적 이용을 금지합니다.
