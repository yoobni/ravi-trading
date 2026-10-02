/** 축 J: 업비트 KRW-USDT 15분봉 전체 이력 → data/research-ext/upbit-KRW-USDT_15m.json (2026-10-02) */
import 'dotenv/config';
import fs from 'fs';
const OUT = 'data/research-ext/upbit-KRW-USDT_15m.json';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() {
  for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
    const hot = [0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 3;
    if (!hot) return; await sleep(20000); }
}
(async () => {
  const acc: any[] = []; let to: string | undefined;
  for (;;) {
    await yieldTicks();
    const u = `https://api.upbit.com/v1/candles/minutes/15?market=KRW-USDT&count=200${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    let page: any[] = [];
    for (let t = 0; t < 5; t++) { try { const r = await fetch(u); page = await r.json(); if (Array.isArray(page)) break; } catch {} await sleep(1500); }
    if (!Array.isArray(page) || !page.length) break;
    acc.push(...page); to = page[page.length - 1].candle_date_time_utc;
    if (page.length < 200) break;
    await sleep(300);
  }
  const seen = new Set<number>();
  const bars = acc.map(c => ({ ts: new Date(c.candle_date_time_utc + 'Z').getTime(), open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume }))
    .filter(b => seen.has(b.ts) ? false : (seen.add(b.ts), true)).sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(OUT, JSON.stringify(bars));
  console.log('DONE', bars.length, new Date(bars[0].ts).toISOString(), new Date(bars[bars.length - 1].ts).toISOString());
})();
