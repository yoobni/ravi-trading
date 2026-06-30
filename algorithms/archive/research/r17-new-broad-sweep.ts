/**
 * R17 NEW_BROAD_SWEEP — 10가지 fresh 알고리즘 양방향 sweep.
 *
 * 데이터: Binance BTCUSDT perp 1m / 1h / 4h / 1d (2025-06-09 ~ 2026-06-09).
 * R15와 안 겹치는 새 신호 10가지.
 *
 * Rules (15m TF 기반):
 *   1. ATR_BREAKOUT      : 현재 range > ATR(14) × 1.5 + 방향 (큰 캔들 momentum)
 *   2. KELTNER_BREAKOUT  : Keltner Channel (EMA20 ± ATR×2) 돌파
 *   3. SUPERTREND        : SuperTrend(10, 3) 방향 변화
 *   4. HEIKIN_REVERSAL   : Heikin Ashi 색 변화 (음→양 = LONG)
 *   5. CCI_EXTREME       : CCI(20) > 100 → SHORT, < -100 → LONG
 *   6. STOCHASTIC_CROSS  : %K cross %D in oversold/overbought
 *   7. AWESOME_OSC       : AO histogram 0 cross
 *   8. VWAP_DEV          : VWAP에서 ±2 std 이탈 후 회복
 *   9. MTF_TREND_CONFIRM : 4h EMA50 trend + 15m close 회복
 *   10. RANGE_BREAK_VOL  : 직전 N봉 range break + volume z > 1.5 confirm
 *
 * Cost 왕복 0.2%, 1m path verify, LONG/SHORT/BOTH 비교.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const VARIANTS: Variant[] = [
  { name: 'T_TP0.5_SL0.3_2h',  tp: 0.5, sl: -0.3, maxMin: 120 },
  { name: 'M_TP1.0_SL0.7_4h',  tp: 1.0, sl: -0.7, maxMin: 240 },
  { name: 'W_TP2.0_SL1.3_8h',  tp: 2.0, sl: -1.3, maxMin: 480 },
];

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

// ───── 지표 계산 ─────
function calcCCI(highs: number[], lows: number[], closes: number[], period = 20): (number | null)[] {
  const n = closes.length; const out: (number | null)[] = new Array(n).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period - 1; i < n; i++) {
    const win = tp.slice(i - period + 1, i + 1);
    const sma = win.reduce((s, v) => s + v, 0) / period;
    const md = win.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    out[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  return out;
}
function calcStochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3): { k: (number | null)[]; d: (number | null)[] } {
  const n = closes.length; const k: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    k[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
  }
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod + dPeriod - 2; i < n; i++) {
    const win = k.slice(i - dPeriod + 1, i + 1).filter((v): v is number => v != null);
    d[i] = win.length === dPeriod ? win.reduce((s, v) => s + v, 0) / dPeriod : null;
  }
  return { k, d };
}
function calcAO(highs: number[], lows: number[]): (number | null)[] {
  const n = highs.length; const median = highs.map((h, i) => (h + lows[i]) / 2);
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 33; i < n; i++) {
    const sma5 = median.slice(i - 4, i + 1).reduce((s, v) => s + v, 0) / 5;
    const sma34 = median.slice(i - 33, i + 1).reduce((s, v) => s + v, 0) / 34;
    out[i] = sma5 - sma34;
  }
  return out;
}
function calcRollingVWAP(bars: Bar[], window = 48): { vwap: (number | null)[]; std: (number | null)[] } {
  const n = bars.length;
  const vwap: (number | null)[] = new Array(n).fill(null);
  const std: (number | null)[] = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    const win = bars.slice(i - window + 1, i + 1);
    let pvSum = 0, vSum = 0;
    for (const b of win) { pvSum += b.close * b.volume; vSum += b.volume; }
    const w = vSum > 0 ? pvSum / vSum : null;
    vwap[i] = w;
    if (w != null) {
      // std of (close - vwap) in window
      const dev = win.map((b) => (b.close - w) ** 2);
      std[i] = Math.sqrt(dev.reduce((s, v) => s + v, 0) / win.length);
    }
  }
  return { vwap, std };
}
function calcSuperTrend(highs: number[], lows: number[], closes: number[], atrPeriod = 10, multiplier = 3): { direction: (1 | -1 | null)[]; line: (number | null)[] } {
  const n = closes.length;
  const atr = calcATR(highs, lows, closes, atrPeriod);
  const direction: (1 | -1 | null)[] = new Array(n).fill(null);
  const line: (number | null)[] = new Array(n).fill(null);
  let prevUpper = 0, prevLower = 0, prevDirection: 1 | -1 = 1;
  for (let i = atrPeriod; i < n; i++) {
    const a = atr[i]; if (a == null) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    let upper = hl2 + multiplier * a;
    let lower = hl2 - multiplier * a;
    if (i > atrPeriod) {
      if (closes[i - 1] <= prevUpper) upper = Math.min(upper, prevUpper);
      if (closes[i - 1] >= prevLower) lower = Math.max(lower, prevLower);
    }
    let dir: 1 | -1 = prevDirection;
    if (prevDirection === 1 && closes[i] < lower) dir = -1;
    else if (prevDirection === -1 && closes[i] > upper) dir = 1;
    direction[i] = dir;
    line[i] = dir === 1 ? lower : upper;
    prevUpper = upper; prevLower = lower; prevDirection = dir;
  }
  return { direction, line };
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
      close: haClose,
      volume: b.volume,
    });
  }
  return out;
}

interface SignalEvent { ts: number; direction: Direction; }
interface SignalContext {
  bars15m: Bar[];
  bars1h: Bar[];
  bars4h: Bar[];
}
type SignalFn = (ctx: SignalContext) => SignalEvent[];

function inAnalysis(ts: number): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ANALYSIS_START && d <= ANALYSIS_END;
}

const RULES: { name: string; fn: SignalFn }[] = [
  // 1. ATR_BREAKOUT (large candle momentum)
  { name: 'ATR_BREAKOUT', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const atr = calcATR(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14);
    for (let i = 14; i < bars.length; i++) {
      const a = atr[i]; if (a == null) continue;
      const range = bars[i].high - bars[i].low;
      if (range < a * 1.5) continue;
      // 양봉/음봉으로 방향
      if (bars[i].close > bars[i].open) out.push({ ts: bars[i].ts, direction: 'LONG' });
      else if (bars[i].close < bars[i].open) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 2. KELTNER_BREAKOUT
  { name: 'KELTNER_BREAKOUT', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const ema = calcEMA(bars.map(b => b.close), 20);
    const atr = calcATR(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14);
    for (let i = 20; i < bars.length; i++) {
      const e = ema[i], a = atr[i]; if (e == null || a == null) continue;
      const upper = e + 2 * a, lower = e - 2 * a;
      const prev = bars[i - 1], cur = bars[i];
      if (prev.close <= upper && cur.close > upper) out.push({ ts: cur.ts, direction: 'LONG' });
      if (prev.close >= lower && cur.close < lower) out.push({ ts: cur.ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 3. SUPERTREND
  { name: 'SUPERTREND', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const st = calcSuperTrend(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 10, 3);
    for (let i = 1; i < bars.length; i++) {
      const d = st.direction[i], p = st.direction[i - 1];
      if (d == null || p == null) continue;
      if (p === -1 && d === 1) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (p === 1 && d === -1) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 4. HEIKIN_REVERSAL
  { name: 'HEIKIN_REVERSAL', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const ha = calcHeikinAshi(bars);
    for (let i = 1; i < ha.length; i++) {
      const prevGreen = ha[i - 1].close > ha[i - 1].open;
      const curGreen = ha[i].close > ha[i].open;
      if (!prevGreen && curGreen) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (prevGreen && !curGreen) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 5. CCI_EXTREME
  { name: 'CCI_EXTREME', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const cci = calcCCI(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 20);
    for (let i = 1; i < bars.length; i++) {
      const c = cci[i], p = cci[i - 1]; if (c == null || p == null) continue;
      if (p > -100 && c <= -100) out.push({ ts: bars[i].ts, direction: 'LONG' }); // oversold → LONG
      if (p < 100 && c >= 100) out.push({ ts: bars[i].ts, direction: 'SHORT' }); // overbought → SHORT
    }
    return out;
  }},
  // 6. STOCHASTIC_CROSS
  { name: 'STOCHASTIC_CROSS', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const stoch = calcStochastic(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14, 3);
    for (let i = 1; i < bars.length; i++) {
      const kP = stoch.k[i - 1], kC = stoch.k[i], dP = stoch.d[i - 1], dC = stoch.d[i];
      if (kP == null || kC == null || dP == null || dC == null) continue;
      // %K cross %D in oversold (k < 20) → LONG
      if (kP < 20 && dP < 20 && kP < dP && kC > dC) out.push({ ts: bars[i].ts, direction: 'LONG' });
      // %K cross %D in overbought (k > 80) → SHORT
      if (kP > 80 && dP > 80 && kP > dP && kC < dC) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 7. AWESOME_OSC (zero cross)
  { name: 'AWESOME_OSC', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const ao = calcAO(bars.map(b => b.high), bars.map(b => b.low));
    for (let i = 1; i < bars.length; i++) {
      const c = ao[i], p = ao[i - 1]; if (c == null || p == null) continue;
      if (p <= 0 && c > 0) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (p >= 0 && c < 0) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 8. VWAP_DEV (rolling VWAP from 15m, mean reversion)
  { name: 'VWAP_DEV', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const vw = calcRollingVWAP(bars, 48); // 12h rolling
    for (let i = 1; i < bars.length; i++) {
      const v = vw.vwap[i], s = vw.std[i];
      const vp = vw.vwap[i - 1], sp = vw.std[i - 1];
      if (v == null || s == null || vp == null || sp == null) continue;
      const prev = bars[i - 1], cur = bars[i];
      // 이전이 VWAP+2std 위 close, 현재가 안으로 회복 → SHORT
      if (prev.close > vp + 2 * sp && cur.close < v + 2 * s) out.push({ ts: cur.ts, direction: 'SHORT' });
      // 이전이 VWAP-2std 아래, 현재가 안으로 회복 → LONG
      if (prev.close < vp - 2 * sp && cur.close > v - 2 * s) out.push({ ts: cur.ts, direction: 'LONG' });
    }
    return out;
  }},
  // 9. MTF_TREND_CONFIRM (4h trend + 15m close confirm)
  { name: 'MTF_TREND_CONFIRM', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars15 = ctx.bars15m;
    const bars4h = ctx.bars4h;
    const closes4h = bars4h.map(b => b.close);
    const ema50_4h = calcEMA(closes4h, 50);
    function get4hTrend(ts: number): 1 | -1 | null {
      let idx = -1;
      for (let i = bars4h.length - 1; i >= 0; i--) if (bars4h[i].ts <= ts) { idx = i; break; }
      if (idx < 0) return null;
      const e = ema50_4h[idx]; if (e == null) return null;
      if (bars4h[idx].close > e) return 1;
      if (bars4h[idx].close < e) return -1;
      return null;
    }
    const closes15 = bars15.map(b => b.close);
    const ema20_15 = calcEMA(closes15, 20);
    for (let i = 1; i < bars15.length; i++) {
      const trend = get4hTrend(bars15[i].ts);
      if (!trend) continue;
      const e = ema20_15[i], ep = ema20_15[i - 1]; if (e == null || ep == null) continue;
      const prev = bars15[i - 1], cur = bars15[i];
      // 4h UP + 15m close crosses above EMA20 (with previous below) → LONG
      if (trend === 1 && prev.close < ep && cur.close > e) out.push({ ts: cur.ts, direction: 'LONG' });
      if (trend === -1 && prev.close > ep && cur.close < e) out.push({ ts: cur.ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 10. RANGE_BREAK_VOL (20-bar range break + volume z>1.5)
  { name: 'RANGE_BREAK_VOL', fn: (ctx) => {
    const out: SignalEvent[] = [];
    const bars = ctx.bars15m;
    const W = 30;
    for (let i = 20; i < bars.length; i++) {
      // volume z-score
      const vols = bars.slice(i - W, i).map(b => b.volume);
      const m = vols.reduce((s, v) => s + v, 0) / W;
      const v = vols.reduce((s, x) => s + (x - m) ** 2, 0) / W;
      const std = Math.sqrt(v);
      const z = std === 0 ? 0 : (bars[i].volume - m) / std;
      if (z < 1.5) continue;
      // 20-bar range
      const window = bars.slice(i - 20, i);
      const high20 = Math.max(...window.map(b => b.high));
      const low20 = Math.min(...window.map(b => b.low));
      if (bars[i].close > high20) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (bars[i].close < low20) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
];

interface Trade {
  rule: string; direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}
interface CellResult {
  rule: string; variant: string; mode: 'BOTH' | 'LONG_ONLY' | 'SHORT_ONLY';
  n: number; wr: number; avgWin: number; avgLoss: number; total: number; pf: number;
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

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R17 NEW_BROAD_SWEEP ===\n`);
  const bars1m = load(`BINANCE_PERP_BTCUSDT_1m_${ANALYSIS_START}_${ANALYSIS_END}.json`);
  console.log(`Binance perp 1m: ${bars1m.length} bars`);
  const bars15m = aggregate(bars1m, 15);
  const bars1h = aggregate(bars1m, 60);
  const bars4h = aggregate(bars1m, 240);
  console.log(`15m=${bars15m.length}, 1h=${bars1h.length}, 4h=${bars4h.length}\n`);

  const ctx: SignalContext = { bars15m, bars1h, bars4h };

  const allCells: CellResult[] = [];
  for (const rule of RULES) {
    const signals = rule.fn(ctx).filter((s) => inAnalysis(s.ts));
    process.stdout.write(`  [${rule.name}] ${signals.length} signals, ${signals.filter(s=>s.direction==='LONG').length} LONG / ${signals.filter(s=>s.direction==='SHORT').length} SHORT\n`);
    for (const v of VARIANTS) {
      for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
        const trades: Trade[] = [];
        let cooldownTs = 0;
        for (const sig of signals) {
          if (mode === 'LONG_ONLY' && sig.direction !== 'LONG') continue;
          if (mode === 'SHORT_ONLY' && sig.direction !== 'SHORT') continue;
          if (sig.ts < cooldownTs) continue;
          const nextSlotTs = Math.floor((sig.ts + 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
          const startIdx = find1mIdx(bars1m, nextSlotTs);
          if (startIdx >= bars1m.length) continue;
          const entryBar = bars1m[startIdx];
          const exit = pathVerify(bars1m, startIdx, entryBar.ts, entryBar.open, sig.direction, v);
          const netRet = exit.rawReturnPct - COST_RT * 100;
          trades.push({
            rule: rule.name, direction: sig.direction,
            entryTs: entryBar.ts, entryPrice: entryBar.open,
            exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
            rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
            monthKey: new Date(sig.ts + 9 * 3600_000).toISOString().slice(0, 7),
          });
          cooldownTs = exit.exitTs;
        }
        const s = statsFor(trades);
        allCells.push({ rule: rule.name, variant: v.name, mode, ...s });
      }
    }
  }

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R17 NEW_BROAD_SWEEP — Binance perp 1m 1y, ${RULES.length} rules × ${VARIANTS.length} variants × 3 modes`);
  L.push(`Period: ${ANALYSIS_START} ~ ${ANALYSIS_END} | 1m path verify | cost RT ${(COST_RT*100).toFixed(1)}%`);
  L.push('='.repeat(150));

  L.push(`\n## WR 정렬 top 25 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byWR = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.wr - a.wr).slice(0, 25);
  for (const c of byWR) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  L.push(`\n\n## PF 정렬 top 25 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byPF = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.pf - a.pf).slice(0, 25);
  for (const c of byPF) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  L.push(`\n\n## Total return 정렬 top 25 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byTotal = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.total - a.total).slice(0, 25);
  for (const c of byTotal) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  L.push(`\n\n## 룰별 best mode (PF 기준)\n`);
  L.push(`${pad('rule', 22)} | ${padS('BOTH PF', 8)} | ${padS('LONG PF', 8)} | ${padS('SHORT PF', 8)} | ${padS('BOTH WR', 8)} | ${padS('LONG WR', 8)} | ${padS('SHORT WR', 8)}`);
  L.push('-'.repeat(100));
  for (const rule of RULES) {
    const cells = allCells.filter((c) => c.rule === rule.name);
    function bestBy(mode: 'BOTH' | 'LONG_ONLY' | 'SHORT_ONLY'): CellResult | null {
      const rs = cells.filter((c) => c.mode === mode && c.n >= 5);
      if (rs.length === 0) return null;
      return rs.sort((a, b) => b.pf - a.pf)[0];
    }
    const both = bestBy('BOTH'), long = bestBy('LONG_ONLY'), short = bestBy('SHORT_ONLY');
    L.push(`${pad(rule.name, 22)} | ${padS(both?.pf.toFixed(2) ?? '-', 8)} | ${padS(long?.pf.toFixed(2) ?? '-', 8)} | ${padS(short?.pf.toFixed(2) ?? '-', 8)} | ${padS((both?.wr.toFixed(0) ?? '-') + '%', 8)} | ${padS((long?.wr.toFixed(0) ?? '-') + '%', 8)} | ${padS((short?.wr.toFixed(0) ?? '-') + '%', 8)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R17_NEW_BROAD_SWEEP.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
