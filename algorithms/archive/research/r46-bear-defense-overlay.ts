/**
 * R46 — 약세장 방어 regime 오버레이.
 *
 * 가설: F6_v2 신호/청산은 그대로 두고, "약세장 진입만" 시장 regime 게이트로 차단하면
 *       풀사이클 total 유지 + MDD 축소(특히 약세 분기 손실 방어)가 가능한가?
 *
 * R37 교훈: BTC EMA200/EMA50 단독 필터는 신호를 너무 줄여 alpha ↓ (강세 진입까지 차단).
 *           → 다른 regime 신호(낙폭/모멘텀/시장 breadth/콤보)로 재시도.
 *
 * 게이트는 신호봉(follow-through bar, bars[i]) 종가까지의 정보만 사용 → 진입(i+1 open) 전 확정. lookahead-safe.
 * 모든 변형 exit = F6_v2 (TP+7/SL-2.5/84bars), 사이징 동일. 필터가 셀수록 현금 비중↑(= 방어).
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
const TP = 7, SL = -2.5, MAX_BARS = 84; // F6_v2

const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(coin: string): CachedBar[] {
  const seen = new Set<number>(); const all: CachedBar[] = [];
  for (const yf of ['2022-06-10_2026-06-10','2024-06-10_2026-06-10']) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
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
function sigF6(bars: CachedBar[], coin: string): Signal[] {
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

// ─── Regime helpers (per-coin SMA, indexed by ts) ───
function smaArray(bars: CachedBar[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= window) sum -= bars[i - window].close;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

interface RegimeFlags {
  aboveSma50: boolean;   // BTC close > SMA50 (8d)
  aboveSma200: boolean;  // BTC close > SMA200 (33d)
  notCrash: boolean;     // BTC not >10% below 7d(42bar) high
  momUp: boolean;        // BTC close > close 20 bars ago
  breadthOk: boolean;    // >50% universe above own SMA50
}

interface Variant { name: string; gate: (f: RegimeFlags) => boolean; }
const VARIANTS: Variant[] = [
  { name: 'BASE (no filter) ★ paper', gate: () => true },
  { name: 'G1 BTC>SMA50',             gate: f => f.aboveSma50 },
  { name: 'G2 BTC>SMA200',            gate: f => f.aboveSma200 },
  { name: 'G3 BTC not -10% from 7dHi',gate: f => f.notCrash },
  { name: 'G4 BTC mom20>0',           gate: f => f.momUp },
  { name: 'G5 breadth>50%',           gate: f => f.breadthOk },
  { name: 'G6 SMA50 & notCrash',      gate: f => f.aboveSma50 && f.notCrash },
  { name: 'G7 breadth & notCrash',    gate: f => f.breadthOk && f.notCrash },
];

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

function simulate(signals: Signal[], barsByCoin: Map<string, CachedBar[]>, idxByCoinTs: Map<string, Map<number, number>>, periodStartTs: number, periodEndTs: number) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: Trade[] = [];
  const filtered = signals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, Signal[]>();
  for (const sig of [...filtered].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const b = barsByCoin.get(pos.coin)![idx];
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: Trade['reason'] | null = null;
      if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
      else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
      else if (holdBars >= MAX_BARS) { exitPrice = b.close; reason = 'TIME'; }
      if (reason) {
        const cashGained = pos.vol * exitPrice * (1 - COST_RT / 2);
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, profitKrw: cashGained - pos.cashUsed, reason });
        positions.splice(q, 1);
      }
    }
    for (const sig of (sigByTs.get(ts) || [])) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const entryPrice = bars[entryIdx].open;
      const cashToUse = cash * POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - COST_RT / 2) / entryPrice;
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: bars[entryIdx].ts, entryIdx, entryPrice, vol, cashUsed: cashToUse, tp: entryPrice * (1 + TP / 100), sl: entryPrice * (1 + SL / 100) });
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
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= periodEndTs) { lastIdx = i; break; }
    const cashGained = pos.vol * bars[lastIdx].close * (1 - COST_RT / 2);
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, profitKrw: cashGained - pos.cashUsed, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, mdd };
  const wins = trades.filter(t => t.profitKrw > 0);
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(trades.filter(t => t.profitKrw <= 0).reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  return { n, wr: wins.length / n * 100, total: (finalCash - INITIAL_CASH) / INITIAL_CASH * 100, pf, mdd };
}
function fmt(n: number, s = true): string { return `${s && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R46 약세장 방어 regime 오버레이 ===\n`);

  const barsByCoin = new Map<string, CachedBar[]>();
  for (const c of COINS) { const b = loadBars(c); if (b.length >= 8000) barsByCoin.set(c, b); }
  console.log(`${barsByCoin.size} coins loaded`);

  const idxByCoinTs = new Map<string, Map<number, number>>();
  const sma50ByCoin = new Map<string, (number | null)[]>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
    sma50ByCoin.set(coin, smaArray(bars, 50));
  }

  // BTC regime arrays
  const btc = barsByCoin.get('BTC')!;
  const btcIdx = idxByCoinTs.get('BTC')!;
  const btcSma50 = smaArray(btc, 50);
  const btcSma200 = smaArray(btc, 200);

  function breadthAt(ts: number): boolean {
    let above = 0, total = 0;
    for (const [coin, bars] of barsByCoin) {
      const i = idxByCoinTs.get(coin)!.get(ts);
      if (i == null) continue;
      const s = sma50ByCoin.get(coin)![i];
      if (s == null) continue;
      total++; if (bars[i].close > s) above++;
    }
    return total > 0 && above / total > 0.5;
  }
  function regimeAt(ts: number): RegimeFlags {
    const i = btcIdx.get(ts);
    if (i == null) return { aboveSma50: true, aboveSma200: true, notCrash: true, momUp: true, breadthOk: true };
    const c = btc[i].close;
    let hi7 = -Infinity;
    for (let j = Math.max(0, i - 41); j <= i; j++) if (btc[j].high > hi7) hi7 = btc[j].high;
    const dd = (hi7 - c) / hi7 * 100;
    return {
      aboveSma50: btcSma50[i] != null ? c > btcSma50[i]! : true,
      aboveSma200: btcSma200[i] != null ? c > btcSma200[i]! : true,
      notCrash: dd <= 10,
      momUp: i >= 20 ? c > btc[i - 20].close : true,
      breadthOk: breadthAt(ts),
    };
  }

  // signals + regime flags
  const sigs: (Signal & { flags: RegimeFlags })[] = [];
  for (const c of barsByCoin.keys()) for (const s of sigF6(barsByCoin.get(c)!, c)) sigs.push({ ...s, flags: regimeAt(s.ts) });
  console.log(`F6 signals: ${sigs.length}`);

  const L: string[] = [];
  L.push('='.repeat(120));
  L.push(`R46 약세장 방어 오버레이 — F6_v2(TP7/SL-2.5/84) 신호에 시장 regime 게이트, ${barsByCoin.size}코인`);
  L.push(`목표: 풀사이클 total 유지 + MDD↓ (특히 약세 분기). R37 EMA단독 실패 → 낙폭/모멘텀/breadth/콤보 재시도`);
  L.push('='.repeat(120));

  const periods = [
    { name: '1Y (25-06~26-06)', start: '2025-06-10', end: '2026-06-10' },
    { name: '2Y (24-06~26-06)', start: '2024-06-10', end: '2026-06-10' },
    { name: '4Y (22-06~26-06)', start: '2022-06-10', end: '2026-06-10' },
  ];
  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    L.push(`\n## ${period.name}\n`);
    L.push(`${pad('variant', 28)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 10)} | ${padS('PF', 5)} | ${padS('MDD', 7)} | pass`);
    L.push('-'.repeat(80));
    for (const v of VARIANTS) {
      const r = simulate(sigs.filter(s => v.gate(s.flags)), barsByCoin, idxByCoinTs, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      L.push(`${pad(v.name, 28)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 10)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 7)} | ${pass ? '✓' : ''}`);
    }
  }

  // 분기 walk-forward + 약세/강세 분리
  const sd = new Date('2022-06-10');
  const quarters: { name: string; start: number; end: number; btcRet: number }[] = [];
  for (let q = 0; q < 16; q++) {
    const s = new Date(sd); s.setMonth(s.getMonth() + q * 3);
    const e = new Date(s); e.setMonth(e.getMonth() + 3);
    const ps = new Date(s.toISOString().slice(0,10) + 'T00:00:00+09:00').getTime();
    const pe = new Date(e.toISOString().slice(0,10) + 'T23:59:59+09:00').getTime();
    // BTC return over quarter
    let first: number | null = null, last: number | null = null;
    for (const b of btc) { if (b.ts >= ps && b.ts <= pe) { if (first == null) first = b.close; last = b.close; } }
    const btcRet = first != null && last != null ? (last - first) / first * 100 : 0;
    quarters.push({ name: `Q${q+1}`, start: ps, end: pe, btcRet });
  }

  L.push(`\n## 4년 분기 walk-forward (16Q) — total% per quarter (B=약세분기 BTC<0)\n`);
  L.push(`${pad('variant', 28)} | ${quarters.map(q => padS((q.btcRet < 0 ? 'B' : '') + q.name.replace('Q',''), 5)).join('')}`);
  L.push('-'.repeat(120));
  const bearTotals: Record<string, number> = {};
  const bullTotals: Record<string, number> = {};
  const passCounts: Record<string, number> = {};
  for (const v of VARIANTS) {
    const cells: string[] = [];
    let bearSum = 0, bullSum = 0, pc = 0;
    for (const q of quarters) {
      const r = simulate(sigs.filter(s => v.gate(s.flags)), barsByCoin, idxByCoinTs, q.start, q.end);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      cells.push(padS(s.total.toFixed(0), 5));
      if (q.btcRet < 0) bearSum += s.total; else bullSum += s.total;
      if (s.pf >= 1.2 && s.total > 0) pc++;
    }
    bearTotals[v.name] = bearSum; bullTotals[v.name] = bullSum; passCounts[v.name] = pc;
    L.push(`${pad(v.name, 28)} |${cells.join('')}`);
  }

  L.push(`\n## 요약 — 약세분기 합 vs 강세분기 합 (방어 효과 핵심)\n`);
  L.push(`${pad('variant', 28)} | ${padS('약세Σ', 9)} | ${padS('강세Σ', 9)} | ${padS('pass/16', 8)}`);
  L.push('-'.repeat(70));
  for (const v of VARIANTS) {
    L.push(`${pad(v.name, 28)} | ${padS(fmt(bearTotals[v.name]), 9)} | ${padS(fmt(bullTotals[v.name]), 9)} | ${padS(String(passCounts[v.name]) + '/16', 8)}`);
  }
  const bearQ = quarters.filter(q => q.btcRet < 0).map(q => q.name).join(',');
  L.push(`\n약세 분기(${quarters.filter(q=>q.btcRet<0).length}개): ${bearQ}`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R46_BEAR_DEFENSE.txt`), L.join('\n'));
  process.exit(0);
})();
