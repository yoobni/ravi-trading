import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getUpbitClient, classifyApiError } from '@/lib/upbit-client';
import {
  executeSell,
  getBalanceSummary,
  loadBalance,
} from '@/lib/paper-trading-engine';
import {
  checkPositionRisks,
  checkCircuitBreaker,
  updateConsecutiveLosses,
  logRiskEvent,
  loadRiskConfig,
} from '@/lib/risk-manager';
import { getOpenPositions } from '@/lib/order-store';
import { appendCycleLog } from '@/lib/cycle-logger';
import { emergencyLiquidateAll } from '@/lib/emergency-liquidation';
import { updateHighPrices, getHighPricesByMarket, removeHighPrice } from '@/lib/high-price-tracker';
import { runPipeline, pipelineResultToCycleLog } from '@/lib/strategy-pipeline';
import type { TradingDecision } from '@/types/trading-decision';
import type { MarketAnalysis } from '@/types/market-analysis';
import type {
  SchedulerConfig,
  SchedulerStatus,
  CycleLog,
  MarketCycleResult,
  CycleExecution,
} from '@/types/scheduler';
import type { PersistedSchedulerState } from '@/types/error';

// ──────────────────────────────────────────────
// 기본 설정
// ──────────────────────────────────────────────

const FIVE_MINUTES = 5 * 60 * 1000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'scheduler-state.json');

/** 연속 에러 N회 이상 → 자동 중지 */
const AUTO_STOP_THRESHOLD = 5;
/** 연속 에러 N회 이상 + 보유 포지션 → 긴급 청산 */
const EMERGENCY_THRESHOLD = 8;

const DEFAULT_CONFIG: SchedulerConfig = {
  intervalMs: FIVE_MINUTES,
  targetMarketCount: 5,
  candleUnit: 5,
  candleCount: 200,
  enabled: true,
};

// ──────────────────────────────────────────────
// 상태
// ──────────────────────────────────────────────

let config: SchedulerConfig = { ...DEFAULT_CONFIG };
let timer: ReturnType<typeof setInterval> | null = null;
let isRunningCycle = false; // 사이클 중복 실행 방지

const status: SchedulerStatus = {
  running: false,
  totalCycles: 0,
  consecutiveErrors: 0,
  lastCycleAt: null,
  nextCycleAt: null,
  startedAt: null,
};

// 최근 시세 캐시 (긴급 청산 시 fallback용)
let lastKnownPrices: Record<string, number> = {};

// ──────────────────────────────────────────────
// 설정 관리
// ──────────────────────────────────────────────

export function getSchedulerConfig(): SchedulerConfig {
  return { ...config };
}

export function updateSchedulerConfig(partial: Partial<SchedulerConfig>): SchedulerConfig {
  config = { ...config, ...partial };
  return { ...config };
}

export function getSchedulerStatus(): SchedulerStatus {
  return { ...status };
}

// ──────────────────────────────────────────────
// 스케줄러 시작/중지
// ──────────────────────────────────────────────

/** 스케줄러 시작 */
export function startScheduler(overrideConfig?: Partial<SchedulerConfig>): SchedulerStatus {
  if (status.running) {
    console.log('[스케줄러] 이미 실행 중입니다.');
    return { ...status };
  }

  if (overrideConfig) {
    config = { ...config, ...overrideConfig };
  }

  if (!config.enabled) {
    console.log('[스케줄러] 비활성 상태입니다. config.enabled = true로 설정해주세요.');
    return { ...status };
  }

  status.running = true;
  status.startedAt = new Date().toISOString();
  status.consecutiveErrors = 0;

  console.log(`[스케줄러] 시작 — 간격 ${config.intervalMs / 1000}초, 대상 ${config.targetMarketCount}종목`);

  // 즉시 1회 실행 후 인터벌 등록
  runCycleSafe();

  timer = setInterval(() => {
    runCycleSafe();
  }, config.intervalMs);

  updateNextCycleTime();
  persistState();

  return { ...status };
}

/** 스케줄러 중지 */
export function stopScheduler(): SchedulerStatus {
  if (!status.running) {
    console.log('[스케줄러] 실행 중이 아닙니다.');
    return { ...status };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  status.running = false;
  status.nextCycleAt = null;

  console.log(`[스케줄러] 중지 — 총 ${status.totalCycles}사이클 완료`);
  persistState();

  return { ...status };
}

// ──────────────────────────────────────────────
// 상태 영속화 / 복원
// ──────────────────────────────────────────────

/** 스케줄러 상태를 파일에 저장 */
function persistState(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const state: PersistedSchedulerState = {
      wasRunning: status.running,
      lastCycleAt: status.lastCycleAt,
      totalCycles: status.totalCycles,
      consecutiveErrors: status.consecutiveErrors,
      savedAt: new Date().toISOString(),
      config: {
        intervalMs: config.intervalMs,
        targetMarketCount: config.targetMarketCount,
        candleUnit: config.candleUnit,
        candleCount: config.candleCount,
        enabled: config.enabled,
      },
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[스케줄러] 상태 저장 실패:', err);
  }
}

function loadPersistedState(): PersistedSchedulerState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedSchedulerState;
  } catch {
    return null;
  }
}

