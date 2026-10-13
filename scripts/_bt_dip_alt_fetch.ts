/**
 * 축 ALT(저점매수) 데이터 — 바이낸스 현물 USDT 일봉 (업비트 KRW 전 종목 대응, 2019-01~).
 * 일봉 경계 00:00 UTC = 업비트 일봉 경계(KST 09:00) → 동시각 종가로 코인별 프리미엄 계산 가능.
 * 저장: data/research-ext/dip-2026-10/alt/binance-1d/{COIN}.json [[openTime, o, h, l, c, quoteVol]]
 * 예절: 초당 2회 이하. 업비트 API 는 부르지 않는다.
 */
import fs from 'fs';
import path from 'path';
const OUT = path.resolve('data/research-ext/dip-2026-10/alt/binance-1d');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
(async () => {
  const mk: string[] = fs.readdirSync('data/research-ext/daily').filter(f => f.startsWith('KRW-')).map(f => f.slice(4, -5));
  const miss: string[] = [];
  for (const c of mk) {
    const f = path.join(OUT, c + '.json'); if (fs.existsSync(f)) continue;
    const acc: any[] = []; let start = Date.UTC(2019, 0, 1); let bad = false;
    for (;;) {
      await sleep(550);
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${c}USDT&interval=1d&startTime=${start}&limit=1000`);
      if (r.status === 400) { bad = true; break; }
      if (r.status === 429 || r.status === 418) { console.log('rate', r.status); await sleep(60_000); continue; }
      const j: any[] = await r.json();
      for (const k of j) acc.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[7]]);
      if (j.length < 1000) break; start = j[j.length - 1][0] + 86400e3;
    }
    if (bad || !acc.length) { miss.push(c); continue; }
    fs.writeFileSync(f, JSON.stringify(acc)); console.log(c, acc.length);
  }
  fs.writeFileSync(path.join(OUT, '_missing.json'), JSON.stringify(miss));
  console.log('missing', miss.length);
})();
