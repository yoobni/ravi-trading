/**
 * R20 ABCD — Phase A/B/C/D 순차 검증.
 *
 * A. Filter 조합으로 WR 50%+ 도전
 *    - ATR mid + volume
 *    - HA confirm + volume
 *    - ATR mid + funding
 *    - HA + volume + ATR mid (3중)
 *
 * B. Walk-forward (이전 1년 2024-06 ~ 2025-06) — base R18-1 + R19 best
 *
 * C. Payoff ratio 극단 (5:1, 6:1, 8:1) — strict filter 적용
 *
 * D. Cost stress (0.3%, 0.5%) — best 후보들
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR, calcRSI } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const PERIOD_CUR = { start: '2025-06-09', end: '2026-06-09' };
const PERIOD_PREV = { start: '2024-06-09', end: '2025-06-09' };

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
interface FundingPoint { ts: number; date: string; rate: number; }

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
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function percentile(arr: number[], p: number): number {
  const s = [...arr].filter((v) => !Number.isNaN(v) && v != null).sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}
interface ExitResult { exitTs: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; rawReturnPct: number; }
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
      const ret = direction === 'LONG' ? (bar.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG' ? (last.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - last.close) / entryPriceRaw * 100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret };
}
function calcHeikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      ts: b.ts, date: b.date,
      open: haOpen, close: haClose,
      high: Math.max(b.high, haOpen, haClose),
      low: Math.min(b.low, haOpen, haClose),
      volume: b.volume,
    });
  }
  return out;
}

interface SignalEvent { ts: number; direction: Direction; }
interface Ctx {
  periodStart: string; periodEnd: string;
  bars1m: Bar[]; bars15m: Bar[]; bars4h: Bar[];
  haBars15m: Bar[];
  fundingDaily: Map<string, number>;
  ind15: { ema20: (number|null)[]; ema50: (number|null)[]; rsi: (number|null)[]; atr: (number|null)[]; };
  ind4h: { ema50: (number|null)[] };
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
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);
  const closes15 = bars15m.map(b => b.close);
  const atr15 = calcATR(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15, 14);
  const atrValid = atr15.filter((v): v is number => v != null);
  return {
    periodStart, periodEnd,
    bars1m, bars15m, bars4h,
    haBars15m: calcHeikinAshi(bars15m),
    fundingDaily,
    ind15: {
      ema20: calcEMA(closes15, 20),
      ema50: calcEMA(closes15, 50),
      rsi: calcRSI(closes15, 14).values,
      atr: atr15,
    },
    ind4h: { ema50: calcEMA(bars4h.map(b => b.close), 50) },
    atrP33: percentile(atrValid, 33),
    atrP67: percentile(atrValid, 67),
    barsByTs: new Map(bars15m.map((b, i) => [b.ts, i])),
  };
}

function mtfBaseSignals(ctx: Ctx): SignalEvent[] {
  const out: SignalEvent[] = [];
  const bars15 = ctx.bars15m; const bars4h = ctx.bars4h;
  function get4hTrend(ts: number): 1 | -1 | null {
    let idx = -1;
    for (let i = bars4h.length - 1; i >= 0; i--) if (bars4h[i].ts <= ts) { idx = i; break; }
    if (idx < 0) return null;
    const e = ctx.ind4h.ema50[idx]; if (e == null) return null;
    if (bars4h[idx].close > e) return 1;
    if (bars4h[idx].close < e) return -1;
    return null;
  }
  for (let i = 1; i < bars15.length; i++) {
    const trend = get4hTrend(bars15[i].ts);
    if (!trend) continue;
    const e = ctx.ind15.ema20[i], ep = ctx.ind15.ema20[i - 1];
    if (e == null || ep == null) continue;
    const prev = bars15[i - 1], cur = bars15[i];
    if (trend === 1 && prev.close < ep && cur.close > e) out.push({ ts: cur.ts, direction: 'LONG' });
    if (trend === -1 && prev.close > ep && cur.close < e) out.push({ ts: cur.ts, direction: 'SHORT' });
  }
  return out;
}

// Filter helpers
function filterMultiBar(s: SignalEvent[], ctx: Ctx): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (const sig of s) {
    const i = ctx.barsByTs.get(sig.ts); if (i == null || i + 1 >= ctx.bars15m.length) continue;
    const next = ctx.bars15m[i + 1];
    const isGreen = next.close > next.open;
    if (sig.direction === 'LONG' && isGreen) out.push({ ts: next.ts, direction: sig.direction });
    if (sig.direction === 'SHORT' && !isGreen) out.push({ ts: next.ts, direction: sig.direction });
  }
  return out;
}
function filterFunding(s: SignalEvent[], ctx: Ctx): SignalEvent[] {
  return s.filter((sig) => {
    const kstDate = new Date(sig.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const yesterday = new Date(new Date(kstDate + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
    const yF = ctx.fundingDaily.get(yesterday);
    if (yF == null) return false;
    if (sig.direction === 'LONG' && yF <= -0.001) return true;
    if (sig.direction === 'SHORT' && yF >= 0.001) return true;
    return false;
  });
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
function filterHaConfirm(s: SignalEvent[], ctx: Ctx): SignalEvent[] {
  return s.filter((sig) => {
    const i = ctx.barsByTs.get(sig.ts); if (i == null) return false;
    const ha = ctx.haBars15m[i];
    const isGreen = ha.close > ha.open;
    if (sig.direction === 'LONG' && isGreen) return true;
    if (sig.direction === 'SHORT' && !isGreen) return true;
    return false;
  });
}
function filterAtrMid(s: SignalEvent[], ctx: Ctx): SignalEvent[] {
  return s.filter((sig) => {
    const i = ctx.barsByTs.get(sig.ts); if (i == null) return false;
    const a = ctx.ind15.atr[i]; if (a == null) return false;
    return a > ctx.atrP33 && a < ctx.atrP67;
  });
}

interface Trade {
  direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
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

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R20 ABCD ===\n`);

  const curCtx = buildCtx(PERIOD_CUR.start, PERIOD_CUR.end)!;
  const prevCtx = buildCtx(PERIOD_PREV.start, PERIOD_PREV.end);
  console.log(`Current period: ${PERIOD_CUR.start} ~ ${PERIOD_CUR.end} (1m=${curCtx.bars1m.length})`);
  if (prevCtx) console.log(`Previous period: ${PERIOD_PREV.start} ~ ${PERIOD_PREV.end} (1m=${prevCtx.bars1m.length})`);
  else console.log(`Previous period: 데이터 없음 (Phase B skip)`);

  const PAYOFF_3_1: Variant = { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 };

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R20 ABCD — filter combo + walk-forward + payoff extreme + cost stress`);
  L.push('='.repeat(140));

  // ───── Phase A: Filter combinations ─────
  L.push(`\n\n## Phase A — Filter 조합 (WR 50% 도전, current 1년, SHORT only)\n`);
  L.push(`${pad('combo', 40)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(105));

  const curBase = mtfBaseSignals(curCtx);
  const aCombos: Array<{ name: string; sigs: SignalEvent[] }> = [
    { name: 'R20A-1: ATR mid + Volume z>1.0', sigs: filterVolume(filterAtrMid(curBase, curCtx), curCtx, 1.0) },
    { name: 'R20A-2: ATR mid + HA confirm', sigs: filterHaConfirm(filterAtrMid(curBase, curCtx), curCtx) },
    { name: 'R20A-3: HA + Volume', sigs: filterVolume(filterHaConfirm(curBase, curCtx), curCtx, 1.0) },
    { name: 'R20A-4: ATR mid + Funding', sigs: filterFunding(filterAtrMid(curBase, curCtx), curCtx) },
    { name: 'R20A-5: ATR + Volume + HA (3중)', sigs: filterHaConfirm(filterVolume(filterAtrMid(curBase, curCtx), curCtx, 1.0), curCtx) },
    { name: 'R20A-6: ATR mid + MultiBar', sigs: filterMultiBar(filterAtrMid(curBase, curCtx), curCtx) },
    { name: 'R20A-7: HA + MultiBar', sigs: filterMultiBar(filterHaConfirm(curBase, curCtx), curCtx) },
    { name: 'R20A-8: Volume z>1.5 (stricter)', sigs: filterVolume(curBase, curCtx, 1.5) },
    { name: 'R20A-9: Volume z>2.0 (very strict)', sigs: filterVolume(curBase, curCtx, 2.0) },
    { name: 'R20A-10: ATR + Vol + HA + Funding (4중)', sigs: filterFunding(filterHaConfirm(filterVolume(filterAtrMid(curBase, curCtx), curCtx, 1.0), curCtx), curCtx) },
  ];

  for (const c of aCombos) {
    const shorts = c.sigs.filter(s => s.direction === 'SHORT');
    const trades = simulate(curCtx, shorts, PAYOFF_3_1, 0.002);
    const s = statsFor(trades);
    L.push(`${pad(c.name, 40)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  // ───── Phase B: Walk-forward (prev year) ─────
  L.push(`\n\n## Phase B — Walk-forward (prev 1년 2024-06 ~ 2025-06, SHORT only)\n`);
  if (!prevCtx) {
    L.push(`⚠ prev year 데이터 없음. fetch 완료 후 재실행 필요.`);
  } else {
    L.push(`${pad('strategy', 40)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)} | curr cmp`);
    L.push('-'.repeat(105));
    const prevBase = mtfBaseSignals(prevCtx);
    const bStrats: Array<{ name: string; sigsCur: SignalEvent[]; sigsPrev: SignalEvent[] }> = [
      { name: 'R18-1 MTF + payoff 3:1', sigsCur: curBase, sigsPrev: prevBase },
      { name: 'R19-5 MTF + Volume z>1.0', sigsCur: filterVolume(curBase, curCtx, 1.0), sigsPrev: filterVolume(prevBase, prevCtx, 1.0) },
      { name: 'R19-10 MTF + ATR mid', sigsCur: filterAtrMid(curBase, curCtx), sigsPrev: filterAtrMid(prevBase, prevCtx) },
      { name: 'R19-7 MTF + HA confirm', sigsCur: filterHaConfirm(curBase, curCtx), sigsPrev: filterHaConfirm(prevBase, prevCtx) },
      { name: 'R19-2 MTF + Funding align', sigsCur: filterFunding(curBase, curCtx), sigsPrev: filterFunding(prevBase, prevCtx) },
    ];
    for (const st of bStrats) {
      const curS = st.sigsCur.filter(s => s.direction === 'SHORT');
      const prevS = st.sigsPrev.filter(s => s.direction === 'SHORT');
      const cTrades = simulate(curCtx, curS, PAYOFF_3_1, 0.002);
      const pTrades = simulate(prevCtx, prevS, PAYOFF_3_1, 0.002);
      const cS = statsFor(cTrades);
      const pS = statsFor(pTrades);
      const cmp = pS.total >= 0 ? '✓' : '✗';
      L.push(`${pad(st.name + ' [PREV]', 40)} | ${padS(String(pS.n), 4)} | ${padS(pS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(pS.total), 8)} | ${padS(pS.pf.toFixed(2), 5)} | ${cmp}`);
      L.push(`${pad(st.name + ' [CURR]', 40)} | ${padS(String(cS.n), 4)} | ${padS(cS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(cS.total), 8)} | ${padS(cS.pf.toFixed(2), 5)} | -`);
      L.push('');
    }
  }

  // ───── Phase C: Payoff ratio 극단 ─────
  L.push(`\n## Phase C — Payoff ratio 극단 (current 1년, SHORT only, ATR mid filter)\n`);
  L.push(`${pad('payoff (TP/SL/maxMin)', 30)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(105));
  const atrMidShorts = filterAtrMid(curBase, curCtx).filter(s => s.direction === 'SHORT');
  const payoffVariants: Variant[] = [
    { name: 'TP2_SL1.3_8h (R17 default)', tp: 2.0, sl: -1.3, maxMin: 480 },
    { name: 'TP3_SL1_12h (R18-1)',        tp: 3.0, sl: -1.0, maxMin: 720 },
    { name: 'TP4_SL1_24h (R18-2)',        tp: 4.0, sl: -1.0, maxMin: 1440 },
    { name: 'TP5_SL1_48h',                tp: 5.0, sl: -1.0, maxMin: 2880 },
    { name: 'TP6_SL1_72h',                tp: 6.0, sl: -1.0, maxMin: 4320 },
    { name: 'TP8_SL1_120h',               tp: 8.0, sl: -1.0, maxMin: 7200 },
    { name: 'TP4_SL0.8_24h (tight SL)',   tp: 4.0, sl: -0.8, maxMin: 1440 },
    { name: 'TP3_SL0.5_12h (tight SL)',   tp: 3.0, sl: -0.5, maxMin: 720 },
  ];
  for (const v of payoffVariants) {
    const trades = simulate(curCtx, atrMidShorts, v, 0.002);
    const s = statsFor(trades);
    L.push(`${pad(v.name, 30)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  // ───── Phase D: Cost stress ─────
  L.push(`\n\n## Phase D — Cost stress (SHORT only, payoff 3:1)\n`);
  L.push(`${pad('strategy × cost', 42)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(85));
  const dStrats: Array<{ name: string; sigs: SignalEvent[] }> = [
    { name: 'R18-1 base', sigs: curBase },
    { name: 'R19-5 + Volume', sigs: filterVolume(curBase, curCtx, 1.0) },
    { name: 'R19-10 + ATR mid', sigs: filterAtrMid(curBase, curCtx) },
    { name: 'R19-7 + HA confirm', sigs: filterHaConfirm(curBase, curCtx) },
  ];
  const costs = [0.002, 0.003, 0.005];
  for (const st of dStrats) {
    const shorts = st.sigs.filter(s => s.direction === 'SHORT');
    for (const cost of costs) {
      const trades = simulate(curCtx, shorts, PAYOFF_3_1, cost);
      const s = statsFor(trades);
      L.push(`${pad(`${st.name} @${(cost*100).toFixed(1)}%`, 42)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R20_ABCD.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
