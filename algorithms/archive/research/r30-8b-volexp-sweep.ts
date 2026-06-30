/**
 * R30-8B — VOL_EXPANSION deep sweep.
 *
 * Variables:
 *   BB period: 14, 20, 30
 *   BB mult: 2.0
 *   Squeeze lookback: 30, 50, 100
 *   Squeeze multiplier (current width <= min * X): 1.05, 1.1, 1.2, 1.5
 *   Vol z threshold: 0.5, 1.0, 1.5
 *   TP/SL: (5/2/14d), (7/2.5/14d), (3/1.5/7d)
 * Pool: 10 coins. Position 33%, max 3 concurrent.
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
function sigVolExp(bars: CachedBar[], coin: string, bbPeriod: number, lookback: number, squeezeMult: number, volZ: number): RawSignal[] {
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

interface Variant { name: string; tp: number; sl: number; maxBars: number; }
const VARIANTS: Variant[] = [
  { name: 'TP5/SL2/14d',   tp: 5,  sl: -2,   maxBars: 336 },
  { name: 'TP7/SL2.5/14d', tp: 7,  sl: -2.5, maxBars: 336 },
  { name: 'TP3/SL1.5/7d',  tp: 3,  sl: -1.5, maxBars: 168 },
];

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }
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
        trades.push({ rawRet, netRet, profitKrw, reason });
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
    trades.push({ rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-8B VOL_EXPANSION sweep ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  const bbPeriods = [14, 20, 30];
  const lookbacks = [30, 50, 100];
  const squeezeMults = [1.05, 1.1, 1.2, 1.5];
  const volZs = [0.5, 1.0, 1.5];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R30-8B VOL_EXPANSION sweep — BB period × lookback × squeeze mult × vol z × variant`);
  L.push(`10 coin pool, position 33% × max 3 concurrent`);
  L.push('='.repeat(170));

  interface Res { config: string; variant: string; n: number; wr: number; total: number; pf: number; mdd: number; }
  const rows: Res[] = [];
  let count = 0;
  for (const bbp of bbPeriods) {
    for (const lb of lookbacks) {
      for (const sm of squeezeMults) {
        for (const vz of volZs) {
          // Pre-compute signals once for this config
          const all: RawSignal[] = [];
          for (const coin of COINS) {
            const bars = barsByCoin.get(coin)!;
            for (const s of sigVolExp(bars, coin, bbp, lb, sm, vz)) all.push(s);
          }
          for (const v of VARIANTS) {
            const { trades, finalCash, mdd } = simulate(all, barsByCoin, v);
            const n = trades.length;
            const wins = trades.filter(t => t.profitKrw > 0);
            const losses = trades.filter(t => t.profitKrw <= 0);
            const wr = n ? wins.length / n * 100 : 0;
            const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
            const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
            const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
            const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
            rows.push({
              config: `BB${bbp}/lb${lb}/sm${sm}/vz${vz}`,
              variant: v.name, n, wr, total, pf, mdd,
            });
            count++;
          }
        }
      }
    }
  }

  L.push(`\nTotal cells: ${count}`);
  const passes = rows.filter(r => r.pf >= 1.2 && r.total > 0);
  L.push(`\n## 통과 cells (PF≥1.2 & total>0) — ${passes.length}개\n`);
  L.push(`${pad('config', 32)} | ${pad('variant', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)}`);
  L.push('-'.repeat(105));
  for (const r of passes.sort((a, b) => b.pf - a.pf)) {
    L.push(`${pad(r.config, 32)} | ${pad(r.variant, 16)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)}`);
  }
  L.push(`\n## TOP 20 cells by total (n≥30)\n`);
  L.push(`${pad('config', 32)} | ${pad('variant', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)}`);
  L.push('-'.repeat(105));
  for (const r of rows.filter(r => r.n >= 30).sort((a, b) => b.total - a.total).slice(0, 20)) {
    L.push(`${pad(r.config, 32)} | ${pad(r.variant, 16)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-8B.txt`), L.join('\n'));
  process.exit(0);
})();
