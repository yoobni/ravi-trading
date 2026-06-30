/**
 * R11 TREND_PULLBACK_PERP — 추세 추종 + pullback reversal, 양방향.
 *
 * 가설: 큰 추세 + 작은 반대 pullback 후 추세 방향 회복 시 진입.
 *       추세를 거스르지 않으므로 WR 높을 것.
 *
 * 신호:
 *   UP trend (1d close > 50d EMA AND 50d EMA 상승):
 *     1h close < 1h 50p EMA (pullback)
 *     → 다음 1h에 close > 1h 20p EMA + 양봉 (회복)
 *     → 다음 15m 시초가 LONG
 *
 *   DOWN trend (1d close < 50d EMA AND 50d EMA 하락):
 *     1h close > 1h 50p EMA (rally)
 *     → 다음 1h에 close < 1h 20p EMA + 음봉 (거부)
 *     → 다음 15m 시초가 SHORT
 *
 * 청산: 1m path verified TP/SL/MAX.
 *
 * 데이터: Binance BTCUSDT daily + Upbit 1m proxy (12개월).
 * Cost: 왕복 0.2% (Binance perp taker + slippage)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

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
      ts,
      date: new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
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

type Direction = 'LONG' | 'SHORT';
interface Trade {
  signalTs: number; direction: Direction;
  entryTs: number; entryDate: string; entryPrice: number;
  exitTs: number; exitDate: string; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  durationMin: number; monthKey: string;
  trend: 'UP' | 'DOWN';
}

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
function pathVerify(bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number, direction: Direction, tpPct: number, slPct: number, maxMin: number): ExitResult {
  // LONG: TP = entry × (1+tp/100), SL = entry × (1+sl/100) [sl<0]
  // SHORT: TP = entry × (1-tp/100), SL = entry × (1-sl/100) [sl<0 → 1+|sl|/100]
  const tpPrice = direction === 'LONG' ? entryPriceRaw * (1 + tpPct / 100) : entryPriceRaw * (1 - tpPct / 100);
  const slPrice = direction === 'LONG' ? entryPriceRaw * (1 + slPct / 100) : entryPriceRaw * (1 - slPct / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsed = (bar.ts - entryTs) / 60_000;
    if (direction === 'LONG') {
      if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: slPct, durationMin: elapsed };
      if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: tpPct, durationMin: elapsed };
    } else {
      if (bar.high >= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: slPct, durationMin: elapsed };
      if (bar.low <= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: tpPct, durationMin: elapsed };
    }
    if (elapsed >= maxMin) {
      const ret = direction === 'LONG'
        ? (bar.close - entryPriceRaw) / entryPriceRaw * 100
        : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret, durationMin: elapsed };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG'
    ? (last.close - entryPriceRaw) / entryPriceRaw * 100
    : (entryPriceRaw - last.close) / entryPriceRaw * 100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret, durationMin: (last.ts - entryTs) / 60_000 };
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

function monthList(): string[] {
  const out: string[] = [];
  let y = parseInt(ANALYSIS_START.slice(0, 4));
  let m = parseInt(ANALYSIS_START.slice(5, 7));
  const endY = parseInt(ANALYSIS_END.slice(0, 4));
  const endM = parseInt(ANALYSIS_END.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${m.toString().padStart(2, '0')}`); m++;
    if (m > 12) { y++; m = 1; }
  }
  return out;
}
function monthlyTable(trades: Trade[]): string[] {
  const L: string[] = [];
  L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
  L.push('-'.repeat(85));
  const byMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
    byMonth.get(t.monthKey)!.push(t);
  }
  let cum = 0;
  for (const mk of monthList()) {
    const ts = byMonth.get(mk) ?? [];
    const s = statsFor(ts);
    cum += s.total;
    if (s.n === 0) {
      L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
    } else {
      L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
    }
  }
  const all = statsFor(trades);
  L.push(`${pad('TOTAL', 8)} | ${padS(String(all.n), 3)} | ${padS(all.wr.toFixed(0)+'%', 5)} | ${padS(fmt(all.avgWin), 7)} | ${padS(fmt(all.avgLoss), 7)} | ${padS(fmt(all.total), 8)} | ${padS(all.pf.toFixed(2), 5)} | ${padS(fmt(all.total), 8)}`);
  return L;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R11 TREND_PULLBACK_PERP ===\n`);
  const bars1m = loadBtc1m();
  const bars15m = aggregate(bars1m, 15);
  const bars1h = aggregate(bars1m, 60);
  const bars1d = aggregate(bars1m, 24 * 60);

  // EMAs
  const closes1d = bars1d.map((b) => b.close);
  const ema50_1d = calcEMA(closes1d, 50);
  const closes1h = bars1h.map((b) => b.close);
  const ema50_1h = calcEMA(closes1h, 50);
  const ema20_1h = calcEMA(closes1h, 20);

  const ema50_1d_byTs = new Map(bars1d.map((b, i) => [b.ts, ema50_1d[i]]));
  // 1h indicators
  const ema50_1h_byTs = new Map(bars1h.map((b, i) => [b.ts, ema50_1h[i]]));
  const ema20_1h_byTs = new Map(bars1h.map((b, i) => [b.ts, ema20_1h[i]]));

  // 1d trend at given ts: 가장 최근 완료 1d bar의 close vs EMA50
  function get1dTrend(ts: number): 'UP' | 'DOWN' | null {
    // find latest 1d bar with ts < given ts
    let idx = -1;
    for (let i = bars1d.length - 1; i >= 0; i--) {
      if (bars1d[i].ts < ts) { idx = i; break; }
    }
    if (idx < 0) return null;
    const e = ema50_1d[idx];
    if (e == null) return null;
    // EMA50 slope: 비교 5일 전
    const ePrev = idx >= 5 ? ema50_1d[idx - 5] : null;
    if (ePrev == null) return null;
    if (bars1d[idx].close > e && e > ePrev) return 'UP';
    if (bars1d[idx].close < e && e < ePrev) return 'DOWN';
    return null;
  }

  // 1h pullback/recover: 1h bar 평가
  function checkSignal(barIdx1h: number, trend: 'UP' | 'DOWN'): Direction | null {
    if (barIdx1h < 2) return null;
    const cur = bars1h[barIdx1h];
    const prev = bars1h[barIdx1h - 1];
    const ema50 = ema50_1h[barIdx1h];
    const ema20 = ema20_1h[barIdx1h];
    const ema50Prev = ema50_1h[barIdx1h - 1];
    if (ema50 == null || ema20 == null || ema50Prev == null) return null;

    if (trend === 'UP') {
      // 이전 1h가 pullback (prev.close < ema50Prev)
      // 현재 1h가 회복 (cur.close > ema20 + cur.close > cur.open 양봉)
      if (prev.close < ema50Prev && cur.close > ema20 && cur.close > cur.open) {
        return 'LONG';
      }
    } else {
      // 이전 1h가 rally (prev.close > ema50Prev)
      // 현재 1h가 거부 (cur.close < ema20 + cur.close < cur.open 음봉)
      if (prev.close > ema50Prev && cur.close < ema20 && cur.close < cur.open) {
        return 'SHORT';
      }
    }
    return null;
  }

  function simulate(v: Variant): Trade[] {
    const trades: Trade[] = [];
    let cooldownTs = 0;
    for (let i = 0; i < bars1h.length - 1; i++) {
      const bar = bars1h[i];
      const day = new Date(bar.ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
      if (bar.ts < cooldownTs) continue;

      const trend = get1dTrend(bar.ts);
      if (!trend) continue;
      const dir = checkSignal(i, trend);
      if (!dir) continue;

      // 다음 15m 시초가 진입
      const nextSlotTs = Math.floor((bar.ts + 60 * 60_000) / (15 * 60_000)) * (15 * 60_000);
      const entry15mIdx = bars15m.findIndex((b) => b.ts >= nextSlotTs);
      if (entry15mIdx < 0 || entry15mIdx >= bars15m.length) break;
      const entryBar = bars15m[entry15mIdx];
      const entryTs = entryBar.ts;
      const entryPriceRaw = entryBar.open;
      const start1mIdx = find1mIdx(bars1m, entryTs);
      if (start1mIdx >= bars1m.length) break;

      const exit = pathVerify(bars1m, start1mIdx, entryTs, entryPriceRaw, dir, v.tp, v.sl, v.maxMin);
      const netReturn = exit.rawReturnPct - COST_RT * 100;
      trades.push({
        signalTs: bar.ts, direction: dir,
        entryTs, entryDate: entryBar.date, entryPrice: entryPriceRaw,
        exitTs: exit.exitTs, exitDate: new Date(exit.exitTs + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' '),
        exitPrice: exit.exitPrice, reason: exit.reason,
        rawReturnPct: exit.rawReturnPct, netReturnPct: netReturn,
        durationMin: exit.durationMin,
        monthKey: day.slice(0, 7), trend,
      });
      cooldownTs = exit.exitTs;
    }
    return trades;
  }

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R11 TREND_PULLBACK_PERP — Binance BTC perpetual 가정`);
  L.push(`1d trend(EMA50, slope) + 1h pullback/rally + 1h reversal → 다음 15m LONG/SHORT`);
  L.push(`1m path verified exit. 양방향. Cost 왕복 0.2%.`);
  L.push('='.repeat(140));

  for (const v of VARIANTS) {
    const trades = simulate(v);
    L.push(`\n## ${v.name}\n`);
    // 양방향
    L.push(`### Bidirectional (LONG + SHORT)`);
    L.push(...monthlyTable(trades));
    // LONG only
    const longs = trades.filter((t) => t.direction === 'LONG');
    L.push(`\n### LONG only (UP trend)`);
    L.push(...monthlyTable(longs));
    // SHORT only
    const shorts = trades.filter((t) => t.direction === 'SHORT');
    L.push(`\n### SHORT only (DOWN trend)`);
    L.push(...monthlyTable(shorts));
  }

  // 종합 요약
  L.push(`\n\n## 1년 합계 요약\n`);
  L.push(`${pad('variant × dir', 30)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(85));
  for (const v of VARIANTS) {
    const trades = simulate(v);
    const longs = trades.filter((t) => t.direction === 'LONG');
    const shorts = trades.filter((t) => t.direction === 'SHORT');
    const sBoth = statsFor(trades);
    const sLong = statsFor(longs);
    const sShort = statsFor(shorts);
    L.push(`${pad(`${v.name} BOTH`, 30)} | ${padS(String(sBoth.n), 4)} | ${padS(sBoth.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sBoth.avgWin), 7)} | ${padS(fmt(sBoth.avgLoss), 7)} | ${padS(fmt(sBoth.total), 8)} | ${padS(sBoth.pf.toFixed(2), 5)}`);
    L.push(`${pad(`${v.name} LONG`, 30)} | ${padS(String(sLong.n), 4)} | ${padS(sLong.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sLong.avgWin), 7)} | ${padS(fmt(sLong.avgLoss), 7)} | ${padS(fmt(sLong.total), 8)} | ${padS(sLong.pf.toFixed(2), 5)}`);
    L.push(`${pad(`${v.name} SHORT`, 30)} | ${padS(String(sShort.n), 4)} | ${padS(sShort.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sShort.avgWin), 7)} | ${padS(fmt(sShort.avgLoss), 7)} | ${padS(fmt(sShort.total), 8)} | ${padS(sShort.pf.toFixed(2), 5)}`);
    L.push('');
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R11_TREND_PULLBACK.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
