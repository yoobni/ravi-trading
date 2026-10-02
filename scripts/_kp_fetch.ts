/**
 * 김치 프리미엄 리서치 데이터 수집 (2026-10-02) → data/research-ext/
 *   fx-usdkrw.json        : 원/달러 일별 (frankfurter, ECB 영업일)
 *   upbit-KRW-USDT_240m.json : 업비트 USDT 4h (2022-06~)
 *   binance-{SYM}_240m.json  : 바이낸스 USDT 4h (2022-06~) — POL 은 2024-09 이전 MATICUSDT 이어붙임
 * 업비트 호출은 초당 ~3회, 라이브 tick 시각(:58~:03 of KST 01/05/09/11/13/17/21시) 회피.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
const OUT = path.resolve(process.cwd(), 'data', 'research-ext');
const FROM = Date.UTC(2022, 5, 1);
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() {
  for (;;) {
    const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), mi = k.getUTCMinutes();
    const nextH = (h + 1) % 24;
    const near = ([1,5,9,11,13,17,21].includes(nextH) && mi >= 58) || ([1,5,9,11,13,17,21].includes(h) && mi < 4);
    if (!near) return; await sleep(20_000);
  }
}
async function binance(sym: string, start: number, end = Date.now()) {
  const out: any[] = []; let s = start;
  while (s < end) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=4h&startTime=${s}&limit=1000`;
    const r = await fetch(url); if (!r.ok) { console.log(sym, r.status); break; }
    const d: any[] = await r.json(); if (!d.length) break;
    out.push(...d); s = d[d.length - 1][0] + 4 * 3600e3; await sleep(250);
    if (d.length < 1000) break;
  }
  return out.map(k => ({ ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quote: +k[7] }));
}
(async () => {
  // FX
  const fxf = path.join(OUT, 'fx-usdkrw.json');
  if (!fs.existsSync(fxf)) {
    const r = await fetch('https://api.frankfurter.app/2022-05-01..?from=USD&to=KRW', { redirect: 'follow' });
    const j: any = await r.json();
    const rates = Object.fromEntries(Object.entries(j.rates).map(([d, v]: any) => [d, v.KRW]));
    fs.writeFileSync(fxf, JSON.stringify(rates)); console.log('fx', Object.keys(rates).length);
  }
  // Binance
  for (const c of COINS) {
    const f = path.join(OUT, `binance-${c}_240m.json`); if (fs.existsSync(f)) continue;
    let bars: any[];
    if (c === 'POL') {
      const a = await binance('MATICUSDT', FROM); const b = await binance('POLUSDT', FROM);
      const firstPol = b.length ? b[0].ts : Infinity;
      bars = [...a.filter(x => x.ts < firstPol), ...b];
    } else bars = await binance(`${c}USDT`, FROM);
    fs.writeFileSync(f, JSON.stringify(bars)); console.log('binance', c, bars.length, bars[0] && new Date(bars[0].ts).toISOString().slice(0, 10));
  }
  // Upbit KRW-USDT 4h
  const uf = path.join(OUT, 'upbit-KRW-USDT_240m.json');
  if (!fs.existsSync(uf)) {
    const client = getUpbitClient(); const acc: any[] = []; let to: string | undefined;
    for (;;) {
      await yieldTicks();
      const page = await client.getCandlesMinutes(240, 'KRW-USDT', 200, to);
      if (!page.length) break; acc.push(...page);
      const o: any = page[page.length - 1]; to = o.candle_date_time_utc;
      if (new Date(o.candle_date_time_utc + 'Z').getTime() <= FROM) break;
      await sleep(350);
    }
    const seen = new Set<number>();
    const bars = acc.map((c: any) => ({ ts: new Date(c.candle_date_time_utc + 'Z').getTime(), open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume }))
      .filter(b => b.ts >= FROM && (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(uf, JSON.stringify(bars)); console.log('upbit usdt', bars.length);
  }
  console.log('DONE'); process.exit(0);
})();
