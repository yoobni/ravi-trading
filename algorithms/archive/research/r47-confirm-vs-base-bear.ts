/**
 * R47 — "약세 방어가 잘 되는 것"의 정체 규명.
 *
 * R46 결론: 시장 regime(bull/bear) 필터는 방어 못 함 (F6 손실은 BTC 약세장이 아니라 chop에서 발생).
 * 가설: chop(거짓돌파)을 직접 거르는 F6_v3(CONFIRM)이 진짜 약세/횡보 방어다.
 *
 * F6_v2 (현 paper)  : follow-through bar 진입, TP+7/SL-2.5, pos33%×3
 * F6_v3 (CONFIRM)   : 확인봉(거짓돌파 아님 확정) 다음 진입, TP+10/SL-3, pos25%×4
 *
 * 16분기 walk-forward, 약세분기(BTC<0) vs 강세분기 분리 + MDD 비교. lookahead-safe.
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

const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(coin: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(fp)) return [];
  return (JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBar[]).sort((a, b) => a.ts - b.ts);
}
function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += v[j]; s2 += v[j]*v[j]; }
  const m = s / w, sd = Math.sqrt(Math.max(s2/w - m*m, 1e-12));
  return sd > 0 ? (v[i] - m) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; } // barIdx = 진입 직전 bar (entry = barIdx+1)

function sigF6v2(bars: CachedBar[], coin: string): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let i = LOOKBACK + 1; i < bars.length; i++) {
    let mx = -Infinity;
    for (let j = i - LOOKBACK; j < i - 1; j++) if (bars[j].high > mx) mx = bars[j].high;
    if (!(bars[i-1].high > mx)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function sigF6v3(bars: CachedBar[], coin: string): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let L = LOOKBACK + 3; L < bars.length; L++) {
    const i = L - 1;
    let mx = -Infinity;
    for (let j = i - LOOKBACK; j < i - 1; j++) if (bars[j].high > mx) mx = bars[j].high;
    if (!(bars[i-1].high > mx)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30);
    if (z == null || z < 0.5) continue;
    if (!(bars[L].close > bars[i].high)) continue;   // 확인봉: 신고가봉 고가 위 마감
    if (!(bars[L].close > bars[L].open)) continue;    // 확인봉 양봉
    out.push({ coin, barIdx: L, ts: bars[L].ts });    // entry = L+1
  }
  return out;
}

interface Cfg { name: string; tp: number; sl: number; pos: number; maxC: number; maxBars: number; sig: (b: CachedBar[], c: string) => Signal[]; }
const CFGS: Cfg[] = [
  { name: 'F6_v2 (TP7/SL2.5) ★paper', tp: 7,  sl: -2.5, pos: 0.33, maxC: 3, maxBars: 84, sig: sigF6v2 },
  { name: 'F6_v3 CONFIRM (TP10/SL3)', tp: 10, sl: -3,   pos: 0.25, maxC: 4, maxBars: 84, sig: sigF6v3 },
];

interface Pos { coin: string; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; }
function simulate(cfg: Cfg, signals: Signal[], barsByCoin: Map<string, CachedBar[]>, idxByCoinTs: Map<string, Map<number, number>>, ps: number, pe: number) {
  let cash = INITIAL_CASH; const positions: Pos[] = []; let win = 0, lossSum = 0, winSum = 0, n = 0;
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
      if (b.low <= p.sl) { xp = p.sl; hit = true; }
      else if (b.high >= p.tp) { xp = p.tp; hit = true; }
      else if (hold >= cfg.maxBars) { xp = b.close; hit = true; }
      if (hit) { const cg = p.vol * xp * (1 - COST_RT/2); cash += cg; close(cg - p.cashUsed); positions.splice(q, 1); }
    }
    for (const s of (sigByTs.get(ts) || [])) {
      if (positions.length >= cfg.maxC) break;
      const bars = barsByCoin.get(s.coin); if (!bars) continue;
      const ei = s.barIdx + 1; if (ei >= bars.length) continue;
      const ep = bars[ei].open; const use = cash * cfg.pos; if (use < 5000) continue;
      cash -= use;
      positions.push({ coin: s.coin, entryIdx: ei, entryPrice: ep, vol: use*(1-COST_RT/2)/ep, cashUsed: use, tp: ep*(1+cfg.tp/100), sl: ep*(1+cfg.sl/100) });
    }
    let ov = 0;
    for (const p of positions) { const idx = idxByCoinTs.get(p.coin)!.get(ts); if (idx != null) ov += p.vol * barsByCoin.get(p.coin)![idx].close; }
    const eq = cash + ov; if (eq > peak) peak = eq; const dd = (peak - eq)/peak*100; if (dd > mdd) mdd = dd;
  }
  for (const p of positions) {
    const bars = barsByCoin.get(p.coin)!; let li = bars.length - 1;
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= pe) { li = i; break; }
    const cg = p.vol * bars[li].close * (1 - COST_RT/2); cash += cg; close(cg - p.cashUsed);
  }
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n, wr: n ? win/n*100 : 0, total: (cash - INITIAL_CASH)/INITIAL_CASH*100, pf, mdd };
}
function fmt(n: number, s = true) { return `${s && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const c of COINS) { const b = loadBars(c); if (b.length >= 8000) barsByCoin.set(c, b); }
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) { const m = new Map<number, number>(); for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i); idxByCoinTs.set(coin, m); }
  const btc = barsByCoin.get('BTC')!;

  const sigsByCfg = CFGS.map(cfg => { const a: Signal[] = []; for (const c of barsByCoin.keys()) for (const s of cfg.sig(barsByCoin.get(c)!, c)) a.push(s); return a; });

  const L: string[] = [];
  L.push('='.repeat(110));
  L.push(`R47 — F6_v2(현 paper) vs F6_v3(CONFIRM) 약세 방어 비교, ${barsByCoin.size}코인 4년`);
  L.push(`신호수: F6_v2=${sigsByCfg[0].length}, F6_v3=${sigsByCfg[1].length}`);
  L.push('='.repeat(110));

  // 4Y / 2Y / 1Y
  for (const [nm, st] of [['4Y','2022-06-10'],['2Y','2024-06-10'],['1Y','2025-06-10']] as const) {
    const ps = new Date(`${st}T00:00:00+09:00`).getTime(), pe = new Date('2026-06-10T23:59:59+09:00').getTime();
    L.push(`\n## ${nm}\n${pad('strategy',28)} | ${padS('n',4)} | ${padS('WR',5)} | ${padS('total',10)} | ${padS('PF',5)} | ${padS('MDD',7)}`);
    L.push('-'.repeat(72));
    CFGS.forEach((cfg, k) => { const r = simulate(cfg, sigsByCfg[k], barsByCoin, idxByCoinTs, ps, pe);
      L.push(`${pad(cfg.name,28)} | ${padS(String(r.n),4)} | ${padS(r.wr.toFixed(0)+'%',5)} | ${padS(fmt(r.total),10)} | ${padS(r.pf.toFixed(2),5)} | ${padS(r.mdd.toFixed(1)+'%',7)}`); });
  }

  // 분기
  const sd = new Date('2022-06-10'); const quarters: { name: string; start: number; end: number; bear: boolean }[] = [];
  for (let q = 0; q < 16; q++) {
    const s = new Date(sd); s.setMonth(s.getMonth() + q*3); const e = new Date(s); e.setMonth(e.getMonth()+3);
    const ps = new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(), pe = new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime();
    let f: number|null=null, l: number|null=null; for (const b of btc) if (b.ts>=ps&&b.ts<=pe){ if(f==null)f=b.close; l=b.close; }
    quarters.push({ name:`Q${q+1}`, start:ps, end:pe, bear: f!=null&&l!=null ? (l-f)/f*100<0 : false });
  }
  L.push(`\n## 16분기 total% (B=약세분기)\n${pad('strategy',28)} |${quarters.map(q=>padS((q.bear?'B':'')+q.name.replace('Q',''),5)).join('')}`);
  L.push('-'.repeat(110));
  const agg: any = {};
  CFGS.forEach((cfg,k) => {
    const cells: string[]=[]; let bear=0,bull=0,pc=0,bearMdd=0;
    for (const q of quarters){ const r=simulate(cfg,sigsByCfg[k],barsByCoin,idxByCoinTs,q.start,q.end);
      cells.push(padS(r.total.toFixed(0),5)); if(q.bear){bear+=r.total; if(r.mdd>bearMdd)bearMdd=r.mdd;} else bull+=r.total; if(r.pf>=1.2&&r.total>0)pc++; }
    agg[cfg.name]={bear,bull,pc,bearMdd}; L.push(`${pad(cfg.name,28)} |${cells.join('')}`);
  });
  L.push(`\n## 요약\n${pad('strategy',28)} | ${padS('약세Σ',9)} | ${padS('강세Σ',9)} | ${padS('약세최대MDD',11)} | ${padS('pass/16',8)}`);
  L.push('-'.repeat(80));
  CFGS.forEach(cfg => { const a=agg[cfg.name]; L.push(`${pad(cfg.name,28)} | ${padS(fmt(a.bear),9)} | ${padS(fmt(a.bull),9)} | ${padS(a.bearMdd.toFixed(1)+'%',11)} | ${padS(a.pc+'/16',8)}`); });
  L.push(`\n약세분기: ${quarters.filter(q=>q.bear).map(q=>q.name).join(',')}`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R47_CONFIRM_VS_BASE.txt`), L.join('\n'));
  process.exit(0);
})();
