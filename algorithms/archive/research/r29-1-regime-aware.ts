/**
 * R29-1 — Regime-aware R23-C.
 *
 * 가설: R23-C가 2024-2026에만 작동 = bull market 한정 알파.
 *      Daily close > 200d EMA (bull regime)에서만 진입하면 fluke가 robust가 될 수 있나?
 *
 * 룰: R23-C (MTF SHORT + Volume z>1.0 + TP6/SL1/72h) + Regime filter (daily close > 200d EMA, lookahead-free).
 * Period: 5년 walk-forward (2020-06 ~ 2026-06, year-by-year).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  aggregateBars, simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  type SafeContext, type SafeSignal, type Variant, type Bar,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;
const TP6_1: Variant = { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 };
const D_1D = 24 * 60 * 60_000;

function mtfShortSignalsWithRegime(
  ctx: SafeContext,
  bars1d: Bar[],
  ema200_1d: (number | null)[],
  regime: 'bull' | 'bear' | 'any',
): SafeSignal[] {
  const out: SafeSignal[] = [];
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    // Daily regime check (latest closed daily bar)
    const idx1d = latestClosedBarIdx(bars1d, D_1D, sigTs);
    if (idx1d < 0) continue;
    const e1d = ema200_1d[idx1d];
    if (e1d == null) continue;
    const isBull = bars1d[idx1d].close > e1d;
    if (regime === 'bull' && !isBull) continue;
    if (regime === 'bear' && isBull) continue;
    // 4h trend
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null || ctx.bars4h[idx4h].close >= e4h) continue;
    // 15m cross
    const ePrev = ema20_15[i - 1], eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    if (!(prev.close > ePrev && bar.close < eCur)) continue;
    // Volume z
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < 1.0) continue;
    out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out.filter(s => inPeriod(s.signalTs, ctx)).sort((a, b) => a.signalTs - b.signalTs);
}

/**
 * 1m bars를 합쳐서 daily bars 만들기. 단, 200일 EMA warm-up이 필요하므로
 * period 시작 이전 200일 data가 필요. 5년 1m이 다 있으니 (2020-06~2026-06),
 * 각 period에 대해 이전 1년치 data까지 합쳐 EMA200 계산.
 */
function buildDailyWithWarmup(periodStart: string): { bars1d: Bar[]; ema200: (number | null)[] } {
  const cacheDir = path.resolve(process.cwd(), 'data', 'candle-cache');
  // 모든 1m years를 읽어와서 합치고, periodStart 이전 ~1년치도 포함
  const allYears = [
    '2020-06-09_2021-06-09',
    '2021-06-09_2022-06-09',
    '2022-06-09_2023-06-09',
    '2023-06-09_2024-06-09',
    '2024-06-09_2025-06-09',
    '2025-06-09_2026-06-09',
  ];
  const all: Bar[] = [];
  // periodStart 1년 전부터 ~ 끝까지
  const pStartDate = periodStart;
  for (const y of allYears) {
    const fp = path.join(cacheDir, `BINANCE_PERP_BTCUSDT_1m_${y}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr: Bar[] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);
  }
  // sort + dedup by ts
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set<number>();
  const dedup: Bar[] = [];
  for (const b of all) { if (!seen.has(b.ts)) { seen.add(b.ts); dedup.push(b); } }
  const bars1d = aggregateBars(dedup, 1440);
  const ema200 = calcEMASafe(bars1d.map(b => b.close), 200);
  return { bars1d, ema200 };
}

const yearRanges = [
  { label: '2020-06~21-06', start: '2020-06-09', end: '2021-06-09' },
  { label: '2021-06~22-06', start: '2021-06-09', end: '2022-06-09' },
  { label: '2022-06~23-06', start: '2022-06-09', end: '2023-06-09' },
  { label: '2023-06~24-06', start: '2023-06-09', end: '2024-06-09' },
  { label: '2024-06~25-06', start: '2024-06-09', end: '2025-06-09' },
  { label: '2025-06~26-06', start: '2025-06-09', end: '2026-06-09' },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R29-1 REGIME-AWARE R23-C ===\n`);

  // Daily bars (전체 5년+) + 200d EMA (한 번만 계산)
  console.log(`Building daily bars + 200d EMA (전체 5년+)...`);
  const { bars1d, ema200 } = buildDailyWithWarmup('2020-06-09');
  console.log(`  → ${bars1d.length} daily bars, EMA200 ready`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R29-1 REGIME-AWARE R23-C — Daily close > 200d EMA gate (lookahead-free)`);
  L.push(`Algorithm: MTF SHORT + Volume z>1.0 + TP6/SL1/72h, regime: { bull | bear | any }`);
  L.push('='.repeat(140));

  for (const regime of ['any', 'bull', 'bear'] as const) {
    L.push(`\n## REGIME = ${regime.toUpperCase()}\n`);
    L.push(`${pad('year', 24)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
    L.push('-'.repeat(90));

    const yearStats: { label: string; n: number; total: number; pf: number; wr: number }[] = [];
    const allTrades: any[] = [];
    for (const yr of yearRanges) {
      const ctx = buildSafeContext(yr.start, yr.end);
      if (!ctx) {
        L.push(`${pad(yr.label, 24)} | (데이터 없음)`);
        continue;
      }
      const sigs = mtfShortSignalsWithRegime(ctx, bars1d, ema200, regime);
      const trades = simulateSafe(ctx, sigs, TP6_1, COST_RT);
      for (let i = 0; i < trades.length; i++) allTrades.push(trades[i]);
      const s = statsFor(trades);
      yearStats.push({ label: yr.label, n: s.n, total: s.total, pf: s.pf, wr: s.wr });
      L.push(`${pad(yr.label, 24)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    const overall = statsFor(allTrades);
    L.push('-'.repeat(90));
    L.push(`${pad('TOTAL 5y', 24)} | ${padS(String(overall.n), 4)} | ${padS(overall.wr.toFixed(0)+'%', 5)} | ${padS(fmt(overall.avgWin), 7)} | ${padS(fmt(overall.avgLoss), 7)} | ${padS(fmt(overall.total), 8)} | ${padS(overall.pf.toFixed(2), 5)}`);
    let passCount = 0;
    for (const ys of yearStats) if (ys.pf >= 1.2 && ys.total > 0) passCount++;
    L.push(`PASS (PF≥1.2 + total>0): ${passCount}/${yearStats.length}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R29-1_REGIME.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
