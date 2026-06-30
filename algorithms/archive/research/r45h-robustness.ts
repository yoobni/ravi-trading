/**
 * R45h — CONFIRM+TP10/SL3 견고성 + 실전리스크 검증 (4년 4h).
 * ★ 읽기 전용. 운영 paper 안 건드림. 결정론적(Math.random 미사용, 시드 LCG).
 *
 * 1) Monte Carlo: 거래 부트스트랩 1000회 → PF/누적 분포(운빨 의존도)
 * 2) 코인 제거: top1/top3 기여 코인 빼도 유지되나 (코인 의존도)
 * 3) 비용/슬리피지 민감도: cost 0.1~0.5%, 진입 슬립 0~0.5% (타이밍 민감 → 실전 비용)
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL=10_000_000, MAXBARS=84, LB=42, POS=0.33, MC=3, TP=10, SL=-3;
const FROM='2022-06-10', TO='2026-06-10';
const COINS=['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v:number[],i:number,w=30):number|null{ if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null; }
function f6Bars(bars:CachedBar[]):number[]{ const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm)pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i);} return out; }
interface Entry{coin:string;entryIdx:number;ts:number;}
function confirmEntries(barsByCoin:Map<string,CachedBar[]>):Entry[]{
  const out:Entry[]=[]; for(const [coin,bars] of barsByCoin){ for(const i of f6Bars(bars)){ if(i+2>=bars.length)continue;
    if(bars[i+1].close>bars[i].high&&bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:i+2,ts:bars[i+1].ts}); } } return out; }
function simulate(entries:Entry[],barsByCoin:Map<string,CachedBar[]>,cost:number,entrySlip:number,ps:number,pe:number){
  let cash=INITIAL; const positions:any[]=[]; const trades:any[]=[];
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  let peak=INITIAL,mdd=0;
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx; let ep=0,r:string|null=null;
      if(b.low<=pos.sl){ep=pos.sl;r='SL';} else if(b.high>=pos.tp){ep=pos.tp;r='TP';} else if(hb>=MAXBARS){ep=b.close;r='TIME';}
      if(r){ const cg=pos.vol*ep*(1-cost/2); cash+=cg; trades.push({coin:pos.coin,profitKrw:cg-pos.cashUsed}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=MC)break; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open*(1+entrySlip); const ctu=cash*POS; if(ctu<5000)continue; const vol=ctu*(1-cost/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,vol,cashUsed:ctu,tp:ep*(1+TP/100),sl:ep*(1+SL/100)}); }
    let ov=0; for(const pos of positions){ const idx=idxMap.get(pos.coin)!.get(ts); if(idx!=null) ov+=pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq=cash+ov; if(eq>peak)peak=eq; const dd=(peak-eq)/peak*100; if(dd>mdd)mdd=dd;
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-cost/2); cash+=cg; trades.push({coin:pos.coin,profitKrw:cg-pos.cashUsed}); }
  return {trades,finalCash:cash,mdd};
}
function pfTotal(t:any[],fc:number){ const w=t.filter(x=>x.profitKrw>0),l=t.filter(x=>x.profitKrw<=0); const tw=w.reduce((s,x)=>s+x.profitKrw,0),tl=Math.abs(l.reduce((s,x)=>s+x.profitKrw,0)); return {pf:tl>0?tw/tl:99,total:(fc-INITIAL)/INITIAL*100,wr:t.length?w.length/t.length*100:0}; }
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const all=new Map<string,CachedBar[]>(); for(const c of COINS){ const b=await fetchMinutesCached(`KRW-${c}`,240,FROM,TO); if(b.length>=8000) all.set(c,b); }
  const ps=new Date('2022-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();
  const baseEntries=confirmEntries(all);
  const base=simulate(baseEntries,all,0.001,0,ps,pe); const bs=pfTotal(base.trades,base.finalCash);
  const L:string[]=[]; L.push('='.repeat(80)); L.push(`R45h — CONFIRM+TP10/SL3 견고성 (4년 ${all.size}코인)`); L.push(`기준: total +${bs.total.toFixed(1)}%, PF ${bs.pf.toFixed(2)}, WR ${bs.wr.toFixed(0)}%, n ${base.trades.length}`); L.push('='.repeat(80));

  // 1) Monte Carlo: 거래 netRet(=profitKrw/cashUsed 근사 위해 profitKrw 부트스트랩 복리) — 결정론 LCG
  L.push(`\n## 1) Monte Carlo (거래 부트스트랩 1000회) — 운빨 의존도`);
  const rets=base.trades.map(t=>t.profitKrw/(INITIAL*POS)); // 거래당 자본대비 수익률 근사
  let seed=12345; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  const totals:number[]=[]; const N=base.trades.length;
  for(let it=0;it<1000;it++){ let eq=1; for(let k=0;k<N;k++){ const r=rets[Math.floor(rnd()*N)]; eq*=(1+r*POS); } totals.push((eq-1)*100); }
  totals.sort((a,b)=>a-b);
  const pct=(p:number)=>totals[Math.floor(p/100*totals.length)];
  const posRate=totals.filter(x=>x>0).length/totals.length*100;
  L.push(`  누적수익 분포: P5 ${pct(5).toFixed(0)}% | P50 ${pct(50).toFixed(0)}% | P95 ${pct(95).toFixed(0)}%`);
  L.push(`  양수 시나리오 비율: ${posRate.toFixed(1)}%  ${posRate>=95?'✓ 견고':posRate>=80?'△':'✗ 취약'}`);

  // 2) 코인 제거
  L.push(`\n## 2) 코인 제거 (top 기여 코인 빼도 유지?)`);
  const byCoin=new Map<string,number>(); for(const t of base.trades) byCoin.set(t.coin,(byCoin.get(t.coin)||0)+t.profitKrw);
  const ranked=[...byCoin.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  for(const [label,drop] of [['top1 제외',ranked.slice(0,1)],['top3 제외',ranked.slice(0,3)],['top5 제외',ranked.slice(0,5)]] as [string,string[]][]){
    const sub=new Map([...all].filter(([c])=>!drop.includes(c)));
    const r=simulate(confirmEntries(sub),sub,0.001,0,ps,pe); const s=pfTotal(r.trades,r.finalCash);
    L.push(`  ${pad(label,10)} (${drop.join(',')}) → total ${padS((s.total>=0?'+':'')+s.total.toFixed(0)+'%',7)} PF ${s.pf.toFixed(2)} MDD ${r.mdd.toFixed(0)}%`);
  }

  // 3) 비용/슬리피지 민감도
  L.push(`\n## 3) 비용·슬리피지 민감도 (타이밍 민감 리스크 → 실전 비용)`);
  L.push(`  ${pad('시나리오',22)} | ${padS('total',8)} | ${padS('PF',5)} | ${padS('MDD',5)}`);
  L.push('  '+'-'.repeat(50));
  const scen:[string,number,number][]=[['기본 (cost0.1%,slip0)',0.001,0],['cost0.2%',0.002,0],['cost0.3%',0.003,0],['slip+0.2%',0.001,0.002],['slip+0.5%',0.001,0.005],['cost0.3%+slip0.3%',0.003,0.003],['최악 cost0.5%+slip0.5%',0.005,0.005]];
  for(const [nm,cost,slip] of scen){ const r=simulate(baseEntries,all,cost,slip,ps,pe); const s=pfTotal(r.trades,r.finalCash);
    L.push(`  ${pad(nm,22)} | ${padS((s.total>=0?'+':'')+s.total.toFixed(0)+'%',8)} | ${padS(s.pf.toFixed(2),5)} | ${padS(r.mdd.toFixed(0)+'%',5)}`);
  }

  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45h_robustness.txt'),out);
  process.exit(0);
})();
