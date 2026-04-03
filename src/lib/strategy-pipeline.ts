/**
 * 매매 전략 통합 파이프라인
 *
 * 기술 분석 + 시장 흐름 + AI 판단 + 리스크 관리를 하나의 파이프라인으로 통합.
 * 종목 스크리닝 → 분석 → AI 판단 → 리스크 체크 → 주문 실행 흐름.
 *
 * 스케줄러에서 직접 호출하거나, 단일 종목 분석 API로도 사용 가능.
 */

import crypto from 'crypto';
import { getUpbitClient } from '@/lib/upbit-client';
import { analyzeMarket } from '@/lib/market-analysis';
import { analyze as technicalAnalyze } from '@/lib/indicators';
import { evaluate as algorithmEvaluate } from '@/lib/trading-engine';
import { evaluateWithAI } from '@/lib/ai-judgment-engine';
import {
  executeBuy,
  executeSell,
  getBalanceSummary,
  loadBalance,
} from '@/lib/paper-trading-engine';
import {
  checkBuyRisk,
  getTodayStats,
} from '@/lib/risk-manager';
import { getOpenPositions } from '@/lib/order-store';
import { selectMarkets } from '@/lib/market-selector';
import type { TradingDecision, PortfolioContext, DecisionInput } from '@/types/trading-decision';
import type { MarketAnalysis } from '@/types/market-analysis';
import type { TechnicalAnalysis } from '@/types/indicator';
import type {
  PipelineConfig,
  PipelineResult,
  PipelineStage,
  StageTrace,
  ScreeningStageResult,
  AnalysisStageResult,
  JudgmentStageResult,
  RiskStageResult,
  ExecutionStageResult,
  MarketPipelineResult,
  SingleMarketPipelineInput,
  SingleMarketPipelineResult,
} from '@/types/strategy-pipeline';
import type { CycleExecution } from '@/types/scheduler';
import {
  buildDecisionLog,
  saveDecisionLog,
  printPipelineLogToConsole,
} from '@/lib/decision-log-service';

// ──────────────────────────────────────────────
// 기본 설정
// ──────────────────────────────────────────────

const DEFAULT_CONFIG: PipelineConfig = {
  candleUnit: 5,
  candleCount: 200,
  useAI: true,
  apiDelayMs: 150,
  minCandleCount: 30,
  minBuyAmount: 5000,
};

let pipelineConfig: PipelineConfig = { ...DEFAULT_CONFIG };

export function getPipelineConfig(): PipelineConfig {
  return { ...pipelineConfig };
}

export function updatePipelineConfig(partial: Partial<PipelineConfig>): PipelineConfig {
  pipelineConfig = { ...pipelineConfig, ...partial };
  return { ...pipelineConfig };
}

// ──────────────────────────────────────────────
// 스테이지 추적 헬퍼
// ──────────────────────────────────────────────

function startTrace(stage: PipelineStage): { stage: PipelineStage; startMs: number; startedAt: string } {
  return { stage, startMs: Date.now(), startedAt: new Date().toISOString() };
}

function endTrace(
  start: { stage: PipelineStage; startMs: number; startedAt: string },
  error: string | null = null,
): StageTrace {
  const now = Date.now();
  return {
    stage: start.stage,
    startedAt: start.startedAt,
    endedAt: new Date().toISOString(),
    durationMs: now - start.startMs,
    success: error === null,
    error,
  };
}

// ──────────────────────────────────────────────
// 1단계: 종목 스크리닝
// ──────────────────────────────────────────────

async function runScreening(): Promise<{ result: ScreeningStageResult; trace: StageTrace }> {
  const t = startTrace('screening');

  try {
    const holdingMarkets = [...new Set(getOpenPositions().map((p) => p.market))];

    const [marketAnalysis, selectionResult] = await Promise.all([
      analyzeMarket(),
      selectMarkets(holdingMarkets),
    ]);

    const result: ScreeningStageResult = {
      selectedMarkets: selectionResult.selectedMarkets,
      marketAnalysis,
      selectionResult,
    };

    console.log(
      `[파이프라인] 스크리닝 완료: ${result.selectedMarkets.length}종목 선정 ` +
      `(${selectionResult.stats.totalKrwMarkets}개 중 ${selectionResult.stats.candidateCount}후보)`,
    );

    return { result, trace: endTrace(t) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`스크리닝 실패: ${msg}`), {
      trace: endTrace(t, msg),
    });
  }
}

