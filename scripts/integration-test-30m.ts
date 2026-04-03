/**
 * 2차 통합 리뷰: 자동 매매 루프 30분 연속 검증
 *
 * 검증 항목:
 *   - 5분 스케줄러 안정성 (사이클 완주율, 간격 일관성)
 *   - 종목 선정 로직 동작 확인
 *   - AI 판단 로그 완전성
 *   - 수익률 추적 정확성
 *   - 메모리 누수 탐지 (힙 사용량 사이클별 추적)
 *   - API 호출 한도 (업비트 분당 600회 제한 준수)
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/integration-test-30m.ts
 * 결과: data/integration-test-2nd-result.json
 */

import 'dotenv/config';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { UpbitClient } from '@/lib/upbit-client';
import { selectMarkets } from '@/lib/market-selector';
import { analyzeMarket } from '@/lib/market-analysis';
import { analyze as technicalAnalyze } from '@/lib/indicators';
import { evaluate as algorithmEvaluate } from '@/lib/trading-engine';
import { evaluateWithAI } from '@/lib/ai-judgment-engine';
import { classifyApiError } from '@/lib/upbit-client';
import type { TradingDecision, PortfolioContext, DecisionInput } from '@/types/trading-decision';
import type { TechnicalAnalysis } from '@/types/indicator';
import type { UpbitCandle } from '@/types/upbit';

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────

const TEST_NAME = '2차 통합 리뷰: 자동 매매 루프 검증';
const TARGET_CYCLES = 7;                          // 6사이클 = 30분. 버퍼 1회 추가
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;         // 5분
const MAX_DURATION_MS = 35 * 60 * 1000;          // 35분 하드 타임아웃
const CANDLE_UNIT: 5 | 15 | 60 = 5;
const CANDLE_COUNT = 200;
const TARGET_MARKET_COUNT = 5;
const INITIAL_CAPITAL = 10_000_000;              // 1000만 KRW
const BUY_SIZE_RATE = 0.1;                       // 자본의 10%씩 매수
const FEE_RATE = 0.0005;                         // 업비트 수수료 0.05%
const STOP_LOSS_RATE = -0.02;                    // 손절 -2%
const TAKE_PROFIT_RATE = 0.03;                   // 익절 +3%

// 결과 파일 경로
const DATA_DIR = path.resolve(process.cwd(), 'data');
const RESULT_FILE = path.join(DATA_DIR, 'integration-test-2nd-result.json');

// 패스/페일 기준
const PASS_CRITERIA = {
  minCycleCompletionRate: 80,   // 사이클 완주율 80% 이상
  maxMemoryGrowthMB: 100,       // 힙 증가 100MB 미만
  maxApiCallsPerCycle: 300,     // 사이클당 API 호출 300회 미만
  maxErrorRate: 33,             // 에러 사이클 비율 33% 미만
  maxCycleIntervalDriftPct: 15, // 5분 기준 ±15% 이내
};

// ──────────────────────────────────────────────
// 타입
// ──────────────────────────────────────────────

interface SimPosition {
  id: string;
  market: string;
  buyPrice: number;
  volume: number;
  totalCost: number;  // 수수료 포함
  boughtAt: string;
}

interface SimPortfolio {
  cash: number;
  positions: SimPosition[];
  totalRealizedPnl: number;
  totalFeesPaid: number;
  totalBuys: number;
  totalSells: number;
}

interface MemorySnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

interface ApiCallStats {
  total: number;
  byType: Record<string, number>;
}

interface CycleRecord {
  cycleNumber: number;
  cycleId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  intervalFromPreviousMs: number | null;  // 직전 사이클과의 간격
  selectedMarkets: string[];
  decisions: {
    market: string;
    action: 'buy' | 'sell' | 'hold';
    confidence: number;
    compositeScore: number;
    reasoning: string;
    executed: boolean;
    executedPrice: number | null;
    executedAmount: number | null;
  }[];
  portfolio: {
    cash: number;
    positionValue: number;
    totalEquity: number;
    returnRate: number;
    positionCount: number;
    realizedPnl: number;
    feesPaid: number;
  };
  memory: MemorySnapshot;
  apiCalls: ApiCallStats;
  error: string | null;
}

