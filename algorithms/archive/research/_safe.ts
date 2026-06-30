/**
 * Lookahead-safe helper library.
 *
 * 모든 함수는 명확한 "as-of" contract를 가진다:
 *   - "as-of ts" = signal evaluation 시점. 이 시점에서 알 수 있는 정보만 사용.
 *
 * 핵심 원칙:
 *   1. Bar (OHLCV) 데이터는 "bar.ts ~ bar.ts + duration" 구간에 해당하는 정보.
 *      bar.close는 bar.ts + duration 시점에 알게 됨.
 *      따라서 signal at ts에서 bar.close 쓰려면: bar.ts + duration ≤ ts
 *
 *   2. Indicator 배열 ind[i]는 "bars[i]의 close 시점에 알게 되는 값".
 *      i.e., bars[i].ts + duration 시점부터 유효.
 *
 *   3. signal_ts = bars[i].ts + duration (= bar i가 close된 직후).
 *      그래서 signal at bars[i] uses ind[i] is OK.
 *
 *   4. Entry는 signal_ts + 1 tick 이후의 첫 가능 가격 (= 다음 bar의 open).
 *
 *   5. Higher TF lookup: 가장 최근 "완전히 종료된" higher bar.
 *      i.e., bigger_bar.ts + big_duration ≤ ts
 *
 * 이 contract만 지키면 lookahead 불가능.
 */
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');

