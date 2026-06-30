/**
 * R39 — Regime switch hybrid (V2 + PANIC_BUY).
 *
 * 가설: V2가 강세장에서만 알파. 약세장 (BTC bear)에 자동으로 PANIC_BUY로 전환.
 *
 * 변형:
 *   V2_BASE    : V2_BASE 단독 (비교)
 *   H1 SWITCH       : bull=V2 / bear=PANIC_BUY (단순 switch)
 *   H2 SWITCH_LOOSE : bull=V2 / bear=PANIC_BUY (drop threshold -3%, 완화)
 *   H3 SWITCH_DEEP  : bull=V2 / bear=PANIC_BUY (drop -7%, 큰 dip만)
 *   H4 SWITCH_BOTH  : bull=V2 / bear=V2 + PANIC_BUY (둘 다)
 *   H5 SWITCH_MR    : bull=V2 / bear=PANIC + BB lower bounce (mean reversion 강화)
 *
 * Regime: BTC daily close vs EMA50 (D-1, lookahead-safe)
 * TP/SL: 신호별 다름 (V2 신호 = TP7/SL-2.5/MAX 84, PANIC = TP7/SL-3/MAX 42)
 * Pool: 28코인 (2Y) / 15코인 (4Y)
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
function calcBB(closes: number[], period: number, mult = 2) {
  const n = closes.length;
  const lower: (number|null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    lower[i] = mean - mult*sd;
  }
  return { lower };
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

// Signal types — 어떤 룰에 따라 entry exit 다름
type SigKind = 'V2' | 'PANIC' | 'BB_BOUNCE';
interface Signal { coin: string; barIdx: number; ts: number; kind: SigKind; }

// V2 (F6) 신호
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
    out.push({ coin, barIdx: i, ts: bars[i].ts, kind: 'V2' });
  }
  return out;
}
// PANIC_BUY 신호 (drop threshold 가변)
function sigPanic(bars: CachedBar[], coin: string, dropThreshold: number): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevRet = (bars[i-1].close - bars[i-1].open) / bars[i-1].open * 100;
    if (prevRet >= dropThreshold) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].close)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, kind: 'PANIC' });
  }
  return out;
}
// BB_LOWER_BOUNCE 신호 (mean reversion)
function sigBBBounce(bars: CachedBar[], coin: string): Signal[] {
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 20, 2);
  const out: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bb.lower[i-1] == null || bb.lower[i] == null) continue;
    if (!(closes[i-1] < bb.lower[i-1]! && closes[i] > bb.lower[i]!)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, kind: 'BB_BOUNCE' });
  }
  return out;
}

// BTC daily regime (D-1 close vs EMA50)
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
    if (ema50[i] != null) dateToRegime.set(arr[i][0], arr[i][1].c > ema50[i]! ? 'bull' : 'bear');
  }
  const tsToRegime = new Map<number, 'bull' | 'bear'>();
  for (const b of btcBars) {
    const prevDate = new Date(b.ts + 9*3600_000 - 86400_000).toISOString().slice(0, 10);
    const r = dateToRegime.get(prevDate);
    if (r) tsToRegime.set(b.ts, r);
  }
  return tsToRegime;
}

// TP/SL per signal kind
function exitParams(kind: SigKind): { tp: number; sl: number; maxBars: number } {
  switch (kind) {
    case 'V2': return { tp: 7, sl: -2.5, maxBars: 84 };
    case 'PANIC': return { tp: 7, sl: -3, maxBars: 42 };
    case 'BB_BOUNCE': return { tp: 5, sl: -2, maxBars: 42 };
  }
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; maxBars: number; kind: SigKind; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; kind: SigKind; }

function simulate(rawSignals: Signal[], barsByCoin: Map<string, CachedBar[]>, periodStartTs: number, periodEndTs: number) {
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
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason, kind: pos.kind });
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
      const ep = exitParams(sig.kind);
      const cashToUse = cash * POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      const tp = entryPrice * (1 + ep.tp / 100);
      const sl = entryPrice * (1 + ep.sl / 100);
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse, tp, sl, maxBars: ep.maxBars, kind: sig.kind });
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
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END', kind: pos.kind });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, mdd, finalCash, nV2: 0, nPanic: 0, nBB: 0 };
  const wins = trades.filter(t => t.profitKrw > 0);
  const losses = trades.filter(t => t.profitKrw <= 0);
  const wr = wins.length / n * 100;
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
  const nV2 = trades.filter(t => t.kind === 'V2').length;
  const nPanic = trades.filter(t => t.kind === 'PANIC').length;
  const nBB = trades.filter(t => t.kind === 'BB_BOUNCE').length;
  return { n, wr, total, pf, mdd, finalCash, nV2, nPanic, nBB };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

// Build hybrid signal sets
function buildHybridSigs(
  barsByCoin: Map<string, CachedBar[]>,
  btcRegime: Map<number, 'bull' | 'bear'>,
  mode: 'BASE' | 'H1' | 'H2' | 'H3' | 'H4' | 'H5',
): Signal[] {
  const all: Signal[] = [];
  for (const coin of barsByCoin.keys()) {
    const bars = barsByCoin.get(coin)!;
    const v2Sigs = sigV2(bars, coin);
    if (mode === 'BASE') {
      for (const s of v2Sigs) all.push(s);
      continue;
    }
    const panicDrop = mode === 'H2' ? -3 : mode === 'H3' ? -7 : -5;
    const panicSigs = sigPanic(bars, coin, panicDrop);
    const bbSigs = mode === 'H5' ? sigBBBounce(bars, coin) : [];

    // bull = V2, bear = mode별 다름
    for (const s of v2Sigs) {
      if (btcRegime.get(s.ts) === 'bull') all.push(s);
      else if (mode === 'H4') all.push(s); // H4 = bear에도 V2 추가
    }
    // bear에서 PANIC/BB 추가
    for (const s of panicSigs) {
      if (btcRegime.get(s.ts) === 'bear') all.push(s);
    }
    for (const s of bbSigs) {
      if (btcRegime.get(s.ts) === 'bear') all.push(s);
    }
  }
  return all.sort((a, b) => a.ts - b.ts);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R39 Regime switch hybrid ===\n`);

  const bars4y = new Map<string, CachedBar[]>();
  for (const c of COINS_4Y) { const b = load4hBars(c, ['2022-06-10_2023-06-10','2023-06-10_2024-06-10','2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 8000) bars4y.set(c, b); }
  const bars2y = new Map<string, CachedBar[]>();
  for (const c of COINS_2Y) { const b = load4hBars(c, ['2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 4000) bars2y.set(c, b); }
  console.log(`Loaded 4y: ${bars4y.size}, 2y: ${bars2y.size}`);

  const btcRegime4y = buildBtcRegime(bars4y.get('BTC')!);
  const btcRegime2y = buildBtcRegime(bars2y.get('BTC')!);

  const modes: ('BASE'|'H1'|'H2'|'H3'|'H4'|'H5')[] = ['BASE','H1','H2','H3','H4','H5'];
  const modeNames: Record<string, string> = {
    'BASE': 'V2_BASE ★',
    'H1':   'H1 SWITCH (panic -5%)',
    'H2':   'H2 SWITCH_LOOSE (-3%)',
    'H3':   'H3 SWITCH_DEEP (-7%)',
    'H4':   'H4 SWITCH_BOTH (V2+P)',
    'H5':   'H5 SWITCH_MR (P+BB)',
  };

  const sigs4y: Record<string, Signal[]> = {};
  const sigs2y: Record<string, Signal[]> = {};
  for (const m of modes) {
    sigs4y[m] = buildHybridSigs(bars4y, btcRegime4y, m);
    sigs2y[m] = buildHybridSigs(bars2y, btcRegime2y, m);
  }

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R39 Regime switch — bull=V2, bear=PANIC/BB (5 변형 + BASE 비교)`);
  L.push(`4Y (15코인) + 2Y (28코인)`);
  L.push('='.repeat(170));

  for (const [pname, ps, pe, barsByCoin, sigSet] of [
    ['4Y (15코인)', '2022-06-10', '2026-06-10', bars4y, sigs4y],
    ['2Y (28코인)', '2024-06-10', '2026-06-10', bars2y, sigs2y],
  ] as const) {
    const pStart = new Date(`${ps}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${pe}T23:59:59+09:00`).getTime();
    L.push(`\n## ${pname}\n`);
    L.push(`${pad('variant', 24)} | ${padS('n', 5)} | ${padS('V2/P/BB', 11)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
    L.push('-'.repeat(95));
    const stats: { name: string; stats: ReturnType<typeof statsFor> }[] = [];
    for (const m of modes) {
      const r = simulate(sigSet[m], barsByCoin, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      stats.push({ name: modeNames[m], stats: s });
    }
    for (const r of stats) {
      const pass = r.stats.pf >= 1.2 && r.stats.total > 0;
      const kindStr = `${r.stats.nV2}/${r.stats.nPanic}/${r.stats.nBB}`;
      L.push(`${pad(r.name, 24)} | ${padS(String(r.stats.n), 5)} | ${padS(kindStr, 11)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 9)} | ${padS(r.stats.pf.toFixed(2), 5)} | ${padS(r.stats.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
    }
  }

  // 약세장 분기 4Y 상세
  L.push(`\n## 약세장 분기 (4Y) 비교\n`);
  const bearQuarters = [
    { name: 'Q2 22-09', start: '2022-09-10', end: '2022-12-10' },
    { name: 'Q3 22-12', start: '2022-12-10', end: '2023-03-10' },
    { name: 'Q4 23-03', start: '2023-03-10', end: '2023-06-10' },
    { name: 'Q7 23-12', start: '2023-12-10', end: '2024-03-10' },
    { name: 'Q8 24-03', start: '2024-03-10', end: '2024-06-10' },
  ];
  L.push(`${pad('variant', 24)} | ${bearQuarters.map(q => padS(q.name, 11)).join(' | ')}`);
  L.push('-'.repeat(120));
  for (const m of modes) {
    const cells: string[] = [];
    for (const q of bearQuarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const r = simulate(sigs4y[m], bars4y, ps, pe);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      cells.push(padS(fmt(s.total), 11));
    }
    L.push(`${pad(modeNames[m], 24)} | ${cells.join(' | ')}`);
  }

  // 강세장 분기 4Y (V2 알파 손상 없는지)
  L.push(`\n## 강세장 분기 (4Y) 비교 (V2 알파 손상 X 확인)\n`);
  const bullQuarters = [
    { name: 'Q1 22-06', start: '2022-06-10', end: '2022-09-10' },
    { name: 'Q5 23-06', start: '2023-06-10', end: '2023-09-10' },
    { name: 'Q6 23-09', start: '2023-09-10', end: '2023-12-10' },
    { name: 'Q9 24-06', start: '2024-06-10', end: '2024-09-10' },
    { name: 'Q10 24-09', start: '2024-09-10', end: '2024-12-10' },
    { name: 'Q13 25-06', start: '2025-06-10', end: '2025-09-10' },
    { name: 'Q14 25-09', start: '2025-09-10', end: '2025-12-10' },
    { name: 'Q16 26-03', start: '2026-03-10', end: '2026-06-10' },
  ];
  L.push(`${pad('variant', 24)} | ${bullQuarters.map(q => padS(q.name, 11)).join(' | ')}`);
  L.push('-'.repeat(140));
  for (const m of modes) {
    const cells: string[] = [];
    for (const q of bullQuarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const r = simulate(sigs4y[m], bars4y, ps, pe);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      cells.push(padS(fmt(s.total), 11));
    }
    L.push(`${pad(modeNames[m], 24)} | ${cells.join(' | ')}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R39_REGIME.txt`), L.join('\n'));
  process.exit(0);
})();
