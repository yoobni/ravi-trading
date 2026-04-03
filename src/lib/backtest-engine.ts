/**
 * 백테스트 엔진
 *
 * 과거 캔들 데이터로 전략 성과를 시뮬레이션한다.
 * 기존 분석/판단 파이프라인(indicators.analyze, trading-engine.evaluate)을 그대로 재사용.
 * 포트폴리오 상태는 인메모리로 관리하여 실제 계좌에 영향 없음.
 *
 * 흐름:
 *  1. 업비트 API에서 과거 캔들 데이터 일괄 수집
 *  2. 슬라이딩 윈도우로 lookback 캔들 구간 이동
 *  3. 각 스텝에서: 기술 분석 → 알고리즘 판단 → 모의 체결
 *  4. 결과 집계: 수익률, 승률, MDD, 샤프비율 등
 */

import { getUpbitClient } from '@/lib/upbit-client';
import { analyze } from '@/lib/indicators';
import { evaluate, updateEngineConfig, getEngineConfig, resetEngineConfig } from '@/lib/trading-engine';
import type { UpbitCandle } from '@/types/upbit';
import type { MarketAnalysis } from '@/types/market-analysis';
import type { DecisionInput, PortfolioContext, TradingDecision, DecisionEngineConfig } from '@/types/trading-decision';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestPosition,
  BacktestTrade,
  EquityPoint,
  PeriodStats,
  DEFAULT_BACKTEST_CONFIG,
} from '@/types/backtest';

// ──────────────────────────────────────────────
// 캔들 데이터 수집
// ──────────────────────────────────────────────

/**
 * 업비트 API에서 과거 캔들 데이터를 기간 기반으로 수집.
 * 200개씩 페이지네이션하여 전체 기간의 캔들을 가져온다.
 */
