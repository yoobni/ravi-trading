/**
 * AI 매매 판단 엔진
 *
 * 6개 전략 시그널을 종합하여 매수/매도/관망을 결정합니다.
 * Claude API 없이 순수 알고리즘 기반으로 동작하며,
 * 각 전략의 가중치와 임계값을 조정하여 튜닝할 수 있습니다.
 *
 * 전략 목록:
 *  1. RSI 과매수/과매도 반전
 *  2. MACD 크로스오버
 *  3. 볼린저 밴드 이탈/복귀
 *  4. 이동평균 정배열/역배열
 *  5. 거래량 확인
 *  6. 시장 심리 (공포/탐욕)
 */

import type { TechnicalAnalysis } from '@/types/indicator';
import type { MarketAnalysis } from '@/types/market-analysis';
import type {
  DecisionAction,
  DecisionEngineConfig,
  DecisionInput,
  PortfolioContext,
  StrategySignal,
  TradingDecision,
} from '@/types/trading-decision';

// ─── 기본 설정 ───────────────────────────────────────────────

const DEFAULT_CONFIG: DecisionEngineConfig = {
  buyThreshold: 25,
  sellThreshold: -25,
  minConfidence: 40,
  strategyWeights: {
    rsi: 0.20,
    macd: 0.20,
    bollinger: 0.15,
    movingAverage: 0.15,
    volume: 0.15,
    sentiment: 0.15,
  },
};

let currentConfig: DecisionEngineConfig = { ...DEFAULT_CONFIG };

// ─── 설정 관리 ───────────────────────────────────────────────

export function getEngineConfig(): DecisionEngineConfig {
  return { ...currentConfig };
}

export function updateEngineConfig(
  partial: Partial<DecisionEngineConfig>
): DecisionEngineConfig {
  currentConfig = { ...currentConfig, ...partial };
  if (partial.strategyWeights) {
    currentConfig.strategyWeights = {
      ...currentConfig.strategyWeights,
      ...partial.strategyWeights,
    };
  }
  return { ...currentConfig };
}

export function resetEngineConfig(): DecisionEngineConfig {
  currentConfig = { ...DEFAULT_CONFIG };
  return { ...currentConfig };
}

// ─── 유틸 ────────────────────────────────────────────────────