export interface Bar {
  ts: number;        // bar START time (ms epoch)
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

export interface SafeContext {
  /** Period bounds — analysis time window */
  periodStart: string; periodEnd: string;
  /** 1m bars (price source, also path verify) */
  bars1m: Bar[];
  /** Lower TF (signal evaluation) */
  bars15m: Bar[];
  durationMs15m: number;  // = 15 × 60_000
  /** Higher TFs (trend filter) */
  bars1h: Bar[];
  durationMs1h: number;   // = 60 × 60_000
  bars4h: Bar[];
  durationMs4h: number;   // = 240 × 60_000
  /** ts → idx for 15m bars */
  idxByTs15m: Map<number, number>;
}

export const D_15M = 15 * 60_000;
export const D_1H = 60 * 60_000;
export const D_4H = 240 * 60_000;

/**
 * 1m bars 파일 로드 (period 단위, BTC default 또는 alt symbol).
 */
export function loadBars1m(periodStart: string, periodEnd: string, symbol = 'BTCUSDT'): Bar[] | null {
  const fp = path.join(CACHE_DIR, `BINANCE_PERP_${symbol}_1m_${periodStart}_${periodEnd}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

/**
 * 1m bars → N-min bars 합성.
 * bucket ts = (Math.floor(b.ts / slot)) * slot — bucket START time.
 */
export function aggregateBars(bars1m: Bar[], minutes: number): Bar[] {
  const slot = minutes * 60_000;
  const buckets = new Map<number, Bar[]>();
  for (const b of bars1m) {
    const k = Math.floor(b.ts / slot) * slot;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(b);
  }
  const out: Bar[] = [];
  for (const [ts, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length === 0) continue;
    out.push({
      ts, date: new Date(ts + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' '),
      open: bs[0].open,
      high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)),
      close: bs[bs.length - 1].close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

/**
 * SafeContext 빌드.
 */
export function buildSafeContext(periodStart: string, periodEnd: string, symbol = 'BTCUSDT'): SafeContext | null {
  const bars1m = loadBars1m(periodStart, periodEnd, symbol);
  if (!bars1m) return null;
  const bars15m = aggregateBars(bars1m, 15);
  const bars1h = aggregateBars(bars1m, 60);
  const bars4h = aggregateBars(bars1m, 240);
  return {
    periodStart, periodEnd,
    bars1m, bars15m, bars1h, bars4h,
    durationMs15m: D_15M, durationMs1h: D_1H, durationMs4h: D_4H,
    idxByTs15m: new Map(bars15m.map((b, i) => [b.ts, i])),
  };
}

// ─────────────────────────────────────────────────────────────
// Lookahead-SAFE accessor primitives
// ─────────────────────────────────────────────────────────────

/**
 * "As-of ts" 시점에 알 수 있는 가장 최근 완전 종료된 higher bar.
 * Returns idx (or -1) of the latest bar where bar.ts + duration ≤ ts.
 */
export function latestClosedBarIdx(bars: Bar[], duration: number, ts: number): number {
  // Binary search would be ideal; linear from back is fine for small N
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].ts + duration <= ts) return i;
  }
  return -1;
}

/**
 * Signal evaluation: signal_ts of bars[i] = bars[i].ts + duration.
 * (Bar i가 완전히 close된 직후 시점)
 */
export function signalTs(bar: Bar, duration: number): number {
  return bar.ts + duration;
}

/**
 * Lookahead-safe Volume z-score for bar[i].
 * Uses bars[i - window ... i - 1] (signal bar 자체 미포함).
 *
 * 왜 i 미포함?
 *   i bar의 volume이 통계의 일부면, "현재 봉이 평균보다 큰가" 비교에서
 *   현재 봉 자체가 평균에 영향 줘서 비정상. 직전 N봉 기준 z-score가 더 정확.
 *   (다만 일부 backtest는 inclusive로 쓰기도 함 — 우리는 strict하게 exclusive)
 *
 * 단, signal at bar[i] = "bar[i]가 close된 직후 evaluation"이라 i의 volume도
 * 이미 알려진 값. inclusive도 lookahead 아님. 하지만 strict하게 exclusive로 통일.
 */
export function safeVolumeZ(bars: Bar[], i: number, window: number, inclusive = true): number | null {
  if (i < window) return null;
  const start = inclusive ? i - window + 1 : i - window;
  const end = inclusive ? i + 1 : i;
  if (start < 0 || end > bars.length) return null;
  const win = bars.slice(start, end).map((b) => b.volume);
  const m = win.reduce((s, v) => s + v, 0) / win.length;
  const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length;
  const std = Math.sqrt(v);
  const target = bars[i].volume;
  return std === 0 ? 0 : (target - m) / std;
}

/**
 * EMA — closes[0..i] 기반. ema[i] = bars[i] close 시점 값.
 * Standard implementation; no lookahead by construction.
 */
export function calcEMASafe(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;
  let sma = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = sma;
  const alpha = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    sma = closes[i] * alpha + sma * (1 - alpha);
    out[i] = sma;
  }
  return out;
}

/**
 * ATR (Wilder). closes/highs/lows[0..i] 기반.
 */
export function calcATRSafe(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) trs.push(highs[i] - lows[i]);
    else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      trs.push(Math.max(hl, hc, lc));
    }
  }
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Signal evaluation contract
// ─────────────────────────────────────────────────────────────

/**
 * Signal at bars[i] — evaluated at bars[i].ts + duration (= close 직후).
 * Returns the ts at which signal becomes actionable (= signal_ts).
 * Entry will be on next bar open (= bars[i+1].open) IF i+1 exists.
 */
export interface SafeSignal {
  /** signal generation time (bar i close 직후) */
  signalTs: number;
  /** bar i index in low TF */
  signalBarIdx: number;
  /** direction */
  direction: 'LONG' | 'SHORT';
}

// ─────────────────────────────────────────────────────────────
// Path verify (entry 이후 1m bars만)
// ─────────────────────────────────────────────────────────────

export interface Variant { name: string; tp: number; sl: number; maxMin: number; }
export interface ExitResult {
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number;
}

/**
 * 1m path verify. startIdx부터 시작, entry 이후 path만 검사.
 */
export function pathVerify(
  bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number,
  direction: 'LONG' | 'SHORT', v: Variant,
): ExitResult {
  const tpPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.tp / 100) : entryPriceRaw * (1 - v.tp / 100);
  const slPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.sl / 100) : entryPriceRaw * (1 - v.sl / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsed = (bar.ts - entryTs) / 60_000;
    if (direction === 'LONG') {
      if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl };
      if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp };
    } else {
      if (bar.high >= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: v.sl };
      if (bar.low <= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: v.tp };
    }
    if (elapsed >= v.maxMin) {
      const ret = direction === 'LONG'
        ? (bar.close - entryPriceRaw) / entryPriceRaw * 100
        : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG'
    ? (last.close - entryPriceRaw) / entryPriceRaw * 100
    : (entryPriceRaw - last.close) / entryPriceRaw * 100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret };
}

/**
 * 1m idx로 ts >= entryTs 인 가장 첫 bar 찾기 (binary search).
 */
export function find1mIdx(bars: Bar[], ts: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ─────────────────────────────────────────────────────────────
// Trade execution flow (SAFE 진입/청산)
// ─────────────────────────────────────────────────────────────

export interface Trade {
  direction: 'LONG' | 'SHORT';
  signalTs: number;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}

/**
 * SAFE 진입/청산 시뮬레이터.
 *
 * Contract:
 *   - signal_ts에서 알 수 있는 정보만 사용 (signalFn 책임).
 *   - entry는 next 15m bar의 open (signal_ts 이후 첫 가능 시점).
 *   - 1m path verify는 entry ts 이후만.
 *   - cooldown: 직전 exit_ts 이후만 다음 진입 가능.
 */
export function simulateSafe(
  ctx: SafeContext,
  signals: SafeSignal[],
  v: Variant,
  costRT: number,
  options?: { cooldownMs?: number },
): Trade[] {
  const trades: Trade[] = [];
  const cooldownMs = options?.cooldownMs ?? 0;
  let cooldownUntilTs = 0;
  for (const sig of signals) {
    if (sig.signalTs < cooldownUntilTs) continue;
    // Next 15m bar (entry bar)
    const entryBarIdx = sig.signalBarIdx + 1;
    if (entryBarIdx >= ctx.bars15m.length) continue;
    const entryBar15 = ctx.bars15m[entryBarIdx];
    if (entryBar15.ts < sig.signalTs) continue; // safety: must be future
    // Entry at next 15m bar open: find the 1m bar at that ts
    const start1mIdx = find1mIdx(ctx.bars1m, entryBar15.ts);
    if (start1mIdx >= ctx.bars1m.length) continue;
    const entry1mBar = ctx.bars1m[start1mIdx];
    const entryPriceRaw = entry1mBar.open;
    const exit = pathVerify(ctx.bars1m, start1mIdx, entry1mBar.ts, entryPriceRaw, sig.direction, v);
    const netRet = exit.rawReturnPct - costRT * 100;
    const monthKey = new Date(sig.signalTs + 9 * 3600_000).toISOString().slice(0, 7);
    trades.push({
      direction: sig.direction,
      signalTs: sig.signalTs,
      entryTs: entry1mBar.ts, entryPrice: entryPriceRaw,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey,
    });
    cooldownUntilTs = exit.exitTs + cooldownMs;
  }
  return trades;
}

// ─────────────────────────────────────────────────────────────
// Period filter
// ─────────────────────────────────────────────────────────────

export function inPeriod(ts: number, ctx: SafeContext): boolean {
  const d = new Date(ts + 9 * 3600_000).toISOString().slice(0, 10);
  return d >= ctx.periodStart && d <= ctx.periodEnd;
}

// ─────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────

export interface Stats {
  n: number; wr: number; avgWin: number; avgLoss: number;
  total: number; pf: number;
}
export function statsFor(trades: Trade[]): Stats {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, avgWin: 0, avgLoss: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const wr = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
  const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  return { n, wr, avgWin, avgLoss, total, pf };
}

// ─────────────────────────────────────────────────────────────
// 공용 formatting
// ─────────────────────────────────────────────────────────────

export function fmt(n: number, sign = true): string {
  return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
export function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
export function padS(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

export function monthList(start: string, end: string): string[] {
  const out: string[] = [];
  let y = parseInt(start.slice(0, 4)); let m = parseInt(start.slice(5, 7));
  const endY = parseInt(end.slice(0, 4)); const endM = parseInt(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${m.toString().padStart(2, '0')}`); m++;
    if (m > 12) { y++; m = 1; }
  }
  return out;
}
