/**
 * R30-11 — V1/V2/W1 알파 source 분해.
 *
 * 라비 질문: "코인을 정확히 가려내면 좋은건지, 장 흐름을 읽는게 좋은건지, 거래량인지"
 *
 * 각 strategy 분석:
 *   1. 코인별 PnL 기여 + top-1/3 제거 시 PF
 *   2. BTC regime (bull/neutral/bear)별 trades & PF
 *   3. Vol z 분위 (low/mid/high)별 trades & PF
 *   4. 월별 cumulative PnL curve
 *
 * Period: 2025-06-10 ~ 2026-06-10 (R30-9와 동일, 통과 4/4였던 시기)
 * Pool: 10 coins (V1/V2) + 4 coins (W1)
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
const COINS_10 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH'];
const COINS_4  = ['ETH','SOL','DOT','LINK'];

function loadBars(coin: string): CachedBar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_${UNIT}m_${FROM}_${TO}.json`), 'utf-8'));
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

interface Trade {
  coin: string;
  entryTs: number; exitTs: number;
  entryPrice: number; exitPrice: number;
  rawRet: number; netRet: number;
  reason: 'TP'|'SL'|'TIME';
  holdBars: number;
  volZ: number;
  monthKey: string;
  btcRegime: 'bull'|'neutral'|'bear';
}

function simulateStandalone(
  bars: CachedBar[], coin: string,
  signals: { barIdx: number; ts: number; volZ: number }[],
  tp: number, sl: number, maxBars: number,
  btcByDate: Map<string, { close: number; ema50: number | null }>,
): Trade[] {
  const out: Trade[] = [];
  for (const sig of signals) {
    const entryIdx = sig.barIdx + 1;
    if (entryIdx >= bars.length) continue;
    const entry = bars[entryIdx];
    const tpP = entry.open * (1 + tp / 100);
    const slP = entry.open * (1 + sl / 100);
    let exitIdx = -1, rawRet = 0, reason: Trade['reason'] = 'TIME';
    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + maxBars); j++) {
      const b = bars[j];
      if (b.low <= slP) { exitIdx = j; rawRet = sl; reason = 'SL'; break; }
      if (b.high >= tpP) { exitIdx = j; rawRet = tp; reason = 'TP'; break; }
    }
    if (exitIdx < 0) {
      const last = Math.min(bars.length - 1, entryIdx + maxBars - 1);
      exitIdx = last;
      rawRet = (bars[last].close - entry.open) / entry.open * 100;
      reason = 'TIME';
    }
    const netRet = rawRet - COST_RT * 100;
    const entryDate = new Date(entry.ts + 9 * 3600_000);
    const dateStr = entryDate.toISOString().slice(0, 10);
    const prevDateStr = new Date(entry.ts + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
    const monthKey = dateStr.slice(0, 7);
    const btc = btcByDate.get(prevDateStr) || btcByDate.get(dateStr);
    let btcRegime: Trade['btcRegime'] = 'neutral';
    if (btc && btc.ema50 != null) {
      const diff = (btc.close - btc.ema50) / btc.ema50 * 100;
      if (diff > 2) btcRegime = 'bull';
      else if (diff < -2) btcRegime = 'bear';
    }
    out.push({
      coin, entryTs: entry.ts, exitTs: bars[exitIdx].ts,
      entryPrice: entry.open,
      exitPrice: reason === 'TP' ? tpP : reason === 'SL' ? slP : bars[exitIdx].close,
      rawRet, netRet, reason,
      holdBars: exitIdx - entryIdx + 1,
      volZ: sig.volZ, monthKey, btcRegime,
    });
  }
  return out;
}

function sigV1(bars: CachedBar[]): { barIdx: number; ts: number; volZ: number }[] {
  // BB30/lb100/sm1.5/vz1.0
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 30, 2);
  const lookback = 100, squeezeMult = 1.5;
  const out: { barIdx: number; ts: number; volZ: number }[] = [];
  for (let i = Math.max(30, lookback) + 1; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - lookback; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    if (bb.width[i]! > minWidth * squeezeMult) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}
function sigV2(bars: CachedBar[]): { barIdx: number; ts: number; volZ: number }[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 30, 2);
  const lookback = 50, squeezeMult = 1.05;
  const out: { barIdx: number; ts: number; volZ: number }[] = [];
  for (let i = Math.max(30, lookback) + 1; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - lookback; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    if (bb.width[i]! > minWidth * squeezeMult) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}
function sigW1(bars: CachedBar[]): { barIdx: number; ts: number; volZ: number }[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 168;
  const out: { barIdx: number; ts: number; volZ: number }[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i-1].close <= prevMax && bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
      out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
    }
  }
  return out;
}

function statsFor(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0 };
  const wins = trades.filter(t => t.netRet > 0);
  const losses = trades.filter(t => t.netRet <= 0);
  const wr = wins.length / n * 100;
  const total = trades.reduce((s, t) => s + t.netRet, 0);
  const winSum = wins.reduce((s, t) => s + t.netRet, 0);
  const lossSum = Math.abs(losses.reduce((s, t) => s + t.netRet, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n, wr, total, pf };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-11 알파 source 분해 ===\n`);

  // Load bars (10 coins; W1는 4 coin만 subset)
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS_10) barsByCoin.set(coin, loadBars(coin));

  // BTC daily for regime
  const btcBars = barsByCoin.get('BTC')!;
  const btcDaily = new Map<string, { open: number; high: number; low: number; close: number }>();
  for (const b of btcBars) {
    const date = new Date(b.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const d = btcDaily.get(date);
    if (!d) btcDaily.set(date, { open: b.open, high: b.high, low: b.low, close: b.close });
    else { d.high = Math.max(d.high, b.high); d.low = Math.min(d.low, b.low); d.close = b.close; }
  }
  const dailyArr = [...btcDaily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyCloses = dailyArr.map(([, d]) => d.close);
  const dailyEma50 = calcEMA(dailyCloses, 50);
  const btcByDate = new Map<string, { close: number; ema50: number | null }>();
  for (let i = 0; i < dailyArr.length; i++) {
    btcByDate.set(dailyArr[i][0], { close: dailyArr[i][1].close, ema50: dailyEma50[i] });
  }

  // Build trades
  const strategies: { name: string; trades: Trade[]; tp: number; sl: number; maxBars: number }[] = [];
  for (const [name, sigFn, pool, tp, sl, maxBars] of [
    ['V1 VOL_EXP_A', sigV1, COINS_10, 3, -1.5, 168],
    ['V2 VOL_EXP_B', sigV2, COINS_10, 7, -2.5, 336],
    ['W1 WEEK_HIGH', sigW1, COINS_4,  5, -2,   336],
  ] as const) {
    const all: Trade[] = [];
    for (const coin of pool) {
      const bars = barsByCoin.get(coin)!;
      const sigs = sigFn(bars);
      const tr = simulateStandalone(bars, coin, sigs, tp, sl, maxBars, btcByDate);
      for (const t of tr) all.push(t);
    }
    strategies.push({ name, trades: all, tp, sl, maxBars });
  }

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R30-11 — V1/V2/W1 알파 source 분해 (1년 standalone analysis, no portfolio)`);
  L.push(`Period ${FROM} ~ ${TO}. 코인 풀: V1/V2 = 10코인, W1 = 4코인 (ETH/SOL/DOT/LINK).`);
  L.push(`주의: 1 trade = 1 진입 가정 (cash/position size 무관). PnL은 trade return 합산.`);
  L.push('='.repeat(150));

  // 1. 종합
  L.push(`\n## 1) 종합 (코인 풀 전체)\n`);
  L.push(`${pad('strategy', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | TP/SL/TIME`);
  L.push('-'.repeat(75));
  for (const s of strategies) {
    const st = statsFor(s.trades);
    const tp = s.trades.filter(t => t.reason === 'TP').length;
    const sl = s.trades.filter(t => t.reason === 'SL').length;
    const tm = s.trades.filter(t => t.reason === 'TIME').length;
    L.push(`${pad(s.name, 16)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(st.pf.toFixed(2), 5)} | ${tp}/${sl}/${tm}`);
  }

  // 2. 코인별 PnL 기여
  L.push(`\n## 2) 코인 의존도 (코인별 PnL 기여, %는 strategy total 대비)\n`);
  for (const s of strategies) {
    L.push(`\n### ${s.name}`);
    L.push(`${pad('coin', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('share', 7)}`);
    L.push('-'.repeat(60));
    const stTotal = statsFor(s.trades).total;
    const byCoin = new Map<string, Trade[]>();
    for (const t of s.trades) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
      byCoin.get(t.coin)!.push(t);
    }
    const coinRows = [...byCoin.entries()].map(([coin, trs]) => ({ coin, st: statsFor(trs) }));
    coinRows.sort((a, b) => b.st.total - a.st.total);
    for (const r of coinRows) {
      const share = stTotal !== 0 ? r.st.total / stTotal * 100 : 0;
      L.push(`${pad(r.coin, 6)} | ${padS(String(r.st.n), 4)} | ${padS(r.st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.st.total), 9)} | ${padS(r.st.pf.toFixed(2), 5)} | ${padS(share.toFixed(0)+'%', 7)}`);
    }

    // top-1 / top-3 제거
    const sortedByTotal = [...coinRows].sort((a, b) => b.st.total - a.st.total);
    for (const topN of [1, 3]) {
      const remove = new Set(sortedByTotal.slice(0, topN).map(r => r.coin));
      const filtered = s.trades.filter(t => !remove.has(t.coin));
      const st = statsFor(filtered);
      L.push(`  → top-${topN} 코인 (${[...remove].join(', ')}) 제거 시: n=${st.n}, WR=${st.wr.toFixed(0)}%, total=${fmt(st.total)}, PF=${st.pf.toFixed(2)}`);
    }
  }

  // 3. BTC regime
  L.push(`\n## 3) 장 흐름 의존도 (BTC daily close vs EMA50)\n`);
  for (const s of strategies) {
    L.push(`\n### ${s.name}`);
    L.push(`${pad('regime', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('avg/trade', 9)}`);
    L.push('-'.repeat(60));
    for (const reg of ['bull','neutral','bear'] as const) {
      const sub = s.trades.filter(t => t.btcRegime === reg);
      const st = statsFor(sub);
      const avg = st.n ? st.total / st.n : 0;
      L.push(`${pad(reg, 10)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(st.pf.toFixed(2), 5)} | ${padS(fmt(avg, false), 9)}`);
    }
  }

  // 4. Vol z 분위
  L.push(`\n## 4) 거래량 의존도 (vol z 분위별)\n`);
  for (const s of strategies) {
    L.push(`\n### ${s.name}`);
    L.push(`${pad('vol z', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('avg/trade', 9)}`);
    L.push('-'.repeat(60));
    const buckets = [
      { name: '1.0~1.5', lo: 1.0, hi: 1.5 },
      { name: '1.5~2.0', lo: 1.5, hi: 2.0 },
      { name: '2.0~3.0', lo: 2.0, hi: 3.0 },
      { name: '3.0+',    lo: 3.0, hi: 999 },
    ];
    for (const b of buckets) {
      const sub = s.trades.filter(t => t.volZ >= b.lo && t.volZ < b.hi);
      const st = statsFor(sub);
      const avg = st.n ? st.total / st.n : 0;
      L.push(`${pad(b.name, 12)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(st.pf.toFixed(2), 5)} | ${padS(fmt(avg, false), 9)}`);
    }
  }

  // 5. 월별 cumulative PnL
  L.push(`\n## 5) 시기 의존도 (월별 PnL + cumulative)\n`);
  for (const s of strategies) {
    L.push(`\n### ${s.name}`);
    L.push(`${pad('month', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('monthRet', 9)} | ${padS('cumRet', 9)} | ${padS('PF', 5)}`);
    L.push('-'.repeat(65));
    const byMonth = new Map<string, Trade[]>();
    for (const t of s.trades) {
      if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
      byMonth.get(t.monthKey)!.push(t);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    for (const m of months) {
      const sub = byMonth.get(m)!;
      const st = statsFor(sub);
      cum += st.total;
      L.push(`${pad(m, 10)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(fmt(cum), 9)} | ${padS(st.pf.toFixed(2), 5)}`);
    }
  }

  // 6. 진단 요약
  L.push(`\n\n## 6) 진단 요약 — 각 strategy의 알파 source\n`);
  for (const s of strategies) {
    const allSt = statsFor(s.trades);
    const stTotal = allSt.total;
    const byCoin = new Map<string, Trade[]>();
    for (const t of s.trades) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
      byCoin.get(t.coin)!.push(t);
    }
    const coinRows = [...byCoin.entries()].map(([coin, trs]) => ({ coin, st: statsFor(trs) }));
    const sortedByTotal = [...coinRows].sort((a, b) => b.st.total - a.st.total);
    const top1 = sortedByTotal[0];
    const top3Share = sortedByTotal.slice(0, 3).reduce((s, r) => s + r.st.total, 0) / stTotal * 100;

    const bull = s.trades.filter(t => t.btcRegime === 'bull');
    const bear = s.trades.filter(t => t.btcRegime === 'bear');
    const bullPF = statsFor(bull).pf;
    const bearPF = statsFor(bear).pf;

    const highZ = s.trades.filter(t => t.volZ >= 2.0);
    const lowZ = s.trades.filter(t => t.volZ < 2.0);
    const highZPF = statsFor(highZ).pf;
    const lowZPF = statsFor(lowZ).pf;

    L.push(`\n### ${s.name}`);
    L.push(`  - n=${allSt.n}, totalRet ${fmt(allSt.total)}, PF ${allSt.pf.toFixed(2)}`);
    L.push(`  - 코인 의존: top-1 ${top1.coin} (${(top1.st.total/stTotal*100).toFixed(0)}% 기여), top-3 합 ${top3Share.toFixed(0)}%`);
    L.push(`  - 장 의존: bull PF ${bullPF.toFixed(2)} vs bear PF ${bearPF.toFixed(2)} (ratio ${bearPF > 0 ? (bullPF / bearPF).toFixed(1) : '∞'}x)`);
    L.push(`  - 거래량 의존: high z(≥2) PF ${highZPF.toFixed(2)} vs low z(<2) PF ${lowZPF.toFixed(2)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-11_SOURCE.txt`), L.join('\n'));
  process.exit(0);
})();
