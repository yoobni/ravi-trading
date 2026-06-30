/**
 * R29-2 — Daily swing (TP10/SL4/MAX 7d).
 *
 * 가설: R23-C는 TP6/SL1/72h — 짧은 TF에서 noise 많음.
 *      더 큰 payoff/holding (TP10/SL4/MAX 7d)로 noise 무시 + 큰 trend만 익절.
 *
 * 룰: R23-C signal (MTF SHORT + Volume z>1.0) + variant TP10/SL4/MAX 168h.
 *     비교 variants 추가: TP8/SL3/MAX 5d, TP15/SL5/MAX 14d.
 * Period: 5년 walk-forward + 알트 (ETH/SOL/XRP) 2y.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  type SafeContext, type SafeSignal, type Variant,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;

const VARIANTS: Variant[] = [
  { name: 'TP10_SL4_168h',  tp: 10, sl: -4, maxMin: 10080 },
  { name: 'TP8_SL3_120h',   tp: 8,  sl: -3, maxMin: 7200 },
  { name: 'TP15_SL5_336h',  tp: 15, sl: -5, maxMin: 20160 },
  { name: 'TP12_SL3_240h',  tp: 12, sl: -3, maxMin: 14400 },
  { name: 'TP6_SL1_72h',    tp: 6,  sl: -1, maxMin: 4320 }, // R23-C 비교
];

function mtfShortSignals(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null || ctx.bars4h[idx4h].close >= e4h) continue;
    const ePrev = ema20_15[i - 1], eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    if (!(prev.close > ePrev && bar.close < eCur)) continue;
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < 1.0) continue;
    out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out.filter(s => inPeriod(s.signalTs, ctx)).sort((a, b) => a.signalTs - b.signalTs);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R29-2 DAILY SWING (big TP/SL/MAX) ===\n`);

  const yearRanges = [
    { label: '2020-06~21-06', start: '2020-06-09', end: '2021-06-09' },
    { label: '2021-06~22-06', start: '2021-06-09', end: '2022-06-09' },
    { label: '2022-06~23-06', start: '2022-06-09', end: '2023-06-09' },
    { label: '2023-06~24-06', start: '2023-06-09', end: '2024-06-09' },
    { label: '2024-06~25-06', start: '2024-06-09', end: '2025-06-09' },
    { label: '2025-06~26-06', start: '2025-06-09', end: '2026-06-09' },
  ];
  const altPeriods = [
    { label: 'PREV', start: '2024-06-09', end: '2025-06-09' },
    { label: 'CURR', start: '2025-06-09', end: '2026-06-09' },
  ];

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R29-2 DAILY SWING — 큰 payoff/holding으로 noise 회피`);
  L.push(`Algorithm: R23-C MTF SHORT signal × 5 variants (TP/SL/MAX 조합)`);
  L.push('='.repeat(140));

  for (const v of VARIANTS) {
    L.push(`\n## variant: ${v.name}\n`);
    L.push(`${pad('year/coin', 28)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
    L.push('-'.repeat(95));

    // BTC 5y
    const allTrades: any[] = [];
    let passCount = 0;
    for (const yr of yearRanges) {
      const ctx = buildSafeContext(yr.start, yr.end);
      if (!ctx) continue;
      const sigs = mtfShortSignals(ctx);
      const trades = simulateSafe(ctx, sigs, v, COST_RT);
      for (let i = 0; i < trades.length; i++) allTrades.push(trades[i]);
      const s = statsFor(trades);
      if (s.pf >= 1.2 && s.total > 0) passCount++;
      L.push(`${pad(`BTC ${yr.label}`, 28)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    const overall = statsFor(allTrades);
    L.push('-'.repeat(95));
    L.push(`${pad('BTC TOTAL 5y', 28)} | ${padS(String(overall.n), 4)} | ${padS(overall.wr.toFixed(0)+'%', 5)} | ${padS(fmt(overall.avgWin), 7)} | ${padS(fmt(overall.avgLoss), 7)} | ${padS(fmt(overall.total), 8)} | ${padS(overall.pf.toFixed(2), 5)}`);
    L.push(`PASS years: ${passCount}/${yearRanges.length}`);

    // 알트
    L.push('');
    for (const coin of ['ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
      for (const p of altPeriods) {
        const ctx = buildSafeContext(p.start, p.end, coin);
        if (!ctx) continue;
        const sigs = mtfShortSignals(ctx);
        const trades = simulateSafe(ctx, sigs, v, COST_RT);
        const s = statsFor(trades);
        L.push(`${pad(`${coin.replace('USDT','')} ${p.label}`, 28)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R29-2_DAILY_SWING.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
