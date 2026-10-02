/** 축 L: 업비트 KRW-BTC 1h 2018-01~ 수집 → data/research-ext/macro/KRW-BTC_60m.json (라이브 tick 시각 회피, 초당 ≤4) */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
const OUT = 'data/research-ext/macro/KRW-BTC_60m.json';
const FROM = Date.UTC(2018, 0, 1);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() {
  for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
    const hot = [0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 4;
    if (!hot) return; await sleep(20000); }
}
(async () => {
  const acc: any[] = []; let to: string | undefined;
  for (;;) {
    await yieldTicks();
    let page: any[] = [];
    for (let t = 0; t < 5; t++) { try { page = await getUpbitClient().getCandlesMinutes(60, 'KRW-BTC', 200, to); break; } catch { await sleep(2000 * (t + 1)); } }
    if (!page.length) break;
    acc.push(...page);
    const o = page[page.length - 1]; to = o.candle_date_time_utc;
    if (new Date(o.candle_date_time_utc + 'Z').getTime() <= FROM) break;
    await sleep(260);
  }
  const seen = new Set<number>();
  const bars = acc.map(c => ({ ts: new Date(c.candle_date_time_utc + 'Z').getTime(), open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume }))
    .filter(b => b.ts >= FROM && (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(OUT, JSON.stringify(bars));
  console.log('DONE', bars.length, new Date(bars[0].ts).toISOString(), new Date(bars[bars.length - 1].ts).toISOString());
  process.exit(0);
})();
