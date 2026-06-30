/**
 * R19 WR_IMPROVEMENT — R18-1 (MTF SHORT + payoff 3:1, PF 1.18) 기반 WR 개선.
 *
 * 분석:
 *   R18-1 base WR 41% / payoff 3:1 / total +38.57%
 *   다양한 filter/confluence로 WR 50% 이상 가능한지 검증
 *
 * 10가지 변형 (모두 base = MTF_TREND_CONFIRM, payoff TP3/SL1/12h):
 *   R19-1  Multi-bar confirm (next bar same color)
 *   R19-2  Funding alignment (funding direction 일치)
 *   R19-3  Multi-bar + funding (3중 confluence)
 *   R19-4  RSI confluence (LONG: RSI<40, SHORT: RSI>60)
 *   R19-5  Volume z > 1.0 (high volume confirmation)
 *   R19-6  EMA50 distance > 1% (강한 trend만)
 *   R19-7  Heikin Ashi color match (HA confirm)
 *   R19-8  2-bar same direction (직전 2봉 same color)
 *   R19-9  Time filter (KST 09-21 active hours)
 *   R19-10 ATR percentile filter (변동성 mid regime)
 *
 * Period: 2025-06-09 ~ 2026-06-09 (1년)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR, calcRSI } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const PAYOFF_3_1: Variant = { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 };
interface FundingPoint { ts: number; date: string; rate: number; }

function load(file: string): Bar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
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
    if (bars[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
      open: haOpen,
      high: Math.max(b.high, haOpen, haClose),
      low: Math.min(b.low, haOpen, haClose),
      close: haClose, volume: b.volume,
    });
  }
  return out;
}
function percentile(arr: number[], p: number): number {
  const s = [...arr].filter((v) => !Number.isNaN(v) && v != null).sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}

interface SignalEvent { ts: number; direction: Direction; }
interface SimContext {
  bars1m: Bar[];
  bars15m: Bar[];
  bars1h: Bar[];
  bars4h: Bar[];
  haBars15m: Bar[];
  fundingDaily: Map<string, number>;
  ind15: {
    ema20: (number|null)[]; ema50: (number|null)[];
    rsi: (number|null)[]; atr: (number|null)[];
  };
  ind4h: { ema50: (number|null)[] };
  atrPercentiles: { p33: number; p67: number };
  barsByTs: Map<number, number>; // ts → idx
}

function inAnalysis(ts: number): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ANALYSIS_START && d <= ANALYSIS_END;
}

// Base MTF_TREND_CONFIRM
function mtfBaseSignals(ctx: SimContext): SignalEvent[] {
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
function filterMultiBarConfirm(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (const s of signals) {
    const i = ctx.barsByTs.get(s.ts); if (i == null || i + 1 >= ctx.bars15m.length) continue;
    const next = ctx.bars15m[i + 1];
    const isGreen = next.close > next.open;
    if (s.direction === 'LONG' && isGreen) out.push({ ts: next.ts, direction: s.direction });
    if (s.direction === 'SHORT' && !isGreen) out.push({ ts: next.ts, direction: s.direction });
  }
  return out;
}
function filterFundingAlign(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const kstDate = new Date(s.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const yesterday = new Date(new Date(kstDate + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
    const yF = ctx.fundingDaily.get(yesterday);
    if (yF == null) return false;
    if (s.direction === 'LONG' && yF <= -0.001) return true;
    if (s.direction === 'SHORT' && yF >= 0.001) return true;
    return false;
  });
}
function filterRSI(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null) return false;
    const r = ctx.ind15.rsi[i]; if (r == null) return false;
    if (s.direction === 'LONG' && r < 40) return true;
    if (s.direction === 'SHORT' && r > 60) return true;
    return false;
  });
}
function filterVolume(signals: SignalEvent[], ctx: SimContext, zThresh = 1.0): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null || i < 30) return false;
    const win = ctx.bars15m.slice(i - 30, i).map((b) => b.volume);
    const m = win.reduce((sm, v) => sm + v, 0) / 30;
    const va = win.reduce((sm, x) => sm + (x - m) ** 2, 0) / 30;
    const std = Math.sqrt(va);
    const z = std === 0 ? 0 : (ctx.bars15m[i].volume - m) / std;
    return z >= zThresh;
  });
}
function filterEMA50Distance(signals: SignalEvent[], ctx: SimContext, distPct = 1.0): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null) return false;
    const e = ctx.ind15.ema50[i]; if (e == null) return false;
    const cur = ctx.bars15m[i].close;
    const dist = Math.abs(cur - e) / e * 100;
    return dist >= distPct;
  });
}
function filterHaConfirm(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null) return false;
    const ha = ctx.haBars15m[i];
    const isGreen = ha.close > ha.open;
    if (s.direction === 'LONG' && isGreen) return true;
    if (s.direction === 'SHORT' && !isGreen) return true;
    return false;
  });
}
function filter2BarSame(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null || i < 2) return false;
    const b1 = ctx.bars15m[i - 1], b2 = ctx.bars15m[i];
    const b1Green = b1.close > b1.open, b2Green = b2.close > b2.open;
    if (s.direction === 'LONG' && b1Green && b2Green) return true;
    if (s.direction === 'SHORT' && !b1Green && !b2Green) return true;
    return false;
  });
}
function filterTimeOfDay(signals: SignalEvent[]): SignalEvent[] {
  return signals.filter((s) => {
    const kstHour = (new Date(s.ts + 9 * 3600_000).getUTCHours()); // KST hour (after +9h)
    return kstHour >= 9 && kstHour <= 21;
  });
}
function filterAtrMid(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const i = ctx.barsByTs.get(s.ts); if (i == null) return false;
    const a = ctx.ind15.atr[i]; if (a == null) return false;
    return a > ctx.atrPercentiles.p33 && a < ctx.atrPercentiles.p67;
  });
}

interface Trade {
  rule: string; direction: Direction;
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

function simulate(ctx: SimContext, signals: SignalEvent[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  let cooldownTs = 0;
  for (const sig of signals) {
    if (!inAnalysis(sig.ts)) continue;
    if (sig.ts < cooldownTs) continue;
    const nextSlotTs = Math.floor((sig.ts + 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(ctx.bars1m, nextSlotTs);
    if (startIdx >= ctx.bars1m.length) continue;
    const entryBar = ctx.bars1m[startIdx];
    const exit = pathVerify(ctx.bars1m, startIdx, entryBar.ts, entryBar.open, sig.direction, v);
    const netRet = exit.rawReturnPct - COST_RT * 100;
    trades.push({
      rule: 'MTF', direction: sig.direction,
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

  console.log(`\n=== R19 WR_IMPROVEMENT ===\n`);
  const bars1m = load(`BINANCE_PERP_BTCUSDT_1m_${ANALYSIS_START}_${ANALYSIS_END}.json`);
  const bars15m = aggregate(bars1m, 15);
  const bars1h = aggregate(bars1m, 60);
  const bars4h = aggregate(bars1m, 240);
  console.log(`bars: 1m=${bars1m.length} 15m=${bars15m.length} 1h=${bars1h.length} 4h=${bars4h.length}`);

  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);

  const closes15 = bars15m.map(b => b.close);
  const atr15 = calcATR(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15, 14);
  const atrValid = atr15.filter((v): v is number => v != null);
  const atrPercentiles = { p33: percentile(atrValid, 33), p67: percentile(atrValid, 67) };

  const ctx: SimContext = {
    bars1m, bars15m, bars1h, bars4h,
    haBars15m: calcHeikinAshi(bars15m),
    fundingDaily,
    ind15: {
      ema20: calcEMA(closes15, 20),
      ema50: calcEMA(closes15, 50),
      rsi: calcRSI(closes15, 14).values,
      atr: atr15,
    },
    ind4h: { ema50: calcEMA(bars4h.map(b => b.close), 50) },
    atrPercentiles,
    barsByTs: new Map(bars15m.map((b, i) => [b.ts, i])),
  };

  const baseSignals = mtfBaseSignals(ctx);

  // 10 변형
  const variations: Array<{ id: string; signals: SignalEvent[]; desc: string }> = [
    { id: 'R19-1_MTF_MULTIBAR_P3:1',     signals: filterMultiBarConfirm(baseSignals, ctx), desc: 'MTF + multi-bar confirm + payoff 3:1' },
    { id: 'R19-2_MTF_FUND_P3:1',         signals: filterFundingAlign(baseSignals, ctx),    desc: 'MTF + funding align + payoff 3:1' },
    { id: 'R19-3_MTF_MULTIBAR_FUND',     signals: filterFundingAlign(filterMultiBarConfirm(baseSignals, ctx), ctx), desc: 'MTF + multi-bar + funding (3중)' },
    { id: 'R19-4_MTF_RSI',               signals: filterRSI(baseSignals, ctx),             desc: 'MTF + RSI confluence (LONG<40, SHORT>60)' },
    { id: 'R19-5_MTF_VOLUME',            signals: filterVolume(baseSignals, ctx, 1.0),     desc: 'MTF + volume z>1.0' },
    { id: 'R19-6_MTF_EMA50_DIST',        signals: filterEMA50Distance(baseSignals, ctx, 1.0), desc: 'MTF + EMA50 distance > 1%' },
    { id: 'R19-7_MTF_HA_CONFIRM',        signals: filterHaConfirm(baseSignals, ctx),       desc: 'MTF + Heikin Ashi color match' },
    { id: 'R19-8_MTF_2BAR_SAME',         signals: filter2BarSame(baseSignals, ctx),        desc: 'MTF + 2-bar same direction' },
    { id: 'R19-9_MTF_TIME',              signals: filterTimeOfDay(baseSignals),            desc: 'MTF + time filter (KST 09-21)' },
    { id: 'R19-10_MTF_ATR_MID',          signals: filterAtrMid(baseSignals, ctx),          desc: 'MTF + ATR mid regime (p33~p67)' },
  ];

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R19 WR_IMPROVEMENT — MTF + filter/confluence 변형 (payoff TP3/SL1/12h)`);
  L.push(`Period: ${ANALYSIS_START} ~ ${ANALYSIS_END}, Binance perp 1m path verify, cost RT ${(COST_RT*100).toFixed(1)}%`);
  L.push(`Base (R18-1) reference: MTF SHORT_ONLY n=395, WR 41%, total +38.57%, PF 1.18`);
  L.push('='.repeat(140));

  L.push(`\n## 변형별 결과 (각 SHORT_ONLY 위주)\n`);
  L.push(`${pad('id', 26)} | ${pad('desc', 42)} | ${pad('mode', 11)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(150));

  interface CellRow { id: string; mode: string; desc: string; stats: ReturnType<typeof statsFor>; }
  const allCells: CellRow[] = [];

  for (const vr of variations) {
    for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
      const sigs = vr.signals.filter((s) => mode === 'BOTH' || (mode === 'LONG_ONLY' ? s.direction === 'LONG' : s.direction === 'SHORT'));
      const trades = simulate(ctx, sigs, PAYOFF_3_1);
      const s = statsFor(trades);
      allCells.push({ id: vr.id, mode, desc: vr.desc, stats: s });
      L.push(`${pad(vr.id, 26)} | ${pad(vr.desc, 42)} | ${pad(mode, 11)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  // SHORT only top by WR
  L.push(`\n## SHORT_ONLY WR 정렬 (n≥10)\n`);
  L.push(`${pad('id', 26)} | ${pad('desc', 42)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(120));
  const shorts = allCells.filter(c => c.mode === 'SHORT_ONLY' && c.stats.n >= 10).sort((a, b) => b.stats.wr - a.stats.wr);
  for (const c of shorts) {
    L.push(`${pad(c.id, 26)} | ${pad(c.desc, 42)} | ${padS(String(c.stats.n), 4)} | ${padS(c.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.stats.total), 8)} | ${padS(c.stats.pf.toFixed(2), 5)}`);
  }

  // PF 정렬
  L.push(`\n## PF 정렬 (전체, n ≥ 10)\n`);
  L.push(`${pad('id × mode', 38)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(85));
  const byPF = [...allCells].filter(c => c.stats.n >= 10).sort((a, b) => b.stats.pf - a.stats.pf).slice(0, 15);
  for (const c of byPF) {
    L.push(`${pad(`${c.id} ${c.mode}`, 38)} | ${padS(String(c.stats.n), 4)} | ${padS(c.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.stats.total), 8)} | ${padS(c.stats.pf.toFixed(2), 5)}`);
  }

  // Total 정렬
  L.push(`\n## Total return 정렬 (전체, n ≥ 10)\n`);
  L.push(`${pad('id × mode', 38)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(85));
  const byTotal = [...allCells].filter(c => c.stats.n >= 10).sort((a, b) => b.stats.total - a.stats.total).slice(0, 15);
  for (const c of byTotal) {
    L.push(`${pad(`${c.id} ${c.mode}`, 38)} | ${padS(String(c.stats.n), 4)} | ${padS(c.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.stats.total), 8)} | ${padS(c.stats.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R19_WR_IMPROVE.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
