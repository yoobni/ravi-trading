import fs from 'fs';
import path from 'path';
import type {
  RiskConfig,
  RiskCheckResult,
  RiskViolation,
  PositionRiskCheck,
  AIRiskFilterInput,
  AIRiskFilterResult,
  DailyTradeStats,
  CircuitBreakerConfig,
  CircuitBreakerState,
  RiskEvent,
  RiskEventType,
  RiskStatusSummary,
} from '@/types/risk';
import type { Order } from '@/types/order';
import { getOpenPositions, listOrders } from '@/lib/order-store';

// ──────────────────────────────────────────────
// 설정 파일 경로
// ──────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'risk-config.json');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily-stats.json');
const CB_CONFIG_FILE = path.join(DATA_DIR, 'circuit-breaker-config.json');
const CB_STATE_FILE = path.join(DATA_DIR, 'circuit-breaker-state.json');
const RISK_EVENTS_FILE = path.join(DATA_DIR, 'risk-events.json');

// ──────────────────────────────────────────────
// 기본 설정값
// ──────────────────────────────────────────────

const DEFAULT_CONFIG: RiskConfig = {
  totalCapital: 10_000_000, // 1,000만원 (모의 거래 기본)
  stopLoss: {
    stopLossRate: -3,        // 3% 하락 시 손절
    takeProfitRate: 5,       // 5% 상승 시 익절
    useTrailingStop: true,
    trailingStopRate: 2,     // 고점 대비 2% 하락 시 매도
  },
  positionSize: {
    maxAmountPerTrade: 1_000_000,     // 1건당 최대 100만원
    maxRatePerTrade: 10,              // 1건당 최대 10%
    maxTotalPosition: 7_000_000,      // 전체 포지션 최대 700만원
    maxTotalPositionRate: 70,         // 전체 포지션 최대 70%
  },
  dailyLoss: {
    maxDailyLossAmount: 500_000,      // 일일 최대 손실 50만원
    maxDailyLossRate: 5,              // 일일 최대 손실 5%
    maxDailyTrades: 20,               // 일일 최대 20건
  },
  diversification: {
    maxHoldings: 5,                   // 동시 보유 최대 5종목
    maxSingleAssetRate: 30,           // 단일 종목 최대 30%
    blockSurgeCoins: true,            // 급등/급락 종목 매수 차단
    minTradeVolume24h: 500_000_000,   // 최소 거래대금 5억원
  },
};

// ──────────────────────────────────────────────
// 설정 로드/저장
// ──────────────────────────────────────────────

/** 리스크 설정 로드 (없으면 기본값 생성 후 반환) */
export function loadRiskConfig(): RiskConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveRiskConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as RiskConfig;
}

/** 리스크 설정 저장 */
export function saveRiskConfig(config: RiskConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** 리스크 설정 부분 업데이트 */
export function updateRiskConfig(partial: Partial<RiskConfig>): RiskConfig {
  const current = loadRiskConfig();
  const updated: RiskConfig = {
    ...current,
    ...partial,
    stopLoss: { ...current.stopLoss, ...(partial.stopLoss ?? {}) },
    positionSize: { ...current.positionSize, ...(partial.positionSize ?? {}) },
    dailyLoss: { ...current.dailyLoss, ...(partial.dailyLoss ?? {}) },
    diversification: { ...current.diversification, ...(partial.diversification ?? {}) },
  };
  saveRiskConfig(updated);
  return updated;
}

// ──────────────────────────────────────────────
// 일일 거래 통계
// ──────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadDailyStats(): DailyTradeStats[] {
  if (!fs.existsSync(DAILY_STATS_FILE)) return [];
  const raw = fs.readFileSync(DAILY_STATS_FILE, 'utf-8');
  return JSON.parse(raw) as DailyTradeStats[];
}