/**
 * 프로세스 재시작 후 마지막 상태 복원.
 * 이전에 실행 중이었으면 설정+통계 복원 후 자동 재시작.
 */
export function restoreFromPersistedState(): boolean {
  const saved = loadPersistedState();
  if (!saved) {
    console.log('[스케줄러] 저장된 상태 없음 — 복원 건너뜀');
    return false;
  }

  console.log(
    `[스케줄러] 저장된 상태 발견 — wasRunning=${saved.wasRunning}, ` +
    `totalCycles=${saved.totalCycles}, consecutiveErrors=${saved.consecutiveErrors}, ` +
    `savedAt=${saved.savedAt}`,
  );

  status.totalCycles = saved.totalCycles;
  status.consecutiveErrors = saved.consecutiveErrors;
  status.lastCycleAt = saved.lastCycleAt;

  config = {
    ...config,
    intervalMs: saved.config.intervalMs,
    targetMarketCount: saved.config.targetMarketCount,
    candleUnit: saved.config.candleUnit as SchedulerConfig['candleUnit'],
    candleCount: saved.config.candleCount,
    enabled: saved.config.enabled,
  };

  if (saved.wasRunning && saved.config.enabled) {
    console.log('[스케줄러] 이전 실행 상태 복원 — 자동 재시작');
    startScheduler();
    return true;
  }
  return false;
}

/** 영속 상태 조회 (디버깅/API용) */
export function getPersistedState(): PersistedSchedulerState | null {
  return loadPersistedState();
}

// ──────────────────────────────────────────────
// 사이클 실행 (안전 래퍼)
// ──────────────────────────────────────────────

/** 중복 실행 방지 래퍼 */
function runCycleSafe(): void {
  if (isRunningCycle) {
    console.log('[스케줄러] 이전 사이클 실행 중 — 스킵');
    return;
  }

  // fire-and-forget, 에러는 내부에서 처리
  runCycle().catch((err) => {
    console.error('[스케줄러] 예상치 못한 사이클 에러:', err);
  });
}

// ──────────────────────────────────────────────
// 메인 사이클 로직
// ──────────────────────────────────────────────

/** 단일 사이클 수동 실행 (API에서 호출 가능) */
export async function runCycleManual(): Promise<CycleLog> {
  return runCycle();
}

/**
 * 1회 사이클 실행:
 * 1. 시장 데이터 수집
 * 2. 대상 종목 선정
 * 3. 보유 포지션 리스크 점검 (손절/익절)
 * 4. 종목별 기술 분석 → AI 판단
 * 5. 매수/매도 실행
 * 6. 결과 기록
 */
async function runCycle(): Promise<CycleLog> {
  isRunningCycle = true;
  const cycleId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  console.log(`\n[사이클 ${cycleId}] ========== 시작 ==========`);

  try {
    // ── 0단계: 서킷 브레이커 점검 ──
    const balance = loadBalance();
    const riskConfig = loadRiskConfig();
    const totalEquity = balance.cash +
      getOpenPositions().reduce((sum, p) => sum + p.totalAmount, 0);

    if (!checkCircuitBreaker(totalEquity, riskConfig.totalCapital)) {
      console.log(`[사이클 ${cycleId}] 서킷 브레이커 발동 상태 — 사이클 스킵`);
      const skipLog: CycleLog = {
        cycleId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        marketSummary: '서킷 브레이커 발동 — 거래 중단',
        results: [],
        executedCount: 0,
        error: '서킷 브레이커 발동',
        portfolioSummary: getBalanceSummary(),
      };
      appendCycleLog(skipLog);
      status.totalCycles++;
      status.lastCycleAt = skipLog.endedAt;
      updateNextCycleTime();
      return skipLog;
    }

    // ── 1~2단계: 스크리닝 + 3~5단계: 종목별 분석/판단/실행 (파이프라인) ──
    console.log(`[사이클 ${cycleId}] 보유 포지션 리스크 점검...`);
    const pipelineResult = await runPipeline({
      candleUnit: config.candleUnit,
      candleCount: config.candleCount,
    });

    // 보유 포지션 리스크 점검 (손절/익절 자동 처리)
    const riskExecutions = await processPositionRisks(
      cycleId,
      pipelineResult.screening.selectedMarkets,
      pipelineResult.screening.marketAnalysis,
    );

    // 파이프라인 결과를 CycleLog로 변환 + 리스크 실행 결과 병합
    const cycleLog = pipelineResultToCycleLog(pipelineResult);
    cycleLog.cycleId = cycleId; // 사이클 ID 통일
    cycleLog.results = [...riskExecutions, ...cycleLog.results.filter(
      (r) => !riskExecutions.some((re) => re.market === r.market),
    )];
    cycleLog.executedCount = cycleLog.results.filter(
      (r) => r.execution && r.execution.success,
    ).length;

    appendCycleLog(cycleLog);

    // 상태 갱신
    const endedAt = cycleLog.endedAt;
    const durationMs = Date.now() - startMs;
    status.totalCycles++;
    status.consecutiveErrors = 0;
    status.lastCycleAt = endedAt;
    updateNextCycleTime();
    persistState();

    console.log(`[사이클 ${cycleId}] ========== 완료 (${durationMs}ms, 실행 ${cycleLog.executedCount}건) ==========`);
    console.log(`[사이클 ${cycleId}] ${cycleLog.portfolioSummary}`);

    return cycleLog;
  } catch (err) {
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    // 에러 분류
    const classified = classifyApiError(err);
    const errorMsg = `[${classified.kind}] ${classified.message}`;

    console.error(`[사이클 ${cycleId}] 에러 (${classified.kind}): ${classified.message}`);

    if (classified.kind === 'rate_limit') {
      console.warn(`[사이클 ${cycleId}] 레이트 리밋 — 다음 사이클에서 자연 복구 예상`);
    } else if (classified.kind === 'network' || classified.kind === 'timeout') {
      console.warn(`[사이클 ${cycleId}] 네트워크/타임아웃 — 연결 상태 확인 필요`);
    }

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

    // 상태 갱신
    status.totalCycles++;
    status.consecutiveErrors++;
    status.lastCycleAt = endedAt;
    updateNextCycleTime();
    persistState();

    // 연속 에러 임계치 기반 단계적 대응
    if (status.consecutiveErrors >= EMERGENCY_THRESHOLD) {
      // 8회 이상: 긴급 청산 + 중지
      const openPositions = getOpenPositions();
      if (openPositions.length > 0) {
        console.error(
          `[스케줄러] 연속 에러 ${status.consecutiveErrors}회 + ` +
          `보유 포지션 ${openPositions.length}건 — 긴급 청산 실행`,
        );
        emergencyLiquidateAll('consecutive_errors', lastKnownPrices).catch((e) => {
          console.error('[스케줄러] 긴급 청산 실패:', e);
        });
      }
      stopScheduler();
    } else if (status.consecutiveErrors >= AUTO_STOP_THRESHOLD) {
      // 5회 이상: 자동 중지 (포지션은 유지)
      console.error(`[스케줄러] 연속 에러 ${status.consecutiveErrors}회 — 자동 중지`);
      stopScheduler();
    }

    return cycleLog;
  } finally {
    isRunningCycle = false;
  }
}

