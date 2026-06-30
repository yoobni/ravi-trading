/**
 * R45e — CONFIRM 신호 고정, exit(TP/SL) + sizing 변형 4년 OOS.
 * ★ 읽기 전용. 운영 paper 안 건드림. 4h 4년 캐시 재사용.
 * 목표: CONFIRM(거짓돌파 확정)에 F6_v2식 넓은 TP/SL·사이징 적용 시 수익폭 개선되나.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL=10_000_000, COST_RT=0.001, MAXBARS=84, LB=42;
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

function simulate(entries:Entry[],barsByCoin:Map<string,CachedBar[]>,tp:number,sl:number,posPct:number,maxConc:number,ps:number,pe:number){
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
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({netRet:(ep-pos.entryPrice)/pos.entryPrice*100-COST_RT*100,profitKrw:cg-pos.cashUsed}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=maxConc)break; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open; const ctu=cash*posPct; if(ctu<5000)continue; const vol=ctu*(1-COST_RT/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,entryPrice:ep,vol,cashUsed:ctu,tp:ep*(1+tp/100),sl:ep*(1+sl/100)}); }
    let ov=0; for(const pos of positions){ const idx=idxMap.get(pos.coin)!.get(ts); if(idx!=null) ov+=pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq=cash+ov; if(eq>peak)peak=eq; const dd=(peak-eq)/peak*100; if(dd>mdd)mdd=dd;
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({netRet:(bars[li].close-pos.entryPrice)/pos.entryPrice*100-COST_RT*100,profitKrw:cg-pos.cashUsed}); }
  return {trades,finalCash:cash,mdd};
}
function stats(t:any[],fc:number,mdd:number){ const n=t.length; if(!n)return{n:0,wr:0,total:0,pf:0,mdd};
  const w=t.filter(x=>x.profitKrw>0),l=t.filter(x=>x.profitKrw<=0); const tw=w.reduce((s,x)=>s+x.profitKrw,0),tl=Math.abs(l.reduce((s,x)=>s+x.profitKrw,0));
  return{n,wr:w.length/n*100,total:(fc-INITIAL)/INITIAL*100,pf:tl>0?tw/tl:(tw>0?99:0),mdd}; }
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}
const T=(s:string)=>new Date(s+'T00:00:00+09:00').getTime(); const Te=(s:string)=>new Date(s+'T23:59:59+09:00').getTime();

(async()=>{
  const bars=new Map<string,CachedBar[]>(); for(const c of COINS){ const b=await fetchMinutesCached(`KRW-${c}`,240,FROM,TO); if(b.length>=8000) bars.set(c,b); }
  const entries=confirmEntries(bars);
  console.log(`4년 ${bars.size}코인, CONFIRM 신호 ${entries.length}`);
  const quarters:{s:number;e:number}[]=[]; const sd=new Date('2022-06-10');
  for(let q=0;q<16;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push({s:T(s.toISOString().slice(0,10)),e:Te(e.toISOString().slice(0,10))}); }
  const years=[['Y1','2022-06-10','2023-06-10'],['Y2약세','2023-06-10','2024-06-10'],['Y3','2024-06-10','2025-06-10'],['Y4','2025-06-10','2026-06-10']] as const;
  const fS=T('2022-06-10'), fE=Te('2026-06-10');

  const run=(tp:number,sl:number,pos:number,mc:number)=>{
    const rf=simulate(entries,bars,tp,sl,pos,mc,fS,fE); const sf=stats(rf.trades,rf.finalCash,rf.mdd);
    let qp=0; for(const q of quarters){ const r=simulate(entries,bars,tp,sl,pos,mc,q.s,q.e); const s=stats(r.trades,r.finalCash,r.mdd); if(s.pf>=1.2&&s.total>0)qp++; }
    const yr=years.map(([_,s,e])=>{ const r=simulate(entries,bars,tp,sl,pos,mc,T(s),Te(e)); const st=stats(r.trades,r.finalCash,r.mdd); return `${st.pf.toFixed(2)}/${fmt(st.total)}`; });
    return {sf,qp,yr};
  };

  const L:string[]=[]; L.push('='.repeat(100));
  L.push(`R45e — CONFIRM exit/sizing 변형 4년 OOS (${bars.size}코인). 신호=거짓돌파 확정 고정`); L.push('='.repeat(100));

  // Part 1: exit 변형 (sizing 33%×3 고정)
  L.push(`\n## Part1 — exit(TP/SL) 변형 (pos 33%×3)\n`);
  L.push(`${pad('exit',14)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('4Y total',9)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',6)} | Y1 / Y2약세 / Y3 / Y4`);
  L.push('-'.repeat(100));
  const exits:[string,number,number][]=[['TP5/SL2(현)',5,-2],['TP6/SL2.5',6,-2.5],['TP7/SL2.5(v2식)',7,-2.5],['TP8/SL3',8,-3],['TP10/SL3',10,-3],['TP7/SL2',7,-2]];
  let best:[string,number,number]=['TP5/SL2(현)',5,-2]; let bestScore=-1e9;
  for(const [nm,tp,sl] of exits){ const r=run(tp,sl,0.33,3);
    L.push(`${pad(nm,14)} | ${padS(String(r.sf.n),5)} | ${padS(r.sf.wr.toFixed(0)+'%',4)} | ${padS(fmt(r.sf.total),9)} | ${padS(r.sf.pf.toFixed(2),5)} | ${padS(r.sf.mdd.toFixed(0)+'%',5)} | ${padS(r.qp+'/16',6)} | ${r.yr.join(' ')}`);
    const score=r.sf.pf*100 + r.qp*5 - r.sf.mdd; if(score>bestScore){bestScore=score; best=[nm,tp,sl];}
  }

  // Part 2: sizing 변형 (best exit)
  L.push(`\n## Part2 — sizing 변형 (best exit = ${best[0]})\n`);
  L.push(`${pad('sizing',12)} | ${padS('n',5)} | ${padS('4Y total',9)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',6)} | Y1 / Y2약세 / Y3 / Y4`);
  L.push('-'.repeat(95));
  const sizings:[string,number,number][]=[['33%×3(현)',0.33,3],['40%×3',0.40,3],['50%×2',0.50,2],['25%×4',0.25,4],['50%×3',0.50,3]];
  for(const [nm,pos,mc] of sizings){ const r=run(best[1],best[2],pos,mc);
    L.push(`${pad(nm,12)} | ${padS(String(r.sf.n),5)} | ${padS(fmt(r.sf.total),9)} | ${padS(r.sf.pf.toFixed(2),5)} | ${padS(r.sf.mdd.toFixed(0)+'%',5)} | ${padS(r.qp+'/16',6)} | ${r.yr.join(' ')}`);
  }

  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45e_confirm_exit.txt'),out);
  process.exit(0);
})();
