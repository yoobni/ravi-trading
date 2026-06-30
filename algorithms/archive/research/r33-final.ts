/**
 * R33 — 최종 테스트.
 *
 * Algos (4h TF):
 *   F6 NEW_HIGH 42 (7d) — 7일 신고가 + 양봉 follow-through + vol z≥0.5
 *   F2 BREAKOUT42 (7d)  — 7일 high break + vol z≥1.0
 *   F4 EMA_PULLBACK     — EMA20 풀백 + EMA50 위 + 양봉
 *
 * Pool: 28코인 (기존 15 + 추가 13)
 *   BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, BCH,
 *   POL, NEAR, ATOM, TRX, ALGO,
 *   ETC, XLM, AAVE, ARB, APT, SUI, GRT, IMX, SAND, MANA, CHZ, AXS, BAT
 *
 * 각 algo 1000만 KRW, position 33% × max 3, multi-pos per coin OK
 * Period: 2024-06-10 ~ 2026-06-10 (2년)
 * Walk-forward: 분기 8개
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
const TP_PCT = 5.0;
const SL_PCT = -2.0;
const MAX_BARS = 84;

const COINS = [
  // 기존 15
  'BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH',
  'POL','NEAR','ATOM','TRX','ALGO',
  // 추가 13
  'ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT',
];

function load4hBars2Y(coin: string): CachedBar[] {
  const y1 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2024-06-10_2025-06-10.json`), 'utf-8'));
  const y2 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2025-06-10_2026-06-10.json`), 'utf-8'));
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const arr of [y1, y2]) for (const b of arr) {
    if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface RawSignal { coin: string; barIdx: number; ts: number; algoId: 'F6'|'F2'|'F4'; }

function sigF6(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, algoId: 'F6' });
  }
  return out;
}
function sigF2(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].close <= prevMax && bars[i].close > prevMax)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, algoId: 'F2' });
  }
  return out;
}
function sigF4(bars: CachedBar[], coin: string): RawSignal[] {
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
    out.push({ coin, barIdx: i, ts: bars[i].ts, algoId: 'F4' });
  }
  return out;
}

interface Position { coin: string; algoId: 'F6'|'F2'|'F4'; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; algoId: 'F6'|'F2'|'F4'; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

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
      const tp = pos.entryPrice * (1 + TP_PCT / 100), sl = pos.entryPrice * (1 + SL_PCT / 100);
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
  console.log(`\n=== R33 최종 — 3 algo × 2년 × ${COINS.length}코인 풀 ===\n`);

  console.log(`Loading 2y 4h bars (${COINS.length} coins)...`);
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, load4hBars2Y(coin));

  console.log(`Building signals across ${COINS.length} coins...`);
  const sigF6arr: RawSignal[] = [];
  const sigF2arr: RawSignal[] = [];
  const sigF4arr: RawSignal[] = [];
  for (const coin of COINS) {
    const bars = barsByCoin.get(coin)!;
    for (const s of sigF6(bars, coin)) sigF6arr.push(s);
    for (const s of sigF2(bars, coin)) sigF2arr.push(s);
    for (const s of sigF4(bars, coin)) sigF4arr.push(s);
  }
  console.log(`  F6: ${sigF6arr.length}, F2: ${sigF2arr.length}, F4: ${sigF4arr.length}`);

  const periods = [
    { name: '1Y (25-06~26-06)', start: '2025-06-10', end: '2026-06-10' },
    { name: '2Y FULL (24-06~26-06)', start: '2024-06-10', end: '2026-06-10' },
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

  const strategies = [
    { name: 'F6 NEW_HIGH 42',   sigs: sigF6arr },
    { name: 'F2 BREAKOUT42',    sigs: sigF2arr },
    { name: 'F4 EMA_PULLBACK',  sigs: sigF4arr },
  ];

  const L: string[] = [];
  L.push('='.repeat(180));
  L.push(`R33 FINAL — 3 algo × 2년 × ${COINS.length}코인 풀`);
  L.push(`Coins: ${COINS.join(', ')}`);
  L.push(`각 algo 1000만 독립 portfolio, position 33% × max 3 concurrent, multi-pos per coin OK`);
  L.push(`Variant: TP+5%/SL-2%/MAX 14d. Cost RT 0.1%.`);
  L.push('='.repeat(180));

  // 1Y / 2Y
  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    L.push(`\n## ${period.name}\n`);
    L.push(`${pad('strategy', 20)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 13)} | pass`);
    L.push('-'.repeat(90));
    let totalFinal = 0, totalN = 0;
    const algoResults: { name: string; finalCash: number; trades: PfTrade[]; mdd: number }[] = [];
    for (const strat of strategies) {
      const { trades, finalCash, mdd } = simulate(strat.sigs, barsByCoin, pStart, pEnd);
      algoResults.push({ name: strat.name, finalCash, trades, mdd });
      const s = statsFor(trades, finalCash, mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      totalFinal += finalCash;
      totalN += s.n;
      L.push(`${pad(strat.name, 20)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${padS(s.finalCash.toFixed(0), 13)} | ${pass ? '✓' : ''}`);
    }
    const totalInitial = INITIAL_CASH * strategies.length;
    const totalRet = (totalFinal - totalInitial) / totalInitial * 100;
    L.push('-'.repeat(90));
    L.push(`${pad('TOTAL (3 strats)', 20)} | ${padS(String(totalN), 4)} | ${padS('-', 5)} | ${padS(fmt(totalRet), 9)} | ${padS('-', 5)} | ${padS('-', 6)} | ${padS(totalFinal.toFixed(0), 13)}`);
    L.push(`  → 자본 ${(totalInitial/1e7).toFixed(0)}천만 → ${(totalFinal/1e7).toFixed(2)}천만`);
  }

  // 분기 walk-forward
  L.push(`\n## 분기 walk-forward (8 quarters)\n`);
  L.push(`${pad('strategy', 20)} | ${quarters.map(q => padS(q.name, 4)).join('|')} | pass/8`);
  L.push('-'.repeat(85));
  for (const strat of strategies) {
    const passes: boolean[] = [];
    for (const q of quarters) {
      const pStart = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pEnd = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const { trades, finalCash, mdd } = simulate(strat.sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(trades, finalCash, mdd);
      passes.push(s.pf >= 1.2 && s.total > 0);
    }
    const cnt = passes.filter(p => p).length;
    L.push(`${pad(strat.name, 20)} | ${passes.map(p => padS(p ? '✓' : '✗', 4)).join('|')} | ${cnt}/8`);
  }

  // 코인별 PnL 분포 (2Y)
  L.push(`\n## 코인별 PnL 기여 (2Y)\n`);
  const pStart2y = new Date('2024-06-10T00:00:00+09:00').getTime();
  const pEnd2y = new Date('2026-06-10T23:59:59+09:00').getTime();
  for (const strat of strategies) {
    L.push(`\n### ${strat.name}`);
    const { trades } = simulate(strat.sigs, barsByCoin, pStart2y, pEnd2y);
    const byCoin = new Map<string, { n: number; pnl: number; wins: number }>();
    for (const t of trades) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, { n: 0, pnl: 0, wins: 0 });
      const d = byCoin.get(t.coin)!;
      d.n++; d.pnl += t.profitKrw;
      if (t.profitKrw > 0) d.wins++;
    }
    const rows = [...byCoin.entries()].map(([coin, d]) => ({ coin, ...d, pnlPct: d.pnl / INITIAL_CASH * 100 }))
      .sort((a, b) => b.pnlPct - a.pnlPct);
    L.push(`  ${pad('coin', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('pnl%', 8)}`);
    L.push(`  ${'-'.repeat(40)}`);
    for (const r of rows) {
      const wr = r.n > 0 ? r.wins / r.n * 100 : 0;
      L.push(`  ${pad(r.coin, 6)} | ${padS(String(r.n), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.pnlPct, false), 8)}`);
    }
    const negCount = rows.filter(r => r.pnl < 0).length;
    L.push(`  → 코인 ${rows.length}개 중 음수 ${negCount}개`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R33_FINAL.txt`), L.join('\n'));
  process.exit(0);
})();
