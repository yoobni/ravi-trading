# AI_Gate_V1

C1_final 베이스 + BTC trend 가드를 Claude haiku의 판정으로 대체.

## 동기

룰의 일봉 MA20 trend는 후행 지표 — 약세장 진입을 늦게 감지. AI가 차트 데이터를 종합 판단하면 약세장을 더 빠르게 감지할 수 있다는 가설.

## 룰

C1_final과 동일하지만 BTC up_only 가드만 AI 판정으로 대체:

```
[진입 신호] — C1_final 그대로
  - 어제 low ≤ (10일 최저가 × 1.01)
  - 어제 일봉 양봉
  - 동시 보유 < 5종

[BTC 가드] — AI로 대체
  - 매일 KST 09:00에 Claude haiku 호출
  - 입력: 최근 30일 BTC/KRW 일봉 + 기본 지표
  - 출력: regime = uptrend | downtrend | sideways
  - 결정:
    - uptrend → 매수 OK
    - downtrend / sideways → 매수 X + 보유 청산

[기타 가드] — C1_final 그대로
  - panic 25% (40종 중 25%↑ 신저가면 매수 X)
  - 자본 -10% drawdown 시 청산 + 10일 휴식

[청산] — C1_final 그대로
  - 익절 +5% / 손절 -2.5% / 5일 강제
```

## AI 프롬프트 (V1)

```
You are a cryptocurrency market analyst. You will be given Bitcoin (BTC/KRW)
daily candle data up to a specific date.

Your task: classify the current market regime as one of:
- "uptrend": Bullish momentum, price trending up, healthy gains
- "downtrend": Bearish momentum, price falling, sell pressure
- "sideways": Range-bound, no clear direction, mixed signals

CRITICAL RULES:
1. You only know data up to the given date. Do NOT use future information
   or training-data knowledge.
2. Base your decision PURELY on the candle data provided.
3. Look at: recent price action (5-10 days), volume trends, daily ranges.
4. Be conservative — when in doubt, choose "sideways".
5. Output reasoning in 1-2 sentences (Korean is fine).
```

핵심: **"Be conservative — when in doubt, choose sideways"** 명시. 명확한 룰 없이 AI 자기 판단으로 결정.

## 백테스트 결과

### 3month (강세장, B&H +4.96%)

| 변형 | 수익 | 알파 |
|---|---|---|
| C1_final (룰) | +22.66% | +17.70% |
| AI_Gate_V1 | +20.11% | +15.15% |

→ 강세장에선 룰보다 −2.55%p 약간 손해 (AI가 보수적이라 강세장 일부 진입 못함)

### Q4_2025 (강한 약세장, B&H −44.64%)

| 변형 | 수익 | 알파 |
|---|---|---|
| C1_final (룰) | −8.43% | +36.22% |
| **AI_Gate_V1** | **−1.95%** | **+42.69%** |

→ 약세장에서 룰보다 **+6.48%p 더 잘함**. 손실 1/4로 줄임.

### 종합 (3month + Q4 단순 합)

| 변형 | 3m 강세 | Q4 약세 | 종합 |
|---|---|---|---|
| C1_final | +22.66% | −8.43% | +14.23% |
| **AI_Gate_V1** | +20.11% | −1.95% | **+18.16%** ⭐ |

→ AI_Gate_V1이 종합 +3.93%p 향상.

## 판정 분포

### 3month (90일)
- Rule: uptrend 60 / down 4 / sideways 26
- V1 AI: uptrend 47 / down 26 / sideways 17

→ AI가 6.5배 자주 downtrend 판정. 강세장에 보수적.

### Q4 (90일)
- Rule: uptrend 18 / down 45 / sideways 29
- V1 AI: uptrend 11 / **down 64** / sideways 17

→ 약세장 90일 중 64일 downtrend 판정. 매수 차단 88%.

## 다른 프롬프트 (V2/V3/V4) 비교

| 변형 | 프롬프트 특성 | 종합 알파 vs Rule |
|---|---|---|
| **V1** | 보수, "의심되면 sideways" | **+3.93%p** ⭐ |
| V2 | 공격, "default uptrend" | +1.15%p (강세장만 우위) |
| V3 | 중간 (V1+V2) | 0 (Rule과 동일) |
| V4 | V1보다 더 strict | +0.69%p (강세장 큰 손해) |

→ V1이 명확한 베스트. 더 보수적 또는 더 공격적 변형은 모두 종합 손해.

## 운영 비용 / 시간

- Claude haiku 매일 1회 호출 = 365회/년
- 호출당 비용: ~$0.001 (haiku 적은 토큰)
- **1년 운영 비용: ~$0.4** (구독 사용자는 quota 소모만)
- 호출 시간: 5~30초/회

## 라이브 적용 시 주의

- Claude API cutoff 우려 — 학습 데이터에 있는 시기는 cheat 가능성
- 시스템 프롬프트에 "future info 모름" 강조 + 입력 데이터 그 시점까지만
- 실제 정확도는 라이브 운영하며 측정해야

## 한계

- 강세장에선 보수적이라 알파 약간 손해 (-2.55%p)
- 약세장에선 큰 보호 효과 (+6.48%p)
- **약세장 보호가 진짜 가치** — 큰 폭락장에서 자본 보존
- 강세장 손해는 약세장 이득보다 작음 (종합 양수)

## Status

**보관 — 라이브 미적용**. 향후 다른 개선과 함께 검토.
