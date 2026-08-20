/** Walk-forward 동적 유니버스: 매월 직전30일 거래대금 top-N (미래참조X) vs 고정28. A2 트레일 4h. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const CUR28=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const CAND=['KRW-ONDO','KRW-HBAR','KRW-SHIB','KRW-BONK','KRW-JTO','KRW-ENS','KRW-VIRTUAL','KRW-ZIL','KRW-XEC','KRW-KAITO'];
const POOL=[...CUR28,...CAND];
const EVAL_FROM=Date.parse('2025-06-10T00:00:00Z'), EVAL_TO=Date.parse('2026-06-10T00:00:00Z');
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
const REBAL=180, LIQW=180; // 30일마다 리밸런스, 직전30일 거래대금
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
function load(m:string):Bar[]|null{
  const one=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);
  if(fs.existsSync(one))return JSON.parse(fs.readFileSync(one,'utf8')).filter((b:Bar)=>b.ts>=Date.parse('2024-12-01T00:00:00Z'));
  const parts=['2024-06-10_2025-06-10','2025-06-10_2026-06-10'].map(s=>path.join(DIR,`${m}_240m_${s}.json`)).filter(fs.existsSync);
  if(!parts.length)return null;const seen=new Set<number>();const all:Bar[]=[];
  for(const p of parts)for(const b of JSON.parse(fs.readFileSync(p,'utf8')))if(!seen.has(b.ts)){seen.add(b.ts);all.push(b);}
  all.sort((a,b)=>a.ts-b.ts);return all;
}
function sig(b:Bar[],i:number){if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{exitTs:number;ret:number;win:boolean;}
// activeAt: (coin,ts)=>bool. null이면 항상 허용
function sim(coins:string[],data:Map<string,Bar[]>,activeAt:((c:string,ts:number)=>boolean)|null):Tr[]{
  const T:Tr[]=[];
  for(const m of coins){const b=data.get(m);if(!b||b.length<LB+3)continue;let ei=-1,ep=0,peak=0,sl=0,on=false;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;if(bar.low<=sl){lvl=sl;done=true;}else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*1.02)on=true;if(on)sl=Math.max(sl,peak*0.98);}if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}if(done){if(bar.ts>=EVAL_FROM&&bar.ts<EVAL_TO)T.push({exitTs:bar.ts,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0});ei=-1;}}continue;}
      if(i>=b.length-1||!sig(b,i))continue;
      if(activeAt&&!activeAt(m,b[i].ts))continue;   // 동적: 진입시점 top-N 소속만
      ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*0.98;peak=ep;on=false;
    }}
  return T;
}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const p=(x:number,d=0)=>x.toFixed(d);
function row(l:string,s:any){if(!s){console.log(l.padEnd(20)+'| -');return;}console.log(`${l.padEnd(20)}| ${String(s.n).padStart(4)} ${(p(s.wr,1)+'%').padStart(6)} PF${p(s.pf,2).padStart(5)} 총${(p(s.total)+'%').padStart(6)} MDD${(p(s.mdd)+'%').padStart(5)} 수/MDD${p(s.mdd>0?s.total/s.mdd:0,1).padStart(5)}`);}
(async()=>{
  const data=new Map<string,Bar[]>();for(const m of POOL){const b=load(m);if(b)data.set(m,b);}
  // 공통 ts 그리드
  const tsSet=new Set<number>();for(const b of data.values())for(const x of b)tsSet.add(x.ts);
  const grid=[...tsSet].sort((a,b)=>a-b);
  // liq lookup: coin→(ts→close*vol)
  const liq=new Map<string,Map<number,number>>();
  for(const[m,b]of data){const mm=new Map<number,number>();for(const x of b)mm.set(x.ts,x.close*x.volume);liq.set(m,mm);}
  // 리밸런스 경계마다 top-N 계산 (직전 LIQW봉 거래대금 합)
  function buildActive(N:number){
    const bounds=grid.filter((_,i)=>i%REBAL===0 && i>=LIQW);
    const uni=new Map<number,Set<string>>(); // boundaryTs → active set
    for(const B of bounds){
      const idx=grid.indexOf(B);const win=grid.slice(idx-LIQW,idx);
      const score=[...data.keys()].map(m=>{const mm=liq.get(m)!;let s=0,cnt=0;for(const t of win){const v=mm.get(t);if(v!=null){s+=v;cnt++;}}return{m,s,ok:cnt>=LIQW*0.8};}).filter(x=>x.ok).sort((a,b)=>b.s-a.s);
      uni.set(B,new Set(score.slice(0,N).map(x=>x.m)));
    }
    const bkeys=[...uni.keys()].sort((a,b)=>a-b);
    return (c:string,ts:number)=>{let act:Set<string>|null=null;for(const B of bkeys){if(B<=ts)act=uni.get(B)!;else break;}return act?act.has(c):false;};
  }
  console.log(`풀 ${data.size}코인 | 평가기간 2025-06~2026-06 | 리밸런스 30일, 직전30일 거래대금 top-N\n`);
  console.log('유니버스              | 거래   승률   PF    총익   MDD   수익/MDD');
  console.log('----------------------|-------------------------------------------------');
  row('고정 28 (현재)',      st(sim(CUR28,data,null)));
  row('고정 38 (28+후보)',   st(sim(POOL,data,null)));
  for(const N of [28,22,16,10]) row(`동적 top-${N}`, st(sim(POOL,data,buildActive(N))));
})();
