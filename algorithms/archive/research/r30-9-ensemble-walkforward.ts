/**
 * R30-9 — 3 algo ensemble + 분기별 walk-forward.
 *
 * Algos (R30-8B/8A 검증):
 *   V1 VOL_EXP_A: BB30/lb100/sm1.5/vz1.0, variant TP3/SL1.5/7d  (10코인 풀)
 *   V2 VOL_EXP_B: BB30/lb50/sm1.05/vz1.0, variant TP7/SL2.5/14d (10코인 풀)
 *   W1 WEEK_HIGH: prior 168h high + vol z>1,  variant TP5/SL2/14d (4코인: ETH/SOL/DOT/LINK)
 *
 * Ensemble: 통합 cash pool 10M, position 33% × max 3 concurrent, 신호 ts 시간순 처리.
 *           같은 ts에 여러 신호면 ts 순으로 들어옴 (FIFO).
 *
 * 분기별 split (1년 = 4 quarter):
 *   Q1 2025-06-10 ~ 2025-09-10
 *   Q2 2025-09-10 ~ 2025-12-10
 *   Q3 2025-12-10 ~ 2026-03-10
 *   Q4 2026-03-10 ~ 2026-06-10
 *
 * 각 algo individual + ensemble × 5 period (Q1~Q4 + 1Y) = 20 cells.
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
const COST_RT = 0.001;
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;

const COINS_10 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH'];
const COINS_4  = ['ETH','SOL','DOT','LINK'];

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

interface RawSignal { coin: string; barIdx: number; ts: number; algoId: 'V1'|'V2'|'W1'; }

function sigVolExp(
  bars: CachedBar[], coin: string,
  bbPeriod: number, lookback: number, squeezeMult: number, volZ: number,
  algoId: 'V1'|'V2',
): RawSignal[] {
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
    out.push({ coin, barIdx: i, ts: bars[i].ts, algoId });
  }
  return out;
}
function sigWeekHigh(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 168;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts, algoId: 'W1' });
    }
  }
  return out;
}

interface Variant { tp: number; sl: number; maxBars: number; }
const VARIANTS: Record<string, Variant> = {
  V1: { tp: 3,  sl: -1.5, maxBars: 168 }, // 7d
  V2: { tp: 7,  sl: -2.5, maxBars: 336 }, // 14d
  W1: { tp: 5,  sl: -2,   maxBars: 336 }, // 14d
};

interface Position {
  coin: string; algoId: 'V1'|'V2'|'W1';
  entryTs: number; entryIdx: number; entryPrice: number;
  vol: number; cashUsed: number;
}
interface PfTrade {
  coin: string; algoId: 'V1'|'V2'|'W1';
  entryTs: number; exitTs: number;
  entryPrice: number; exitPrice: number;
  rawRet: number; netRet: number; profitKrw: number;
  reason: 'TP'|'SL'|'TIME'|'END';
}

function simulate(
  rawSignals: RawSignal[],
  barsByCoin: Map<string, CachedBar[]>,
  periodStartTs: number, periodEndTs: number,
) {
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
    // Exit
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const v = VARIANTS[pos.algoId];
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
        trades.push({ coin: pos.coin, algoId: pos.algoId, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(p, 1);
      }
    }
    // Entry
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
      positions.push({ coin: sig.coin, algoId: sig.algoId, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse });
    }
    // Equity
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
  // Force-close at periodEnd
  for (const pos of positions) {
    const bars = barsByCoin.get(pos.coin)!;
    // last bar in period
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
    trades.push({ coin: pos.coin, algoId: pos.algoId, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}

function statsFor(trades: PfTrade[], finalCash: number, mdd: number) {
  const n = trades.length;
  const wins = trades.filter(t => t.profitKrw > 0);
  const losses = trades.filter(t => t.profitKrw <= 0);
  const wr = n ? wins.length / n * 100 : 0;
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
  return { n, wr, total, pf, mdd };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-9 ENSEMBLE + WALK-FORWARD ===\n`);

  // Load bars (10 coins, used by both V1/V2 and W1)
  const barsByCoin10 = new Map<string, CachedBar[]>();
  for (const coin of COINS_10) barsByCoin10.set(coin, loadBars(coin));

  // Build signals for each algo
  console.log('Building V1 signals (VOL_EXP A: BB30/lb100/sm1.5/vz1, 10 coins)...');
  const sigV1: RawSignal[] = [];
  for (const coin of COINS_10) {
    const bars = barsByCoin10.get(coin)!;
    for (const s of sigVolExp(bars, coin, 30, 100, 1.5, 1.0, 'V1')) sigV1.push(s);
  }
  console.log(`  V1 raw signals: ${sigV1.length}`);

  console.log('Building V2 signals (VOL_EXP B: BB30/lb50/sm1.05/vz1, 10 coins)...');
  const sigV2: RawSignal[] = [];
  for (const coin of COINS_10) {
    const bars = barsByCoin10.get(coin)!;
    for (const s of sigVolExp(bars, coin, 30, 50, 1.05, 1.0, 'V2')) sigV2.push(s);
  }
  console.log(`  V2 raw signals: ${sigV2.length}`);

  console.log('Building W1 signals (WEEK_HIGH, 4 coins)...');
  const sigW1: RawSignal[] = [];
  for (const coin of COINS_4) {
    const bars = barsByCoin10.get(coin)!;
    for (const s of sigWeekHigh(bars, coin)) sigW1.push(s);
  }
  console.log(`  W1 raw signals: ${sigW1.length}`);

  const periods = [
    { name: 'Q1 2025-06~09', start: '2025-06-10', end: '2025-09-10' },
    { name: 'Q2 2025-09~12', start: '2025-09-10', end: '2025-12-10' },
    { name: 'Q3 2025-12~03', start: '2025-12-10', end: '2026-03-10' },
    { name: 'Q4 2026-03~06', start: '2026-03-10', end: '2026-06-10' },
    { name: '1Y FULL',        start: '2025-06-10', end: '2026-06-10' },
  ];

  const L: string[] = [];
  L.push('='.repeat(160));
  L.push(`R30-9 ENSEMBLE + Walk-Forward`);
  L.push(`Algos: V1 VOL_EXP(BB30/lb100/sm1.5/vz1, TP3/SL1.5/7d, 10coin), V2 VOL_EXP(BB30/lb50/sm1.05/vz1, TP7/SL2.5/14d, 10coin), W1 WEEK_HIGH(TP5/SL2/14d, 4coin)`);
  L.push(`Ensemble: 통합 cash 10M, position 33% × max 3 concurrent`);
  L.push('='.repeat(160));

  // Combined signals
  const sigEnsemble = [...sigV1, ...sigV2, ...sigW1].sort((a, b) => a.ts - b.ts);

  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();

    L.push(`\n## Period: ${period.name} (${period.start} ~ ${period.end})\n`);
    L.push(`${pad('strategy', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
    L.push('-'.repeat(80));

    for (const [label, sigs] of [
      ['V1 VOL_EXP_A',  sigV1],
      ['V2 VOL_EXP_B',  sigV2],
      ['W1 WEEK_HIGH',  sigW1],
      ['ENSEMBLE V1+V2+W1', sigEnsemble],
    ] as const) {
      const { trades, finalCash, mdd } = simulate(sigs, barsByCoin10, pStart, pEnd);
      const s = statsFor(trades, finalCash, mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      L.push(`${pad(label, 22)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
    }
  }

  // Robustness 종합
  L.push(`\n\n## Robustness 종합 (분기별 통과 횟수 / 4)`);
  L.push(`${pad('strategy', 22)} | ${padS('Q1', 4)} | ${padS('Q2', 4)} | ${padS('Q3', 4)} | ${padS('Q4', 4)} | ${padS('1Y', 4)} | ${padS('pass Q', 5)} | ${padS('1Y PF', 6)}`);
  L.push('-'.repeat(85));

  const quarterPeriods = periods.slice(0, 4);
  for (const [label, sigs] of [
    ['V1 VOL_EXP_A',  sigV1],
    ['V2 VOL_EXP_B',  sigV2],
    ['W1 WEEK_HIGH',  sigW1],
    ['ENSEMBLE V1+V2+W1', sigEnsemble],
  ] as const) {
    const qRes: string[] = [];
    let passCount = 0;
    for (const period of quarterPeriods) {
      const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
      const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
      const { trades, finalCash, mdd } = simulate(sigs, barsByCoin10, pStart, pEnd);
      const s = statsFor(trades, finalCash, mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      qRes.push(pass ? '✓' : '✗');
      if (pass) passCount++;
    }
    // 1Y
    const period = periods[4];
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    const { trades, finalCash, mdd } = simulate(sigs, barsByCoin10, pStart, pEnd);
    const s = statsFor(trades, finalCash, mdd);
    const yPass = s.pf >= 1.2 && s.total > 0;
    L.push(`${pad(label, 22)} | ${padS(qRes[0], 4)} | ${padS(qRes[1], 4)} | ${padS(qRes[2], 4)} | ${padS(qRes[3], 4)} | ${padS(yPass ? '✓' : '✗', 4)} | ${padS(String(passCount), 5)} | ${padS(s.pf.toFixed(2), 6)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-9_ENSEMBLE.txt`), L.join('\n'));
  process.exit(0);
})();