// ──────────────────────────────────────────────
// 2단계: 기술 분석 (종목별)
// ──────────────────────────────────────────────

async function runAnalysis(
  market: string,
): Promise<{ result: AnalysisStageResult; trace: StageTrace }> {
  const t = startTrace('analysis');

  try {
    const client = getUpbitClient();
    const candles = await client.getCandlesMinutes(
      pipelineConfig.candleUnit,
      market,
      pipelineConfig.candleCount,
    );

    if (candles.length < pipelineConfig.minCandleCount) {
      throw new Error(`캔들 데이터 부족: ${candles.length}개 (최소 ${pipelineConfig.minCandleCount}개)`);
    }

    const technicalAnalysis = technicalAnalyze(candles);
    const currentPrice = candles[0].trade_price;
    const portfolio = buildPortfolioContext(market, currentPrice);

    const result: AnalysisStageResult = {
      market,
      technicalAnalysis,
      currentPrice,
      portfolio,
    };

    return { result, trace: endTrace(t) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(msg), { trace: endTrace(t, msg) });
  }
}

// ──────────────────────────────────────────────
// 3단계: AI/알고리즘 판단 (종목별)
// ──────────────────────────────────────────────

async function runJudgment(
  market: string,
  analysis: AnalysisStageResult,
  marketAnalysis: MarketAnalysis,
): Promise<{ result: JudgmentStageResult; trace: StageTrace }> {
  const t = startTrace('judgment');

  try {
    const input: DecisionInput = {
      market,
      currentPrice: analysis.currentPrice,
      technicalAnalysis: analysis.technicalAnalysis,
      marketAnalysis,
      portfolio: analysis.portfolio,
    };

    let decision: TradingDecision;
    let source: 'ai' | 'algorithm';

    if (pipelineConfig.useAI) {
      try {
        decision = await evaluateWithAI(input);
        source = 'ai';
      } catch {
        // AI 실패 시 알고리즘 폴백
        console.log(`[파이프라인] ${market} AI 판단 실패 — 알고리즘 폴백`);
        decision = algorithmEvaluate(input);
        source = 'algorithm';
      }
    } else {
      decision = algorithmEvaluate(input);
      source = 'algorithm';
    }

    const result: JudgmentStageResult = { market, decision, source };

    console.log(
      `[파이프라인] ${market} 판단(${source}): ${decision.action.toUpperCase()} ` +
      `(점수 ${decision.compositeScore}, 신뢰도 ${decision.confidence}%)`,
    );

    return { result, trace: endTrace(t) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(msg), { trace: endTrace(t, msg) });
  }
}

// ──────────────────────────────────────────────
// 4단계: 리스크 체크 (종목별)
// ──────────────────────────────────────────────

