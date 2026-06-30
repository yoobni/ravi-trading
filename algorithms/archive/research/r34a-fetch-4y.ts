/**
 * R34A fetch — 4h 2022-06-10 ~ 2023-06-10 추가 (4년 완성)
 * 일부 코인 (POL/SUI/APT/TIA/AAVE/ARB) 2022년 미상장 → 빈 데이터 silently skip
 */
import 'dotenv/config';
import { fetchMinutesCached } from '../_candle-cache';

const COINS = [
  'KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH',
  'KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO',
  'KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT',
];

(async () => {
  const ok: string[] = [];
  const thin: string[] = [];
  for (const coin of COINS) {
    process.stdout.write(`[${coin}] 4h 2022-06-10~2023-06-10... `);
    try {
      const bars = await fetchMinutesCached(coin, 240, '2022-06-10', '2023-06-10');
      if (bars.length >= 2000) { console.log(`${bars.length} bars`); ok.push(coin); }
      else { console.log(`THIN (${bars.length})`); thin.push(coin); }
    } catch (e: any) {
      console.log(`FAIL: ${e?.message || e}`);
    }
  }
  console.log(`\n→ OK (2년치 OK): ${ok.length}`);
  console.log(`   ${ok.join(', ')}`);
  console.log(`→ THIN (부분 데이터): ${thin.length}`);
  console.log(`   ${thin.join(', ')}`);
  process.exit(0);
})();
