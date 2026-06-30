/**
 * R24 — R23-C (TP6:1) base에 WR 개선 filter 8가지 (safe lib).
 *
 * Base: MTF + Volume z>1.0 SHORT + TP6/SL1/72h
 *
 * Filters:
 *   1. + RSI<45 (모멘텀 약함 확인)
 *   2. + Heikin Ashi 음봉 confirm
 *   3. + 2-bar 연속 음봉
 *   4. + 1h trend 동조 (R23-H 재실험)
 *   5. + close < EMA50 (강한 trend)
 *   6. + Time filter (KST 09-21)
 *   7. + funding align (펀딩 양수 시만)
 *   8. + Volume z>1.5 (덜 strict)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcRSI } from '@/lib/indicators';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  D_15M, D_1H, D_4H,
  type SafeContext, type SafeSignal, type Trade, type Variant,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;
const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const PAYOFF_6_1: Variant = { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 };

interface FundingPoint { ts: number; date: string; rate: number; }

function loadFunding(): Map<string, number> {
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const m = new Map<string, number>();
  for (const p of funding) m.set(p.date, (m.get(p.date) ?? 0) + p.rate);
  return m;
}

function calcHeikinAshi(bars: { open: number; high: number; low: number; close: number }[]) {
  const ha: { open: number; close: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({ open: haOpen, close: haClose });
  }
  return ha;
}

interface FilterOpts {
  rsiBelow?: number;       // RSI < this (LONG 약함 = SHORT 강함)
  haRed?: boolean;
  twoBarRed?: boolean;
  needHourlyAlign?: boolean;
  closeBelowEma50?: boolean;
  timeKstActive?: boolean;
  fundingPos?: boolean;
  volZ?: number;
}

function mtfShortWithFilters(ctx: SafeContext, fundingDaily: Map<string, number>, opts: FilterOpts = {}): SafeSignal[] {
  const out: SafeSignal[] = [];
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const ema50_15 = calcEMASafe(closes15, 50);
  const rsi14 = calcRSI(closes15, 14).values;
  const ha = calcHeikinAshi(ctx.bars15m);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  const closes1h = ctx.bars1h.map(b => b.close);
  const ema50_1h = opts.needHourlyAlign ? calcEMASafe(closes1h, 50) : null;

  const volZThresh = opts.volZ ?? 1.0;

  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);

    // 4h trend (safe)
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null || ctx.bars4h[idx4h].close >= e4h) continue;

    // 1h alignment
    if (opts.needHourlyAlign && ema50_1h) {
      const idx1h = latestClosedBarIdx(ctx.bars1h, ctx.durationMs1h, sigTs);
      if (idx1h < 0) continue;
      const e1h = ema50_1h[idx1h];
      if (e1h == null || ctx.bars1h[idx1h].close >= e1h) continue;
    }

    // 15m EMA20 cross down
    const ePrev = ema20_15[i - 1]; const eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    if (!(prev.close > ePrev && bar.close < eCur)) continue;

    // Volume z
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < volZThresh) continue;

    // Optional filters
    if (opts.rsiBelow != null) {
      const r = rsi14[i]; if (r == null || r >= opts.rsiBelow) continue;
    }
    if (opts.haRed) {
      const h = ha[i]; if (h.close >= h.open) continue;
    }
    if (opts.twoBarRed) {
      const h1 = ha[i], h2 = ha[i - 1];
      if (h1.close >= h1.open || h2.close >= h2.open) continue;
    }
    if (opts.closeBelowEma50) {
      const e50 = ema50_15[i]; if (e50 == null || bar.close >= e50) continue;
    }
    if (opts.timeKstActive) {
      const kstHour = new Date(sigTs + 9 * 3600_000).getUTCHours();
      if (kstHour < 9 || kstHour > 21) continue;
    }
    if (opts.fundingPos) {
      const yesterday = new Date(new Date(new Date(sigTs + 9 * 3600_000).toISOString().slice(0, 10) + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
      const yF = fundingDaily.get(yesterday);
      if (yF == null || yF <= 0) continue;
    }

    out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out.filter(s => inPeriod(s.signalTs, ctx)).sort((a, b) => a.signalTs - b.signalTs);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fundingDaily = loadFunding();

  console.log(`\n=== R24 WR_IMPROVE (safe lib) ===\n`);
  const curCtx = buildSafeContext('2025-06-09', '2026-06-09')!;
  const prevCtx = buildSafeContext('2024-06-09', '2025-06-09')!;

  const variants: Array<{ id: string; opts: FilterOpts }> = [
    { id: 'R24-1: BASE (R23-C)',         opts: {} },
    { id: 'R24-2: + RSI<45',             opts: { rsiBelow: 45 } },
    { id: 'R24-3: + HA red',             opts: { haRed: true } },
    { id: 'R24-4: + 2-bar HA red',       opts: { twoBarRed: true } },
    { id: 'R24-5: + 1h align (재실험)',   opts: { needHourlyAlign: true } },
    { id: 'R24-6: + close<EMA50',        opts: { closeBelowEma50: true } },
    { id: 'R24-7: + KST 09-21 active',   opts: { timeKstActive: true } },
    { id: 'R24-8: + funding>0',          opts: { fundingPos: true } },
    { id: 'R24-9: + volZ>1.5',           opts: { volZ: 1.5 } },
    { id: 'R24-10: + 1h align + HA red', opts: { needHourlyAlign: true, haRed: true } },
  ];

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R24 WR_IMPROVE — R23-C base + 추가 filter (safe lib)`);
  L.push(`Base: MTF SHORT + Volume z>1.0 + TP6/SL1/72h`);
  L.push(`Walk-forward: PREV(2024-06~25-06) + CURR(2025-06~26-06)`);
  L.push('='.repeat(150));

  L.push(`\n${pad('variant', 36)} | ${pad('period', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(110));

  interface Row { id: string; period: 'PREV'|'CURR'; stats: ReturnType<typeof statsFor>; }
  const allRows: Row[] = [];

  for (const variant of variants) {
    for (const [period, ctx] of [['PREV', prevCtx], ['CURR', curCtx]] as const) {
      const sigs = mtfShortWithFilters(ctx, fundingDaily, variant.opts);
      const trades = simulateSafe(ctx, sigs, PAYOFF_6_1, COST_RT);
      const s = statsFor(trades);
      allRows.push({ id: variant.id, period, stats: s });
      L.push(`${pad(variant.id, 36)} | ${pad(period, 6)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  // 통과 cell
  L.push(`\n## 양쪽 1년 PF≥1.2 + WR best 정렬\n`);
  const byId = new Map<string, { prev?: Row; curr?: Row }>();
  for (const r of allRows) {
    if (!byId.has(r.id)) byId.set(r.id, {});
    byId.get(r.id)![r.period === 'PREV' ? 'prev' : 'curr'] = r;
  }
  const passing: Array<{ id: string; prev: Row; curr: Row; avgWR: number }> = [];
  for (const [id, pair] of byId) {
    if (!pair.prev || !pair.curr) continue;
    if (pair.prev.stats.pf >= 1.2 && pair.curr.stats.pf >= 1.2) {
      passing.push({ id, prev: pair.prev, curr: pair.curr, avgWR: (pair.prev.stats.wr + pair.curr.stats.wr) / 2 });
    }
  }
  passing.sort((a, b) => b.avgWR - a.avgWR);
  L.push(`${pad('variant', 36)} | ${padS('PREV PF', 8)} | ${padS('CURR PF', 8)} | ${padS('PREV WR', 8)} | ${padS('CURR WR', 8)} | ${padS('avg WR', 8)}`);
  for (const p of passing) {
    L.push(`${pad(p.id, 36)} | ${padS(p.prev.stats.pf.toFixed(2), 8)} | ${padS(p.curr.stats.pf.toFixed(2), 8)} | ${padS(p.prev.stats.wr.toFixed(0)+'%', 8)} | ${padS(p.curr.stats.wr.toFixed(0)+'%', 8)} | ${padS(p.avgWR.toFixed(0)+'%', 8)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R24_WR_IMPROVE.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