export async function fetchHistoricalCandles(
  market: string,
  candleUnit: number,
  startDate: string,
  endDate: string,
): Promise<UpbitCandle[]> {
  const client = getUpbitClient();
  const allCandles: UpbitCandle[] = [];
  const startTs = new Date(startDate).getTime();
  const endTs = new Date(endDate).getTime();

  // 업비트 API: 'to' 파라미터로 해당 시각 이전 캔들을 가져옴
  let cursor = new Date(endDate).toISOString().replace('T', ' ').slice(0, 19);
  const pageSize = 200;
  const maxPages = 500; // 안전 장치

  for (let page = 0; page < maxPages; page++) {
    const candles = await client.getCandlesMinutes(
      candleUnit as any,
      market,
      pageSize,
      cursor,
    );

    if (candles.length === 0) break;

    // 시간순 정렬 (업비트 응답은 최신→과거)
    const sorted = candles.sort((a, b) => a.timestamp - b.timestamp);

    // startDate 이전 캔들 필터링
    const filtered = sorted.filter((c) => c.timestamp >= startTs && c.timestamp <= endTs);
    allCandles.push(...filtered);

    // 가장 오래된 캔들이 startDate 이전이면 종료
    const oldest = sorted[0];
    if (oldest.timestamp <= startTs) break;

    // 다음 페이지 커서: 가장 오래된 캔들의 시각
    cursor = oldest.candle_date_time_utc.replace('T', ' ');

    // 레이트 리밋 방지
    await new Promise((r) => setTimeout(r, 120));
  }

  // 중복 제거 및 시간순 정렬
  const seen = new Set<number>();
  const unique = allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  return unique.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * lookback 캔들도 포함하여 데이터를 수집.
 * startDate 이전 lookback * candleUnit 분만큼 추가 수집.
 */
export async function fetchCandlesWithLookback(
  config: BacktestConfig,
): Promise<UpbitCandle[]> {
  const lookbackMinutes = config.lookbackCandles * config.candleUnit;
  const adjustedStart = new Date(
    new Date(config.startDate).getTime() - lookbackMinutes * 60 * 1000,
  ).toISOString();

  return fetchHistoricalCandles(
    config.market,
    config.candleUnit,
    adjustedStart,
    config.endDate,
  );
}

// ──────────────────────────────────────────────
// 가짜 시장 분석 (백테스트용 중립 값)
// ──────────────────────────────────────────────

function createNeutralMarketAnalysis(): MarketAnalysis {
  return {
    analyzedAt: new Date().toISOString(),
    btcDominance: {
      btcTradePrice24h: 0,
      totalTradePrice24h: 0,
      dominanceRate: 45,
      btcPrice: 0,
      btcChangeRate: 0,
    },
    topVolume: [],
    surges: [],
    crashes: [],
    fearGreed: {
      score: 50,
      label: 'neutral',
      components: {
        volatility: 50,
        volumeMomentum: 50,
        marketStrength: 50,
        dominanceFactor: 50,
      },
    },
    summary: '[백테스트] 시장 분석 미적용 — 중립 기본값 사용',
  };
}

// ──────────────────────────────────────────────
// 포트폴리오 상태 관리 (인메모리)
// ──────────────────────────────────────────────

interface BacktestPortfolio {
  cash: number;
  initialCapital: number;
  position: BacktestPosition | null;
  trades: BacktestTrade[];
  totalFees: number;
  totalRealizedPnl: number;
  todayTradeCount: number;
  todayDate: string;
  todayRealizedPnl: number;
}

function createPortfolio(initialCapital: number): BacktestPortfolio {
  return {
    cash: initialCapital,
    initialCapital,
    position: null,
    trades: [],
    totalFees: 0,
    totalRealizedPnl: 0,
    todayTradeCount: 0,
    todayDate: '',
    todayRealizedPnl: 0,
  };
}

function getPortfolioContext(
  portfolio: BacktestPortfolio,
  market: string,
  currentPrice: number,
): PortfolioContext {
  const isHolding = portfolio.position !== null && portfolio.position.market === market;
  let avgBuyPrice: number | null = null;
  let currentProfitRate: number | null = null;

  if (isHolding && portfolio.position) {
    avgBuyPrice = portfolio.position.entryPrice;
    currentProfitRate = (currentPrice - avgBuyPrice) / avgBuyPrice;
  }

  return {
    isHolding,
    avgBuyPrice,
    currentProfitRate,
    holdingCount: portfolio.position ? 1 : 0,
    totalPositionAmount: portfolio.position
      ? portfolio.position.volume * currentPrice
      : 0,
    availableBalance: portfolio.cash,
    todayTradeCount: portfolio.todayTradeCount,
    todayRealizedPnL: portfolio.todayRealizedPnl,
  };
}

function executeBuy(
  portfolio: BacktestPortfolio,
  config: BacktestConfig,
  decision: TradingDecision,
  candleIndex: number,
  candleTime: string,
): void {
  if (portfolio.position !== null) return; // 이미 보유 중

  const amount = portfolio.cash * decision.suggestedSizeRate;
  if (amount < 5000) return; // 최소 주문 금액

  const slippedPrice = decision.currentPrice * (1 + config.fee.slippageRate);
  const volume = amount / slippedPrice;
  const fee = amount * config.fee.feeRate;
  const totalCost = amount + fee;

  if (totalCost > portfolio.cash) return;

  portfolio.cash -= totalCost;
  portfolio.totalFees += fee;

  portfolio.position = {
    entryIndex: candleIndex,
    entryTime: candleTime,
    market: config.market,
    entryPrice: slippedPrice,
    volume,
    totalCost,
    entryFee: fee,
  };

  portfolio.todayTradeCount++;
}

function executeSell(
  portfolio: BacktestPortfolio,
  config: BacktestConfig,
  decision: TradingDecision,
  candleIndex: number,
  candleTime: string,
): void {
  if (!portfolio.position) return;

  const pos = portfolio.position;
  const slippedPrice = decision.currentPrice * (1 - config.fee.slippageRate);
  const grossProceeds = pos.volume * slippedPrice;
  const fee = grossProceeds * config.fee.feeRate;
  const netProceeds = grossProceeds - fee;

  const profit = netProceeds - pos.totalCost;
  const profitRate = ((slippedPrice - pos.entryPrice) / pos.entryPrice) * 100;

  portfolio.cash += netProceeds;
  portfolio.totalFees += fee;
  portfolio.totalRealizedPnl += profit;
  portfolio.todayRealizedPnl += profit;
  portfolio.todayTradeCount++;

  const trade: BacktestTrade = {
    market: config.market,
    entryTime: pos.entryTime,
    exitTime: candleTime,
    entryPrice: pos.entryPrice,
    exitPrice: slippedPrice,
    volume: pos.volume,
    totalCost: pos.totalCost,
    totalProceeds: netProceeds,
    profit: Math.round(profit),
    profitRate: Math.round(profitRate * 100) / 100,
    totalFee: Math.round(pos.entryFee + fee),
    holdingPeriod: candleIndex - pos.entryIndex,
    entryReasoning: '', // 진입 시 이미 기록
    exitReasoning: decision.reasoning,
    entryDecision: null as any, // 아래에서 채움
    exitDecision: decision,
  };

  portfolio.trades.push(trade);
  portfolio.position = null;
}

// ──────────────────────────────────────────────
// 에퀴티 평가
// ──────────────────────────────────────────────

function evaluateEquity(
  portfolio: BacktestPortfolio,
  currentPrice: number,
): { equity: number; positionValue: number } {
  const positionValue = portfolio.position
    ? portfolio.position.volume * currentPrice
    : 0;
  return {
    equity: portfolio.cash + positionValue,
    positionValue,
  };
}

// ──────────────────────────────────────────────
// 통계 계산
// ──────────────────────────────────────────────

function calcPeriodStats(
  trades: BacktestTrade[],
  initialCapital: number,
  groupFn: (t: BacktestTrade) => string,
): PeriodStats[] {
  const groups = new Map<string, BacktestTrade[]>();

  for (const t of trades) {
    const key = groupFn(t);
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  let runningEquity = initialCapital;
  const stats: PeriodStats[] = [];

  for (const [period, periodTrades] of groups) {
    const wins = periodTrades.filter((t) => t.profit > 0);
    const losses = periodTrades.filter((t) => t.profit <= 0);
    const profit = periodTrades.reduce((s, t) => s + t.profit, 0);

    runningEquity += profit;

    stats.push({
      period,
      tradeCount: periodTrades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: periodTrades.length > 0
        ? Math.round((wins.length / periodTrades.length) * 10000) / 100
        : 0,
      profit: Math.round(profit),
      profitRate: Math.round((profit / initialCapital) * 10000) / 100,
      equity: Math.round(runningEquity),
    });
  }

  return stats;
}

function calcSharpeRatio(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev === 0) continue;
    returns.push((equityCurve[i].equity - prev) / prev);
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // 연환산 (5분 캔들 기준 약 105,120 스텝/년)
  const annualizationFactor = Math.sqrt(returns.length);
  return Math.round((mean / stdDev) * annualizationFactor * 100) / 100;
}

function calcMaxDrawdown(equityCurve: EquityPoint[]): { mdd: number; duration: number } {
  let peak = 0;
  let mdd = 0;
  let mddDuration = 0;
  let drawdownStart = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const eq = equityCurve[i].equity;
    if (eq > peak) {
      peak = eq;
      drawdownStart = i;
    }
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > mdd) {
      mdd = dd;
      mddDuration = i - drawdownStart;
    }
  }

  return {
    mdd: Math.round(mdd * 100) / 100,
    duration: mddDuration,
  };
}

