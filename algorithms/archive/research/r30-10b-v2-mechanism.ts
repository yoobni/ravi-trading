/**
 * R30-10B — V2 메커니즘 분해.
 *
 * V2 룰: BB30/lb50/sm1.05/vz1.0 + TP+7%/SL-2.5%/MAX 14d
 *
 * 각 trade entry 시점 분석:
 *   - 코인
 *   - BTC 추세 (EMA50 above/below)
 *   - BTC ATR % (시장 변동성)
 *   - 진입 시간대 (요일, 시간 KST)
 *   - BB width / min width ratio (squeeze 강도)
 *   - Vol z 값
 *   - 결과 (TP/SL/TIME) + holdBars
 *
 * 출력:
 *   - 월별 trade 분포 + WR
 *   - 코인별 분포 + WR
 *   - BTC regime별 (bull/bear/neutral) WR
 *   - 시간대별 WR
 *   - 어떤 환경에서 V2 작동하는지
 *
 * Period: 2025-06-10 ~ 2026-06-10 (R30-9와 동일)
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
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH'];
const COST_RT = 0.001;
const TP_PCT = 7.0;
const SL_PCT = -2.5;
const MAX_BARS = 336;

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
function calcATR(highs: number[], lows: number[], closes: number[], period = 14): (number|null)[] {
  const tr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let atr: number | null = null; let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { sum += tr[i]; continue; }
    if (atr === null) { sum += tr[i]; atr = sum / period; }
    else atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
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

interface DetailedTrade {
  coin: string;
  signalTs: number;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  reason: 'TP'|'SL'|'TIME'|'END';
  rawRet: number; netRet: number;
  holdBars: number;
  // 분석용 메타
  monthKey: string;       // YYYY-MM
  weekday: number;        // 0=Sun, 6=Sat (KST)
  hour: number;           // 0-23 KST
  btcRegime: 'bull'|'bear'|'neutral'; // BTC daily EMA50 above/below at entry
  btcAtrPct: number;      // BTC daily ATR / close * 100 (at entry)
  bbWidthRatio: number;   // width / minWidth (squeeze tightness, lower=tighter)
  volZ: number;
}

function v2Signals(bars: CachedBar[], coin: string): { sigBarIdx: number; ts: number; bbWidthRatio: number; volZ: number; }[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 30, 2);
  const lookback = 50;
  const squeezeMult = 1.05;
  const volZThresh = 1.0;
  const out: { sigBarIdx: number; ts: number; bbWidthRatio: number; volZ: number; }[] = [];
  for (let i = Math.max(30, lookback) + 1; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - lookback; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    if (bb.width[i]! > minWidth * squeezeMult) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZThresh) continue;
    out.push({ sigBarIdx: i, ts: bars[i].ts, bbWidthRatio: bb.width[i]! / minWidth, volZ: z });
  }
  return out;
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-10B V2 메커니즘 분해 ===\n`);

  // Load all bars
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  // Build BTC daily aggregation for regime/ATR analysis
  const btcBars = barsByCoin.get('BTC')!;
  const btcDaily = new Map<string, { open: number; high: number; low: number; close: number }>();
  for (const b of btcBars) {
    const date = new Date(b.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const d = btcDaily.get(date);
    if (!d) btcDaily.set(date, { open: b.open, high: b.high, low: b.low, close: b.close });
    else {
      d.high = Math.max(d.high, b.high);
      d.low = Math.min(d.low, b.low);
      d.close = b.close;
    }
  }
  const dailyArr = [...btcDaily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyCloses = dailyArr.map(([, d]) => d.close);
  const dailyHighs = dailyArr.map(([, d]) => d.high);
  const dailyLows = dailyArr.map(([, d]) => d.low);
  const dailyEma50 = calcEMA(dailyCloses, 50);
  const dailyAtr14 = calcATR(dailyHighs, dailyLows, dailyCloses, 14);
  const btcByDate = new Map<string, { close: number; ema50: number | null; atr: number | null; idx: number }>();
  for (let i = 0; i < dailyArr.length; i++) {
    btcByDate.set(dailyArr[i][0], { close: dailyArr[i][1].close, ema50: dailyEma50[i], atr: dailyAtr14[i], idx: i });
  }

  // Build trades
  const trades: DetailedTrade[] = [];
  for (const coin of COINS) {
    const bars = barsByCoin.get(coin)!;
    const sigs = v2Signals(bars, coin);
    for (const sig of sigs) {
      const entryIdx = sig.sigBarIdx + 1;
      if (entryIdx >= bars.length) continue;
      const entry = bars[entryIdx];
      const tp = entry.open * (1 + TP_PCT / 100);
      const sl = entry.open * (1 + SL_PCT / 100);
      let exitIdx = -1, rawRet = 0, reason: DetailedTrade['reason'] = 'TIME';
      for (let j = entryIdx; j < Math.min(bars.length, entryIdx + MAX_BARS); j++) {
        const b = bars[j];
        if (b.low <= sl) { exitIdx = j; rawRet = SL_PCT; reason = 'SL'; break; }
        if (b.high >= tp) { exitIdx = j; rawRet = TP_PCT; reason = 'TP'; break; }
      }
      if (exitIdx < 0) {
        const last = Math.min(bars.length - 1, entryIdx + MAX_BARS - 1);
        exitIdx = last;
        rawRet = (bars[last].close - entry.open) / entry.open * 100;
        reason = 'TIME';
      }
      const netRet = rawRet - COST_RT * 100;
      // Meta
      const entryDate = new Date(entry.ts + 9 * 3600_000);
      const dateStr = entryDate.toISOString().slice(0, 10);
      const monthKey = entryDate.toISOString().slice(0, 7);
      const weekday = entryDate.getUTCDay();
      const hour = entryDate.getUTCHours();
      // BTC regime: D-1 daily close vs ema50
      const dPrev = new Date(entry.ts + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
      const btc = btcByDate.get(dPrev) || btcByDate.get(dateStr);
      let btcRegime: DetailedTrade['btcRegime'] = 'neutral';
      let btcAtrPct = 0;
      if (btc && btc.ema50 != null) {
        const diff = (btc.close - btc.ema50) / btc.ema50 * 100;
        if (diff > 2) btcRegime = 'bull';
        else if (diff < -2) btcRegime = 'bear';
        else btcRegime = 'neutral';
        if (btc.atr != null) btcAtrPct = btc.atr / btc.close * 100;
      }
      trades.push({
        coin, signalTs: sig.ts, entryTs: entry.ts, entryPrice: entry.open,
        exitTs: bars[exitIdx].ts, exitPrice: reason === 'TP' ? tp : reason === 'SL' ? sl : bars[exitIdx].close,
        reason, rawRet, netRet, holdBars: exitIdx - entryIdx + 1,
        monthKey, weekday, hour, btcRegime, btcAtrPct,
        bbWidthRatio: sig.bbWidthRatio, volZ: sig.volZ,
      });
    }
  }

  trades.sort((a, b) => a.signalTs - b.signalTs);

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R30-10B V2 메커니즘 분해 — trade-by-trade 분석`);
  L.push(`V2 룰: BB30/lb50/sm1.05/vz1.0 + TP+7%/SL-2.5%/MAX 14d`);
  L.push(`Period: ${FROM} ~ ${TO}, 10 coins. Total trades: ${trades.length}`);
  L.push('='.repeat(150));

  // 종합
  const wr = trades.filter(t => t.netRet > 0).length / trades.length * 100;
  const totWin = trades.filter(t => t.netRet > 0).reduce((s, t) => s + t.netRet, 0);
  const totLoss = Math.abs(trades.filter(t => t.netRet <= 0).reduce((s, t) => s + t.netRet, 0));
  const pf = totLoss > 0 ? totWin / totLoss : 99;
  const tpRate = trades.filter(t => t.reason === 'TP').length / trades.length * 100;
  const slRate = trades.filter(t => t.reason === 'SL').length / trades.length * 100;
  const timeRate = trades.filter(t => t.reason === 'TIME').length / trades.length * 100;
  const avgHoldH = trades.reduce((s, t) => s + t.holdBars, 0) / trades.length;
  L.push(`\nOverall: n=${trades.length}, WR=${wr.toFixed(1)}%, PF=${pf.toFixed(2)}, TP=${tpRate.toFixed(0)}%, SL=${slRate.toFixed(0)}%, TIME=${timeRate.toFixed(0)}%, avg hold=${avgHoldH.toFixed(0)}h`);

  // 1. 월별 분포
  L.push(`\n## 월별 분포\n`);
  L.push(`${pad('month', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avg ret', 8)} | ${padS('TP%', 5)} | ${padS('SL%', 5)}`);
  L.push('-'.repeat(55));
  const monthGroups = new Map<string, DetailedTrade[]>();
  for (const t of trades) {
    if (!monthGroups.has(t.monthKey)) monthGroups.set(t.monthKey, []);
    monthGroups.get(t.monthKey)!.push(t);
  }
  const sortedMonths = [...monthGroups.keys()].sort();
  for (const mk of sortedMonths) {
    const ts = monthGroups.get(mk)!;
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const avgR = ts.reduce((s, t) => s + t.netRet, 0) / ts.length;
    const tp = ts.filter(t => t.reason === 'TP').length / ts.length * 100;
    const sl = ts.filter(t => t.reason === 'SL').length / ts.length * 100;
    L.push(`${pad(mk, 10)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(avgR, false), 8)} | ${padS(tp.toFixed(0)+'%', 5)} | ${padS(sl.toFixed(0)+'%', 5)}`);
  }

  // 2. 코인별 분포
  L.push(`\n## 코인별 분포\n`);
  L.push(`${pad('coin', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('TP%', 5)}`);
  L.push('-'.repeat(60));
  for (const coin of COINS) {
    const ts = trades.filter(t => t.coin === coin);
    if (ts.length === 0) { L.push(`${pad(coin, 6)} | (없음)`); continue; }
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const tot = ts.reduce((s, t) => s + t.netRet, 0);
    const winSum = ts.filter(t => t.netRet > 0).reduce((s, t) => s + t.netRet, 0);
    const lossSum = Math.abs(ts.filter(t => t.netRet <= 0).reduce((s, t) => s + t.netRet, 0));
    const pfc = lossSum > 0 ? winSum / lossSum : 99;
    const tp = ts.filter(t => t.reason === 'TP').length / ts.length * 100;
    L.push(`${pad(coin, 6)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(tot), 9)} | ${padS(pfc.toFixed(2), 5)} | ${padS(tp.toFixed(0)+'%', 5)}`);
  }

  // 3. BTC regime
  L.push(`\n## BTC regime별 (entry 시점 daily close vs EMA50)\n`);
  L.push(`${pad('regime', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avg ret', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(50));
  for (const reg of ['bull','neutral','bear'] as const) {
    const ts = trades.filter(t => t.btcRegime === reg);
    if (ts.length === 0) { L.push(`${pad(reg, 10)} | (없음)`); continue; }
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const avgR = ts.reduce((s, t) => s + t.netRet, 0) / ts.length;
    const winSum = ts.filter(t => t.netRet > 0).reduce((s, t) => s + t.netRet, 0);
    const lossSum = Math.abs(ts.filter(t => t.netRet <= 0).reduce((s, t) => s + t.netRet, 0));
    const pfc = lossSum > 0 ? winSum / lossSum : 99;
    L.push(`${pad(reg, 10)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(avgR, false), 8)} | ${padS(pfc.toFixed(2), 5)}`);
  }

  // 4. BB squeeze tightness (width / min ratio)
  L.push(`\n## BB squeeze tightness (width/min ratio, 낮을수록 tight)\n`);
  const buckets = [
    { name: '1.00-1.01', lo: 1.0, hi: 1.01 },
    { name: '1.01-1.02', lo: 1.01, hi: 1.02 },
    { name: '1.02-1.03', lo: 1.02, hi: 1.03 },
    { name: '1.03-1.05', lo: 1.03, hi: 1.05 },
  ];
  L.push(`${pad('ratio', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avg ret', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(55));
  for (const b of buckets) {
    const ts = trades.filter(t => t.bbWidthRatio >= b.lo && t.bbWidthRatio < b.hi);
    if (ts.length === 0) { L.push(`${pad(b.name, 12)} | (없음)`); continue; }
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const avgR = ts.reduce((s, t) => s + t.netRet, 0) / ts.length;
    const winSum = ts.filter(t => t.netRet > 0).reduce((s, t) => s + t.netRet, 0);
    const lossSum = Math.abs(ts.filter(t => t.netRet <= 0).reduce((s, t) => s + t.netRet, 0));
    const pfc = lossSum > 0 ? winSum / lossSum : 99;
    L.push(`${pad(b.name, 12)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(avgR, false), 8)} | ${padS(pfc.toFixed(2), 5)}`);
  }

  // 5. Vol z buckets
  L.push(`\n## Vol z buckets\n`);
  const vzB = [
    { name: '1.0-1.5', lo: 1.0, hi: 1.5 },
    { name: '1.5-2.0', lo: 1.5, hi: 2.0 },
    { name: '2.0-3.0', lo: 2.0, hi: 3.0 },
    { name: '3.0+',    lo: 3.0, hi: 999 },
  ];
  L.push(`${pad('vol z', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avg ret', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(50));
  for (const b of vzB) {
    const ts = trades.filter(t => t.volZ >= b.lo && t.volZ < b.hi);
    if (ts.length === 0) { L.push(`${pad(b.name, 10)} | (없음)`); continue; }
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const avgR = ts.reduce((s, t) => s + t.netRet, 0) / ts.length;
    const winSum = ts.filter(t => t.netRet > 0).reduce((s, t) => s + t.netRet, 0);
    const lossSum = Math.abs(ts.filter(t => t.netRet <= 0).reduce((s, t) => s + t.netRet, 0));
    const pfc = lossSum > 0 ? winSum / lossSum : 99;
    L.push(`${pad(b.name, 10)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(avgR, false), 8)} | ${padS(pfc.toFixed(2), 5)}`);
  }

  // 6. Hold time
  L.push(`\n## Hold time buckets\n`);
  const hB = [
    { name: '<24h',     lo: 0,    hi: 24 },
    { name: '24-72h',   lo: 24,   hi: 72 },
    { name: '72-168h',  lo: 72,   hi: 168 },
    { name: '168-336h', lo: 168,  hi: 336 },
    { name: '336h+',    lo: 336,  hi: 9999 },
  ];
  L.push(`${pad('hold', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avg ret', 8)} | TP/SL/TIME`);
  L.push('-'.repeat(70));
  for (const b of hB) {
    const ts = trades.filter(t => t.holdBars >= b.lo && t.holdBars < b.hi);
    if (ts.length === 0) { L.push(`${pad(b.name, 12)} | (없음)`); continue; }
    const w = ts.filter(t => t.netRet > 0).length / ts.length * 100;
    const avgR = ts.reduce((s, t) => s + t.netRet, 0) / ts.length;
    const tp = ts.filter(t => t.reason === 'TP').length;
    const sl = ts.filter(t => t.reason === 'SL').length;
    const tm = ts.filter(t => t.reason === 'TIME').length;
    L.push(`${pad(b.name, 12)} | ${padS(String(ts.length), 4)} | ${padS(w.toFixed(0)+'%', 5)} | ${padS(fmt(avgR, false), 8)} | ${tp}/${sl}/${tm}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-10B_V2_MECH.txt`), L.join('\n'));
  process.exit(0);
})();
