/**
 * R30-10A — Upbit 60m fetch.
 *   - 기존 10코인: 2024-06-10 ~ 2025-06-10 (이전 1년 추가)
 *   - 새 5코인 (MATIC, NEAR, ATOM, TRX, SAND): 2024-06-10 ~ 2026-06-10 (2년)
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';

const EXISTING = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH'];
const NEW = ['KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO'];

(async () => {
  // 기존 10코인 — 2024-06-10 ~ 2025-06-10 (이전 1년 추가)
  for (const coin of EXISTING) {
    process.stdout.write(`[${coin}] 60m 2024-06~25-06... `);
    const bars = await fetchMinutesCached(coin, 60, '2024-06-10', '2025-06-10');
    console.log(`${bars.length} bars`);
  }
  // 새 5코인 — 2년 (2024-06-10 ~ 2026-06-10)
  for (const coin of NEW) {
    for (const period of [
      { from: '2024-06-10', to: '2025-06-10' },
      { from: '2025-06-10', to: '2026-06-10' },
    ]) {
      process.stdout.write(`[${coin}] 60m ${period.from}~${period.to}... `);
      const bars = await fetchMinutesCached(coin, 60, period.from, period.to);
      console.log(`${bars.length} bars`);
    }
  }
  console.log('\nDone.');
  process.exit(0);
})();
