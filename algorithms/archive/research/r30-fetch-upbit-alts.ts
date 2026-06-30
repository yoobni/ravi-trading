/**
 * R30 fetch — Upbit 60m candles, 1년 (2025-06-10 ~ 2026-06-10).
 * 알트 10종: BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, BCH
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';

const COINS = [
  'KRW-BTC', 'KRW-ETH', 'KRW-SOL', 'KRW-XRP', 'KRW-ADA',
  'KRW-DOGE', 'KRW-AVAX', 'KRW-LINK', 'KRW-DOT', 'KRW-BCH',
];
const FROM = '2025-06-10';
const TO = '2026-06-10';
const UNIT = 60 as const;

(async () => {
  for (const coin of COINS) {
    process.stdout.write(`[${coin}] fetching 60m ${FROM}~${TO}... `);
    const bars = await fetchMinutesCached(coin, UNIT, FROM, TO);
    console.log(`${bars.length} bars (first=${bars[0]?.date}, last=${bars[bars.length-1]?.date})`);
  }
  console.log('\nDone.');
  process.exit(0);
})();
