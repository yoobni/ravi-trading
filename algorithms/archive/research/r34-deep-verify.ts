/**
 * R34 — F6 NEW_HIGH 42 deep verification.
 *
 * 검증 4가지:
 *   B) 4년 portfolio walk-forward (분기 16개) — 2022-06 ~ 2026-06, 23 코인
 *   C) Monte Carlo bootstrap — trade resample 1000회로 PF 신뢰구간
 *   D) Parameter sensitivity — lookback (21/28/42/56/84), vol z (0~2)
 *   E) Slippage stress — 0% / 0.1% / 0.2% / 0.3% / 0.5%
 *
 * 23 코인 풀 (2022-06부터 데이터 OK):
 *   BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, BCH,
 *   POL, NEAR, ATOM, TRX, ALGO, ETC, XLM, AAVE, SAND, MANA, CHZ, AXS, BAT
 *
 * 기본 룰: lookback 42 (7d), vol z ≥ 0.5, TP+5%/SL-2%/MAX 84 bars (14d), cost RT 0.1%
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
const TP_PCT_BASE = 5.0;
const SL_PCT_BASE = -2.0;
const MAX_BARS_BASE = 84;
const COST_RT_BASE = 0.001;

const COINS_4Y = [
  'BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH',
  'POL','NEAR','ATOM','TRX','ALGO',
  'ETC','XLM','AAVE','SAND','MANA','CHZ','AXS','BAT',
];

function load4hBars4Y(coin: string): CachedBar[] {
  const yearFiles = [
    '2022-06-10_2023-06-10',
    '2023-06-10_2024-06-10',
    '2024-06-10_2025-06-10',
    '2025-06-10_2026-06-10',
  ];
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const yf of yearFiles) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) {
      if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); }
    }
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

interface Signal { coin: string; barIdx: number; ts: number; volZ: number; }
function sigF6(bars: CachedBar[], coin: string, lookback: number, volZThresh: number): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZThresh) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

interface SimParams { tp: number; sl: number; maxBars: number; costRT: number; positionPct: number; maxConcurrent: number; }
function simulate(rawSignals: Signal[], barsByCoin: Map<string, CachedBar[]>, p: SimParams, periodStartTs: number, periodEndTs: number) {
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
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const tp = pos.entryPrice * (1 + p.tp / 100), sl = pos.entryPrice * (1 + p.sl / 100);
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (b.low <= sl) { exitPrice = sl; reason = 'SL'; rawRet = p.sl; }
      else if (b.high >= tp) { exitPrice = tp; reason = 'TP'; rawRet = p.tp; }
      else if (holdBars >= p.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - p.costRT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - p.costRT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(q, 1);
      }
    }
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= p.maxConcurrent) break;
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const eBar = bars[entryIdx];
      const entryPrice = eBar.open;
      const cashToUse = cash * p.positionPct;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - p.costRT / 2);
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
    const cashGained = gross * (1 - p.costRT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - p.costRT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
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

// Seeded random for reproducibility
function mulberry32(seed: number) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R34 F6 deep verification ===\n`);

  // Load 4y bars (23 coins)
  console.log(`Loading 4y bars (${COINS_4Y.length} coins, 2022-06~2026-06)...`);
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS_4Y) {
    const bars = load4hBars4Y(coin);
    if (bars.length < 8000) {
      console.log(`  [${coin}] SKIP (${bars.length} bars)`);
      continue;
    }
    barsByCoin.set(coin, bars);
  }
  console.log(`  → ${barsByCoin.size} coins loaded`);

  // Build base F6 signals (lookback 42, vol z 0.5)
  console.log('Building F6 base signals...');
  const baseSigs: Signal[] = [];
  for (const coin of barsByCoin.keys()) {
    for (const s of sigF6(barsByCoin.get(coin)!, coin, 42, 0.5)) baseSigs.push(s);
  }
  console.log(`  Total signals: ${baseSigs.length}`);

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R34 F6 NEW_HIGH 42 deep verification (4년, ${barsByCoin.size}코인)`);
  L.push(`Base: lookback 42, vol z≥0.5, TP+5/SL-2/MAX 14d (84 bars), capital 10M, position 33%×3`);
  L.push('='.repeat(170));

  // ============ B) 4년 walk-forward ============
  L.push(`\n## B) 4년 walk-forward — 분기 16개\n`);
  const periodAll = {
    start: new Date('2022-06-10T00:00:00+09:00').getTime(),
    end: new Date('2026-06-10T23:59:59+09:00').getTime(),
  };
  const fullParam: SimParams = { tp: TP_PCT_BASE, sl: SL_PCT_BASE, maxBars: MAX_BARS_BASE, costRT: COST_RT_BASE, positionPct: POSITION_PCT, maxConcurrent: MAX_CONCURRENT };
  const fullResult = simulate(baseSigs, barsByCoin, fullParam, periodAll.start, periodAll.end);
  const fullStats = statsFor(fullResult.trades, fullResult.finalCash, fullResult.mdd);
  L.push(`4Y FULL: n=${fullStats.n}, WR=${fullStats.wr.toFixed(0)}%, total=${fmt(fullStats.total)}, PF=${fullStats.pf.toFixed(2)}, MDD=${fullStats.mdd.toFixed(1)}%, finalCash=${fullStats.finalCash.toFixed(0)}`);

  const quarters: { name: string; start: string; end: string }[] = [];
  const startDate = new Date('2022-06-10');
  for (let q = 0; q < 16; q++) {
    const sd = new Date(startDate);
    sd.setMonth(sd.getMonth() + q * 3);
    const ed = new Date(sd);
    ed.setMonth(ed.getMonth() + 3);
    quarters.push({
      name: `Q${q+1}`,
      start: sd.toISOString().slice(0, 10),
      end: ed.toISOString().slice(0, 10),
    });
  }
  L.push(`\n${pad('quarter', 14)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(75));
  let qPass = 0;
  for (const q of quarters) {
    const pStart = new Date(`${q.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${q.end}T23:59:59+09:00`).getTime();
    const r = simulate(baseSigs, barsByCoin, fullParam, pStart, pEnd);
    const s = statsFor(r.trades, r.finalCash, r.mdd);
    const pass = s.pf >= 1.2 && s.total > 0;
    if (pass) qPass++;
    L.push(`${pad(`${q.name} ${q.start.slice(2)}`, 14)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
  }
  L.push(`\nQuarter pass: ${qPass}/16 (${(qPass/16*100).toFixed(0)}%)`);

  // ============ C) Monte Carlo bootstrap ============
  L.push(`\n## C) Monte Carlo bootstrap (4년 trade 시퀀스 resample 1000회)\n`);
  // Trade-level netRet 시퀀스에서 random sampling with replacement
  const tradeRets = fullResult.trades.map(t => t.netRet);
  const rng = mulberry32(42);
  const N_RUNS = 1000;
  const pfDistribution: number[] = [];
  const totalDistribution: number[] = [];
  for (let run = 0; run < N_RUNS; run++) {
    const sampleSize = tradeRets.length;
    let winSum = 0, lossSum = 0, total = 0;
    for (let k = 0; k < sampleSize; k++) {
      const idx = Math.floor(rng() * tradeRets.length);
      const r = tradeRets[idx];
      total += r;
      if (r > 0) winSum += r;
      else lossSum += Math.abs(r);
    }
    const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
    pfDistribution.push(pf);
    totalDistribution.push(total);
  }
  pfDistribution.sort((a, b) => a - b);
  totalDistribution.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];
  L.push(`PF 분포:`);
  L.push(`  Median:  ${pct(pfDistribution, 0.50).toFixed(2)}`);
  L.push(`  P5 (worst 5%):  ${pct(pfDistribution, 0.05).toFixed(2)}`);
  L.push(`  P95 (best 5%):  ${pct(pfDistribution, 0.95).toFixed(2)}`);
  L.push(`  Pass rate (PF≥1.2): ${(pfDistribution.filter(p => p >= 1.2).length / N_RUNS * 100).toFixed(0)}%`);
  L.push(`  Pass rate (PF≥1.0): ${(pfDistribution.filter(p => p >= 1.0).length / N_RUNS * 100).toFixed(0)}%`);
  L.push(`Total return 분포 (% sum of all trade returns):`);
  L.push(`  Median:  ${pct(totalDistribution, 0.50).toFixed(0)}%`);
  L.push(`  P5:  ${pct(totalDistribution, 0.05).toFixed(0)}%`);
  L.push(`  P95: ${pct(totalDistribution, 0.95).toFixed(0)}%`);
  L.push(`  Pass rate (total > 0): ${(totalDistribution.filter(t => t > 0).length / N_RUNS * 100).toFixed(0)}%`);

  // ============ D) Parameter sensitivity ============
  L.push(`\n## D) Parameter sensitivity (4Y)\n`);
  // lookback × vol z grid
  const lookbacks = [21, 28, 42, 56, 84];
  const volZs = [0, 0.5, 1.0, 1.5];
  L.push(`${pad('lookback', 10)} | ${padS('vol z', 6)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)}`);
  L.push('-'.repeat(70));
  for (const lb of lookbacks) {
    for (const vz of volZs) {
      const sigs: Signal[] = [];
      for (const coin of barsByCoin.keys()) {
        for (const s of sigF6(barsByCoin.get(coin)!, coin, lb, vz)) sigs.push(s);
      }
      const r = simulate(sigs, barsByCoin, fullParam, periodAll.start, periodAll.end);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      const isBase = lb === 42 && vz === 0.5;
      L.push(`${pad(String(lb)+(isBase?' ★':''), 10)} | ${padS(vz.toFixed(1), 6)} | ${padS(String(s.n), 5)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)}`);
    }
  }

  // TP/SL sensitivity
  L.push(`\nTP/SL sensitivity (lookback 42, vol z 0.5):`);
  const tpSls: { tp: number; sl: number }[] = [
    { tp: 3, sl: -1 },   // tight
    { tp: 5, sl: -2 },   // base ★
    { tp: 7, sl: -2.5 },
    { tp: 8, sl: -3 },
    { tp: 10, sl: -4 },
    { tp: 15, sl: -5 },  // swing
  ];
  L.push(`${pad('TP/SL', 12)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)}`);
  L.push('-'.repeat(60));
  for (const c of tpSls) {
    const param = { ...fullParam, tp: c.tp, sl: c.sl };
    const r = simulate(baseSigs, barsByCoin, param, periodAll.start, periodAll.end);
    const s = statsFor(r.trades, r.finalCash, r.mdd);
    const isBase = c.tp === 5 && c.sl === -2;
    L.push(`${pad(`${c.tp}/${c.sl}${isBase?' ★':''}`, 12)} | ${padS(String(s.n), 5)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)}`);
  }

  // ============ E) Slippage stress ============
  L.push(`\n## E) Slippage stress test (4Y)\n`);
  L.push(`Slippage 변경 시 cost RT 변화. Upbit 실제 fee 0.05% × 2 = 0.1% 기준.`);
  L.push(`${pad('slippage RT', 14)} | ${padS('cost RT', 8)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)}`);
  L.push('-'.repeat(75));
  const costs: { slip: number; total: number }[] = [
    { slip: 0,    total: 0 },        // 환상적 — fee 0
    { slip: 0.05, total: 0.05 },     // fee만, slippage 0
    { slip: 0.1,  total: 0.1 },      // base ★ (Upbit fee 0.05% × 2 + slippage 0)
    { slip: 0.2,  total: 0.2 },      // 보수
    { slip: 0.3,  total: 0.3 },      // worst case
    { slip: 0.5,  total: 0.5 },      // 극단
  ];
  for (const c of costs) {
    const param = { ...fullParam, costRT: c.total / 100 };
    const r = simulate(baseSigs, barsByCoin, param, periodAll.start, periodAll.end);
    const s = statsFor(r.trades, r.finalCash, r.mdd);
    const isBase = c.total === 0.1;
    L.push(`${pad(`${c.total.toFixed(2)}%${isBase?' ★':''}`, 14)} | ${padS((c.total).toFixed(2)+'%', 8)} | ${padS(String(s.n), 5)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)}`);
  }

  // ============ F) Lookahead audit ============
  L.push(`\n## F) Lookahead-safe 코드 audit\n`);
  L.push(`F6 signal 평가 (sigF6 in r34-deep-verify.ts / paper-f6-store.ts evaluateF6):`);
  L.push(`  - prevMax = max(bars[j].high for j in [i-42, i-2])  ← bar i-1, i 제외 (current 미사용)`);
  L.push(`  - bars[i-1].high > prevMax                          ← bar i-1 close 시점에 알 수 있음`);
  L.push(`  - bars[i].close > bars[i].open                      ← bar i close 시점에 알 수 있음`);
  L.push(`  - bars[i].close > bars[i-1].high                    ← bar i close 시점에 알 수 있음`);
  L.push(`  - calcVolZ(volumes, i, 30): window [i-30, i-1] mean/sd + volumes[i] (bar i close 시점 OK)`);
  L.push(`Entry: signals[i] → bars[i+1].open                    ← signal 이후의 첫 가능 시점`);
  L.push(`Exit:  bars[entry..].low <= sl 또는 high >= tp        ← intra-bar TP/SL (SL 우선)`);
  L.push(`결론: 미래 정보 사용 경로 없음. R31-verify와 동일.`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R34_DEEP.txt`), L.join('\n'));
  process.exit(0);
})();
