/**
 * AI 리스크 데스크 리서치 — 외부 데이터: 업비트에서 상폐·유의 지정된 코인(현재 daily/ 에 없음)의 바이낸스 현물 USDT 일봉.
 * 예절: 초당 2회 이하(550ms 간격). 업비트 API 는 부르지 않는다. 결과 캐시: data/research-ext/riskdesk-2026-10/binance-1d-ext/{SYM}.json [[openTime,o,h,l,c,quoteVol]]
 * 주의: 바이낸스 심볼 재사용(LUNA: 구 LUNA 2022-05-13 까지 → 신 LUNA 2022-05-31~) — 가격 불연속은 사용 측에서 상폐일 기준으로 자른다.
 */
import fs from 'fs';
import path from 'path';
const OUT = path.resolve('data/research-ext/riskdesk-2026-10/binance-1d-ext');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ALIAS: Record<string, string> = { LUNA: 'LUNA', FTT: 'FTT', BTT: 'BTTC', MFT: 'MFT' };
(async () => {
  const need: string[] = JSON.parse(fs.readFileSync('data/research-ext/riskdesk-2026-10/need-external.json', 'utf8'));
  const miss: string[] = [];
  for (const c of need) {
    const f = path.join(OUT, c + '.json'); if (fs.existsSync(f)) continue;
    const sym = (ALIAS[c] ?? c) + 'USDT';
    const acc: any[] = []; let start = Date.UTC(2018, 6, 1); let bad = false;
    for (;;) {
      await sleep(550);
      let r: Response;
      try { r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&startTime=${start}&limit=1000`); } catch (e) { console.log('net', c, e); await sleep(5000); continue; }
      if (r.status === 400) { bad = true; break; }
      if (r.status === 429 || r.status === 418) { console.log('rate', r.status); await sleep(60_000); continue; }
      const j: any[] = await r.json();
      for (const k of j) acc.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[7]]);
      if (j.length < 1000) break; start = j[j.length - 1][0] + 86400e3;
    }
    if (bad || !acc.length) { miss.push(c); console.log('missing', c); continue; }
    fs.writeFileSync(f, JSON.stringify(acc)); console.log(c, acc.length, new Date(acc[0][0]).toISOString().slice(0, 10), new Date(acc.at(-1)[0]).toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(OUT, '_missing.json'), JSON.stringify(miss));
  console.log('missing', miss.length, 'of', need.length);
})();
