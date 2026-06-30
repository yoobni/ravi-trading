/**
 * R30-8A — R30-5 setup (4코인, no filter, TP5/SL2/14d) + 10 algos.
 *
 * R30-6 confluence filter가 오히려 손해였음 (10코인 풀에서). 다시 4코인 + no filter로.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const FROM = '2025-06-10';
const TO = '2026-06-10';
const UNIT = 60;
const COINS = ['ETH','SOL','DOT','LINK'];
const COST_RT = 0.001;
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const TP_PCT = 5.0;
const SL_PCT = -2.0;
const MAX_BARS = 336;

function loadBars(coin: string): CachedBar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_${UNIT}m_${FROM}_${TO}.json`), 'utf-8'));
}
function calcEMA(values: number[], period: number): (number|null)[] {
  const k = 2 / (period + 1); const out: (number|null)[] = new Array(values.length).fill(null);
  let ema: number | null = null; let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { sum += values[i]; continue; }
    if (ema === null) { sum += values[i]; ema = sum / period; }
    else ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  } return out;
}
function calcRSI(closes: number[], period = 14): (number|null)[] {
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period;
      if (i === period) { const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); } }
    else { avgGain = (avgGain*(period-1)+gain)/period; avgLoss = (avgLoss*(period-1)+loss)/period;
      const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); }
  } return out;
}
function calcATR(highs: number[], lows: number[], closes: number[], period = 14): (number|null)[] {
  const tr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let atr: number | null = null; let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { sum += tr[i]; continue; }
    if (atr === null) { sum += tr[i]; atr = sum / period; }
    else atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  } return out;
}
function calcBB(closes: number[], period = 20, mult = 2) {
  const n = closes.length;
  const lower: (number|null)[] = new Array(n).fill(null);
  const upper: (number|null)[] = new Array(n).fill(null);
  const width: (number|null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    lower[i] = mean - mult*sd; upper[i] = mean + mult*sd;
    width[i] = (upper[i]! - lower[i]!) / mean;
  }
  return { lower, upper, width };
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface RawSignal { coin: string; barIdx: number; ts: number; }
function sigBreakout(bars: CachedBar[], coin: string, lookback: number, volZ: number): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigDonchian(bars: CachedBar[], coin: string, lookback = 20, volZ = 0.5): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigWeekHigh(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 168; const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigSMA(bars: CachedBar[], coin: string, volZ = 0.5): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ef = calcEMA(closes, 12), es = calcEMA(closes, 26);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ef[i-1] == null || es[i-1] == null || ef[i] == null || es[i] == null) continue;
    if (ef[i-1]! < es[i-1]! && ef[i]! > es[i]!) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigKeltner(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20);
  const atr14 = calcATR(highs, lows, closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ema20[i-1] == null || ema20[i] == null || atr14[i-1] == null || atr14[i] == null) continue;
    const upperPrev = ema20[i-1]! + 2 * atr14[i-1]!;
    const upperCur = ema20[i]! + 2 * atr14[i]!;
    if (closes[i-1] <= upperPrev && closes[i] > upperCur) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 0.5) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigMomentum3(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20);
  const out: RawSignal[] = [];
  for (let i = 3; i < bars.length; i++) {
    if (ema20[i] == null) continue;
    if (!(closes[i-2] < closes[i-1] && closes[i-1] < closes[i])) continue;
    if (closes[i] <= ema20[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigVolExpansion(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 20, 2);
  const out: RawSignal[] = [];
  for (let i = 50; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - 50; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    const isSqueeze = bb.width[i]! <= minWidth * 1.1;
    if (!isSqueeze) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigPullback(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ema20[i-1] == null || ema20[i] == null || ema50[i] == null) continue;
    if (closes[i] <= ema50[i]!) continue;
    if (!(bars[i-1].low <= ema20[i-1]! && bars[i].close > ema20[i]!)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigEMATrend(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26), e50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i] == null || e26[i] == null || e50[i] == null) continue;
    if (closes[i] > e50[i]! && e12[i]! > e26[i]! && bars[i].close > bars[i].open) {
      if (bars[i-1].low <= e26[i-1]! && bars[i].close > e26[i]!) {
        const z = calcVolZ(volumes, i, 30);
        if (z == null || z < 0.8) continue;
        out.push({ coin, barIdx: i, ts: bars[i].ts });
      }
    }
  }
  return out;
}

const ALGOS = [
  { name: 'A1 BREAKOUT12',  fn: (b: CachedBar[], c: string) => sigBreakout(b, c, 12, 1.0) },
  { name: 'A2 BREAKOUT24',  fn: (b: CachedBar[], c: string) => sigBreakout(b, c, 24, 1.0) },
  { name: 'A3 BREAKOUT48',  fn: (b: CachedBar[], c: string) => sigBreakout(b, c, 48, 1.0) },
  { name: 'A4 DONCHIAN20',  fn: (b: CachedBar[], c: string) => sigDonchian(b, c, 20, 0.5) },
  { name: 'A5 WEEK_HIGH',   fn: sigWeekHigh },
  { name: 'A6 SMA_CROSS',   fn: (b: CachedBar[], c: string) => sigSMA(b, c, 0.5) },
  { name: 'A7 KELTNER',     fn: sigKeltner },
  { name: 'A8 MOMENTUM3',   fn: sigMomentum3 },
  { name: 'A9 VOL_EXP',     fn: sigVolExpansion },
  { name: 'A10 PULLBACK',   fn: sigPullback },
  { name: 'A11 EMA_TREND',  fn: sigEMATrend },
];

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; holdBars: number; }

function simulate(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: PfTrade[] = [];
  const sorted = [...rawSignals].sort((a, b) => a.ts - b.ts);
  const sigByTs = new Map<number, RawSignal[]>();
  for (const sig of sorted) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const tp = pos.entryPrice * (1 + TP_PCT / 100), sl = pos.entryPrice * (1 + SL_PCT / 100);
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: PfTrade['reason'] | null = null, rawRet = 0;
      if (b.low <= sl) { exitPrice = sl; reason = 'SL'; rawRet = SL_PCT; }
      else if (b.high >= tp) { exitPrice = tp; reason = 'TP'; rawRet = TP_PCT; }
      else if (holdBars >= MAX_BARS) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason, holdBars });
        positions.splice(p, 1);
      }
    }
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const eBar = bars[entryIdx];
      const entryPrice = eBar.open;
      const cashToUse = cash * POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse });
    }
    let openValue = 0;
    for (const pos of positions) {
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx != null) openValue += pos.vol * barsByCoin.get(pos.coin)![idx].close;
    }
    const eq = cash + openValue;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > mdd) mdd = dd;
  }
  for (const pos of positions) {
    const bars = barsByCoin.get(pos.coin)!;
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: last.ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END', holdBars: bars.length - 1 - pos.entryIdx });
  }
  return { trades, finalCash: cash, mdd };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-8A 4코인 no-filter fleet ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  const L: string[] = [];
  L.push('='.repeat(160));
  L.push(`R30-8A — 4 coin pool (ETH/SOL/DOT/LINK), no confluence filter, TP+5%/SL-2%/MAX 14d`);
  L.push(`Capital ${INITIAL_CASH/1e6}M, Position ${POSITION_PCT*100}% × max ${MAX_CONCURRENT} concurrent, multi-pos per coin OK`);
  L.push('='.repeat(160));

  interface Res { name: string; n: number; wr: number; total: number; pf: number; mdd: number; }
  const results: Res[] = [];
  for (const algo of ALGOS) {
    const allSigs: RawSignal[] = [];
    for (const coin of COINS) {
      const bars = barsByCoin.get(coin)!;
      for (const s of algo.fn(bars, coin)) allSigs.push(s);
    }
    const { trades, finalCash, mdd } = simulate(allSigs, barsByCoin);
    const n = trades.length;
    const wins = trades.filter(t => t.profitKrw > 0);
    const losses = trades.filter(t => t.profitKrw <= 0);
    const wr = n ? wins.length / n * 100 : 0;
    const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
    const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
    const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
    const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
    results.push({ name: algo.name, n, wr, total, pf, mdd });
  }

  L.push(`\n${pad('algo', 18)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(75));
  for (const r of results.sort((a, b) => b.pf - a.pf)) {
    const pass = r.pf >= 1.2 && r.total > 0;
    L.push(`${pad(r.name, 18)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
  }
  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-8A.txt`), L.join('\n'));
  process.exit(0);
})();
