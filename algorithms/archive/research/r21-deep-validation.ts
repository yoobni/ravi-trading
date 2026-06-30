/**
 * R21 DEEP_VALIDATION — R19-5 (MTF + Volume SHORT) 심층 검증 + 새 변형.
 *
 * Phase 1: 24개월 (2024-06~2026-06) 월별 R19-5 일관성
 * Phase 2: 다른 base × Volume 조합 walk-forward (Volume이 핵심인지 검증)
 * Phase 3: cost 0.5% 살아남는 변형 탐색 (더 strict + 더 큰 payoff)
 * Phase 4: cooldown 변형 (15m/30m/1h/4h)
 * Phase 5: 자본 sizing은 별도 후속 (이번엔 trade 기준 raw return만)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const PERIOD_CUR = { start: '2025-06-09', end: '2026-06-09' };
const PERIOD_PREV = { start: '2024-06-09', end: '2025-06-09' };

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }

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
function percentile(arr: number[], p: number): number {
  const s = [...arr].filter((v) => !Number.isNaN(v) && v != null).sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
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
  ema20: (number|null)[]; ema50_15: (number|null)[];
  atr15: (number|null)[]; ema50_4h: (number|null)[];
  atrP33: number; atrP67: number;
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
  const atr15 = calcATR(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15, 14);
  const atrValid = atr15.filter((v): v is number => v != null);
  return {
    periodStart, periodEnd, bars1m, bars15m, bars4h,
    ema20: calcEMA(closes15, 20),
    ema50_15: calcEMA(closes15, 50),
    atr15, ema50_4h: calcEMA(bars4h.map(b => b.close), 50),
    atrP33: percentile(atrValid, 33),
    atrP67: percentile(atrValid, 67),
    barsByTs: new Map(bars15m.map((b, i) => [b.ts, i])),
  };
}

function mtfBase(ctx: Ctx): SignalEvent[] {
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

// 다른 base들
function cciBase(ctx: Ctx): SignalEvent[] {
  const out: SignalEvent[] = [];
  const tp = ctx.bars15m.map(b => (b.high + b.low + b.close) / 3);
  const period = 20;
  const cci: (number|null)[] = new Array(tp.length).fill(null);
  for (let i = period - 1; i < tp.length; i++) {
    const win = tp.slice(i - period + 1, i + 1);
    const sma = win.reduce((s, v) => s + v, 0) / period;
    const md = win.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    cci[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const c = cci[i], p = cci[i - 1];
    if (c == null || p == null) continue;
    if (p > -100 && c <= -100) out.push({ ts: ctx.bars15m[i].ts, direction: 'LONG' });
    if (p < 100 && c >= 100) out.push({ ts: ctx.bars15m[i].ts, direction: 'SHORT' });
  }
  return out;
}
function bbBase(ctx: Ctx): SignalEvent[] {
  // BB(20, 2) outside close then reversal
  const closes = ctx.bars15m.map(b => b.close);
  const period = 20; const k = 2;
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
  const out: SignalEvent[] = [];
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const u = upper[i], l = lower[i], up = upper[i - 1], lp = lower[i - 1];
    if (u == null || l == null || up == null || lp == null) continue;
    const prev = ctx.bars15m[i - 1], cur = ctx.bars15m[i];
    if (prev.close > up && cur.close < u) out.push({ ts: cur.ts, direction: 'SHORT' });
    if (prev.close < lp && cur.close > l) out.push({ ts: cur.ts, direction: 'LONG' });
  }
  return out;
}

// Volume filter
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
function filterAtrMid(s: SignalEvent[], ctx: Ctx): SignalEvent[] {
  return s.filter((sig) => {
    const i = ctx.barsByTs.get(sig.ts); if (i == null) return false;
    const a = ctx.atr15[i]; if (a == null) return false;
    return a > ctx.atrP33 && a < ctx.atrP67;
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

function simulate(ctx: Ctx, signals: SignalEvent[], v: Variant, cost: number, cooldownMs = 0): Trade[] {
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
    cooldownTs = exit.exitTs + cooldownMs;
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

  console.log(`\n=== R21 DEEP_VALIDATION ===\n`);
  const curCtx = buildCtx(PERIOD_CUR.start, PERIOD_CUR.end)!;
  const prevCtx = buildCtx(PERIOD_PREV.start, PERIOD_PREV.end)!;
  console.log(`Current: ${curCtx.bars1m.length} bars`);
  console.log(`Prev: ${prevCtx.bars1m.length} bars\n`);

  const PAYOFF_3_1: Variant = { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 };

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R21 DEEP_VALIDATION — R19-5 (MTF + Volume SHORT) 심층 검증`);
  L.push('='.repeat(140));

  // ───── Phase 1: 24개월 월별 ─────
  L.push(`\n\n## Phase 1 — R19-5 SHORT 24개월 월별 (2024-06 ~ 2026-06)\n`);
  L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
  L.push('-'.repeat(85));

  const prevBase = mtfBase(prevCtx);
  const curBase = mtfBase(curCtx);
  const prevSigs = filterVolume(prevBase, prevCtx, 1.0).filter(s => s.direction === 'SHORT');
  const curSigs = filterVolume(curBase, curCtx, 1.0).filter(s => s.direction === 'SHORT');
  const prevTrades = simulate(prevCtx, prevSigs, PAYOFF_3_1, 0.002);
  const curTrades = simulate(curCtx, curSigs, PAYOFF_3_1, 0.002);
  const allTrades = [...prevTrades, ...curTrades];
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
    if (s.n === 0) {
      L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
    } else {
      L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
    }
  }
  const totalAll = statsFor(allTrades);
  L.push(`${pad('TOTAL', 8)} | ${padS(String(totalAll.n), 3)} | ${padS(totalAll.wr.toFixed(0)+'%', 5)} | ${padS(fmt(totalAll.avgWin), 7)} | ${padS(fmt(totalAll.avgLoss), 7)} | ${padS(fmt(totalAll.total), 8)} | ${padS(totalAll.pf.toFixed(2), 5)} | ${padS(fmt(totalAll.total), 8)}`);
  L.push(`\n양수 월: ${posMonths}/${totalMonths} (${(posMonths/totalMonths*100).toFixed(0)}%)`);

  // ───── Phase 2: 다른 base × Volume walk-forward ─────
  L.push(`\n\n## Phase 2 — 다른 base × Volume z>1.0 walk-forward (SHORT only)\n`);
  L.push(`${pad('base × period', 26)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(75));
  const bases: Array<{ name: string; fn: (ctx: Ctx) => SignalEvent[] }> = [
    { name: 'MTF_TREND (ref)', fn: mtfBase },
    { name: 'CCI', fn: cciBase },
    { name: 'BB_REJECT', fn: bbBase },
  ];
  for (const b of bases) {
    const pSigs = filterVolume(b.fn(prevCtx), prevCtx, 1.0).filter(s => s.direction === 'SHORT');
    const cSigs = filterVolume(b.fn(curCtx), curCtx, 1.0).filter(s => s.direction === 'SHORT');
    const pT = simulate(prevCtx, pSigs, PAYOFF_3_1, 0.002);
    const cT = simulate(curCtx, cSigs, PAYOFF_3_1, 0.002);
    const pS = statsFor(pT); const cS = statsFor(cT);
    L.push(`${pad(`${b.name} PREV`, 26)} | ${padS(String(pS.n), 4)} | ${padS(pS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(pS.total), 8)} | ${padS(pS.pf.toFixed(2), 5)}`);
    L.push(`${pad(`${b.name} CURR`, 26)} | ${padS(String(cS.n), 4)} | ${padS(cS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(cS.total), 8)} | ${padS(cS.pf.toFixed(2), 5)}`);
    L.push('');
  }

  // ───── Phase 3: cost 0.5% 견디는 변형 탐색 (R19-5 base) ─────
  L.push(`\n## Phase 3 — cost 0.5% 견디는 R19-5 변형 (current 1년, SHORT only)\n`);
  L.push(`${pad('variant', 28)} | ${pad('add filter', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(95));

  const r5Base = filterVolume(mtfBase(curCtx), curCtx, 1.0).filter(s => s.direction === 'SHORT');
  const r5AtrMid = filterAtrMid(r5Base, curCtx);
  const r5VolStrict = filterVolume(mtfBase(curCtx), curCtx, 1.5).filter(s => s.direction === 'SHORT');
  const r5VolVeryStrict = filterVolume(mtfBase(curCtx), curCtx, 2.0).filter(s => s.direction === 'SHORT');

  const p3Variants: Array<{ name: string; sigs: SignalEvent[]; v: Variant; addFilter: string }> = [
    { name: 'TP3_SL1_12h', sigs: r5Base, v: { name: 'TP3_SL1_12h', tp: 3, sl: -1, maxMin: 720 }, addFilter: 'none (base R19-5)' },
    { name: 'TP4_SL1_24h', sigs: r5Base, v: { name: 'TP4_SL1_24h', tp: 4, sl: -1, maxMin: 1440 }, addFilter: 'none' },
    { name: 'TP5_SL1_48h', sigs: r5Base, v: { name: 'TP5_SL1_48h', tp: 5, sl: -1, maxMin: 2880 }, addFilter: 'none' },
    { name: 'TP6_SL1_72h', sigs: r5Base, v: { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 }, addFilter: 'none' },
    { name: 'TP3_SL1', sigs: r5AtrMid, v: PAYOFF_3_1, addFilter: '+ ATR mid' },
    { name: 'TP5_SL1', sigs: r5AtrMid, v: { name: 'TP5_SL1_48h', tp: 5, sl: -1, maxMin: 2880 }, addFilter: '+ ATR mid' },
    { name: 'TP3_SL1', sigs: r5VolStrict, v: PAYOFF_3_1, addFilter: 'Vol z>1.5' },
    { name: 'TP3_SL1', sigs: r5VolVeryStrict, v: PAYOFF_3_1, addFilter: 'Vol z>2.0' },
  ];

  for (const pv of p3Variants) {
    const trades = simulate(curCtx, pv.sigs, pv.v, 0.005);
    const s = statsFor(trades);
    L.push(`${pad(pv.name, 28)} | ${pad(pv.addFilter, 22)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  // ───── Phase 4: cooldown 변형 (R19-5 base, current 1년) ─────
  L.push(`\n\n## Phase 4 — Cooldown 변형 (R19-5 SHORT, payoff 3:1, cost 0.2%)\n`);
  L.push(`${pad('cooldown', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(55));
  const cooldowns = [
    { name: 'default (exit+0)', ms: 0 },
    { name: '+15m', ms: 15 * 60_000 },
    { name: '+30m', ms: 30 * 60_000 },
    { name: '+1h', ms: 60 * 60_000 },
    { name: '+4h', ms: 240 * 60_000 },
  ];
  for (const cd of cooldowns) {
    const trades = simulate(curCtx, r5Base, PAYOFF_3_1, 0.002, cd.ms);
    const s = statsFor(trades);
    L.push(`${pad(cd.name, 16)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R21_DEEP.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
