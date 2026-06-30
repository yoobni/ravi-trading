/**
 * R30-4 — 알고리즘 fleet portfolio.
 *
 * 8개 알고리즘이 각자 독립 portfolio로 운영.
 *   - 자본 10M KRW
 *   - 10코인 pool 자유롭게 매수 (시간순 신호 처리)
 *   - Multi-position: per-entry 자본 20%, max 5 concurrent
 *   - per-coin 1 position only (중복 진입 X)
 *   - Variant TP5/SL2/14d 통일
 *   - Cost RT 0.1% (Upbit 0.05% × 2 + slippage)
 *
 * 각 알고리즘별 결과: final cash / PF / total / WR / MDD / n / 코인별 활용도.
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
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.20;      // 자본의 20% per entry
const MAX_CONCURRENT = 5;
const TP_PCT = 5.0;
const SL_PCT = -2.0;
const MAX_BARS = 336; // 14d

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
function calcRSI(closes: number[], period = 14): (number|null)[] {
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period;
      if (i === period) { const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); } }
    else { avgGain = (avgGain*(period-1)+gain)/period; avgLoss = (avgLoss*(period-1)+loss)/period;
      const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); }
  } return out;
}
function calcMACD(closes: number[]) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? (e12[i]! - e26[i]!) : null);
  const macdPad = macd.map(v => v ?? 0);
  const sigRaw = calcEMA(macdPad, 9);
  const sig = macd.map((v, i) => v == null ? null : sigRaw[i]);
  const hist = macd.map((v, i) => (v != null && sig[i] != null) ? v - sig[i]! : null);
  return { macd, sig, hist };
}
function calcBB(closes: number[], period = 20, mult = 2) {
  const lower: (number|null)[] = [], upper: (number|null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { lower.push(null); upper.push(null); continue; }
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    lower.push(mean - mult*sd); upper.push(mean + mult*sd);
  }
  return { lower, upper };
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}
function heikinAshi(bars: CachedBar[]) {
  const ho: number[] = [], hc: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const hcv = (b.open + b.high + b.low + b.close) / 4;
    const hov = i === 0 ? b.open : (ho[i-1] + hc[i-1]) / 2;
    hc.push(hcv); ho.push(hov);
  }
  return { ho, hc };
}
function vwap(bars: CachedBar[], i: number, window: number): number | null {
  if (i < window - 1) return null;
  let pv = 0, v = 0;
  for (let j = i - window + 1; j <= i; j++) {
    const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
    pv += tp * bars[j].volume; v += bars[j].volume;
  }
  return v > 0 ? pv / v : null;
}

interface RawSignal { coin: string; barIdx: number; ts: number; }

function sigBreakout(bars: CachedBar[], coin: string, lookback: number, volZ: number): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close > prevMax) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigSMA(bars: CachedBar[], coin: string, volZ = 0.5): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ef = calcEMA(closes, 12), es = calcEMA(closes, 26);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (ef[i-1] == null || es[i-1] == null || ef[i] == null || es[i] == null) continue;
    if (ef[i-1]! < es[i-1]! && ef[i]! > es[i]!) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigEMATrend(bars: CachedBar[], coin: string, volZ = 0.8): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26), e50 = calcEMA(closes, 50);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (e12[i] == null || e26[i] == null || e50[i] == null) continue;
    if (closes[i] > e50[i]! && e12[i]! > e26[i]! && bars[i].close > bars[i].open) {
      if (bars[i-1].low <= e26[i-1]! && bars[i].close > e26[i]!) {
        const z = calcVolZ(volumes, i, 30);
        if (z == null || z < volZ) continue;
        out.push({ coin, barIdx: i, ts: bars[i].ts });
      }
    }
  }
  return out;
}
function sigMACD(bars: CachedBar[], coin: string, volZ = 0.5): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const { macd, sig, hist } = calcMACD(closes);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (macd[i-1] == null || macd[i] == null || sig[i-1] == null || sig[i] == null || hist[i] == null) continue;
    if (macd[i-1]! < sig[i-1]! && macd[i]! > sig[i]! && hist[i]! > 0) {
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < volZ) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}
function sigRSI(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close);
  const rsi = calcRSI(closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (rsi[i-1] == null || rsi[i] == null) continue;
    if (rsi[i-1]! < 30 && rsi[i]! > 30 && bars[i].close > bars[i].open) out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigBB(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close);
  const bb = calcBB(closes, 20, 2);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bb.lower[i-1] == null || bb.lower[i] == null) continue;
    if (closes[i-1] < bb.lower[i-1]! && closes[i] > bb.lower[i]! && bars[i].close > bars[i].open) out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigHA(bars: CachedBar[], coin: string): RawSignal[] {
  const ha = heikinAshi(bars);
  const out: RawSignal[] = [];
  for (let i = 3; i < bars.length; i++) {
    let redStreak = 0;
    for (let j = i - 1; j >= 0 && ha.hc[j] < ha.ho[j]; j--) redStreak++;
    if (redStreak >= 3 && ha.hc[i] > ha.ho[i]) out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigVWAP(bars: CachedBar[], coin: string): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = 24; i < bars.length; i++) {
    const v0 = vwap(bars, i-1, 24);
    const v1 = vwap(bars, i, 24);
    if (v0 == null || v1 == null) continue;
    if (bars[i-1].close < v0 && bars[i].close > v1 && bars[i].close > bars[i].open) out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

interface AlgoDef { name: string; fn: (bars: CachedBar[], coin: string) => RawSignal[]; }
const ALGOS: AlgoDef[] = [
  { name: 'A1 BREAKOUT12',  fn: (b, c) => sigBreakout(b, c, 12, 1.0) },
  { name: 'A2 BREAKOUT24',  fn: (b, c) => sigBreakout(b, c, 24, 1.0) },
  { name: 'A3 BREAKOUT48',  fn: (b, c) => sigBreakout(b, c, 48, 1.0) },
  { name: 'A4 SMA_CROSS',   fn: (b, c) => sigSMA(b, c, 0.5) },
  { name: 'A5 EMA_TREND',   fn: (b, c) => sigEMATrend(b, c, 0.8) },
  { name: 'A6 MACD_BULL',   fn: (b, c) => sigMACD(b, c, 0.5) },
  { name: 'A7 RSI_BOUNCE',  fn: (b, c) => sigRSI(b, c) },
  { name: 'A8 BB_BOUNCE',   fn: (b, c) => sigBB(b, c) },
  { name: 'A9 HA_REVERSAL', fn: (b, c) => sigHA(b, c) },
  { name: 'A10 VWAP_BOUNCE', fn: (b, c) => sigVWAP(b, c) },
];

interface PortfolioPosition {
  coin: string;
  entryTs: number; entryIdx: number; entryPrice: number;
  vol: number; cashUsed: number;
}
interface PortfolioTrade {
  coin: string;
  entryTs: number; exitTs: number;
  entryPrice: number; exitPrice: number;
  rawRet: number; netRet: number;
  profitKrw: number;
  reason: 'TP'|'SL'|'TIME'|'END';
  holdBars: number;
}

function simulateFleet(
  algoName: string,
  rawSignals: RawSignal[],
  barsByCoin: Map<string, CachedBar[]>,
): { trades: PortfolioTrade[]; finalCash: number; peak: number; mdd: number; equityCurve: { ts: number; eq: number }[] } {
  let cash = INITIAL_CASH;
  const positions: PortfolioPosition[] = [];
  const trades: PortfolioTrade[] = [];

  // 모든 이벤트(신호+청산) 시간순 처리
  const sorted = [...rawSignals].sort((a, b) => a.ts - b.ts);

  // 시뮬 cursor: 매 1h마다 (8760 bars in a year)
  const cursors = new Map<string, number>();
  for (const coin of COINS) cursors.set(coin, 0);

  // 시계열 진행: 모든 코인 bars의 ts union을 sorted iterate
  const allTs = new Set<number>();
  for (const [coin, bars] of barsByCoin) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const sigByTs = new Map<number, RawSignal[]>();
  for (const sig of sorted) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }

  // 1h bar 진행
  const equityCurve: { ts: number; eq: number }[] = [];
  let peak = INITIAL_CASH;
  let mdd = 0;

  for (const ts of tsList) {
    // 1) Exit check: 모든 open positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const bars = barsByCoin.get(pos.coin)!;
      const bIdx = bars.findIndex(b => b.ts === ts);
      if (bIdx < 0) continue;
      const b = bars[bIdx];
      const tp = pos.entryPrice * (1 + TP_PCT / 100);
      const sl = pos.entryPrice * (1 + SL_PCT / 100);
      const holdBars = bIdx - pos.entryIdx;
      let exitPrice = 0;
      let reason: PortfolioTrade['reason'] | null = null;
      let rawRet = 0;
      if (b.low <= sl) { exitPrice = sl; reason = 'SL'; rawRet = SL_PCT; }
      else if (b.high >= tp) { exitPrice = tp; reason = 'TP'; rawRet = TP_PCT; }
      else if (holdBars >= MAX_BARS) {
        exitPrice = b.close; reason = 'TIME';
        rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100;
      }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({
          coin: pos.coin, entryTs: pos.entryTs, exitTs: ts,
          entryPrice: pos.entryPrice, exitPrice, rawRet, netRet,
          profitKrw, reason, holdBars,
        });
        positions.splice(p, 1);
      }
    }

    // 2) Entry: 이 ts의 신호들
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
      // per-coin 1 position
      if (positions.some(p => p.coin === sig.coin)) continue;
      const bars = barsByCoin.get(sig.coin)!;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const entryBar = bars[entryIdx];
      const entryPrice = entryBar.open;
      const cashToUse = cash * POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      cash -= cashToUse;
      positions.push({
        coin: sig.coin, entryTs: entryBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse,
      });
    }

    // 3) Equity calc + MDD
    let openValue = 0;
    for (const pos of positions) {
      const bars = barsByCoin.get(pos.coin)!;
      const bIdx = bars.findIndex(b => b.ts === ts);
      if (bIdx >= 0) openValue += pos.vol * bars[bIdx].close;
    }
    const eq = cash + openValue;
    equityCurve.push({ ts, eq });
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  // Force-close remaining at last bar
  for (const pos of positions) {
    const bars = barsByCoin.get(pos.coin)!;
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({
      coin: pos.coin, entryTs: pos.entryTs, exitTs: last.ts,
      entryPrice: pos.entryPrice, exitPrice, rawRet, netRet,
      profitKrw, reason: 'END', holdBars: bars.length - 1 - pos.entryIdx,
    });
  }

  return { trades, finalCash: cash, peak, mdd, equityCurve };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R30-4 FLEET PORTFOLIO ===\n`);

  // Load all coin bars once
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  const L: string[] = [];
  L.push('='.repeat(160));
  L.push(`R30-4 FLEET PORTFOLIO — 10개 알고리즘 각자 독립 운영`);
  L.push(`Pool: 10 coins (BTC~BCH). Capital: ${INITIAL_CASH/1e6}M KRW. Position: ${POSITION_PCT*100}% per entry, max ${MAX_CONCURRENT} concurrent, per-coin 1.`);
  L.push(`Variant: TP+${TP_PCT}% / SL ${SL_PCT}% / MAX ${MAX_BARS}h (${MAX_BARS/24}d). Cost RT ${(COST_RT*100).toFixed(1)}%.`);
  L.push('='.repeat(160));

  interface AlgoResult {
    name: string; n: number; wr: number; total: number; pf: number; mdd: number;
    finalCash: number; avgHoldH: number;
    tpRate: number; slRate: number; timeRate: number;
    coinDist: Record<string, number>;
  }
  const results: AlgoResult[] = [];

  for (const algo of ALGOS) {
    // Build all raw signals across coins
    const allSigs: RawSignal[] = [];
    for (const coin of COINS) {
      const bars = barsByCoin.get(coin)!;
      for (const s of algo.fn(bars, coin)) allSigs.push(s);
    }
    const res = simulateFleet(algo.name, allSigs, barsByCoin);
    const tr = res.trades;
    const n = tr.length;
    const wins = tr.filter(t => t.netRet > 0);
    const losses = tr.filter(t => t.netRet <= 0);
    const wr = n ? wins.length / n * 100 : 0;
    const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
    const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
    const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
    const total = (res.finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
    const avgHoldH = n ? tr.reduce((s, t) => s + t.holdBars, 0) / n : 0;
    const tp = tr.filter(t => t.reason === 'TP').length;
    const sl = tr.filter(t => t.reason === 'SL').length;
    const tm = tr.filter(t => t.reason === 'TIME' || t.reason === 'END').length;
    const coinDist: Record<string, number> = {};
    for (const t of tr) coinDist[t.coin] = (coinDist[t.coin] || 0) + 1;
    results.push({
      name: algo.name, n, wr, total, pf, mdd: res.mdd, finalCash: res.finalCash,
      avgHoldH, tpRate: n ? tp/n*100 : 0, slRate: n ? sl/n*100 : 0, timeRate: n ? tm/n*100 : 0,
      coinDist,
    });
  }

  L.push(`\n## Portfolio 결과 — 각 알고리즘 독립 운영, ${COINS.length} coin pool, 1년\n`);
  L.push(`${pad('algorithm', 18)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 14)} | ${padS('hold(h)', 8)} | ${padS('TP%', 5)} | ${padS('SL%', 5)} | pass`);
  L.push('-'.repeat(135));
  for (const r of results.sort((a, b) => b.pf - a.pf)) {
    const pass = r.pf >= 1.2 && r.total > 0;
    L.push(`${pad(r.name, 18)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${padS(r.finalCash.toFixed(0), 14)} | ${padS(r.avgHoldH.toFixed(0), 8)} | ${padS(r.tpRate.toFixed(0)+'%', 5)} | ${padS(r.slRate.toFixed(0)+'%', 5)} | ${pass ? '✓' : ''}`);
  }

  // 코인 분포 per algorithm
  L.push(`\n## 알고리즘별 코인 trade 분포 (n=10코인 pool)\n`);
  L.push(`${pad('algorithm', 18)} | ${COINS.map(c => padS(c, 5)).join(' | ')}`);
  L.push('-'.repeat(140));
  for (const r of results) {
    const cols = COINS.map(c => padS(String(r.coinDist[c] || 0), 5));
    L.push(`${pad(r.name, 18)} | ${cols.join(' | ')}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R30-4_FLEET.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
