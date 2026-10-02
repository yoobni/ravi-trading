/**
 * 15분봉 2년치 수집 (2026-10-02) — 실시간 감시·지정가 진입 같은 "봉 내부" 메커니즘을 시뮬하려면
 * 1h 는 거칠다. 28코인 × 2024-10-01 ~ 현재. 결과: data/candle-cache/{m}_15m_2024-10-01_{오늘}.json
 * 이어받기: 이미 파일이 있으면 그 코인은 건너뛴다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FROM = Date.UTC(2024, 9, 1);
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/** 라이브 tick(KST 정각 00/04/…/20시, 최대 ~2분)과 시세 API 한도를 나눠 쓰지 않게 그 앞뒤엔 쉰다. */
async function yieldToLiveTicks() {
  for (;;) {
    const k = new Date(Date.now() + 9 * 3600_000);
    const h = k.getUTCHours(), mi = k.getUTCMinutes();
    const near = (h % 4 === 3 && mi >= 58) || (h % 4 === 0 && mi < 4);
    if (!near) return;
    await new Promise(r => setTimeout(r, 20_000));
  }
}

(async () => {
  const client = getUpbitClient();
  for (const m of COINS) {
    const out = path.join(DIR, `${m}_15m_2024-10-01_${today}.json`);
    if (fs.existsSync(out)) { console.log(`${m} skip`); continue; }
    const acc: any[] = [];
    let to: string | undefined;
    for (;;) {
      await yieldToLiveTicks();
      let page: any[] = [];
      for (let tries = 0; tries < 5; tries++) {
        try { page = await client.getCandlesMinutes(15, m, 200, to); break; }
        catch { await new Promise(r => setTimeout(r, 1500 * (tries + 1))); }
      }
      if (!page.length) break;
      acc.push(...page);
      const oldest = page[page.length - 1];
      to = oldest.candle_date_time_utc;
      if (new Date(oldest.candle_date_time_utc + 'Z').getTime() <= FROM) break;
      await new Promise(r => setTimeout(r, 130));
    }
    const seen = new Set<number>();
    const bars = acc.map(c => ({
      ts: new Date(c.candle_date_time_utc + 'Z').getTime(), date: c.candle_date_time_kst,
      open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume,
    })).filter(b => b.ts >= FROM && (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(out, JSON.stringify(bars));
    console.log(`${m} ${bars.length} bars ${new Date(bars[0].ts).toISOString().slice(0,10)}~${new Date(bars[bars.length-1].ts).toISOString().slice(0,10)}`);
  }
  console.log('DONE');
  process.exit(0);
})();