/** 배열 끝에서 n번째 유효한 값 (null 제외) */
function latest(arr: (number | null)[], nth = 0): number | null {
  let count = 0;
  for (const v of arr) {
    if (v !== null) {
      if (count === nth) return v;
      count++;
    }
  }
  return null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── 전략 1: RSI ─────────────────────────────────────────────

function evalRSI(ta: TechnicalAnalysis): StrategySignal {
  const rsi = latest(ta.rsi.values);
  const prevRsi = latest(ta.rsi.values, 1);
  const w = currentConfig.strategyWeights['rsi'] ?? 0.20;

  if (rsi === null) {
    return { name: 'RSI', score: 0, weight: w, reason: 'RSI 데이터 부족' };
  }

  let score = 0;
  const reasons: string[] = [];

  if (rsi <= 25) {
    // 극단적 과매도 → 강한 매수
    score = 0.9;
    reasons.push(`RSI ${rsi.toFixed(1)} 극과매도`);
  } else if (rsi <= 30) {
    score = 0.7;
    reasons.push(`RSI ${rsi.toFixed(1)} 과매도`);
    // RSI 반등 확인 시 추가 점수
    if (prevRsi !== null && rsi > prevRsi) {
      score = 0.85;
      reasons.push('반등 확인');
    }
  } else if (rsi <= 40) {
    score = 0.3;
    reasons.push(`RSI ${rsi.toFixed(1)} 약세 영역`);
  } else if (rsi >= 75) {
    score = -0.9;
    reasons.push(`RSI ${rsi.toFixed(1)} 극과매수`);
  } else if (rsi >= 70) {
    score = -0.7;
    reasons.push(`RSI ${rsi.toFixed(1)} 과매수`);
    if (prevRsi !== null && rsi < prevRsi) {
      score = -0.85;
      reasons.push('하락 전환 감지');
    }
  } else if (rsi >= 60) {
    score = -0.2;
    reasons.push(`RSI ${rsi.toFixed(1)} 강세 영역 (매수 주의)`);
  } else {
    score = 0;
    reasons.push(`RSI ${rsi.toFixed(1)} 중립`);
  }

  return { name: 'RSI', score, weight: w, reason: reasons.join(', ') };
}

// ─── 전략 2: MACD ────────────────────────────────────────────

function evalMACD(ta: TechnicalAnalysis): StrategySignal {
  const macd = latest(ta.macd.macd);
  const signal = latest(ta.macd.signal);
  const histogram = latest(ta.macd.histogram);
  const prevHistogram = latest(ta.macd.histogram, 1);
  const w = currentConfig.strategyWeights['macd'] ?? 0.20;

  if (macd === null || signal === null || histogram === null) {
    return { name: 'MACD', score: 0, weight: w, reason: 'MACD 데이터 부족' };
  }

  let score = 0;
  const reasons: string[] = [];

  // 골든크로스 / 데드크로스
  if (prevHistogram !== null) {
    if (prevHistogram <= 0 && histogram > 0) {
      // 골든크로스: MACD가 시그널을 상향 돌파
      score = 0.8;
      reasons.push('MACD 골든크로스');
    } else if (prevHistogram >= 0 && histogram < 0) {
      // 데드크로스
      score = -0.8;
      reasons.push('MACD 데드크로스');
    } else if (histogram > 0 && histogram > prevHistogram) {
      // 양의 히스토그램 확대
      score = 0.4;
      reasons.push('MACD 상승 모멘텀 확대');
    } else if (histogram > 0 && histogram < prevHistogram) {
      // 양의 히스토그램 축소 → 모멘텀 약화
      score = 0.1;
      reasons.push('MACD 상승 모멘텀 약화');
    } else if (histogram < 0 && histogram < prevHistogram) {
      score = -0.4;
      reasons.push('MACD 하락 모멘텀 확대');
    } else if (histogram < 0 && histogram > prevHistogram) {
      score = -0.1;
      reasons.push('MACD 하락 모멘텀 약화');
    }
  }

  // 0선 기준
  if (macd > 0) {
    score += 0.1;
    reasons.push('MACD 0선 위');
  } else {
    score -= 0.1;
    reasons.push('MACD 0선 아래');
  }

  score = clamp(score, -1, 1);

  return { name: 'MACD', score, weight: w, reason: reasons.join(', ') };
}

// ─── 전략 3: 볼린저 밴드 ────────────────────────────────────

function evalBollinger(ta: TechnicalAnalysis): StrategySignal {
  const percentB = latest(ta.bollingerBand.percentB);
  const prevPercentB = latest(ta.bollingerBand.percentB, 1);
  const bandwidth = latest(ta.bollingerBand.bandwidth);
  const w = currentConfig.strategyWeights['bollinger'] ?? 0.15;

  if (percentB === null) {
    return { name: '볼린저밴드', score: 0, weight: w, reason: '볼린저 데이터 부족' };
  }

  let score = 0;
  const reasons: string[] = [];

  // %B 기반 판단 (0 = 하단, 1 = 상단)
  if (percentB <= 0) {
    // 하단 밴드 이탈 → 과매도 + 반등 기대
    score = 0.7;
    reasons.push(`%B ${percentB.toFixed(2)} 하단밴드 이탈`);
    // 반등 시작 확인
    if (prevPercentB !== null && percentB > prevPercentB) {
      score = 0.85;
      reasons.push('밴드 내 복귀 시작');
    }
  } else if (percentB <= 0.2) {
    score = 0.5;
    reasons.push(`%B ${percentB.toFixed(2)} 하단 근접`);
  } else if (percentB >= 1.0) {
    // 상단 밴드 이탈 → 과매수
    score = -0.7;
    reasons.push(`%B ${percentB.toFixed(2)} 상단밴드 이탈`);
    if (prevPercentB !== null && percentB < prevPercentB) {
      score = -0.85;
      reasons.push('밴드 내 하락 시작');
    }
  } else if (percentB >= 0.8) {
    score = -0.4;
    reasons.push(`%B ${percentB.toFixed(2)} 상단 근접`);
  } else {
    score = 0;
    reasons.push(`%B ${percentB.toFixed(2)} 중립`);
  }

  // 밴드폭 스퀴즈 (변동성 수축 → 곧 큰 움직임)
  if (bandwidth !== null && bandwidth < 0.03) {
    reasons.push('밴드폭 스퀴즈 (변동성 수축, 큰 움직임 임박)');
    // 스퀴즈 자체는 방향성이 없으므로 score는 변경하지 않음
  }

  return { name: '볼린저밴드', score, weight: w, reason: reasons.join(', ') };
}

// ─── 전략 4: 이동평균 정배열 ─────────────────────────────────

function evalMovingAverage(ta: TechnicalAnalysis): StrategySignal {
  const ma5 = latest(ta.ma.ma5.values);
  const ma20 = latest(ta.ma.ma20.values);
  const ma60 = latest(ta.ma.ma60.values);
  const prevMa5 = latest(ta.ma.ma5.values, 1);
  const prevMa20 = latest(ta.ma.ma20.values, 1);
  const w = currentConfig.strategyWeights['movingAverage'] ?? 0.15;

  if (ma5 === null || ma20 === null) {
    return { name: '이동평균', score: 0, weight: w, reason: 'MA 데이터 부족' };
  }

  let score = 0;
  const reasons: string[] = [];

  // 정배열: 5 > 20 > 60
  if (ma60 !== null) {
    if (ma5 > ma20 && ma20 > ma60) {
      score = 0.6;
      reasons.push('정배열 (MA5 > MA20 > MA60)');
    } else if (ma5 < ma20 && ma20 < ma60) {
      score = -0.6;
      reasons.push('역배열 (MA5 < MA20 < MA60)');
    } else {
      reasons.push('이동평균 혼조');
    }
  }

  // 골든크로스: 5일선이 20일선을 상향 돌파
  if (prevMa5 !== null && prevMa20 !== null) {
    if (prevMa5 <= prevMa20 && ma5 > ma20) {
      score = Math.max(score, 0.75);
      reasons.push('MA 골든크로스 (5/20)');
    } else if (prevMa5 >= prevMa20 && ma5 < ma20) {
      score = Math.min(score, -0.75);
      reasons.push('MA 데드크로스 (5/20)');
    }
  }

  // 가격과 이동평균 간 괴리율
  const price = ta.candles[0]?.trade_price;
  if (price && ma20) {
    const deviation = (price - ma20) / ma20;
    if (deviation > 0.1) {
      score -= 0.2;
      reasons.push(`MA20 대비 +${(deviation * 100).toFixed(1)}% 괴리 (과열)`);
    } else if (deviation < -0.1) {
      score += 0.2;
      reasons.push(`MA20 대비 ${(deviation * 100).toFixed(1)}% 괴리 (침체)`);
    }
  }

  score = clamp(score, -1, 1);

  return { name: '이동평균', score, weight: w, reason: reasons.join(', ') };
}

// ─── 전략 5: 거래량 ──────────────────────────────────────────

function evalVolume(ta: TechnicalAnalysis): StrategySignal {
  const vol = ta.volume;
  const w = currentConfig.strategyWeights['volume'] ?? 0.15;

  let score = 0;
  const reasons: string[] = [];

  // 거래량 비율
  if (vol.volumeRatio > 3.0) {
    // 폭발적 거래량 — 방향 확인 필요 (자체적으로는 약간 긍정)
    score = 0.3;
    reasons.push(`거래량 비율 ${vol.volumeRatio.toFixed(1)}배 (폭발)`);
  } else if (vol.volumeRatio > 1.5) {
    score = 0.4;
    reasons.push(`거래량 비율 ${vol.volumeRatio.toFixed(1)}배 (활발)`);
  } else if (vol.volumeRatio < 0.5) {
    // 거래량 급감 → 관망
    score = -0.2;
    reasons.push(`거래량 비율 ${vol.volumeRatio.toFixed(1)}배 (침체)`);
  } else {
    reasons.push(`거래량 비율 ${vol.volumeRatio.toFixed(1)}배 (보통)`);
  }

  // 거래량 서지 + 가격 상승 = 강한 매수 신호
  if (vol.isSurge) {
    reasons.push('거래량 서지 감지');
  }

  // OBV 추세 (최근 5개)
  const recentObv = vol.obv.filter((v) => v !== null).slice(0, 5) as number[];
  if (recentObv.length >= 3) {
    const obvUp = recentObv[0] > recentObv[recentObv.length - 1];
    if (obvUp) {
      score += 0.15;
      reasons.push('OBV 상승 추세');
    } else {
      score -= 0.15;
      reasons.push('OBV 하락 추세');
    }
  }

  score = clamp(score, -1, 1);

  return { name: '거래량', score, weight: w, reason: reasons.join(', ') };
}

// ─── 전략 6: 시장 심리 ──────────────────────────────────────

function evalSentiment(ma: MarketAnalysis): StrategySignal {
  const fg = ma.fearGreed;
  const w = currentConfig.strategyWeights['sentiment'] ?? 0.15;

  let score = 0;
  const reasons: string[] = [];

  // 공포/탐욕 지수 기반 역발상 투자
  if (fg.score <= 20) {
    score = 0.7;
    reasons.push(`극단적 공포 (${fg.score}점) → 역발상 매수 기회`);
  } else if (fg.score <= 35) {
    score = 0.4;
    reasons.push(`공포 (${fg.score}점) → 매수 우호적`);
  } else if (fg.score >= 80) {
    score = -0.7;
    reasons.push(`극단적 탐욕 (${fg.score}점) → 과열 주의`);
  } else if (fg.score >= 65) {
    score = -0.3;
    reasons.push(`탐욕 (${fg.score}점) → 매수 주의`);
  } else {
    reasons.push(`중립 (${fg.score}점)`);
  }

  // BTC 도미넌스 변화
  const btcDom = ma.btcDominance;
  if (btcDom.dominanceRate > 55) {
    score -= 0.1;
    reasons.push(`BTC 도미넌스 ${btcDom.dominanceRate.toFixed(1)}% (알트코인 약세)`);
  } else if (btcDom.dominanceRate < 35) {
    score += 0.1;
    reasons.push(`BTC 도미넌스 ${btcDom.dominanceRate.toFixed(1)}% (알트코인 강세)`);
  }

  // 급등/급락 종목 수
  const surgeCount = ma.surges.length;
  const crashCount = ma.crashes.length;
  if (surgeCount > crashCount * 2) {
    score += 0.1;
    reasons.push(`급등 ${surgeCount}개 > 급락 ${crashCount}개 (시장 낙관)`);
  } else if (crashCount > surgeCount * 2) {
    score -= 0.1;
    reasons.push(`급락 ${crashCount}개 > 급등 ${surgeCount}개 (시장 비관)`);
  }

  score = clamp(score, -1, 1);

  return { name: '시장심리', score, weight: w, reason: reasons.join(', ') };
}

// ─── 포지션 보정 ─────────────────────────────────────────────

function adjustForPortfolio(
  rawScore: number,
  portfolio: PortfolioContext
): { adjustedScore: number; adjustmentReasons: string[] } {
  let adjusted = rawScore;
  const reasons: string[] = [];

  if (portfolio.isHolding) {
    // 이미 보유 중이면 추가 매수 시그널 약화
    if (rawScore > 0) {
      adjusted *= 0.6;
      reasons.push('이미 보유 중 — 추가 매수 시그널 할인');
    }
    // 수익 중이면 매도 압력 약간 강화
    if (portfolio.currentProfitRate !== null) {
      if (portfolio.currentProfitRate > 0.05) {
        adjusted -= 10;
        reasons.push(
          `수익률 +${(portfolio.currentProfitRate * 100).toFixed(1)}% — 일부 익절 고려`
        );
      } else if (portfolio.currentProfitRate < -0.03) {
        adjusted -= 15;
        reasons.push(
          `손실률 ${(portfolio.currentProfitRate * 100).toFixed(1)}% — 손절 고려`
        );
      }
    }
  }

  // 보유 종목 수 많으면 신규 매수 억제
  if (!portfolio.isHolding && portfolio.holdingCount >= 4) {
    if (adjusted > 0) {
      adjusted *= 0.5;
      reasons.push(`보유 ${portfolio.holdingCount}종목 — 신규 매수 억제`);
    }
  }

  // 오늘 거래 많으면 제동
  if (portfolio.todayTradeCount >= 15) {
    adjusted *= 0.5;
    reasons.push(`오늘 ${portfolio.todayTradeCount}회 거래 — 빈도 제동`);
  }

  // 오늘 손실 많으면 제동
  if (portfolio.todayRealizedPnL < -30000) {
    if (adjusted > 0) {
      adjusted *= 0.3;
    }
    reasons.push(
      `오늘 실현 손실 ${portfolio.todayRealizedPnL.toLocaleString()}원 — 추가 매수 억제`
    );
  }

  return { adjustedScore: adjusted, adjustmentReasons: reasons };
}

// ─── 매매 크기 결정 ──────────────────────────────────────────

function calcSuggestedSize(
  confidence: number,
  compositeScore: number,
  action: DecisionAction
): number {
  if (action === 'hold') return 0;

  if (action === 'sell') {
    // 매도: 신뢰도에 비례
    if (confidence >= 80) return 1.0; // 전량 매도
    if (confidence >= 60) return 0.5; // 절반 매도
    return 0.3; // 일부 매도
  }

  // 매수: 보수적
  const absScore = Math.abs(compositeScore);
  if (absScore >= 60 && confidence >= 70) return 0.3; // 강한 확신 → 30%
  if (absScore >= 40 && confidence >= 55) return 0.2; // 보통 확신 → 20%
  return 0.1; // 약한 확신 → 10%
}

// ─── 손절/익절 제안 ──────────────────────────────────────────

function calcStopLevels(
  price: number,
  action: DecisionAction,
  confidence: number
): { stopLoss: number | null; takeProfit: number | null } {
  if (action !== 'buy') return { stopLoss: null, takeProfit: null };

  // 신뢰도에 따라 손절/익절 폭 조정
  const stopLossRate = confidence >= 70 ? 0.025 : 0.02; // 2~2.5%
  const takeProfitRate = confidence >= 70 ? 0.05 : 0.035; // 3.5~5%

  return {
    stopLoss: Math.round(price * (1 - stopLossRate)),
    takeProfit: Math.round(price * (1 + takeProfitRate)),
  };
}

// ─── 판단 근거 텍스트 생성 ───────────────────────────────────

function buildReasoning(
  action: DecisionAction,
  confidence: number,
  compositeScore: number,
  signals: StrategySignal[],
  adjustmentReasons: string[]
): string {
  const actionLabel =
    action === 'buy' ? '매수' : action === 'sell' ? '매도' : '관망';

  const lines: string[] = [
    `[${actionLabel}] 종합점수 ${compositeScore.toFixed(1)}점 / 신뢰도 ${confidence}%`,
    '',
    '▸ 전략별 시그널:',
  ];

  for (const s of signals) {
    const dir =
      s.score > 0.2 ? '↑매수' : s.score < -0.2 ? '↓매도' : '→중립';
    lines.push(
      `  ${s.name} (${dir}, ${(s.score * 100).toFixed(0)}점, 가중치 ${(s.weight * 100).toFixed(0)}%): ${s.reason}`
    );
  }

  if (adjustmentReasons.length > 0) {
    lines.push('', '▸ 포트폴리오 보정:');
    for (const r of adjustmentReasons) {
      lines.push(`  - ${r}`);
    }
  }

  return lines.join('\n');
}

// ─── 메인 판단 함수 ──────────────────────────────────────────

export function evaluate(input: DecisionInput): TradingDecision {
  const { market, currentPrice, technicalAnalysis, marketAnalysis, portfolio } =
    input;

  // 1. 개별 전략 시그널 수집
  const signals: StrategySignal[] = [
    evalRSI(technicalAnalysis),
    evalMACD(technicalAnalysis),
    evalBollinger(technicalAnalysis),
    evalMovingAverage(technicalAnalysis),
    evalVolume(technicalAnalysis),
    evalSentiment(marketAnalysis),
  ];

  // 2. 가중 합산 (-100 ~ 100)
  let totalWeight = 0;
  let weightedSum = 0;
  for (const s of signals) {
    weightedSum += s.score * s.weight;
    totalWeight += s.weight;
  }
  const normalizedScore = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;

  // 3. 포트폴리오 보정
  const { adjustedScore, adjustmentReasons } = adjustForPortfolio(
    normalizedScore,
    portfolio
  );

  const compositeScore = clamp(Math.round(adjustedScore * 10) / 10, -100, 100);

  // 4. 신뢰도 계산 (시그널 일관성 기반)
  const positiveCount = signals.filter((s) => s.score > 0.2).length;
  const negativeCount = signals.filter((s) => s.score < -0.2).length;
  const totalSignals = signals.length;
  const agreement = Math.max(positiveCount, negativeCount) / totalSignals;
  const confidence = Math.round(
    clamp(agreement * 100 + Math.abs(compositeScore) * 0.3, 0, 100)
  );

  // 5. 최종 판단
  let action: DecisionAction = 'hold';
  const cfg = currentConfig;

  if (compositeScore >= cfg.buyThreshold && confidence >= cfg.minConfidence) {
    action = portfolio.isHolding ? 'hold' : 'buy';
  } else if (
    compositeScore <= cfg.sellThreshold &&
    confidence >= cfg.minConfidence
  ) {
    action = portfolio.isHolding ? 'sell' : 'hold';
  }

  // 보유 중 + 강한 손실 → 신뢰도 무관 손절
  if (
    portfolio.isHolding &&
    portfolio.currentProfitRate !== null &&
    portfolio.currentProfitRate < -0.03
  ) {
    action = 'sell';
  }

  // 보유 중 + 충분한 익절 → 익절 매도
  if (
    portfolio.isHolding &&
    portfolio.currentProfitRate !== null &&
    portfolio.currentProfitRate > 0.05 &&
    compositeScore < 10
  ) {
    action = 'sell';
  }

  // 6. 매매 규모, 손절/익절
  const suggestedSizeRate = calcSuggestedSize(confidence, compositeScore, action);
  const { stopLoss, takeProfit } = calcStopLevels(currentPrice, action, confidence);

  // 7. 판단 근거 텍스트
  const reasoning = buildReasoning(
    action,
    confidence,
    compositeScore,
    signals,
    adjustmentReasons
  );

  return {
    market,
    timestamp: new Date().toISOString(),
    action,
    confidence,
    compositeScore,
    signals,
    reasoning,
    suggestedSizeRate,
    currentPrice,
    suggestedStopLoss: stopLoss,
    suggestedTakeProfit: takeProfit,
  };
}
