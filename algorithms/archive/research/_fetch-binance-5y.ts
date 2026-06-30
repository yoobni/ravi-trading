/**
 * Binance BTCUSDT perp 1m 5년 데이터 fetch (2020-06-09 ~ 2024-06-09).
 * 3년 어치 추가 (이미 2024-06~2026-06 있음).
 *
 * 4년치만큼 cycle 별로 fetch.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const SYMBOL = 'BTCUSDT';

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchYear(yearStart: string, yearEnd: string): Promise<Bar[]> {
  const startMs = new Date(`${yearStart}T00:00:00Z`).getTime();
  const endMs = new Date(`${yearEnd}T00:00:00Z`).getTime();
  const all: Bar[] = [];
  let cur = startMs;
  let req = 0;
  while (cur < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&startTime=${cur}&limit=1500`;
    let data: any[][];
    try {
      const res = await axios.get<any[][]>(url);
      data = res.data;
    } catch (e: any) {
      if (e?.response?.status === 429 || e?.response?.status === 418) {
        console.log(`  rate limit, sleep 60s ...`);
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
    if (req % 50 === 0) process.stdout.write(`  ${yearStart}~${yearEnd}: ${req} reqs, ${all.length} bars\n`);
    await new Promise((r) => setTimeout(r, 350));
  }
  return all;
}

(async () => {
  const yearRanges = [
    { start: '2020-06-09', end: '2021-06-09' },
    { start: '2021-06-09', end: '2022-06-09' },
    { start: '2022-06-09', end: '2023-06-09' },
    { start: '2023-06-09', end: '2024-06-09' },
  ];
  for (const yr of yearRanges) {
    const outFile = path.join(CACHE_DIR, `BINANCE_PERP_BTCUSDT_1m_${yr.start}_${yr.end}.json`);
    if (fs.existsSync(outFile)) {
      const arr = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      console.log(`[${yr.start}~${yr.end}] cached: ${arr.length} bars`);
      continue;
    }
    console.log(`[${yr.start}~${yr.end}] fetching ...`);
    const bars = await fetchYear(yr.start, yr.end);
    fs.writeFileSync(outFile, JSON.stringify(bars));
    console.log(`[${yr.start}~${yr.end}] saved ${bars.length} bars`);
  }
  console.log('\nDone.');
  process.exit(0);
})();
