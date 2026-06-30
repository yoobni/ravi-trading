/**
 * R27 NEW_APPROACHES — WR 50%+ 자연스러운 신호 찾기.
 *
 * 라비 지적: WR 30% = 양방향 환경에서 "tracking 못 하는" 것.
 *   payoff trick(작은 loss + 큰 win)으로 net+여도 진짜 directional alpha 아님.
 *
 * 새 접근: mean reversion at extremes + 패턴 인식 + 시간대 효과
 *   - WR 50%+ 자연스러운 신호 = "정보 비대칭" 또는 "비효율" 활용
 *   - 작은 TP + 작은 SL = quick mean reversion
 *
 * 10가지 시도 (양방향, safe lib):
 *   1. RSI < 20 LONG, > 80 SHORT (extreme oversold/overbought)
 *   2. RSI < 25 + 양봉 LONG, > 75 + 음봉 SHORT (extreme + confirmation)
 *   3. BB lower touch with close inside LONG / upper touch with close inside SHORT
 *   4. 3-bar 연속 같은 방향 → 반대 (overextension)
 *   5. Hammer pattern (long lower wick + close > open) LONG
 *      / Shooting star (long upper wick + close < open) SHORT
 *   6. 큰 캔들 (range > ATR×2) 직후 반대 방향 (overreaction)
 *   7. Volume spike (z>3) + price stall → 반대
 *   8. Funding rate change z>2 → 반대 방향
 *   9. KST 09:00 시초가 효과 (한국 active 시작 시 +1~2시간 momentum)
 *   10. 4h pin bar reversal (long wick)
 *
 * Variants: TP 1.0/1.5/2.0 with proportional SL (mean reversion = 작은 보유)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcRSI } from '@/lib/indicators';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe, calcATRSafe,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  D_15M, D_1H, D_4H,
  type SafeContext, type SafeSignal, type Trade, type Variant, type Bar,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;
const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');

interface FundingPoint { ts: number; date: string; rate: number; }

function loadFunding(): { perEvent: FundingPoint[]; daily: Map<string, number> } {
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  funding.sort((a, b) => a.ts - b.ts);
  const m = new Map<string, number>();
  for (const p of funding) m.set(p.date, (m.get(p.date) ?? 0) + p.rate);
  return { perEvent: funding, daily: m };
}

// ─── 10 가지 새 신호 ───

function r1_rsiExtreme(ctx: SafeContext): SafeSignal[] {
  const closes = ctx.bars15m.map(b => b.close);
  const rsi = calcRSI(closes, 14).values;
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const r = rsi[i]; if (r == null) continue;
    const sigTs = signalTs(ctx.bars15m[i], ctx.durationMs15m);
    if (r < 20) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    else if (r > 80) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out;
}

function r2_rsiExtremeConfirm(ctx: SafeContext): SafeSignal[] {
  const closes = ctx.bars15m.map(b => b.close);
  const rsi = calcRSI(closes, 14).values;
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const r = rsi[i]; if (r == null) continue;
    const bar = ctx.bars15m[i];
    const isGreen = bar.close > bar.open;
    const sigTs = signalTs(bar, ctx.durationMs15m);
    if (r < 25 && isGreen) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    else if (r > 75 && !isGreen) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out;
}

function r3_bbTouchInside(ctx: SafeContext): SafeSignal[] {
  const closes = ctx.bars15m.map(b => b.close);
  const period = 20, k = 2;
  const upper: (number|null)[] = new Array(closes.length).fill(null);
  const lower: (number|null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const m = win.reduce((s, v) => s + v, 0) / period;
    const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / period;
    const std = Math.sqrt(v);
    upper[i] = m + k * std;
    lower[i] = m - k * std;
  }
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const u = upper[i], l = lower[i]; if (u == null || l == null) continue;
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    // Touch lower + close back inside
    if (bar.low < l && bar.close > l) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    if (bar.high > u && bar.close < u) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out;
}

function r4_threeConsecutive(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  for (let i = 2; i < ctx.bars15m.length; i++) {
    const a = ctx.bars15m[i - 2], b = ctx.bars15m[i - 1], c = ctx.bars15m[i];
    const aGreen = a.close > a.open, bGreen = b.close > b.open, cGreen = c.close > c.open;
    const sigTs = signalTs(c, ctx.durationMs15m);
    if (aGreen && bGreen && cGreen) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    else if (!aGreen && !bGreen && !cGreen) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
  }
  return out;
}

function r5_hammerStar(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    if (range === 0) continue;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const isGreen = bar.close > bar.open;
    const sigTs = signalTs(bar, ctx.durationMs15m);
    // Hammer: long lower wick (≥2× body), close > open
    if (lowerWick > body * 2 && isGreen && body > 0) {
      out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    }
    // Shooting star: long upper wick (≥2× body), close < open
    else if (upperWick > body * 2 && !isGreen && body > 0) {
      out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    }
  }
  return out;
}

function r6_largeCanleReverse(ctx: SafeContext): SafeSignal[] {
  const atr = calcATRSafe(ctx.bars15m.map(b=>b.high), ctx.bars15m.map(b=>b.low), ctx.bars15m.map(b=>b.close), 14);
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const a = atr[i]; if (a == null) continue;
    const bar = ctx.bars15m[i];
    const range = bar.high - bar.low;
    if (range < a * 2) continue;
    // 큰 캔들 직후 반대 방향 (다음 봉 진입 → 평균 회귀)
    const sigTs = signalTs(bar, ctx.durationMs15m);
    if (bar.close > bar.open) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    else if (bar.close < bar.open) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
  }
  return out;
}

function r7_volumeClimaxStall(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  for (let i = 30; i < ctx.bars15m.length; i++) {
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < 3) continue;
    const bar = ctx.bars15m[i];
    // Body small (small body relative to range) = stall after volume
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    if (range === 0 || body / range > 0.3) continue;
    const sigTs = signalTs(bar, ctx.durationMs15m);
    // Mean reversion direction = 직전 trend 반대. 사용: 직전 5봉 net direction
    const prev5 = ctx.bars15m.slice(Math.max(0, i - 5), i);
    const net = prev5[prev5.length - 1].close - prev5[0].open;
    if (net > 0) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    else if (net < 0) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
  }
  return out;
}

function r8_fundingZ(ctx: SafeContext, fundingPerEvent: FundingPoint[]): SafeSignal[] {
  // Funding rate 변화율 z-score (per 8h event 기준)
  // 각 15m bar에 대해, signal_ts 이전의 가장 최근 funding event 사용
  const out: SafeSignal[] = [];
  const rates = fundingPerEvent.map(f => f.rate);
  // Rolling z-score (last 30 events)
  const fundingZ: number[] = new Array(rates.length).fill(0);
  for (let i = 30; i < rates.length; i++) {
    const win = rates.slice(i - 30, i);
    const m = win.reduce((s, v) => s + v, 0) / 30;
    const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / 30;
    const std = Math.sqrt(v);
    fundingZ[i] = std === 0 ? 0 : (rates[i] - m) / std;
  }
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const sigTs = signalTs(ctx.bars15m[i], ctx.durationMs15m);
    // 가장 최근 funding event (signal_ts 이전)
    let fIdx = -1;
    for (let j = fundingPerEvent.length - 1; j >= 0; j--) {
      if (fundingPerEvent[j].ts <= sigTs) { fIdx = j; break; }
    }
    if (fIdx < 30) continue;
    const z = fundingZ[fIdx];
    if (Math.abs(z) < 2) continue;
    // Funding spike up → SHORT (LONG 과열), down → LONG
    if (z > 2) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
    else out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
  }
  return out;
}

function r9_kstOpen(ctx: SafeContext): SafeSignal[] {
  // KST 09:00 시초가 후 momentum (한국 active 시작)
  // 다음 1~2시간 동안 강한 방향 → 진입
  const out: SafeSignal[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const kstHour = new Date(bar.ts + 9 * 3600_000).getUTCHours();
    const kstMin = new Date(bar.ts + 9 * 3600_000).getUTCMinutes();
    // KST 09:00 시작 봉 (open at 09:00)
    if (kstHour !== 9 || kstMin !== 0) continue;
    const sigTs = signalTs(bar, ctx.durationMs15m);
    // 09:00 봉의 방향 따라
    if (bar.close > bar.open) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'LONG' });
    else if (bar.close < bar.open) out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out;
}

function r10_4hPinBar(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  // 4h pin bar = long wick reversal
  for (let i = 1; i < ctx.bars4h.length; i++) {
    const bar = ctx.bars4h[i];
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    if (range === 0) continue;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const sigTs = bar.ts + ctx.durationMs4h; // 4h bar close 직후
    // Find the 15m bar that starts at/after signal ts
    let lowIdx = -1;
    for (let j = 0; j < ctx.bars15m.length; j++) if (ctx.bars15m[j].ts >= sigTs) { lowIdx = j; break; }
    if (lowIdx < 0) continue;
    if (lowerWick > range * 0.6) out.push({ signalTs: sigTs, signalBarIdx: lowIdx - 1, direction: 'LONG' });
    else if (upperWick > range * 0.6) out.push({ signalTs: sigTs, signalBarIdx: lowIdx - 1, direction: 'SHORT' });
  }
  return out;
}

const RULES: { id: string; fn: (ctx: SafeContext, funding: FundingPoint[]) => SafeSignal[] }[] = [
  { id: 'R27-1: RSI extreme (15m)', fn: (c) => r1_rsiExtreme(c) },
  { id: 'R27-2: RSI extreme + confirm', fn: (c) => r2_rsiExtremeConfirm(c) },
  { id: 'R27-3: BB touch + inside close', fn: (c) => r3_bbTouchInside(c) },
  { id: 'R27-4: 3-bar consecutive → 반대', fn: (c) => r4_threeConsecutive(c) },
  { id: 'R27-5: Hammer / Shooting star', fn: (c) => r5_hammerStar(c) },
  { id: 'R27-6: Large candle reversal', fn: (c) => r6_largeCanleReverse(c) },
  { id: 'R27-7: Volume climax + stall', fn: (c) => r7_volumeClimaxStall(c) },
  { id: 'R27-8: Funding z>2 reversal', fn: (c, f) => r8_fundingZ(c, f) },
  { id: 'R27-9: KST 09:00 momentum', fn: (c) => r9_kstOpen(c) },
  { id: 'R27-10: 4h pin bar reversal', fn: (c) => r10_4hPinBar(c) },
];

// Variants — mean reversion이라 작은 TP/SL
const VARIANTS: Variant[] = [
  { name: 'A_TP0.6_SL0.4_2h',  tp: 0.6, sl: -0.4, maxMin: 120 },
  { name: 'B_TP1.0_SL0.6_4h',  tp: 1.0, sl: -0.6, maxMin: 240 },
  { name: 'C_TP1.5_SL1.0_8h',  tp: 1.5, sl: -1.0, maxMin: 480 },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R27 NEW_APPROACHES — WR 50%+ 도전 ===\n`);
  const curCtx = buildSafeContext('2025-06-09', '2026-06-09')!;
  const prevCtx = buildSafeContext('2024-06-09', '2025-06-09')!;
  const funding = loadFunding();

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R27 NEW_APPROACHES — WR 50%+ 자연스러운 신호 찾기`);
  L.push(`mean reversion + 패턴 + 시간대 효과. Cost RT ${(COST_RT*100).toFixed(1)}%`);
  L.push('='.repeat(150));

  L.push(`\n## 모든 rule × variant × mode (n≥20만 표시)\n`);
  L.push(`${pad('rule × variant × mode', 50)} | ${pad('period', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(140));

  interface Row { id: string; mode: string; period: 'PREV'|'CURR'; stats: ReturnType<typeof statsFor>; }
  const rows: Row[] = [];

  for (const rule of RULES) {
    for (const v of VARIANTS) {
      for (const [period, ctx] of [['PREV', prevCtx], ['CURR', curCtx]] as const) {
        const allSigs = rule.fn(ctx, funding.perEvent).filter(s => inPeriod(s.signalTs, ctx));
        for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
          const sigs = allSigs.filter(s => mode === 'BOTH' || (mode === 'LONG_ONLY' ? s.direction === 'LONG' : s.direction === 'SHORT'));
          const trades = simulateSafe(ctx, sigs, v, COST_RT);
          const s = statsFor(trades);
          if (s.n < 20) continue;
          rows.push({ id: `${rule.id} ${v.name}`, mode, period, stats: s });
        }
      }
    }
  }

  // WR ≥ 50% 정렬
  L.push(`\n## WR ≥ 50% cells (n≥20)\n`);
  L.push(`${pad('cell', 60)} | ${pad('period', 6)} | ${pad('mode', 11)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(130));
  const wrSorted = [...rows].filter(r => r.stats.wr >= 50).sort((a, b) => b.stats.wr - a.stats.wr);
  for (const r of wrSorted.slice(0, 30)) {
    L.push(`${pad(r.id, 60)} | ${pad(r.period, 6)} | ${pad(r.mode, 11)} | ${padS(String(r.stats.n), 4)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 8)} | ${padS(r.stats.pf.toFixed(2), 5)}`);
  }

  // PF 정렬 top
  L.push(`\n\n## PF 정렬 top 20 (n ≥ 20)\n`);
  L.push(`${pad('cell', 60)} | ${pad('period', 6)} | ${pad('mode', 11)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(130));
  const pfSorted = [...rows].sort((a, b) => b.stats.pf - a.stats.pf);
  for (const r of pfSorted.slice(0, 20)) {
    L.push(`${pad(r.id, 60)} | ${pad(r.period, 6)} | ${pad(r.mode, 11)} | ${padS(String(r.stats.n), 4)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 8)} | ${padS(r.stats.pf.toFixed(2), 5)}`);
  }

  // 양쪽 1년 PF≥1.2 통과
  L.push(`\n\n## 양쪽 1년 PF≥1.2 통과 + WR≥45%\n`);
  const groupKey = (r: Row) => `${r.id} ${r.mode}`;
  const byKey = new Map<string, { prev?: Row; curr?: Row }>();
  for (const r of rows) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, {});
    byKey.get(k)![r.period === 'PREV' ? 'prev' : 'curr'] = r;
  }
  L.push(`${pad('cell', 60)} | ${padS('PREV PF', 8)} | ${padS('CURR PF', 8)} | ${padS('PREV WR', 8)} | ${padS('CURR WR', 8)}`);
  L.push('-'.repeat(110));
  for (const [k, pair] of byKey) {
    if (!pair.prev || !pair.curr) continue;
    if (pair.prev.stats.pf >= 1.2 && pair.curr.stats.pf >= 1.2 && pair.prev.stats.wr >= 45 && pair.curr.stats.wr >= 45) {
      L.push(`${pad(k, 60)} | ${padS(pair.prev.stats.pf.toFixed(2), 8)} | ${padS(pair.curr.stats.pf.toFixed(2), 8)} | ${padS(pair.prev.stats.wr.toFixed(0)+'%', 8)} | ${padS(pair.curr.stats.wr.toFixed(0)+'%', 8)}`);
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R27_NEW_APPROACHES.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