interface TestResult {
  testName: string;
  testId: string;
  startedAt: string;
  endedAt: string | null;
  totalDurationMs: number | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  config: {
    targetCycles: number;
    cycleIntervalMs: number;
    initialCapital: number;
    targetMarketCount: number;
    candleUnit: number;
    candleCount: number;
  };
  cycles: CycleRecord[];
  summary: {
    totalCycles: number;
    successCycles: number;
    errorCycles: number;
    completionRate: number;
    avgCycleDurationMs: number;
    maxCycleDurationMs: number;
    minCycleDurationMs: number;
    avgIntervalMs: number | null;
    intervalDriftPct: number | null;
  } | null;
  performance: {
    finalEquity: number;
    returnRate: number;
    realizedPnl: number;
    feesPaid: number;
    totalBuys: number;
    totalSells: number;
    winCount: number;
    lossCount: number;
    winRate: number;
  } | null;
  stability: {
    memoryGrowthMB: number;
    avgApiCallsPerCycle: number;
    maxApiCallsPerCycle: number;
    errorRate: number;
    passedCriteria: Record<string, boolean>;
    overallPass: boolean;
  } | null;
  errors: { cycleNumber: number; time: string; message: string }[];
}

// ──────────────────────────────────────────────
// API 호출 인터셉터
// ──────────────────────────────────────────────

/** 업비트 클라이언트 API 호출 횟수 추적 */
class InstrumentedUpbitClient extends UpbitClient {
  public callStats: ApiCallStats = { total: 0, byType: {} };

  resetStats() {
    this.callStats = { total: 0, byType: {} };
  }

  private track(method: string) {
    this.callStats.total++;
    this.callStats.byType[method] = (this.callStats.byType[method] ?? 0) + 1;
  }

  override async getMarkets(onlyKrw = true) {
    this.track('getMarkets');
    return super.getMarkets(onlyKrw);
  }

  override async getTicker(markets: string[]) {
    this.track('getTicker');
    return super.getTicker(markets);
  }

  override async getCandlesMinutes(unit: 1 | 3 | 5 | 10 | 15 | 30 | 60 | 240, market: string, count = 200) {
    this.track('getCandlesMinutes');
    return super.getCandlesMinutes(unit, market, count);
  }

  override async getCandlesDays(market: string, count = 200) {
    this.track('getCandlesDays');
    return super.getCandlesDays(market, count);
  }

  override async getAccounts() {
    this.track('getAccounts');
    return super.getAccounts();
  }

  override async getOrderbook(markets: string[]) {
    this.track('getOrderbook');
    return super.getOrderbook(markets);
  }
}

// ──────────────────────────────────────────────
// 포트폴리오 관리 (인메모리, 격리)
// ──────────────────────────────────────────────

function createPortfolio(): SimPortfolio {
  return {
    cash: INITIAL_CAPITAL,
    positions: [],
    totalRealizedPnl: 0,
    totalFeesPaid: 0,
    totalBuys: 0,
    totalSells: 0,
  };
}

function simBuy(portfolio: SimPortfolio, market: string, price: number): boolean {
  const allocate = portfolio.cash * BUY_SIZE_RATE;
  if (allocate < 5000) return false;  // 최소 5000원

  const fee = allocate * FEE_RATE;
  const netAmount = allocate - fee;
  const volume = netAmount / price;

  portfolio.cash -= allocate;
  portfolio.positions.push({
    id: crypto.randomUUID().slice(0, 8),
    market,
    buyPrice: price,
    volume,
    totalCost: allocate,
    boughtAt: new Date().toISOString(),
  });
  portfolio.totalFeesPaid += fee;
  portfolio.totalBuys++;
  return true;
}

function simSell(portfolio: SimPortfolio, market: string, price: number, reason: string): number {
  const posIdx = portfolio.positions.findIndex((p) => p.market === market);
  if (posIdx === -1) return 0;

  const pos = portfolio.positions[posIdx];
  const grossProceeds = pos.volume * price;
  const fee = grossProceeds * FEE_RATE;
  const netProceeds = grossProceeds - fee;
  const pnl = netProceeds - pos.totalCost;

  portfolio.cash += netProceeds;
  portfolio.totalRealizedPnl += pnl;
  portfolio.totalFeesPaid += fee;
  portfolio.totalSells++;
  portfolio.positions.splice(posIdx, 1);

  return pnl;
}

