/**
 * R4: BTC_ALT_LEAD_LAG — BTC 급등 후 알트 지연 반응 매수.
 *
 * 데이터 한계: 알트 1m 6개월만 가용 (2025-12 ~ 2026-05).
 *   - 가용: ETH, SOL, XRP (1m 6개월)
 *   - 부족: DOGE, ADA, AVAX, LINK (별도 fetch 안 함)
 *
 * 룰:
 *   1. BTC 15m return ≥ +0.8% (또는 +1.2%)
 *   2. 같은 15m bar에서 알트 15m return < BTC 15m return × 0.5 (lagging)
 *   3. 다음 15m 시초가 알트 진입
 *
 * 청산: 1m path verified TP/SL/MAX
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP1.0_SL0.8_2h', tp: 1.0, sl: -0.8, maxMin: 120 },
  { name: 'B_TP1.5_SL1.0_4h', tp: 1.5, sl: -1.0, maxMin: 240 },
  { name: 'C_TP2.0_SL1.5_8h', tp: 2.0, sl: -1.5, maxMin: 480 },
];
const COST_LEVELS = [0.002, 0.003, 0.005];
const BTC_TRIGGER_RETURNS = [0.8, 1.2]; // % 15m return

const ALTS = ['KRW-ETH', 'KRW-SOL', 'KRW-XRP'];

function load1mForMarket(market: string): Bar[] {
  // 두 파일 합치기
  const files = [
    `${market}_1m_2025-06-01_2025-11-30.json`,
    `${market}_1m_2025-12-01_2026-05-29.json`,
  ];
  const all: Bar[] = [];
  for (const f of files) {
    const fp = path.join(CACHE_DIR, f);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Bar[];
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);
  }
  const seen = new Set<number>();
  return all.filter((b) => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; }).sort((a, b) => a.ts - b.ts);
}
function aggregate1mTo15m(bars1m: Bar[]): Bar[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of bars1m) {
    const bucketTs = Math.floor(b.ts / (15 * 60_000)) * (15 * 60_000);
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, []);
    buckets.get(bucketTs)!.push(b);
  }
  const out: Bar[] = [];
  for (const [ts, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length === 0) continue;
    const date = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    out.push({
      ts, date,
      open: bs[0].open,
      high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)),
      close: bs[bs.length - 1].close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

interface ExitResult { exitTs: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; rawReturnPct: number; durationMin: number; }
function pathVerify(bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number, tpPct: number, slPct: number, maxMin: number): ExitResult {
  const tpPrice = entryPriceRaw * (1 + tpPct / 100);
  const slPrice = entryPriceRaw * (1 + slPct / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsedMin = (bar.ts - entryTs) / 60_000;
    if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: slPct, durationMin: elapsedMin };
    if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: tpPct, durationMin: elapsedMin };
    if (elapsedMin >= maxMin) {
      const ret = (bar.close - entryPriceRaw) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret, durationMin: elapsedMin };
    }
  }
  const last = bars1m[bars1m.length - 1];
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: (last.close - entryPriceRaw) / entryPriceRaw * 100, durationMin: (last.ts - entryTs) / 60_000 };
}

interface Trade {
  alt: string;
  signalTs: number;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: string;
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
  btcRet: number; altRet: number;
}

function find1mIdx(bars1m: Bar[], ts: number): number {
  let lo = 0, hi = bars1m.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function simulate(
  btc15m: Bar[],
  alt15m: Bar[],
  alt1m: Bar[],
  altName: string,
  triggerRet: number,
  variant: Variant,
  cost: number,
): Trade[] {
  const trades: Trade[] = [];
  const alt15mByTs = new Map(alt15m.map((b) => [b.ts, b]));
  let cooldownTs = 0;

  for (let i = 1; i < btc15m.length - 1; i++) {
    const btcBar = btc15m[i];
    if (btcBar.ts < cooldownTs) continue;
    const btcRet = (btcBar.close - btcBar.open) / btcBar.open * 100;
    if (btcRet < triggerRet) continue;

    // 알트 같은 ts bar
    const altBar = alt15mByTs.get(btcBar.ts);
    if (!altBar) continue;
    const altRet = (altBar.close - altBar.open) / altBar.open * 100;
    if (altRet >= btcRet * 0.5) continue; // lagging 조건

    // 다음 15m 시초가 알트 진입
    const nextBarTs = btcBar.ts + 15 * 60_000;
    const nextAlt = alt15mByTs.get(nextBarTs);
    if (!nextAlt) continue;
    const startIdx = find1mIdx(alt1m, nextBarTs);
    if (startIdx >= alt1m.length) continue;
    const entryPriceRaw = nextAlt.open;

    const exit = pathVerify(alt1m, startIdx, nextBarTs, entryPriceRaw, variant.tp, variant.sl, variant.maxMin);
    const netReturn = exit.rawReturnPct - cost * 100;
    trades.push({
      alt: altName,
      signalTs: btcBar.ts,
      entryTs: nextBarTs, entryPrice: entryPriceRaw,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice,
      reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netReturn,
      monthKey: new Date(nextBarTs + 9 * 3600 * 1000).toISOString().slice(0, 7),
      btcRet, altRet,
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R4: BTC_ALT_LEAD_LAG ===\n`);

  const btc1m = load1mForMarket('KRW-BTC');
  const btc15m = aggregate1mTo15m(btc1m);
  console.log(`BTC 1m=${btc1m.length}, 15m=${btc15m.length}`);

  const altData: Record<string, { bars1m: Bar[]; bars15m: Bar[] }> = {};
  for (const alt of ALTS) {
    const a1m = load1mForMarket(alt);
    if (a1m.length === 0) { console.log(`  ${alt}: NO DATA`); continue; }
    const a15m = aggregate1mTo15m(a1m);
    altData[alt] = { bars1m: a1m, bars15m: a15m };
    const startD = new Date(a1m[0].ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const endD = new Date(a1m[a1m.length - 1].ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
    console.log(`  ${alt}: 1m=${a1m.length}, 15m=${a15m.length}, ${startD} ~ ${endD}`);
  }

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R4: BTC_ALT_LEAD_LAG`);
  L.push(`Period: BTC 12mo + 알트 ETH/SOL/XRP 가용기간`);
  L.push('='.repeat(150));

  L.push(`\n## Raw 결과 (WR / 이익률 중심)\n`);
  L.push(`${pad('config', 38)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('payoff', 6)} | ${padS('totalRet', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(150));

  interface Cell { name: string; trades: Trade[]; }
  const cells: Cell[] = [];

  for (const altName of ALTS) {
    if (!altData[altName]) continue;
    const ad = altData[altName];
    for (const trig of BTC_TRIGGER_RETURNS) {
      for (const v of VARIANTS) {
        for (const cost of COST_LEVELS) {
          const trades = simulate(btc15m, ad.bars15m, ad.bars1m, altName, trig, v, cost);
          const wins = trades.filter((t) => t.netReturnPct > 0);
          const losses = trades.filter((t) => t.netReturnPct <= 0);
          const n = trades.length;
          const wr = n ? wins.length / n * 100 : 0;
          const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
          const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
          const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
          const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
          const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
          const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
          const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
          const cfg = `${altName.replace('KRW-', '')}_trig${trig}_${v.name}`;
          cells.push({ name: cfg + '_c' + cost, trades });
          L.push(`${pad(cfg, 38)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(n), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(avgWin), 7)} | ${padS(fmt(avgLoss), 7)} | ${padS(payoff.toFixed(2), 6)} | ${padS(fmt(total), 9)} | ${padS(pf.toFixed(2), 5)}`);
        }
      }
    }
  }

  // 알트별 요약 (cost 0.2% 기준)
  L.push(`\n## 알트별 요약 (cost 0.2%, best variant)\n`);
  L.push(`${pad('alt', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(50));
  for (const altName of ALTS) {
    if (!altData[altName]) continue;
    // pick best total ret cell at cost 0.2%
    const altCells = cells.filter((c) => c.name.startsWith(altName.replace('KRW-', '')) && c.name.endsWith('c0.002'));
    if (altCells.length === 0) continue;
    altCells.sort((a, b) => {
      const aTot = a.trades.reduce((s, t) => s + t.netReturnPct, 0);
      const bTot = b.trades.reduce((s, t) => s + t.netReturnPct, 0);
      return bTot - aTot;
    });
    const best = altCells[0];
    const wins = best.trades.filter((t) => t.netReturnPct > 0);
    const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
    const losses = best.trades.filter((t) => t.netReturnPct <= 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
    const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
    const total = best.trades.reduce((s, t) => s + t.netReturnPct, 0);
    L.push(`${pad(altName.replace('KRW-', ''), 12)} | ${padS(String(best.trades.length), 4)} | ${padS((best.trades.length ? wins.length/best.trades.length*100 : 0).toFixed(0)+'%', 5)} | ${padS(fmt(total), 9)} | ${padS(pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R4_ALT_LEAD_LAG.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
