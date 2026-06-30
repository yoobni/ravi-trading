# F6_v2 (TP_OPT) — Paper Trading 명세

## 1. 룰 (변경 금지)

**F6과 동일한 signal, exit만 다름:**

Signal (4h bar, lookback 42, vol z ≥ 0.5):
- 28 코인 풀 (F6과 동일)
- 7일 신고가 직전 발생 + 양봉 follow-through + vol z ≥ 0.5

**Exit (F6과 다름):**
- TP: **+7%** (F6은 +5%)
- SL: **-2.5%** (F6은 -2%)
- MAX: 14일 (84 4h bars, F6과 동일)

**Position sizing (F6과 동일):**
- 자본 10,000,000원
- 33% × max 3 concurrent
- Fee 0.05% + slippage 0.05% = round-trip 0.1%

## 2. 검증 (R35/R36)

| 검증 | n | WR | total | PF | MDD | 분기 통과 |
|---|---|---|---|---|---|---|
| 4Y (R35, 15코인) | 700 | 34% | +116.15% | 1.30 | 27.4% | 9/16 |
| 2Y 28코인 (R36) | 467 | 37% | +114.28% | 1.40 | 11.3% | 5/8 |
| 1Y 최근 (R36) | 202 | 38% | +43.15% | 1.44 | 11.3% | - |

**F6_v1 BASE 대비:**
- 2Y total: +73% → +114% (**+41%p 개선**)
- 2Y PF: 1.29 → 1.40
- 1Y PF: 1.33 → 1.44
- MDD: 9.6% → 11.3% (약간 ↑)

## 3. F6_v1과 차이

```
              F6_v1 BASE      F6_v2 (TP_OPT)
TP            +5%             +7%
SL            -2%             -2.5%
Payoff ratio  2.5:1           2.8:1
─────────────────────────────────────
모든 다른 룰 동일
```

## 4. 운영 보존 사항

- **룰 변경 금지** (3개월 paper 운영 끝까지)
- **F6_v1과 동일 28코인 풀** 유지
- **TP/SL 변경 금지** (7%/-2.5%)
- **F6_v1과 비교 데이터 수집** — 어느 룰이 진짜 robust한지 실전 검증

## 5. 검증 스크립트

- `scripts/research/r35-variants.ts` (4년)
- `scripts/research/r36-variants-2y28.ts` (2년 28코인)
- 백업 결과: `data/research/2026-06-12T*_R35_VARIANTS.txt`, `2026-06-12T*_R36_2Y.txt`
