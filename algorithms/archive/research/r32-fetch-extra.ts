/**
 * R32 fetch — 4h 2023-06-10 ~ 2024-06-10 (15코인) 추가.
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';

const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO'];

(async () => {
  for (const coin of COINS) {
    process.stdout.write(`[${coin}] 4h 2023-06-10~2024-06-10... `);
    try {
      const bars = await fetchMinutesCached(coin, 240, '2023-06-10', '2024-06-10');
      console.log(`${bars.length} bars`);
    } catch (e: any) {
      console.log(`FAIL: ${e?.message || e}`);
    }
  }
  console.log('Done');
  process.exit(0);
})();
