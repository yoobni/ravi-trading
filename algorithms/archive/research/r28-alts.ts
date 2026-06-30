/**
 * R28 — 알트 적용 (ETH/SOL/XRP) + 좋았던 알고리즘 walk-forward.
 *
 * 알고리즘:
 *   - R23-C: MTF SHORT + Volume z>1.0 + TP6/SL1/72h
 *   - R23-B: MTF SHORT + Volume z>1.0 + TP5/SL1/48h
 *   - R24-5: MTF SHORT + Volume + 1h align + TP6/SL1/72h
 *
 * Periods: PREV (2024-06~25-06) + CURR (2025-06~26-06)
 * Coins: BTC (ref) + ETH + SOL + XRP
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

function mtfShortSignals(ctx: SafeContext, opts: { needHourlyAlign?: boolean } = {}): SafeSignal[] {
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  const closes1h = ctx.bars1h.map(b => b.close);
  const ema50_1h = opts.needHourlyAlign ? calcEMASafe(closes1h, 50) : null;
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null || ctx.bars4h[idx4h].close >= e4h) continue;
    if (opts.needHourlyAlign && ema50_1h) {
      const idx1h = latestClosedBarIdx(ctx.bars1h, ctx.durationMs1h, sigTs);
      if (idx1h < 0) continue;
      const e1h = ema50_1h[idx1h];
      if (e1h == null || ctx.bars1h[idx1h].close >= e1h) continue;
    }
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

// 양방향 LONG 신호도 추가 (4h uptrend + 15m EMA20 cross up + volume z>1)
function mtfBothSignals(ctx: SafeContext, opts: { needHourlyAlign?: boolean } = {}): SafeSignal[] {
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null) continue;
    const trend = ctx.bars4h[idx4h].close > e4h ? 1 : ctx.bars4h[idx4h].close < e4h ? -1 : 0;
    if (trend === 0) continue;
    const ePrev = ema20_15[i - 1], eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < 1.0) continue;
    if (trend === 1 && prev.close < ePrev && bar.close > eCur) {
      out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    } else if (trend === -1 && prev.close > ePrev && bar.close < eCur) {
      out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    }
  }
  return out.filter(s => inPeriod(s.signalTs, ctx)).sort((a, b) => a.signalTs - b.signalTs);
}

const VARIANTS: Record<string, Variant> = {
  TP3_1: { name: 'TP3_SL1_12h', tp: 3, sl: -1, maxMin: 720 },
  TP5_1: { name: 'TP5_SL1_48h', tp: 5, sl: -1, maxMin: 2880 },
  TP6_1: { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 },
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R28 ALTS — ETH/SOL/XRP + 좋았던 알고리즘 ===\n`);

  const coins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const periods = [
    { name: 'PREV', start: '2024-06-09', end: '2025-06-09' },
    { name: 'CURR', start: '2025-06-09', end: '2026-06-09' },
  ];

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R28 ALTS — Binance perp ETH/SOL/XRP + 좋았던 알고리즘 walk-forward`);
  L.push(`Algorithms: R23-C (TP6:1) / R23-B (TP5:1) / R24-5 (TP6:1 + 1h align) / BOTH variants`);
  L.push('='.repeat(150));

  L.push(`\n## SHORT only (4h downtrend)\n`);
  L.push(`${pad('coin × algo × period', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(110));

  interface Row { id: string; period: string; stats: ReturnType<typeof statsFor>; }
  const rows: Row[] = [];

  for (const coin of coins) {
    for (const p of periods) {
      const ctx = buildSafeContext(p.start, p.end, coin);
      if (!ctx) {
        L.push(`${pad(`${coin} × — × ${p.name}`, 36)} | ${padS('(데이터 없음)', 50)}`);
        continue;
      }
      const algos = [
        { id: 'R23-C TP6:1',        sigs: mtfShortSignals(ctx, {}),                v: VARIANTS.TP6_1 },
        { id: 'R23-B TP5:1',        sigs: mtfShortSignals(ctx, {}),                v: VARIANTS.TP5_1 },
        { id: 'R24-5 TP6:1+1halign', sigs: mtfShortSignals(ctx, { needHourlyAlign: true }), v: VARIANTS.TP6_1 },
      ];
      for (const algo of algos) {
        const trades = simulateSafe(ctx, algo.sigs, algo.v, COST_RT);
        const s = statsFor(trades);
        rows.push({ id: `${coin.replace('USDT','')} ${algo.id}`, period: p.name, stats: s });
        L.push(`${pad(`${coin.replace('USDT','')} ${algo.id} × ${p.name}`, 36)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
      L.push('');
    }
  }

  // 양쪽 1년 통과
  L.push(`\n## 양쪽 1년 PF≥1.2 통과 cell (SHORT only)\n`);
  const byId = new Map<string, { prev?: Row; curr?: Row }>();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, {});
    byId.get(r.id)![r.period === 'PREV' ? 'prev' : 'curr'] = r;
  }
  L.push(`${pad('coin × algo', 36)} | ${padS('PREV PF', 8)} | ${padS('CURR PF', 8)} | ${padS('PREV total', 11)} | ${padS('CURR total', 11)}`);
  L.push('-'.repeat(100));
  for (const [id, pair] of byId) {
    if (!pair.prev || !pair.curr) continue;
    const pass = pair.prev.stats.pf >= 1.2 && pair.curr.stats.pf >= 1.2;
    L.push(`${pad(id, 36)} | ${padS(pair.prev.stats.pf.toFixed(2), 8)} | ${padS(pair.curr.stats.pf.toFixed(2), 8)} | ${padS(fmt(pair.prev.stats.total), 11)} | ${padS(fmt(pair.curr.stats.total), 11)} ${pass ? '✓' : ''}`);
  }

  // BOTH (LONG+SHORT) 양방향 시도
  L.push(`\n\n## BOTH (LONG + SHORT) — 양방향 시도\n`);
  L.push(`${pad('coin × algo × period', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(85));

  for (const coin of coins) {
    for (const p of periods) {
      const ctx = buildSafeContext(p.start, p.end, coin);
      if (!ctx) continue;
      for (const algoName of ['TP6:1', 'TP5:1']) {
        const v = algoName === 'TP6:1' ? VARIANTS.TP6_1 : VARIANTS.TP5_1;
        const sigs = mtfBothSignals(ctx, {});
        const trades = simulateSafe(ctx, sigs, v, COST_RT);
        const s = statsFor(trades);
        L.push(`${pad(`${coin.replace('USDT','')} BOTH ${algoName} × ${p.name}`, 36)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
      L.push('');
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R28_ALTS.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
