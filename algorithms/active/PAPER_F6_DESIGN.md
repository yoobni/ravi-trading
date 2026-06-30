# F6 NEW_HIGH 42 — Paper Trading 명세

## 1. 룰 (변경 금지)

**Signal (4h bar 기준, lookahead-safe):**
- 코인 풀: KRW-{BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, BCH, POL, NEAR, ATOM, TRX, ALGO, ETC, XLM, AAVE, ARB, APT, SUI, GRT, IMX, SAND, MANA, CHZ, AXS, BAT} (28종)
- 평가 시점: 매 4h bar 종료 직후 (KST 00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
- 진입 조건 (모두 만족):
  1. **7일 신고가 발생** — 직전 4h bar (i-1)의 high가 이전 42 bars (= 7일 = i-42 ~ i-2)의 high 최대값 초과
  2. **양봉 follow-through** — 현재 bar(i)가 양봉 (close > open)
  3. **신고가 갱신** — 현재 bar close > 직전 bar high
  4. **거래량 확인** — vol z-score ≥ 0.5 (volumes[i] vs 직전 30 bars mean/sd)
- Entry: 신호 bar 종료 후 다음 4h bar open 가격

**Exit:**
- TP: +5%
- SL: -2%
- MAX: 14일 (84 4h bars) → time exit (해당 bar close)
- 동시 hit 시 SL 우선 보수 처리

**Position sizing:**
- 자본: 10,000,000 KRW (1000만)
- 진입당: cash × 33%
- 동시 보유 최대: 3 positions
- 코인 중복 허용 (multi-pos per coin OK — backtest와 동일)
- Cost: 진입+청산 각 0.05% (Upbit fee) + slippage 0.05% = round-trip 0.1%

## 2. 검증 결과

| 검증 | n | WR | total | PF | MDD | 분기 통과 |
|---|---|---|---|---|---|---|
| 1Y (R31, 15코인) | 167 | 39% | +27.78% | 1.46 | 5.7% | 5/8 |
| 2Y standalone (R31-verify, 15코인) | 414 | 40% | +89.92% | 1.47 | 7.6% | - |
| 3Y (R32, 15코인) | 671 | 36% | +72.64% | 1.26 | 24.4% | 6/12 |
| 2Y 28코인 (R33) | 563 | 37% | +72.99% | 1.29 | 9.6% | 5/8 |
| 1Y 최근 28코인 (R33) | 192 | 41% | +29.46% | 1.51 | 5.6% | - |

**Robustness 확인:**
- Lookahead bias: 없음 (코드 검증 완료)
- 코인 의존도: top-3 빼도 PF 1.31 (분산 OK)
- 장 의존도: bull 1.48 / neutral 1.50 / bear 1.34 — 사실상 무관
- 거래량 의존: 모든 vol z 분위 PF≥1.3

## 3. 운영 보존 사항 (paper trading 동안)

- **룰 변경 금지** (3개월 paper 운영 끝까지)
- **손실 거래 보고 threshold 수정 금지**
- **신규 코인 풀 추가 금지** (28코인 고정)
- **TP/SL/MAX 변경 금지** (5%/-2%/14d)
- **자본 분할 비율 변경 금지** (33% × 3 max)
- **LLM 판단 진입/청산 금지**
- **3개월 종료 전 실거래 전환 금지**

## 4. 통과 기준 (3개월 후 판정)

- PF ≥ 1.2
- 누적 total > 0
- MDD < 15%
- n ≥ 30 (분기당 최소)
- 백테스트 reference 대비 큰 deviation 없음

## 5. 데이터 source

- Upbit 4h candles (`/v1/candles/minutes/240`)
- 평가 직전 50 bars 이상 (BB/vol z 계산 안정)
- 28코인 모두 매 tick 평가

## 6. tick 주기

- 4h마다 1회 평가 (cron: `0 0,4,8,12,16,20 * * *` KST)
- 평가 1: 청산 check (open positions의 high/low → TP/SL 또는 MAX)
- 평가 2: 신호 check (28코인 각자) + 진입 (자본 + max 3 제약)

## 7. 참조

- 검증 스크립트: `scripts/research/r31-verify.ts`, `scripts/research/r33-final.ts`
- 백테스트 매트릭스: `data/research/2026-06-*_R31_VERIFY.txt`, `data/research/2026-06-*_R33_FINAL.txt`
- 코드: `scripts/research/r33-final.ts` (sigF6 함수)
