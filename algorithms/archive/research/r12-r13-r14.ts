/**
 * Round 5 — R12 / R13 / R14 동시 실행 (Binance perp 가정, 양방향).
 *
 * R12 R11_INVERSE   : R11 룰 정반대 진입 (UP+pullback+양봉 → SHORT, DOWN+rally+음봉 → LONG)
 * R13 BB_REVERSAL   : 1h BB(20,2) 상단/하단 외부 close 후 다음 봉 BB 안 회복 → 역방향 entry
 * R14 MTF_MACD      : 4h MACD 양수 + 1h MACD bullish cross → LONG. 4h 음수 + bearish → SHORT.
 *
 * 데이터: Upbit BTC 1m → 15m/1h/4h 합성 (Binance proxy)
 * Cost 왕복 0.2%, 1m path verify
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcBollingerBands, calcMACD } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP0.8_SL0.5_4h',  tp: 0.8, sl: -0.5, maxMin: 240 },
  { name: 'B_TP1.5_SL1.0_8h',  tp: 1.5, sl: -1.0, maxMin: 480 },
  { name: 'C_TP2.5_SL1.5_24h', tp: 2.5, sl: -1.5, maxMin: 1440 },
];

function loadBtc1m(): Bar[] {
  const files = ['KRW-BTC_1m_2025-06-01_2025-11-30.json', 'KRW-BTC_1m_2025-12-01_2026-05-29.json'];
  const all: Bar[] = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8')) as Bar[];
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);
  }
  const seen = new Set<number>();
  return all.filter((b) => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; }).sort((a, b) => a.ts - b.ts);
}
function aggregate(bars1m: Bar[], minutes: number): Bar[] {
  const buckets = new Map<number, Bar[]>();
  const slot = minutes * 60_000;
  for (const b of bars1m) {
    const k = Math.floor(b.ts / slot) * slot;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(b);
  }
  const out: Bar[] = [];
  for (const [ts, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length === 0) continue;
    out.push({
      ts, date: new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
      open: bs[0].open,
      high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)),
      close: bs[bs.length - 1].close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}
function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

function find1mIdx(bars: Bar[], ts: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface ExitResult { exitTs: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; rawReturnPct: number; durationMin: number; }
function pathVerify(bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number, direction: Direction, v: Variant): ExitResult {
  const tpPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.tp / 100) : entryPriceRaw * (1 - v.tp / 100);
  const slPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.sl / 100) : entryPriceRaw * (1 - v.sl / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsed = (bar.ts - entryTs) / 60_000;
    if (direction === 'LONG') {
      if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl, durationMin: elapsed };
      if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp, durationMin: elapsed };
    } else {
      if (bar.high >= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl, durationMin: elapsed };
      if (bar.low <= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp, durationMin: elapsed };
    }
    if (elapsed >= v.maxMin) {
      const ret = direction === 'LONG' ? (bar.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret, durationMin: elapsed };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG' ? (last.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - last.close) / entryPriceRaw * 100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret, durationMin: (last.ts - entryTs) / 60_000 };
}

interface Trade {
  signalTs: number; direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}

function statsFor(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, avgWin: 0, avgLoss: 0, payoff: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const wr = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
  const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  return { n, wr, avgWin, avgLoss, payoff, total, pf };
}

function inAnalysis(ts: number): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ANALYSIS_START && d <= ANALYSIS_END;
}

// ─────────────────────────────────────────────────────
// R12: R11_INVERSE
// ─────────────────────────────────────────────────────
function runR12(bars1m: Bar[], bars1h: Bar[], bars1d: Bar[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  const closes1d = bars1d.map((b) => b.close);
  const closes1h = bars1h.map((b) => b.close);
  const ema50_1d = calcEMA(closes1d, 50);
  const ema50_1h = calcEMA(closes1h, 50);
  const ema20_1h = calcEMA(closes1h, 20);

  function get1dTrend(ts: number): 'UP' | 'DOWN' | null {
    let idx = -1;
    for (let i = bars1d.length - 1; i >= 0; i--) if (bars1d[i].ts < ts) { idx = i; break; }
    if (idx < 0 || idx < 5) return null;
    const e = ema50_1d[idx]; const ePrev = ema50_1d[idx - 5];
    if (e == null || ePrev == null) return null;
    if (bars1d[idx].close > e && e > ePrev) return 'UP';
    if (bars1d[idx].close < e && e < ePrev) return 'DOWN';
    return null;
  }

  let cooldownTs = 0;
  for (let i = 2; i < bars1h.length - 1; i++) {
    const bar = bars1h[i];
    if (!inAnalysis(bar.ts) || bar.ts < cooldownTs) continue;
    const trend = get1dTrend(bar.ts);
    if (!trend) continue;
    const prev = bars1h[i - 1];
    const e50 = ema50_1h[i], e20 = ema20_1h[i], e50p = ema50_1h[i - 1];
    if (e50 == null || e20 == null || e50p == null) continue;

    let dir: Direction | null = null;
    if (trend === 'UP' && prev.close < e50p && bar.close > e20 && bar.close > bar.open) dir = 'SHORT'; // INVERSE
    if (trend === 'DOWN' && prev.close > e50p && bar.close < e20 && bar.close < bar.open) dir = 'LONG'; // INVERSE
    if (!dir) continue;

    const nextSlot = Math.floor((bar.ts + 60 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(bars1m, nextSlot);
    if (startIdx >= bars1m.length) break;
    const entryBar = bars1m[startIdx];
    const exit = pathVerify(bars1m, startIdx, entryBar.ts, entryBar.open, dir, v);
    const netRet = exit.rawReturnPct - COST_RT * 100;
    trades.push({
      signalTs: bar.ts, direction: dir,
      entryTs: entryBar.ts, entryPrice: entryBar.open,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey: new Date(bar.ts + 9 * 3600_000).toISOString().slice(0, 7),
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

// ─────────────────────────────────────────────────────
// R13: BB_REVERSAL
// ─────────────────────────────────────────────────────
function runR13(bars1m: Bar[], bars1h: Bar[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  const closes = bars1h.map((b) => b.close);
  const bb = calcBollingerBands(closes, 20, 2);

  let cooldownTs = 0;
  for (let i = 1; i < bars1h.length - 1; i++) {
    const bar = bars1h[i];
    if (!inAnalysis(bar.ts) || bar.ts < cooldownTs) continue;
    const prev = bars1h[i - 1];
    const upperPrev = bb.upper[i - 1], lowerPrev = bb.lower[i - 1];
    const upper = bb.upper[i], lower = bb.lower[i];
    if (upper == null || lower == null || upperPrev == null || lowerPrev == null) continue;

    let dir: Direction | null = null;
    // 이전 1h close가 upper 밖 (overbought), 현재 close가 upper 안 (회복) → SHORT (mean reversion)
    if (prev.close > upperPrev && bar.close < upper) dir = 'SHORT';
    // 이전 1h close가 lower 밖 (oversold), 현재 close가 lower 안 → LONG
    else if (prev.close < lowerPrev && bar.close > lower) dir = 'LONG';
    if (!dir) continue;

    const nextSlot = Math.floor((bar.ts + 60 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(bars1m, nextSlot);
    if (startIdx >= bars1m.length) break;
    const entryBar = bars1m[startIdx];
    const exit = pathVerify(bars1m, startIdx, entryBar.ts, entryBar.open, dir, v);
    const netRet = exit.rawReturnPct - COST_RT * 100;
    trades.push({
      signalTs: bar.ts, direction: dir,
      entryTs: entryBar.ts, entryPrice: entryBar.open,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey: new Date(bar.ts + 9 * 3600_000).toISOString().slice(0, 7),
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

// ─────────────────────────────────────────────────────
// R14: MTF_MACD
// ─────────────────────────────────────────────────────
function runR14(bars1m: Bar[], bars1h: Bar[], bars4h: Bar[], v: Variant): Trade[] {
  const trades: Trade[] = [];
  const closes1h = bars1h.map((b) => b.close);
  const closes4h = bars4h.map((b) => b.close);
  const macd1h = calcMACD(closes1h, 12, 26, 9);
  const macd4h = calcMACD(closes4h, 12, 26, 9);

  // 4h MACD histogram at given ts
  function get4hMacdHist(ts: number): number | null {
    let idx = -1;
    for (let i = bars4h.length - 1; i >= 0; i--) if (bars4h[i].ts <= ts) { idx = i; break; }
    if (idx < 0) return null;
    return macd4h.histogram[idx] ?? null;
  }

  let cooldownTs = 0;
  for (let i = 2; i < bars1h.length - 1; i++) {
    const bar = bars1h[i];
    if (!inAnalysis(bar.ts) || bar.ts < cooldownTs) continue;
    const hist1hPrev = macd1h.histogram[i - 1];
    const hist1h = macd1h.histogram[i];
    if (hist1hPrev == null || hist1h == null) continue;
    const hist4h = get4hMacdHist(bar.ts);
    if (hist4h == null) continue;

    let dir: Direction | null = null;
    // 4h positive + 1h bullish cross (hist 음→양) → LONG
    if (hist4h > 0 && hist1hPrev < 0 && hist1h > 0) dir = 'LONG';
    // 4h negative + 1h bearish cross → SHORT
    else if (hist4h < 0 && hist1hPrev > 0 && hist1h < 0) dir = 'SHORT';
    if (!dir) continue;

    const nextSlot = Math.floor((bar.ts + 60 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(bars1m, nextSlot);
    if (startIdx >= bars1m.length) break;
    const entryBar = bars1m[startIdx];
    const exit = pathVerify(bars1m, startIdx, entryBar.ts, entryBar.open, dir, v);
    const netRet = exit.rawReturnPct - COST_RT * 100;
    trades.push({
      signalTs: bar.ts, direction: dir,
      entryTs: entryBar.ts, entryPrice: entryBar.open,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey: new Date(bar.ts + 9 * 3600_000).toISOString().slice(0, 7),
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== Round 5: R12 / R13 / R14 ===\n`);
  const bars1m = loadBtc1m();
  const bars15m = aggregate(bars1m, 15);
  const bars1h = aggregate(bars1m, 60);
  const bars4h = aggregate(bars1m, 240);
  const bars1d = aggregate(bars1m, 24 * 60);
  console.log(`1m=${bars1m.length}, 15m=${bars15m.length}, 1h=${bars1h.length}, 4h=${bars4h.length}, 1d=${bars1d.length}`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`Round 5 — R12 (R11 inverse) / R13 (BB reversal) / R14 (MTF MACD)`);
  L.push(`Binance perp 가정, 양방향, 1m path verify, cost 왕복 0.2%`);
  L.push(`Period: ${ANALYSIS_START} ~ ${ANALYSIS_END}`);
  L.push('='.repeat(140));

  const strategies = [
    { name: 'R12_INVERSE', run: (v: Variant) => runR12(bars1m, bars1h, bars1d, v) },
    { name: 'R13_BB_REV',  run: (v: Variant) => runR13(bars1m, bars1h, v) },
    { name: 'R14_MTF_MACD', run: (v: Variant) => runR14(bars1m, bars1h, bars4h, v) },
  ];

  L.push(`\n## 1년 합계 요약\n`);
  L.push(`${pad('strategy × variant × dir', 38)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(95));

  const allResults: Record<string, Trade[]> = {};
  for (const strat of strategies) {
    for (const v of VARIANTS) {
      const trades = strat.run(v);
      allResults[`${strat.name}_${v.name}`] = trades;
      const longs = trades.filter((t) => t.direction === 'LONG');
      const shorts = trades.filter((t) => t.direction === 'SHORT');
      const sBoth = statsFor(trades);
      const sLong = statsFor(longs);
      const sShort = statsFor(shorts);
      L.push(`${pad(`${strat.name} ${v.name} BOTH`, 38)} | ${padS(String(sBoth.n), 4)} | ${padS(sBoth.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sBoth.avgWin), 7)} | ${padS(fmt(sBoth.avgLoss), 7)} | ${padS(fmt(sBoth.total), 8)} | ${padS(sBoth.pf.toFixed(2), 5)}`);
      L.push(`${pad(`${strat.name} ${v.name} LONG`, 38)} | ${padS(String(sLong.n), 4)} | ${padS(sLong.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sLong.avgWin), 7)} | ${padS(fmt(sLong.avgLoss), 7)} | ${padS(fmt(sLong.total), 8)} | ${padS(sLong.pf.toFixed(2), 5)}`);
      L.push(`${pad(`${strat.name} ${v.name} SHORT`, 38)} | ${padS(String(sShort.n), 4)} | ${padS(sShort.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sShort.avgWin), 7)} | ${padS(fmt(sShort.avgLoss), 7)} | ${padS(fmt(sShort.total), 8)} | ${padS(sShort.pf.toFixed(2), 5)}`);
      L.push('');
    }
  }

  // 월별 (각 strategy의 best variant)
  for (const strat of strategies) {
    // 1년 total 가장 좋은 variant
    let bestVar = VARIANTS[0]; let bestTotal = -Infinity;
    for (const v of VARIANTS) {
      const trades = allResults[`${strat.name}_${v.name}`];
      const s = statsFor(trades);
      if (s.total > bestTotal) { bestTotal = s.total; bestVar = v; }
    }
    const trades = allResults[`${strat.name}_${bestVar.name}`];
    if (trades.length === 0) continue;

    L.push(`\n## ${strat.name} 월별 (best variant ${bestVar.name}, BOTH)\n`);
    L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)}`);
    L.push('-'.repeat(75));
    const byMonth = new Map<string, Trade[]>();
    for (const t of trades) {
      if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
      byMonth.get(t.monthKey)!.push(t);
    }
    let cum = 0;
    const months: string[] = [];
    let y = parseInt(ANALYSIS_START.slice(0, 4));
    let m = parseInt(ANALYSIS_START.slice(5, 7));
    const endY = parseInt(ANALYSIS_END.slice(0, 4));
    const endM = parseInt(ANALYSIS_END.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      months.push(`${y}-${m.toString().padStart(2, '0')}`); m++;
      if (m > 12) { y++; m = 1; }
    }
    for (const mk of months) {
      const ts = byMonth.get(mk) ?? [];
      const s = statsFor(ts); cum += s.total;
      if (s.n === 0) L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)}`);
      else L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    const all = statsFor(trades);
    L.push(`${pad('TOTAL', 8)} | ${padS(String(all.n), 3)} | ${padS(all.wr.toFixed(0)+'%', 5)} | ${padS(fmt(all.avgWin), 7)} | ${padS(fmt(all.avgLoss), 7)} | ${padS(fmt(all.total), 8)} | ${padS(all.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_ROUND5_R12_R13_R14.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