async function runRiskCheck(
  market: string,
  judgment: JudgmentStageResult,
  currentPrice: number,
): Promise<{ result: RiskStageResult; trace: StageTrace }> {
  const t = startTrace('risk_check');

  try {
    const { decision } = judgment;

    // 매도/관망은 리스크 체크 불필요
    if (decision.action !== 'buy') {
      const result: RiskStageResult = {
        market,
        originalDecision: decision,
        riskCheck: null,
        allowed: true,
        adjustedAmount: null,
        blockReason: decision.action === 'hold' ? '관망 판단' : null,
      };
      return { result, trace: endTrace(t) };
    }

    // 매수 금액 산출 (paper-trading-engine의 실제 잔고 기준)
    const availableBalance = loadBalance().cash;
    const rawAmount = Math.round(availableBalance * decision.suggestedSizeRate);

    if (rawAmount < pipelineConfig.minBuyAmount) {
      const result: RiskStageResult = {
        market,
        originalDecision: decision,
        riskCheck: null,
        allowed: false,
        adjustedAmount: null,
        blockReason: `매수 금액 부족: ${rawAmount.toLocaleString()}원 (최소 ${pipelineConfig.minBuyAmount.toLocaleString()}원)`,
      };
      return { result, trace: endTrace(t) };
    }

    // 현재가 시세 정보 조회 (리스크 체크용)
    const client = getUpbitClient();
    const [ticker] = await client.getTicker([market]);

    const riskCheck = checkBuyRisk(
      market,
      rawAmount,
      ticker
        ? { accTradePrice24h: ticker.acc_trade_price_24h, signedChangeRate: ticker.signed_change_rate }
        : undefined,
    );

    const allowed = riskCheck.allowed || (riskCheck.adjustedAmount !== null && riskCheck.adjustedAmount >= pipelineConfig.minBuyAmount);
    const adjustedAmount = riskCheck.adjustedAmount;

    let blockReason: string | null = null;
    if (!allowed) {
      const violations = riskCheck.violations.filter((v) => v.severity === 'block');
      blockReason = violations.map((v) => v.message).join('; ') || '리스크 한도 초과';
    }

    if (!riskCheck.allowed && allowed) {
      console.log(
        `[파이프라인] ${market} 리스크 경고 — 금액 조정: ` +
        `${rawAmount.toLocaleString()}원 → ${adjustedAmount?.toLocaleString()}원`,
      );
    }

    const result: RiskStageResult = {
      market,
      originalDecision: decision,
      riskCheck,
      allowed,
      adjustedAmount: allowed ? (adjustedAmount ?? rawAmount) : null,
      blockReason,
    };

    return { result, trace: endTrace(t) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(msg), { trace: endTrace(t, msg) });
  }
}

// ──────────────────────────────────────────────
// 5단계: 주문 실행 (종목별)
// ──────────────────────────────────────────────

function runExecution(
  market: string,
  judgment: JudgmentStageResult,
  riskResult: RiskStageResult,
  currentPrice: number,
): { result: ExecutionStageResult; trace: StageTrace } {
  const t = startTrace('execution');

  try {
    const { decision } = judgment;

    // 관망
    if (decision.action === 'hold') {
      return {
        result: { market, execution: null, skipReason: '관망 판단' },
        trace: endTrace(t),
      };
    }

    // 매수
    if (decision.action === 'buy') {
      if (!riskResult.allowed) {
        return {
          result: { market, execution: null, skipReason: riskResult.blockReason },
          trace: endTrace(t),
        };
      }

      const buyAmount = riskResult.adjustedAmount!;
      const execResult = executeBuy(market, currentPrice, buyAmount, decision.reasoning);

      const execution: CycleExecution = {
        action: 'buy',
        market,
        executedPrice: execResult.executedPrice,
        amount: execResult.totalSettlement,
        fee: execResult.feeAmount,
        success: execResult.success,
        reason: execResult.reason,
      };

      if (execResult.success) {
        console.log(
          `[파이프라인] ${market} 매수 체결: ` +
          `${execResult.executedPrice.toLocaleString()}원 × ${execResult.totalSettlement.toLocaleString()}원`,
        );
      }

      return { result: { market, execution, skipReason: null }, trace: endTrace(t) };
    }

    // 매도
    if (decision.action === 'sell') {
      const positions = getOpenPositions(market);
      if (positions.length === 0) {
        return {
          result: { market, execution: null, skipReason: '보유 포지션 없음' },
          trace: endTrace(t),
        };
      }

      const position = positions[0]; // 가장 오래된 포지션
      const execResult = executeSell(position.id, currentPrice, decision.reasoning);

      const execution: CycleExecution = {
        action: 'sell',
        market,
        executedPrice: execResult.executedPrice,
        amount: execResult.totalSettlement,
        fee: execResult.feeAmount,
        success: execResult.success,
        reason: execResult.reason,
      };

      if (execResult.success) {
        console.log(
          `[파이프라인] ${market} 매도 체결: ` +
          `${execResult.executedPrice.toLocaleString()}원 × ${execResult.totalSettlement.toLocaleString()}원`,
        );
      }

      return { result: { market, execution, skipReason: null }, trace: endTrace(t) };
    }

    return {
      result: { market, execution: null, skipReason: `알 수 없는 액션: ${decision.action}` },
      trace: endTrace(t),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: { market, execution: null, skipReason: `실행 에러: ${msg}` },
      trace: endTrace(t, msg),
    };
  }
}

