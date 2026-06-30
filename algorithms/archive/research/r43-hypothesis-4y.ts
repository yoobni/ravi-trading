/**
 * R43 — 라비 두 가설 4년 검증.
 *
 * 4 strategy 비교:
 *   F6_BASE  : TP+5/SL-2/14d     (비교 baseline)
 *   F6_v2 ★  : TP+7/SL-2.5/14d   (paper 현재)
 *   R3       : TP+3/SL-5/14d      ← 라비 첫 가설 best (WR ↑↑, 67%)
 *   T2       : TP+10/SL-1.5/14d   ← 반대 가설 best (PF 1.54)
 *
 * 4년 (2022-06 ~ 2026-06), 15 코인 (4년 가능)
 * 신호: F6 동일 (7d 신고가 + 양봉 + vol z 0.5)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const COST_RT = 0.001;

const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(coin: string): CachedBar[] {
  const seen = new Set<number>(); const all: CachedBar[] = [];
  for (const yf of ['2022-06-10_2023-06-10','2023-06-10_2024-06-10','2024-06-10_2025-06-10','2025-06-10_2026-06-10']) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; }
function sigF6(bars: CachedBar[], coin: string): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

interface Variant { name: string; tp: number; sl: number; maxBars: number; }
const VARIANTS: Variant[] = [
  { name: 'F6_BASE (5/-2/14d)',         tp: 5,  sl: -2,    maxBars: 84 },
  { name: 'F6_v2 (7/-2.5/14d) ★ paper', tp: 7,  sl: -2.5,  maxBars: 84 },
  { name: 'R3 TP3/SL-5/14d (WR ↑)',     tp: 3,  sl: -5,    maxBars: 84 },
  { name: 'T2 TP10/SL-1.5/14d (PF ↑)',  tp: 10, sl: -1.5,  maxBars: 84 },
];

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; maxBars: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; holdBars: number; }

function simulate(v: Variant, rawSignals: Signal[], barsByCoin: Map<string, CachedBar[]>, periodStartTs: number, periodEndTs: number) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: Trade[] = [];
  const filtered = rawSignals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, Signal[]>();
  for (const sig of [...filtered].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; rawRet = (pos.sl - pos.entryPrice) / pos.entryPrice * 100; }
      else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; rawRet = (pos.tp - pos.entryPrice) / pos.entryPrice * 100; }
      else if (holdBars >= pos.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason, holdBars });
        positions.splice(q, 1);
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
      positions.push({
        coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse,
        tp: entryPrice * (1 + v.tp / 100), sl: entryPrice * (1 + v.sl / 100), maxBars: v.maxBars,
      });
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
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= periodEndTs) { lastIdx = i; break; }
    const exitPrice = bars[lastIdx].close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END', holdBars: lastIdx - pos.entryIdx });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, mdd, finalCash, tpRate: 0, slRate: 0 };
  const wins = trades.filter(t => t.profitKrw > 0);
  const losses = trades.filter(t => t.profitKrw <= 0);
  const wr = wins.length / n * 100;
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
  const tp = trades.filter(t => t.reason === 'TP').length;
  const sl = trades.filter(t => t.reason === 'SL').length;
  return { n, wr, total, pf, mdd, finalCash, tpRate: tp/n*100, slRate: sl/n*100 };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R43 라비 두 가설 4년 검증 ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const c of COINS) { const b = loadBars(c); if (b.length >= 8000) barsByCoin.set(c, b); }
  console.log(`${barsByCoin.size} coins loaded`);

  const sigs: Signal[] = [];
  for (const c of barsByCoin.keys()) for (const s of sigF6(barsByCoin.get(c)!, c)) sigs.push(s);
  console.log(`F6 signals: ${sigs.length}`);

  const periods = [
    { name: '1Y (25-06~26-06)', start: '2025-06-10', end: '2026-06-10' },
    { name: '2Y (24-06~26-06)', start: '2024-06-10', end: '2026-06-10' },
    { name: '4Y (22-06~26-06)', start: '2022-06-10', end: '2026-06-10' },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R43 라비 두 가설 4년 비교 — F6 신호 그대로, ${barsByCoin.size}코인`);
  L.push(`R3 = 라비 첫 가설 (TP+3/SL-5, WR ↑) | T2 = 반대 가설 (TP+10/SL-1.5, PF ↑)`);
  L.push('='.repeat(170));

  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    L.push(`\n## ${period.name}\n`);
    L.push(`${pad('variant', 30)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 10)} | ${padS('PF', 5)} | ${padS('MDD', 7)} | ${padS('finalCash', 12)} | ${padS('TP%', 5)} | ${padS('SL%', 5)} | pass`);
    L.push('-'.repeat(120));
    for (const v of VARIANTS) {
      const r = simulate(v, sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      L.push(`${pad(v.name, 30)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 10)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 7)} | ${padS(s.finalCash.toFixed(0), 12)} | ${padS(s.tpRate.toFixed(0)+'%', 5)} | ${padS(s.slRate.toFixed(0)+'%', 5)} | ${pass ? '✓' : ''}`);
    }
  }

  // 분기 16개 walk-forward
  L.push(`\n## 4년 분기 walk-forward (16 quarters)\n`);
  const sd = new Date('2022-06-10');
  const quarters: { name: string; start: string; end: string }[] = [];
  for (let q = 0; q < 16; q++) {
    const s = new Date(sd); s.setMonth(s.getMonth() + q * 3);
    const e = new Date(s); e.setMonth(e.getMonth() + 3);
    quarters.push({ name: `Q${q+1}`, start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
  }

  L.push(`${pad('variant', 30)} | ${quarters.map(q => padS(q.name.replace('Q', ''), 3)).join('|')} | pass/16`);
  L.push('-'.repeat(110));
  for (const v of VARIANTS) {
    const passes: boolean[] = [];
    for (const q of quarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const r = simulate(v, sigs, barsByCoin, ps, pe);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      passes.push(s.pf >= 1.2 && s.total > 0);
    }
    const cnt = passes.filter(p => p).length;
    L.push(`${pad(v.name, 30)} | ${passes.map(p => padS(p ? '✓' : '✗', 3)).join('|')} | ${cnt}/16`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R43_HYP_4Y.txt`), L.join('\n'));
  process.exit(0);
})();
