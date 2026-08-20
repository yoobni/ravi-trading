/** 리서치 검증: (1)비용 스트레스 (2)변동성 타깃 사이징(BTC 실현변동성 기반). A2 트레일, 28코인 4년. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LB=42,VW=30,MAXB=84,SLIP=0.0005;
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function sig(b:Bar[],i:number){if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{exitTs:number;entryTs:number;ret:number;win:boolean}
// fric = round-trip cost fraction (fee+slip 포함). ret = fric반영 gross ratio
function sim(data:Map<string,Bar[]>,rtCost:number):Tr[]{
  const FR=(1-rtCost); const T:Tr[]=[];
  for(const[,b]of data){let ei=-1,ep=0,peak=0,sl=0,on=false,ets=0;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;if(bar.low<=sl){lvl=sl;done=true;}else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*1.02)on=true;if(on)sl=Math.max(sl,peak*0.98);}if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}if(done){T.push({exitTs:bar.ts,entryTs:ets,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0});ei=-1;}}continue;}
      if(i>=b.length-1||!sig(b,i))continue;ei=i+1;ep=b[i+1].open*(1+SLIP);ets=b[i+1].ts;sl=ep*0.98;peak=ep;on=false;
    }}
  return T;
}
function stats(T:Tr[],w?:Map<number,number>){if(!T.length)return null;let gw=0,gl=0,wins=0;const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0,sw=0;
  for(const t of seq){const wt=w?(w.get(t.entryTs)??1):1;const r=t.ret*wt;if(t.ret>0){gw+=r;wins++;}else gl+=-r;eq+=r;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);sw+=wt;}
  const avgW=sw/T.length;
  return{n:T.length,wr:wins/T.length*100,pf:gl>0?gw/gl:99,total:eq/avgW*100,mdd:mdd/avgW*100};}
const p=(x:number,d=0)=>x.toFixed(d);
function row(l:string,s:any){if(!s){console.log(l.padEnd(22)+'| -');return;}console.log(`${l.padEnd(22)}| PF${p(s.pf,2).padStart(5)} 총${(p(s.total)+'%').padStart(6)} MDD${(p(s.mdd)+'%').padStart(5)} 수/MDD${p(s.mdd>0?s.total/s.mdd:0,1).padStart(5)} 승률${p(s.wr,0)}%`);}
(async()=>{
  const data=new Map<string,Bar[]>();for(const m of COINS){const b=load(m);if(b&&b.length>200)data.set(m,b);}
  // BTC 실현변동성 (직전30봉 로그수익 stdev) ts→vol
  const btc=data.get('KRW-BTC')!;const btcVol=new Map<number,number>();
  for(let i=30;i<btc.length;i++){const r=[];for(let j=i-29;j<=i;j++)r.push(Math.log(btc[j].close/btc[j-1].close));const m=r.reduce((a,x)=>a+x,0)/r.length;btcVol.set(btc[i].ts,Math.sqrt(r.reduce((a,x)=>a+(x-m)**2,0)/r.length));}
  const vols=[...btcVol.values()].sort((a,b)=>a-b);const medVol=vols[Math.floor(vols.length/2)],hiVol=vols[Math.floor(vols.length*0.8)];

  console.log('◆ (1) 비용 스트레스 (왕복 비용별) — A2 트레일');
  console.log('  왕복비용             | 성과');
  for(const c of [0.001,0.002,0.004,0.006]){row('  '+(c*100).toFixed(1)+'%',stats(sim(data,c)));}

  console.log('\n◆ (2) 변동성 타깃 사이징 (왕복 0.2% 고정) — BTC 실현변동성 기반');
  const T=sim(data,0.002);
  // 가중치: 진입시점 BTC vol의 역수 (targetVol/vol), clamp
  const nearest=(ts:number)=>{let v=btcVol.get(ts);if(v!=null)return v;let best=medVol,bd=Infinity;for(const[k,val]of btcVol){const d=Math.abs(k-ts);if(d<bd){bd=d;best=val;}}return best;};
  const wVT=new Map<number,number>();for(const t of T)wVT.set(t.entryTs,Math.max(0.3,Math.min(2.5,medVol/nearest(t.entryTs))));
  // 고변동 게이트: 진입시 BTC vol이 상위20%면 스킵(가중0)
  const wGate=new Map<number,number>();for(const t of T)wGate.set(t.entryTs,nearest(t.entryTs)>=hiVol?0:1);
  row('  등가중(baseline)',stats(T));
  row('  변동성타깃(역vol)',stats(T,wVT));
  row('  고변동회피(상위20%컷)',stats(T,wGate));
})();
