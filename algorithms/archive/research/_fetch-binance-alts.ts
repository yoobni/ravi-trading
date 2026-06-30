/**
 * Binance perp 알트 1m fetch (ETH/SOL/XRP, 2024-06 ~ 2026-06).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchPeriod(symbol: string, start: string, end: string): Promise<Bar[]> {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  const all: Bar[] = [];
  let cur = startMs;
  let req = 0;
  while (cur < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${cur}&limit=1500`;
    let data: any[][];
    try {
      const res = await axios.get<any[][]>(url);
      data = res.data;
    } catch (e: any) {
      if (e?.response?.status === 429 || e?.response?.status === 418) {
        console.log(`  [${symbol}] rate limit, sleep 60s`);
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
    if (req % 50 === 0) process.stdout.write(`  [${symbol}] ${req} reqs, ${all.length} bars\n`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return all;
}

(async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const symbol of SYMBOLS) {
    for (const period of [
      { start: '2024-06-09', end: '2025-06-09' },
      { start: '2025-06-09', end: '2026-06-09' },
    ]) {
      const outFile = path.join(CACHE_DIR, `BINANCE_PERP_${symbol}_1m_${period.start}_${period.end}.json`);
      if (fs.existsSync(outFile)) {
        const arr = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        console.log(`[${symbol} ${period.start}~${period.end}] cached: ${arr.length} bars`);
        continue;
      }
      console.log(`[${symbol} ${period.start}~${period.end}] fetching ...`);
      const bars = await fetchPeriod(symbol, period.start, period.end);
      fs.writeFileSync(outFile, JSON.stringify(bars));
      console.log(`[${symbol} ${period.start}~${period.end}] saved ${bars.length} bars`);
    }
  }
  console.log('\nDone.');
  process.exit(0);
})();
