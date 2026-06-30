/**
 * R31 — 4h / daily TF에 algo 적용.
 *
 * 가설: 1h TF에서 진짜 알파 부재 입증됨. 더 긴 TF에서 더 안정적 알파 있을 가능성.
 *
 * 4h TF (84 bars = 14d MAX, TP+5%/SL-2%):
 *   F1 BREAKOUT24 (4d high)
 *   F2 BREAKOUT42 (7d high)
 *   F3 SMA_CROSS (12/26)
 *   F4 EMA_PULLBACK (EMA20/50)
 *   F5 BB_SQUEEZE (BB30/lb50)
 *   F6 NEW_HIGH_CONFIRM
 *
 * Daily TF (30 bars = 30d MAX, TP+10%/SL-4%):
 *   D1 BREAKOUT5 (5d high)
 *   D2 BREAKOUT10 (10d)
 *   D3 BREAKOUT30 (30d)
 *   D4 SMA_CROSS (20/50)
 *   D5 ATR_BREAKOUT
 *
 * Pool: 15 coins. Position 33% × max 3. 2년 (2024-06~26-06) + 분기 8개.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.001;
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;

const COINS_15 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function load4hBars(coin: string): CachedBar[] {
  const y1 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2024-06-10_2025-06-10.json`), 'utf-8'));
  const y2 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2025-06-10_2026-06-10.json`), 'utf-8'));
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const b of y1) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  for (const b of y2) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}
function loadDailyBars(coin: string): CachedBar[] {
  const arr = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_daily_800d_asof_2026-06-11.json`), 'utf-8'));
  // shape may have ts/date/open/high/low/close/volume. coerce to CachedBar
  return arr.map((b: any) => ({ ts: b.ts, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
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
function calcBB(closes: number[], period: number, mult = 2) {
  const n = closes.length;
  const upper: (number|null)[] = new Array(n).fill(null);
  const width: (number|null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    upper[i] = mean + mult*sd;
    width[i] = (2 * mult * sd) / mean;
  }
  return { upper, width };
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
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigSMACross(bars: CachedBar[], coin: string, fast: number, slow: number, volZ: number): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ef = calcEMA(closes, fast), es = calcEMA(closes, slow);
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
function sigEMAPullback(bars: CachedBar[], coin: string): RawSignal[] {
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
function sigBBSqueeze(bars: CachedBar[], coin: string, bbPeriod: number, lookback: number, squeezeMult: number, volZ: number): RawSignal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, bbPeriod, 2);
  const out: RawSignal[] = [];
  for (let i = Math.max(bbPeriod, lookback) + 1; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - lookback; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    if (bb.width[i]! > minWidth * squeezeMult) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZ) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigNewHighConfirm(bars: CachedBar[], coin: string, lookback: number): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    // 직전 N bar 안에 신고가 발생 + 현재 양봉으로 follow-through
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].high <= prevMax) continue;
    if (bars[i].close <= bars[i].open) continue;
    if (bars[i].close <= bars[i-1].high) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigATRBreakout(bars: CachedBar[], coin: string, mult: number): RawSignal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const atr14 = calcATR(highs, lows, closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (atr14[i] == null) continue;
    const threshold = bars[i-1].close + atr14[i]! * mult;
    if (bars[i].close > threshold) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 0.5) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}

// Variant 정의
interface Variant { tp: number; sl: number; maxBars: number; }
const V_4H: Variant  = { tp: 5,  sl: -2, maxBars: 84 };   // 14d = 84 4h bars
const V_DAILY: Variant = { tp: 10, sl: -4, maxBars: 30 };  // 30d

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

function simulate(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>, v: Variant, periodStartTs: number, periodEndTs: number) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: PfTrade[] = [];
  const filtered = rawSignals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, RawSignal[]>();
  for (const sig of [...filtered].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) {
    if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  }
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
    let lastIdx = bars.length - 1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= periodEndTs) { lastIdx = i; break; }
    }
    const exitPrice = bars[lastIdx].close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: PfTrade[], finalCash: number, mdd: number) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, mdd, finalCash };
  const wins = trades.filter(t => t.profitKrw > 0);
  const losses = trades.filter(t => t.profitKrw <= 0);
  const wr = wins.length / n * 100;
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
  return { n, wr, total, pf, mdd, finalCash };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R31 4h / daily TF algo ===\n`);

  // Load 4h
  console.log(`Loading 4h bars (15 coins)...`);
  const bars4h = new Map<string, CachedBar[]>();
  for (const coin of COINS_15) bars4h.set(coin, load4hBars(coin));

  // Load daily
  console.log(`Loading daily bars (15 coins)...`);
  const barsDaily = new Map<string, CachedBar[]>();
  for (const coin of COINS_15) barsDaily.set(coin, loadDailyBars(coin));

  // 4h algos
  console.log(`Building 4h signals...`);
  const sigs4h: Record<string, RawSignal[]> = {
    'F1 BREAKOUT24 (4d)':    [],
    'F2 BREAKOUT42 (7d)':    [],
    'F3 SMA_CROSS 12/26':    [],
    'F4 EMA_PULLBACK 20/50': [],
    'F5 BB_SQUEEZE 30/50':   [],
    'F6 NEW_HIGH 42 (7d)':   [],
    'F7 ATR_BREAKOUT 2x':    [],
  };
  for (const coin of COINS_15) {
    const bars = bars4h.get(coin)!;
    for (const s of sigBreakout(bars, coin, 24, 1.0)) sigs4h['F1 BREAKOUT24 (4d)'].push(s);
    for (const s of sigBreakout(bars, coin, 42, 1.0)) sigs4h['F2 BREAKOUT42 (7d)'].push(s);
    for (const s of sigSMACross(bars, coin, 12, 26, 0.5)) sigs4h['F3 SMA_CROSS 12/26'].push(s);
    for (const s of sigEMAPullback(bars, coin)) sigs4h['F4 EMA_PULLBACK 20/50'].push(s);
    for (const s of sigBBSqueeze(bars, coin, 30, 50, 1.1, 1.0)) sigs4h['F5 BB_SQUEEZE 30/50'].push(s);
    for (const s of sigNewHighConfirm(bars, coin, 42)) sigs4h['F6 NEW_HIGH 42 (7d)'].push(s);
    for (const s of sigATRBreakout(bars, coin, 2.0)) sigs4h['F7 ATR_BREAKOUT 2x'].push(s);
  }
  console.log(`Building daily signals...`);
  const sigsDaily: Record<string, RawSignal[]> = {
    'D1 BREAKOUT5':       [],
    'D2 BREAKOUT10':      [],
    'D3 BREAKOUT30':      [],
    'D4 SMA_CROSS 20/50': [],
    'D5 ATR_BREAKOUT 2x': [],
    'D6 BB_SQUEEZE 20/50':[],
  };
  for (const coin of COINS_15) {
    const bars = barsDaily.get(coin)!;
    for (const s of sigBreakout(bars, coin, 5, 0.5)) sigsDaily['D1 BREAKOUT5'].push(s);
    for (const s of sigBreakout(bars, coin, 10, 0.5)) sigsDaily['D2 BREAKOUT10'].push(s);
    for (const s of sigBreakout(bars, coin, 30, 0.5)) sigsDaily['D3 BREAKOUT30'].push(s);
    for (const s of sigSMACross(bars, coin, 20, 50, 0.3)) sigsDaily['D4 SMA_CROSS 20/50'].push(s);
    for (const s of sigATRBreakout(bars, coin, 2.0)) sigsDaily['D5 ATR_BREAKOUT 2x'].push(s);
    for (const s of sigBBSqueeze(bars, coin, 20, 50, 1.1, 0.5)) sigsDaily['D6 BB_SQUEEZE 20/50'].push(s);
  }

  for (const k of Object.keys(sigs4h)) console.log(`  ${k}: ${sigs4h[k].length}`);
  for (const k of Object.keys(sigsDaily)) console.log(`  ${k}: ${sigsDaily[k].length}`);

  const periods = [
    { name: '1Y (25-06~26-06)', start: '2025-06-10', end: '2026-06-10' },
    { name: '2Y (24-06~26-06)', start: '2024-06-10', end: '2026-06-10' },
  ];
  const quarters = [
    { name: 'Q1', start: '2024-06-10', end: '2024-09-10' },
    { name: 'Q2', start: '2024-09-10', end: '2024-12-10' },
    { name: 'Q3', start: '2024-12-10', end: '2025-03-10' },
    { name: 'Q4', start: '2025-03-10', end: '2025-06-10' },
    { name: 'Q5', start: '2025-06-10', end: '2025-09-10' },
    { name: 'Q6', start: '2025-09-10', end: '2025-12-10' },
    { name: 'Q7', start: '2025-12-10', end: '2026-03-10' },
    { name: 'Q8', start: '2026-03-10', end: '2026-06-10' },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R31 4h/daily TF — 15코인, capital 10M, position 33%×3, cost RT 0.1%`);
  L.push(`Variants — 4h: TP+5%/SL-2%/MAX 14d | daily: TP+10%/SL-4%/MAX 30d`);
  L.push('='.repeat(170));

  // 1Y, 2Y 결과
  for (const [tfName, sigs, vrn, barsByCoin] of [
    ['── 4h TF ──', sigs4h, V_4H, bars4h],
    ['── Daily TF ──', sigsDaily, V_DAILY, barsDaily],
  ] as const) {
    L.push(`\n${tfName}`);
    for (const period of periods) {
      const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
      const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
      L.push(`\n## ${period.name}\n`);
      L.push(`${pad('algo', 24)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
      L.push('-'.repeat(85));
      for (const algoName of Object.keys(sigs)) {
        const { trades, finalCash, mdd } = simulate(sigs[algoName], barsByCoin, vrn, pStart, pEnd);
        const s = statsFor(trades, finalCash, mdd);
        const pass = s.pf >= 1.2 && s.total > 0;
        L.push(`${pad(algoName, 24)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
      }
    }

    L.push(`\n## 분기 walk-forward Q1~Q8 (${tfName})\n`);
    L.push(`${pad('algo', 24)} | ${quarters.map(q => padS(q.name, 3)).join(' | ')} | pass/8`);
    L.push('-'.repeat(85));
    for (const algoName of Object.keys(sigs)) {
      const passes: boolean[] = [];
      for (const q of quarters) {
        const pStart = new Date(`${q.start}T00:00:00+09:00`).getTime();
        const pEnd = new Date(`${q.end}T23:59:59+09:00`).getTime();
        const { trades, finalCash, mdd } = simulate(sigs[algoName], barsByCoin, vrn, pStart, pEnd);
        const s = statsFor(trades, finalCash, mdd);
        passes.push(s.pf >= 1.2 && s.total > 0);
      }
      const cnt = passes.filter(p => p).length;
      L.push(`${pad(algoName, 24)} | ${passes.map(p => padS(p ? '✓' : '✗', 3)).join(' | ')} | ${cnt}/8`);
    }
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R31_MULTI_TF.txt`), L.join('\n'));
  process.exit(0);
})();
