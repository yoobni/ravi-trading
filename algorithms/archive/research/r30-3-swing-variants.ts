/**
 * R30-3 — 단타 + swing 전환 가능 variants.
 *
 * baseline은 단타 (TP 3-5%) 이지만 MAX days를 넉넉히 (3d~21d) 두어
 * 큰 trend면 swing으로 자연스럽게 전환되도록 함.
 *
 * 빈도 강제 청산 없이 PF 중심 평가.
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
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH'];
const COST_RT = 0.001;

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
function calcMACD(closes: number[]) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? (e12[i]! - e26[i]!) : null);
  const macdPad = macd.map(v => v ?? 0);
  const sigRaw = calcEMA(macdPad, 9);
  const sig = macd.map((v, i) => v == null ? null : sigRaw[i]);
  const hist = macd.map((v, i) => (v != null && sig[i] != null) ? v - sig[i]! : null);
  return { macd, sig, hist };
}
function calcBB(closes: number[], period = 20, mult = 2) {
  const lower: (number|null)[] = [], upper: (number|null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { lower.push(null); upper.push(null); continue; }
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    lower.push(mean - mult*sd); upper.push(mean + mult*sd);
  }
  return { lower, upper };
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface Signal { barIdx: number; }

function sigBreakout(bars: CachedBar[], lookback = 24, volZ = 1.0): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ barIdx: i });
    }
  }
  return out;
}
function sigSMA(bars: CachedBar[], fast = 12, slow = 26, volZ = 0.5): Signal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ef = calcEMA(closes, fast), es = calcEMA(closes, slow);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ef[i-1] == null || es[i-1] == null || ef[i] == null || es[i] == null) continue;
    if (ef[i-1]! < es[i-1]! && ef[i]! > es[i]!) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ barIdx: i });
    }
  }
  return out;
}
function sigEMATrend(bars: CachedBar[], volZ = 0.8): Signal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26), e50 = calcEMA(closes, 50);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i] == null || e26[i] == null || e50[i] == null) continue;
    if (closes[i] > e50[i]! && e12[i]! > e26[i]! && bars[i].close > bars[i].open) {
      if (bars[i-1].low <= e26[i-1]! && bars[i].close > e26[i]!) {
        const z = calcVolZ(volumes, i, 30);
        if (z == null || z < volZ) continue;
        out.push({ barIdx: i });
      }
    }
  }
  return out;
}
function sigMACD(bars: CachedBar[], volZ = 0.5): Signal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const { macd, sig, hist } = calcMACD(closes);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (macd[i-1] == null || macd[i] == null || sig[i-1] == null || sig[i] == null || hist[i] == null) continue;
    if (macd[i-1]! < sig[i-1]! && macd[i]! > sig[i]! && hist[i]! > 0) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ barIdx: i });
    }
  }
  return out;
}
function sigRSI(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const rsi = calcRSI(closes, 14);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (rsi[i-1] == null || rsi[i] == null) continue;
    if (rsi[i-1]! < 30 && rsi[i]! > 30 && bars[i].close > bars[i].open) out.push({ barIdx: i });
  }
  return out;
}
function sigBB(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const bb = calcBB(closes, 20, 2);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bb.lower[i-1] == null || bb.lower[i] == null) continue;
    if (closes[i-1] < bb.lower[i-1]! && closes[i] > bb.lower[i]! && bars[i].close > bars[i].open) out.push({ barIdx: i });
  }
  return out;
}

interface Variant { name: string; tp: number; sl: number; maxBars: number; cooldown: number; }
const VARIANTS: Variant[] = [
  // baseline 단타 (R30-2의 best)
  { name: 'TP3_SL1.5_3d',   tp: 3.0,  sl: -1.5, maxBars: 72,  cooldown: 6 },
  // swing 가능 (MAX 길게)
  { name: 'TP3_SL1.5_7d',   tp: 3.0,  sl: -1.5, maxBars: 168, cooldown: 6 },
  { name: 'TP5_SL2_7d',     tp: 5.0,  sl: -2.0, maxBars: 168, cooldown: 12 },
  { name: 'TP5_SL2_14d',    tp: 5.0,  sl: -2.0, maxBars: 336, cooldown: 12 },
  { name: 'TP8_SL3_10d',    tp: 8.0,  sl: -3.0, maxBars: 240, cooldown: 12 },
  { name: 'TP8_SL3_21d',    tp: 8.0,  sl: -3.0, maxBars: 504, cooldown: 12 },
  { name: 'TP10_SL4_14d',   tp: 10.0, sl: -4.0, maxBars: 336, cooldown: 12 },
  { name: 'TP10_SL4_21d',   tp: 10.0, sl: -4.0, maxBars: 504, cooldown: 12 },
  { name: 'TP15_SL5_21d',   tp: 15.0, sl: -5.0, maxBars: 504, cooldown: 24 },
];

const ALGOS = [
  { name: 'BREAKOUT12 z1.0', fn: (b: CachedBar[]) => sigBreakout(b, 12, 1.0) },
  { name: 'BREAKOUT24 z1.0', fn: (b: CachedBar[]) => sigBreakout(b, 24, 1.0) },
  { name: 'BREAKOUT48 z1.0', fn: (b: CachedBar[]) => sigBreakout(b, 48, 1.0) },
  { name: 'SMA z0.5',        fn: (b: CachedBar[]) => sigSMA(b, 12, 26, 0.5) },
  { name: 'EMA_TREND z0.8',  fn: (b: CachedBar[]) => sigEMATrend(b, 0.8) },
  { name: 'MACD z0.5',       fn: (b: CachedBar[]) => sigMACD(b, 0.5) },
  { name: 'RSI_BOUNCE',      fn: sigRSI },
  { name: 'BB_BOUNCE',       fn: sigBB },
];

interface Trade { entryIdx: number; exitIdx: number; rawRet: number; netRet: number; holdBars: number; reason: 'TP'|'SL'|'TIME'; }
function simulate(bars: CachedBar[], signals: Signal[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  let cdUntil = -1;
  for (const sig of signals) {
    if (sig.barIdx < cdUntil) continue;
    const entryIdx = sig.barIdx + 1;
    if (entryIdx >= bars.length) continue;
    const entry = bars[entryIdx].open;
    const tp = entry * (1 + v.tp / 100), sl = entry * (1 + v.sl / 100);
    let exitIdx = -1, rawRet = 0, reason: 'TP'|'SL'|'TIME' = 'TIME';
    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + v.maxBars); j++) {
      const b = bars[j];
      if (b.low <= sl) { exitIdx = j; rawRet = v.sl; reason = 'SL'; break; }
      if (b.high >= tp) { exitIdx = j; rawRet = v.tp; reason = 'TP'; break; }
    }
    if (exitIdx < 0) {
      const last = Math.min(bars.length - 1, entryIdx + v.maxBars - 1);
      exitIdx = last;
      rawRet = (bars[last].close - entry) / entry * 100;
      reason = 'TIME';
    }
    const netRet = rawRet - COST_RT * 100;
    trades.push({ entryIdx, exitIdx, rawRet, netRet, holdBars: exitIdx - entryIdx + 1, reason });
    cdUntil = exitIdx + v.cooldown;
  }
  return trades;
}
function stats(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, avgHoldH: 0, tpRate: 0, slRate: 0, timeRate: 0 };
  const wins = trades.filter(t => t.netRet > 0), losses = trades.filter(t => t.netRet <= 0);
  const wr = wins.length / n * 100;
  const total = trades.reduce((s, t) => s + t.netRet, 0);
  const totWin = wins.reduce((s, t) => s + t.netRet, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.netRet, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const avgHoldH = trades.reduce((s, t) => s + t.holdBars, 0) / n;
  const tp = trades.filter(t => t.reason === 'TP').length;
  const sl = trades.filter(t => t.reason === 'SL').length;
  const tm = trades.filter(t => t.reason === 'TIME').length;
  return { n, wr, total, pf, avgHoldH, tpRate: tp/n*100, slRate: sl/n*100, timeRate: tm/n*100 };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R30-3 SWING VARIANTS (단타 + swing 전환) ===\n`);

  const L: string[] = [];
  L.push('='.repeat(180));
  L.push(`R30-3 SWING VARIANTS — 단타 baseline + MAX days 넉넉 (3d~21d)`);
  L.push(`8 algos × 9 variants × 10 coins = 720 cells, Upbit 60m, 1y (2025-06~26-06)`);
  L.push(`PASS: PF≥1.2 + total>0`);
  L.push('='.repeat(180));

  interface Row { coin: string; algo: string; variant: string; n: number; wr: number; total: number; pf: number; avgHoldH: number; tpRate: number; slRate: number; timeRate: number; }
  const rows: Row[] = [];

  for (const algo of ALGOS) {
    for (const coin of COINS) {
      const bars = loadBars(coin);
      const sigs = algo.fn(bars);
      for (const v of VARIANTS) {
        const trades = simulate(bars, sigs, v);
        const s = stats(trades);
        rows.push({ coin, algo: algo.name, variant: v.name, ...s });
      }
    }
  }

  const passes = rows.filter(r => r.pf >= 1.2 && r.total > 0);
  L.push(`\n## 통과 cells (PF≥1.2, total>0) — ${passes.length}개\n`);
  L.push(`${pad('coin', 5)} | ${pad('algo', 17)} | ${pad('variant', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('hold(h)', 8)} | ${padS('TP%', 5)} | ${padS('SL%', 5)} | ${padS('TIME%', 6)}`);
  L.push('-'.repeat(125));
  for (const r of passes.sort((a, b) => b.pf - a.pf)) {
    L.push(`${pad(r.coin, 5)} | ${pad(r.algo, 17)} | ${pad(r.variant, 16)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.avgHoldH.toFixed(0), 8)} | ${padS(r.tpRate.toFixed(0)+'%', 5)} | ${padS(r.slRate.toFixed(0)+'%', 5)} | ${padS(r.timeRate.toFixed(0)+'%', 6)}`);
  }

  // Algo aggregate
  L.push(`\n## algorithm aggregate (10 coins × 9 variants = 90 cells each)\n`);
  L.push(`${pad('algo', 20)} | ${padS('avg PF', 7)} | ${padS('pass count', 10)} | ${padS('avg total', 10)} | ${padS('best PF', 8)}`);
  L.push('-'.repeat(70));
  for (const algo of ALGOS) {
    const sub = rows.filter(r => r.algo === algo.name);
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const avgTotal = sub.reduce((s, r) => s + r.total, 0) / sub.length;
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0).length;
    const best = sub.reduce((b, r) => r.pf > b.pf ? r : b, sub[0]);
    L.push(`${pad(algo.name, 20)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(String(passCount), 10)} | ${padS(fmt(avgTotal), 10)} | ${padS(best.pf.toFixed(2), 8)}`);
  }

  // Coin aggregate
  L.push(`\n## coin aggregate (8 algos × 9 variants = 72 cells each)\n`);
  L.push(`${pad('coin', 5)} | ${padS('avg PF', 7)} | ${padS('pass count', 10)} | ${padS('avg total', 10)} | ${padS('best PF', 8)}`);
  L.push('-'.repeat(60));
  for (const coin of COINS) {
    const sub = rows.filter(r => r.coin === coin);
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const avgTotal = sub.reduce((s, r) => s + r.total, 0) / sub.length;
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0).length;
    const best = sub.reduce((b, r) => r.pf > b.pf ? r : b, sub[0]);
    L.push(`${pad(coin, 5)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(String(passCount), 10)} | ${padS(fmt(avgTotal), 10)} | ${padS(best.pf.toFixed(2), 8)}`);
  }

  // Variant aggregate
  L.push(`\n## variant aggregate (10 coins × 8 algos = 80 cells each)\n`);
  L.push(`${pad('variant', 18)} | ${padS('avg PF', 7)} | ${padS('pass count', 10)} | ${padS('avg total', 10)} | ${padS('avg hold(h)', 12)}`);
  L.push('-'.repeat(75));
  for (const v of VARIANTS) {
    const sub = rows.filter(r => r.variant === v.name);
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const avgTotal = sub.reduce((s, r) => s + r.total, 0) / sub.length;
    const avgHold = sub.reduce((s, r) => s + r.avgHoldH, 0) / sub.length;
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0).length;
    L.push(`${pad(v.name, 18)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(String(passCount), 10)} | ${padS(fmt(avgTotal), 10)} | ${padS(avgHold.toFixed(0), 12)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30-3_SWING.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