function getPositionValue(portfolio: SimPortfolio, priceMap: Record<string, number>): number {
  return portfolio.positions.reduce((sum, pos) => {
    const price = priceMap[pos.market] ?? pos.buyPrice;
    return sum + pos.volume * price;
  }, 0);
}

function calcWinLoss(cycles: CycleRecord[]): { win: number; loss: number } {
  let win = 0, loss = 0;
  for (const cycle of cycles) {
    for (const d of cycle.decisions) {
      if (d.executed && d.action === 'sell' && d.executedAmount !== null) {
        if (d.executedAmount > 0) win++;
        else loss++;
      }
    }
  }
  return { win, loss };
}

// ──────────────────────────────────────────────
// 메모리 스냅샷
// ──────────────────────────────────────────────

function takeMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
    rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
    externalMB: Math.round(mem.external / 1024 / 1024 * 10) / 10,
  };
}

// ──────────────────────────────────────────────
// 결과 파일 저장
// ──────────────────────────────────────────────

function saveResult(result: TestResult): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// 로그 유틸
// ──────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ──────────────────────────────────────────────
// 리스크 자동 손절/익절 처리
// ──────────────────────────────────────────────

interface RiskCheckResult {
  market: string;
  action: 'stop_loss' | 'take_profit' | 'hold';
  price: number;
  profitRate: number;
  reason: string;
}

function checkPositionRisks(
  portfolio: SimPortfolio,
  priceMap: Record<string, number>,
): RiskCheckResult[] {
  const results: RiskCheckResult[] = [];

  for (const pos of portfolio.positions) {
    const price = priceMap[pos.market];
    if (!price) continue;

    const profitRate = (price - pos.buyPrice) / pos.buyPrice;

    if (profitRate <= STOP_LOSS_RATE) {
      results.push({
        market: pos.market,
        action: 'stop_loss',
        price,
        profitRate: Math.round(profitRate * 10000) / 100,
        reason: `손절: ${Math.round(profitRate * 10000) / 100}% (기준: ${STOP_LOSS_RATE * 100}%)`,
      });
    } else if (profitRate >= TAKE_PROFIT_RATE) {
      results.push({
        market: pos.market,
        action: 'take_profit',
        price,
        profitRate: Math.round(profitRate * 10000) / 100,
        reason: `익절: ${Math.round(profitRate * 10000) / 100}% (기준: ${TAKE_PROFIT_RATE * 100}%)`,
      });
    }
  }

  return results;
}

// ──────────────────────────────────────────────
// 단일 사이클 실행
// ──────────────────────────────────────────────

