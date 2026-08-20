/** 엔트리 신호 다양화: 돌파 vs 과매도반등 vs 눌림목 — 성과 + 월수익 상관관계. 28코인 4년, 트레일 exit 통일. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
const ACT=2,GAP=2,SL=-2;
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
// indicators (precompute per coin)
function ema(v:number[],n:number){const k=2/(n+1);const o:number[]=[];let e=v[0];for(let i=0;i<v.length;i++){e=i?v[i]*k+e*(1-k):v[i];o.push(e);}return o;}
function rsi(v:number[],n=14){const o:number[]=new Array(v.length).fill(NaN);let ag=0,al=0;for(let i=1;i<v.length;i++){const d=v[i]-v[i-1];const g=Math.max(d,0),l=Math.max(-d,0);if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=100-100/(1+ag/(al||1e-9));}}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=100-100/(1+ag/(al||1e-9));}}return o;}
function volZ(b:Bar[],i:number){if(i<VW)return 0;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return sd>0?(b[i].volume-mn)/sd:0;}

type Ind={ema20:number[];ema50:number[];rsi:number[]};
// 신호 함수: (b,i,ind)=>bool (i=확정봉)
const SIGS:Record<string,(b:Bar[],i:number,ind:Ind)=>boolean>={
  // 돌파(F6): 7일 신고가 + 양봉FT + volZ
  BREAKOUT:(b,i)=>{if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;return b[i-1].high>pm&&b[i].close>b[i].open&&b[i].close>b[i-1].high&&volZ(b,i)>=0.5;},
  // 과매도 반등: RSI<30에서 30 위로 크로스 + 양봉
  MEANREV:(b,i,ind)=>{const r=ind.rsi;if(isNaN(r[i-1])||isNaN(r[i]))return false;return r[i-1]<30&&r[i]>=30&&b[i].close>b[i].open;},
  // 눌림목(상승추세 속 되돌림 후 재상승): close>EMA50 & EMA20>EMA50 & 직전 저가<EMA20 & 양봉 재탈환
  PULLBACK:(b,i,ind)=>{const e20=ind.ema20[i],e50=ind.ema50[i];return b[i].close>e50&&ind.ema20[i]>e50&&b[i-1].low<ind.ema20[i-1]&&b[i].close>b[i].open&&b[i].close>e20;},
};
interface Tr{exitTs:number;ret:number;win:boolean;}
function sim(sigName:string,data:Map<string,Bar[]>,inds:Map<string,Ind>):Tr[]{
  const fn=SIGS[sigName];const T:Tr[]=[];
  for(const[m,b]of data){const ind=inds.get(m)!;let ei=-1,ep=0,peak=0,sl=0,on=false;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;if(bar.low<=sl){lvl=sl;done=true;}else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*(1+ACT/100))on=true;if(on)sl=Math.max(sl,peak*(1-GAP/100));}if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}if(done){T.push({exitTs:bar.ts,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0});ei=-1;}}continue;}
      if(i>=b.length-1||!fn(b,i,ind))continue;
      ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*(1+SL/100);peak=ep;on=false;
    }}
  return T;
}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const ym=(ts:number)=>new Date(ts+9*3600000).toISOString().slice(0,7);
function monthly(T:Tr[]){const m:Record<string,number>={};for(const t of T)m[ym(t.exitTs)]=(m[ym(t.exitTs)]||0)+t.ret;return m;}
function corr(a:Record<string,number>,b:Record<string,number>){const ks=[...new Set([...Object.keys(a),...Object.keys(b)])];const x=ks.map(k=>a[k]||0),y=ks.map(k=>b[k]||0);const n=x.length,mx=x.reduce((s,v)=>s+v,0)/n,my=y.reduce((s,v)=>s+v,0)/n;let sxy=0,sx=0,sy=0;for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sx+=(x[i]-mx)**2;sy+=(y[i]-my)**2;}return sxy/Math.sqrt(sx*sy||1e-9);}
const p=(x:number,d=0)=>x.toFixed(d);
(async()=>{
  const data=new Map<string,Bar[]>(),inds=new Map<string,Ind>();
  for(const m of COINS){const b=load(m);if(b&&b.length>200){data.set(m,b);const cl=b.map(x=>x.close);inds.set(m,{ema20:ema(cl,20),ema50:ema(cl,50),rsi:rsi(cl,14)});}}
  const names=['BREAKOUT','MEANREV','PULLBACK'];
  const res:Record<string,Tr[]>={};for(const s of names)res[s]=sim(s,data,inds);
  console.log('신호별 성과 (28코인 4년, 트레일 A2 exit 통일)');
  console.log('신호       | 거래  승률   PF    총익   MDD');
  for(const s of names){const x=st(res[s])!;console.log(`${s.padEnd(10)}| ${String(x.n).padStart(4)} ${(p(x.wr,1)+'%').padStart(6)} ${p(x.pf,2).padStart(5)} ${(p(x.total)+'%').padStart(6)} ${(p(x.mdd)+'%').padStart(5)}`);}
  console.log('\n월수익 상관관계 (낮을수록 분산효과 ↑)');
  const mo:Record<string,any>={};for(const s of names)mo[s]=monthly(res[s]);
  console.log('           '+names.map(n=>n.slice(0,7).padStart(9)).join(''));
  for(const a of names){let line=a.padEnd(10);for(const b of names)line+=p(corr(mo[a],mo[b]),2).padStart(9);console.log(line);}
  // 합성: BREAKOUT + 가장 낮은 상관 신호 50:50
  console.log('\n합성 포트폴리오 (월수익 합산, 동일가중)');
  for(const combo of [['BREAKOUT'],['BREAKOUT','MEANREV'],['BREAKOUT','PULLBACK'],['BREAKOUT','MEANREV','PULLBACK']]){
    const allM:Record<string,number>={};for(const s of combo)for(const[k,v]of Object.entries(monthly(res[s])))allM[k]=(allM[k]||0)+v/combo.length;
    const seq=Object.entries(allM).sort((a,b)=>a[0].localeCompare(b[0]));let eq=0,pk=0,mdd=0,pos=0;for(const[,v]of seq){eq+=v;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);if(v>0)pos++;}
    console.log(`  ${combo.join('+').padEnd(28)} 총 ${(p(eq*100)+'%').padStart(6)} MDD ${(p(mdd*100)+'%').padStart(5)} 흑자월 ${p(pos/seq.length*100,0)}%`);
  }
})();
