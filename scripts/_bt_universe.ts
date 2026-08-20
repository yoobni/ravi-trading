/** 유니버스 비교: 현재28 vs 확장 vs 리프레시 — A2 트레일(4h), 공통 1년(2025-06~2026-06). */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const CUR28=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const CAND=['KRW-ONDO','KRW-HBAR','KRW-SHIB','KRW-BONK','KRW-JTO','KRW-ENS','KRW-VIRTUAL','KRW-ZIL','KRW-XEC','KRW-KAITO'];
const WITHER=['KRW-BAT','KRW-IMX','KRW-MANA','KRW-GRT'];
const FROM=Date.parse('2025-06-10T00:00:00Z'), TO=Date.parse('2026-06-10T00:00:00Z');
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
function load(m:string):Bar[]|null{
  const one=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);
  if(fs.existsSync(one))return JSON.parse(fs.readFileSync(one,'utf8')).filter((b:Bar)=>b.ts>=FROM&&b.ts<TO);
  // 후보: 2파일 concat
  const parts=['2024-06-10_2025-06-10','2025-06-10_2026-06-10'].map(s=>path.join(DIR,`${m}_240m_${s}.json`)).filter(fs.existsSync);
  if(!parts.length)return null;
  const seen=new Set<number>();const all:Bar[]=[];
  for(const p of parts)for(const b of JSON.parse(fs.readFileSync(p,'utf8')))if(!seen.has(b.ts)){seen.add(b.ts);all.push(b);}
  all.sort((a,b)=>a.ts-b.ts);
  return all.filter(b=>b.ts>=FROM&&b.ts<TO);
}
function sig(b:Bar[],i:number){if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{exitTs:number;ret:number;win:boolean;coin:string;}
function sim(coins:string[],data:Map<string,Bar[]>):Tr[]{const T:Tr[]=[];for(const m of coins){const b=data.get(m);if(!b||b.length<LB+3)continue;let ei=-1,ep=0,peak=0,sl=0,on=false;for(let i=LB+1;i<b.length;i++){if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;if(bar.low<=sl){lvl=sl;done=true;}else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*1.02)on=true;if(on)sl=Math.max(sl,peak*0.98);}if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}if(done){T.push({exitTs:bar.ts,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0,coin:m});ei=-1;}}continue;}if(i>=b.length-1||!sig(b,i))continue;ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*0.98;peak=ep;on=false;}}return T;}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const p=(x:number,d=0)=>x.toFixed(d);
function row(l:string,s:any){if(!s){console.log(l.padEnd(24)+'| -');return;}console.log(`${l.padEnd(24)}| ${String(s.n).padStart(4)} ${(p(s.wr,1)+'%').padStart(6)} PF${p(s.pf,2).padStart(5)} 총${(p(s.total)+'%').padStart(6)} MDD${(p(s.mdd)+'%').padStart(5)} 수/MDD${p(s.mdd>0?s.total/s.mdd:0,1).padStart(5)}`);}
(async()=>{
  const data=new Map<string,Bar[]>();
  for(const m of [...CUR28,...CAND]){const b=load(m);if(b)data.set(m,b);}
  const REFRESH=[...CUR28.filter(c=>!WITHER.includes(c)),...CAND];
  console.log(`기간 2025-06~2026-06 | 로드: 28중 ${CUR28.filter(c=>data.has(c)).length}, 후보중 ${CAND.filter(c=>data.has(c)).length}\n`);
  console.log('시나리오                  | 거래   승률   PF    총익   MDD   수익/MDD');
  console.log('--------------------------|-------------------------------------------------');
  row('① 현재 28',            st(sim(CUR28,data)));
  row('② 확장 28+후보10',      st(sim([...CUR28,...CAND],data)));
  row('③ 리프레시(-4말라+10)',  st(sim(REFRESH,data)));
  row('④ 드롭만 (28-4말라)',   st(sim(CUR28.filter(c=>!WITHER.includes(c)),data)));
  row('⑤ 후보10 단독',         st(sim(CAND,data)));
  // 후보별 기여
  console.log('\n=== 후보 코인별 성과 (단독) ===');
  for(const c of CAND){const s=st(sim([c],data));console.log(`  ${c.replace('KRW-','').padEnd(8)} `+(s?`거래${String(s.n).padStart(3)} PF${p(s.pf,2)} 총${p(s.total)}%`:'거래부족'));}
  console.log('\n=== 말라버린 4개 성과 (단독, 최근1년) ===');
  for(const c of WITHER){const s=st(sim([c],data));console.log(`  ${c.replace('KRW-','').padEnd(8)} `+(s?`거래${String(s.n).padStart(3)} PF${p(s.pf,2)} 총${p(s.total)}%`:'거래부족'));}
})();
