/**
 * R22 NO_LOOKAHEAD — R21 lookahead bug 수정 후 재검증.
 *
 * Bug:
 *   get4hTrend가 진행 중인 4h bar의 close 사용 (미래 정보)
 *
 * Fix:
 *   "완전히 종료된 가장 최근 4h bar" 사용
 *   = bars4h[i].ts + 4시간 ≤ signal ts
 *
 * 재검증:
 *   - R19-5 24개월 월별
 *   - Walk-forward PREV vs CURR
 *   - Cost stress
 *   - 자본 sizing (best variant)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const PERIOD_CUR = { start: '2025-06-09', end: '2026-06-09' };
const PERIOD_PREV = { start: '2024-06-09', end: '2025-06-09' };

const COST_RT = 0.002;
const FOUR_HOURS_MS = 4 * 3600_000;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const PAYOFF_3_1: Variant = { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 };

function load(file: string): Bar[] | null {
  const fp = path.join(CACHE_DIR, file);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}
function aggregate(bars1m: Bar[], minutes: number): Bar[] {
  const buckets = new Map<number, Bar[]>();
  const slot = minutes * 60_000;
  for (const b of bars1m) {
    const k = Math.floor(b.ts / slot) * slot;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(b);
  }
  const out: Bar[] = [];
  for (const [ts, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length === 0) continue;
    out.push({
      ts, date: new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
      open: bs[0].open, high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)), close: bs[bs.length - 1].close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}
function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }
function find1mIdx(bars: Bar[], ts: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].ts < ts) lo = mid + 1; else hi = mid; }
  return lo;
}

interface ExitResult { exitTs: number; exitPrice: number; reason: 'TP'|'SL'|'TIME'; rawReturnPct: number; }
function pathVerify(bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number, direction: Direction, v: Variant): ExitResult {
  const tpPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.tp / 100) : entryPriceRaw * (1 - v.tp / 100);
  const slPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.sl / 100) : entryPriceRaw * (1 - v.sl / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsed = (bar.ts - entryTs) / 60_000;
    if (direction === 'LONG') {
      if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl };
      if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp };
    } else {
      if (bar.high >= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl };
      if (bar.low <= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp };
    }
    if (elapsed >= v.maxMin) {
      const ret = direction === 'LONG' ? (bar.close - entryPriceRaw)/entryPriceRaw*100 : (entryPriceRaw - bar.close)/entryPriceRaw*100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG' ? (last.close - entryPriceRaw)/entryPriceRaw*100 : (entryPriceRaw - last.close)/entryPriceRaw*100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret };
}

interface SignalEvent { ts: number; direction: Direction; }
interface Ctx {
  periodStart: string; periodEnd: string;
  bars1m: Bar[]; bars15m: Bar[]; bars4h: Bar[];
  ema20: (number|null)[]; ema50_4h: (number|null)[];
  barsByTs: Map<number, number>;
}
function inAnalysis(ts: number, ctx: Ctx): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ctx.periodStart && d <= ctx.periodEnd;
}
function buildCtx(periodStart: string, periodEnd: string): Ctx | null {
  const bars1m = load(`BINANCE_PERP_BTCUSDT_1m_${periodStart}_${periodEnd}.json`);
  if (!bars1m) return null;
  const bars15m = aggregate(bars1m, 15);
  const bars4h = aggregate(bars1m, 240);
  const closes15 = bars15m.map(b => b.close);
  return {
    periodStart, periodEnd, bars1m, bars15m, bars4h,
    ema20: calcEMA(closes15, 20),
    ema50_4h: calcEMA(bars4h.map(b => b.close), 50),
    barsByTs: new Map(bars15m.map((b, i) => [b.ts, i])),
  };
}

// ★ FIXED: 완전히 종료된 가장 최근 4h bar 사용
function mtfBaseFIXED(ctx: Ctx): SignalEvent[] {
  const out: SignalEvent[] = [];
  function get4hTrend(ts: number): 1 | -1 | null {
    let idx = -1;
    for (let i = ctx.bars4h.length - 1; i >= 0; i--) {
      // bar i는 [ts, ts+4h) 구간. ts+4h <= signal ts 인 가장 최근 bar (완전 종료)
      if (ctx.bars4h[i].ts + FOUR_HOURS_MS <= ts) { idx = i; break; }
    }
    if (idx < 0) return null;
    const e = ctx.ema50_4h[idx]; if (e == null) return null;
    if (ctx.bars4h[idx].close > e) return 1;
    if (ctx.bars4h[idx].close < e) return -1;
    return null;
  }
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const trend = get4hTrend(ctx.bars15m[i].ts);
    if (!trend) continue;
    const e = ctx.ema20[i], ep = ctx.ema20[i - 1];
    if (e == null || ep == null) continue;
    const prev = ctx.bars15m[i - 1], cur = ctx.bars15m[i];
    if (trend === 1 && prev.close < ep && cur.close > e) out.push({ ts: cur.ts, direction: 'LONG' });
    if (trend === -1 && prev.close > ep && cur.close < e) out.push({ ts: cur.ts, direction: 'SHORT' });
  }
  return out;
}

// 원래 BUG 버전 (비교용)
function mtfBaseBUGGY(ctx: Ctx): SignalEvent[] {
  const out: SignalEvent[] = [];
  function get4hTrend(ts: number): 1 | -1 | null {
    let idx = -1;
    for (let i = ctx.bars4h.length - 1; i >= 0; i--) if (ctx.bars4h[i].ts <= ts) { idx = i; break; }
    if (idx < 0) return null;
    const e = ctx.ema50_4h[idx]; if (e == null) return null;
    if (ctx.bars4h[idx].close > e) return 1;
    if (ctx.bars4h[idx].close < e) return -1;
    return null;
  }
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const trend = get4hTrend(ctx.bars15m[i].ts);
    if (!trend) continue;
    const e = ctx.ema20[i], ep = ctx.ema20[i - 1];
    if (e == null || ep == null) continue;
    const prev = ctx.bars15m[i - 1], cur = ctx.bars15m[i];
    if (trend === 1 && prev.close < ep && cur.close > e) out.push({ ts: cur.ts, direction: 'LONG' });
    if (trend === -1 && prev.close > ep && cur.close < e) out.push({ ts: cur.ts, direction: 'SHORT' });
  }
  return out;
}

function filterVolume(s: SignalEvent[], ctx: Ctx, zThresh = 1.0): SignalEvent[] {
  return s.filter((sig) => {
    const i = ctx.barsByTs.get(sig.ts); if (i == null || i < 30) return false;
    const win = ctx.bars15m.slice(i - 30, i).map((b) => b.volume);
    const m = win.reduce((sm, v) => sm + v, 0) / 30;
    const va = win.reduce((sm, x) => sm + (x - m) ** 2, 0) / 30;
    const std = Math.sqrt(va);
    const z = std === 0 ? 0 : (ctx.bars15m[i].volume - m) / std;
    return z >= zThresh;
  });
}

interface Trade {
  direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP'|'SL'|'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}
function statsFor(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, avgWin: 0, avgLoss: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const wr = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
  const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  return { n, wr, avgWin, avgLoss, total, pf };
}

function simulate(ctx: Ctx, signals: SignalEvent[], v: Variant, cost: number): Trade[] {
  const trades: Trade[] = [];
  let cooldownTs = 0;
  for (const sig of signals) {
    if (!inAnalysis(sig.ts, ctx)) continue;
    if (sig.ts < cooldownTs) continue;
    const nextSlotTs = Math.floor((sig.ts + 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(ctx.bars1m, nextSlotTs);
    if (startIdx >= ctx.bars1m.length) continue;
    const entryBar = ctx.bars1m[startIdx];
    const exit = pathVerify(ctx.bars1m, startIdx, entryBar.ts, entryBar.open, sig.direction, v);
    const netRet = exit.rawReturnPct - cost * 100;
    trades.push({
      direction: sig.direction,
      entryTs: entryBar.ts, entryPrice: entryBar.open,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey: new Date(sig.ts + 9 * 3600_000).toISOString().slice(0, 7),
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

function monthList(start: string, end: string): string[] {
  const out: string[] = [];
  let y = parseInt(start.slice(0, 4)); let m = parseInt(start.slice(5, 7));
  const endY = parseInt(end.slice(0, 4)); const endM = parseInt(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${m.toString().padStart(2, '0')}`); m++;
    if (m > 12) { y++; m = 1; }
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R22 NO_LOOKAHEAD (bug fix) ===\n`);
  const curCtx = buildCtx(PERIOD_CUR.start, PERIOD_CUR.end)!;
  const prevCtx = buildCtx(PERIOD_PREV.start, PERIOD_PREV.end)!;
  console.log(`Current: ${curCtx.bars1m.length} bars, Prev: ${prevCtx.bars1m.length} bars\n`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R22 NO_LOOKAHEAD — 4h trend bug 수정 후 R19-5 재검증`);
  L.push(`Fix: bars4h[idx].ts + 4h ≤ signal ts (완전 종료된 4h bar만 사용)`);
  L.push('='.repeat(140));

  // ───── Phase 1: BUGGY vs FIXED 비교 (current 1년) ─────
  L.push(`\n## Phase 1 — BUGGY vs FIXED 비교 (current 1년, SHORT only, R19-5 룰)\n`);
  L.push(`${pad('version', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(75));

  const buggyCur = filterVolume(mtfBaseBUGGY(curCtx), curCtx, 1.0).filter(s => s.direction === 'SHORT');
  const fixedCur = filterVolume(mtfBaseFIXED(curCtx), curCtx, 1.0).filter(s => s.direction === 'SHORT');
  const buggyCurTrades = simulate(curCtx, buggyCur, PAYOFF_3_1, COST_RT);
  const fixedCurTrades = simulate(curCtx, fixedCur, PAYOFF_3_1, COST_RT);
  const bS = statsFor(buggyCurTrades); const fS = statsFor(fixedCurTrades);
  L.push(`${pad('BUGGY', 12)} | ${padS(String(bS.n), 4)} | ${padS(bS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(bS.avgWin), 7)} | ${padS(fmt(bS.avgLoss), 7)} | ${padS(fmt(bS.total), 8)} | ${padS(bS.pf.toFixed(2), 5)}`);
  L.push(`${pad('FIXED', 12)} | ${padS(String(fS.n), 4)} | ${padS(fS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(fS.avgWin), 7)} | ${padS(fmt(fS.avgLoss), 7)} | ${padS(fmt(fS.total), 8)} | ${padS(fS.pf.toFixed(2), 5)}`);

  // ───── Phase 2: FIXED 24개월 월별 ─────
  L.push(`\n\n## Phase 2 — FIXED 24개월 월별 (R19-5 룰 lookahead 없이)\n`);
  L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
  L.push('-'.repeat(85));
  const fixedPrev = filterVolume(mtfBaseFIXED(prevCtx), prevCtx, 1.0).filter(s => s.direction === 'SHORT');
  const fixedPrevTrades = simulate(prevCtx, fixedPrev, PAYOFF_3_1, COST_RT);
  const allTrades = [...fixedPrevTrades, ...fixedCurTrades];
  const byMonth = new Map<string, Trade[]>();
  for (const t of allTrades) {
    if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
    byMonth.get(t.monthKey)!.push(t);
  }
  let cum = 0; let posMonths = 0; let totalMonths = 0;
  for (const mk of monthList('2024-06', '2026-06')) {
    const ts = byMonth.get(mk) ?? [];
    const s = statsFor(ts);
    cum += s.total;
    if (s.n > 0) { totalMonths++; if (s.total > 0) posMonths++; }
    if (s.n === 0) L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
    else L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
  }
  const totalAll = statsFor(allTrades);
  L.push(`${pad('TOTAL', 8)} | ${padS(String(totalAll.n), 3)} | ${padS(totalAll.wr.toFixed(0)+'%', 5)} | ${padS(fmt(totalAll.avgWin), 7)} | ${padS(fmt(totalAll.avgLoss), 7)} | ${padS(fmt(totalAll.total), 8)} | ${padS(totalAll.pf.toFixed(2), 5)} | ${padS(fmt(totalAll.total), 8)}`);
  L.push(`\n양수 월: ${posMonths}/${totalMonths} (${totalMonths ? (posMonths/totalMonths*100).toFixed(0) : 0}%)`);

  // ───── Phase 3: Cost stress (FIXED) ─────
  L.push(`\n\n## Phase 3 — Cost stress (FIXED, current 1년, SHORT only)\n`);
  L.push(`${pad('config × cost', 28)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(70));
  const configs = [
    { name: 'FIXED base + payoff 3:1', sigs: fixedCur, v: PAYOFF_3_1 },
    { name: 'FIXED + payoff 5:1', sigs: fixedCur, v: { name: 'TP5_SL1_48h', tp: 5, sl: -1, maxMin: 2880 } },
    { name: 'FIXED + payoff 6:1', sigs: fixedCur, v: { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 } },
  ];
  for (const cfg of configs) {
    for (const cost of [0.002, 0.003, 0.005]) {
      const t = simulate(curCtx, cfg.sigs, cfg.v, cost);
      const s = statsFor(t);
      L.push(`${pad(`${cfg.name} @${(cost*100).toFixed(1)}%`, 28)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  // ───── Phase 4: Walk-forward (FIXED) ─────
  L.push(`\n## Phase 4 — Walk-forward (FIXED, SHORT only)\n`);
  L.push(`${pad('period × variant', 28)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(70));
  for (const v of [
    { name: 'TP3_SL1_12h', tp: 3, sl: -1, maxMin: 720 },
    { name: 'TP5_SL1_48h', tp: 5, sl: -1, maxMin: 2880 },
    { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 },
  ]) {
    const pT = simulate(prevCtx, fixedPrev, v, COST_RT);
    const cT = simulate(curCtx, fixedCur, v, COST_RT);
    const pS = statsFor(pT); const cS = statsFor(cT);
    L.push(`${pad(`PREV ${v.name}`, 28)} | ${padS(String(pS.n), 4)} | ${padS(pS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(pS.total), 8)} | ${padS(pS.pf.toFixed(2), 5)}`);
    L.push(`${pad(`CURR ${v.name}`, 28)} | ${padS(String(cS.n), 4)} | ${padS(cS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(cS.total), 8)} | ${padS(cS.pf.toFixed(2), 5)}`);
    L.push('');
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R22_NO_LOOKAHEAD.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
