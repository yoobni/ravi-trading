# R19-5 PRIME Paper Trading System — 설계 문서

> 이 문서는 설계만. 실제 구현은 라비 운영 시작 결정 후 진행.

## 개요

R23-C 검증된 알파 (lookahead-free, 24개월 +58.57%, PF 1.43)를 paper로 운영.
기존 `FUNDING_F1F2_50` (Upbit, daily)와 **별도**로 동시 운영.

## 룰 (변경 금지)

```
1. 4h 완전 종료된 bar의 close < 4h EMA50 (downtrend 필수)
2. 15m bar i: prev.close > EMA20(i-1) AND cur.close < EMA20(i) (cross down)
3. 15m bar i의 volume z-score (30봉 inclusive) > 1.0
4. signal_ts = bar i 종료 시점 (= bar.ts + 15min)
5. Entry: 다음 15m bar의 open에 Binance perp BTCUSDT SHORT 진입
6. Exit: 1m path verify
   - TP +6% (price↓ 6%)
   - SL -1% (price↑ 1%)
   - MAX 72h (3 days)
7. Cooldown: 직전 exit_ts 이후만 다음 진입
8. 자본: paper 자본의 50% × signal당 (Kelly half 근사)
```

## 인프라

```
데이터 소스: Binance fapi public API
  - GET /fapi/v1/klines (1m / 15m / 4h)
  - 매 15분: 최근 4h, 15m, 1m fetch (signal 평가용)
  - 매 1분: 활성 포지션 monitor (TP/SL/MAX 체크)

저장: data/paper-trading-r19/
  - state.json (자본, 포지션, last tick ts)
  - positions.jsonl (체결 trade)
  - signals.jsonl (모든 신호, 진입 실행 여부)
  - daily-snapshots.jsonl (메타데이터)

Cron:
  */15 * * * *  → signal 평가 + 진입 (15분 단위)
  * * * * *     → 활성 포지션 monitor (1분 단위, 포지션 있을 때만)
  0 22 * * 0   → weekly report
```

## 통과 기준 (3개월 후)

```
PASS:
  - PF ≥ 1.2
  - 총수익 양수
  - MDD ≤ 15% (백테스트 16% 보다 약간 보수)
  - 신호 수 ≥ 20개 (24개월 165건 / 24 ≈ 월 7건 × 3 = ~20)
  - 손실 거래가 백테스트보다 과도하지 않음 (avgLoss ≤ -1.5%)

HOLD:
  - PF 1.0~1.2
  - 양수지만 미미

DROP:
  - PF < 1.0
  - MDD > 20%
  - max losing streak > 12 (백테스트 10보다 더 큰 streak)
```

## 운영 시 주의

```
1. 심리적: 10연패 가능 (WR 30%). 룰대로 계속 진입 필수.
2. Binance perpetual: funding payment 영향 받음 (8h마다)
   - SHORT 포지션이라 funding > 0이면 받음, < 0이면 지급
   - 일평균 +0.01%~+0.03% (양수 다수)
3. Cost: maker 0.02% / taker 0.05% (Binance perp)
   - 실거래시 round-trip 0.1~0.2% 예상
4. Slippage: 0.05% 가정 (BTC는 충분히 liquid)
5. Position size: paper 자본 50%. 실거래 시 Kelly half 4.5% 고려.
```

## 금지 사항

```
- 3개월 paper 중 룰 변경 금지
- 손실 streak 보고 size 줄이지 말 것 (룰대로)
- 통과 기준 만족 전 실거래 전환 금지
- TP/SL 비율 임의 변경 금지
- volume z threshold 변경 금지
- 1h align 추가 등 filter 추가 금지 (검증된 룰만)
```

## 다음 단계

1. 라비 운영 시작 결정
2. Binance API key (read-only 충분)
3. paper trading code 구현 (1주일 추정)
4. cron 등록
5. 3개월 운영 → 판정
