/**
 * 매수 실행 경로 강제 검증
 *
 * 알고리즘이 hold 판단을 내려도, 매수→기록→잔고차감→포지션생성 경로가
 * 정상 동작하는지 검증하기 위해 소액(50,000원)으로 강제 매수 1회 실행.
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/verify-buy-path.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { UpbitClient } from '@/lib/upbit-client';
import { analyze as technicalAnalyze } from '@/lib/indicators';
import {
  executeBuy,
  executeSell,
  loadBalance,
  getBalanceSummary,
} from '@/lib/paper-trading-engine';
import { getOpenPositions, listOrders } from '@/lib/order-store';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RESULT_FILE = path.join(DATA_DIR, 'verify-buy-path-result.json');

function log(stage: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${stage}] ${msg}`);
}

async function main() {
  const market = 'KRW-BTC';
  const result: Record<string, unknown> = {};
  const startedAt = new Date().toISOString();

  console.log('\n========================================');
  console.log('  매수→매도 실행 경로 강제 검증');
  console.log(`  대상: ${market} / 매수 금액: 50,000원`);
  console.log('========================================\n');

  // 1. 현재가 조회
  const client = new UpbitClient();
  const candles = await client.getCandlesMinutes(5, market, 30);
  const currentPrice = candles[0].trade_price;
  log('시세', `${market} 현재가: ${currentPrice.toLocaleString()}원`);

  // 2. 기술 분석 (기록용)
  const ta = technicalAnalyze(candles);
  const rsi = ta.rsi.values.find((v: number | null) => v !== null);
  log('분석', `RSI: ${rsi?.toFixed(1) ?? 'N/A'}, 거래량비율: ${ta.volume.volumeRatio.toFixed(2)}x`);

  // 3. 매수 전 잔고
  const balanceBefore = loadBalance();
  log('잔고', `매수 전: ${getBalanceSummary()}`);
  result['balanceBefore'] = { cash: balanceBefore.cash, holdings: balanceBefore.holdings.length };

  // 4. 강제 매수 (50,000원)
  const buyAmount = 50_000;
  const reasoning = '[검증용] 매수 경로 강제 테스트 — 실제 판단 아님';
  log('매수', `모의 매수 실행: ${buyAmount.toLocaleString()}원`);

  const buyResult = executeBuy(market, currentPrice, buyAmount, reasoning);

  if (buyResult.success) {
    log('매수', `체결 성공`);
    log('매수', `  체결가: ${buyResult.executedPrice.toLocaleString()}원`);
    log('매수', `  수수료: ${buyResult.feeAmount.toLocaleString()}원`);
    log('매수', `  결제총액: ${buyResult.totalSettlement.toLocaleString()}원`);
    log('매수', `  잔여 현금: ${buyResult.cashAfter.toLocaleString()}원`);
    log('매수', `  주문ID: ${buyResult.order?.id}`);
  } else {
    log('매수', `체결 실패: ${buyResult.reason}`);
  }

  result['buy'] = {
    success: buyResult.success,
    executedPrice: buyResult.executedPrice,
    feeAmount: buyResult.feeAmount,
    totalSettlement: buyResult.totalSettlement,
    cashAfter: buyResult.cashAfter,
    orderId: buyResult.order?.id ?? null,
    reason: buyResult.reason,
  };

  // 5. 매수 후 잔고 & 포지션 확인
  const balanceAfterBuy = loadBalance();
  const positions = getOpenPositions(market);
  log('잔고', `매수 후: ${getBalanceSummary()}`);
  log('포지션', `${market} 오픈 포지션: ${positions.length}건`);

  result['balanceAfterBuy'] = {
    cash: balanceAfterBuy.cash,
    holdings: balanceAfterBuy.holdings.length,
  };
  result['positionAfterBuy'] = positions.length;

  // 6. 즉시 매도 (경로 검증)
  if (buyResult.success && buyResult.order) {
    log('매도', `즉시 매도 실행 (경로 검증)`);
    const sellResult = executeSell(buyResult.order.id, currentPrice, '[검증용] 매도 경로 테스트');

    if (sellResult.success) {
      log('매도', `체결 성공`);
      log('매도', `  체결가: ${sellResult.executedPrice.toLocaleString()}원`);
      log('매도', `  수수료: ${sellResult.feeAmount.toLocaleString()}원`);
      log('매도', `  수령액: ${sellResult.totalSettlement.toLocaleString()}원`);
      log('매도', `  잔여 현금: ${sellResult.cashAfter.toLocaleString()}원`);
    } else {
      log('매도', `체결 실패: ${sellResult.reason}`);
    }

    result['sell'] = {
      success: sellResult.success,
      executedPrice: sellResult.executedPrice,
      feeAmount: sellResult.feeAmount,
      totalSettlement: sellResult.totalSettlement,
      cashAfter: sellResult.cashAfter,
      reason: sellResult.reason,
    };

    // 매도 후 잔고
    const balanceAfterSell = loadBalance();
    log('잔고', `매도 후: ${getBalanceSummary()}`);
    result['balanceAfterSell'] = {
      cash: balanceAfterSell.cash,
      holdings: balanceAfterSell.holdings.length,
    };
  }

  // 7. 주문 기록 확인
  const recentOrders = listOrders({ limit: 5 });
  log('기록', `최근 주문 ${recentOrders.length}건:`);
  for (const o of recentOrders.slice(0, 4)) {
    log('기록', `  ${o.side.toUpperCase()} ${o.market} @ ${o.price.toLocaleString()}원 × ${o.volume.toFixed(8)} (${o.status})`);
  }
  result['recentOrders'] = recentOrders.slice(0, 4).map(o => ({
    side: o.side,
    market: o.market,
    price: o.price,
    volume: o.volume,
    status: o.status,
    reasoning: o.reasoning,
  }));

  // 8. 결과 저장
  const endedAt = new Date().toISOString();
  const fullResult = {
    testName: '매수→매도 실행 경로 강제 검증',
    market,
    startedAt,
    endedAt,
    durationMs: Date.now() - new Date(startedAt).getTime(),
    currentPrice,
    result,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(fullResult, null, 2), 'utf-8');

  console.log(`\n결과 파일: ${RESULT_FILE}`);

  // 최종 판정
  const buyOk = (result['buy'] as Record<string, unknown>)?.success === true;
  const sellOk = (result['sell'] as Record<string, unknown>)?.success === true;
  console.log(`\n  매수 경로: ${buyOk ? 'PASS' : 'FAIL'}`);
  console.log(`  매도 경로: ${sellOk ? 'PASS' : 'FAIL'}`);
  console.log(`  JSON 기록: ${recentOrders.length > 0 ? 'PASS' : 'FAIL'}`);
  console.log('');
}

main().catch(err => {
  console.error('검증 에러:', err);
  process.exit(1);
});