// ──────────────────────────────────────────────
// 메인 백테스트 실행
// ──────────────────────────────────────────────

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const startMs = Date.now();

  // 엔진 설정 백업 → 복원
  const originalConfig = getEngineConfig();
  if (config.engineConfig) {
    updateEngineConfig(config.engineConfig);
  }

  try {
    // 1. 캔들 데이터 수집
    const candles = await fetchCandlesWithLookback(config);

    if (candles.length < config.lookbackCandles + 10) {
      throw new Error(
        `캔들 데이터 부족: ${candles.length}개 (최소 ${config.lookbackCandles + 10}개 필요)`,
      );
    }

    const startTs = new Date(config.startDate).getTime();
    // lookback 시작 인덱스 찾기
    let evalStartIndex = 0;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].timestamp >= startTs) {
        evalStartIndex = Math.max(i, config.lookbackCandles);
        break;
      }
    }

    // 2. 포트폴리오 초기화
    const portfolio = createPortfolio(config.initialCapital);
    const neutralMarket = createNeutralMarketAnalysis();
    const equityCurve: EquityPoint[] = [];

    // 에퀴티 샘플링 간격 (약 100~200 포인트)
    const totalSteps = candles.length - evalStartIndex;
    const sampleInterval = Math.max(1, Math.floor(totalSteps / 200));

    // 진입 시 decision 임시 저장
    let lastEntryDecision: TradingDecision | null = null;

    // 3. 슬라이딩 윈도우 루프
    for (let i = evalStartIndex; i < candles.length; i++) {
      const windowCandles = candles.slice(
        Math.max(0, i - config.lookbackCandles + 1),
        i + 1,
      );
      const currentCandle = candles[i];
      const currentPrice = currentCandle.trade_price;
      const candleTime = currentCandle.candle_date_time_kst;

      // 일별 카운터 리셋
      const candleDate = candleTime.slice(0, 10);
      if (candleDate !== portfolio.todayDate) {
        portfolio.todayDate = candleDate;
        portfolio.todayTradeCount = 0;
        portfolio.todayRealizedPnl = 0;
      }

      // 기술 분석
      const ta = analyze(windowCandles);

      // 포트폴리오 컨텍스트
      const portfolioCtx = getPortfolioContext(portfolio, config.market, currentPrice);

      // 판단 입력 구성
      const input: DecisionInput = {
        market: config.market,
        currentPrice,
        technicalAnalysis: ta,
        marketAnalysis: neutralMarket,
        portfolio: portfolioCtx,
      };

      // 알고리즘 판단
      const decision = evaluate(input);

      // 체결
      if (decision.action === 'buy' && !portfolio.position) {
        executeBuy(portfolio, config, decision, i, candleTime);
        lastEntryDecision = decision;

        // 마지막 trade에 entryReasoning 기록
        // (아직 trade 생성 안됨 — 매도 시 기록)
      } else if (decision.action === 'sell' && portfolio.position) {
        executeSell(portfolio, config, decision, i, candleTime);

        // 방금 추가된 trade에 entry 정보 보충
        const lastTrade = portfolio.trades[portfolio.trades.length - 1];
        if (lastTrade && lastEntryDecision) {
          lastTrade.entryReasoning = lastEntryDecision.reasoning;
          lastTrade.entryDecision = lastEntryDecision;
        }
        lastEntryDecision = null;
      }

      // 에퀴티 커브 샘플링
      if ((i - evalStartIndex) % sampleInterval === 0 || i === candles.length - 1) {
        const { equity, positionValue } = evaluateEquity(portfolio, currentPrice);
        equityCurve.push({
          time: candleTime,
          index: i,
          equity: Math.round(equity),
          cash: Math.round(portfolio.cash),
          positionValue: Math.round(positionValue),
          returnRate:
            Math.round(
              ((equity - config.initialCapital) / config.initialCapital) * 10000,
            ) / 100,
        });
      }
    }

    // 마지막에 미청산 포지션 강제 청산
    if (portfolio.position) {
      const lastCandle = candles[candles.length - 1];
      const forceDecision: TradingDecision = {
        market: config.market,
        timestamp: lastCandle.candle_date_time_kst,
        action: 'sell',
        confidence: 100,
        compositeScore: 0,
        signals: [],
        reasoning: '[백테스트 종료] 미청산 포지션 강제 청산',
        suggestedSizeRate: 1,
        currentPrice: lastCandle.trade_price,
        suggestedStopLoss: null,
        suggestedTakeProfit: null,
      };
      executeSell(portfolio, config, forceDecision, candles.length - 1, lastCandle.candle_date_time_kst);

      const lastTrade = portfolio.trades[portfolio.trades.length - 1];
      if (lastTrade && lastEntryDecision) {
        lastTrade.entryReasoning = lastEntryDecision.reasoning;
        lastTrade.entryDecision = lastEntryDecision;
      }
    }

    // 4. 결과 집계
    const trades = portfolio.trades;
    const wins = trades.filter((t) => t.profit > 0);
    const losses = trades.filter((t) => t.profit <= 0);

    const finalEquity = portfolio.cash;
    const totalReturnRate =
      Math.round(
        ((finalEquity - config.initialCapital) / config.initialCapital) * 10000,
      ) / 100;

    // 연환산 수익률
    const startD = new Date(config.startDate).getTime();
    const endD = new Date(config.endDate).getTime();
    const daysDiff = (endD - startD) / (1000 * 60 * 60 * 24);
    const annualizedReturn =
      daysDiff > 0
        ? Math.round(
            ((Math.pow(1 + totalReturnRate / 100, 365 / daysDiff) - 1) * 100) * 100,
          ) / 100
        : 0;

    const avgProfitRate =
      trades.length > 0
        ? Math.round(
            (trades.reduce((s, t) => s + t.profitRate, 0) / trades.length) * 100,
          ) / 100
        : 0;

    const avgHoldingPeriod =
      trades.length > 0
        ? Math.round(
            trades.reduce((s, t) => s + t.holdingPeriod, 0) / trades.length,
          )
        : 0;

    const avgWinRate =
      wins.length > 0
        ? Math.round(
            (wins.reduce((s, t) => s + t.profitRate, 0) / wins.length) * 100,
          ) / 100
        : 0;

    const avgLossRate =
      losses.length > 0
        ? Math.round(
            (losses.reduce((s, t) => s + t.profitRate, 0) / losses.length) * 100,
          ) / 100
        : 0;

    const profitFactor =
      avgLossRate !== 0
        ? Math.round((Math.abs(avgWinRate / avgLossRate)) * 100) / 100
        : wins.length > 0
          ? Infinity
          : 0;

    const { mdd, duration: mddDuration } = calcMaxDrawdown(equityCurve);
    const sharpeRatio = calcSharpeRatio(equityCurve);

    // 일별/주별 통계
    const dailyStats = calcPeriodStats(trades, config.initialCapital, (t) =>
      t.exitTime.slice(0, 10),
    );
    const weeklyStats = calcPeriodStats(trades, config.initialCapital, (t) => {
      const d = new Date(t.exitTime);
      const week = getISOWeek(d);
      return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    });

    return {
      config,
      executedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      totalCandles: candles.length,
      evaluatedSteps: totalSteps,

      initialCapital: config.initialCapital,
      finalEquity: Math.round(finalEquity),
      totalReturnRate,
      annualizedReturn,
      totalProfit: Math.round(portfolio.totalRealizedPnl),
      totalFees: Math.round(portfolio.totalFees),

      tradeCount: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate:
        trades.length > 0
          ? Math.round((wins.length / trades.length) * 10000) / 100
          : 0,
      avgProfitRate,
      avgHoldingPeriod,
      bestTradeRate:
        trades.length > 0
          ? Math.max(...trades.map((t) => t.profitRate))
          : 0,
      worstTradeRate:
        trades.length > 0
          ? Math.min(...trades.map((t) => t.profitRate))
          : 0,
      avgWinRate,
      avgLossRate,
      profitFactor,

      maxDrawdown: mdd,
      maxDrawdownDuration: mddDuration,
      sharpeRatio,

      trades,
      equityCurve,
      dailyStats,
      weeklyStats,
    };
  } finally {
    // 엔진 설정 복원
    resetEngineConfig();
    if (originalConfig) {
      updateEngineConfig(originalConfig);
    }
  }
}

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
