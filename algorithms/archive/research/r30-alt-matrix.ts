/**
 * R30 — Upbit spot LONG alt × algorithm matrix.
 *
 * 데이터: Upbit 60m, 1년 (2025-06-10 ~ 2026-06-10).
 * 알트: BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, BCH.
 * 알고리즘 (LONG only — Upbit spot):
 *   A1 SMA_CROSS    : EMA12 cross over EMA26 + vol z>0.5
 *   A2 RSI_BOUNCE   : RSI<30 후 RSI cross up 30 + green bar
 *   A3 MACD_BULL    : MACD line cross over signal line, hist>0
 *   A4 BB_BOUNCE    : close<lowerBB 후 close>lowerBB + 양봉
 *   A5 BREAKOUT     : close > prev 24h high + vol z>1
 *   A6 HA_REVERSAL  : red HA candle 3+ → green HA candle (강한 반전)
 *   A7 VWAP_BOUNCE  : close 24h VWAP 아래에서 위로 cross
 *   A8 EMA_TREND    : close>EMA50 + EMA12>EMA26 + green bar + vol z>0.8
 *
 * Exit: TP +3%, SL -1.5%, MAX 24h. Cooldown 12h after exit.
 * Cost: 0.1% RT (Upbit 0.05% × 2 + slippage 0.05%).
 * Pass: PF≥1.2 & total>0 & 1.0~3.0 trades/day.
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
const TP_PCT = 3.0;
const SL_PCT = -1.5;
const MAX_BARS = 24; // 24h
const COOLDOWN_BARS = 12;

function loadBars(coin: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${coin}_${UNIT}m_${FROM}_${TO}.json`);
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function calcEMA(values: number[], period: number): (number|null)[] {
  const k = 2 / (period + 1);
  const out: (number|null)[] = new Array(values.length).fill(null);
  let ema: number | null = null;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { sum += values[i]; continue; }
    if (ema === null) { sum += values[i]; ema = sum / period; }
    else ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRSI(closes: number[], period = 14): (number|null)[] {
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        const rs = avgGain / (avgLoss || 1e-12);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgGain / (avgLoss || 1e-12);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function calcMACD(closes: number[]): { macd: (number|null)[]; sig: (number|null)[]; hist: (number|null)[] } {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? (ema12[i]! - ema26[i]!) : null);
  // signal line = EMA9(macd)
  const macdValid = macd.map(v => v ?? 0); // pad with 0; we filter later
  const sigRaw = calcEMA(macdValid, 9);
  const sig: (number|null)[] = macd.map((v, i) => (v == null) ? null : sigRaw[i]);
  const hist: (number|null)[] = macd.map((v, i) => (v != null && sig[i] != null) ? (v - sig[i]!) : null);
  return { macd, sig, hist };
}

function calcBB(closes: number[], period = 20, mult = 2): { lower: (number|null)[]; upper: (number|null)[]; mid: (number|null)[] } {
  const out = { lower: [] as (number|null)[], upper: [] as (number|null)[], mid: [] as (number|null)[] };
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.lower.push(null); out.upper.push(null); out.mid.push(null); continue; }
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j] * closes[j]; }
    const mean = sum / period;
    const variance = (sum2 / period) - mean * mean;
    const sd = Math.sqrt(Math.max(variance, 0));
    out.lower.push(mean - mult * sd);
    out.upper.push(mean + mult * sd);
    out.mid.push(mean);
  }
  return out;
}

function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j] * volumes[j]; }
  const mean = sum / window;
  const variance = (sum2 / window) - mean * mean;
  const sd = Math.sqrt(Math.max(variance, 1e-12));
  if (sd <= 0) return null;
  return (volumes[i] - mean) / sd;
}

function heikinAshi(bars: CachedBar[]): { ho: number[]; hc: number[]; hh: number[]; hl: number[] } {
  const ho: number[] = [], hc: number[] = [], hh: number[] = [], hl: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const hcv = (b.open + b.high + b.low + b.close) / 4;
    const hov = i === 0 ? b.open : (ho[i-1] + hc[i-1]) / 2;
    hc.push(hcv);
    ho.push(hov);
    hh.push(Math.max(b.high, hov, hcv));
    hl.push(Math.min(b.low, hov, hcv));
  }
  return { ho, hc, hh, hl };
}

function maxOver(values: number[], i: number, window: number): number {
  let max = -Infinity;
  for (let j = Math.max(0, i - window + 1); j <= i; j++) if (values[j] > max) max = values[j];
  return max;
}

function vwap(bars: CachedBar[], i: number, window: number): number | null {
  if (i < window - 1) return null;
  let pv = 0, v = 0;
  for (let j = i - window + 1; j <= i; j++) {
    const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
    pv += tp * bars[j].volume;
    v += bars[j].volume;
  }
  return v > 0 ? pv / v : null;
}

interface Signal { barIdx: number; }

function signalsA1_SMA(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i-1] == null || e26[i-1] == null || e12[i] == null || e26[i] == null) continue;
    if (e12[i-1]! < e26[i-1]! && e12[i]! > e26[i]!) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 0.5) continue;
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA2_RSI(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const rsi = calcRSI(closes, 14);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (rsi[i-1] == null || rsi[i] == null) continue;
    if (rsi[i-1]! < 30 && rsi[i]! > 30 && bars[i].close > bars[i].open) {
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA3_MACD(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const { macd, sig, hist } = calcMACD(closes);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (macd[i-1] == null || macd[i] == null || sig[i-1] == null || sig[i] == null || hist[i] == null) continue;
    if (macd[i-1]! < sig[i-1]! && macd[i]! > sig[i]! && hist[i]! > 0) {
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA4_BB(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const bb = calcBB(closes, 20, 2);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bb.lower[i-1] == null || bb.lower[i] == null) continue;
    if (closes[i-1] < bb.lower[i-1]! && closes[i] > bb.lower[i]! && bars[i].close > bars[i].open) {
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA5_BREAKOUT(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 25; i < bars.length; i++) {
    // close > prior 24h high (i-24..i-1), excludes current
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (closes[i] > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA6_HA(bars: CachedBar[]): Signal[] {
  const ha = heikinAshi(bars);
  const out: Signal[] = [];
  for (let i = 3; i < bars.length; i++) {
    // prior 3+ red HA, current green
    let redStreak = 0;
    for (let j = i - 1; j >= 0 && ha.hc[j] < ha.ho[j]; j--) redStreak++;
    if (redStreak >= 3 && ha.hc[i] > ha.ho[i]) {
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA7_VWAP(bars: CachedBar[]): Signal[] {
  const out: Signal[] = [];
  for (let i = 24; i < bars.length; i++) {
    const v0 = vwap(bars, i-1, 24);
    const v1 = vwap(bars, i, 24);
    if (v0 == null || v1 == null) continue;
    if (bars[i-1].close < v0 && bars[i].close > v1 && bars[i].close > bars[i].open) {
      out.push({ barIdx: i });
    }
  }
  return out;
}

function signalsA8_EMA_TREND(bars: CachedBar[]): Signal[] {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const e50 = calcEMA(closes, 50);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i] == null || e26[i] == null || e50[i] == null) continue;
    if (closes[i] > e50[i]! && e12[i]! > e26[i]! && bars[i].close > bars[i].open) {
      // pullback to e26 then re-touch up
      if (bars[i-1].low <= e26[i-1]! && bars[i].close > e26[i]!) {
        const z = calcVolZ(volumes, i, 30);
        if (z == null || z < 0.8) continue;
        out.push({ barIdx: i });
      }
    }
  }
  return out;
}

const ALGOS = [
  { name: 'A1 SMA_CROSS',  fn: signalsA1_SMA },
  { name: 'A2 RSI_BOUNCE', fn: signalsA2_RSI },
  { name: 'A3 MACD_BULL',  fn: signalsA3_MACD },
  { name: 'A4 BB_BOUNCE',  fn: signalsA4_BB },
  { name: 'A5 BREAKOUT',   fn: signalsA5_BREAKOUT },
  { name: 'A6 HA_REVERSAL', fn: signalsA6_HA },
  { name: 'A7 VWAP_BOUNCE', fn: signalsA7_VWAP },
  { name: 'A8 EMA_TREND',  fn: signalsA8_EMA_TREND },
];

interface Trade { entryIdx: number; exitIdx: number; entryPrice: number; exitPrice: number; reason: 'TP'|'SL'|'TIME'; rawRet: number; netRet: number; }

function simulate(bars: CachedBar[], signals: Signal[]): Trade[] {
  const trades: Trade[] = [];
  let cooldownUntilIdx = -1;
  for (const sig of signals) {
    if (sig.barIdx < cooldownUntilIdx) continue;
    // entry at next bar open
    const entryIdx = sig.barIdx + 1;
    if (entryIdx >= bars.length) continue;
    const entry = bars[entryIdx].open;
    const tp = entry * (1 + TP_PCT / 100);
    const sl = entry * (1 + SL_PCT / 100);
    let exitIdx = -1, exitPrice = 0, reason: 'TP'|'SL'|'TIME' = 'TIME', rawRet = 0;
    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + MAX_BARS); j++) {
      const b = bars[j];
      // priority: SL first (conservative)
      if (b.low <= sl) { exitIdx = j; exitPrice = sl; reason = 'SL'; rawRet = SL_PCT; break; }
      if (b.high >= tp) { exitIdx = j; exitPrice = tp; reason = 'TP'; rawRet = TP_PCT; break; }
    }
    if (exitIdx < 0) {
      const last = Math.min(bars.length - 1, entryIdx + MAX_BARS - 1);
      exitIdx = last; exitPrice = bars[last].close; reason = 'TIME';
      rawRet = (bars[last].close - entry) / entry * 100;
    }
    const netRet = rawRet - COST_RT * 100;
    trades.push({ entryIdx, exitIdx, entryPrice: entry, exitPrice, reason, rawRet, netRet });
    cooldownUntilIdx = exitIdx + COOLDOWN_BARS;
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, avgWin: 0, avgLoss: 0 };
  const wins = trades.filter(t => t.netRet > 0);
  const losses = trades.filter(t => t.netRet <= 0);
  const wr = wins.length / n * 100;
  const total = trades.reduce((s, t) => s + t.netRet, 0);
  const totWin = wins.reduce((s, t) => s + t.netRet, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.netRet, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const avgWin = wins.length ? totWin / wins.length : 0;
  const avgLoss = losses.length ? -totLoss / losses.length : 0;
  return { n, wr, total, pf, avgWin, avgLoss };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R30 ALT × ALGORITHM MATRIX (Upbit 60m 1y) ===\n`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R30 ALT × ALGORITHM MATRIX — Upbit spot LONG, 60m bars, 2025-06-10~2026-06-10`);
  L.push(`Exit: TP +${TP_PCT}% / SL ${SL_PCT}% / MAX ${MAX_BARS}h | Cooldown ${COOLDOWN_BARS}h | Cost RT ${(COST_RT*100).toFixed(1)}%`);
  L.push(`Pass: PF≥1.2 + total>0 + 0.5~3.0 trades/day | n_target = 182~1095 / year`);
  L.push('='.repeat(140));

  interface Row { coin: string; algo: string; n: number; perDay: number; wr: number; total: number; pf: number; }
  const allRows: Row[] = [];

  for (const algo of ALGOS) {
    L.push(`\n## ${algo.name}\n`);
    L.push(`${pad('coin', 6)} | ${padS('n', 4)} | ${padS('/day', 5)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 9)} | ${padS('PF', 5)} | pass`);
    L.push('-'.repeat(85));
    for (const coin of COINS) {
      const bars = loadBars(coin);
      const days = (bars[bars.length-1].ts - bars[0].ts) / 86400_000;
      const sigs = algo.fn(bars);
      const trades = simulate(bars, sigs);
      const s = stats(trades);
      const perDay = s.n / days;
      const pass = s.pf >= 1.2 && s.total > 0 && perDay >= 0.5 && perDay <= 3.0;
      allRows.push({ coin, algo: algo.name, n: s.n, perDay, wr: s.wr, total: s.total, pf: s.pf });
      L.push(`${pad(coin, 6)} | ${padS(String(s.n), 4)} | ${padS(perDay.toFixed(2), 5)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${pass ? '✓' : ''}`);
    }
  }

  // Top cells overall
  L.push(`\n\n## TOP 20 cells (sorted by PF, n≥50)\n`);
  L.push(`${pad('coin', 6)} | ${pad('algo', 20)} | ${padS('n', 4)} | ${padS('/day', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(80));
  const sorted = allRows.filter(r => r.n >= 50).sort((a, b) => b.pf - a.pf).slice(0, 20);
  for (const r of sorted) {
    L.push(`${pad(r.coin, 6)} | ${pad(r.algo, 20)} | ${padS(String(r.n), 4)} | ${padS(r.perDay.toFixed(2), 5)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)}`);
  }

  // Passes only
  const passes = allRows.filter(r => r.pf >= 1.2 && r.total > 0 && r.perDay >= 0.5 && r.perDay <= 3.0);
  L.push(`\n## 통과 cells (PF≥1.2, total>0, 0.5~3.0 trades/day) — ${passes.length}개\n`);
  L.push(`${pad('coin', 6)} | ${pad('algo', 20)} | ${padS('n', 4)} | ${padS('/day', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(80));
  for (const r of passes.sort((a, b) => b.pf - a.pf)) {
    L.push(`${pad(r.coin, 6)} | ${pad(r.algo, 20)} | ${padS(String(r.n), 4)} | ${padS(r.perDay.toFixed(2), 5)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30_ALT_MATRIX.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