// ──────────────────────────────────────────────
// 종목 1개 파이프라인 (2~5단계)
// ──────────────────────────────────────────────

async function runMarketPipeline(
  market: string,
  marketAnalysis: MarketAnalysis,
): Promise<MarketPipelineResult> {
  const traces: StageTrace[] = [];
  let analysis: AnalysisStageResult | null = null;
  let judgment: JudgmentStageResult | null = null;
  let riskCheck: RiskStageResult | null = null;
  let execution: ExecutionStageResult | null = null;

  try {
    // 2단계: 분석
    const analysisOut = await runAnalysis(market);
    analysis = analysisOut.result;
    traces.push(analysisOut.trace);

    // 3단계: 판단
    const judgmentOut = await runJudgment(market, analysis, marketAnalysis);
    judgment = judgmentOut.result;
    traces.push(judgmentOut.trace);

    // 4단계: 리스크
    const riskOut = await runRiskCheck(market, judgment, analysis.currentPrice);
    riskCheck = riskOut.result;
    traces.push(riskOut.trace);

    // 5단계: 실행
    const execOut = runExecution(market, judgment, riskCheck, analysis.currentPrice);
    execution = execOut.result;
    traces.push(execOut.trace);

    return { market, analysis, judgment, riskCheck, execution, traces, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 실패한 스테이지의 trace가 에러 객체에 붙어 있을 수 있음
    const errObj = err as { trace?: StageTrace };
    if (errObj.trace) {
      traces.push(errObj.trace);
    }
    return { market, analysis, judgment, riskCheck, execution, traces, error: msg };
  }
}

// ──────────────────────────────────────────────
// 전체 파이프라인 (1~5단계)
// ──────────────────────────────────────────────

/**
 * 전체 파이프라인 실행
 * 스케줄러의 runCycle()을 대체.
 */
export async function runPipeline(
  overrideConfig?: Partial<PipelineConfig>,
): Promise<PipelineResult> {
  const pipelineId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const cfg = overrideConfig ? { ...pipelineConfig, ...overrideConfig } : { ...pipelineConfig };

  console.log(`\n[파이프라인 ${pipelineId}] ========== 시작 ==========`);

  try {
    // 1단계: 스크리닝
    const screeningOut = await runScreening();
    const screening = screeningOut.result;

    // 2~5단계: 종목별 순차 실행 (API rate limit 대응)
    const markets: MarketPipelineResult[] = [];

    for (const market of screening.selectedMarkets) {
      const result = await runMarketPipeline(market, screening.marketAnalysis);
      markets.push(result);

      // API rate limit 대응
      if (screening.selectedMarkets.indexOf(market) < screening.selectedMarkets.length - 1) {
        await sleep(cfg.apiDelayMs);
      }
    }

    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const executedMarkets = markets.filter(
      (m) => m.execution?.execution && m.execution.execution.success,
    );
    const buyCount = executedMarkets.filter(
      (m) => m.execution?.execution?.action === 'buy',
    ).length;
    const sellCount = executedMarkets.filter(
      (m) => m.execution?.execution?.action === 'sell',
    ).length;

    const result: PipelineResult = {
      pipelineId,
      startedAt,
      endedAt,
      durationMs,
      screening,
      markets,
      executedCount: executedMarkets.length,
      buyCount,
      sellCount,
      error: null,
      config: cfg,
    };

    console.log(
      `[파이프라인 ${pipelineId}] ========== 완료 ` +
      `(${durationMs}ms, 매수 ${buyCount}건, 매도 ${sellCount}건) ==========`,
    );

    // 판단 로그 기록 (JSON 파일 + 콘솔)
    try {
      const decisionLog = buildDecisionLog(result);
      saveDecisionLog(decisionLog);
      printPipelineLogToConsole(decisionLog);
    } catch (logErr) {
      console.error(`[파이프라인 ${pipelineId}] 판단 로그 기록 실패:`, logErr);
    }

    return result;
  } catch (err) {
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);

    console.error(`[파이프라인 ${pipelineId}] 실패: ${msg}`);

    return {
      pipelineId,
      startedAt,
      endedAt,
      durationMs,
      screening: {
        selectedMarkets: [],
        marketAnalysis: {} as MarketAnalysis,
        selectionResult: null,
      },
      markets: [],
      executedCount: 0,
      buyCount: 0,
      sellCount: 0,
      error: msg,
      config: cfg,
    };
  }
}

