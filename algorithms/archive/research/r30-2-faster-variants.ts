/**
 * R30-2 — 빠른 매매 변형 (1-2 trades/day target).
 *
 * R30 1차 결과: 빈도 좋은 algos (MACD/BB/HA/VWAP)는 noise 많아 음수. 빈도 낮은 algos (SMA/RSI/BREAKOUT/EMA_TREND)는 PF 1.2+ 일부 있으나 0.15~0.25 trades/day.
 *
 * 빈도 늘리는 4가지 axis 변형 sweep:
 *   - Cooldown: 12h, 4h, 0h
 *   - TP/SL/MAX: (3.0/-1.5/24h) baseline, (1.5/-1.0/8h) fast, (2.0/-1.2/12h) mid
 *   - 알고리즘 4개 focus: A5 BREAKOUT (best PF), A1 SMA, A8 EMA_TREND, A3 MACD (high freq)
 *
 * Coins: 10개 모두.
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface Signal { barIdx: number; }

function sigBreakout(bars: CachedBar[], lookback = 12, volZ = 1.0): Signal[] {
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

interface Variant { name: string; tp: number; sl: number; maxBars: number; cooldown: number; }
const VARIANTS: Variant[] = [
  // baseline
  { name: 'TP3_SL1.5_24h_cd12h', tp: 3.0, sl: -1.5, maxBars: 24, cooldown: 12 },
  { name: 'TP3_SL1.5_24h_cd4h',  tp: 3.0, sl: -1.5, maxBars: 24, cooldown: 4 },
  { name: 'TP3_SL1.5_24h_cd0h',  tp: 3.0, sl: -1.5, maxBars: 24, cooldown: 0 },
  // fast
  { name: 'TP1.5_SL1.0_8h_cd4h', tp: 1.5, sl: -1.0, maxBars: 8,  cooldown: 4 },
  { name: 'TP1.5_SL1.0_8h_cd0h', tp: 1.5, sl: -1.0, maxBars: 8,  cooldown: 0 },
  // mid
  { name: 'TP2.0_SL1.2_12h_cd4h', tp: 2.0, sl: -1.2, maxBars: 12, cooldown: 4 },
  { name: 'TP2.0_SL1.2_12h_cd0h', tp: 2.0, sl: -1.2, maxBars: 12, cooldown: 0 },
];

const ALGOS = [
  { name: 'A5 BREAKOUT12 z1.0', fn: (b: CachedBar[]) => sigBreakout(b, 12, 1.0) },
  { name: 'A5 BREAKOUT24 z1.0', fn: (b: CachedBar[]) => sigBreakout(b, 24, 1.0) },
  { name: 'A5 BREAKOUT12 z0.5', fn: (b: CachedBar[]) => sigBreakout(b, 12, 0.5) },
  { name: 'A1 SMA z0.5', fn: (b: CachedBar[]) => sigSMA(b, 12, 26, 0.5) },
  { name: 'A8 EMA_TREND z0.8', fn: (b: CachedBar[]) => sigEMATrend(b, 0.8) },
  { name: 'A3 MACD z0.5', fn: (b: CachedBar[]) => sigMACD(b, 0.5) },
];

interface Trade { entryIdx: number; exitIdx: number; rawRet: number; netRet: number; }
function simulate(bars: CachedBar[], signals: Signal[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  let cdUntil = -1;
  for (const sig of signals) {
    if (sig.barIdx < cdUntil) continue;
    const entryIdx = sig.barIdx + 1;
    if (entryIdx >= bars.length) continue;
    const entry = bars[entryIdx].open;
    const tp = entry * (1 + v.tp / 100), sl = entry * (1 + v.sl / 100);
    let exitIdx = -1, rawRet = 0;
    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + v.maxBars); j++) {
      const b = bars[j];
      if (b.low <= sl) { exitIdx = j; rawRet = v.sl; break; }
      if (b.high >= tp) { exitIdx = j; rawRet = v.tp; break; }
    }
    if (exitIdx < 0) {
      const last = Math.min(bars.length - 1, entryIdx + v.maxBars - 1);
      exitIdx = last;
      rawRet = (bars[last].close - entry) / entry * 100;
    }
    const netRet = rawRet - COST_RT * 100;
    trades.push({ entryIdx, exitIdx, rawRet, netRet });
    cdUntil = exitIdx + v.cooldown;
  }
  return trades;
}
function stats(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0 };
  const wins = trades.filter(t => t.netRet > 0), losses = trades.filter(t => t.netRet <= 0);
  const wr = wins.length / n * 100;
  const total = trades.reduce((s, t) => s + t.netRet, 0);
  const totWin = wins.reduce((s, t) => s + t.netRet, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.netRet, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  return { n, wr, total, pf };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R30-2 FASTER VARIANTS ===\n`);

  const L: string[] = [];
  L.push('='.repeat(160));
  L.push(`R30-2 FASTER VARIANTS — Upbit 60m 1y. TP/SL/cooldown sweep × 6 algos × 10 coins.`);
  L.push(`Pass: PF≥1.2 + total>0 + 0.5~3.0 trades/day`);
  L.push('='.repeat(160));

  interface Row { coin: string; algo: string; variant: string; n: number; perDay: number; wr: number; total: number; pf: number; }
  const rows: Row[] = [];

  for (const algo of ALGOS) {
    for (const coin of COINS) {
      const bars = loadBars(coin);
      const days = (bars[bars.length-1].ts - bars[0].ts) / 86400_000;
      const sigs = algo.fn(bars);
      for (const v of VARIANTS) {
        const trades = simulate(bars, sigs, v);
        const s = stats(trades);
        const perDay = s.n / days;
        rows.push({ coin, algo: algo.name, variant: v.name, n: s.n, perDay, wr: s.wr, total: s.total, pf: s.pf });
      }
    }
  }

  const passes = rows.filter(r => r.pf >= 1.2 && r.total > 0 && r.perDay >= 0.5 && r.perDay <= 3.0);
  L.push(`\n## 통과 cells (PF≥1.2, total>0, 0.5~3.0 trades/day) — ${passes.length}개\n`);
  L.push(`${pad('coin', 5)} | ${pad('algo', 20)} | ${pad('variant', 22)} | ${padS('n', 4)} | ${padS('/day', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(105));
  for (const r of passes.sort((a, b) => b.pf - a.pf)) {
    L.push(`${pad(r.coin, 5)} | ${pad(r.algo, 20)} | ${pad(r.variant, 22)} | ${padS(String(r.n), 4)} | ${padS(r.perDay.toFixed(2), 5)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)}`);
  }

  L.push(`\n## TOP 30 cells (sorted by PF, n≥100)\n`);
  L.push(`${pad('coin', 5)} | ${pad('algo', 20)} | ${pad('variant', 22)} | ${padS('n', 4)} | ${padS('/day', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(105));
  for (const r of rows.filter(r => r.n >= 100).sort((a, b) => b.pf - a.pf).slice(0, 30)) {
    L.push(`${pad(r.coin, 5)} | ${pad(r.algo, 20)} | ${pad(r.variant, 22)} | ${padS(String(r.n), 4)} | ${padS(r.perDay.toFixed(2), 5)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)}`);
  }

  // Algo aggregate: 알고리즘별 평균 PF, 통과 cell 수
  L.push(`\n## algorithm aggregate (10 coins × 7 variants = 70 cells each)\n`);
  L.push(`${pad('algo', 20)} | ${padS('avg PF', 7)} | ${padS('passes', 7)} | ${padS('cells>1.2', 10)} | ${padS('cells>1.0', 10)}`);
  L.push('-'.repeat(70));
  for (const algo of ALGOS) {
    const sub = rows.filter(r => r.algo === algo.name);
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const pf12 = sub.filter(r => r.pf >= 1.2).length;
    const pf10 = sub.filter(r => r.pf >= 1.0).length;
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0 && r.perDay >= 0.5 && r.perDay <= 3.0).length;
    L.push(`${pad(algo.name, 20)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(String(passCount), 7)} | ${padS(String(pf12), 10)} | ${padS(String(pf10), 10)}`);
  }

  // Coin aggregate
  L.push(`\n## coin aggregate (6 algos × 7 variants = 42 cells each)\n`);
  L.push(`${pad('coin', 5)} | ${padS('avg PF', 7)} | ${padS('passes', 7)} | ${padS('cells>1.2', 10)}`);
  L.push('-'.repeat(50));
  for (const coin of COINS) {
    const sub = rows.filter(r => r.coin === coin);
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const pf12 = sub.filter(r => r.pf >= 1.2).length;
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0 && r.perDay >= 0.5 && r.perDay <= 3.0).length;
    L.push(`${pad(coin, 5)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(String(passCount), 7)} | ${padS(String(pf12), 10)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30-2_FASTER.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
