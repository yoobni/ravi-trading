/**
 * R30-10C — 4 strategy fleet, 2년, 15코인.
 *
 * 자본: 총 3000만 KRW = 4 strategy × 750만 (독립 portfolio)
 * Pool: 15코인 (기존 10 + 새 5: POL/NEAR/ATOM/TRX/ALGO)
 * Period: 2024-06-10 ~ 2026-06-10 (2년)
 * 분기 8개 walk-forward + 2Y FULL
 *
 * Strategies:
 *   V1 VOL_EXP_A : BB30/lb100/sm1.5/vz1.0 + TP+3%/SL-1.5%/MAX 7d
 *   V2 VOL_EXP_B : BB30/lb50/sm1.05/vz1.0 + TP+7%/SL-2.5%/MAX 14d
 *   W1 WEEK_HIGH : 7d high break + vol z>1 + TP+5%/SL-2%/MAX 14d
 *   ENS          : V1+V2+W1 통합 cash pool (별도 자본 750만)
 *
 * 각 strategy: cash 750만, position 33% × max 3 concurrent
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const UNIT = 60;
const COST_RT = 0.001;
const INITIAL_CASH = 7_500_000; // 각 strategy 750만
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;

const COINS_15 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const COINS_W1 = COINS_15; // 코인 제한 없이 = W1도 15코인

function loadBarsFor(coin: string, from: string, to: string): CachedBar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_${UNIT}m_${from}_${to}.json`), 'utf-8'));
}
function loadBars2Y(coin: string): CachedBar[] {
  // 두 1년 파일 합치기
  const y1 = loadBarsFor(coin, '2024-06-10', '2025-06-10');
  const y2 = loadBarsFor(coin, '2025-06-10', '2026-06-10');
  // dedup by ts (boundary overlap)
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const b of y1) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  for (const b of y2) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  all.sort((a, b) => a.ts - b.ts);
  return all;
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

function sigVolExp(bars: CachedBar[], coin: string, bbPeriod: number, lookback: number, squeezeMult: number, volZ: number, algoId: 'V1'|'V2'): RawSignal[] {
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
  V1: { tp: 3,  sl: -1.5, maxBars: 168 },
  V2: { tp: 7,  sl: -2.5, maxBars: 336 },
  W1: { tp: 5,  sl: -2,   maxBars: 336 },
};

interface Position { coin: string; algoId: 'V1'|'V2'|'W1'; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; algoId: 'V1'|'V2'|'W1'; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

function simulate(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>, periodStartTs: number, periodEndTs: number) {
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
  // force close
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
  return { n, wr, total, pf, mdd, finalCash };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-10C FLEET 2Y 15COIN ===\n`);

  console.log(`Loading 2y bars for ${COINS_15.length} coins...`);
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS_15) barsByCoin.set(coin, loadBars2Y(coin));
  console.log(`Loaded.`);

  // Build signals
  console.log('Building V1/V2/W1 signals across 15 coins...');
  const sigV1: RawSignal[] = [];
  for (const coin of COINS_15) {
    for (const s of sigVolExp(barsByCoin.get(coin)!, coin, 30, 100, 1.5, 1.0, 'V1')) sigV1.push(s);
  }
  const sigV2: RawSignal[] = [];
  for (const coin of COINS_15) {
    for (const s of sigVolExp(barsByCoin.get(coin)!, coin, 30, 50, 1.05, 1.0, 'V2')) sigV2.push(s);
  }
  const sigW1: RawSignal[] = [];
  for (const coin of COINS_15) {
    for (const s of sigWeekHigh(barsByCoin.get(coin)!, coin)) sigW1.push(s);
  }
  console.log(`  V1: ${sigV1.length}, V2: ${sigV2.length}, W1: ${sigW1.length}`);
  const sigENS = [...sigV1, ...sigV2, ...sigW1].sort((a, b) => a.ts - b.ts);

  const periods = [
    { name: 'Q1 24-06~09', start: '2024-06-10', end: '2024-09-10' },
    { name: 'Q2 24-09~12', start: '2024-09-10', end: '2024-12-10' },
    { name: 'Q3 24-12~25-03', start: '2024-12-10', end: '2025-03-10' },
    { name: 'Q4 25-03~06', start: '2025-03-10', end: '2025-06-10' },
    { name: 'Q5 25-06~09', start: '2025-06-10', end: '2025-09-10' },
    { name: 'Q6 25-09~12', start: '2025-09-10', end: '2025-12-10' },
    { name: 'Q7 25-12~26-03', start: '2025-12-10', end: '2026-03-10' },
    { name: 'Q8 26-03~06', start: '2026-03-10', end: '2026-06-10' },
    { name: '2Y FULL',       start: '2024-06-10', end: '2026-06-10' },
  ];

  const strategies = [
    { name: 'V1 VOL_EXP_A',  sigs: sigV1 },
    { name: 'V2 VOL_EXP_B',  sigs: sigV2 },
    { name: 'W1 WEEK_HIGH',  sigs: sigW1 },
    { name: 'ENS V1+V2+W1',  sigs: sigENS },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R30-10C — 4 strategy fleet × 2년 × 15코인 풀 (코인 제한 없이)`);
  L.push(`Total capital: 3000만 KRW = 4 strategy × 750만 (각자 독립 portfolio)`);
  L.push(`Coins: ${COINS_15.join(', ')}`);
  L.push(`Period: 2024-06-10 ~ 2026-06-10 (2 years, 8 quarters + 2Y FULL)`);
  L.push('='.repeat(170));

  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    L.push(`\n## ${period.name} (${period.start} ~ ${period.end})\n`);
    L.push(`${pad('strategy', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 13)} | pass`);
    L.push('-'.repeat(95));
    for (const strat of strategies) {
      const { trades, finalCash, mdd } = simulate(strat.sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(trades, finalCash, mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      L.push(`${pad(strat.name, 22)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${padS(s.finalCash.toFixed(0), 13)} | ${pass ? '✓' : ''}`);
    }
  }

  // Robustness 종합
  L.push(`\n\n## Robustness 종합 (Q1~Q8 + 2Y)\n`);
  L.push(`${pad('strategy', 22)} | ${padS('Q1', 4)} | ${padS('Q2', 4)} | ${padS('Q3', 4)} | ${padS('Q4', 4)} | ${padS('Q5', 4)} | ${padS('Q6', 4)} | ${padS('Q7', 4)} | ${padS('Q8', 4)} | ${padS('2Y', 4)} | ${padS('pass/8Q', 7)} | ${padS('2Y PF', 6)} | ${padS('2Y total', 9)} | ${padS('2Y MDD', 7)}`);
  L.push('-'.repeat(150));
  for (const strat of strategies) {
    const passes: boolean[] = [];
    let yearStats: ReturnType<typeof statsFor> | null = null;
    for (const period of periods) {
      const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
      const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
      const { trades, finalCash, mdd } = simulate(strat.sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(trades, finalCash, mdd);
      passes.push(s.pf >= 1.2 && s.total > 0);
      if (period.name === '2Y FULL') yearStats = s;
    }
    const qPass = passes.slice(0, 8).filter(p => p).length;
    L.push(`${pad(strat.name, 22)} | ${passes.slice(0, 8).map(p => padS(p ? '✓' : '✗', 4)).join(' | ')} | ${padS(passes[8] ? '✓' : '✗', 4)} | ${padS(`${qPass}/8`, 7)} | ${padS(yearStats!.pf.toFixed(2), 6)} | ${padS(fmt(yearStats!.total), 9)} | ${padS(yearStats!.mdd.toFixed(1)+'%', 7)}`);
  }

  // 합산 portfolio (4 strategy 자본 합산)
  L.push(`\n\n## 총 포트폴리오 (4 strategy 합산, 자본 3000만)`);
  for (const period of [periods[8]]) { // 2Y FULL만
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    let totalFinal = 0;
    let totalN = 0;
    for (const strat of strategies) {
      const { trades, finalCash } = simulate(strat.sigs, barsByCoin, pStart, pEnd);
      totalFinal += finalCash;
      totalN += trades.length;
    }
    const totalInitial = INITIAL_CASH * strategies.length;
    const totalRet = (totalFinal - totalInitial) / totalInitial * 100;
    L.push(`  ${period.name}: initial ${totalInitial.toLocaleString()} → final ${Math.round(totalFinal).toLocaleString()} (${fmt(totalRet)}), n=${totalN}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-10C_2Y.txt`), L.join('\n'));
  process.exit(0);
})();
