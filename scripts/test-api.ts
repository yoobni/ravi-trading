/**
 * 업비트 API 연결 테스트 스크립트
 *
 * 테스트 항목:
 * 1. 마켓 코드 조회 (Public)
 * 2. 현재가(Ticker) 조회 (Public)
 * 3. 분봉 캔들 조회 (Public)
 * 4. 일봉 캔들 조회 (Public)
 * 5. 호가(Orderbook) 조회 (Public)
 * 6. 계좌 조회 (Private — JWT 인증)
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/test-api.ts
 */

import 'dotenv/config';
import { UpbitClient } from '@/lib/upbit-client';

// ── helpers ──────────────────────────────────────

function printSection(title: string) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(50));
}

function printResult(label: string, value: unknown) {
  console.log(`  ${label}: ${JSON.stringify(value, null, 2).slice(0, 500)}`);
}

function printOk(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function printFail(msg: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`  ❌ ${msg}: ${message}`);

  if (err instanceof Error && 'response' in err) {
    const axiosErr = err as { response?: { status: number; data: unknown } };
    if (axiosErr.response) {
      console.error(`     HTTP ${axiosErr.response.status}`);
      console.error(`     Body: ${JSON.stringify(axiosErr.response.data).slice(0, 300)}`);
    }
  }
}

// ── main ─────────────────────────────────────────

async function main() {
  console.log('🚀 업비트 API 연결 테스트 시작\n');

  // 클라이언트 초기화
  let client: UpbitClient;
  try {
    client = new UpbitClient();
    printOk('UpbitClient 초기화 성공');
  } catch (err) {
    printFail('UpbitClient 초기화 실패', err);
    process.exit(1);
  }

  const testMarket = 'KRW-BTC';
  let passed = 0;
  let failed = 0;

  // ── 1. 마켓 코드 조회 ──
  printSection('1. 마켓 코드 조회 (GET /market/all)');
  try {
    const markets = await client.getMarkets();
    printOk(`총 ${markets.length}개 마켓 조회 완료`);
    printResult('KRW 마켓 수', markets.filter((m) => m.market.startsWith('KRW-')).length);
    printResult('BTC 마켓 수', markets.filter((m) => m.market.startsWith('BTC-')).length);
    printResult('USDT 마켓 수', markets.filter((m) => m.market.startsWith('USDT-')).length);

    const btc = markets.find((m) => m.market === testMarket);
    if (btc) {
      printResult('KRW-BTC', { market: btc.market, korean_name: btc.korean_name, english_name: btc.english_name });
    }
    passed++;
  } catch (err) {
    printFail('마켓 코드 조회 실패', err);
    failed++;
  }

  // ── 2. 현재가(Ticker) 조회 ──
  printSection('2. 현재가 조회 (GET /ticker)');
  try {
    const tickers = await client.getTicker([testMarket, 'KRW-ETH']);
    for (const t of tickers) {
      printResult(t.market, {
        trade_price: t.trade_price.toLocaleString(),
        change: t.change,
        change_rate: `${(t.change_rate * 100).toFixed(2)}%`,
        acc_trade_price_24h: `${(t.acc_trade_price_24h / 1_000_000_000).toFixed(1)}B`,
      });
    }
    printOk(`${tickers.length}개 티커 조회 완료`);
    passed++;
  } catch (err) {
    printFail('현재가 조회 실패', err);
    failed++;
  }

  // ── 3. 분봉 캔들 조회 ──
  printSection('3. 5분봉 캔들 조회 (GET /candles/minutes/5)');
  try {
    const candles = await client.getCandlesMinutes(5, testMarket, 5);
    printOk(`${candles.length}개 캔들 조회 완료`);
    for (const c of candles) {
      printResult(c.candle_date_time_kst, {
        open: c.opening_price.toLocaleString(),
        high: c.high_price.toLocaleString(),
        low: c.low_price.toLocaleString(),
        close: c.trade_price.toLocaleString(),
        volume: c.candle_acc_trade_volume.toFixed(4),
      });
    }

    // 응답 형식 검증
    const first = candles[0];
    const requiredFields = ['market', 'opening_price', 'high_price', 'low_price', 'trade_price', 'candle_acc_trade_volume'];
    const missing = requiredFields.filter((f) => !(f in first));
    if (missing.length > 0) {
      printFail(`캔들 응답에 누락 필드: ${missing.join(', ')}`, new Error('schema mismatch'));
      failed++;
    } else {
      printOk('캔들 응답 스키마 정상');
      passed++;
    }
  } catch (err) {
    printFail('분봉 캔들 조회 실패', err);
    failed++;
  }

  // ── 4. 일봉 캔들 조회 ──
  printSection('4. 일봉 캔들 조회 (GET /candles/days)');
  try {
    const days = await client.getCandlesDays(testMarket, 3);
    printOk(`${days.length}개 일봉 조회 완료`);
    for (const d of days) {
      printResult(d.candle_date_time_kst.slice(0, 10), {
        open: d.opening_price.toLocaleString(),
        close: d.trade_price.toLocaleString(),
        change_rate: `${(d.change_rate * 100).toFixed(2)}%`,
      });
    }
    passed++;
  } catch (err) {
    printFail('일봉 캔들 조회 실패', err);
    failed++;
  }

  // ── 5. 호가(Orderbook) 조회 ──
  printSection('5. 호가 조회 (GET /orderbook)');
  try {
    const books = await client.getOrderbook([testMarket]);
    const book = books[0];
    printOk(`${book.market} 호가 조회 완료`);
    printResult('매도 총량', book.total_ask_size.toFixed(4));
    printResult('매수 총량', book.total_bid_size.toFixed(4));
    printResult('호가 단위 수', book.orderbook_units.length);

    const best = book.orderbook_units[0];
    printResult('최우선 매도', { price: best.ask_price.toLocaleString(), size: best.ask_size.toFixed(4) });
    printResult('최우선 매수', { price: best.bid_price.toLocaleString(), size: best.bid_size.toFixed(4) });
    passed++;
  } catch (err) {
    printFail('호가 조회 실패', err);
    failed++;
  }

  // ── 6. 계좌 조회 (Private) ──
  printSection('6. 계좌 조회 (GET /accounts) — JWT 인증');
  try {
    const accounts = await client.getAccounts();
    printOk(`${accounts.length}개 계좌 조회 완료`);
    for (const a of accounts) {
      printResult(a.currency, {
        balance: a.balance,
        locked: a.locked,
        avg_buy_price: a.avg_buy_price,
        unit_currency: a.unit_currency,
      });
    }
    passed++;
  } catch (err) {
    printFail('계좌 조회 실패 (API 키/권한 확인 필요)', err);
    failed++;
  }

  // ── 결과 요약 ──
  printSection('테스트 결과 요약');
  console.log(`  통과: ${passed}  |  실패: ${failed}  |  총: ${passed + failed}`);

  if (failed > 0) {
    console.log('\n⚠️  일부 테스트 실패. 위 에러 메시지를 확인하세요.');
    process.exit(1);
  } else {
    console.log('\n🎉 모든 API 연결 테스트 통과!');
  }
}

main();
