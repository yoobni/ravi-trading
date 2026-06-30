/**
 * R25 — R23-C trade list 기반 자본 sizing / risk analysis.
 *
 * 분석:
 *   1. Equity curve (24개월)
 *   2. Max drawdown (capital 100% / 50% / 25%)
 *   3. Max consecutive losses (streak)
 *   4. Kelly criterion
 *   5. Sharpe-like ratio
 *   6. 1-trade max loss / max win
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

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R25 CAPITAL_SIZING ===\n`);
  const curCtx = buildSafeContext('2025-06-09', '2026-06-09')!;
  const prevCtx = buildSafeContext('2024-06-09', '2025-06-09')!;

  const prevSigs = mtfShortSignals(prevCtx);
  const curSigs = mtfShortSignals(curCtx);
  const prevT = simulateSafe(prevCtx, prevSigs, PAYOFF_6_1, COST_RT);
  const curT = simulateSafe(curCtx, curSigs, PAYOFF_6_1, COST_RT);
  const allT = [...prevT, ...curT].sort((a, b) => a.entryTs - b.entryTs);
  console.log(`Total trades: ${allT.length}`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R25 CAPITAL_SIZING — R23-C 24개월 trade list (n=${allT.length})`);
  L.push('='.repeat(140));

  // ─── 1. Capital sizing별 equity curve ───
  L.push(`\n## 자본 sizing별 24개월 equity curve\n`);
  L.push(`각 trade: equity × sizing × netReturnPct / 100`);
  L.push(`(initial capital 100 단위, 누적 compounding)\n`);
  L.push(`${pad('sizing', 12)} | ${padS('final equity', 14)} | ${padS('total ret', 11)} | ${padS('MDD', 8)} | ${padS('max loss', 9)} | ${padS('max win', 8)}`);
  L.push('-'.repeat(90));
  for (const sizing of [1.0, 0.5, 0.25, 0.1]) {
    let eq = 100; let peak = 100; let mdd = 0;
    let maxLoss = 0, maxWin = 0;
    for (const t of allT) {
      const pnl = eq * sizing * t.netReturnPct / 100;
      eq += pnl;
      if (pnl < maxLoss) maxLoss = pnl;
      if (pnl > maxWin) maxWin = pnl;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > mdd) mdd = dd;
    }
    const totalRet = (eq - 100) / 100 * 100;
    L.push(`${pad((sizing*100).toFixed(0)+'%', 12)} | ${padS(eq.toFixed(2), 14)} | ${padS(fmt(totalRet), 11)} | ${padS(mdd.toFixed(1)+'%', 8)} | ${padS(maxLoss.toFixed(2), 9)} | ${padS(maxWin.toFixed(2), 8)}`);
  }

  // ─── 2. Losing streak ───
  L.push(`\n\n## Consecutive losing streak\n`);
  let curStreak = 0, maxStreak = 0;
  const streaks: number[] = [];
  for (const t of allT) {
    if (t.netReturnPct <= 0) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
    else { if (curStreak > 0) streaks.push(curStreak); curStreak = 0; }
  }
  if (curStreak > 0) streaks.push(curStreak);
  const avgStreak = streaks.length ? streaks.reduce((s, v) => s + v, 0) / streaks.length : 0;
  L.push(`Max losing streak: ${maxStreak}`);
  L.push(`Avg losing streak (when in streak): ${avgStreak.toFixed(2)}`);
  L.push(`Total losing streaks (≥1): ${streaks.length}`);
  const streakDist: Record<number, number> = {};
  for (const s of streaks) streakDist[s] = (streakDist[s] ?? 0) + 1;
  L.push(`Streak distribution:`);
  for (const k of Object.keys(streakDist).map(Number).sort((a, b) => a - b)) {
    L.push(`  ${k}-streak: ${streakDist[k]}회`);
  }

  // ─── 3. Kelly criterion ───
  L.push(`\n\n## Kelly criterion`);
  const wins = allT.filter(t => t.netReturnPct > 0);
  const losses = allT.filter(t => t.netReturnPct <= 0);
  const wr = wins.length / allT.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length) : 0;
  const b = avgWin / avgLoss; // odds
  const kelly = wr - (1 - wr) / b;
  L.push(`\nWR=${(wr*100).toFixed(1)}%, avgWin=${avgWin.toFixed(2)}%, avgLoss=${avgLoss.toFixed(2)}%`);
  L.push(`Odds (b) = avgWin/avgLoss = ${b.toFixed(2)}`);
  L.push(`Kelly fraction (full) = ${(kelly*100).toFixed(1)}%`);
  L.push(`Kelly fraction (half, 안전) = ${(kelly/2*100).toFixed(1)}%`);
  L.push(`Kelly fraction (quarter) = ${(kelly/4*100).toFixed(1)}%`);

  // ─── 4. Return distribution ───
  L.push(`\n\n## Trade return 분포\n`);
  const buckets: Record<string, number> = {
    '<-1.5%': 0, '-1.5~-1%': 0, '-1~0%': 0, '0~+1%': 0, '+1~+3%': 0, '+3~+5%': 0, '+5%+': 0,
  };
  for (const t of allT) {
    const r = t.netReturnPct;
    if (r < -1.5) buckets['<-1.5%']++;
    else if (r < -1) buckets['-1.5~-1%']++;
    else if (r < 0) buckets['-1~0%']++;
    else if (r < 1) buckets['0~+1%']++;
    else if (r < 3) buckets['+1~+3%']++;
    else if (r < 5) buckets['+3~+5%']++;
    else buckets['+5%+']++;
  }
  for (const k of Object.keys(buckets)) {
    L.push(`  ${pad(k, 12)}: ${buckets[k]}회 (${(buckets[k]/allT.length*100).toFixed(1)}%)`);
  }

  // ─── 5. Exit reason 분포 ───
  L.push(`\n\n## Exit reason 분포\n`);
  for (const reason of ['TP', 'SL', 'TIME'] as const) {
    const cnt = allT.filter(t => t.reason === reason).length;
    const ret = allT.filter(t => t.reason === reason).reduce((s, t) => s + t.netReturnPct, 0);
    L.push(`  ${reason}: ${cnt}회 (${(cnt/allT.length*100).toFixed(0)}%), total ${fmt(ret)}`);
  }

  // ─── 6. Sharpe-like ratio ───
  const totalRet = allT.reduce((s, t) => s + t.netReturnPct, 0);
  const meanRet = totalRet / allT.length;
  const variance = allT.reduce((s, t) => s + (t.netReturnPct - meanRet) ** 2, 0) / allT.length;
  const std = Math.sqrt(variance);
  L.push(`\n\n## Sharpe-like (per trade)\n`);
  L.push(`Mean return per trade: ${meanRet.toFixed(3)}%`);
  L.push(`Std per trade: ${std.toFixed(3)}%`);
  L.push(`Sharpe-like = mean/std = ${(meanRet/std).toFixed(3)}`);
  L.push(`(주의: 위는 per-trade Sharpe. 표준 Sharpe는 시간 단위 정규화 필요)`);

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R25_SIZING.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
