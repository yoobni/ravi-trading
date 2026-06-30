/**
 * R33 fetch — Upbit 메이저 알트 추가 (4h, 2024-06 ~ 2026-06).
 * 신규 상장이라 데이터 부족할 수 있으면 silently skip.
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';

const ADD = [
  'KRW-ETC','KRW-EOS','KRW-XLM','KRW-AAVE','KRW-ARB',
  'KRW-APT','KRW-OP','KRW-SUI','KRW-GRT','KRW-INJ',
  'KRW-IMX','KRW-TIA','KRW-SAND','KRW-MANA','KRW-CHZ',
  'KRW-FIL','KRW-AXS','KRW-FLOW','KRW-ETC','KRW-BAT',
];

(async () => {
  const ok: string[] = [];
  const fail: string[] = [];
  for (const coin of ADD) {
    for (const period of [
      { from: '2024-06-10', to: '2025-06-10' },
      { from: '2025-06-10', to: '2026-06-10' },
    ]) {
      process.stdout.write(`[${coin}] 4h ${period.from}~${period.to}... `);
      try {
        const bars = await fetchMinutesCached(coin, 240, period.from, period.to);
        if (bars.length < 2000) { console.log(`THIN (${bars.length})`); }
        else { console.log(`${bars.length} bars`); }
        if (period.to === '2026-06-10' && bars.length >= 2000) ok.push(coin);
      } catch (e: any) {
        console.log(`FAIL: ${e?.message || e}`);
        fail.push(coin);
      }
    }
  }
  console.log(`\n→ OK: ${ok.join(', ')}`);
  console.log(`→ FAIL: ${fail.join(', ')}`);
  process.exit(0);
})();
