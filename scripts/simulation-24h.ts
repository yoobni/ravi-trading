/**
 * 24시간 모의 운영 테스트
 *
 * 전체 시스템을 24시간 연속 운영하며:
 * - 5분 간격 자동 매매 사이클 실행
 * - 수익률/승률 실시간 추적
 * - AI 판단 품질 검토
 * - 시스템 안정성 확인
 * - 종료 시 최종 리포트 생성
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/simulation-24h.ts
 * 조기 종료: Ctrl+C (SIGINT) → 리포트 생성 후 종료
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { UpbitClient } from '@/lib/upbit-client';
import { runPipeline, getPipelineConfig } from '@/lib/strategy-pipeline';
import {
  loadBalance,
  initializeBalance,
  evaluatePortfolio,
  getBalanceSummary,
} from '@/lib/paper-trading-engine';
import { getOpenPositions, listOrders } from '@/lib/order-store';
import { getBalanceState } from '@/lib/balance-tracker';
import { appendCycleLog, getTodayCycleLogs, getTodayCycleSummary } from '@/lib/cycle-logger';
import {
  checkCircuitBreaker,
  loadRiskConfig,
} from '@/lib/risk-manager';
import {
  checkPositionRisks,
  updateConsecutiveLosses,
  logRiskEvent,
} from '@/lib/risk-manager';
import { emergencyLiquidateAll } from '@/lib/emergency-liquidation';
import { updateHighPrices, getHighPricesByMarket, removeHighPrice } from '@/lib/high-price-tracker';
import { executeSell } from '@/lib/paper-trading-engine';
import { generateReport, saveReportToFile, reportToCsv } from '@/lib/report-generator';
import { classifyApiError } from '@/lib/upbit-client';
import type { CycleLog, CycleExecution, MarketCycleResult } from '@/types/scheduler';
import type { TradingDecision } from '@/types/trading-decision';
import type { MarketAnalysis } from '@/types/market-analysis';

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────

const SIMULATION_DURATION_MS = 24 * 60 * 60 * 1000; // 24시간
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;            // 5분
const STATUS_LOG_INTERVAL_MS = 30 * 60 * 1000;      // 30분마다 상태 로그
const DATA_DIR = path.resolve(process.cwd(), 'data');
const SIM_DIR = path.join(DATA_DIR, 'simulation');
const SIM_LOG_FILE = path.join(SIM_DIR, 'simulation-log.jsonl');
const SIM_REPORT_FILE = path.join(SIM_DIR, 'simulation-report.json');
const AUTO_STOP_ERRORS = 5;
const EMERGENCY_ERRORS = 8;

// ──────────────────────────────────────────────
// 시뮬레이션 상태
// ──────────────────────────────────────────────

interface SimulationState {
  simulationId: string;
  startedAt: string;
  initialCapital: number;
  totalCycles: number;
  successCycles: number;
  errorCycles: number;
  consecutiveErrors: number;
  totalBuys: number;
  totalSells: number;
  totalHoldDecisions: number;
  cycleTimings: number[];       // 각 사이클 소요시간 (ms)
  errors: { time: string; message: string; cycle: number }[];
  snapshots: PortfolioSnapshot[];  // 30분 간격 스냅샷
  lastKnownPrices: Record<string, number>;
}

interface PortfolioSnapshot {
  timestamp: string;
  cycle: number;
  cash: number;
  positionValue: number;
  totalEquity: number;
  returnRate: number;
  holdingCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  feesPaid: number;
}

const state: SimulationState = {
  simulationId: crypto.randomUUID().slice(0, 8),
  startedAt: '',
  initialCapital: 0,
  totalCycles: 0,
  successCycles: 0,
  errorCycles: 0,
  consecutiveErrors: 0,
  totalBuys: 0,
  totalSells: 0,
  totalHoldDecisions: 0,
  cycleTimings: [],
  errors: [],
  snapshots: [],
  lastKnownPrices: {},
};

let isRunning = false;
let shutdownRequested = false;

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function logLine(msg: string) {
  const line = JSON.stringify({ t: new Date().toISOString(), msg });
  fs.appendFileSync(SIM_LOG_FILE, line + '\n', 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirs() {
  fs.mkdirSync(SIM_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'cycle-logs'), { recursive: true });
}

// ──────────────────────────────────────────────
// 포트폴리오 스냅샷
// ──────────────────────────────────────────────

async function takeSnapshot(client: UpbitClient): Promise<PortfolioSnapshot> {
  const balance = loadBalance();
  const positions = getOpenPositions();
  let positionValue = 0;
  let unrealizedPnl = 0;

  if (positions.length > 0) {
    const markets = [...new Set(positions.map((p) => p.market))];
    try {
      const tickers = await client.getTicker(markets);
      const priceMap: Record<string, number> = {};
      for (const t of tickers) {
        priceMap[t.market] = t.trade_price;
        state.lastKnownPrices[t.market] = t.trade_price;
      }
      const valuation = evaluatePortfolio(priceMap);
      positionValue = valuation.totalPositionValue;
      unrealizedPnl = valuation.unrealizedPnl;
    } catch {
      // 시세 조회 실패 시 매수가 기준
      positionValue = balance.holdings.reduce((s, h) => s + h.avgPrice * h.volume, 0);
    }
  }

  const totalEquity = balance.cash + positionValue;

  return {
    timestamp: new Date().toISOString(),
    cycle: state.totalCycles,
    cash: balance.cash,
    positionValue: Math.round(positionValue),
    totalEquity: Math.round(totalEquity),
    returnRate: Math.round(((totalEquity - balance.initialCapital) / balance.initialCapital) * 10000) / 100,
    holdingCount: balance.holdings.length,
    realizedPnl: balance.totalRealizedPnl,
    unrealizedPnl: Math.round(unrealizedPnl),
    feesPaid: balance.totalFeesPaid,
  };
}

// ──────────────────────────────────────────────
// 보유 포지션 리스크 처리
// ──────────────────────────────────────────────

async function processPositionRisks(
  client: UpbitClient,
  cycleId: string,
): Promise<MarketCycleResult[]> {
  const results: MarketCycleResult[] = [];
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return results;

  const holdingMarkets = [...new Set(openPositions.map((p) => p.market))];
  const tickers = await client.getTicker(holdingMarkets);
  const priceMap: Record<string, number> = {};
  for (const t of tickers) {
    priceMap[t.market] = t.trade_price;
    state.lastKnownPrices[t.market] = t.trade_price;
  }

  // 고점 추적 갱신
  const positionPriceMap: Record<string, number> = {};
  const positionMarketMap: Record<string, string> = {};
  for (const pos of openPositions) {
    const price = priceMap[pos.market];
    if (price !== undefined) {
      positionPriceMap[pos.id] = price;
      positionMarketMap[pos.id] = pos.market;
    }
  }
  updateHighPrices(positionPriceMap);
  const highPrices = getHighPricesByMarket(positionMarketMap);

  const riskChecks = checkPositionRisks(priceMap, highPrices);

  for (const check of riskChecks) {
    if (check.action === 'hold') continue;

    const actionLabel =
      check.action === 'stop_loss' ? '손절' :
      check.action === 'take_profit' ? '익절' : '트레일링 스탑';

    const reasoning = `[자동 ${actionLabel}] ${check.violations.map((v) => v.message).join('; ')}`;
    log('리스크', `${check.market} ${actionLabel} (수익률 ${check.profitRate}%)`);

    const execResult = executeSell(check.orderId, check.currentPrice, reasoning);

    const eventType = check.action === 'stop_loss' ? 'stop_loss'
      : check.action === 'take_profit' ? 'take_profit'
      : 'trailing_stop';
    logRiskEvent(eventType as 'stop_loss' | 'take_profit' | 'trailing_stop', check.market, check.orderId, reasoning, {
      buyPrice: check.buyPrice,
      currentPrice: check.currentPrice,
      profitRate: check.profitRate,
    });

    removeHighPrice(check.orderId);

    if (execResult.success) {
      updateConsecutiveLosses(check.profitRate < 0 ? -1 : 1);
      state.totalSells++;
    }

    const execution: CycleExecution = {
      action: 'sell',
      market: check.market,
      executedPrice: execResult.executedPrice,
      amount: execResult.totalSettlement,
      fee: execResult.feeAmount,
      success: execResult.success,
      reason: execResult.reason,
    };

    const decision: TradingDecision = {
      market: check.market,
      timestamp: new Date().toISOString(),
      action: 'sell',
      confidence: 100,
      compositeScore: -100,
      signals: [],
      reasoning,
      suggestedSizeRate: 1,
      currentPrice: check.currentPrice,
      suggestedStopLoss: null,
      suggestedTakeProfit: null,
    };

    results.push({ market: check.market, decision, execution, error: null });
  }

  return results;
}

// ──────────────────────────────────────────────
// 단일 사이클 실행
// ──────────────────────────────────────────────

async function runCycle(client: UpbitClient): Promise<CycleLog> {
  const cycleId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  log('사이클', `#${state.totalCycles + 1} [${cycleId}] 시작`);

  try {
    // 서킷 브레이커 점검
    const balanceState = getBalanceState();
    const riskConfig = loadRiskConfig();
    const totalEquity = balanceState.availableKrw +
      getOpenPositions().reduce((sum, p) => sum + p.totalAmount, 0);

    if (!checkCircuitBreaker(totalEquity, riskConfig.totalCapital)) {
      log('사이클', `[${cycleId}] 서킷 브레이커 발동 — 스킵`);
      const skipLog: CycleLog = {
        cycleId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        marketSummary: '서킷 브레이커 발동',
        results: [],
        executedCount: 0,
        error: '서킷 브레이커 발동',
        portfolioSummary: getBalanceSummary(),
      };
      appendCycleLog(skipLog);
      return skipLog;
    }

    // 파이프라인 실행 (스크리닝 → 분석 → 판단 → 리스크 → 실행)
    const pipelineResult = await runPipeline({
      candleUnit: 5,
      candleCount: 200,
    });

    // 보유 포지션 리스크 점검
    const riskExecutions = await processPositionRisks(client, cycleId);

    // 결과 병합
    const { pipelineResultToCycleLog } = await import('@/lib/strategy-pipeline');
    const cycleLog = pipelineResultToCycleLog(pipelineResult);
    cycleLog.cycleId = cycleId;
    cycleLog.results = [...riskExecutions, ...cycleLog.results.filter(
      (r) => !riskExecutions.some((re) => re.market === r.market),
    )];
    cycleLog.executedCount = cycleLog.results.filter(
      (r) => r.execution && r.execution.success,
    ).length;

    appendCycleLog(cycleLog);

    // 통계 집계
    for (const r of cycleLog.results) {
      if (r.execution?.success) {
        if (r.execution.action === 'buy') state.totalBuys++;
        else if (r.execution.action === 'sell') state.totalSells++;
      }
      if (r.decision?.action === 'hold') state.totalHoldDecisions++;
    }

    const durationMs = Date.now() - startMs;
    state.cycleTimings.push(durationMs);

    log('사이클', `[${cycleId}] 완료 (${durationMs}ms, 실행 ${cycleLog.executedCount}건)`);
    log('잔고', getBalanceSummary());

    return cycleLog;
  } catch (err) {
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const classified = classifyApiError(err);
    const errorMsg = `[${classified.kind}] ${classified.message}`;

    log('에러', `[${cycleId}] ${errorMsg}`);
    state.errors.push({
      time: endedAt,
      message: errorMsg,
      cycle: state.totalCycles + 1,
    });

    const cycleLog: CycleLog = {
      cycleId,
      startedAt,
      endedAt,
      durationMs,
      marketSummary: '',
      results: [],
      executedCount: 0,
      error: errorMsg,
      portfolioSummary: '',
    };
    appendCycleLog(cycleLog);
    state.cycleTimings.push(durationMs);

    return cycleLog;
  }
}

// ──────────────────────────────────────────────
// 최종 리포트 생성
// ──────────────────────────────────────────────

async function generateFinalReport(client: UpbitClient): Promise<void> {
  log('리포트', '최종 리포트 생성 중...');

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(state.startedAt).getTime();
  const durationHours = Math.round(durationMs / 3600000 * 10) / 10;

  // 최종 스냅샷
  const finalSnapshot = await takeSnapshot(client);
  state.snapshots.push(finalSnapshot);

  // 거래 리포트 생성
  const tradeReport = generateReport({
    period: 'daily',
    format: 'json',
    fromDate: state.startedAt.slice(0, 10),
    toDate: endedAt.slice(0, 10),
  });

  // 사이클 통계
  const avgCycleTime = state.cycleTimings.length > 0
    ? Math.round(state.cycleTimings.reduce((a, b) => a + b, 0) / state.cycleTimings.length)
    : 0;
  const maxCycleTime = state.cycleTimings.length > 0
    ? Math.max(...state.cycleTimings)
    : 0;
  const minCycleTime = state.cycleTimings.length > 0
    ? Math.min(...state.cycleTimings)
    : 0;

  // 포트폴리오 변동 추적
  const equityHistory = state.snapshots.map((s) => ({
    time: s.timestamp,
    equity: s.totalEquity,
    returnRate: s.returnRate,
  }));

  const maxEquity = equityHistory.length > 0
    ? Math.max(...equityHistory.map((e) => e.equity))
    : state.initialCapital;
  const minEquity = equityHistory.length > 0
    ? Math.min(...equityHistory.map((e) => e.equity))
    : state.initialCapital;

  // MDD 계산
  let mdd = 0;
  let peak = state.initialCapital;
  for (const s of state.snapshots) {
    if (s.totalEquity > peak) peak = s.totalEquity;
    const drawdown = ((peak - s.totalEquity) / peak) * 100;
    if (drawdown > mdd) mdd = drawdown;
  }

  const report = {
    simulationId: state.simulationId,
    title: '24시간 모의 운영 테스트 리포트',
    startedAt: state.startedAt,
    endedAt,
    durationHours,

    // 수익률
    performance: {
      initialCapital: state.initialCapital,
      finalEquity: finalSnapshot.totalEquity,
      totalReturnRate: finalSnapshot.returnRate,
      realizedPnl: finalSnapshot.realizedPnl,
      unrealizedPnl: finalSnapshot.unrealizedPnl,
      totalFeesPaid: finalSnapshot.feesPaid,
      maxEquity,
      minEquity,
      maxDrawdown: Math.round(mdd * 100) / 100,
    },

    // 거래 통계
    trading: {
      totalCycles: state.totalCycles,
      successCycles: state.successCycles,
      errorCycles: state.errorCycles,
      errorRate: state.totalCycles > 0
        ? Math.round((state.errorCycles / state.totalCycles) * 10000) / 100
        : 0,
      totalBuys: state.totalBuys,
      totalSells: state.totalSells,
      totalHoldDecisions: state.totalHoldDecisions,
      tradeCount: tradeReport.totalSummary.tradeCount,
      winCount: tradeReport.totalSummary.winCount,
      lossCount: tradeReport.totalSummary.lossCount,
      winRate: tradeReport.totalSummary.winRate,
      avgProfitRate: tradeReport.totalSummary.avgProfitRate,
      avgHoldingMinutes: tradeReport.totalSummary.avgHoldingMinutes,
    },

    // 시스템 안정성
    stability: {
      avgCycleTimeMs: avgCycleTime,
      maxCycleTimeMs: maxCycleTime,
      minCycleTimeMs: minCycleTime,
      totalErrors: state.errors.length,
      maxConsecutiveErrors: state.consecutiveErrors,
      uptimeRate: state.totalCycles > 0
        ? Math.round((state.successCycles / state.totalCycles) * 10000) / 100
        : 0,
      errorBreakdown: categorizeErrors(state.errors),
    },

    // 포트폴리오 스냅샷 (30분 간격)
    equityHistory,

    // 최종 포지션
    finalPositions: finalSnapshot,

    // 에러 로그
    errors: state.errors.slice(0, 50), // 최대 50건

    // 개별 거래 내역
    trades: tradeReport.trades,
    periodSummaries: tradeReport.periodSummaries,
  };

  fs.writeFileSync(SIM_REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  log('리포트', `저장 완료: ${SIM_REPORT_FILE}`);

  // CSV 리포트도 저장
  if (tradeReport.trades.length > 0) {
    const csvPath = saveReportToFile(tradeReport, 'csv');
    log('리포트', `CSV 저장: ${csvPath}`);
  }

  // 콘솔 요약 출력
  printSummary(report);
}

function categorizeErrors(errors: { message: string }[]): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const e of errors) {
    const match = e.message.match(/^\[(\w+)\]/);
    const category = match ? match[1] : 'unknown';
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return categories;
}

function printSummary(report: Record<string, unknown>) {
  const perf = report.performance as Record<string, number>;
  const trading = report.trading as Record<string, number>;
  const stability = report.stability as Record<string, number>;

  console.log('\n' + '═'.repeat(60));
  console.log('  24시간 모의 운영 테스트 — 최종 리포트');
  console.log('═'.repeat(60));

  console.log('\n▸ 수익률');
  console.log(`  초기자본:     ${perf.initialCapital.toLocaleString()}원`);
  console.log(`  최종평가액:   ${perf.finalEquity.toLocaleString()}원`);
  console.log(`  총 수익률:    ${perf.totalReturnRate >= 0 ? '+' : ''}${perf.totalReturnRate}%`);
  console.log(`  실현 손익:    ${perf.realizedPnl.toLocaleString()}원`);
  console.log(`  미실현 손익:  ${perf.unrealizedPnl.toLocaleString()}원`);
  console.log(`  총 수수료:    ${perf.totalFeesPaid.toLocaleString()}원`);
  console.log(`  최대 낙폭:    ${perf.maxDrawdown}%`);

  console.log('\n▸ 거래 통계');
  console.log(`  총 사이클:    ${trading.totalCycles}회 (성공 ${trading.successCycles} / 에러 ${trading.errorCycles})`);
  console.log(`  매수:         ${trading.totalBuys}회`);
  console.log(`  매도:         ${trading.totalSells}회`);
  console.log(`  관망:         ${trading.totalHoldDecisions}회`);
  console.log(`  청산 거래:    ${trading.tradeCount}건`);
  console.log(`  승률:         ${trading.winRate}% (${trading.winCount}승 ${trading.lossCount}패)`);
  console.log(`  평균 수익률:  ${trading.avgProfitRate}%`);
  console.log(`  평균 보유:    ${trading.avgHoldingMinutes}분`);

  console.log('\n▸ 시스템 안정성');
  console.log(`  평균 사이클:  ${stability.avgCycleTimeMs}ms`);
  console.log(`  최대 사이클:  ${stability.maxCycleTimeMs}ms`);
  console.log(`  가동률:       ${stability.uptimeRate}%`);
  console.log(`  총 에러:      ${stability.totalErrors}건`);

  console.log('\n' + '═'.repeat(60));
  console.log(`  리포트 파일: ${SIM_REPORT_FILE}`);
  console.log('═'.repeat(60) + '\n');
}

// ──────────────────────────────────────────────
// 메인 시뮬레이션 루프
// ──────────────────────────────────────────────

async function main() {
  ensureDirs();

  console.log('\n' + '═'.repeat(60));
  console.log('  24시간 모의 운영 테스트 시작');
  console.log('  Ctrl+C로 조기 종료 가능 (리포트 자동 생성)');
  console.log('═'.repeat(60) + '\n');

  // API 연결 확인
  let client: UpbitClient;
  try {
    client = new UpbitClient();
    const healthy = await client.healthCheck();
    if (!healthy) {
      log('초기화', 'API 헬스체크 실패 — 종료');
      process.exit(1);
    }
    log('초기화', 'API 연결 OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('초기화', `API 연결 실패: ${msg}`);
    process.exit(1);
  }

  // 모의 계좌 초기화 (기존 잔고 사용)
  const balance = loadBalance();
  state.initialCapital = balance.initialCapital;
  state.startedAt = new Date().toISOString();

  log('초기화', `시뮬레이션 ID: ${state.simulationId}`);
  log('초기화', `초기 자본: ${state.initialCapital.toLocaleString()}원`);
  log('초기화', `현재 잔고: ${balance.cash.toLocaleString()}원`);
  log('초기화', `보유 포지션: ${balance.holdings.length}건`);
  log('초기화', `사이클 간격: ${CYCLE_INTERVAL_MS / 1000}초`);
  log('초기화', `예상 사이클 수: ${Math.floor(SIMULATION_DURATION_MS / CYCLE_INTERVAL_MS)}회`);

  logLine(`시뮬레이션 시작 — ID: ${state.simulationId}, 초기자본: ${state.initialCapital}`);

  // 초기 스냅샷
  const initialSnapshot = await takeSnapshot(client);
  state.snapshots.push(initialSnapshot);

  // SIGINT (Ctrl+C) 핸들러
  let sigintCount = 0;
  process.on('SIGINT', async () => {
    sigintCount++;
    if (sigintCount === 1) {
      log('시그널', 'SIGINT 수신 — 현재 사이클 완료 후 종료합니다...');
      shutdownRequested = true;
    } else {
      log('시그널', '강제 종료 — 리포트 생성 시도...');
      try {
        await generateFinalReport(client);
      } catch {
        log('에러', '리포트 생성 실패');
      }
      process.exit(1);
    }
  });

  // 메인 루프
  isRunning = true;
  const startTime = Date.now();
  let lastStatusLog = Date.now();

  while (isRunning && !shutdownRequested) {
    const elapsed = Date.now() - startTime;

    // 24시간 경과 확인
    if (elapsed >= SIMULATION_DURATION_MS) {
      log('시뮬레이션', '24시간 경과 — 종료');
      break;
    }

    // 사이클 실행
    const cycleLog = await runCycle(client);
    state.totalCycles++;

    if (cycleLog.error) {
      state.errorCycles++;
      state.consecutiveErrors++;
    } else {
      state.successCycles++;
      state.consecutiveErrors = 0;
    }

    // 연속 에러 임계치 대응
    if (state.consecutiveErrors >= EMERGENCY_ERRORS) {
      log('긴급', `연속 에러 ${state.consecutiveErrors}회 — 긴급 청산 후 중지`);
      const openPositions = getOpenPositions();
      if (openPositions.length > 0) {
        await emergencyLiquidateAll('consecutive_errors', state.lastKnownPrices).catch(() => {});
      }
      break;
    } else if (state.consecutiveErrors >= AUTO_STOP_ERRORS) {
      log('경고', `연속 에러 ${state.consecutiveErrors}회 — 자동 중지`);
      break;
    }

    // 30분 간격 스냅샷
    if (Date.now() - lastStatusLog >= STATUS_LOG_INTERVAL_MS) {
      const snapshot = await takeSnapshot(client);
      state.snapshots.push(snapshot);
      lastStatusLog = Date.now();

      const elapsedHours = Math.round((Date.now() - startTime) / 3600000 * 10) / 10;
      const remainingHours = Math.round((SIMULATION_DURATION_MS - elapsed) / 3600000 * 10) / 10;

      log('상태', `─── ${elapsedHours}시간 경과 (남은: ${remainingHours}시간) ───`);
      log('상태', `사이클: ${state.totalCycles}회 (성공 ${state.successCycles}, 에러 ${state.errorCycles})`);
      log('상태', `매수 ${state.totalBuys} / 매도 ${state.totalSells} / 관망 ${state.totalHoldDecisions}`);
      log('상태', `수익률: ${snapshot.returnRate >= 0 ? '+' : ''}${snapshot.returnRate}%`);
      log('상태', `총 평가: ${snapshot.totalEquity.toLocaleString()}원 (현금 ${snapshot.cash.toLocaleString()} + 포지션 ${snapshot.positionValue.toLocaleString()})`);
      log('상태', `실현 손익: ${snapshot.realizedPnl.toLocaleString()}원, 수수료: ${snapshot.feesPaid.toLocaleString()}원`);

      logLine(`스냅샷 — 수익률: ${snapshot.returnRate}%, 총평가: ${snapshot.totalEquity}`);
    }

    // 다음 사이클까지 대기
    const cycleElapsed = Date.now() - (new Date(cycleLog.startedAt).getTime());
    const waitMs = Math.max(0, CYCLE_INTERVAL_MS - cycleElapsed);

    if (waitMs > 0 && !shutdownRequested) {
      // 10초 단위로 끊어서 대기 (SIGINT 반응성 확보)
      const chunkMs = 10_000;
      let remaining = waitMs;
      while (remaining > 0 && !shutdownRequested) {
        await sleep(Math.min(remaining, chunkMs));
        remaining -= chunkMs;
      }
    }
  }

  isRunning = false;

  // 최종 리포트 생성
  await generateFinalReport(client);

  log('시뮬레이션', '종료');
}

main().catch((err) => {
  console.error('시뮬레이션 예기치 않은 에러:', err);
  process.exit(1);
});