function saveDailyStats(stats: DailyTradeStats[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

/** 오늘 거래 통계 조회 (없으면 초기화) */
export function getTodayStats(): DailyTradeStats {
  const all = loadDailyStats();
  const today = todayStr();
  const existing = all.find((s) => s.date === today);
  if (existing) return existing;

  // 오늘 주문 기록에서 계산
  const orders = listOrders();
  const todayOrders = orders.filter(
    (o) => o.createdAt.startsWith(today) && o.status === 'filled',
  );

  const sells = todayOrders.filter((o) => o.side === 'sell' && o.profitRate !== null);
  const realizedPnl = sells.reduce((sum, o) => {
    const buyOrder = o.linkedOrderId
      ? orders.find((b) => b.id === o.linkedOrderId)
      : null;
    if (!buyOrder) return sum;
    return sum + (o.totalAmount - buyOrder.totalAmount);
  }, 0);

  const stats: DailyTradeStats = {
    date: today,
    tradeCount: todayOrders.length,
    realizedPnl: Math.round(realizedPnl),
    maxDrawdown: Math.min(0, realizedPnl),
  };

  // 저장
  const updated = all.filter((s) => s.date !== today);
  updated.push(stats);
  saveDailyStats(updated);
  return stats;
}

/** 일일 통계 갱신 (거래 체결 후 호출) */
export function recordTrade(pnl: number): DailyTradeStats {
  const all = loadDailyStats();
  const today = todayStr();
  let stats = all.find((s) => s.date === today);

  if (!stats) {
    stats = { date: today, tradeCount: 0, realizedPnl: 0, maxDrawdown: 0 };
    all.push(stats);
  }

  stats.tradeCount += 1;
  stats.realizedPnl += pnl;
  stats.maxDrawdown = Math.min(stats.maxDrawdown, stats.realizedPnl);

  saveDailyStats(all);
  return stats;
}

// ──────────────────────────────────────────────
// 매수 주문 리스크 검증
// ──────────────────────────────────────────────

/**
 * 매수 주문 전 리스크 검증.
 *
 * @param market  매수 대상 종목
 * @param amount  매수 금액 (KRW)
 * @param ticker  현재가 정보 (24h 거래대금, 변동률 등)
 */
export function checkBuyRisk(
  market: string,
  amount: number,
  ticker?: { accTradePrice24h: number; signedChangeRate: number },
): RiskCheckResult {
  const config = loadRiskConfig();
  const violations: RiskViolation[] = [];
  let adjustedAmount = amount;

  // 1. 1건당 최대 금액 체크
  if (amount > config.positionSize.maxAmountPerTrade) {
    violations.push({
      rule: 'MAX_AMOUNT_PER_TRADE',
      message: `1건 최대 금액 ${config.positionSize.maxAmountPerTrade.toLocaleString()}원 초과`,
      severity: 'warn',
      currentValue: amount,
      limitValue: config.positionSize.maxAmountPerTrade,
    });
    adjustedAmount = config.positionSize.maxAmountPerTrade;
  }

  // 2. 1건당 최대 비율 체크
  const maxByRate = config.totalCapital * (config.positionSize.maxRatePerTrade / 100);
  if (amount > maxByRate) {
    violations.push({
      rule: 'MAX_RATE_PER_TRADE',
      message: `1건 최대 비율 ${config.positionSize.maxRatePerTrade}% (${maxByRate.toLocaleString()}원) 초과`,
      severity: 'warn',
      currentValue: amount,
      limitValue: maxByRate,
    });
    adjustedAmount = Math.min(adjustedAmount, maxByRate);
  }

  // 3. 전체 포지션 한도 체크
  const openPositions = getOpenPositions();
  const currentTotalPosition = openPositions.reduce((sum, o) => sum + o.totalAmount, 0);
  const maxTotalPos = Math.min(
    config.positionSize.maxTotalPosition,
    config.totalCapital * (config.positionSize.maxTotalPositionRate / 100),
  );
  const remainingCapacity = maxTotalPos - currentTotalPosition;

  if (remainingCapacity <= 0) {
    violations.push({
      rule: 'MAX_TOTAL_POSITION',
      message: `전체 포지션 한도 ${maxTotalPos.toLocaleString()}원 도달 (현재 ${currentTotalPosition.toLocaleString()}원)`,
      severity: 'block',
      currentValue: currentTotalPosition,
      limitValue: maxTotalPos,
    });
    adjustedAmount = 0;
  } else if (adjustedAmount > remainingCapacity) {
    violations.push({
      rule: 'MAX_TOTAL_POSITION',
      message: `전체 포지션 잔여 한도 ${remainingCapacity.toLocaleString()}원으로 축소`,
      severity: 'warn',
      currentValue: currentTotalPosition + adjustedAmount,
      limitValue: maxTotalPos,
    });
    adjustedAmount = remainingCapacity;
  }

  // 4. 일일 손실 한도 체크
  const todayStats = getTodayStats();
  const maxDailyLoss = Math.min(
    config.dailyLoss.maxDailyLossAmount,
    config.totalCapital * (config.dailyLoss.maxDailyLossRate / 100),
  );
  if (todayStats.realizedPnl <= -maxDailyLoss) {
    violations.push({
      rule: 'MAX_DAILY_LOSS',
      message: `일일 최대 손실 한도 도달 (${todayStats.realizedPnl.toLocaleString()}원 / -${maxDailyLoss.toLocaleString()}원)`,
      severity: 'block',
      currentValue: Math.abs(todayStats.realizedPnl),
      limitValue: maxDailyLoss,
    });
    adjustedAmount = 0;
  }

  // 5. 일일 최대 거래 횟수 체크
  if (todayStats.tradeCount >= config.dailyLoss.maxDailyTrades) {
    violations.push({
      rule: 'MAX_DAILY_TRADES',
      message: `일일 최대 거래 횟수 ${config.dailyLoss.maxDailyTrades}건 도달`,
      severity: 'block',
      currentValue: todayStats.tradeCount,
      limitValue: config.dailyLoss.maxDailyTrades,
    });
    adjustedAmount = 0;
  }

  // 6. 동시 보유 종목 수 체크
  const holdingMarkets = new Set(openPositions.map((o) => o.market));
  if (!holdingMarkets.has(market) && holdingMarkets.size >= config.diversification.maxHoldings) {
    violations.push({
      rule: 'MAX_HOLDINGS',
      message: `동시 보유 최대 ${config.diversification.maxHoldings}종목 도달 (현재 ${holdingMarkets.size}종목)`,
      severity: 'block',
      currentValue: holdingMarkets.size,
      limitValue: config.diversification.maxHoldings,
    });
    adjustedAmount = 0;
  }

  // 7. 단일 종목 비중 체크
  const currentMarketPosition = openPositions
    .filter((o) => o.market === market)
    .reduce((sum, o) => sum + o.totalAmount, 0);
  const totalAfterBuy = currentTotalPosition + adjustedAmount;
  const singleRate = totalAfterBuy > 0
    ? ((currentMarketPosition + adjustedAmount) / totalAfterBuy) * 100
    : 0;

  if (singleRate > config.diversification.maxSingleAssetRate) {
    violations.push({
      rule: 'MAX_SINGLE_ASSET_RATE',
      message: `${market} 비중 ${singleRate.toFixed(1)}% → 최대 ${config.diversification.maxSingleAssetRate}% 초과`,
      severity: 'warn',
      currentValue: singleRate,
      limitValue: config.diversification.maxSingleAssetRate,
    });
    // 비중 한도 내로 조정
    const maxForAsset =
      (config.diversification.maxSingleAssetRate / 100) * totalAfterBuy - currentMarketPosition;
    adjustedAmount = Math.min(adjustedAmount, Math.max(0, maxForAsset));
  }

  // 8. 급등/급락 종목 차단
  if (ticker && config.diversification.blockSurgeCoins) {
    const absRate = Math.abs(ticker.signedChangeRate * 100);
    if (absRate >= 10) {
      violations.push({
        rule: 'SURGE_COIN_BLOCKED',
        message: `${market} 24h 변동률 ${(ticker.signedChangeRate * 100).toFixed(1)}% — 급등/급락 종목 매수 차단`,
        severity: 'block',
        currentValue: absRate,
        limitValue: 10,
      });
      adjustedAmount = 0;
    }
  }

  // 9. 거래량 부족 체크
  if (ticker && ticker.accTradePrice24h < config.diversification.minTradeVolume24h) {
    violations.push({
      rule: 'LOW_VOLUME',
      message: `${market} 24h 거래대금 ${(ticker.accTradePrice24h / 1e8).toFixed(1)}억원 — 최소 ${(config.diversification.minTradeVolume24h / 1e8).toFixed(1)}억원 미달`,
      severity: 'block',
      currentValue: ticker.accTradePrice24h,
      limitValue: config.diversification.minTradeVolume24h,
    });
    adjustedAmount = 0;
  }

  const hasBlock = violations.some((v) => v.severity === 'block');

  return {
    allowed: !hasBlock && adjustedAmount > 0,
    violations,
    adjustedAmount: hasBlock ? null : Math.round(adjustedAmount),
    checkedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// 보유 포지션 리스크 점검 (손절/익절 판단)
// ──────────────────────────────────────────────

/**
 * 보유 포지션별 손절/익절/트레일링 스탑 판단.
 *
 * @param currentPrices  종목별 현재가 맵 { "KRW-BTC": 50000000 }
 * @param highPrices     종목별 보유 이후 고점 맵 (트레일링 스탑용)
 */
export function checkPositionRisks(
  currentPrices: Record<string, number>,
  highPrices?: Record<string, number>,
): PositionRiskCheck[] {
  const config = loadRiskConfig();
  const openPositions = getOpenPositions();
  const results: PositionRiskCheck[] = [];

  for (const position of openPositions) {
    const currentPrice = currentPrices[position.market];
    if (currentPrice === undefined) continue;

    const profitRate = ((currentPrice - position.price) / position.price) * 100;
    const violations: RiskViolation[] = [];
    let action: PositionRiskCheck['action'] = 'hold';

    // 손절 체크
    if (profitRate <= config.stopLoss.stopLossRate) {
      violations.push({
        rule: 'STOP_LOSS_HIT',
        message: `${position.market} 수익률 ${profitRate.toFixed(2)}% → 손절선 ${config.stopLoss.stopLossRate}% 도달`,
        severity: 'block',
        currentValue: profitRate,
        limitValue: config.stopLoss.stopLossRate,
      });
      action = 'stop_loss';
    }

    // 익절 체크
    if (profitRate >= config.stopLoss.takeProfitRate) {
      violations.push({
        rule: 'TAKE_PROFIT_HIT',
        message: `${position.market} 수익률 ${profitRate.toFixed(2)}% → 익절선 ${config.stopLoss.takeProfitRate}% 도달`,
        severity: 'block',
        currentValue: profitRate,
        limitValue: config.stopLoss.takeProfitRate,
      });
      action = 'take_profit';
    }

    // 트레일링 스탑 체크
    if (
      config.stopLoss.useTrailingStop &&
      highPrices &&
      highPrices[position.market] !== undefined
    ) {
      const highPrice = highPrices[position.market];
      const dropFromHigh = ((currentPrice - highPrice) / highPrice) * 100;

      if (dropFromHigh <= -config.stopLoss.trailingStopRate && profitRate > 0) {
        violations.push({
          rule: 'TRAILING_STOP_HIT',
          message: `${position.market} 고점 대비 ${dropFromHigh.toFixed(2)}% 하락 → 트레일링 스탑 ${config.stopLoss.trailingStopRate}% 도달`,
          severity: 'block',
          currentValue: Math.abs(dropFromHigh),
          limitValue: config.stopLoss.trailingStopRate,
        });
        action = 'trailing_stop';
      }
    }

    results.push({
      orderId: position.id,
      market: position.market,
      buyPrice: position.price,
      currentPrice,
      profitRate: Math.round(profitRate * 100) / 100,
      action,
      violations,
    });
  }

  return results;
}

// ──────────────────────────────────────────────
// AI 리스크 필터
// ──────────────────────────────────────────────

/**
 * AI 판단을 리스크 관점에서 한번 더 검증.
 * 기술적 지표 + 시장 흐름을 종합하여 리스크 점수 산출.
 */
export function evaluateAIRiskFilter(input: AIRiskFilterInput): AIRiskFilterResult {
  const warnings: string[] = [];
  let riskScore = 0;

  // ── 1. 기술적 분석 기반 리스크 ──
  if (input.technicalAnalysis) {
    const ta = input.technicalAnalysis;
    const rsiValues = ta.rsi.values.filter((v): v is number => v !== null);
    const latestRSI = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;

    // RSI 과매수 (70 이상)
    if (latestRSI >= 70) {
      riskScore += 25;
      warnings.push(`RSI ${latestRSI.toFixed(1)} — 과매수 구간`);
    } else if (latestRSI >= 60) {
      riskScore += 10;
    }

    // RSI 과매도 (30 이하) — 반등 기대이나 추가 하락 리스크
    if (latestRSI <= 30) {
      riskScore += 15;
      warnings.push(`RSI ${latestRSI.toFixed(1)} — 과매도 구간, 추가 하락 주의`);
    }

    // 볼린저 밴드 — 상단 돌파 시 과열
    const bbPercentB = ta.bollingerBand.percentB.filter((v): v is number => v !== null);
    const latestPercentB = bbPercentB.length > 0 ? bbPercentB[bbPercentB.length - 1] : 0.5;

    if (latestPercentB > 1.0) {
      riskScore += 20;
      warnings.push(`볼린저 밴드 상단 돌파 (%B=${latestPercentB.toFixed(2)}) — 과열 주의`);
    } else if (latestPercentB > 0.8) {
      riskScore += 10;
    }

    // MACD 데드크로스 확인
    const macdHist = ta.macd.histogram.filter((v): v is number => v !== null);
    if (macdHist.length >= 2) {
      const latest = macdHist[macdHist.length - 1];
      const prev = macdHist[macdHist.length - 2];
      if (latest < 0 && prev >= 0) {
        riskScore += 15;
        warnings.push('MACD 데드크로스 발생 — 하락 전환 신호');
      }
    }

    // 거래량 급증 (펌핑 의심)
    if (ta.volume.isSurge && ta.volume.volumeRatio > 3) {
      riskScore += 15;
      warnings.push(`거래량 ${ta.volume.volumeRatio.toFixed(1)}배 급증 — 비정상 거래 주의`);
    }
  }

  // ── 2. 시장 흐름 기반 리스크 ──
  if (input.marketAnalysis) {
    const ma = input.marketAnalysis;

    // 극도의 공포 시장 — 매수 리스크 높음
    if (ma.fearGreed.score <= 20) {
      riskScore += 20;
      warnings.push(`시장 공포/탐욕 지수 ${ma.fearGreed.score} — 극도의 공포`);
    }

    // 극도의 탐욕 — 고점 매수 리스크
    if (ma.fearGreed.score >= 80) {
      riskScore += 15;
      warnings.push(`시장 공포/탐욕 지수 ${ma.fearGreed.score} — 극도의 탐욕, 고점 매수 주의`);
    }

    // 급등 종목이면 추가 리스크
    const isSurge = ma.surges.some((s) => s.market === input.market);
    if (isSurge) {
      riskScore += 20;
      warnings.push(`${input.market} — 급등 종목 (FOMO 매수 주의)`);
    }

    // 급락 종목이면 추가 리스크
    const isCrash = ma.crashes.some((s) => s.market === input.market);
    if (isCrash) {
      riskScore += 20;
      warnings.push(`${input.market} — 급락 종목 (낙폭 과대 함정 주의)`);
    }
  }

  // ── 3. 금액 기반 리스크 ──
  const config = loadRiskConfig();
  const capitalRate = (input.amount / config.totalCapital) * 100;
  if (capitalRate > 15) {
    riskScore += 10;
    warnings.push(`투자 금액 비중 ${capitalRate.toFixed(1)}% — 고비중 투자`);
  }

  // 점수 클램핑
  riskScore = Math.min(100, Math.max(0, riskScore));

  // 50점 이상이면 차단
  const passed = riskScore < 50;

  const reasoning = passed
    ? `리스크 점수 ${riskScore}/100 — 허용 범위 내`
    : `리스크 점수 ${riskScore}/100 — 위험 수준 초과 (기준: 50)`;

  return { passed, riskScore, reasoning, warnings };
}

// ──────────────────────────────────────────────
// 종합 리스크 검증 (매수 전 최종 게이트)
// ──────────────────────────────────────────────

/**
 * 매수 주문 전 모든 리스크를 종합 검증하는 최종 게이트.
 *
 * 1단계: 규칙 기반 리스크 체크 (checkBuyRisk)
 * 2단계: AI 리스크 필터 (evaluateAIRiskFilter)
 *
 * 두 단계 모두 통과해야 매수 허용.
 */
export function validateOrder(
  market: string,
  amount: number,
  reasoning: string,
  ticker?: { accTradePrice24h: number; signedChangeRate: number },
  technicalAnalysis?: AIRiskFilterInput['technicalAnalysis'],
  marketAnalysis?: AIRiskFilterInput['marketAnalysis'],
): RiskCheckResult {
  // 1단계: 규칙 기반 리스크
  const ruleCheck = checkBuyRisk(market, amount, ticker);

  if (!ruleCheck.allowed) {
    return ruleCheck;
  }

  // 2단계: AI 리스크 필터
  const aiFilter = evaluateAIRiskFilter({
    market,
    amount: ruleCheck.adjustedAmount ?? amount,
    reasoning,
    technicalAnalysis: technicalAnalysis ?? null,
    marketAnalysis: marketAnalysis ?? null,
  });

  if (!aiFilter.passed) {
    ruleCheck.allowed = false;
    ruleCheck.adjustedAmount = null;
    ruleCheck.violations.push({
      rule: 'AI_RISK_FILTER',
      message: `AI 리스크 필터 차단: ${aiFilter.reasoning}`,
      severity: 'block',
      currentValue: aiFilter.riskScore,
      limitValue: 50,
    });
    logRiskEvent('ai_filter_block', market, null, aiFilter.reasoning, {
      riskScore: aiFilter.riskScore,
      warnings: aiFilter.warnings,
    });
  }

  // 위반 이벤트 로깅
  for (const v of ruleCheck.violations) {
    if (v.rule !== 'AI_RISK_FILTER') {
      logRiskEvent(
        v.severity === 'block' ? 'violation_block' : 'violation_warn',
        market,
        null,
        v.message,
        { rule: v.rule, currentValue: v.currentValue, limitValue: v.limitValue },
      );
    }
  }

  return ruleCheck;
}

// ──────────────────────────────────────────────
// 서킷 브레이커
// ──────────────────────────────────────────────

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  maxDrawdownRate: 10,          // 초기 자본 대비 10% 손실 시 발동
  maxConsecutiveLosses: 5,      // 연속 5회 손실 시 발동
  maxTradesPerHour: 30,         // 1시간 30건 초과 시 발동
  cooldownMs: 30 * 60 * 1000,  // 30분 쿨다운 후 자동 복구
};

/** 서킷 브레이커 설정 로드 */
export function loadCircuitBreakerConfig(): CircuitBreakerConfig {
  if (!fs.existsSync(CB_CONFIG_FILE)) {
    saveCircuitBreakerConfig(DEFAULT_CB_CONFIG);
    return { ...DEFAULT_CB_CONFIG };
  }
  const raw = fs.readFileSync(CB_CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as CircuitBreakerConfig;
}

/** 서킷 브레이커 설정 저장 */
export function saveCircuitBreakerConfig(config: CircuitBreakerConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CB_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** 서킷 브레이커 설정 업데이트 */
export function updateCircuitBreakerConfig(
  partial: Partial<CircuitBreakerConfig>,
): CircuitBreakerConfig {
  const current = loadCircuitBreakerConfig();
  const updated = { ...current, ...partial };
  saveCircuitBreakerConfig(updated);
  return updated;
}

/** 서킷 브레이커 상태 로드 */
export function loadCircuitBreakerState(): CircuitBreakerState {
  if (!fs.existsSync(CB_STATE_FILE)) {
    const initial: CircuitBreakerState = {
      tripped: false,
      reason: null,
      trippedAt: null,
      consecutiveLosses: 0,
      recoversAt: null,
    };
    saveCircuitBreakerState(initial);
    return initial;
  }
  const raw = fs.readFileSync(CB_STATE_FILE, 'utf-8');
  return JSON.parse(raw) as CircuitBreakerState;
}

function saveCircuitBreakerState(state: CircuitBreakerState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CB_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 서킷 브레이커 점검.
 * 거래 실행 전 호출하여 거래 가능 여부를 확인합니다.
 *
 * @param totalEquity  현재 총 자산 (KRW)
 * @param initialCapital  초기 자본 (KRW)
 * @returns true이면 거래 가능, false이면 거래 중단
 */
export function checkCircuitBreaker(
  totalEquity: number,
  initialCapital: number,
): boolean {
  const cbConfig = loadCircuitBreakerConfig();
  const state = loadCircuitBreakerState();

  // 이미 트립된 상태면 쿨다운 확인
  if (state.tripped) {
    if (state.recoversAt) {
      const recoveryTime = new Date(state.recoversAt).getTime();
      if (Date.now() >= recoveryTime) {
        // 자동 복구
        resetCircuitBreaker('자동 복구 (쿨다운 만료)');
        return true;
      }
    }
    return false; // 여전히 트립 상태
  }

  // 1. 총 자산 낙폭 체크
  if (initialCapital > 0) {
    const drawdownRate = ((initialCapital - totalEquity) / initialCapital) * 100;
    if (drawdownRate >= cbConfig.maxDrawdownRate) {
      tripCircuitBreaker(
        cbConfig,
        `총 자산 낙폭 ${drawdownRate.toFixed(1)}% — 한도 ${cbConfig.maxDrawdownRate}% 초과`,
      );
      return false;
    }
  }

  // 2. 연속 손실 횟수 체크
  if (state.consecutiveLosses >= cbConfig.maxConsecutiveLosses) {
    tripCircuitBreaker(
      cbConfig,
      `연속 ${state.consecutiveLosses}회 손실 — 한도 ${cbConfig.maxConsecutiveLosses}회 초과`,
    );
    return false;
  }

  // 3. 시간당 거래 횟수 체크
  const recentEvents = loadRiskEvents();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentTradeCount = recentEvents.filter(
    (e) =>
      (e.type === 'violation_warn' || e.type === 'stop_loss' || e.type === 'take_profit' || e.type === 'trailing_stop') &&
      new Date(e.timestamp).getTime() > oneHourAgo,
  ).length;

  if (recentTradeCount >= cbConfig.maxTradesPerHour) {
    tripCircuitBreaker(
      cbConfig,
      `1시간 내 ${recentTradeCount}건 이벤트 — 한도 ${cbConfig.maxTradesPerHour}건 초과`,
    );
    return false;
  }

  return true;
}

/** 서킷 브레이커 발동 */
function tripCircuitBreaker(cbConfig: CircuitBreakerConfig, reason: string): void {
  const now = new Date();
  const state: CircuitBreakerState = {
    tripped: true,
    reason,
    trippedAt: now.toISOString(),
    consecutiveLosses: loadCircuitBreakerState().consecutiveLosses,
    recoversAt: cbConfig.cooldownMs > 0
      ? new Date(now.getTime() + cbConfig.cooldownMs).toISOString()
      : null,
  };
  saveCircuitBreakerState(state);
  logRiskEvent('circuit_breaker_trip', null, null, reason, {
    recoversAt: state.recoversAt,
  });
  console.log(`[서킷 브레이커] 발동: ${reason}`);
}

/** 서킷 브레이커 수동/자동 해제 */
export function resetCircuitBreaker(reason?: string): CircuitBreakerState {
  const state: CircuitBreakerState = {
    tripped: false,
    reason: null,
    trippedAt: null,
    consecutiveLosses: 0,
    recoversAt: null,
  };
  saveCircuitBreakerState(state);
  logRiskEvent('circuit_breaker_reset', null, null, reason ?? '수동 해제', null);
  console.log(`[서킷 브레이커] 해제: ${reason ?? '수동 해제'}`);
  return state;
}

/** 거래 결과에 따라 연속 손실 카운터 갱신 */
export function updateConsecutiveLosses(pnl: number): void {
  const state = loadCircuitBreakerState();
  if (pnl < 0) {
    state.consecutiveLosses += 1;
  } else if (pnl > 0) {
    state.consecutiveLosses = 0; // 수익 거래 시 리셋
  }
  saveCircuitBreakerState(state);
}

// ──────────────────────────────────────────────
// 리스크 이벤트 로그
// ──────────────────────────────────────────────

function loadRiskEvents(): RiskEvent[] {
  if (!fs.existsSync(RISK_EVENTS_FILE)) return [];
  const raw = fs.readFileSync(RISK_EVENTS_FILE, 'utf-8');
  return JSON.parse(raw) as RiskEvent[];
}

function saveRiskEvents(events: RiskEvent[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RISK_EVENTS_FILE, JSON.stringify(events, null, 2), 'utf-8');
}

/** 리스크 이벤트 기록 */
export function logRiskEvent(
  type: RiskEventType,
  market: string | null,
  orderId: string | null,
  message: string,
  details: Record<string, unknown> | null,
): RiskEvent {
  const events = loadRiskEvents();
  const event: RiskEvent = {
    id: `re_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    timestamp: new Date().toISOString(),
    market,
    orderId,
    message,
    details,
  };
  events.push(event);

  // 최대 1000건 유지 (오래된 것부터 삭제)
  if (events.length > 1000) {
    events.splice(0, events.length - 1000);
  }

  saveRiskEvents(events);
  return event;
}

/** 오늘 리스크 이벤트 조회 */
export function getTodayRiskEvents(): RiskEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  return loadRiskEvents().filter((e) => e.timestamp.startsWith(today));
}

/** 최근 N건 리스크 이벤트 조회 */
export function getRecentRiskEvents(count: number): RiskEvent[] {
  const events = loadRiskEvents();
  return events.slice(-count);
}

/** 타입별 리스크 이벤트 조회 */
export function getRiskEventsByType(type: RiskEventType): RiskEvent[] {
  return loadRiskEvents().filter((e) => e.type === type);
}

// ──────────────────────────────────────────────
// 리스크 현황 요약 (대시보드용)
// ──────────────────────────────────────────────

/**
 * 리스크 현황 전체 요약.
 * 대시보드 API에서 호출합니다.
 */
export function getRiskStatus(): RiskStatusSummary {
  const config = loadRiskConfig();
  const cbState = loadCircuitBreakerState();
  const todayStats = getTodayStats();
  const todayEvents = getTodayRiskEvents();
  const recentEvents = getRecentRiskEvents(10);
  const openPositions = getOpenPositions();

  const currentTotalPosition = openPositions.reduce((sum, o) => sum + o.totalAmount, 0);
  const maxTotalPos = Math.min(
    config.positionSize.maxTotalPosition,
    config.totalCapital * (config.positionSize.maxTotalPositionRate / 100),
  );
  const positionUsageRate = maxTotalPos > 0
    ? (currentTotalPosition / maxTotalPos) * 100
    : 0;

  const maxDailyLoss = Math.min(
    config.dailyLoss.maxDailyLossAmount,
    config.totalCapital * (config.dailyLoss.maxDailyLossRate / 100),
  );
  const dailyLossUsageRate = maxDailyLoss > 0
    ? (Math.abs(Math.min(0, todayStats.realizedPnl)) / maxDailyLoss) * 100
    : 0;

  return {
    config,
    circuitBreaker: cbState,
    todayStats,
    todayEventCount: todayEvents.length,
    recentEvents,
    openPositionCount: openPositions.length,
    positionUsageRate: Math.round(positionUsageRate * 10) / 10,
    dailyLossUsageRate: Math.round(dailyLossUsageRate * 10) / 10,
    checkedAt: new Date().toISOString(),
  };
}
