/**
 * candle-cache 최신화 — 기존 캐시 파일의 마지막 봉 이후만 받아서 이어붙인다.
 *
 * data/candle-cache/{market}_{unit}m_{from}_{to}.json 중 가장 긴 파일을 기준으로,
 * 마지막 ts 이후 구간만 Upbit 에서 받아 병합하고 `{from}_{오늘}` 이름으로 새로 저장한다.
 * (_bt_* 스크립트들이 "가장 긴 파일"을 고르므로 새 파일이 자동으로 선택된다.)
 *
 * 실행: npx tsx scripts/_bt_cache-extend.ts [240|60] ...   (기본: 240 60)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];

const UNITS = (() => {
  const args = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  return args.length ? args : [240, 60];
})();

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number }

const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/** 해당 market/unit 의 가장 긴 캐시 파일 */
function longestCache(market: string, unit: number) {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(`${market}_${unit}m_`) && f.endsWith('.json'));
  let best: { file: string; bars: Bar[] } | null = null;
  for (const f of files) {
    const bars = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    if (!best || bars.length > best.bars.length) best = { file: f, bars };
  }
  return best;
}

async function extend(market: string, unit: number) {
  const cur = longestCache(market, unit);
  if (!cur) { console.log(`  [${market} ${unit}m] 기존 캐시 없음 — skip`); return; }
  const from = cur.file.split('_')[2];
  const lastTs = cur.bars[cur.bars.length - 1].ts;
  if (todayKst <= cur.file.split('_')[3].replace('.json', '')) {
    console.log(`  [${market} ${unit}m] 이미 최신 (${cur.file.split('_')[3].replace('.json', '')})`);
    return;
  }

  const client = getUpbitClient();
  const fetched: any[] = [];
  let to: string | undefined = undefined;
  for (let page = 0; page < 200; page++) {
    const candles = await client.getCandlesMinutes(unit as 60 | 240, market, 200, to);
    if (!candles.length) break;
    fetched.push(...candles);
    const oldest = candles[candles.length - 1] as any;
    const oldestTs = new Date(oldest.candle_date_time_utc + 'Z').getTime();
    if (oldestTs <= lastTs) break;
    to = oldest.candle_date_time_utc;
    await new Promise((r) => setTimeout(r, 110));
  }

  const newBars: Bar[] = fetched.map((c: any) => ({
    // ts 는 UTC ms. 예전에는 candle_date_time_kst 를 로컬 파싱해 같은 값을 얻었으나,
    // 그건 기계의 TZ 가 Asia/Seoul 일 때만 맞다(CI·서버에서 9시간 어긋난다).
    // candle_date_time_utc 를 명시적으로 쓴다 — 기존 캐시와 동일한 값이 나온다.
    ts: new Date(c.candle_date_time_utc + 'Z').getTime(),
    date: c.candle_date_time_kst.slice(0, 16),
    open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
    volume: c.candle_acc_trade_volume,
  })).filter((b) => b.ts > lastTs);

  const merged = [...cur.bars, ...newBars];
  const seen = new Set<number>();
  const dedup = merged.filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);

  const outFile = path.join(DIR, `${market}_${unit}m_${from}_${todayKst}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dedup));
  const last = dedup[dedup.length - 1];
  console.log(`  [${market} ${unit}m] +${newBars.length}봉 → ${dedup.length}봉 (마지막 ${last.date}) → ${path.basename(outFile)}`);
}

(async () => {
  console.log(`=== candle-cache 최신화 → ${todayKst} (units: ${UNITS.join(', ')}) ===`);
  for (const unit of UNITS) {
    console.log(`\n── ${unit}m`);
    for (const m of COINS) {
      try { await extend(m, unit); } catch (e: unknown) { console.log(`  [${m} ${unit}m] FAIL ${(e as Error)?.message ?? e}`); }
    }
  }
  console.log('\n=== 완료 ===');
  process.exit(0);
})();
