/** 축 C (b'): KRW 개시 무렵 KRW-BTC / KRW-USDT 1분봉 → data/research-ext/ev-fx.json */
import fs from 'fs';
const B = JSON.parse(fs.readFileSync('data/research-ext/eventB.json', 'utf8'));
const ev = JSON.parse(fs.readFileSync('data/research-ext/events.json', 'utf8'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() { for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
  if (!([0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 3)) return; await sleep(20000); } }
(async () => {
  const out: Record<string, any[]> = {};
  const keys = new Set<string>();
  for (const b of B) { const e = ev.find((x: any) => x.sym === b.sym && x.annTs === b.ts); const anchor = (e?.openTs ?? b.ts + b.gapMin * 60e3); keys.add(`${b.mk}|${anchor}`); }
  for (const k of keys) {
    const [mk, a] = k.split('|'); const to = new Date(+a + 90 * 60e3).toISOString().slice(0, 19);
    await yieldTicks(); await sleep(350);
    const j = await (await fetch(`https://api.upbit.com/v1/candles/minutes/1?market=KRW-${mk}&count=200&to=${to}`)).json();
    out[k] = Array.isArray(j) ? j.map((c: any) => ({ ts: Date.parse(c.candle_date_time_utc + 'Z'), o: c.opening_price, c: c.trade_price })).sort((x: any, y: any) => x.ts - y.ts) : [];
  }
  fs.writeFileSync('data/research-ext/ev-fx.json', JSON.stringify(out)); console.log('DONE', Object.keys(out).length);
})();