// ──────────────────────────────────────────────
// 단일 종목 분석 파이프라인
// ──────────────────────────────────────────────

/**
 * 특정 종목 1개만 분석 → 판단 → 리스크 체크 → 실행
 * API에서 수동 분석 요청 시 사용.
 */
export async function runSingleMarketPipeline(
  input: SingleMarketPipelineInput,
): Promise<SingleMarketPipelineResult> {
  const pipelineId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  console.log(`[파이프라인 ${pipelineId}] 단일 종목 분석: ${input.market}`);

  // 시장 분석 (캐시 있으면 재사용)
  const marketAnalysis = input.marketAnalysis ?? await analyzeMarket();

  // 2~5단계
  const result = await runMarketPipeline(input.market, marketAnalysis);

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  console.log(`[파이프라인 ${pipelineId}] 단일 종목 완료: ${input.market} (${durationMs}ms)`);

  return {
    pipelineId,
    startedAt,
    endedAt,
    durationMs,
    marketAnalysis,
    result,
    config: { ...pipelineConfig },
  };
}

// ──────────────────────────────────────────────
// 파이프라인 결과 → 사이클 로그 변환
// ──────────────────────────────────────────────

/**
 * PipelineResult를 스케줄러의 CycleLog 형식으로 변환.
 * 기존 스케줄러 연동 호환용.
 */
export function pipelineResultToCycleLog(
  pipelineResult: PipelineResult,
): import('@/types/scheduler').CycleLog {
  const results = pipelineResult.markets.map((m) => ({
    market: m.market,
    decision: m.judgment?.decision ?? emptyDecision(m.market, m.error ?? '분석 미완료'),
    execution: m.execution?.execution ?? null,
    error: m.error,
  }));

  return {
    cycleId: pipelineResult.pipelineId,
    startedAt: pipelineResult.startedAt,
    endedAt: pipelineResult.endedAt,
    durationMs: pipelineResult.durationMs,
    marketSummary: pipelineResult.screening.marketAnalysis?.summary ?? '',
    results,
    executedCount: pipelineResult.executedCount,
    error: pipelineResult.error,
    portfolioSummary: getBalanceSummary(),
  };
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

function buildPortfolioContext(market: string, currentPrice: number): PortfolioContext {
  const openPositions = getOpenPositions();
  const marketPositions = openPositions.filter((p) => p.market === market);
  const isHolding = marketPositions.length > 0;

  let avgBuyPrice: number | null = null;
  let currentProfitRate: number | null = null;

  if (isHolding && marketPositions.length > 0) {
    const totalCost = marketPositions.reduce((sum, p) => sum + p.totalAmount, 0);
    const totalVolume = marketPositions.reduce((sum, p) => sum + p.volume, 0);
    avgBuyPrice = totalVolume > 0 ? totalCost / totalVolume : null;

    if (avgBuyPrice && avgBuyPrice > 0) {
      currentProfitRate = (currentPrice - avgBuyPrice) / avgBuyPrice;
    }
  }

  const holdingMarkets = new Set(openPositions.map((p) => p.market));
  const totalPositionAmount = openPositions.reduce((sum, p) => sum + p.totalAmount, 0);
  const todayStats = getTodayStats();

  return {
    isHolding,
    avgBuyPrice,
    currentProfitRate,
    holdingCount: holdingMarkets.size,
    totalPositionAmount,
    availableBalance: loadBalance().cash,
    todayTradeCount: todayStats.tradeCount,
    todayRealizedPnL: todayStats.realizedPnl,
  };
}

function emptyDecision(market: string, reason: string): TradingDecision {
  return {
    market,
    timestamp: new Date().toISOString(),
    action: 'hold',
    confidence: 0,
    compositeScore: 0,
    signals: [],
    reasoning: reason,
    suggestedSizeRate: 0,
    currentPrice: 0,
    suggestedStopLoss: null,
    suggestedTakeProfit: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
