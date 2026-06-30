/**
 * R26 — 5년 walk-forward (year-by-year), R23-C 룰 그대로.
 *
 * Year ranges (모두 1m 데이터 cached):
 *   2020-06 ~ 2021-06
 *   2021-06 ~ 2022-06
 *   2022-06 ~ 2023-06
 *   2023-06 ~ 2024-06
 *   2024-06 ~ 2025-06
 *   2025-06 ~ 2026-06
 *
 * 각 year별 R23-C SHORT only (TP6/SL1/72h) 측정.
 * 거시 환경별 robustness 검증:
 *   2020: covid recovery
 *   2021: bull market top
 *   2022: bear market
 *   2023: sideways/recovery
 *   2024: bull
 *   2025-2026: 최근
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  D_15M, D_1H, D_4H,
  type SafeContext, type SafeSignal, type Trade, type Variant,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;
const PAYOFF_6_1: Variant = { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 };

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

const yearRanges = [
  { label: '2020-06~21-06 (covid recovery)', start: '2020-06-09', end: '2021-06-09' },
  { label: '2021-06~22-06 (bull top → bear)', start: '2021-06-09', end: '2022-06-09' },
  { label: '2022-06~23-06 (bear → recovery)', start: '2022-06-09', end: '2023-06-09' },
  { label: '2023-06~24-06 (recovery/bull)', start: '2023-06-09', end: '2024-06-09' },
  { label: '2024-06~25-06 (bull)', start: '2024-06-09', end: '2025-06-09' },
  { label: '2025-06~26-06 (bull/recent)', start: '2025-06-09', end: '2026-06-09' },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R26 5Y_WALK_FORWARD (R23-C, lookahead-free) ===\n`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R26 5Y_WALK_FORWARD — R23-C (MTF + Volume + TP6/SL1) SHORT, year-by-year`);
  L.push(`Cost RT ${(COST_RT*100).toFixed(1)}%, 1m path verify, lookahead-free (_safe.ts)`);
  L.push('='.repeat(140));

  L.push(`\n${pad('year', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(105));

  interface Row { label: string; stats: ReturnType<typeof statsFor>; trades: Trade[]; }
  const rows: Row[] = [];

  for (const yr of yearRanges) {
    const ctx = buildSafeContext(yr.start, yr.end);
    if (!ctx) {
      L.push(`${pad(yr.label, 36)} | ${padS('(데이터 없음)', 50)}`);
      continue;
    }
    const sigs = mtfShortSignals(ctx);
    const trades = simulateSafe(ctx, sigs, PAYOFF_6_1, COST_RT);
    const s = statsFor(trades);
    rows.push({ label: yr.label, stats: s, trades });
    L.push(`${pad(yr.label, 36)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  // 통합
  const allTrades = rows.flatMap(r => r.trades);
  const allStats = statsFor(allTrades);
  L.push('-'.repeat(105));
  L.push(`${pad('TOTAL (모든 year)', 36)} | ${padS(String(allStats.n), 4)} | ${padS(allStats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(allStats.avgWin), 7)} | ${padS(fmt(allStats.avgLoss), 7)} | ${padS(fmt(allStats.total), 8)} | ${padS(allStats.pf.toFixed(2), 5)}`);

  // 통과 판정
  L.push(`\n## 통과 판정 (per year)\n`);
  L.push(`${pad('year', 36)} | ${padS('PF', 5)} | ${padS('total', 8)} | 판정`);
  L.push('-'.repeat(80));
  let passCount = 0;
  for (const r of rows) {
    let verdict = '';
    if (r.stats.pf >= 1.2 && r.stats.total > 0) { verdict = '✓ PASS'; passCount++; }
    else if (r.stats.pf >= 1.0 && r.stats.total >= -5) verdict = '⚠ MARGINAL';
    else verdict = '✗ FAIL';
    L.push(`${pad(r.label, 36)} | ${padS(r.stats.pf.toFixed(2), 5)} | ${padS(fmt(r.stats.total), 8)} | ${verdict}`);
  }
  L.push(`\n양수 year (PF≥1.2): ${passCount}/${rows.length} (${rows.length ? (passCount/rows.length*100).toFixed(0) : 0}%)`);

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R26_5Y.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
