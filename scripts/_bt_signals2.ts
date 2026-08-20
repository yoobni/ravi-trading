/** 신호 6종 × 적합 exit — 성과 + 돌파와의 월수익 상관. 28코인 4년. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function ema(v:number[],n:number){const k=2/(n+1);const o:number[]=[];let e=v[0];for(let i=0;i<v.length;i++){e=i?v[i]*k+e*(1-k):v[i];o.push(e);}return o;}
function rsi(v:number[],n=14){const o=new Array(v.length).fill(NaN);let ag=0,al=0;for(let i=1;i<v.length;i++){const d=v[i]-v[i-1],g=Math.max(d,0),l=Math.max(-d,0);if(i<=n){ag+=g;al+=l;if(i===n)o[i]=100-100/(1+ag/n/((al/n)||1e-9));}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=100-100/(1+ag/((al)||1e-9));}}return o;}
function smaStd(v:number[],n:number){const m=new Array(v.length).fill(NaN),s=new Array(v.length).fill(NaN);for(let i=n-1;i<v.length;i++){let su=0;for(let j=i-n+1;j<=i;j++)su+=v[j];const mn=su/n;let sq=0;for(let j=i-n+1;j<=i;j++)sq+=(v[j]-mn)**2;m[i]=mn;s[i]=Math.sqrt(sq/n);}return{m,s};}
function volZ(b:Bar[],i:number,w=30){if(i<w)return 0;let s=0,s2=0;for(let j=i-w;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/w,sd=Math.sqrt(Math.max(s2/w-mn*mn,1e-12));return sd>0?(b[i].volume-mn)/sd:0;}

interface Ind{cl:number[];e12:number[];e26:number[];e50:number[];sig9:number[];rsi:number[];bbm:number[];bbs:number[];ret42:number[];bw:number[]}
function build(b:Bar[]):Ind{const cl=b.map(x=>x.close);const e12=ema(cl,12),e26=ema(cl,26);const macd=e12.map((v,i)=>v-e26[i]);const sig9=ema(macd,9);const {m:bbm,s:bbs}=smaStd(cl,20);const bw=bbm.map((m,i)=>isNaN(m)?NaN:(4*bbs[i])/m);const ret42=cl.map((v,i)=>i>=42?v/cl[i-42]-1:NaN);return{cl,e12,e26,e50:ema(cl,50),sig9,rsi:rsi(cl,14),bbm,bbs,ret42,bw};}

// exit: trail(A2) or fixed TP
type Exit={kind:'trail'}|{kind:'tp',tp:number,sl:number,max:number};
function runExit(b:Bar[],entryIdx:number,ep:number,ex:Exit){
  if(ex.kind==='trail'){let peak=ep,sl=ep*0.98,on=false;for(let i=entryIdx+1;i<b.length;i++){const bar=b[i];if(bar.low<=sl)return{lvl:sl,ts:bar.ts};peak=Math.max(peak,bar.high);if(!on&&peak>=ep*1.02)on=true;if(on)sl=Math.max(sl,peak*0.98);if(i-entryIdx>=84)return{lvl:bar.close,ts:bar.ts};}return null;}
  else{const tp=ep*(1+ex.tp/100),sl=ep*(1+ex.sl/100);for(let i=entryIdx+1;i<b.length;i++){const bar=b[i];if(bar.low<=sl)return{lvl:sl,ts:bar.ts};if(bar.high>=tp)return{lvl:tp,ts:bar.ts};if(i-entryIdx>=ex.max)return{lvl:bar.close,ts:bar.ts};}return null;}
}
interface Tr{exitTs:number;ret:number;win:boolean}
function sim(fn:(b:Bar[],i:number,d:Ind,ctx:any)=>boolean,ex:Exit,data:Map<string,Bar[]>,inds:Map<string,Ind>,ctx:any):Tr[]{
  const T:Tr[]=[];
  for(const[m,b]of data){const d=inds.get(m)!;let i=50;while(i<b.length-1){if(fn(b,i,d,{coin:m,...ctx})){const ep=b[i+1].open*(1+SLIP);const r=runExit(b,i+1,ep,ex);if(r){T.push({exitTs:r.ts,ret:FR*(r.lvl/ep)-1,win:FR*(r.lvl/ep)-1>0});const ni=b.findIndex((x,k)=>k>i&&x.ts===r.ts);i=ni>i?ni+1:i+1;continue;}}i++;}}
  return T;
}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const ym=(ts:number)=>new Date(ts+9*3600000).toISOString().slice(0,7);
const monthly=(T:Tr[])=>{const m:Record<string,number>={};for(const t of T)m[ym(t.exitTs)]=(m[ym(t.exitTs)]||0)+t.ret;return m;};
function corr(a:any,b:any){const ks=[...new Set([...Object.keys(a),...Object.keys(b)])];const x=ks.map(k=>a[k]||0),y=ks.map(k=>b[k]||0);const n=x.length,mx=x.reduce((s,v)=>s+v,0)/n,my=y.reduce((s,v)=>s+v,0)/n;let sxy=0,sx=0,sy=0;for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sx+=(x[i]-mx)**2;sy+=(y[i]-my)**2;}return sxy/Math.sqrt(sx*sy||1e-9);}
const p=(x:number,d=0)=>x.toFixed(d);

(async()=>{
  const data=new Map<string,Bar[]>(),inds=new Map<string,Ind>();
  for(const m of COINS){const b=load(m);if(b&&b.length>200){data.set(m,b);inds.set(m,build(b));}}
  // XSEC: ts별 ret42 top5
  const topK=new Map<number,Set<string>>();const byTs=new Map<number,{c:string,r:number}[]>();
  for(const[m,b]of data){const d=inds.get(m)!;for(let i=42;i<b.length;i++){if(isNaN(d.ret42[i]))continue;(byTs.get(b[i].ts)??byTs.set(b[i].ts,[]).get(b[i].ts)!).push({c:m,r:d.ret42[i]});}}
  for(const[ts,arr]of byTs){arr.sort((a,b)=>b.r-a.r);topK.set(ts,new Set(arr.slice(0,5).filter(x=>x.r>0).map(x=>x.c)));}

  const TRAIL:Exit={kind:'trail'}, TP:Exit={kind:'tp',tp:4,sl:-3,max:18};
  const defs:[string,any,Exit,(b:Bar[],i:number,d:Ind,ctx:any)=>boolean][]=[
    ['BREAKOUT',null,TRAIL,(b,i)=>{if(i<43)return false;let pm=-Infinity;for(let j=i-42;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;return b[i-1].high>pm&&b[i].close>b[i].open&&b[i].close>b[i-1].high&&volZ(b,i)>=0.5;}],
    ['MEANREV_TP',null,TP,(b,i,d)=>!isNaN(d.rsi[i-1])&&d.rsi[i-1]<30&&d.rsi[i]>=30&&b[i].close>b[i].open],
    ['BBREVERT',null,TP,(b,i,d)=>!isNaN(d.bbm[i])&&b[i-1].close<(d.bbm[i-1]-2*d.bbs[i-1])&&b[i].close>(d.bbm[i]-2*d.bbs[i])&&b[i].close>b[i].open],
    ['SQUEEZE',null,TRAIL,(b,i,d)=>{if(i<120||isNaN(d.bw[i]))return false;const win=d.bw.slice(i-100,i).filter(x=>!isNaN(x)).sort((a,b)=>a-b);const q20=win[Math.floor(win.length*0.2)];let ph=-Infinity;for(let j=i-10;j<i;j++)ph=Math.max(ph,b[j].high);return d.bw[i-1]<q20&&b[i].close>ph&&b[i].close>b[i].open&&volZ(b,i)>=0.5;}],
    ['MACD_TREND',null,TRAIL,(b,i,d)=>{const macd=d.e12[i]-d.e26[i],macdP=d.e12[i-1]-d.e26[i-1];return macdP<=d.sig9[i-1]&&macd>d.sig9[i]&&macd>0&&b[i].close>d.e50[i];}],
    ['XSEC_RS',{topK},TRAIL,(b,i,d,ctx)=>{const now=ctx.topK.get(b[i].ts),prev=ctx.topK.get(b[i-1].ts);return !!now&&now.has(ctx.coin)&&!(prev&&prev.has(ctx.coin))&&b[i].close>b[i].open;}],
  ];
  const res:Record<string,Tr[]>={};
  console.log('신호별 성과 (28코인 4년)');
  console.log('신호        | exit  | 거래  승률   PF    총익    MDD');
  for(const[nm,ctx,ex,fn]of defs){const T=sim(fn,ex,data,inds,ctx||{});res[nm]=T;const x=st(T);const exl=ex.kind==='trail'?'트레일':'TP4/SL3';console.log(`${nm.padEnd(11)}| ${exl.padEnd(6)}| ${x?String(x.n).padStart(4):'-'} ${x?(p(x.wr,1)+'%').padStart(6):''} ${x?p(x.pf,2).padStart(5):''} ${x?(p(x.total)+'%').padStart(7):''} ${x?(p(x.mdd)+'%').padStart(6):''}`);}
  console.log('\n돌파(BREAKOUT)와의 월수익 상관 (낮을수록 분산재 ↑)');
  const bm=monthly(res.BREAKOUT);
  for(const nm of Object.keys(res))if(nm!=='BREAKOUT')console.log(`  ${nm.padEnd(11)} corr ${p(corr(bm,monthly(res[nm])),2)}`);
})();
