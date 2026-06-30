/**
 * R48 — 변동성/낙폭 기반 사이징 (F6_v3 CONFIRM 위에).
 *
 * R46/R37 교훈: binary on/off 필터는 alpha 통째로 날림.
 * 대안: 진입을 "건너뛰지 말고 작게". 위험한 regime(BTC 낙폭/고변동)일수록 포지션 축소.
 * 베이스 = F6_v3 (CONFIRM, TP10/SL3, pos25%×4) — 이미 MDD 9%대인데 더 깎을 여지 있나?
 *
 * 사이징 배수 m∈(0,1]을 진입 fraction(0.25)에 곱함. 신호봉 종가까지 정보만 사용(lookahead-safe).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const COST_RT = 0.001;
const LOOKBACK = 42;
const BASE_POS = 0.25, MAX_C = 4, TP = 10, SL = -3, MAX_BARS = 84;

const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(coin: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(fp)) return [];
  return (JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBar[]).sort((a, b) => a.ts - b.ts);
}
function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null;
  let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += v[j]; s2 += v[j]*v[j]; }
  const m = s / w, sd = Math.sqrt(Math.max(s2/w - m*m, 1e-12));
  return sd > 0 ? (v[i] - m) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; }
function sigF6v3(bars: CachedBar[], coin: string): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let L = LOOKBACK + 3; L < bars.length; L++) {
    const i = L - 1;
    let mx = -Infinity; for (let j = i - LOOKBACK; j < i - 1; j++) if (bars[j].high > mx) mx = bars[j].high;
    if (!(bars[i-1].high > mx)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30); if (z == null || z < 0.5) continue;
    if (!(bars[L].close > bars[i].high)) continue;
    if (!(bars[L].close > bars[L].open)) continue;
    out.push({ coin, barIdx: L, ts: bars[L].ts });
  }
  return out;
}
function sma(bars: CachedBar[], w: number): (number|null)[] {
  const o: (number|null)[] = new Array(bars.length).fill(null); let s = 0;
  for (let i = 0; i < bars.length; i++) { s += bars[i].close; if (i >= w) s -= bars[i-w].close; if (i >= w-1) o[i] = s/w; }
  return o;
}

// 사이징 스킴: (btc regime at signal ts) → multiplier
interface SizeScheme { name: string; m: (r: { dd: number; vol: number; belowSma50: boolean; medVol: number }) => number; }
const SCHEMES: SizeScheme[] = [
  { name: 'BASE fixed 25%',        m: () => 1 },
  { name: 'DD-tier (낙폭)',         m: r => r.dd <= 5 ? 1 : r.dd <= 10 ? 0.6 : 0.35 },
  { name: 'InvVol target',         m: r => Math.max(0.35, Math.min(1, r.medVol / r.vol)) },
  { name: 'Combo DD×SMA50',        m: r => (r.dd <= 5 ? 1 : r.dd <= 10 ? 0.6 : 0.35) * (r.belowSma50 ? 0.6 : 1) },
];

interface Pos { coin: string; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; }
function simulate(scheme: SizeScheme, signals: Signal[], regimeBySig: Map<string, number>, barsByCoin: Map<string, CachedBar[]>, idxByCoinTs: Map<string, Map<number, number>>, ps: number, pe: number) {
  let cash = INITIAL_CASH; const positions: Pos[] = []; let win = 0, winSum = 0, lossSum = 0, n = 0;
  const filtered = signals.filter(s => s.ts >= ps && s.ts <= pe).sort((a, b) => a.ts - b.ts);
  const sigByTs = new Map<number, Signal[]>();
  for (const s of filtered) { if (!sigByTs.has(s.ts)) sigByTs.set(s.ts, []); sigByTs.get(s.ts)!.push(s); }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts >= ps && b.ts <= pe) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  let peak = INITIAL_CASH, mdd = 0;
  const close = (pnl: number) => { n++; if (pnl > 0) { win++; winSum += pnl; } else lossSum += Math.abs(pnl); };
  for (const ts of tsList) {
    for (let q = positions.length - 1; q >= 0; q--) {
      const p = positions[q]; const idx = idxByCoinTs.get(p.coin)!.get(ts); if (idx == null) continue;
      const b = barsByCoin.get(p.coin)![idx]; const hold = idx - p.entryIdx;
      let xp = 0, hit = false;
      if (b.low <= p.sl) { xp = p.sl; hit = true; } else if (b.high >= p.tp) { xp = p.tp; hit = true; } else if (hold >= MAX_BARS) { xp = b.close; hit = true; }
      if (hit) { const cg = p.vol * xp * (1 - COST_RT/2); cash += cg; close(cg - p.cashUsed); positions.splice(q, 1); }
    }
    for (const s of (sigByTs.get(ts) || [])) {
      if (positions.length >= MAX_C) break;
      const bars = barsByCoin.get(s.coin); if (!bars) continue;
      const ei = s.barIdx + 1; if (ei >= bars.length) continue;
      const ep = bars[ei].open;
      const mult = scheme === SCHEMES[0] ? 1 : (regimeBySig.get(`${s.coin}@${s.ts}`) ?? 1);
      const use = cash * BASE_POS * mult; if (use < 5000) continue;
      cash -= use;
      positions.push({ coin: s.coin, entryIdx: ei, entryPrice: ep, vol: use*(1-COST_RT/2)/ep, cashUsed: use, tp: ep*(1+TP/100), sl: ep*(1+SL/100) });
    }
    let ov = 0; for (const p of positions) { const idx = idxByCoinTs.get(p.coin)!.get(ts); if (idx != null) ov += p.vol * barsByCoin.get(p.coin)![idx].close; }
    const eq = cash + ov; if (eq > peak) peak = eq; const dd = (peak - eq)/peak*100; if (dd > mdd) mdd = dd;
  }
  for (const p of positions) { const bars = barsByCoin.get(p.coin)!; let li = bars.length-1; for (let i = bars.length-1; i>=0; i--) if (bars[i].ts<=pe){li=i;break;} const cg = p.vol*bars[li].close*(1-COST_RT/2); cash += cg; close(cg - p.cashUsed); }
  const pf = lossSum > 0 ? winSum/lossSum : (winSum > 0 ? 99 : 0);
  return { n, wr: n?win/n*100:0, total: (cash-INITIAL_CASH)/INITIAL_CASH*100, pf, mdd };
}
function fmt(n: number, s = true) { return `${s&&n>=0?'+':''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length>=w?s:s+' '.repeat(w-s.length); }
function padS(s: string, w: number) { return s.length>=w?s:' '.repeat(w-s.length)+s; }

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const c of COINS) { const b = loadBars(c); if (b.length >= 8000) barsByCoin.set(c, b); }
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) { const m = new Map<number, number>(); for (let i=0;i<bars.length;i++) m.set(bars[i].ts, i); idxByCoinTs.set(coin, m); }

  // BTC regime arrays
  const btc = barsByCoin.get('BTC')!; const btcIdx = idxByCoinTs.get('BTC')!;
  const btcSma50 = sma(btc, 50);
  const btcRets: number[] = btc.map((b, i) => i > 0 ? (b.close - btc[i-1].close)/btc[i-1].close : 0);
  const btcVol: (number|null)[] = btc.map((_, i) => {
    if (i < 30) return null; let s=0,s2=0; for (let j=i-30;j<i;j++){s+=btcRets[j];s2+=btcRets[j]*btcRets[j];} const m=s/30; return Math.sqrt(Math.max(s2/30-m*m,1e-12));
  });
  const volSorted = btcVol.filter((v): v is number => v != null).sort((a,b)=>a-b);
  const medVol = volSorted[Math.floor(volSorted.length/2)] || 0.02;

  const sigs: Signal[] = [];
  for (const c of barsByCoin.keys()) for (const s of sigF6v3(barsByCoin.get(c)!, c)) sigs.push(s);

  // regime multiplier per signal (per scheme computed inline; precompute raw regime metrics)
  function regimeMetrics(ts: number) {
    const i = btcIdx.get(ts);
    if (i == null) return { dd: 0, vol: medVol, belowSma50: false, medVol };
    let hi7 = -Infinity; for (let j = Math.max(0,i-41); j<=i; j++) if (btc[j].high > hi7) hi7 = btc[j].high;
    return { dd: (hi7-btc[i].close)/hi7*100, vol: btcVol[i] ?? medVol, belowSma50: btcSma50[i]!=null ? btc[i].close < btcSma50[i]! : false, medVol };
  }

  const L: string[] = [];
  L.push('='.repeat(96));
  L.push(`R48 — F6_v3(CONFIRM) 변동성/낙폭 사이징, ${barsByCoin.size}코인 4년 (signals=${sigs.length})`);
  L.push(`위험 regime일수록 포지션 축소 (skip 아님). medVol(BTC 4h ret stdev)=${(medVol*100).toFixed(2)}%`);
  L.push('='.repeat(96));

  for (const [nm, st] of [['4Y','2022-06-10'],['2Y','2024-06-10'],['1Y','2025-06-10']] as const) {
    const ps = new Date(`${st}T00:00:00+09:00`).getTime(), pe = new Date('2026-06-10T23:59:59+09:00').getTime();
    L.push(`\n## ${nm}\n${pad('scheme',22)} | ${padS('total',10)} | ${padS('PF',5)} | ${padS('MDD',7)} | ${padS('WR',5)} | ${padS('n',4)}`);
    L.push('-'.repeat(66));
    for (const sc of SCHEMES) {
      const rmap = new Map<string, number>();
      if (sc !== SCHEMES[0]) for (const s of sigs) rmap.set(`${s.coin}@${s.ts}`, sc.m(regimeMetrics(s.ts)));
      const r = simulate(sc, sigs, rmap, barsByCoin, idxByCoinTs, ps, pe);
      L.push(`${pad(sc.name,22)} | ${padS(fmt(r.total),10)} | ${padS(r.pf.toFixed(2),5)} | ${padS(r.mdd.toFixed(1)+'%',7)} | ${padS(r.wr.toFixed(0)+'%',5)} | ${padS(String(r.n),4)}`);
    }
  }
  // 약세분기 MDD
  const sd = new Date('2022-06-10'); const bq: {start:number;end:number}[] = [];
  for (let q=0;q<16;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3);
    const ps=new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(), pe=new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime();
    let f:number|null=null,l:number|null=null; for (const b of btc) if(b.ts>=ps&&b.ts<=pe){if(f==null)f=b.close;l=b.close;}
    if (f!=null&&l!=null&&(l-f)/f<0) bq.push({start:ps,end:pe}); }
  L.push(`\n## 약세분기(${bq.length}개) 각 MDD 최댓값\n${pad('scheme',22)} | ${padS('약세최대MDD',12)}`);
  L.push('-'.repeat(40));
  for (const sc of SCHEMES) {
    const rmap = new Map<string, number>();
    if (sc !== SCHEMES[0]) for (const s of sigs) rmap.set(`${s.coin}@${s.ts}`, sc.m(regimeMetrics(s.ts)));
    let worst = 0; for (const q of bq) { const r = simulate(sc, sigs, rmap, barsByCoin, idxByCoinTs, q.start, q.end); if (r.mdd > worst) worst = r.mdd; }
    L.push(`${pad(sc.name,22)} | ${padS(worst.toFixed(1)+'%',12)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R48_VOL_SIZING.txt`), L.join('\n'));
  process.exit(0);
})();
