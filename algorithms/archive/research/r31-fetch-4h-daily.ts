/**
 * R31 fetch — Upbit 4h + daily 데이터, 15코인, 2년치.
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';
import { fetchDailyCached } from '../_daily-cache';

const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO'];

(async () => {
  // 4h (240m)
  for (const coin of COINS) {
    for (const period of [
      { from: '2024-06-10', to: '2025-06-10' },
      { from: '2025-06-10', to: '2026-06-10' },
    ]) {
      process.stdout.write(`[${coin}] 4h ${period.from}~${period.to}... `);
      const bars = await fetchMinutesCached(coin, 240, period.from, period.to);
      console.log(`${bars.length} bars`);
    }
  }
  // Daily — 800d (2 years buffer)
  for (const coin of COINS) {
    process.stdout.write(`[${coin}] daily 800d... `);
    const bars = await fetchDailyCached(coin, 800, '2026-06-11');
    console.log(`${bars.length} bars`);
  }
  console.log('Done');
  process.exit(0);
})();
