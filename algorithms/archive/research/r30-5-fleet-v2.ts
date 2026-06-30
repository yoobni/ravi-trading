/**
 * R30-5 — fleet v2.
 *
 * R30-4 후속:
 *   ★ 폐기 algos: RSI_BOUNCE, BB_BOUNCE, HA_REVERSAL, VWAP_BOUNCE, MACD_BULL
 *   ★ 유지: BREAKOUT12/24/48, SMA_CROSS, EMA_TREND
 *   ★ 새 algo 5개:
 *      N1 DONCHIAN20     : 20-bar Donchian high break (Turtle-style)
 *      N2 WEEK_HIGH      : 168h(7d) high break + vol z>1
 *      N3 BTC_FILTER_BO  : BREAKOUT24 + BTC EMA50 above (BTC strong regime)
 *      N4 KELTNER_BREAK  : close > EMA20 + ATR14 × 2 (volatility-adjusted upper)
 *      N5 MOMENTUM_3BAR  : 3봉 연속 상승 + vol z>1 + close > EMA20
 *
 * Pool: ETH/SOL/DOT/LINK (R30-3 best). Capital 10M. Position 33% × max 3, per-coin 제한 풀기 (multi-pos per coin OK).
 * Variant TP+5%/SL-2%/MAX 336h(14d). Cost RT 0.1%.
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface RawSignal { coin: string; barIdx: number; ts: number; }

// ─── 유지 algos ───
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
function sigEMATrend(bars: CachedBar[], coin: string, volZ = 0.8): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26), e50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i] == null || e26[i] == null || e50[i] == null) continue;
    if (closes[i] > e50[i]! && e12[i]! > e26[i]! && bars[i].close > bars[i].open) {
      if (bars[i-1].low <= e26[i-1]! && bars[i].close > e26[i]!) {
        const z = calcVolZ(volumes, i, 30);
        if (z == null || z < volZ) continue;
        out.push({ coin, barIdx: i, ts: bars[i].ts });
      }
    }
  }
  return out;
}

// ─── 새 algos ───
function sigDonchian(bars: CachedBar[], coin: string, lookback = 20, volZ = 0.5): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    // 이전 bar에선 prevMax 이하 → 현재 bar에서 break (false breakout 줄이기)
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigWeekHigh(bars: CachedBar[], coin: string, volZ = 1.0): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 168;
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
function sigBTCFilterBO(bars: CachedBar[], coin: string, btcBars: CachedBar[]): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const btcCloses = btcBars.map(b => b.close);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcByTs = new Map<number, { idx: number; close: number; ema: number | null }>();
  for (let i = 0; i < btcBars.length; i++) btcByTs.set(btcBars[i].ts, { idx: i, close: btcBars[i].close, ema: btcEma50[i] });
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    const btc = btcByTs.get(bars[i].ts);
    if (!btc || btc.ema == null || btc.close <= btc.ema) continue; // BTC EMA50 below → skip
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
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
function sigMomentum3Bar(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ema20 = calcEMA(closes, 20);
  const out: RawSignal[] = [];
  for (let i = 3; i < bars.length; i++) {
    if (ema20[i] == null) continue;
    // 3봉 연속 close 상승 (i-2 < i-1 < i)
    if (!(closes[i-2] < closes[i-1] && closes[i-1] < closes[i])) continue;
    if (closes[i] <= ema20[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

interface AlgoDef { name: string; fn: (bars: CachedBar[], coin: string, btcBars: CachedBar[]) => RawSignal[]; }
const ALGOS: AlgoDef[] = [
  { name: 'A1 BREAKOUT12',   fn: (b, c) => sigBreakout(b, c, 12, 1.0) },
  { name: 'A2 BREAKOUT24',   fn: (b, c) => sigBreakout(b, c, 24, 1.0) },
  { name: 'A3 BREAKOUT48',   fn: (b, c) => sigBreakout(b, c, 48, 1.0) },
  { name: 'A4 SMA_CROSS',    fn: (b, c) => sigSMA(b, c, 0.5) },
  { name: 'A5 EMA_TREND',    fn: (b, c) => sigEMATrend(b, c, 0.8) },
  { name: 'N1 DONCHIAN20',   fn: (b, c) => sigDonchian(b, c, 20, 0.5) },
  { name: 'N2 WEEK_HIGH',    fn: (b, c) => sigWeekHigh(b, c, 1.0) },
  { name: 'N3 BTC_FILTER_BO', fn: (b, c, btc) => sigBTCFilterBO(b, c, btc) },
  { name: 'N4 KELTNER',      fn: (b, c) => sigKeltner(b, c) },
  { name: 'N5 MOMENTUM_3BAR', fn: (b, c) => sigMomentum3Bar(b, c) },
];

interface Position {
  coin: string; entryTs: number; entryIdx: number; entryPrice: number;
  vol: number; cashUsed: number;
}
interface PfTrade {
  coin: string; entryTs: number; exitTs: number;
  entryPrice: number; exitPrice: number;
  rawRet: number; netRet: number; profitKrw: number;
  reason: 'TP'|'SL'|'TIME'|'END'; holdBars: number;
}

function simulateFleet(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>) {
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

  // Pre-build idx map per coin for fast lookup
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }

  let peak = INITIAL_CASH, mdd = 0;
  const eqCurve: { ts: number; eq: number }[] = [];

  for (const ts of tsList) {
    // Exit check
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const tp = pos.entryPrice * (1 + TP_PCT / 100);
      const sl = pos.entryPrice * (1 + SL_PCT / 100);
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

    // Entry
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
      // per-coin 제한 풀음 (multi-pos per coin OK)
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

    // Equity
    let openValue = 0;
    for (const pos of positions) {
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx != null) openValue += pos.vol * barsByCoin.get(pos.coin)![idx].close;
    }
    const eq = cash + openValue;
    eqCurve.push({ ts, eq });
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  // Force-close remaining
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

  console.log(`\n=== R30-5 FLEET V2 ===\n`);

  // Load bars
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));
  const btcBars = loadBars('BTC'); // BTC filter용

  const L: string[] = [];
  L.push('='.repeat(160));
  L.push(`R30-5 FLEET V2 — 10 algos × 4 coin pool (ETH/SOL/DOT/LINK)`);
  L.push(`Capital ${INITIAL_CASH/1e6}M, Position ${POSITION_PCT*100}% × max ${MAX_CONCURRENT} concurrent, per-coin 제한 ✗ (multi-pos per coin OK)`);
  L.push(`Variant TP+${TP_PCT}%/SL${SL_PCT}%/MAX ${MAX_BARS}h(${MAX_BARS/24}d). Cost RT ${(COST_RT*100).toFixed(1)}%`);
  L.push('='.repeat(160));

  interface Res { name: string; n: number; wr: number; total: number; pf: number; mdd: number; finalCash: number; avgHoldH: number; tpRate: number; slRate: number; timeRate: number; coinDist: Record<string, number>; }
  const results: Res[] = [];

  for (const algo of ALGOS) {
    const allSigs: RawSignal[] = [];
    for (const coin of COINS) {
      const bars = barsByCoin.get(coin)!;
      for (const s of algo.fn(bars, coin, btcBars)) allSigs.push(s);
    }
    const { trades, finalCash, mdd } = simulateFleet(allSigs, barsByCoin);
    const n = trades.length;
    const wins = trades.filter(t => t.profitKrw > 0);
    const losses = trades.filter(t => t.profitKrw <= 0);
    const wr = n ? wins.length / n * 100 : 0;
    const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
    const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
    const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
    const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
    const avgHoldH = n ? trades.reduce((s, t) => s + t.holdBars, 0) / n : 0;
    const tp = trades.filter(t => t.reason === 'TP').length;
    const sl = trades.filter(t => t.reason === 'SL').length;
    const tm = trades.filter(t => t.reason === 'TIME' || t.reason === 'END').length;
    const coinDist: Record<string, number> = {};
    for (const t of trades) coinDist[t.coin] = (coinDist[t.coin] || 0) + 1;
    results.push({ name: algo.name, n, wr, total, pf, mdd, finalCash, avgHoldH, tpRate: n ? tp/n*100 : 0, slRate: n ? sl/n*100 : 0, timeRate: n ? tm/n*100 : 0, coinDist });
  }

  L.push(`\n## 결과 (sorted by PF)\n`);
  L.push(`${pad('algo', 18)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 13)} | ${padS('hold(h)', 8)} | ${padS('TP%', 5)} | ${padS('SL%', 5)} | ${padS('TIME%', 6)} | pass`);
  L.push('-'.repeat(140));
  for (const r of results.sort((a, b) => b.pf - a.pf)) {
    const pass = r.pf >= 1.2 && r.total > 0;
    L.push(`${pad(r.name, 18)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${padS(r.finalCash.toFixed(0), 13)} | ${padS(r.avgHoldH.toFixed(0), 8)} | ${padS(r.tpRate.toFixed(0)+'%', 5)} | ${padS(r.slRate.toFixed(0)+'%', 5)} | ${padS(r.timeRate.toFixed(0)+'%', 6)} | ${pass ? '✓' : ''}`);
  }

  L.push(`\n## 코인 trade 분포\n`);
  L.push(`${pad('algo', 18)} | ${COINS.map(c => padS(c, 5)).join(' | ')}`);
  L.push('-'.repeat(60));
  for (const r of results) {
    L.push(`${pad(r.name, 18)} | ${COINS.map(c => padS(String(r.coinDist[c] || 0), 5)).join(' | ')}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30-5_FLEET_V2.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
