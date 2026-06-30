/**
 * R30-7 — quality filter 유지 + 넓은 TP/SL (payoff ratio 확보).
 *
 * 라비 통찰: WR 올리려 TP 좁히면 payoff ratio 떨어져 total 감소.
 * 답: confluence filter는 유지 (false break 줄임 → SL 비율 ↓),
 *      TP/SL은 넓혀 payoff 확보 (큰 winner 잡음).
 *
 * Variant 3종 sweep × 10 algos × 10 coins = 30 portfolio runs.
 *   V1: TP+5%/SL-2%/MAX 14d   (baseline, R30-5와 동일)
 *   V2: TP+7%/SL-2.5%/MAX 14d (mid)
 *   V3: TP+10%/SL-3%/MAX 21d  (swing 가능)
 *
 * EV per trade = WR×TP - (1-WR)×|SL| 비교.
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
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;

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
  let atr: number | null = null;
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { sum += tr[i]; continue; }
    if (atr === null) { sum += tr[i]; atr = sum / period; }
    else atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}
function calcADX(highs: number[], lows: number[], closes: number[], period = 14): (number|null)[] {
  const n = closes.length;
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    if (upMove > downMove && upMove > 0) plusDM[i] = upMove;
    if (downMove > upMove && downMove > 0) minusDM[i] = downMove;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  const sTR: number[] = new Array(n).fill(0);
  const sPlusDM: number[] = new Array(n).fill(0);
  const sMinusDM: number[] = new Array(n).fill(0);
  let trSum = 0, pdmSum = 0, mdmSum = 0;
  for (let i = 1; i <= period; i++) { trSum += tr[i]; pdmSum += plusDM[i]; mdmSum += minusDM[i]; }
  sTR[period] = trSum; sPlusDM[period] = pdmSum; sMinusDM[period] = mdmSum;
  for (let i = period + 1; i < n; i++) {
    sTR[i] = sTR[i-1] - sTR[i-1]/period + tr[i];
    sPlusDM[i] = sPlusDM[i-1] - sPlusDM[i-1]/period + plusDM[i];
    sMinusDM[i] = sMinusDM[i-1] - sMinusDM[i-1]/period + minusDM[i];
  }
  const dx: number[] = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    const pDI = sTR[i] > 0 ? 100 * sPlusDM[i] / sTR[i] : 0;
    const mDI = sTR[i] > 0 ? 100 * sMinusDM[i] / sTR[i] : 0;
    dx[i] = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
  }
  const adx: (number|null)[] = new Array(n).fill(null);
  let adxSum = 0;
  for (let i = period; i < period * 2; i++) adxSum += dx[i];
  adx[period * 2 - 1] = adxSum / period;
  for (let i = period * 2; i < n; i++) adx[i] = (adx[i-1]! * (period - 1) + dx[i]) / period;
  return adx;
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
function commonOK(closes: number[], rsi: (number|null)[], ema50: (number|null)[], volumes: number[], i: number, rsiLow: number, rsiHigh: number, volZ: number): boolean {
  if (ema50[i] == null || rsi[i] == null) return false;
  if (closes[i] <= ema50[i]!) return false;
  if (rsi[i]! < rsiLow || rsi[i]! > rsiHigh) return false;
  const z = calcVolZ(volumes, i, 30);
  if (z == null || z < volZ) return false;
  return true;
}

function sigWeekHighV2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema50 = calcEMA(closes, 50), rsi = calcRSI(closes, 14);
  const lookback = 168; const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      if (!commonOK(closes, rsi, ema50, volumes, i, 45, 75, 1.0)) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigBreakout24V2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema50 = calcEMA(closes, 50), rsi = calcRSI(closes, 14);
  const lookback = 24; const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (closes[i] > prevMax) {
      if (!commonOK(closes, rsi, ema50, volumes, i, 45, 70, 1.0)) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigDonchianV2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const adx = calcADX(highs, lows, closes, 14);
  const lookback = 20; const out: RawSignal[] = [];
  for (let i = lookback + 30; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      if (adx[i] == null || adx[i]! < 20) continue;
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 0.5) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigMomentum5V2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 5; i < bars.length; i++) {
    if (ema50[i] == null) continue;
    let ok = true;
    for (let k = 4; k >= 0; k--) if (!(closes[i-k-1] < closes[i-k])) { ok = false; break; }
    if (!ok) continue;
    if (closes[i] <= ema50[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigSMAV2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26), ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ema12[i-1] == null || ema26[i-1] == null || ema12[i] == null || ema26[i] == null) continue;
    if (!(ema12[i-1]! < ema26[i-1]! && ema12[i]! > ema26[i]!)) continue;
    if (!commonOK(closes, rsi, ema50, volumes, i, 40, 65, 0.5)) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigKeltnerV2(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
  const atr14 = calcATR(highs, lows, closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ema20[i-1] == null || ema20[i] == null || atr14[i-1] == null || atr14[i] == null || ema50[i] == null) continue;
    const upperPrev = ema20[i-1]! + 2 * atr14[i-1]!;
    const upperCur = ema20[i]! + 2 * atr14[i]!;
    if (!(closes[i-1] <= upperPrev && closes[i] > upperCur)) continue;
    if (closes[i] <= ema50[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigPullback(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
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
function sigHigherHigh(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema50 = calcEMA(closes, 50);
  const lookback = 12; const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    if (ema50[i] == null) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(closes[i] > prevMax)) continue;
    if (closes[i] <= ema50[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigTrendRSI(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (rsi[i-1] == null || rsi[i] == null || ema20[i] == null || ema50[i] == null) continue;
    if (!(rsi[i-1]! < 50 && rsi[i]! >= 50)) continue;
    if (closes[i] <= ema20[i]!) continue;
    if (ema20[i]! <= ema50[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.8) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigVolExpansion(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 20, 2);
  const ema50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 50; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null || ema50[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - 50; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    const isSqueeze = bb.width[i]! <= minWidth * 1.1;
    if (!isSqueeze) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    if (closes[i] <= ema50[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

const ALGOS = [
  { name: 'A1 WEEK_HIGH v2',  fn: sigWeekHighV2 },
  { name: 'A2 BREAKOUT24 v2', fn: sigBreakout24V2 },
  { name: 'A3 DONCHIAN20 v2', fn: sigDonchianV2 },
  { name: 'A4 MOMENTUM5 v2',  fn: sigMomentum5V2 },
  { name: 'A5 SMA_CROSS v2',  fn: sigSMAV2 },
  { name: 'A6 KELTNER v2',    fn: sigKeltnerV2 },
  { name: 'A7 PULLBACK',      fn: sigPullback },
  { name: 'A8 HIGHER_HIGH',   fn: sigHigherHigh },
  { name: 'A9 TREND_RSI',     fn: sigTrendRSI },
  { name: 'A10 VOL_EXPANSION', fn: sigVolExpansion },
];

interface Variant { name: string; tp: number; sl: number; maxBars: number; }
const VARIANTS: Variant[] = [
  { name: 'V1 TP5/SL2/14d',    tp: 5,  sl: -2,   maxBars: 336 },
  { name: 'V2 TP7/SL2.5/14d',  tp: 7,  sl: -2.5, maxBars: 336 },
  { name: 'V3 TP10/SL3/21d',   tp: 10, sl: -3,   maxBars: 504 },
];

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }
function simulate(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>, v: Variant) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: PfTrade[] = [];
  const sigByTs = new Map<number, RawSignal[]>();
  for (const sig of [...rawSignals].sort((a, b) => a.ts - b.ts)) {
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
      const tp = pos.entryPrice * (1 + v.tp / 100), sl = pos.entryPrice * (1 + v.sl / 100);
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: PfTrade['reason'] | null = null, rawRet = 0;
      if (b.low <= sl) { exitPrice = sl; reason = 'SL'; rawRet = v.sl; }
      else if (b.high >= tp) { exitPrice = tp; reason = 'TP'; rawRet = v.tp; }
      else if (holdBars >= v.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
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
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: last.ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R30-7 EV OPTIMAL (quality filter + 넓은 TP/SL) ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R30-7 EV OPTIMAL — 10 algos (R30-6 confluence filter 유지) × 3 variant × 10 coin pool`);
  L.push(`Capital ${INITIAL_CASH/1e6}M, Position ${POSITION_PCT*100}% × max ${MAX_CONCURRENT} concurrent, multi-pos per coin OK. Cost RT 0.1%`);
  L.push('='.repeat(170));

  // Pre-compute signals per algo (variant 무관)
  const sigsByAlgo = new Map<string, RawSignal[]>();
  for (const algo of ALGOS) {
    const all: RawSignal[] = [];
    for (const coin of COINS) {
      const bars = barsByCoin.get(coin)!;
      for (const s of algo.fn(bars, coin)) all.push(s);
    }
    sigsByAlgo.set(algo.name, all);
  }

  interface Res { algo: string; variant: string; n: number; wr: number; total: number; pf: number; mdd: number; ev: number; tpRate: number; }
  const rows: Res[] = [];

  for (const v of VARIANTS) {
    L.push(`\n## ${v.name}\n`);
    L.push(`${pad('algo', 19)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('EV/trade', 9)} | ${padS('TP%', 5)} | pass`);
    L.push('-'.repeat(95));
    for (const algo of ALGOS) {
      const sigs = sigsByAlgo.get(algo.name)!;
      const { trades, finalCash, mdd } = simulate(sigs, barsByCoin, v);
      const n = trades.length;
      const wins = trades.filter(t => t.profitKrw > 0);
      const losses = trades.filter(t => t.profitKrw <= 0);
      const wr = n ? wins.length / n * 100 : 0;
      const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
      const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
      const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
      const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
      const tp = trades.filter(t => t.reason === 'TP').length;
      const tpRate = n ? tp/n*100 : 0;
      const ev = n ? trades.reduce((s, t) => s + t.netRet, 0) / n : 0;
      const pass = pf >= 1.2 && total > 0;
      rows.push({ algo: algo.name, variant: v.name, n, wr, total, pf, mdd, ev, tpRate });
      L.push(`${pad(algo.name, 19)} | ${padS(String(n), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(total), 9)} | ${padS(pf.toFixed(2), 5)} | ${padS(mdd.toFixed(1)+'%', 6)} | ${padS(fmt(ev, false), 9)} | ${padS(tpRate.toFixed(0)+'%', 5)} | ${pass ? '✓' : ''}`);
    }
  }

  // TOP cells overall
  L.push(`\n\n## TOP cells overall (sorted by total)\n`);
  L.push(`${pad('algo', 19)} | ${pad('variant', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('EV/trade', 9)} | pass`);
  L.push('-'.repeat(115));
  for (const r of rows.filter(r => r.pf >= 1.2 && r.total > 0).sort((a, b) => b.total - a.total)) {
    L.push(`${pad(r.algo, 19)} | ${pad(r.variant, 22)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${padS(fmt(r.ev, false), 9)} | ✓`);
  }

  L.push(`\n## variant aggregate\n`);
  L.push(`${pad('variant', 22)} | ${padS('passes', 7)} | ${padS('avg PF', 7)} | ${padS('avg total', 10)} | ${padS('avg EV', 8)}`);
  L.push('-'.repeat(70));
  for (const v of VARIANTS) {
    const sub = rows.filter(r => r.variant === v.name);
    const passCount = sub.filter(r => r.pf >= 1.2 && r.total > 0).length;
    const avgPF = sub.reduce((s, r) => s + r.pf, 0) / sub.length;
    const avgTotal = sub.reduce((s, r) => s + r.total, 0) / sub.length;
    const avgEV = sub.reduce((s, r) => s + r.ev, 0) / sub.length;
    L.push(`${pad(v.name, 22)} | ${padS(String(passCount), 7)} | ${padS(avgPF.toFixed(2), 7)} | ${padS(fmt(avgTotal), 10)} | ${padS(fmt(avgEV, false), 8)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30-7_EV.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
