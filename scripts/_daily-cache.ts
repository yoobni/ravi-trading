/**
 * 일봉 데이터 캐싱 유틸.
 */
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');

export interface DailyBar {
  ts: number;
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

function cachePath(market: string, totalDays: number, asOf: string): string {
  return path.join(CACHE_DIR, `${market}_daily_${totalDays}d_asof_${asOf}.json`);
}

export async function fetchDailyCached(market: string, totalDays: number, asOf?: string): Promise<DailyBar[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const cp = cachePath(market, totalDays, today);
  if (fs.existsSync(cp)) {
    return JSON.parse(fs.readFileSync(cp, 'utf-8')) as DailyBar[];
  }

  const client = getUpbitClient();
  const all: any[] = [];
  let to: string | undefined = undefined;
  while (all.length < totalDays) {
    const count = Math.min(200, totalDays - all.length);
    const candles = await client.getCandlesDays(market, count, to);
    if (candles.length === 0) break;
    all.push(...candles);
    to = candles[candles.length - 1].candle_date_time_utc;
    await new Promise((r) => setTimeout(r, 110));
  }
  const seen = new Set<number>();
  const dedup = all.filter((c) => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; });
  const sorted = dedup.sort((a, b) => a.timestamp - b.timestamp);
  const bars: DailyBar[] = sorted.map((c) => ({
    ts: new Date(c.candle_date_time_kst).getTime(),
    date: c.candle_date_time_kst.slice(0, 10),
    open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
    volume: c.candle_acc_trade_volume,
  }));

  fs.writeFileSync(cp, JSON.stringify(bars));
  return bars;
}
