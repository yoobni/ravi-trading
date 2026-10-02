/**
 * 축 C: 이벤트별 캔들 수집 → data/research-ext/ev-candles/{id}_{sym}.json
 * 업비트 공개 시세 API, 초당 ~3회, 라이브 tick 시각(:58~:03) 회피. 상폐 마켓은 404(생존편향 — 결과에 명시).
 */
import fs from 'fs';
const ev: any[] = JSON.parse(fs.readFileSync('data/research-ext/events.json', 'utf8'));
const DIR = 'data/research-ext/ev-candles'; fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() { for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
  if (!([0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 3)) return; await sleep(20000); } }
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 19);
async function get(unit: number, market: string, toTs: number, pages: number) {
  const out: any[] = []; let to = iso(toTs);
  for (let p = 0; p < pages; p++) {
    await yieldTicks(); await sleep(330);
    let j: any;
    for (let t = 0; t < 4; t++) {
      try { const r = await fetch(`https://api.upbit.com/v1/candles/minutes/${unit}?market=${market}&count=200&to=${to}`); j = await r.json(); if (r.status === 429) { await sleep(2000); continue; } break; } catch { await sleep(1500); }
    }
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j.map((c: any) => ({ ts: Date.parse(c.candle_date_time_utc + 'Z'), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price, v: c.candle_acc_trade_price })));
    to = j[j.length - 1].candle_date_time_utc;
    if (j.length < 200) break;
  }
  return out.sort((a, b) => a.ts - b.ts);
}
(async () => {
  let n = 0;
  for (const e of ev) {
    const f = `${DIR}/${e.id}_${e.sym}.json`; if (fs.existsSync(f)) continue;
    const anchor = e.openTs ?? e.annTs;
    const rec: any = { ...e };
    rec.krw1m = await get(1, `KRW-${e.sym}`, anchor + 4 * 3600e3, 2);
    rec.krw60 = await get(60, `KRW-${e.sym}`, e.annTs + 31 * 86400e3, 4);
    if (e.type === 'LIST_KRW') {
      rec.btc1m = await get(1, `BTC-${e.sym}`, anchor + 3600e3, 2);
      rec.usdt1m = await get(1, `USDT-${e.sym}`, anchor + 3600e3, 2);
    }
    fs.writeFileSync(f, JSON.stringify(rec));
    if (++n % 25 === 0) console.log(n, e.ann.slice(0, 10), e.type, e.sym);
  }
  console.log('DONE', n);
})();
