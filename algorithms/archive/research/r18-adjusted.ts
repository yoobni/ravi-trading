/**
 * R18 ADJUSTED_VARIANTS — R17 원인 분석 후 변형 10가지.
 *
 * 원인:
 *   1. payoff ratio 약함 (1.5~2:1) → WR 40%로는 break-even 못 넘김
 *   2. avgWin ≈ avgLoss → 신호 방향 정보 없음
 *   3. cost 0.2%가 짧은 TP/SL 잡아먹음
 *
 * 조정 방향:
 *   A. payoff ratio 높이기 (3:1, 4:1)
 *   B. 알려진 알파 (funding) 결합
 *   C. 신호 confirmation 추가 (multi-bar)
 *   D. TF 변경 (1h entry로 noise 감소)
 *
 * 10가지 변형 × 3 modes (BOTH/LONG/SHORT) = 30 cells.
 * Data: Binance perp 1m / 15m / 1h / 4h (1년).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcEMA, calcATR } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
interface FundingPoint { ts: number; date: string; rate: number; }

function load(file: string): Bar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
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
      open: bs[0].open, high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)), close: bs[bs.length - 1].close,
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
interface ExitResult { exitTs: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; rawReturnPct: number; }
function pathVerify(bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number, direction: Direction, v: Variant): ExitResult {
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
      const ret = direction === 'LONG' ? (bar.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret };
    }
  }
  const last = bars1m[bars1m.length - 1];
  const ret = direction === 'LONG' ? (last.close - entryPriceRaw) / entryPriceRaw * 100 : (entryPriceRaw - last.close) / entryPriceRaw * 100;
  return { exitTs: last.ts, exitPrice: last.close, reason: 'TIME', rawReturnPct: ret };
}

function calcCCI(highs: number[], lows: number[], closes: number[], period = 20): (number | null)[] {
  const n = closes.length; const out: (number | null)[] = new Array(n).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period - 1; i < n; i++) {
    const win = tp.slice(i - period + 1, i + 1);
    const sma = win.reduce((s, v) => s + v, 0) / period;
    const md = win.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    out[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  return out;
}
function calcStochastic(highs: number[], lows: number[], closes: number[], kP = 14, dP = 3) {
  const n = closes.length; const k: (number | null)[] = new Array(n).fill(null);
  for (let i = kP - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kP + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kP + 1, i + 1));
    k[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
  }
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = kP + dP - 2; i < n; i++) {
    const win = k.slice(i - dP + 1, i + 1).filter((v): v is number => v != null);
    d[i] = win.length === dP ? win.reduce((s, v) => s + v, 0) / dP : null;
  }
  return { k, d };
}
function calcRollingVWAP(bars: Bar[], window = 48) {
  const n = bars.length;
  const vwap: (number | null)[] = new Array(n).fill(null);
  const std: (number | null)[] = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    const win = bars.slice(i - window + 1, i + 1);
    let pvSum = 0, vSum = 0;
    for (const b of win) { pvSum += b.close * b.volume; vSum += b.volume; }
    const w = vSum > 0 ? pvSum / vSum : null;
    vwap[i] = w;
    if (w != null) {
      const dev = win.map((b) => (b.close - w) ** 2);
      std[i] = Math.sqrt(dev.reduce((s, v) => s + v, 0) / win.length);
    }
  }
  return { vwap, std };
}

interface SignalEvent { ts: number; direction: Direction; }

interface SimContext {
  bars1m: Bar[];
  bars15m: Bar[];
  bars1h: Bar[];
  bars4h: Bar[];
  fundingDaily: Map<string, number>;
  ind15: {
    cci: (number|null)[];
    stochK: (number|null)[]; stochD: (number|null)[];
    vwap: (number|null)[]; vwapStd: (number|null)[];
    ema20: (number|null)[]; ema50: (number|null)[];
    atr: (number|null)[];
  };
  ind4h: { ema50: (number|null)[] };
  ind1h: { ema20: (number|null)[] };
}

function inAnalysis(ts: number): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ANALYSIS_START && d <= ANALYSIS_END;
}

// MTF_TREND_CONFIRM base signal (R17 best)
function mtfTrendSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const bars15 = ctx.bars15m;
  const bars4h = ctx.bars4h;
  function get4hTrend(ts: number): 1 | -1 | null {
    let idx = -1;
    for (let i = bars4h.length - 1; i >= 0; i--) if (bars4h[i].ts <= ts) { idx = i; break; }
    if (idx < 0) return null;
    const e = ctx.ind4h.ema50[idx]; if (e == null) return null;
    if (bars4h[idx].close > e) return 1;
    if (bars4h[idx].close < e) return -1;
    return null;
  }
  for (let i = 1; i < bars15.length; i++) {
    const trend = get4hTrend(bars15[i].ts);
    if (!trend) continue;
    const e = ctx.ind15.ema20[i], ep = ctx.ind15.ema20[i - 1]; if (e == null || ep == null) continue;
    const prev = bars15[i - 1], cur = bars15[i];
    if (trend === 1 && prev.close < ep && cur.close > e) out.push({ ts: cur.ts, direction: 'LONG' });
    if (trend === -1 && prev.close > ep && cur.close < e) out.push({ ts: cur.ts, direction: 'SHORT' });
  }
  return out;
}

function cciSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const cci = ctx.ind15.cci;
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const c = cci[i], p = cci[i - 1]; if (c == null || p == null) continue;
    if (p > -100 && c <= -100) out.push({ ts: ctx.bars15m[i].ts, direction: 'LONG' });
    if (p < 100 && c >= 100) out.push({ ts: ctx.bars15m[i].ts, direction: 'SHORT' });
  }
  return out;
}
function vwapDevSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const bars = ctx.bars15m; const v = ctx.ind15.vwap; const s = ctx.ind15.vwapStd;
  for (let i = 1; i < bars.length; i++) {
    const v2 = v[i], s2 = s[i], vp = v[i - 1], sp = s[i - 1];
    if (v2 == null || s2 == null || vp == null || sp == null) continue;
    const prev = bars[i - 1], cur = bars[i];
    if (prev.close > vp + 2 * sp && cur.close < v2 + 2 * s2) out.push({ ts: cur.ts, direction: 'SHORT' });
    if (prev.close < vp - 2 * sp && cur.close > v2 - 2 * s2) out.push({ ts: cur.ts, direction: 'LONG' });
  }
  return out;
}
function stochSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const k = ctx.ind15.stochK, d = ctx.ind15.stochD;
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const kP = k[i - 1], kC = k[i], dP = d[i - 1], dC = d[i];
    if (kP == null || kC == null || dP == null || dC == null) continue;
    if (kP < 20 && dP < 20 && kP < dP && kC > dC) out.push({ ts: ctx.bars15m[i].ts, direction: 'LONG' });
    if (kP > 80 && dP > 80 && kP > dP && kC < dC) out.push({ ts: ctx.bars15m[i].ts, direction: 'SHORT' });
  }
  return out;
}
function keltnerSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const bars = ctx.bars15m;
  for (let i = 20; i < bars.length; i++) {
    const e = ctx.ind15.ema20[i], a = ctx.ind15.atr[i];
    if (e == null || a == null) continue;
    const upper = e + 2 * a, lower = e - 2 * a;
    const prev = bars[i - 1], cur = bars[i];
    if (prev.close <= upper && cur.close > upper) out.push({ ts: cur.ts, direction: 'LONG' });
    if (prev.close >= lower && cur.close < lower) out.push({ ts: cur.ts, direction: 'SHORT' });
  }
  return out;
}
function rangeBreakVolSignals(ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const bars = ctx.bars15m;
  const W = 30;
  for (let i = 20; i < bars.length; i++) {
    const vols = bars.slice(i - W, i).map(b => b.volume);
    const m = vols.reduce((s, v) => s + v, 0) / W;
    const v = vols.reduce((s, x) => s + (x - m) ** 2, 0) / W;
    const std = Math.sqrt(v);
    const z = std === 0 ? 0 : (bars[i].volume - m) / std;
    if (z < 1.5) continue;
    const window = bars.slice(i - 20, i);
    const high20 = Math.max(...window.map(b => b.high));
    const low20 = Math.min(...window.map(b => b.low));
    if (bars[i].close > high20) out.push({ ts: bars[i].ts, direction: 'LONG' });
    if (bars[i].close < low20) out.push({ ts: bars[i].ts, direction: 'SHORT' });
  }
  return out;
}

// ───── 변형 함수들 ─────

// Filter: funding direction alignment (LONG signal when funding ≤ -0.001, SHORT signal when funding ≥ +0.001)
function filterFundingAlign(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  return signals.filter((s) => {
    const kstDate = new Date(s.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const yesterday = new Date(new Date(kstDate + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
    const yF = ctx.fundingDaily.get(yesterday);
    if (yF == null) return false;
    if (s.direction === 'LONG' && yF <= -0.001) return true;
    if (s.direction === 'SHORT' && yF >= 0.001) return true;
    return false;
  });
}

// Filter: multi-bar confirm (next 15m bar same direction as signal)
function filterMultiBarConfirm(signals: SignalEvent[], ctx: SimContext): SignalEvent[] {
  const out: SignalEvent[] = [];
  const barsByTs = new Map(ctx.bars15m.map((b, i) => [b.ts, i]));
  for (const s of signals) {
    const i = barsByTs.get(s.ts); if (i == null) continue;
    if (i + 1 >= ctx.bars15m.length) continue;
    const nextBar = ctx.bars15m[i + 1];
    const isGreen = nextBar.close > nextBar.open;
    if (s.direction === 'LONG' && isGreen) out.push({ ts: nextBar.ts, direction: s.direction });
    if (s.direction === 'SHORT' && !isGreen) out.push({ ts: nextBar.ts, direction: s.direction });
  }
  return out;
}

// ───── simulate ─────

interface Trade {
  rule: string; direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}
function statsFor(trades: Trade[]) {
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

function simulate(ctx: SimContext, signals: SignalEvent[], v: Variant, ruleName: string): Trade[] {
  const trades: Trade[] = [];
  let cooldownTs = 0;
  for (const sig of signals) {
    if (!inAnalysis(sig.ts)) continue;
    if (sig.ts < cooldownTs) continue;
    const nextSlotTs = Math.floor((sig.ts + 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    const startIdx = find1mIdx(ctx.bars1m, nextSlotTs);
    if (startIdx >= ctx.bars1m.length) continue;
    const entryBar = ctx.bars1m[startIdx];
    const exit = pathVerify(ctx.bars1m, startIdx, entryBar.ts, entryBar.open, sig.direction, v);
    const netRet = exit.rawReturnPct - COST_RT * 100;
    trades.push({
      rule: ruleName, direction: sig.direction,
      entryTs: entryBar.ts, entryPrice: entryBar.open,
      exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
      monthKey: new Date(sig.ts + 9 * 3600_000).toISOString().slice(0, 7),
    });
    cooldownTs = exit.exitTs;
  }
  return trades;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R18 ADJUSTED_VARIANTS ===\n`);
  const bars1m = load(`BINANCE_PERP_BTCUSDT_1m_${ANALYSIS_START}_${ANALYSIS_END}.json`);
  const bars15m = aggregate(bars1m, 15);
  const bars1h = aggregate(bars1m, 60);
  const bars4h = aggregate(bars1m, 240);
  console.log(`bars: 1m=${bars1m.length} 15m=${bars15m.length} 1h=${bars1h.length} 4h=${bars4h.length}`);

  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);

  const closes15 = bars15m.map(b => b.close);
  const stoch = calcStochastic(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15);
  const vw = calcRollingVWAP(bars15m, 48);
  const ctx: SimContext = {
    bars1m, bars15m, bars1h, bars4h, fundingDaily,
    ind15: {
      cci: calcCCI(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15, 20),
      stochK: stoch.k, stochD: stoch.d,
      vwap: vw.vwap, vwapStd: vw.std,
      ema20: calcEMA(closes15, 20),
      ema50: calcEMA(closes15, 50),
      atr: calcATR(bars15m.map(b => b.high), bars15m.map(b => b.low), closes15, 14),
    },
    ind4h: { ema50: calcEMA(bars4h.map(b => b.close), 50) },
    ind1h: { ema20: calcEMA(bars1h.map(b => b.close), 20) },
  };

  // ───── 10 변형 정의 ─────
  const baseSignals = {
    MTF: mtfTrendSignals(ctx),
    CCI: cciSignals(ctx),
    VWAP: vwapDevSignals(ctx),
    STOCH: stochSignals(ctx),
    KELT: keltnerSignals(ctx),
    RNGBV: rangeBreakVolSignals(ctx),
  };

  const variations: Array<{ id: string; signals: SignalEvent[]; variant: Variant; desc: string }> = [
    // 1. MTF + payoff 3:1
    { id: 'R18-1_MTF_P3:1', signals: baseSignals.MTF, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'MTF_TREND + payoff 3:1' },
    // 2. MTF + payoff 4:1
    { id: 'R18-2_MTF_P4:1', signals: baseSignals.MTF, variant: { name: 'TP4_SL1_24h', tp: 4.0, sl: -1.0, maxMin: 1440 }, desc: 'MTF_TREND + payoff 4:1' },
    // 3. MTF + funding alignment
    { id: 'R18-3_MTF_FUND', signals: filterFundingAlign(baseSignals.MTF, ctx), variant: { name: 'TP2_SL1.3_8h', tp: 2.0, sl: -1.3, maxMin: 480 }, desc: 'MTF + funding align' },
    // 4. MTF + multi-bar confirm
    { id: 'R18-4_MTF_CONF', signals: filterMultiBarConfirm(baseSignals.MTF, ctx), variant: { name: 'TP2_SL1.3_8h', tp: 2.0, sl: -1.3, maxMin: 480 }, desc: 'MTF + multi-bar confirm' },
    // 5. CCI + payoff 3:1
    { id: 'R18-5_CCI_P3:1', signals: baseSignals.CCI, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'CCI + payoff 3:1' },
    // 6. VWAP + payoff 3:1
    { id: 'R18-6_VWAP_P3:1', signals: baseSignals.VWAP, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'VWAP_DEV + payoff 3:1' },
    // 7. STOCH + payoff 3:1
    { id: 'R18-7_STOCH_P3:1', signals: baseSignals.STOCH, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'STOCHASTIC + payoff 3:1' },
    // 8. KELT + payoff 3:1
    { id: 'R18-8_KELT_P3:1', signals: baseSignals.KELT, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'KELTNER + payoff 3:1' },
    // 9. RANGE_BREAK_VOL + payoff 3:1
    { id: 'R18-9_RNG_P3:1', signals: baseSignals.RNGBV, variant: { name: 'TP3_SL1_12h', tp: 3.0, sl: -1.0, maxMin: 720 }, desc: 'RANGE_BREAK_VOL + payoff 3:1' },
    // 10. MTF + 1h entry (TF 변경)
    { id: 'R18-10_MTF_1h', signals: baseSignals.MTF.filter((_, i) => i % 4 === 0), variant: { name: 'TP2_SL1.3_8h', tp: 2.0, sl: -1.3, maxMin: 480 }, desc: 'MTF + 1h sampling (every 4th 15m signal)' },
  ];

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R18 ADJUSTED_VARIANTS — 10가지 조정`);
  L.push(`Period: ${ANALYSIS_START} ~ ${ANALYSIS_END}, Binance perp 1m path verify, cost RT 0.2%`);
  L.push('='.repeat(140));

  // ───── 결과 ─────
  L.push(`\n## 변형별 결과 (BOTH/LONG/SHORT)\n`);
  L.push(`${pad('id × mode', 30)} | ${pad('desc', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(135));

  for (const vr of variations) {
    for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
      const sigs = vr.signals.filter((s) => mode === 'BOTH' || (mode === 'LONG_ONLY' ? s.direction === 'LONG' : s.direction === 'SHORT'));
      const trades = simulate(ctx, sigs, vr.variant, vr.id);
      const s = statsFor(trades);
      L.push(`${pad(`${vr.id} ${mode}`, 30)} | ${pad(vr.desc, 36)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
    L.push('');
  }

  // PF 정렬 top 10
  L.push(`\n## PF 정렬 top 15 (n ≥ 10)\n`);
  interface CellRow { id: string; mode: string; desc: string; stats: ReturnType<typeof statsFor>; }
  const allCells: CellRow[] = [];
  for (const vr of variations) {
    for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
      const sigs = vr.signals.filter((s) => mode === 'BOTH' || (mode === 'LONG_ONLY' ? s.direction === 'LONG' : s.direction === 'SHORT'));
      const trades = simulate(ctx, sigs, vr.variant, vr.id);
      const s = statsFor(trades);
      allCells.push({ id: vr.id, mode, desc: vr.desc, stats: s });
    }
  }
  L.push(`${pad('id × mode', 30)} | ${pad('desc', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(110));
  const byPF = [...allCells].filter((c) => c.stats.n >= 10).sort((a, b) => b.stats.pf - a.stats.pf).slice(0, 15);
  for (const c of byPF) {
    L.push(`${pad(`${c.id} ${c.mode}`, 30)} | ${pad(c.desc, 36)} | ${padS(String(c.stats.n), 4)} | ${padS(c.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.stats.total), 8)} | ${padS(c.stats.pf.toFixed(2), 5)}`);
  }

  // Total 정렬
  L.push(`\n## Total 정렬 top 15 (n ≥ 10)\n`);
  L.push(`${pad('id × mode', 30)} | ${pad('desc', 36)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(110));
  const byTotal = [...allCells].filter((c) => c.stats.n >= 10).sort((a, b) => b.stats.total - a.stats.total).slice(0, 15);
  for (const c of byTotal) {
    L.push(`${pad(`${c.id} ${c.mode}`, 30)} | ${pad(c.desc, 36)} | ${padS(String(c.stats.n), 4)} | ${padS(c.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.stats.total), 8)} | ${padS(c.stats.pf.toFixed(2), 5)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R18_ADJUSTED.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
