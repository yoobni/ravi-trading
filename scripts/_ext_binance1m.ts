/** 바이낸스 1분봉 수집 (축 A lead-lag). data/research-ext/binance/{SYM}_1m.json = [[openTime, o, h, l, c, quoteVol], ...] */
import fs from 'fs';
import path from 'path';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const FROM = Date.parse(process.argv[2] || '2026-08-23T15:00:00Z');
const DIR = path.resolve('data/research-ext/binance');
(async () => {
  for (const c of COINS) {
    const out = path.join(DIR, `${c}USDT_1m.json`);
    if (fs.existsSync(out)) { console.log(c, 'skip'); continue; }
    const rows: number[][] = [];
    let t = FROM;
    for (;;) {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${c}USDT&interval=1m&startTime=${t}&limit=1000`);
      if (!r.ok) { console.log(c, 'HTTP', r.status, await r.text()); break; }
      const d: any[] = await r.json();
      if (!d.length) break;
      for (const k of d) rows.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[7]]);
      t = d[d.length - 1][0] + 60_000;
      if (d.length < 1000) break;
      await new Promise(r => setTimeout(r, 120));
    }
    fs.writeFileSync(out, JSON.stringify(rows));
    console.log(c, rows.length);
  }
})();
