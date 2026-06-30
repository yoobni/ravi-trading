/**
 * R23 — _safe.ts 사용해서 R19-5 + TP6:1 진짜 lookahead-free 재검증.
 *
 * 룰 (모두 safe contract):
 *   1. 15m bar i가 close된 직후 (signal_ts = bar.ts + 15min) 평가
 *   2. 4h trend: signal_ts에서 가장 최근 "완전히 종료된" 4h bar의 close vs 4h EMA50
 *      → bars4h[idx].ts + 4h ≤ signal_ts
 *   3. 15m EMA20 cross: prev close < ema_prev AND cur close > ema_cur (또는 반대)
 *   4. Volume z(30봉, inclusive): bars[i-29..i].volume z-score > 1.0
 *   5. Entry: 다음 15m bar의 open (= bars[i+1].open)
 *   6. Exit: 1m path verified (TP/SL/MAX)
 *
 * Variants:
 *   A. TP3/SL1_12h  (R19-5 base)
 *   B. TP5/SL1_48h
 *   C. TP6/SL1_72h  (R22 best)
 *   D. TP6/SL1 + cooldown +1h
 *   E. TP6/SL1 + Volume z>1.5
 *   F. TP6/SL1 + Volume z>2.0
 *   G. TP8/SL1_120h
 *   H. TP6/SL1 + 1h trend confirm (4h 1h 같은 방향)
 *
 * Period:
 *   PREV: 2024-06-09 ~ 2025-06-09
 *   CURR: 2025-06-09 ~ 2026-06-09
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS, monthList,
  D_15M, D_1H, D_4H,
  type SafeContext, type SafeSignal, type Trade, type Variant,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;

// ─── 신호 평가 (lookahead-safe) ───

function mtfShortSignals(ctx: SafeContext, opts: { needHourlyAlign?: boolean; volZThresh?: number } = {}): SafeSignal[] {
  const zThresh = opts.volZThresh ?? 1.0;
  const out: SafeSignal[] = [];

  // pre-compute indicators
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  const closes1h = ctx.bars1h.map(b => b.close);
  const ema50_1h = opts.needHourlyAlign ? calcEMASafe(closes1h, 50) : null;

  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);  // bar i가 close된 직후

    // 4h trend: 가장 최근 완전히 종료된 4h bar
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null) continue;
    const trend4h = ctx.bars4h[idx4h].close > e4h ? 1 : (ctx.bars4h[idx4h].close < e4h ? -1 : 0);
    if (trend4h !== -1) continue;  // SHORT only: 4h downtrend 필요

    // (옵션) 1h trend confirm
    if (opts.needHourlyAlign && ema50_1h) {
      const idx1h = latestClosedBarIdx(ctx.bars1h, ctx.durationMs1h, sigTs);
      if (idx1h < 0) continue;
      const e1h = ema50_1h[idx1h];
      if (e1h == null) continue;
      const trend1h = ctx.bars1h[idx1h].close > e1h ? 1 : (ctx.bars1h[idx1h].close < e1h ? -1 : 0);
      if (trend1h !== -1) continue;
    }

    // 15m EMA20 cross down: prev close > ema(prev), cur close < ema(cur)
    const ePrev = ema20_15[i - 1];
    const eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    if (!(prev.close > ePrev && bar.close < eCur)) continue;

    // Volume z-score (inclusive, bars[i-29..i])
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < zThresh) continue;

    out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out
    .filter((s) => inPeriod(s.signalTs, ctx))
    .sort((a, b) => a.signalTs - b.signalTs);
}

// ─── Variants 정의 ───
const VARIANTS: Array<{ id: string; v: Variant; opts?: { volZThresh?: number; needHourlyAlign?: boolean; cooldownMs?: number; cost?: number; } }> = [
  { id: 'A_TP3:1_12h',          v: { name: 'TP3_SL1_12h',  tp: 3, sl: -1, maxMin: 720 } },
  { id: 'B_TP5:1_48h',          v: { name: 'TP5_SL1_48h',  tp: 5, sl: -1, maxMin: 2880 } },
  { id: 'C_TP6:1_72h',          v: { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 } },
  { id: 'D_TP6:1 + cd 1h',      v: { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 }, opts: { cooldownMs: 60 * 60_000 } },
  { id: 'E_TP6:1 + volZ1.5',    v: { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 }, opts: { volZThresh: 1.5 } },
  { id: 'F_TP6:1 + volZ2.0',    v: { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 }, opts: { volZThresh: 2.0 } },
  { id: 'G_TP8:1_120h',         v: { name: 'TP8_SL1_120h', tp: 8, sl: -1, maxMin: 7200 } },
  { id: 'H_TP6:1 + 1h align',   v: { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 }, opts: { needHourlyAlign: true } },
];

function periodMonths(start: string, end: string): string[] {
  return monthList(start, end);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R23 SAFE_VALIDATION (lookahead-free) ===\n`);

  const curCtx = buildSafeContext('2025-06-09', '2026-06-09')!;
  const prevCtx = buildSafeContext('2024-06-09', '2025-06-09')!;
  console.log(`CURR: 1m=${curCtx.bars1m.length}, 15m=${curCtx.bars15m.length}, 1h=${curCtx.bars1h.length}, 4h=${curCtx.bars4h.length}`);
  console.log(`PREV: 1m=${prevCtx.bars1m.length}, 15m=${prevCtx.bars15m.length}, 1h=${prevCtx.bars1h.length}, 4h=${prevCtx.bars4h.length}\n`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R23 SAFE_VALIDATION — lookahead-free (_safe.ts lib)`);
  L.push(`signal_ts = bar.ts + bar.duration (close 직후)`);
  L.push(`4h trend = latest closed 4h bar (bar.ts + 4h ≤ signal_ts)`);
  L.push(`Entry = next 15m bar open. 1m path verify. Cost RT ${(COST_RT*100).toFixed(1)}%.`);
  L.push('='.repeat(140));

  // ───── Phase 1: Walk-forward 모든 variant ─────
  L.push(`\n## Phase 1 — Walk-forward (모든 variant, SHORT only, MTF + Volume z>1.0)\n`);
  L.push(`${pad('variant', 28)} | ${pad('period', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));

  // 결과 누적 (best 후보 선정용)
  interface Row { id: string; period: 'PREV'|'CURR'; stats: ReturnType<typeof statsFor>; }
  const allRows: Row[] = [];

  for (const variant of VARIANTS) {
    const opts = variant.opts ?? {};
    for (const [period, ctx] of [['PREV', prevCtx], ['CURR', curCtx]] as const) {
      const signals = mtfShortSignals(ctx, { volZThresh: opts.volZThresh, needHourlyAlign: opts.needHourlyAlign });
      const trades = simulateSafe(ctx, signals, variant.v, COST_RT, { cooldownMs: opts.cooldownMs });
      const s = statsFor(trades);
      allRows.push({ id: variant.id, period, stats: s });
      L.push(`${pad(variant.id, 28)} | ${pad(period, 6)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  // ───── Phase 2: 두 1년 모두 PF≥1.2 통과 cell ─────
  L.push(`\n## Phase 2 — 양쪽 1년 PF≥1.2 통과 cell\n`);
  const byId = new Map<string, { prev?: Row; curr?: Row }>();
  for (const r of allRows) {
    if (!byId.has(r.id)) byId.set(r.id, {});
    byId.get(r.id)![r.period === 'PREV' ? 'prev' : 'curr'] = r;
  }
  L.push(`${pad('variant', 28)} | ${padS('PREV PF', 8)} | ${padS('CURR PF', 8)} | 양쪽통과 | ${padS('PREV total', 11)} | ${padS('CURR total', 11)}`);
  L.push('-'.repeat(100));
  for (const [id, pair] of byId) {
    const p = pair.prev?.stats; const c = pair.curr?.stats;
    if (!p || !c) continue;
    const pass = p.pf >= 1.2 && c.pf >= 1.2;
    L.push(`${pad(id, 28)} | ${padS(p.pf.toFixed(2), 8)} | ${padS(c.pf.toFixed(2), 8)} | ${padS(pass ? '✓' : '✗', 8)} | ${padS(fmt(p.total), 11)} | ${padS(fmt(c.total), 11)}`);
  }

  // ───── Phase 3: 24개월 best variant 월별 ─────
  L.push(`\n## Phase 3 — 24개월 월별 (variant C: TP6:1 base)\n`);
  const bestVariant = VARIANTS.find(v => v.id === 'C_TP6:1_72h')!;
  const prevSigs = mtfShortSignals(prevCtx, {});
  const curSigs = mtfShortSignals(curCtx, {});
  const prevTrades = simulateSafe(prevCtx, prevSigs, bestVariant.v, COST_RT, {});
  const curTrades = simulateSafe(curCtx, curSigs, bestVariant.v, COST_RT, {});
  const allTrades = [...prevTrades, ...curTrades];
  const byMonth = new Map<string, Trade[]>();
  for (const t of allTrades) {
    if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
    byMonth.get(t.monthKey)!.push(t);
  }
  L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
  L.push('-'.repeat(85));
  let cum = 0; let posMonths = 0; let totalMonths = 0;
  for (const mk of monthList('2024-06', '2026-06')) {
    const ts = byMonth.get(mk) ?? [];
    const s = statsFor(ts); cum += s.total;
    if (s.n > 0) { totalMonths++; if (s.total > 0) posMonths++; }
    if (s.n === 0) L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
    else L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
  }
  const totAll = statsFor(allTrades);
  L.push(`${pad('TOTAL', 8)} | ${padS(String(totAll.n), 3)} | ${padS(totAll.wr.toFixed(0)+'%', 5)} | ${padS(fmt(totAll.avgWin), 7)} | ${padS(fmt(totAll.avgLoss), 7)} | ${padS(fmt(totAll.total), 8)} | ${padS(totAll.pf.toFixed(2), 5)} | ${padS(fmt(totAll.total), 8)}`);
  L.push(`\n양수 월: ${posMonths}/${totalMonths} (${totalMonths ? Math.round(posMonths/totalMonths*100) : 0}%)`);

  // ───── Phase 4: TP6:1 cost stress ─────
  L.push(`\n\n## Phase 4 — TP6:1 cost stress (CURR 1년)\n`);
  L.push(`${pad('cost', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(50));
  for (const cost of [0.002, 0.003, 0.005]) {
    const t = simulateSafe(curCtx, curSigs, bestVariant.v, cost, {});
    const s = statsFor(t);
    L.push(`${pad((cost*100).toFixed(1)+'%', 6)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R23_SAFE.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
