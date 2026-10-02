/**
 * 축 E 데이터 — 업비트 KRW 마켓 전 종목 일봉 전체 이력 (2026-10-02).
 * 저장: data/research-ext/daily/{market}.json  [{ts,date,open,high,low,close,volume,value}]  ts=UTC ms(일봉 시작 = KST 09시)
 * 현재 상장 종목만 받을 수 있다(상폐 종목은 market/all 에 없음) → 생존편향 있음.
 * API 예절: 초당 ≤4회, 라이브 tick 시각(KST 01/05/09/11/13/17/21시 :58~:03) 회피.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
const OUT = path.resolve(process.cwd(), 'data/research-ext/daily');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() {
  for (;;) {
    const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
    const nextH = (h + 1) % 24;
    const near = (m >= 58 && [1, 5, 9, 11, 13, 17, 21].includes(nextH)) || (m < 4 && [1, 5, 9, 11, 13, 17, 21].includes(h));
    if (!near) return; await sleep(20_000);
  }
}
(async () => {
  const c = getUpbitClient();
  const mk = (await c.getMarkets(false)).map((x: any) => x.market).filter((m: string) => m.startsWith('KRW-'));
  fs.writeFileSync(path.join(OUT, '_markets.json'), JSON.stringify(mk));
  console.log('KRW markets', mk.length);
  for (const m of mk) {
    const f = path.join(OUT, `${m}.json`); if (fs.existsSync(f)) continue;
    const acc: any[] = []; let to: string | undefined;
    for (;;) {
      await yieldTicks();
      let page: any[] = [];
      for (let t = 0; t < 5; t++) { try { page = await c.getCandlesDays(m, 200, to); break; } catch { await sleep(1500 * (t + 1)); } }
      await sleep(260);
      if (!page.length) break;
      acc.push(...page); to = page[page.length - 1].candle_date_time_utc;
      if (page.length < 200) break;
    }
    const seen = new Set<number>();
    const bars = acc.map(x => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), date: x.candle_date_time_kst.slice(0, 10),
      open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, volume: x.candle_acc_trade_volume, value: x.candle_acc_trade_price }))
      .filter(b => seen.has(b.ts) ? false : (seen.add(b.ts), true)).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(f, JSON.stringify(bars));
    console.log(m, bars.length, bars[0]?.date);
  }
  console.log('DONE'); process.exit(0);
})();
