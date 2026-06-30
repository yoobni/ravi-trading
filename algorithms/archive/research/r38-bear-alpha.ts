/**
 * R38 — 약세장 알파 5 새 algo 검증.
 *
 * 가설: F6 (momentum)은 강세장 알파, 약세장은 본질적으로 다른 mechanism 필요.
 *       Upbit spot LONG only 한계 → mean reversion / panic buying 중심.
 *
 * 후보:
 *   M1 RSI_OVERSOLD     : RSI(14) cross up 30 + 양봉 + 거래량
 *   M2 BB_LOWER_BOUNCE  : close < BB lower 후 close > BB lower + 양봉
 *   M3 PANIC_BUY        : 직전 4h bar return < -5% + 양봉 회복 + 거래량
 *   M4 RANGE_BREAKOUT   : 최근 ATR/close 분위 하위 + breakout (변동성 expansion)
 *   M5 HYBRID_REGIME    : BTC bull(EMA50) = F6 / BTC bear = RSI_bounce switch
 *
 * 비교 베이스: V2_BASE
 * 기간: 4Y (15코인) + 2Y (28코인) + 약세장 분기 집중
 *
 * Pool, position 등 V2와 동일 (28/15코인, 33%×3, MAX 84 bars).
 * TP/SL: 신호별 다름 (mean reversion은 짧게).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const COST_RT = 0.001;

const COINS_4Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const COINS_2Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function load4hBars(coin: string, years: string[]): CachedBar[] {
  const seen = new Set<number>(); const all: CachedBar[] = [];
  for (const yf of years) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
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
  const lower: (number|null)[] = new Array(n).fill(null);
  const upper: (number|null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    lower[i] = mean - mult*sd; upper[i] = mean + mult*sd;
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

interface Signal { coin: string; barIdx: number; ts: number; }

// V2_BASE (F6) — 비교용
function sigV2(bars: CachedBar[], coin: string): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// M1 RSI_OVERSOLD: RSI<30 → cross up + 양봉 + vol z≥0
function sigM1(bars: CachedBar[], coin: string): Signal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const rsi = calcRSI(closes, 14);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (rsi[i-1] == null || rsi[i] == null) continue;
    if (!(rsi[i-1]! < 30 && rsi[i]! >= 30)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// M2 BB_LOWER_BOUNCE
function sigM2(bars: CachedBar[], coin: string): Signal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 20, 2);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bb.lower[i-1] == null || bb.lower[i] == null) continue;
    if (!(closes[i-1] < bb.lower[i-1]! && closes[i] > bb.lower[i]!)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// M3 PANIC_BUY: 직전 4h bar return < -5% + 현재 bar 양봉 + 거래량
function sigM3(bars: CachedBar[], coin: string): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevRet = (bars[i-1].close - bars[i-1].open) / bars[i-1].open * 100;
    if (prevRet >= -5) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].close)) continue; // bounce 확인
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// M4 RANGE_BREAKOUT: ATR/close 30 bar 분위 하위 30% → 14h breakout (저변동성 expansion)
function sigM4(bars: CachedBar[], coin: string): Signal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const atr = calcATR(highs, lows, closes, 14);
  const out: Signal[] = [];
  for (let i = 30; i < bars.length; i++) {
    if (atr[i] == null) continue;
    const atrPct = atr[i]! / closes[i];
    // 30 bar 분위 하위 30%
    const recent: number[] = [];
    for (let j = i - 30; j < i; j++) {
      if (atr[j] != null && closes[j] > 0) recent.push(atr[j]! / closes[j]);
    }
    recent.sort((a, b) => a - b);
    const p30 = recent[Math.floor(recent.length * 0.3)];
    if (atrPct > p30) continue;
    // 24h breakout
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i].close > prevMax)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
// M5 HYBRID_REGIME — bull 시 V2 신호, bear 시 M1 신호 (BTC daily EMA50)
function sigM5(bars: CachedBar[], coin: string, btcRegimeByTs: Map<number, 'bull' | 'bear'>): Signal[] {
  const v2 = sigV2(bars, coin);
  const m1 = sigM1(bars, coin);
  const out: Signal[] = [];
  for (const s of v2) {
    if (btcRegimeByTs.get(s.ts) === 'bull') out.push(s);
  }
  for (const s of m1) {
    if (btcRegimeByTs.get(s.ts) === 'bear') out.push(s);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// BTC daily regime
function buildBtcRegime(btcBars: CachedBar[]): Map<number, 'bull' | 'bear'> {
  const byDate = new Map<string, { c: number }>();
  for (const b of btcBars) {
    const d = new Date(b.ts + 9*3600_000).toISOString().slice(0, 10);
    const cur = byDate.get(d);
    if (!cur) byDate.set(d, { c: b.close });
    else cur.c = b.close;
  }
  const arr = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const closes = arr.map(([, d]) => d.c);
  const ema50 = calcEMA(closes, 50);
  const dateToRegime = new Map<string, 'bull' | 'bear'>();
  for (let i = 0; i < arr.length; i++) {
    if (ema50[i] != null) {
      dateToRegime.set(arr[i][0], arr[i][1].c > ema50[i]! ? 'bull' : 'bear');
    }
  }
  // map 4h ts → regime (해당 ts의 KST 직전 date의 regime 사용)
  const tsToRegime = new Map<number, 'bull' | 'bear'>();
  for (const b of btcBars) {
    const prevDate = new Date(b.ts + 9*3600_000 - 86400_000).toISOString().slice(0, 10);
    const r = dateToRegime.get(prevDate);
    if (r) tsToRegime.set(b.ts, r);
  }
  return tsToRegime;
}

interface Variant {
  name: string;
  signalFn: (bars: CachedBar[], coin: string) => Signal[];
  tp: number; sl: number; maxBars: number;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; maxBars: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

function simulate(cfg: Variant, rawSignals: Signal[], barsByCoin: Map<string, CachedBar[]>, periodStartTs: number, periodEndTs: number) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: Trade[] = [];
  const filtered = rawSignals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, Signal[]>();
  for (const sig of [...filtered].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; rawRet = (pos.sl - pos.entryPrice) / pos.entryPrice * 100; }
      else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; rawRet = (pos.tp - pos.entryPrice) / pos.entryPrice * 100; }
      else if (holdBars >= pos.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(q, 1);
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
      const tp = entryPrice * (1 + cfg.tp / 100);
      const sl = entryPrice * (1 + cfg.sl / 100);
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse, tp, sl, maxBars: cfg.maxBars });
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
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
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
  console.log(`\n=== R38 약세장 알파 5변형 ===\n`);

  const bars4y = new Map<string, CachedBar[]>();
  for (const c of COINS_4Y) { const b = load4hBars(c, ['2022-06-10_2023-06-10','2023-06-10_2024-06-10','2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 8000) bars4y.set(c, b); }
  const bars2y = new Map<string, CachedBar[]>();
  for (const c of COINS_2Y) { const b = load4hBars(c, ['2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 4000) bars2y.set(c, b); }
  console.log(`Loaded 4y: ${bars4y.size}, 2y: ${bars2y.size}`);

  const btcRegime4y = buildBtcRegime(bars4y.get('BTC')!);
  const btcRegime2y = buildBtcRegime(bars2y.get('BTC')!);

  // Build signals
  function buildSigs(barsByCoin: Map<string, CachedBar[]>, btcRegime: Map<number, 'bull' | 'bear'>) {
    const v2: Signal[] = []; const m1: Signal[] = []; const m2: Signal[] = []; const m3: Signal[] = []; const m4: Signal[] = []; const m5: Signal[] = [];
    for (const c of barsByCoin.keys()) {
      for (const s of sigV2(barsByCoin.get(c)!, c)) v2.push(s);
      for (const s of sigM1(barsByCoin.get(c)!, c)) m1.push(s);
      for (const s of sigM2(barsByCoin.get(c)!, c)) m2.push(s);
      for (const s of sigM3(barsByCoin.get(c)!, c)) m3.push(s);
      for (const s of sigM4(barsByCoin.get(c)!, c)) m4.push(s);
      for (const s of sigM5(barsByCoin.get(c)!, c, btcRegime)) m5.push(s);
    }
    return { v2, m1, m2, m3, m4, m5 };
  }
  const sigs4y = buildSigs(bars4y, btcRegime4y);
  const sigs2y = buildSigs(bars2y, btcRegime2y);

  console.log(`Signals 4y: V2=${sigs4y.v2.length}, M1=${sigs4y.m1.length}, M2=${sigs4y.m2.length}, M3=${sigs4y.m3.length}, M4=${sigs4y.m4.length}, M5=${sigs4y.m5.length}`);
  console.log(`Signals 2y: V2=${sigs2y.v2.length}, M1=${sigs2y.m1.length}, M2=${sigs2y.m2.length}, M3=${sigs2y.m3.length}, M4=${sigs2y.m4.length}, M5=${sigs2y.m5.length}`);

  const variants: Variant[] = [
    { name: 'V2_BASE ★',         signalFn: sigV2, tp: 7,   sl: -2.5, maxBars: 84 },
    { name: 'M1 RSI_OVERSOLD',   signalFn: sigM1, tp: 5,   sl: -2,   maxBars: 42 },
    { name: 'M2 BB_LOWER_BOUNCE', signalFn: sigM2, tp: 5,   sl: -2,   maxBars: 42 },
    { name: 'M3 PANIC_BUY',       signalFn: sigM3, tp: 7,   sl: -3,   maxBars: 42 },
    { name: 'M4 RANGE_BREAKOUT',  signalFn: sigM4, tp: 6,   sl: -2.5, maxBars: 84 },
    { name: 'M5 HYBRID_REGIME',   signalFn: sigV2 /*ignored*/, tp: 6, sl: -2.5, maxBars: 84 },
  ];

  const sigMap4y = [sigs4y.v2, sigs4y.m1, sigs4y.m2, sigs4y.m3, sigs4y.m4, sigs4y.m5];
  const sigMap2y = [sigs2y.v2, sigs2y.m1, sigs2y.m2, sigs2y.m3, sigs2y.m4, sigs2y.m5];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R38 약세장 알파 5변형 (V2_BASE 비교)`);
  L.push(`4Y (2022~26, ${bars4y.size}코인), 2Y (2024~26, ${bars2y.size}코인)`);
  L.push('='.repeat(170));

  // 4Y + 2Y
  for (const [name, ps, pe, barsByCoin, sigsList] of [
    ['4Y (15코인)', '2022-06-10', '2026-06-10', bars4y, sigMap4y],
    ['2Y (28코인)', '2024-06-10', '2026-06-10', bars2y, sigMap2y],
  ] as const) {
    const pStart = new Date(`${ps}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${pe}T23:59:59+09:00`).getTime();
    L.push(`\n## ${name}\n`);
    L.push(`${pad('variant', 22)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
    L.push('-'.repeat(80));
    const results: { name: string; stats: ReturnType<typeof statsFor> }[] = [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const sigs = sigsList[i];
      const r = simulate(v, sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      results.push({ name: v.name, stats: s });
    }
    for (const r of results) {
      const pass = r.stats.pf >= 1.2 && r.stats.total > 0;
      L.push(`${pad(r.name, 22)} | ${padS(String(r.stats.n), 5)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 9)} | ${padS(r.stats.pf.toFixed(2), 5)} | ${padS(r.stats.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
    }
  }

  // 약세장 분기 (4Y)에서 어느 algo가 진짜 양수 가능한지
  L.push(`\n## 약세장 분기 4Y total% (진짜 보강 algo 찾기)\n`);
  const bearQuarters = [
    { name: 'Q2 22-09', start: '2022-09-10', end: '2022-12-10' },
    { name: 'Q3 22-12', start: '2022-12-10', end: '2023-03-10' },
    { name: 'Q4 23-03', start: '2023-03-10', end: '2023-06-10' },
    { name: 'Q7 23-12', start: '2023-12-10', end: '2024-03-10' },
    { name: 'Q8 24-03', start: '2024-03-10', end: '2024-06-10' },
  ];
  L.push(`${pad('variant', 22)} | ${bearQuarters.map(q => padS(q.name, 11)).join(' | ')}`);
  L.push('-'.repeat(110));
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const sigs = sigMap4y[i];
    const cells: string[] = [];
    for (const q of bearQuarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const r = simulate(v, sigs, bars4y, ps, pe);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      cells.push(padS(fmt(s.total), 11));
    }
    L.push(`${pad(v.name, 22)} | ${cells.join(' | ')}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R38_BEAR_ALPHA.txt`), L.join('\n'));
  process.exit(0);
})();
