/** KRW-BTC 15m 2021-01-01 ~ 2024-10-01 수집 (축 K, 2026-10-02) — 기존 2024-10~ 캐시와 합쳐 data/research-ext/btc15m.json */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
const FROM = Date.UTC(2021, 0, 1), TO_UTC = '2024-10-01T00:00:00';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() { for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
  const hot = ([0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58) || ([1, 5, 9, 11, 13, 17, 21].includes(h) && m < 4); if (!hot) return; await sleep(20000); } }
(async () => {
  const c = getUpbitClient(); const acc: any[] = []; let to: string | undefined = TO_UTC;
  for (;;) {
    await yieldTicks();
    let page: any[] = [];
    for (let t = 0; t < 5; t++) { try { page = await c.getCandlesMinutes(15, 'KRW-BTC', 200, to); break; } catch { await sleep(1500 * (t + 1)); } }
    if (!page.length) break; acc.push(...page); to = page[page.length - 1].candle_date_time_utc;
    if (new Date(to + 'Z').getTime() <= FROM) break; await sleep(260);
  }
  const old = acc.map(x => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, volume: x.candle_acc_trade_volume }))
    .filter(b => b.ts >= FROM);
  const cur = JSON.parse(fs.readFileSync('data/candle-cache/KRW-BTC_15m_2024-10-01_2026-10-02.json', 'utf8'));
  const seen = new Set<number>(); const all = [...old, ...cur].filter((b: any) => seen.has(b.ts) ? false : (seen.add(b.ts), true)).sort((a: any, b: any) => a.ts - b.ts);
  fs.mkdirSync('data/research-ext', { recursive: true });
  fs.writeFileSync('data/research-ext/btc15m.json', JSON.stringify(all.map((b: any) => [b.ts, b.open, b.high, b.low, b.close, b.volume])));
  console.log('DONE', all.length, new Date(all[0].ts).toISOString(), new Date(all[all.length - 1].ts).toISOString());
  process.exit(0);
})();
