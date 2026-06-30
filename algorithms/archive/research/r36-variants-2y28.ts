/**
 * R36 — F6 변형 10개 + BASE 비교 (2년, 28코인).
 *
 * R35는 4년 15코인 → 2024 이전 약세장 포함. 그러나 코인 풀 제한.
 * R36는 2년 28코인 → 최근 시장 + 넓은 풀 비교.
 *
 * 같은 10개 variant (R35와 동일):
 *   V1 BASE              : TP5/SL-2 + lookback 42 + vol z 0.5 ★ paper 현재
 *   V2 TP_OPT            : TP7/SL-2.5
 *   V3 BTC_EMA200_GATE   : BASE + BTC daily close > EMA200
 *   V4 BTC_EMA50_GATE    : BASE + BTC daily close > EMA50
 *   V5 VOLZ_STRICT       : BASE + vol z ≥ 1.5
 *   V6 COIN_TREND        : BASE + 코인 자체 4h EMA200 above
 *   V7 SHORT_LB_VOLZ     : lookback 28 + vol z 1.5
 *   V8 BEAR_HALF_SIZE    : BASE + BTC bear 시 position 16.5%
 *   V9 ATR_DYNAMIC       : TP = 2.5×ATR, SL = 1×ATR
 *   V10 ALL_FILTERS      : V2 + V5(1.0) + V6 combo
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const POSITION_PCT_HALF = 0.165;
const MAX_CONCURRENT = 3;
const COST_RT = 0.001;

const COINS_28 = [
  'BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH',
  'POL','NEAR','ATOM','TRX','ALGO',
  'ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT',
];

function load4hBars2Y(coin: string): CachedBar[] {
  const yearFiles = ['2024-06-10_2025-06-10','2025-06-10_2026-06-10'];
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const yf of yearFiles) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) {
      if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); }
    }
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

function buildBtcDaily(btcBars: CachedBar[]) {
  const byDate = new Map<string, { o: number; h: number; l: number; c: number; }>();
  for (const b of btcBars) {
    const d = new Date(b.ts + 9*3600_000).toISOString().slice(0, 10);
    const cur = byDate.get(d);
    if (!cur) byDate.set(d, { o: b.open, h: b.high, l: b.low, c: b.close });
    else { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.c = b.close; }
  }
  const arr = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const closes = arr.map(([, d]) => d.c);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const dateToData = new Map<string, { c: number; ema50: number|null; ema200: number|null }>();
  for (let i = 0; i < arr.length; i++) dateToData.set(arr[i][0], { c: arr[i][1].c, ema50: ema50[i], ema200: ema200[i] });
  return dateToData;
}

interface Signal { coin: string; barIdx: number; ts: number; volZ: number; }

function sigF6Generic(bars: CachedBar[], coin: string, lookback: number, volZThresh: number, coinEma200Filter?: boolean): Signal[] {
  const volumes = bars.map(b => b.volume);
  const closes = bars.map(b => b.close);
  const ema200_4h = coinEma200Filter ? calcEMA(closes, 200) : null;
  const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZThresh) continue;
    if (coinEma200Filter && (ema200_4h![i] == null || closes[i] <= ema200_4h![i]!)) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; maxBars: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

interface VariantConfig {
  name: string;
  tp: number; sl: number; maxBars: number;
  useAtrExit?: boolean;
  atrTpMult?: number; atrSlMult?: number;
  btcGate?: 'ema200' | 'ema50' | 'none';
  bearHalfSize?: boolean;
}

function simulate(
  cfg: VariantConfig, rawSignals: Signal[],
  barsByCoin: Map<string, CachedBar[]>,
  btcDaily: ReturnType<typeof buildBtcDaily>,
  atrByCoin: Map<string, (number|null)[]>,
  periodStartTs: number, periodEndTs: number,
) {
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
  for (const bars of barsByCoin.values()) for (const b of bars) {
    if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  }
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }
  let peak = INITIAL_CASH, mdd = 0;
  function btcRegimeAtTs(ts: number): 'bull' | 'bear' {
    const prevDate = new Date(ts + 9*3600_000 - 86400_000).toISOString().slice(0, 10);
    const data = btcDaily.get(prevDate);
    if (!data || data.ema50 == null) return 'bull';
    return data.c > data.ema50 ? 'bull' : 'bear';
  }
  function btcGatePass(ts: number, mode: 'ema200' | 'ema50' | 'none'): boolean {
    if (mode === 'none') return true;
    const prevDate = new Date(ts + 9*3600_000 - 86400_000).toISOString().slice(0, 10);
    const data = btcDaily.get(prevDate);
    if (!data) return false;
    if (mode === 'ema200') return data.ema200 != null && data.c > data.ema200;
    return data.ema50 != null && data.c > data.ema50;
  }
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
      if (cfg.btcGate && cfg.btcGate !== 'none' && !btcGatePass(ts, cfg.btcGate)) continue;
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const eBar = bars[entryIdx];
      const entryPrice = eBar.open;
      const sizePct = cfg.bearHalfSize && btcRegimeAtTs(ts) === 'bear' ? POSITION_PCT_HALF : POSITION_PCT;
      const cashToUse = cash * sizePct;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      let tp = 0, sl = 0;
      if (cfg.useAtrExit) {
        const atr = atrByCoin.get(sig.coin)![sig.barIdx];
        if (atr == null) continue;
        tp = entryPrice + atr * (cfg.atrTpMult ?? 2.5);
        sl = entryPrice - atr * (cfg.atrSlMult ?? 1.0);
      } else {
        tp = entryPrice * (1 + cfg.tp / 100);
        sl = entryPrice * (1 + cfg.sl / 100);
      }
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
  console.log(`\n=== R36 변형 10개 + BASE 비교 (2년 28코인) ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS_28) {
    const b = load4hBars2Y(coin);
    if (b.length >= 4000) barsByCoin.set(coin, b);
  }
  console.log(`Loaded ${barsByCoin.size} coins (2y)`);

  const btcDaily = buildBtcDaily(barsByCoin.get('BTC')!);
  const atrByCoin = new Map<string, (number|null)[]>();
  for (const [coin, bars] of barsByCoin) {
    atrByCoin.set(coin, calcATR(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14));
  }

  // Pre-compute signal sets
  const sigBase = (() => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of sigF6Generic(barsByCoin.get(c)!, c, 42, 0.5)) a.push(s); return a; })();
  const sigVolzStrict = (() => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of sigF6Generic(barsByCoin.get(c)!, c, 42, 1.5)) a.push(s); return a; })();
  const sigCoinTrend = (() => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of sigF6Generic(barsByCoin.get(c)!, c, 42, 0.5, true)) a.push(s); return a; })();
  const sigShortLb = (() => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of sigF6Generic(barsByCoin.get(c)!, c, 28, 1.5)) a.push(s); return a; })();
  const sigAllFilters = (() => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of sigF6Generic(barsByCoin.get(c)!, c, 42, 1.0, true)) a.push(s); return a; })();

  const variants: { cfg: VariantConfig; sigs: Signal[] }[] = [
    { cfg: { name: 'V1 BASE ★',         tp: 5,   sl: -2,   maxBars: 84 }, sigs: sigBase },
    { cfg: { name: 'V2 TP_OPT',         tp: 7,   sl: -2.5, maxBars: 84 }, sigs: sigBase },
    { cfg: { name: 'V3 BTC_EMA200',     tp: 5,   sl: -2,   maxBars: 84, btcGate: 'ema200' }, sigs: sigBase },
    { cfg: { name: 'V4 BTC_EMA50',      tp: 5,   sl: -2,   maxBars: 84, btcGate: 'ema50' }, sigs: sigBase },
    { cfg: { name: 'V5 VOLZ_STRICT',    tp: 5,   sl: -2,   maxBars: 84 }, sigs: sigVolzStrict },
    { cfg: { name: 'V6 COIN_TREND',     tp: 5,   sl: -2,   maxBars: 84 }, sigs: sigCoinTrend },
    { cfg: { name: 'V7 SHORT_LB_VOLZ',  tp: 5,   sl: -2,   maxBars: 84 }, sigs: sigShortLb },
    { cfg: { name: 'V8 BEAR_HALF',      tp: 5,   sl: -2,   maxBars: 84, bearHalfSize: true }, sigs: sigBase },
    { cfg: { name: 'V9 ATR_DYNAMIC',    tp: 0,   sl: 0,    maxBars: 84, useAtrExit: true, atrTpMult: 2.5, atrSlMult: 1.0 }, sigs: sigBase },
    { cfg: { name: 'V10 ALL_FILTERS',   tp: 7,   sl: -2.5, maxBars: 84, btcGate: 'ema200' }, sigs: sigAllFilters },
  ];

  const periodAll = {
    start: new Date('2024-06-10T00:00:00+09:00').getTime(),
    end: new Date('2026-06-10T23:59:59+09:00').getTime(),
  };
  const quarters: { name: string; start: string; end: string }[] = [];
  const sd = new Date('2024-06-10');
  for (let q = 0; q < 8; q++) {
    const s = new Date(sd); s.setMonth(s.getMonth() + q * 3);
    const e = new Date(s); e.setMonth(e.getMonth() + 3);
    quarters.push({ name: `Q${q+1}`, start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
  }

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R36 — F6 변형 10개 + BASE 비교 (2년: 2024-06~2026-06, ${barsByCoin.size}코인 풀)`);
  L.push(`Capital 10M each variant, position 33% × max 3, cost RT 0.1%`);
  L.push('='.repeat(170));

  interface Row { name: string; n: number; wr: number; total: number; pf: number; mdd: number; finalCash: number; qPass: number; oneYear: ReturnType<typeof statsFor>; }
  const rows: Row[] = [];

  for (const { cfg, sigs } of variants) {
    const r = simulate(cfg, sigs, barsByCoin, btcDaily, atrByCoin, periodAll.start, periodAll.end);
    const s = statsFor(r.trades, r.finalCash, r.mdd);

    let qPass = 0;
    for (const q of quarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const rr = simulate(cfg, sigs, barsByCoin, btcDaily, atrByCoin, ps, pe);
      const ss = statsFor(rr.trades, rr.finalCash, rr.mdd);
      if (ss.pf >= 1.2 && ss.total > 0) qPass++;
    }
    // 1Y (최근 1년)
    const oneYearStart = new Date('2025-06-10T00:00:00+09:00').getTime();
    const oneYearEnd = periodAll.end;
    const r1y = simulate(cfg, sigs, barsByCoin, btcDaily, atrByCoin, oneYearStart, oneYearEnd);
    const s1y = statsFor(r1y.trades, r1y.finalCash, r1y.mdd);
    rows.push({ name: cfg.name, n: s.n, wr: s.wr, total: s.total, pf: s.pf, mdd: s.mdd, finalCash: s.finalCash, qPass, oneYear: s1y });
  }

  // 2Y FULL (sorted by PF)
  L.push(`\n## 2Y FULL (sorted by PF)\n`);
  L.push(`${pad('variant', 22)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 12)} | pass`);
  L.push('-'.repeat(100));
  const sorted = [...rows].sort((a, b) => b.pf - a.pf);
  for (const r of sorted) {
    const pass = r.pf >= 1.2 && r.total > 0;
    L.push(`${pad(r.name, 22)} | ${padS(String(r.n), 5)} | ${padS(r.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.total), 9)} | ${padS(r.pf.toFixed(2), 5)} | ${padS(r.mdd.toFixed(1)+'%', 6)} | ${padS(r.finalCash.toFixed(0), 12)} | ${pass ? '✓' : ''}`);
  }

  // 1Y (최근 1년) 비교
  L.push(`\n## 1Y (최근 2025-06~2026-06) 비교\n`);
  L.push(`${pad('variant', 22)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(85));
  const sortedY = [...rows].sort((a, b) => b.oneYear.pf - a.oneYear.pf);
  for (const r of sortedY) {
    const s = r.oneYear;
    const pass = s.pf >= 1.2 && s.total > 0;
    L.push(`${pad(r.name, 22)} | ${padS(String(s.n), 5)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
  }

  // 분기 통과
  L.push(`\n## 분기 통과율 (Q1~Q8, 2024-06부터)\n`);
  L.push(`${pad('variant', 22)} | ${padS('pass/8Q', 8)} | ${padS('%', 5)}`);
  L.push('-'.repeat(50));
  for (const r of [...rows].sort((a, b) => b.qPass - a.qPass)) {
    L.push(`${pad(r.name, 22)} | ${padS(`${r.qPass}/8`, 8)} | ${padS((r.qPass/8*100).toFixed(0)+'%', 5)}`);
  }

  // BASE vs 각 variant 비교 표
  L.push(`\n## BASE vs 변형 비교 (2Y FULL)\n`);
  const baseRow = rows.find(r => r.name.startsWith('V1 BASE'))!;
  L.push(`${pad('variant', 22)} | ${padS('Δtotal', 9)} | ${padS('ΔPF', 7)} | ${padS('ΔMDD', 7)} | ${padS('Δ qPass', 8)} | 평가`);
  L.push('-'.repeat(90));
  for (const r of rows) {
    if (r.name === baseRow.name) continue;
    const dt = r.total - baseRow.total;
    const dp = r.pf - baseRow.pf;
    const dm = r.mdd - baseRow.mdd;
    const dq = r.qPass - baseRow.qPass;
    const eval_: string[] = [];
    if (dt > 5) eval_.push('수익↑');
    else if (dt < -5) eval_.push('수익↓');
    if (dm < -2) eval_.push('MDD↓');
    else if (dm > 2) eval_.push('MDD↑');
    if (dq >= 1) eval_.push('분기↑');
    else if (dq <= -1) eval_.push('분기↓');
    L.push(`${pad(r.name, 22)} | ${padS((dt >= 0 ? '+' : '') + dt.toFixed(2)+'%', 9)} | ${padS((dp >= 0 ? '+' : '') + dp.toFixed(2), 7)} | ${padS((dm >= 0 ? '+' : '') + dm.toFixed(1)+'%', 7)} | ${padS((dq >= 0 ? '+' : '') + String(dq), 8)} | ${eval_.join(' ')}`);
  }

  // Top 3 분기 상세 (BASE 포함)
  L.push(`\n## 분기 상세 (BASE + top 변형 비교)\n`);
  const top = [
    rows.find(r => r.name.startsWith('V1 BASE'))!,
    ...[...rows].filter(r => !r.name.startsWith('V1 BASE')).sort((a, b) => b.pf - a.pf).slice(0, 3),
  ];
  L.push(`${pad('quarter', 14)} | ${top.map(t => padS(t.name.split(' ')[0], 12)).join(' | ')}`);
  L.push('-'.repeat(80));
  for (const q of quarters) {
    const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
    const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
    const cells: string[] = [];
    for (const t of top) {
      const variant = variants.find(v => v.cfg.name === t.name)!;
      const rr = simulate(variant.cfg, variant.sigs, barsByCoin, btcDaily, atrByCoin, ps, pe);
      const ss = statsFor(rr.trades, rr.finalCash, rr.mdd);
      cells.push(padS(`${ss.pf.toFixed(2)}/${fmt(ss.total)}`, 12));
    }
    L.push(`${pad(`${q.name} ${q.start.slice(2)}`, 14)} | ${cells.join(' | ')}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R36_2Y.txt`), L.join('\n'));
  process.exit(0);
})();
