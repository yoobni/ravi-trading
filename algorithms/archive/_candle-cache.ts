/**
 * 캔들 데이터 캐싱 유틸 — 재실행 시 fetch 스킵.
 */
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');

export interface CachedBar {
  ts: number;
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

function cachePath(market: string, unit: number, fromDate: string, toDate: string): string {
  return path.join(CACHE_DIR, `${market}_${unit}m_${fromDate}_${toDate}.json`);
}

export async function fetchMinutesCached(
  market: string,
  unit: 1 | 3 | 5 | 15 | 30 | 60 | 240,
  fromDate: string,
  toDate: string,
): Promise<CachedBar[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cp = cachePath(market, unit, fromDate, toDate);
  if (fs.existsSync(cp)) {
    const data = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    return data as CachedBar[];
  }

  const client = getUpbitClient();
  const all: any[] = [];
  let to: string | undefined = `${toDate}T23:59:59`;
  const fromTs = new Date(fromDate + 'T00:00:00').getTime();
  let safety = 10000;
  while (safety-- > 0) {
    const candles = await client.getCandlesMinutes(unit, market, 200, to);
    if (candles.length === 0) break;
    all.push(...candles);
    const oldest = candles[candles.length - 1];
    const oldestTs = new Date(oldest.candle_date_time_utc + 'Z').getTime();
    if (oldestTs < fromTs) break;
    to = oldest.candle_date_time_utc;
    await new Promise((r) => setTimeout(r, 110));
  }
  const seen = new Set<number>();
  const dedup = all.filter((c) => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; });
  const sorted = dedup.sort((a, b) => a.timestamp - b.timestamp);
  const bars: CachedBar[] = sorted.map((c) => ({
    ts: new Date(c.candle_date_time_kst).getTime(),
    date: c.candle_date_time_kst.slice(0, 16),
    open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
    volume: c.candle_acc_trade_volume,
  })).filter((b) => {
    const d = b.date.slice(0, 10);
    return d >= fromDate && d <= toDate;
  });

  fs.writeFileSync(cp, JSON.stringify(bars));
  return bars;
}
