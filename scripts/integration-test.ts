/**
 * 1차 통합 리뷰: 핵심 엔진 검증
 *
 * API 클라이언트 → 기술분석 → AI 판단(알고리즘 폴백) → 모의거래 → 리스크 관리
 * 전체 흐름을 단일 종목(KRW-BTC)으로 1회 수동 실행하여 검증.
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/integration-test.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { UpbitClient } from '@/lib/upbit-client';
import { analyzeMarket } from '@/lib/market-analysis';
import { analyze as technicalAnalyze } from '@/lib/indicators';
import { evaluate as algorithmEvaluate } from '@/lib/trading-engine';
import { buildPromptContext } from '@/lib/ai-judgment-engine';
import {
  executeBuy,
  loadBalance,
  initializeBalance,
  getBalanceSummary,
} from '@/lib/paper-trading-engine';
import {
  checkBuyRisk,
  getTodayStats,
  loadRiskConfig,
} from '@/lib/risk-manager';
import { getOpenPositions, listOrders } from '@/lib/order-store';
import { getAvailableBalance } from '@/lib/balance-tracker';

// ─── 결과 저장 경로 ────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RESULT_FILE = path.join(DATA_DIR, 'integration-test-result.json');

// ─── 유틸 ─────────────────────────────────────────────────────

function log(stage: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${stage}] ${msg}`);
}

function separator(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─── 메인 ─────────────────────────────────────────────────────

async function main() {
  const testMarket = 'KRW-BTC';
  const startedAt = new Date().toISOString();
  const stageResults: Record<string, unknown> = {};
  const stageTimings: Record<string, number> = {};
  const errors: string[] = [];

  console.log('\n========================================');
  console.log('  1차 통합 리뷰: 핵심 엔진 검증');
  console.log(`  대상: ${testMarket}`);
  console.log(`  시작: ${startedAt}`);
  console.log('========================================\n');

  // ── 0단계: 모의 계좌 초기화 확인 ──
  separator('0. 모의 계좌 초기화');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const balance = loadBalance();
    log('계좌', `현재 잔고: ${balance.cash.toLocaleString()}원 / 초기자본: ${balance.initialCapital.toLocaleString()}원`);
    log('계좌', `보유 포지션: ${balance.holdings.length}건`);
    stageResults['account_init'] = {
      success: true,
      cash: balance.cash,
      initialCapital: balance.initialCapital,
      holdingsCount: balance.holdings.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('계좌', `초기화 실패 — 새로 생성합니다: ${msg}`);
    initializeBalance(10_000_000);
    stageResults['account_init'] = { success: true, freshInit: true, capital: 10_000_000 };
  }

  // ── 1단계: API 클라이언트 연결 ──
  separator('1. 업비트 API 연결');
  let client: UpbitClient;
  let t0 = Date.now();
  try {
    client = new UpbitClient();
    const healthy = await client.healthCheck();
    stageTimings['api_connect'] = Date.now() - t0;
    log('API', `헬스체크: ${healthy ? 'OK' : 'FAIL'} (${stageTimings['api_connect']}ms)`);
    stageResults['api_connect'] = { success: healthy, latencyMs: stageTimings['api_connect'] };
    if (!healthy) {
      errors.push('API 헬스체크 실패');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`API 연결 실패: ${msg}`);
    log('API', `연결 실패: ${msg}`);
    stageResults['api_connect'] = { success: false, error: msg };
    writeResult(startedAt, testMarket, stageResults, stageTimings, errors);
    process.exit(1);
  }

  // ── 2단계: 시장 전체 분석 ──
  separator('2. 시장 전체 분석 (공포/탐욕, BTC 도미넌스, 급등/급락)');
  t0 = Date.now();
  let marketAnalysis;
  try {
    marketAnalysis = await analyzeMarket();
    stageTimings['market_analysis'] = Date.now() - t0;
    log('시장', `분석 완료 (${stageTimings['market_analysis']}ms)`);
    log('시장', `공포/탐욕: ${marketAnalysis.fearGreed.score}/100 (${marketAnalysis.fearGreed.label})`);
    log('시장', `BTC 도미넌스: ${marketAnalysis.btcDominance.dominanceRate}%`);
    log('시장', `급등: ${marketAnalysis.surges.length}건, 급락: ${marketAnalysis.crashes.length}건`);
    log('시장', `요약: ${marketAnalysis.summary}`);
    stageResults['market_analysis'] = {
      success: true,
      latencyMs: stageTimings['market_analysis'],
      fearGreed: marketAnalysis.fearGreed,
      btcDominance: marketAnalysis.btcDominance,
      surgeCount: marketAnalysis.surges.length,
      crashCount: marketAnalysis.crashes.length,
      summary: marketAnalysis.summary,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`시장 분석 실패: ${msg}`);
    log('시장', `분석 실패: ${msg}`);
    stageResults['market_analysis'] = { success: false, error: msg };
    writeResult(startedAt, testMarket, stageResults, stageTimings, errors);
    process.exit(1);
  }

  // ── 3단계: 종목 캔들 데이터 조회 + 기술 분석 ──
  separator(`3. ${testMarket} 기술 분석 (5분봉 200개)`);
  t0 = Date.now();
  let technicalResult;
  let currentPrice: number;
  try {
    const candles = await client.getCandlesMinutes(5, testMarket, 200);
    log('기술', `캔들 ${candles.length}개 수신`);

    if (candles.length < 30) {
      throw new Error(`캔들 데이터 부족: ${candles.length}개`);
    }

    currentPrice = candles[0].trade_price;
    technicalResult = technicalAnalyze(candles);
    stageTimings['technical_analysis'] = Date.now() - t0;

    const rsi = technicalResult.rsi.values.find((v: number | null) => v !== null);
    const macdHist = technicalResult.macd.histogram.find((v: number | null) => v !== null);
    const bb = technicalResult.bollingerBand.percentB.find((v: number | null) => v !== null);

    log('기술', `현재가: ${currentPrice.toLocaleString()}원`);
    log('기술', `RSI: ${rsi?.toFixed(1) ?? 'N/A'}`);
    log('기술', `MACD Histogram: ${macdHist?.toFixed(4) ?? 'N/A'}`);
    log('기술', `Bollinger %B: ${bb?.toFixed(3) ?? 'N/A'}`);
    log('기술', `거래량 비율: ${technicalResult.volume.volumeRatio.toFixed(2)}x`);
    log('기술', `분석 완료 (${stageTimings['technical_analysis']}ms)`);

    stageResults['technical_analysis'] = {
      success: true,
      latencyMs: stageTimings['technical_analysis'],
      currentPrice,
      candleCount: candles.length,
      rsi,
      macdHistogram: macdHist,
      bollingerPercentB: bb,
      volumeRatio: technicalResult.volume.volumeRatio,
      volumeSurge: technicalResult.volume.isSurge,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`기술 분석 실패: ${msg}`);
    log('기술', `실패: ${msg}`);
    stageResults['technical_analysis'] = { success: false, error: msg };
    writeResult(startedAt, testMarket, stageResults, stageTimings, errors);
    process.exit(1);
  }

  // ── 4단계: AI/알고리즘 판단 ──
  separator(`4. ${testMarket} AI/알고리즘 판단`);
  t0 = Date.now();
  let decision;
  try {
    // 포트폴리오 컨텍스트 구성
    const openPositions = getOpenPositions();
    const marketPositions = openPositions.filter(p => p.market === testMarket);
    const isHolding = marketPositions.length > 0;
    let avgBuyPrice: number | null = null;
    let currentProfitRate: number | null = null;

    if (isHolding && marketPositions.length > 0) {
      const totalCost = marketPositions.reduce((s, p) => s + p.totalAmount, 0);
      const totalVol = marketPositions.reduce((s, p) => s + p.volume, 0);
      avgBuyPrice = totalVol > 0 ? totalCost / totalVol : null;
      if (avgBuyPrice && avgBuyPrice > 0) {
        currentProfitRate = (currentPrice - avgBuyPrice) / avgBuyPrice;
      }
    }

    const holdingMarkets = new Set(openPositions.map(p => p.market));
    const totalPositionAmount = openPositions.reduce((s, p) => s + p.totalAmount, 0);
    const todayStats = getTodayStats();

    const portfolio = {
      isHolding,
      avgBuyPrice,
      currentProfitRate,
      holdingCount: holdingMarkets.size,
      totalPositionAmount,
      availableBalance: getAvailableBalance(),
      todayTradeCount: todayStats.tradeCount,
      todayRealizedPnL: todayStats.realizedPnl,
    };

    const input = {
      market: testMarket,
      currentPrice,
      technicalAnalysis: technicalResult,
      marketAnalysis,
      portfolio,
    };

    // 알고리즘 판단 (ANTHROPIC_API_KEY 없으므로 알고리즘 모드 사용)
    decision = algorithmEvaluate(input);
    stageTimings['judgment'] = Date.now() - t0;

    // 프롬프트 컨텍스트도 생성하여 기록 (AI에 보낼 입력값 확인용)
    const promptCtx = buildPromptContext(input);

    log('판단', `액션: ${decision.action.toUpperCase()}`);
    log('판단', `신뢰도: ${decision.confidence}%`);
    log('판단', `종합 점수: ${decision.compositeScore}`);
    log('판단', `제안 비율: ${(decision.suggestedSizeRate * 100).toFixed(1)}%`);
    log('판단', `근거: ${decision.reasoning}`);
    log('판단', `시그널 ${decision.signals.length}개:`);
    for (const sig of decision.signals) {
      log('판단', `  - ${sig.name}: ${sig.score > 0 ? '+' : ''}${sig.score.toFixed(2)} (가중치 ${sig.weight.toFixed(2)}) — ${sig.reason}`);
    }
    log('판단', `분석 완료 (${stageTimings['judgment']}ms)`);

    stageResults['judgment'] = {
      success: true,
      engine: 'algorithm',
      latencyMs: stageTimings['judgment'],
      action: decision.action,
      confidence: decision.confidence,
      compositeScore: decision.compositeScore,
      suggestedSizeRate: decision.suggestedSizeRate,
      reasoning: decision.reasoning,
      signals: decision.signals,
      suggestedStopLoss: decision.suggestedStopLoss,
      suggestedTakeProfit: decision.suggestedTakeProfit,
      promptContext: promptCtx,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`판단 실패: ${msg}`);
    log('판단', `실패: ${msg}`);
    stageResults['judgment'] = { success: false, error: msg };
    writeResult(startedAt, testMarket, stageResults, stageTimings, errors);
    process.exit(1);
  }

  // ── 5단계: 리스크 체크 ──
  separator(`5. ${testMarket} 리스크 체크`);
  t0 = Date.now();
  try {
    const riskConfig = loadRiskConfig();
    log('리스크', `설정 — 1건 최대: ${riskConfig.positionSize.maxAmountPerTrade.toLocaleString()}원`);
    log('리스크', `설정 — 전체 최대: ${riskConfig.positionSize.maxTotalPosition.toLocaleString()}원`);
    log('리스크', `설정 — 일일 최대 손실: ${riskConfig.dailyLoss.maxDailyLossAmount.toLocaleString()}원`);

    if (decision.action === 'buy') {
      const availableBalance = getAvailableBalance();
      const rawAmount = Math.round(availableBalance * decision.suggestedSizeRate);
      log('리스크', `매수 시도 금액: ${rawAmount.toLocaleString()}원 (잔고 ${availableBalance.toLocaleString()}원 × ${(decision.suggestedSizeRate * 100).toFixed(1)}%)`);

      // ticker 정보 조회
      const [ticker] = await client.getTicker([testMarket]);
      const riskCheck = checkBuyRisk(
        testMarket,
        rawAmount,
        ticker
          ? { accTradePrice24h: ticker.acc_trade_price_24h, signedChangeRate: ticker.signed_change_rate }
          : undefined,
      );

      stageTimings['risk_check'] = Date.now() - t0;
      log('리스크', `허용 여부: ${riskCheck.allowed ? 'YES' : 'NO'}`);
      if (riskCheck.adjustedAmount !== null) {
        log('리스크', `조정 금액: ${riskCheck.adjustedAmount.toLocaleString()}원`);
      }
      if (riskCheck.violations.length > 0) {
        for (const v of riskCheck.violations) {
          log('리스크', `  [${v.severity}] ${v.rule}: ${v.message}`);
        }
      }
      log('리스크', `체크 완료 (${stageTimings['risk_check']}ms)`);

      stageResults['risk_check'] = {
        success: true,
        latencyMs: stageTimings['risk_check'],
        action: 'buy',
        rawAmount,
        allowed: riskCheck.allowed,
        adjustedAmount: riskCheck.adjustedAmount,
        violations: riskCheck.violations,
      };
    } else {
      stageTimings['risk_check'] = Date.now() - t0;
      log('리스크', `액션이 ${decision.action}이므로 매수 리스크 체크 스킵`);
      stageResults['risk_check'] = {
        success: true,
        latencyMs: stageTimings['risk_check'],
        action: decision.action,
        skipped: true,
        reason: `판단 결과가 ${decision.action}이므로 매수 리스크 체크 불필요`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`리스크 체크 실패: ${msg}`);
    log('리스크', `실패: ${msg}`);
    stageResults['risk_check'] = { success: false, error: msg };
  }

  // ── 6단계: 모의 거래 실행 ──
  separator(`6. ${testMarket} 모의 거래 실행`);
  t0 = Date.now();
  try {
    if (decision.action === 'buy') {
      const availableBalance = getAvailableBalance();
      const riskResult = stageResults['risk_check'] as Record<string, unknown>;
      const buyAmount = (riskResult?.adjustedAmount as number) ??
        Math.round(availableBalance * decision.suggestedSizeRate);

      if (buyAmount < 5000) {
        log('실행', `매수 금액 부족 (${buyAmount.toLocaleString()}원 < 5,000원) — 스킵`);
        stageResults['execution'] = {
          success: true,
          skipped: true,
          reason: `매수 금액 부족: ${buyAmount.toLocaleString()}원`,
        };
      } else if (riskResult?.allowed === false) {
        log('실행', '리스크 체크 차단 — 매수 스킵');
        stageResults['execution'] = {
          success: true,
          skipped: true,
          reason: '리스크 체크에서 차단됨',
        };
      } else {
        log('실행', `모의 매수 실행: ${testMarket} @ ${currentPrice.toLocaleString()}원, 금액 ${buyAmount.toLocaleString()}원`);
        const execResult = executeBuy(testMarket, currentPrice, buyAmount, decision.reasoning);

        stageTimings['execution'] = Date.now() - t0;
        if (execResult.success) {
          log('실행', `체결 성공`);
          log('실행', `  체결가: ${execResult.executedPrice.toLocaleString()}원`);
          log('실행', `  수수료: ${execResult.feeAmount.toLocaleString()}원`);
          log('실행', `  결제총액: ${execResult.totalSettlement.toLocaleString()}원`);
          log('실행', `  잔여 현금: ${execResult.cashAfter.toLocaleString()}원`);
          log('실행', `  주문ID: ${execResult.order?.id}`);
        } else {
          log('실행', `체결 실패: ${execResult.reason}`);
        }

        stageResults['execution'] = {
          success: execResult.success,
          latencyMs: stageTimings['execution'],
          executedPrice: execResult.executedPrice,
          feeAmount: execResult.feeAmount,
          totalSettlement: execResult.totalSettlement,
          cashAfter: execResult.cashAfter,
          orderId: execResult.order?.id ?? null,
          reason: execResult.reason,
        };
      }
    } else if (decision.action === 'sell') {
      const positions = getOpenPositions(testMarket);
      if (positions.length === 0) {
        log('실행', `${testMarket} 보유 포지션 없음 — 매도 스킵`);
        stageResults['execution'] = {
          success: true,
          skipped: true,
          reason: '보유 포지션 없음',
        };
      } else {
        log('실행', `매도 대상 포지션 ${positions.length}건 — 이번 테스트에서는 기록만`);
        stageResults['execution'] = {
          success: true,
          skipped: true,
          reason: '통합 테스트에서는 매도 실행 생략 (포지션 있음)',
          positionCount: positions.length,
        };
      }
    } else {
      log('실행', `관망 판단 — 거래 없음`);
      stageResults['execution'] = {
        success: true,
        skipped: true,
        reason: '관망(hold) 판단으로 거래 없음',
      };
    }
    stageTimings['execution'] = stageTimings['execution'] ?? (Date.now() - t0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`모의 거래 실행 실패: ${msg}`);
    log('실행', `실패: ${msg}`);
    stageResults['execution'] = { success: false, error: msg };
  }

  // ── 7단계: 기록 검증 ──
  separator('7. 기록 검증');
  try {
    const orders = listOrders({ limit: 5 });
    log('검증', `최근 주문: ${orders.length}건`);
    for (const o of orders.slice(0, 3)) {
      log('검증', `  ${o.side.toUpperCase()} ${o.market} @ ${o.price.toLocaleString()}원 × ${o.volume.toFixed(8)} (${o.status})`);
    }

    const positions = getOpenPositions();
    log('검증', `오픈 포지션: ${positions.length}건`);

    const balanceSummary = getBalanceSummary();
    log('검증', `잔고 요약: ${balanceSummary}`);

    // 파일 존재 확인
    const dataFiles = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
    log('검증', `data/ 파일: ${dataFiles.join(', ')}`);

    stageResults['verification'] = {
      success: true,
      recentOrderCount: orders.length,
      openPositionCount: positions.length,
      balanceSummary,
      dataFiles,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`기록 검증 실패: ${msg}`);
    stageResults['verification'] = { success: false, error: msg };
  }

  // ── 결과 저장 ──
  const endedAt = new Date().toISOString();
  writeResult(startedAt, testMarket, stageResults, stageTimings, errors);

  // ── 최종 요약 ──
  separator('통합 테스트 결과 요약');
  const stages = ['account_init', 'api_connect', 'market_analysis', 'technical_analysis', 'judgment', 'risk_check', 'execution', 'verification'];
  let passCount = 0;
  let failCount = 0;
  for (const s of stages) {
    const r = stageResults[s] as Record<string, unknown> | undefined;
    const ok = r?.success === true;
    if (ok) passCount++; else failCount++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s} ${stageTimings[s] ? `(${stageTimings[s]}ms)` : ''}`);
  }
  console.log(`\n  통과: ${passCount} / 실패: ${failCount} / 총: ${stages.length}`);
  console.log(`  결과 파일: ${RESULT_FILE}`);

  if (errors.length > 0) {
    console.log(`\n  에러:`);
    for (const e of errors) console.log(`    - ${e}`);
  }

  console.log(`\n  소요 시간: ${Date.now() - new Date(startedAt).getTime()}ms`);
  console.log('');
}

function writeResult(
  startedAt: string,
  market: string,
  stages: Record<string, unknown>,
  timings: Record<string, number>,
  errors: string[],
) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const result = {
    testName: '1차 통합 리뷰: 핵심 엔진 검증',
    market,
    startedAt,
    endedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - new Date(startedAt).getTime(),
    stages,
    timings,
    errors,
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf-8');
}

main().catch((err) => {
  console.error('통합 테스트 예기치 않은 에러:', err);
  process.exit(1);
});
