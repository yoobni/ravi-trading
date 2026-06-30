/**
 * R15 BROAD_SWEEP — 다양한 entry rule × LONG/SHORT/BOTH sweep.
 *
 * Entry rules (15m bar 평가):
 *   1. RSI_30_70        : RSI<30 → LONG, RSI>70 → SHORT
 *   2. RSI_CROSS        : RSI cross 30↑ → LONG, 70↓ → SHORT
 *   3. BB_REJECT_OUT    : BB 밖 close 후 안으로 회복 (R13 비슷, mean reversion)
 *   4. BB_BREAK_OUT     : BB 밖으로 close (momentum) — break 방향 그대로
 *   5. EMA9_21_CROSS    : EMA9 EMA21 bullish cross → LONG, bearish → SHORT
 *   6. MACD_HIST_CROSS  : MACD histogram 양→음/음→양 cross
 *   7. PRICE_BREAKOUT   : 직전 20봉 high 돌파 → LONG, low 돌파 → SHORT
 *   8. PRICE_FAKEOUT    : 직전 20봉 high/low 돌파 후 다시 안으로 회복 → 역방향
 *   9. VOLUME_PRICE     : volume z-score > 2 + 가격 양봉 → LONG, 음봉 → SHORT
 *   10. BAR_STREAK_REV  : 5개 연속 양봉 → SHORT (mean revert), 5 연속 음봉 → LONG
 *
 * Variants: tight/medium/wide TP/SL
 * Direction: BOTH / LONG_ONLY / SHORT_ONLY
 *
 * 평가: 1년 (2025-06-09 ~ 2026-06-09), 1m path verify, cost 왕복 0.2%
 *
 * 출력: WR 정렬 top cells + PF 정렬 + total 정렬
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcRSI, calcEMA, calcBollingerBands, calcMACD } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_RT = 0.002;
const COOLDOWN_AFTER_EXIT = true;

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
type Direction = 'LONG' | 'SHORT';
interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const VARIANTS: Variant[] = [
  { name: 'T_TP0.5_SL0.3_2h',  tp: 0.5, sl: -0.3, maxMin: 120 },
  { name: 'M_TP1.0_SL0.7_4h',  tp: 1.0, sl: -0.7, maxMin: 240 },
  { name: 'W_TP2.0_SL1.3_8h',  tp: 2.0, sl: -1.3, maxMin: 480 },
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

interface SignalEvent { ts: number; direction: Direction; }
type SignalFn = (bars15m: Bar[], indicators: Indicators) => SignalEvent[];

interface Indicators {
  rsi14: (number | null)[];
  ema9: (number | null)[];
  ema21: (number | null)[];
  bb: { upper: (number|null)[]; middle: (number|null)[]; lower: (number|null)[] };
  macd: { macd: (number|null)[]; signal: (number|null)[]; histogram: (number|null)[] };
}

function inAnalysis(ts: number): boolean {
  const d = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return d >= ANALYSIS_START && d <= ANALYSIS_END;
}

const SIGNAL_RULES: { name: string; fn: SignalFn }[] = [
  // 1. RSI_30_70 (level cross)
  { name: 'RSI_30_70', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const r = ind.rsi14[i]; const p = ind.rsi14[i - 1];
      if (r == null || p == null) continue;
      if (p >= 30 && r < 30) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (p <= 70 && r > 70) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 2. RSI_CROSS (out of oversold/overbought)
  { name: 'RSI_CROSS', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const r = ind.rsi14[i]; const p = ind.rsi14[i - 1];
      if (r == null || p == null) continue;
      if (p < 30 && r >= 30) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (p > 70 && r <= 70) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 3. BB_REJECT_OUT (mean reversion)
  { name: 'BB_REJECT_OUT', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const u = ind.bb.upper[i], l = ind.bb.lower[i];
      const up = ind.bb.upper[i - 1], lp = ind.bb.lower[i - 1];
      if (u == null || l == null || up == null || lp == null) continue;
      const prev = bars[i - 1], cur = bars[i];
      if (prev.close > up && cur.close < u) out.push({ ts: cur.ts, direction: 'SHORT' });
      if (prev.close < lp && cur.close > l) out.push({ ts: cur.ts, direction: 'LONG' });
    }
    return out;
  }},
  // 4. BB_BREAK_OUT (momentum)
  { name: 'BB_BREAK_OUT', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const u = ind.bb.upper[i], l = ind.bb.lower[i];
      if (u == null || l == null) continue;
      const prev = bars[i - 1], cur = bars[i];
      if (prev.close <= u && cur.close > u) out.push({ ts: cur.ts, direction: 'LONG' });
      if (prev.close >= l && cur.close < l) out.push({ ts: cur.ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 5. EMA9_21_CROSS
  { name: 'EMA9_21_CROSS', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const e9 = ind.ema9[i], e21 = ind.ema21[i];
      const e9p = ind.ema9[i - 1], e21p = ind.ema21[i - 1];
      if (e9 == null || e21 == null || e9p == null || e21p == null) continue;
      if (e9p <= e21p && e9 > e21) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (e9p >= e21p && e9 < e21) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 6. MACD_HIST_CROSS
  { name: 'MACD_HIST_CROSS', fn: (bars, ind) => {
    const out: SignalEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const h = ind.macd.histogram[i], hp = ind.macd.histogram[i - 1];
      if (h == null || hp == null) continue;
      if (hp <= 0 && h > 0) out.push({ ts: bars[i].ts, direction: 'LONG' });
      if (hp >= 0 && h < 0) out.push({ ts: bars[i].ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 7. PRICE_BREAKOUT (20-bar high/low)
  { name: 'PRICE_BREAKOUT', fn: (bars) => {
    const out: SignalEvent[] = [];
    for (let i = 20; i < bars.length; i++) {
      const window = bars.slice(i - 20, i);
      const high20 = Math.max(...window.map((b) => b.high));
      const low20 = Math.min(...window.map((b) => b.low));
      const cur = bars[i];
      if (cur.close > high20) out.push({ ts: cur.ts, direction: 'LONG' });
      if (cur.close < low20) out.push({ ts: cur.ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 8. PRICE_FAKEOUT (breakout + 회복)
  { name: 'PRICE_FAKEOUT', fn: (bars) => {
    const out: SignalEvent[] = [];
    for (let i = 21; i < bars.length; i++) {
      const window = bars.slice(i - 21, i - 1);
      const high20 = Math.max(...window.map((b) => b.high));
      const low20 = Math.min(...window.map((b) => b.low));
      const prev = bars[i - 1], cur = bars[i];
      // 직전 봉이 break, 현재 봉이 회복
      if (prev.close > high20 && cur.close < high20) out.push({ ts: cur.ts, direction: 'SHORT' });
      if (prev.close < low20 && cur.close > low20) out.push({ ts: cur.ts, direction: 'LONG' });
    }
    return out;
  }},
  // 9. VOLUME_PRICE (volume z-score + 가격 방향)
  { name: 'VOLUME_PRICE', fn: (bars) => {
    const out: SignalEvent[] = [];
    const W = 30;
    for (let i = W; i < bars.length; i++) {
      const win = bars.slice(i - W, i).map((b) => b.volume);
      const m = win.reduce((s, v) => s + v, 0) / W;
      const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / W;
      const std = Math.sqrt(v);
      const z = std === 0 ? 0 : (bars[i].volume - m) / std;
      if (z < 2) continue;
      const cur = bars[i];
      if (cur.close > cur.open) out.push({ ts: cur.ts, direction: 'LONG' });
      else if (cur.close < cur.open) out.push({ ts: cur.ts, direction: 'SHORT' });
    }
    return out;
  }},
  // 10. BAR_STREAK_REV (5 연속 양봉 → SHORT, 5 연속 음봉 → LONG)
  { name: 'BAR_STREAK_REV', fn: (bars) => {
    const out: SignalEvent[] = [];
    for (let i = 5; i < bars.length; i++) {
      const lastFive = bars.slice(i - 5, i);
      if (lastFive.every((b) => b.close > b.open)) out.push({ ts: bars[i].ts, direction: 'SHORT' });
      else if (lastFive.every((b) => b.close < b.open)) out.push({ ts: bars[i].ts, direction: 'LONG' });
    }
    return out;
  }},
];

interface Trade {
  rule: string; direction: Direction;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}
interface CellResult {
  rule: string; variant: string; mode: 'BOTH' | 'LONG_ONLY' | 'SHORT_ONLY';
  n: number; wr: number; avgWin: number; avgLoss: number; total: number; pf: number;
}

function statsFor(trades: Trade[]): { n: number; wr: number; avgWin: number; avgLoss: number; total: number; pf: number } {
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

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R15 BROAD_SWEEP ===\n`);
  const bars1m = loadBtc1m();
  const bars15m = aggregate(bars1m, 15);
  console.log(`1m=${bars1m.length}, 15m=${bars15m.length}`);

  const closes = bars15m.map((b) => b.close);
  const ind: Indicators = {
    rsi14: calcRSI(closes, 14).values,
    ema9: calcEMA(closes, 9),
    ema21: calcEMA(closes, 21),
    bb: calcBollingerBands(closes, 20, 2),
    macd: calcMACD(closes, 12, 26, 9),
  };

  // 각 rule × variant × direction simulate
  const allCells: CellResult[] = [];
  for (const rule of SIGNAL_RULES) {
    const signals = rule.fn(bars15m, ind).filter((s) => inAnalysis(s.ts));
    for (const v of VARIANTS) {
      // simulate per direction mode
      for (const mode of ['BOTH', 'LONG_ONLY', 'SHORT_ONLY'] as const) {
        const trades: Trade[] = [];
        let cooldownTs = 0;
        for (const sig of signals) {
          if (mode === 'LONG_ONLY' && sig.direction !== 'LONG') continue;
          if (mode === 'SHORT_ONLY' && sig.direction !== 'SHORT') continue;
          if (COOLDOWN_AFTER_EXIT && sig.ts < cooldownTs) continue;
          // 다음 15m 시초가 진입
          const nextSlotTs = Math.floor((sig.ts + 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
          const startIdx = find1mIdx(bars1m, nextSlotTs);
          if (startIdx >= bars1m.length) continue;
          const entryBar = bars1m[startIdx];
          const exit = pathVerify(bars1m, startIdx, entryBar.ts, entryBar.open, sig.direction, v);
          const netRet = exit.rawReturnPct - COST_RT * 100;
          trades.push({
            rule: rule.name, direction: sig.direction,
            entryTs: entryBar.ts, entryPrice: entryBar.open,
            exitTs: exit.exitTs, exitPrice: exit.exitPrice, reason: exit.reason,
            rawReturnPct: exit.rawReturnPct, netReturnPct: netRet,
            monthKey: new Date(sig.ts + 9 * 3600_000).toISOString().slice(0, 7),
          });
          cooldownTs = exit.exitTs;
        }
        const s = statsFor(trades);
        allCells.push({ rule: rule.name, variant: v.name, mode, ...s });
      }
    }
  }

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R15 BROAD_SWEEP — ${SIGNAL_RULES.length} rules × ${VARIANTS.length} variants × 3 modes = ${allCells.length} cells`);
  L.push(`Period: ${ANALYSIS_START} ~ ${ANALYSIS_END} | 1m path verify | cost 왕복 ${(COST_RT*100).toFixed(1)}%`);
  L.push('='.repeat(150));

  // 1. WR 정렬 top (n >= 20 만)
  L.push(`\n## WR 정렬 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byWR = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.wr - a.wr).slice(0, 30);
  for (const c of byWR) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  // 2. PF 정렬
  L.push(`\n\n## PF 정렬 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byPF = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.pf - a.pf).slice(0, 30);
  for (const c of byPF) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  // 3. Total 정렬
  L.push(`\n\n## Total return 정렬 (n ≥ 20)\n`);
  L.push(`${pad('rule × variant × mode', 45)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(100));
  const byTotal = [...allCells].filter((c) => c.n >= 20).sort((a, b) => b.total - a.total).slice(0, 30);
  for (const c of byTotal) {
    L.push(`${pad(`${c.rule} ${c.variant} ${c.mode}`, 45)} | ${padS(String(c.n), 4)} | ${padS(c.wr.toFixed(0)+'%', 5)} | ${padS(fmt(c.avgWin), 7)} | ${padS(fmt(c.avgLoss), 7)} | ${padS(fmt(c.total), 8)} | ${padS(c.pf.toFixed(2), 5)}`);
  }

  // 4. 룰별 mode 효과 (LONG vs SHORT 비대칭)
  L.push(`\n\n## 룰별 mode 효과 (best variant per cell)\n`);
  L.push(`${pad('rule', 18)} | ${padS('BOTH PF', 8)} | ${padS('LONG PF', 8)} | ${padS('SHORT PF', 8)} | ${padS('BOTH WR', 8)} | ${padS('LONG WR', 8)} | ${padS('SHORT WR', 8)}`);
  L.push('-'.repeat(95));
  for (const rule of SIGNAL_RULES) {
    const cells = allCells.filter((c) => c.rule === rule.name);
    function bestBy(mode: 'BOTH' | 'LONG_ONLY' | 'SHORT_ONLY'): CellResult | null {
      const rs = cells.filter((c) => c.mode === mode && c.n >= 5);
      if (rs.length === 0) return null;
      return rs.sort((a, b) => b.pf - a.pf)[0];
    }
    const both = bestBy('BOTH');
    const long = bestBy('LONG_ONLY');
    const short = bestBy('SHORT_ONLY');
    L.push(`${pad(rule.name, 18)} | ${padS(both?.pf.toFixed(2) ?? '-', 8)} | ${padS(long?.pf.toFixed(2) ?? '-', 8)} | ${padS(short?.pf.toFixed(2) ?? '-', 8)} | ${padS((both?.wr.toFixed(0) ?? '-') + '%', 8)} | ${padS((long?.wr.toFixed(0) ?? '-') + '%', 8)} | ${padS((short?.wr.toFixed(0) ?? '-') + '%', 8)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R15_BROAD_SWEEP.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
