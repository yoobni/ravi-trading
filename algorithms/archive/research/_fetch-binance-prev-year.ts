/**
 * Binance BTCUSDT perp 이전 1년 fetch (2024-06-09 ~ 2025-06-09) for walk-forward.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const START = '2024-06-09';
const END = '2025-06-09';
const SYMBOL = 'BTCUSDT';

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlines(interval: string, startMs: number, endMs: number, label: string): Promise<Bar[]> {
  const all: Bar[] = [];
  let cur = startMs;
  let req = 0;
  while (cur < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${cur}&limit=1500`;
    let data: any[][];
    try {
      const res = await axios.get<any[][]>(url);
      data = res.data;
    } catch (e: any) {
      if (e?.response?.status === 429 || e?.response?.status === 418) {
        console.log(`  [${label}] rate limit, sleep 60s ...`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      throw e;
    }
    if (data.length === 0) break;
    for (const k of data) {
      const ts = k[0];
      if (ts >= endMs) break;
      all.push({
        ts, date: new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    const lastTs = data[data.length - 1][0];
    if (lastTs <= cur) break;
    cur = lastTs + 1;
    req += 1;
    if (req % 50 === 0) process.stdout.write(`  [${label}] ${req} reqs, ${all.length} bars\n`);
    await new Promise((r) => setTimeout(r, 350));
  }
  return all;
}

(async () => {
  const startMs = new Date(`${START}T00:00:00Z`).getTime();
  const endMs = new Date(`${END}T00:00:00Z`).getTime();
  console.log(`Binance BTCUSDT perp prev year ${START} ~ ${END}`);
  for (const t of [
    { interval: '1m', label: '1m' },
    { interval: '4h', label: '4h' },
  ]) {
    const outFile = path.join(CACHE_DIR, `BINANCE_PERP_${SYMBOL}_${t.interval}_${START}_${END}.json`);
    if (fs.existsSync(outFile)) {
      console.log(`[${t.label}] cached`);
      continue;
    }
    console.log(`[${t.label}] fetching ...`);
    const bars = await fetchKlines(t.interval, startMs, endMs, t.label);
    fs.writeFileSync(outFile, JSON.stringify(bars));
    console.log(`[${t.label}] saved ${bars.length} bars`);
  }
  console.log('Done.');
  process.exit(0);
})();