async function runCycle(
  cycleNumber: number,
  client: InstrumentedUpbitClient,
  portfolio: SimPortfolio,
  prevCycleEndedAt: string | null,
): Promise<CycleRecord> {
  const cycleId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  client.resetStats();

  log('사이클', `#${cycleNumber} [${cycleId}] 시작`);

  const decisions: CycleRecord['decisions'] = [];
  let selectedMarkets: string[] = [];
  let error: string | null = null;

  try {
    // 1단계: 시장 분석 (공포/탐욕 지수, BTC 도미넌스)
    log('분석', '시장 심리 분석 중...');
    const marketAnalysis = await analyzeMarket();

    // 2단계: 종목 선정
    log('선정', `종목 스크리닝 중 (대상 ${TARGET_MARKET_COUNT}종목)...`);
    const holdingMarkets = [...new Set(portfolio.positions.map((p) => p.market))];
    const selectionResult = await selectMarkets(holdingMarkets);
    selectedMarkets = selectionResult.selectedMarkets;

    log('선정', `선정 완료: ${selectedMarkets.join(', ')}`);

    // 현재 포지션의 시세 조회 (리스크 관리용)
    const allMarkets = [...new Set([...selectedMarkets, ...holdingMarkets])];

    let priceMap: Record<string, number> = {};
    if (allMarkets.length > 0) {
      const tickers = await client.getTicker(allMarkets);
      for (const t of tickers) {
        priceMap[t.market] = t.trade_price;
      }
    }

    // 3단계: 보유 포지션 리스크 처리 (손절/익절)
    const riskChecks = checkPositionRisks(portfolio, priceMap);
    for (const check of riskChecks) {
      if (check.action === 'hold') continue;
      const pnl = simSell(portfolio, check.market, check.price, check.reason);
      decisions.push({
        market: check.market,
        action: 'sell',
        confidence: 100,
        compositeScore: check.profitRate < 0 ? -100 : 100,
        reasoning: check.reason,
        executed: true,
        executedPrice: check.price,
        executedAmount: pnl,
      });
      log('리스크', `${check.market} ${check.action === 'stop_loss' ? '손절' : '익절'} (${check.profitRate}%)`);
    }

    // 4단계: 종목별 기술 분석 → AI 판단
    const totalPositionAmount = portfolio.positions.reduce((s, p) => s + p.totalCost, 0);

    for (const market of selectedMarkets) {
      // 이미 리스크 처리된 종목은 스킵
      if (decisions.some((d) => d.market === market)) continue;

      try {
        log('종목', `${market} 분석 중...`);

        // 캔들 데이터 조회
        const candles = await client.getCandlesMinutes(CANDLE_UNIT, market, CANDLE_COUNT);
        if (candles.length < 30) {
          log('종목', `${market} 캔들 부족 (${candles.length}개) — 스킵`);
          continue;
        }

        // 기술 분석
        const ta: TechnicalAnalysis = technicalAnalyze(candles as unknown as Parameters<typeof technicalAnalyze>[0]);

        // 판단 입력 생성
        const currentPrice = priceMap[market] ?? candles[0].trade_price;
        const pos = portfolio.positions.find((p) => p.market === market) ?? null;
        const portfolioContext: PortfolioContext = {
          isHolding: pos !== null,
          avgBuyPrice: pos ? pos.buyPrice : null,
          currentProfitRate: pos
            ? Math.round(((currentPrice - pos.buyPrice) / pos.buyPrice) * 10000) / 100
            : null,
          holdingCount: portfolio.positions.length,
          totalPositionAmount,
          availableBalance: portfolio.cash,
          todayTradeCount: decisions.filter((d) => d.executed).length,
          todayRealizedPnL: portfolio.totalRealizedPnl,
        };
        const decisionInput: DecisionInput = {
          market,
          currentPrice,
          technicalAnalysis: ta,
          marketAnalysis,
          portfolio: portfolioContext,
        };

        // AI 판단
        const decision: TradingDecision = await evaluateWithAI(decisionInput);

        log('판단', `${market}: ${decision.action.toUpperCase()} (신뢰도 ${decision.confidence}%, 점수 ${decision.compositeScore})`);

        // 현재 포지션 여부 확인
        const hasPosition = portfolio.positions.some((p) => p.market === market);

        // 매수/매도 실행
        let executed = false;
        let executedPrice: number | null = null;
        let executedAmount: number | null = null;

        if (decision.action === 'buy' && !hasPosition) {
          executed = simBuy(portfolio, market, currentPrice);
          if (executed) {
            executedPrice = currentPrice;
            executedAmount = portfolio.cash; // 매수 후 잔고
            log('실행', `${market} 매수 @ ${currentPrice.toLocaleString()}원`);
          }
        } else if (decision.action === 'sell' && hasPosition) {
          const pnl = simSell(portfolio, market, currentPrice, decision.reasoning);
          executed = true;
          executedPrice = currentPrice;
          executedAmount = pnl;
          log('실행', `${market} 매도 @ ${currentPrice.toLocaleString()}원 (손익 ${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원)`);
        } else {
          log('실행', `${market} 관망`);
        }

        decisions.push({
          market,
          action: decision.action,
          confidence: decision.confidence,
          compositeScore: decision.compositeScore,
          reasoning: decision.reasoning,
          executed,
          executedPrice,
          executedAmount,
        });

        // API 레이트 리밋 방지 딜레이
        await sleep(150);

      } catch (marketErr) {
        const errMsg = marketErr instanceof Error ? marketErr.message : String(marketErr);
        log('에러', `${market} 분석 실패: ${errMsg}`);
        decisions.push({
          market,
          action: 'hold',
          confidence: 0,
          compositeScore: 0,
          reasoning: `분석 실패: ${errMsg}`,
          executed: false,
          executedPrice: null,
          executedAmount: null,
        });
      }
    }

  } catch (cycleErr) {
    const classified = classifyApiError(cycleErr);
    error = `[${classified.kind}] ${classified.message}`;
    log('에러', `사이클 실패: ${error}`);
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // 포트폴리오 평가
  const priceMapForValue: Record<string, number> = {};
  for (const pos of portfolio.positions) {
    // 현재가를 모르면 매수가로 대체
    priceMapForValue[pos.market] = pos.buyPrice;
  }
  const positionValue = getPositionValue(portfolio, priceMapForValue);
  const totalEquity = portfolio.cash + positionValue;
  const returnRate = Math.round(((totalEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 10000) / 100;

  // 직전 사이클 간격 계산
  let intervalFromPreviousMs: number | null = null;
  if (prevCycleEndedAt) {
    intervalFromPreviousMs = startMs - new Date(prevCycleEndedAt).getTime();
  }

  const record: CycleRecord = {
    cycleNumber,
    cycleId,
    startedAt,
    endedAt,
    durationMs,
    intervalFromPreviousMs,
    selectedMarkets,
    decisions,
    portfolio: {
      cash: Math.round(portfolio.cash),
      positionValue: Math.round(positionValue),
      totalEquity: Math.round(totalEquity),
      returnRate,
      positionCount: portfolio.positions.length,
      realizedPnl: Math.round(portfolio.totalRealizedPnl),
      feesPaid: Math.round(portfolio.totalFeesPaid),
    },
    memory: takeMemorySnapshot(),
    apiCalls: { ...client.callStats, byType: { ...client.callStats.byType } },
    error,
  };

  log('사이클', `#${cycleNumber} 완료 (${durationMs}ms | 자산 ${totalEquity.toLocaleString()}원 | 수익률 ${returnRate >= 0 ? '+' : ''}${returnRate}%)`);
  log('메모리', `Heap ${record.memory.heapUsedMB}MB / ${record.memory.heapTotalMB}MB | RSS ${record.memory.rssMB}MB`);
  log('API', `이번 사이클 ${record.apiCalls.total}회 호출`);

  return record;
}

// ──────────────────────────────────────────────
// 최종 분석 및 검증
// ──────────────────────────────────────────────

function buildFinalResult(result: TestResult): TestResult {
  const cycles = result.cycles;
  if (cycles.length === 0) {
    result.status = 'failed';
    return result;
  }

  const successCycles = cycles.filter((c) => !c.error).length;
  const errorCycles = cycles.filter((c) => !!c.error).length;
  const completionRate = Math.round((successCycles / cycles.length) * 100);

  const durations = cycles.map((c) => c.durationMs);
  const avgCycleDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const maxCycleDurationMs = Math.max(...durations);
  const minCycleDurationMs = Math.min(...durations);

  const intervals = cycles
    .filter((c) => c.intervalFromPreviousMs !== null)
    .map((c) => c.intervalFromPreviousMs as number);
  const avgIntervalMs = intervals.length > 0
    ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
    : null;
  const intervalDriftPct = avgIntervalMs !== null
    ? Math.round(Math.abs(avgIntervalMs - CYCLE_INTERVAL_MS) / CYCLE_INTERVAL_MS * 10000) / 100
    : null;

  result.summary = {
    totalCycles: cycles.length,
    successCycles,
    errorCycles,
    completionRate,
    avgCycleDurationMs,
    maxCycleDurationMs,
    minCycleDurationMs,
    avgIntervalMs,
    intervalDriftPct,
  };

  // 성과
  const lastCycle = cycles[cycles.length - 1];
  const { win, loss } = calcWinLoss(cycles);
  const totalTrades = win + loss;

  result.performance = {
    finalEquity: lastCycle.portfolio.totalEquity,
    returnRate: lastCycle.portfolio.returnRate,
    realizedPnl: lastCycle.portfolio.realizedPnl,
    feesPaid: lastCycle.portfolio.feesPaid,
    totalBuys: cycles.reduce((s, c) => s + c.decisions.filter((d) => d.action === 'buy' && d.executed).length, 0),
    totalSells: cycles.reduce((s, c) => s + c.decisions.filter((d) => d.action === 'sell' && d.executed).length, 0),
    winCount: win,
    lossCount: loss,
    winRate: totalTrades > 0 ? Math.round((win / totalTrades) * 10000) / 100 : 0,
  };

  // 메모리 분석
  const firstHeap = cycles[0].memory.heapUsedMB;
  const lastHeap = cycles[cycles.length - 1].memory.heapUsedMB;
  const memoryGrowthMB = Math.round((lastHeap - firstHeap) * 10) / 10;

  const apiCallsPerCycle = cycles.map((c) => c.apiCalls.total);
  const avgApiCallsPerCycle = Math.round(apiCallsPerCycle.reduce((a, b) => a + b, 0) / apiCallsPerCycle.length);
  const maxApiCallsPerCycle = Math.max(...apiCallsPerCycle);
  const errorRate = Math.round((errorCycles / cycles.length) * 100);

  const passedCriteria: Record<string, boolean> = {
    '사이클 완주율': completionRate >= PASS_CRITERIA.minCycleCompletionRate,
    '메모리 누수': memoryGrowthMB < PASS_CRITERIA.maxMemoryGrowthMB,
    'API 호출 한도': maxApiCallsPerCycle < PASS_CRITERIA.maxApiCallsPerCycle,
    '에러 비율': errorRate < PASS_CRITERIA.maxErrorRate,
    '인터벌 일관성': intervalDriftPct === null || intervalDriftPct <= PASS_CRITERIA.maxCycleIntervalDriftPct,
  };

  const overallPass = Object.values(passedCriteria).every(Boolean);

  result.stability = {
    memoryGrowthMB,
    avgApiCallsPerCycle,
    maxApiCallsPerCycle,
    errorRate,
    passedCriteria,
    overallPass,
  };

  result.status = 'completed';
  return result;
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────

async function main() {
  const testId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();

  console.log('\n' + '═'.repeat(65));
  console.log(`  ${TEST_NAME}`);
  console.log(`  테스트 ID: ${testId}`);
  console.log(`  목표: ${TARGET_CYCLES}사이클 × ${CYCLE_INTERVAL_MS / 60000}분 = ${Math.round(TARGET_CYCLES * CYCLE_INTERVAL_MS / 60000)}분`);
  console.log('═'.repeat(65) + '\n');

  // 결과 초기화
  const result: TestResult = {
    testName: TEST_NAME,
    testId,
    startedAt,
    endedAt: null,
    totalDurationMs: null,
    status: 'running',
    config: {
      targetCycles: TARGET_CYCLES,
      cycleIntervalMs: CYCLE_INTERVAL_MS,
      initialCapital: INITIAL_CAPITAL,
      targetMarketCount: TARGET_MARKET_COUNT,
      candleUnit: CANDLE_UNIT,
      candleCount: CANDLE_COUNT,
    },
    cycles: [],
    summary: null,
    performance: null,
    stability: null,
    errors: [],
  };

  // 즉시 저장 (진행 중 상태 표시)
  saveResult(result);

  // API 연결 확인
  let client: InstrumentedUpbitClient;
  try {
    client = new InstrumentedUpbitClient();
    const healthy = await client.healthCheck();
    if (!healthy) {
      log('초기화', 'API 헬스체크 실패 — 종료');
      result.status = 'failed';
      result.endedAt = new Date().toISOString();
      result.totalDurationMs = Date.now() - new Date(startedAt).getTime();
      saveResult(result);
      process.exit(1);
    }
    log('초기화', 'Upbit API 연결 OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('초기화', `API 연결 실패: ${msg}`);
    result.status = 'failed';
    result.endedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - new Date(startedAt).getTime();
    saveResult(result);
    process.exit(1);
  }

  // 격리된 포트폴리오 초기화
  const portfolio = createPortfolio();
  log('초기화', `격리 포트폴리오 초기화 — 자본 ${INITIAL_CAPITAL.toLocaleString()}원`);

  // SIGINT 핸들러
  let shutdownRequested = false;
  process.on('SIGINT', () => {
    log('시그널', 'SIGINT 수신 — 현재 사이클 완료 후 종료합니다...');
    shutdownRequested = true;
  });

  // 초기 메모리 기록
  log('메모리', `초기 힙: ${takeMemorySnapshot().heapUsedMB}MB`);

  // 메인 루프
  const testStartMs = Date.now();
  let prevCycleEndedAt: string | null = null;

  for (let i = 1; i <= TARGET_CYCLES; i++) {
    if (shutdownRequested) {
      log('루프', '종료 요청 — 루프 중단');
      result.status = 'interrupted';
      break;
    }

    // 하드 타임아웃
    if (Date.now() - testStartMs >= MAX_DURATION_MS) {
      log('루프', `최대 시간 ${MAX_DURATION_MS / 60000}분 초과 — 루프 중단`);
      break;
    }

    const cycleRecord = await runCycle(i, client, portfolio, prevCycleEndedAt);
    result.cycles.push(cycleRecord);
    prevCycleEndedAt = cycleRecord.endedAt;

    if (cycleRecord.error) {
      result.errors.push({
        cycleNumber: i,
        time: cycleRecord.endedAt,
        message: cycleRecord.error,
      });
    }

    // 중간 저장
    saveResult(result);
    log('저장', `중간 결과 저장 완료 (${i}/${TARGET_CYCLES})`);

    // 마지막 사이클이면 대기 없이 종료
    if (i >= TARGET_CYCLES || shutdownRequested) break;

    // 다음 사이클까지 대기 (5분 - 사이클 소요시간)
    const elapsed = Date.now() - new Date(cycleRecord.startedAt).getTime();
    const waitMs = Math.max(0, CYCLE_INTERVAL_MS - elapsed);

    if (waitMs > 0) {
      const waitMin = Math.round(waitMs / 1000);
      log('대기', `다음 사이클까지 ${waitMin}초 대기...`);

      // 10초 단위로 끊어서 대기 (SIGINT 반응성)
      let remaining = waitMs;
      while (remaining > 0 && !shutdownRequested) {
        await sleep(Math.min(remaining, 10_000));
        remaining -= 10_000;
      }
    }
  }

  // 최종 결과 생성
  const endedAt = new Date().toISOString();
  result.endedAt = endedAt;
  result.totalDurationMs = Date.now() - testStartMs;

  if (result.status === 'running') {
    buildFinalResult(result);
  }

  saveResult(result);

  // 결과 콘솔 출력
  console.log('\n' + '═'.repeat(65));
  console.log('  2차 통합 리뷰 — 최종 결과');
  console.log('═'.repeat(65));

  if (result.summary) {
    const s = result.summary;
    console.log('\n▸ 사이클 통계');
    console.log(`  총 사이클:    ${s.totalCycles}회 (성공 ${s.successCycles} / 에러 ${s.errorCycles})`);
    console.log(`  완주율:       ${s.completionRate}%`);
    console.log(`  평균 소요:    ${s.avgCycleDurationMs}ms`);
    if (s.intervalDriftPct !== null) {
      console.log(`  인터벌 편차:  ${s.intervalDriftPct}% (5분 기준)`);
    }
  }

  if (result.performance) {
    const p = result.performance;
    console.log('\n▸ 모의 수익률');
    console.log(`  총 수익률:    ${p.returnRate >= 0 ? '+' : ''}${p.returnRate}%`);
    console.log(`  최종 자산:    ${p.finalEquity.toLocaleString()}원`);
    console.log(`  실현 손익:    ${p.realizedPnl.toLocaleString()}원`);
    console.log(`  수수료:       ${p.feesPaid.toLocaleString()}원`);
    console.log(`  매수 ${p.totalBuys}회 / 매도 ${p.totalSells}회`);
    if (p.winCount + p.lossCount > 0) {
      console.log(`  승률:         ${p.winRate}% (${p.winCount}승 ${p.lossCount}패)`);
    }
  }

  if (result.stability) {
    const st = result.stability;
    console.log('\n▸ 안정성 검증');
    console.log(`  메모리 증가:  ${st.memoryGrowthMB >= 0 ? '+' : ''}${st.memoryGrowthMB}MB`);
    console.log(`  API 호출:     평균 ${st.avgApiCallsPerCycle}회 / 최대 ${st.maxApiCallsPerCycle}회 (사이클당)`);
    console.log(`  에러 비율:    ${st.errorRate}%`);
    console.log('\n▸ 패스/페일 기준');
    for (const [key, passed] of Object.entries(st.passedCriteria)) {
      console.log(`  ${passed ? '✓' : '✗'} ${key}`);
    }
    console.log(`\n  최종 판정: ${st.overallPass ? '✅ PASS' : '❌ FAIL'}`);
  }

  console.log('\n' + '═'.repeat(65));
  console.log(`  결과 파일: ${RESULT_FILE}`);
  console.log('═'.repeat(65) + '\n');
}

main().catch((err) => {
  console.error('테스트 예기치 않은 에러:', err);
  process.exit(1);
});
