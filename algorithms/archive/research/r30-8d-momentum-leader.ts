/**
 * R30-8D — 동적 코인 ranking + momentum top-K.
 *
 * 새 algo 5개:
 *   D1 RS_TOP_BREAKOUT  : 매 24h ROC ranking → top 3 코인만 BREAKOUT24 매수
 *   D2 RS_TOP_DONCHIAN  : 매 24h ROC ranking → top 4 코인만 Donchian20 매수
 *   D3 EMA_LEADER       : EMA50 above + ROC 양수인 코인만 진입
 *   D4 ROC_7D_TOP       : 7d ROC top 3 코인 + 24h 신고가 break
 *   D5 ROC_3D_TOP_VOL   : 3d ROC top 4 + vol z>1.5
 *
 * 약한 코인 자동 배제. 10코인 풀 활용.
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
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const TP_PCT = 5.0;
const SL_PCT = -2.0;
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface RawSignal { coin: string; barIdx: number; ts: number; }

/**
 * 동적 ranking: 각 ts에서 코인별 ROC 계산 → top-K 코인 선택.
 * ROC = (close - close[i-rocBars]) / close[i-rocBars] * 100
 */
function buildRanking(
  barsByCoin: Map<string, CachedBar[]>,
  rocBars: number,
  topK: number,
): Map<number, Set<string>> {
  // ts → set of top-K coins
  const tsRank = new Map<number, Set<string>>();
  // for each ts, compute ROC per coin
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  // pre-build idx maps
  const idxMap = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxMap.set(coin, m);
  }
  for (const ts of tsList) {
    const rocs: { coin: string; roc: number }[] = [];
    for (const [coin, bars] of barsByCoin) {
      const idx = idxMap.get(coin)!.get(ts);
      if (idx == null || idx < rocBars) continue;
      const cur = bars[idx].close;
      const prev = bars[idx - rocBars].close;
      const roc = (cur - prev) / prev * 100;
      rocs.push({ coin, roc });
    }
    rocs.sort((a, b) => b.roc - a.roc);
    const set = new Set(rocs.slice(0, topK).map(r => r.coin));
    tsRank.set(ts, set);
  }
  return tsRank;
}

// D1 RS_TOP_BREAKOUT: top 3 ROC 24h + BREAKOUT24
function sigD1(bars: CachedBar[], coin: string, ranking: Map<number, Set<string>>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    const rank = ranking.get(bars[i].ts);
    if (!rank || !rank.has(coin)) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// D2 RS_TOP_DONCHIAN: top 4 ROC 24h + Donchian20
function sigD2(bars: CachedBar[], coin: string, ranking: Map<number, Set<string>>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 20;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    const rank = ranking.get(bars[i].ts);
    if (!rank || !rank.has(coin)) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].close <= prevMax && bars[i].close > prevMax)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// D3 EMA_LEADER: EMA50 above + ROC 24h 양수 코인만 + breakout
function sigD3(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close); const volumes = bars.map(b => b.volume);
  const ema50 = calcEMA(closes, 50);
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = Math.max(50, lookback) + 24 + 1; i < bars.length; i++) {
    if (ema50[i] == null) continue;
    if (closes[i] <= ema50[i]!) continue;
    // ROC 24h > 0
    const roc = (closes[i] - closes[i-24]) / closes[i-24] * 100;
    if (roc <= 0) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// D4 ROC_7D_TOP: 7d ROC top 3 + 24h high break
function sigD4(bars: CachedBar[], coin: string, ranking: Map<number, Set<string>>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = lookback + 168 + 1; i < bars.length; i++) {
    const rank = ranking.get(bars[i].ts);
    if (!rank || !rank.has(coin)) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// D5 ROC_3D_TOP_VOL: 3d ROC top 4 + vol z > 1.5
function sigD5(bars: CachedBar[], coin: string, ranking: Map<number, Set<string>>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = 72 + 1; i < bars.length; i++) {
    const rank = ranking.get(bars[i].ts);
    if (!rank || !rank.has(coin)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.5) continue;
    // 양봉 + 직전 24h 신고가
    if (bars[i].close <= bars[i].open) continue;
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }
function simulate(rawSignals: RawSignal[], barsByCoin: Map<string, CachedBar[]>) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: PfTrade[] = [];
  const sigByTs = new Map<number, RawSignal[]>();
  for (const sig of [...rawSignals].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
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
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
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
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse });
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
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: last.ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}

function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R30-8D MOMENTUM LEADER ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS) barsByCoin.set(coin, loadBars(coin));

  console.log(`Building rankings...`);
  const rank24h_top3 = buildRanking(barsByCoin, 24, 3);
  const rank24h_top4 = buildRanking(barsByCoin, 24, 4);
  const rank7d_top3  = buildRanking(barsByCoin, 168, 3);
  const rank3d_top4  = buildRanking(barsByCoin, 72, 4);
  console.log(`Rankings done`);

  const algos = [
    { name: 'D1 RS_TOP_BREAKOUT',  fn: (b: CachedBar[], c: string) => sigD1(b, c, rank24h_top3) },
    { name: 'D2 RS_TOP_DONCHIAN',  fn: (b: CachedBar[], c: string) => sigD2(b, c, rank24h_top4) },
    { name: 'D3 EMA_LEADER',       fn: (b: CachedBar[], c: string) => sigD3(b, c) },
    { name: 'D4 ROC_7D_TOP',       fn: (b: CachedBar[], c: string) => sigD4(b, c, rank7d_top3) },
    { name: 'D5 ROC_3D_TOP_VOL',   fn: (b: CachedBar[], c: string) => sigD5(b, c, rank3d_top4) },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R30-8D — 동적 코인 ranking (ROC top-K) + momentum 신호`);
  L.push(`10 coin pool, TP+5%/SL-2%/MAX 14d, Position ${POSITION_PCT*100}% × max ${MAX_CONCURRENT}`);
  L.push('='.repeat(170));

  interface Res { name: string; n: number; wr: number; total: number; pf: number; mdd: number; coinDist: Record<string, number>; }
  const results: Res[] = [];

  for (const algo of algos) {
    const allSigs: RawSignal[] = [];
    for (const coin of COINS) {
      const bars = barsByCoin.get(coin)!;
      for (const s of algo.fn(bars, coin)) allSigs.push(s);
    }
    const { trades, finalCash, mdd } = simulate(allSigs, barsByCoin);
    const n = trades.length;
    const wins = trades.filter(t => t.profitKrw > 0);
    const losses = trades.filter(t => t.profitKrw <= 0);
    const wr = n ? wins.length / n * 100 : 0;
    const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
    const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
    const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
    const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
    const coinDist: Record<string, number> = {};
    for (const t of trades) coinDist[t.coin] = (coinDist[t.coin] || 0) + 1;
    results.push({ name: algo.name, n, wr, total, pf, mdd, coinDist });
  }

  L.push(`\n${pad('algo', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(80));
  for (const r of results.sort((a, b) => b.pf - a.pf)) {
    const pass = r.pf >= 1.2 && r.total > 0;
    L.push(`${pad(r.name, 22)} | ${padS(String(r.n), 4)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
  }
  L.push(`\n## 코인 trade 분포\n`);
  L.push(`${pad('algo', 22)} | ${COINS.map(c => padS(c, 5)).join(' | ')}`);
  L.push('-'.repeat(95));
  for (const r of results) {
    L.push(`${pad(r.name, 22)} | ${COINS.map(c => padS(String(r.coinDist[c] || 0), 5)).join(' | ')}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-8D.txt`), L.join('\n'));
  process.exit(0);
})();