// ──────────────────────────────────────────────
// 보유 포지션 리스크 자동 처리
// ──────────────────────────────────────────────

async function processPositionRisks(
  cycleId: string,
  targetMarkets: string[],
  marketAnalysis: MarketAnalysis,
): Promise<MarketCycleResult[]> {
  const results: MarketCycleResult[] = [];
  const openPositions = getOpenPositions();

  if (openPositions.length === 0) return results;

  const client = getUpbitClient();
  const holdingMarkets = [...new Set(openPositions.map((p) => p.market))];

  // 보유 종목 현재가 조회
  const tickers = await client.getTicker(holdingMarkets);
  const priceMap: Record<string, number> = {};
  for (const t of tickers) {
    priceMap[t.market] = t.trade_price;
  }

  // 시세 캐시 갱신
  Object.assign(lastKnownPrices, priceMap);

  // 고점 추적 갱신 (트레일링 스탑용)
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

  // 손절/익절 점검 (트레일링 스탑용 고점 전달)
  const riskChecks = checkPositionRisks(priceMap, highPrices);

  for (const check of riskChecks) {
    if (check.action === 'hold') continue;

    const actionLabel =
      check.action === 'stop_loss' ? '손절' :
      check.action === 'take_profit' ? '익절' : '트레일링 스탑';

    const reasoning = `[자동 ${actionLabel}] ${check.violations.map((v) => v.message).join('; ')}`;

    console.log(`[사이클 ${cycleId}]   ${check.market} ${actionLabel} 실행 (수익률 ${check.profitRate}%)`);

    const execResult = executeSell(check.orderId, check.currentPrice, reasoning);

    // 리스크 이벤트 로깅
    const eventType = check.action === 'stop_loss' ? 'stop_loss'
      : check.action === 'take_profit' ? 'take_profit'
      : 'trailing_stop';
    logRiskEvent(eventType as 'stop_loss' | 'take_profit' | 'trailing_stop', check.market, check.orderId, reasoning, {
      buyPrice: check.buyPrice,
      currentPrice: check.currentPrice,
      profitRate: check.profitRate,
    });

    // 고점 기록 삭제
    removeHighPrice(check.orderId);

    // 연속 손실 카운터 갱신
    if (execResult.success) {
      const pnl = check.profitRate < 0 ? -1 : 1; // 손절이면 음수
      updateConsecutiveLosses(pnl);
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

    // 매도 실행 결과를 decision 형태로 래핑
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

    results.push({
      market: check.market,
      decision,
      execution,
      error: execResult.success ? null : execResult.reason,
    });
  }

  return results;
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

function updateNextCycleTime(): void {
  if (status.running) {
    status.nextCycleAt = new Date(Date.now() + config.intervalMs).toISOString();
  }
}

