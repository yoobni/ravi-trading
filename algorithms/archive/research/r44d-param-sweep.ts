/**
 * R44d — F6 진입 파라미터 스윕 (4h 고정). lookback × volZ 2D 그리드.
 * ★ 읽기 전용. 운영 paper 안 건드림. 4h 네이티브 240m 캐시 재사용.
 *
 * lookback: 5/7/10/14일 (4h=6bar/일 → 30/42/60/84 bar). 현 paper=7일(42).
 * volZ:     0.3/0.5/0.8/1.0/1.5. 현 paper=0.5.
 * TP+5/SL-2/MAX84 고정, pos 33%×3, cost 0.1%. 28코인 2년.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL_CASH = 10_000_000, POSITION_PCT = 0.33, MAX_CONCURRENT = 3, COST_RT = 0.001;
const FROM = '2024-06-10', TO = '2026-06-10';
const COINS_28 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null;
  let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += v[j]; s2 += v[j]*v[j]; }
  const m = s / w; const sd = Math.sqrt(Math.max((s2/w) - m*m, 1e-12));
  return sd > 0 ? (v[i] - m) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; }
function sigF6(bars: CachedBar[], coin: string, lookback: number, volZThresh: number): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let pm = -Infinity; for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > pm) pm = bars[j].high;
    if (!(bars[i-1].high > pm)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30); if (z == null || z < volZThresh) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function simulate(maxBars: number, sigs: Signal[], barsByCoin: Map<string, CachedBar[]>, ps: number, pe: number) {
  let cash = INITIAL_CASH; const positions: any[] = []; const trades: any[] = [];
  const filtered = sigs.filter(s => s.ts >= ps && s.ts <= pe);
  const sigByTs = new Map<number, Signal[]>();
  for (const s of [...filtered].sort((a,b)=>a.ts-b.ts)) { if (!sigByTs.has(s.ts)) sigByTs.set(s.ts, []); sigByTs.get(s.ts)!.push(s); }
  const allTs = new Set<number>(); for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList = [...allTs].sort((a,b)=>a-b);
  const idxMap = new Map<string, Map<number, number>>();
  for (const [c, bars] of barsByCoin) { const m = new Map<number,number>(); for (let i=0;i<bars.length;i++) m.set(bars[i].ts, i); idxMap.set(c, m); }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length-1; q>=0; q--) {
      const pos = positions[q]; const idx = idxMap.get(pos.coin)!.get(ts); if (idx == null) continue;
      const b = barsByCoin.get(pos.coin)![idx]; const hb = idx - pos.entryIdx;
      let ep = 0, reason: string|null = null;
      if (b.low <= pos.sl) { ep = pos.sl; reason='SL'; }
      else if (b.high >= pos.tp) { ep = pos.tp; reason='TP'; }
      else if (hb >= pos.maxBars) { ep = b.close; reason='TIME'; }
      if (reason) { const cg = pos.vol*ep*(1-COST_RT/2); cash += cg; trades.push({ profitKrw: cg-pos.cashUsed }); positions.splice(q,1); }
    }
    for (const sig of (sigByTs.get(ts)||[])) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin); if (!bars) continue;
      const ei = sig.barIdx+1; if (ei>=bars.length) continue;
      const ep = bars[ei].open; const ctu = cash*POSITION_PCT; if (ctu<5000) continue;
      const vol = ctu*(1-COST_RT/2)/ep; cash -= ctu;
      positions.push({ coin: sig.coin, entryIdx: ei, entryPrice: ep, vol, cashUsed: ctu, tp: ep*1.05, sl: ep*0.98, maxBars });
    }
    let ov = 0; for (const pos of positions) { const idx = idxMap.get(pos.coin)!.get(ts); if (idx!=null) ov += pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq = cash+ov; if (eq>peak) peak=eq; const dd=(peak-eq)/peak*100; if (dd>mdd) mdd=dd;
  }
  for (const pos of positions) { const bars = barsByCoin.get(pos.coin)!; let li=bars.length-1; for (let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({ profitKrw: cg-pos.cashUsed }); }
  return { trades, finalCash: cash, mdd };
}
function stats(trades: any[], finalCash: number, mdd: number) {
  const n = trades.length; if (!n) return { n:0, wr:0, total:0, pf:0, mdd };
  const wins = trades.filter(t=>t.profitKrw>0), losses = trades.filter(t=>t.profitKrw<=0);
  const tw = wins.reduce((s,t)=>s+t.profitKrw,0), tl = Math.abs(losses.reduce((s,t)=>s+t.profitKrw,0));
  return { n, wr: wins.length/n*100, total: (finalCash-INITIAL_CASH)/INITIAL_CASH*100, pf: tl>0?tw/tl:(tw>0?99:0), mdd };
}
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async () => {
  const bars4h = new Map<string, CachedBar[]>();
  for (const coin of COINS_28) { const b = await fetchMinutesCached(`KRW-${coin}`, 240, FROM, TO); if (b.length>=4000) bars4h.set(coin, b); }
  const pool = bars4h.size;
  const ps = new Date('2024-06-10T00:00:00+09:00').getTime(), pe = new Date('2026-06-10T23:59:59+09:00').getTime();
  const quarters: [number,number][] = [];
  const sd = new Date('2024-06-10');
  for (let q=0;q<8;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push([new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(), new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime()]); }

  const LOOKBACKS = [{d:5,bar:30},{d:7,bar:42},{d:10,bar:60},{d:14,bar:84}];
  const VOLZS = [0.3,0.5,0.8,1.0,1.5];
  const MAXBARS = 84;

  // 결과 캐시: key = `${lb}_${vz}`
  const res = new Map<string, { pf:number; total:number; wr:number; mdd:number; n:number; qp:number }>();
  for (const lb of LOOKBACKS) for (const vz of VOLZS) {
    const sigs: Signal[] = []; for (const c of bars4h.keys()) for (const s of sigF6(bars4h.get(c)!, c, lb.bar, vz)) sigs.push(s);
    const r = simulate(MAXBARS, sigs, bars4h, ps, pe); const s = stats(r.trades, r.finalCash, r.mdd);
    let qp=0; for (const [qs,qe] of quarters){ const rr=simulate(MAXBARS,sigs,bars4h,qs,qe); const ss=stats(rr.trades,rr.finalCash,rr.mdd); if (ss.pf>=1.2&&ss.total>0) qp++; }
    res.set(`${lb.d}_${vz}`, { pf:s.pf, total:s.total, wr:s.wr, mdd:s.mdd, n:s.n, qp });
  }

  const L: string[] = [];
  L.push('='.repeat(90));
  L.push(`R44d — F6 진입 파라미터 스윕 (4h, 2년, ${pool}코인). 현 paper=7일/0.5★`);
  L.push(`TP+5/SL-2/MAX84 고정, pos 33%×3, cost 0.1%`);
  L.push('='.repeat(90));

  const grid = (title: string, pick: (r: any)=>string) => {
    L.push(`\n## ${title}  (행=lookback일, 열=volZ)\n`);
    L.push(`${padS('lb\\vZ',8)} | ${VOLZS.map(v=>padS(String(v),9)).join(' | ')}`);
    L.push('-'.repeat(8 + VOLZS.length*12));
    for (const lb of LOOKBACKS) {
      const cells = VOLZS.map(vz => { const r = res.get(`${lb.d}_${vz}`)!; const mark = (lb.d===7&&vz===0.5)?'★':' '; return padS(pick(r)+mark, 9); });
      L.push(`${padS(lb.d+'일('+lb.bar+')',8)} | ${cells.join(' | ')}`);
    }
  };
  grid('PF', r => r.pf.toFixed(2));
  grid('2Y total', r => fmt(r.total));
  grid('분기 pass /8', r => `${r.qp}/8`);
  grid('거래수 n', r => String(r.n));
  grid('MDD', r => r.mdd.toFixed(0)+'%');

  // 종합 점수: PF*분기 정렬 top
  L.push(`\n## 종합 (분기pass desc, PF desc) top 8\n`);
  L.push(`${padS('lb/volZ',10)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('total',8)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',5)}`);
  L.push('-'.repeat(60));
  const all = [...res.entries()].map(([k,v])=>({k,...v})).sort((a,b)=> b.qp-a.qp || b.pf-a.pf);
  for (const r of all.slice(0,8)) {
    const star = r.k==='7_0.5'?' ★현재':'';
    L.push(`${padS(r.k,10)} | ${padS(String(r.n),5)} | ${padS(r.wr.toFixed(0)+'%',4)} | ${padS(fmt(r.total),8)} | ${padS(r.pf.toFixed(2),5)} | ${padS(r.mdd.toFixed(0)+'%',5)} | ${padS(r.qp+'/8',5)}${star}`);
  }

  const out = L.join('\n'); console.log(out);
  const fs = await import('fs'); fs.writeFileSync(path.resolve('data/research','R44d_param_sweep.txt'), out);
  process.exit(0);
})();
