/**
 * R44e — F6 volZ 후보 4년 OOS 검증. lookback 7일 고정, volZ {0.3, 0.5(현재), 1.5}.
 * ★ 읽기 전용. 운영 paper 안 건드림. 4h 4년 데이터 fetch(별도 캐시).
 *
 * R44d 2년 그리드에서 7일/1.5가 최고였음 → 과적합인지 4년+16분기+연도별로 검증.
 * TP+5/SL-2/MAX84 고정, pos 33%×3, cost 0.1%. 4년치 있는 코인만 공통풀.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL_CASH = 10_000_000, POSITION_PCT = 0.33, MAX_CONCURRENT = 3, COST_RT = 0.001;
const FROM = '2022-06-10', TO = '2026-06-10';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const LOOKBACK_BAR = 42, MAXBARS = 84;

function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += v[j]; s2 += v[j]*v[j]; }
  const m = s / w; const sd = Math.sqrt(Math.max((s2/w) - m*m, 1e-12)); return sd > 0 ? (v[i] - m) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; }
function sigF6(bars: CachedBar[], coin: string, volZThresh: number): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let i = LOOKBACK_BAR + 1; i < bars.length; i++) {
    let pm = -Infinity; for (let j = i - LOOKBACK_BAR; j < i - 1; j++) if (bars[j].high > pm) pm = bars[j].high;
    if (!(bars[i-1].high > pm)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30); if (z == null || z < volZThresh) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function simulate(sigs: Signal[], barsByCoin: Map<string, CachedBar[]>, ps: number, pe: number) {
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
      if (b.low <= pos.sl) { ep = pos.sl; reason='SL'; } else if (b.high >= pos.tp) { ep = pos.tp; reason='TP'; } else if (hb >= pos.maxBars) { ep = b.close; reason='TIME'; }
      if (reason) { const cg = pos.vol*ep*(1-COST_RT/2); cash += cg; trades.push({ profitKrw: cg-pos.cashUsed }); positions.splice(q,1); }
    }
    for (const sig of (sigByTs.get(ts)||[])) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin); if (!bars) continue; const ei = sig.barIdx+1; if (ei>=bars.length) continue;
      const ep = bars[ei].open; const ctu = cash*POSITION_PCT; if (ctu<5000) continue;
      const vol = ctu*(1-COST_RT/2)/ep; cash -= ctu;
      positions.push({ coin: sig.coin, entryIdx: ei, entryPrice: ep, vol, cashUsed: ctu, tp: ep*1.05, sl: ep*0.98, maxBars: MAXBARS });
    }
    let ov = 0; for (const pos of positions) { const idx = idxMap.get(pos.coin)!.get(ts); if (idx!=null) ov += pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq = cash+ov; if (eq>peak) peak=eq; const dd=(peak-eq)/peak*100; if (dd>mdd) mdd=dd;
  }
  for (const pos of positions) { const bars = barsByCoin.get(pos.coin)!; let li=bars.length-1; for (let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({ profitKrw: cg-pos.cashUsed }); }
  return { trades, finalCash: cash, mdd };
}
function stats(t: any[], fc: number, mdd: number) {
  const n = t.length; if (!n) return { n:0, wr:0, total:0, pf:0, mdd };
  const w = t.filter(x=>x.profitKrw>0), l = t.filter(x=>x.profitKrw<=0);
  const tw = w.reduce((s,x)=>s+x.profitKrw,0), tl = Math.abs(l.reduce((s,x)=>s+x.profitKrw,0));
  return { n, wr: w.length/n*100, total: (fc-INITIAL_CASH)/INITIAL_CASH*100, pf: tl>0?tw/tl:(tw>0?99:0), mdd };
}
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
const T = (s:string)=> new Date(s+'T00:00:00+09:00').getTime();
const Te = (s:string)=> new Date(s+'T23:59:59+09:00').getTime();

(async () => {
  const bars = new Map<string, CachedBar[]>();
  for (const coin of COINS) {
    process.stdout.write(`fetch ${coin}...`);
    const b = await fetchMinutesCached(`KRW-${coin}`, 240, FROM, TO);
    console.log(` ${b.length}`);
    if (b.length >= 8000) bars.set(coin, b); // 4년(~8766) 거의 있는 코인만
  }
  console.log(`\n4년 공통풀: ${bars.size}코인`);

  const candidates = [{ name:'7일/0.3', vz:0.3 }, { name:'7일/0.5★현재', vz:0.5 }, { name:'7일/1.5', vz:1.5 }];
  // 16분기 (2022-06부터 3개월×16)
  const quarters: { name:string; s:number; e:number }[] = [];
  const sd = new Date('2022-06-10');
  for (let q=0;q<16;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push({ name:`Q${q+1}`, s:T(s.toISOString().slice(0,10)), e:Te(e.toISOString().slice(0,10)) }); }
  // 연도별
  const years = [['Y1 22-23','2022-06-10','2023-06-10'],['Y2 23-24','2023-06-10','2024-06-10'],['Y3 24-25','2024-06-10','2025-06-10'],['Y4 25-26','2025-06-10','2026-06-10']] as const;
  const fullS = T('2022-06-10'), fullE = Te('2026-06-10');

  const L: string[] = [];
  L.push('='.repeat(100));
  L.push(`R44e — F6 volZ 후보 4년 OOS (lookback 7일 고정, ${bars.size}코인 4년풀)`);
  L.push(`TP+5/SL-2/MAX84, pos 33%×3, cost 0.1%`);
  L.push('='.repeat(100));

  const rows: any[] = [];
  for (const c of candidates) {
    const sigs: Signal[] = []; for (const co of bars.keys()) for (const s of sigF6(bars.get(co)!, co, c.vz)) sigs.push(s);
    const rf = simulate(sigs, bars, fullS, fullE); const sf = stats(rf.trades, rf.finalCash, rf.mdd);
    let qp=0; for (const q of quarters){ const r=simulate(sigs,bars,q.s,q.e); const s=stats(r.trades,r.finalCash,r.mdd); if (s.pf>=1.2&&s.total>0) qp++; }
    const yr = years.map(([nm,s,e])=>{ const r=simulate(sigs,bars,T(s),Te(e)); const st=stats(r.trades,r.finalCash,r.mdd); return { nm, pf:st.pf, total:st.total }; });
    rows.push({ name:c.name, full:sf, qp, yr });
  }

  L.push(`\n## 4Y FULL\n`);
  L.push(`${pad('cand',14)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('4Y total',10)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',6)}`);
  L.push('-'.repeat(70));
  for (const r of rows) { const p=r.full.pf>=1.2&&r.full.total>0; L.push(`${pad(r.name,14)} | ${padS(String(r.full.n),5)} | ${padS(r.full.wr.toFixed(0)+'%',4)} | ${padS(fmt(r.full.total),10)} | ${padS(r.full.pf.toFixed(2),5)} | ${padS(r.full.mdd.toFixed(0)+'%',5)} | ${padS(r.qp+'/16',6)}${p?' ✓':''}`); }

  L.push(`\n## 연도별 OOS (PF / total)\n`);
  L.push(`${pad('cand',14)} | ${years.map(y=>padS(y[0],14)).join(' | ')}`);
  L.push('-'.repeat(80));
  for (const r of rows) L.push(`${pad(r.name,14)} | ${r.yr.map((y:any)=>padS(`${y.pf.toFixed(2)}/${fmt(y.total)}`,14)).join(' | ')}`);

  const out = L.join('\n'); console.log(out);
  const fs = await import('fs'); fs.writeFileSync(path.resolve('data/research','R44e_volz_oos.txt'), out);
  process.exit(0);
})();
