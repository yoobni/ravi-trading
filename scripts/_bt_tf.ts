/** A2/A4 타임프레임 비교 (공통구간 2024-06~2026-06). 1h실데이터 + 4h + 8h/12h/일봉(4h합성). */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
const FROM=Date.parse('2024-06-10T00:00:00Z');
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
function loadRaw(m:string,suffix:string):Bar[]|null{
  const cands=fs.readdirSync(DIR).filter(f=>f.startsWith(m+'_'+suffix+'_'));
  if(!cands.length)return null;
  // 가장 긴 파일
  let best:Bar[]|null=null;for(const f of cands){const d=JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'));if(!best||d.length>best.length)best=d;}
  return best;
}
function agg(b:Bar[],n:number):Bar[]{const o:Bar[]=[];for(let i=0;i+n<=b.length;i+=n){const s=b.slice(i,i+n);o.push({ts:s[0].ts,open:s[0].open,high:Math.max(...s.map(x=>x.high)),low:Math.min(...s.map(x=>x.low)),close:s[s.length-1].close,volume:s.reduce((a,x)=>a+x.volume,0)});}return o;}
function filt(b:Bar[]):Bar[]{return b.filter(x=>x.ts>=FROM);}

function sig(b:Bar[],i:number,LB:number,VW:number){if(i<LB+1||i<VW)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{exitTs:number;ret:number;win:boolean;}
function sim(act:number,gap:number,data:Map<string,Bar[]>,LB:number,VW:number,MAXB:number):Tr[]{
  const T:Tr[]=[];
  for(const[,b]of data){let ei=-1,ep=0,peak=0,sl=0,on=false;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;
        if(bar.low<=sl){lvl=sl;done=true;}
        else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*(1+act/100))on=true;if(on)sl=Math.max(sl,peak*(1-gap/100));}
        if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}
        if(done){T.push({exitTs:bar.ts,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0});ei=-1;}
      }continue;}
      if(i>=b.length-1||!sig(b,i,LB,VW))continue;
      ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*0.98;peak=ep;on=false;
    }}
  return T;
}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const p=(x:number,d=0)=>x.toFixed(d);
function row(l:string,s:any){if(!s){console.log(l.padEnd(10)+'| 거래부족');return;}console.log(`${l.padEnd(10)}| ${String(s.n).padStart(5)} ${(p(s.wr,1)+'%').padStart(6)} PF${p(s.pf,2).padStart(5)} 총${(p(s.total)+'%').padStart(6)} MDD${(p(s.mdd)+'%').padStart(5)} 수익/MDD ${p(s.mdd>0?s.total/s.mdd:0,1)}`);}

(async()=>{
  // load base
  const h4=new Map<string,Bar[]>(),h1=new Map<string,Bar[]>();
  for(const m of COINS){const a=loadRaw(m,'240m');if(a)h4.set(m,filt(a));const c=loadRaw(m,'60m');if(c)h1.set(m,filt(c));}
  const build=(n:number)=>{const mm=new Map<string,Bar[]>();for(const[k,v]of h4)mm.set(k,agg(v,n));return mm;};
  const h8=build(2),h12=build(3),d1=build(6);
  console.log(`공통구간 2024-06 ~ 2026-06 | 4h코인 ${h4.size}, 1h코인 ${h1.size}\n`);
  // TF: [label, data, LB(7d), VW(5d), MAXB(14d)]
  const TFS:[string,Map<string,Bar[]>,number,number,number][]=[
    ['1h',  h1, 168, 120, 336],
    ['4h',  h4, 42,  30,  84],
    ['8h',  h8, 21,  15,  42],
    ['12h', h12,14,  10,  28],
    ['1d',  d1, 7,   5,   14],
  ];
  for(const[nm,act,gap]of[['A2 (act2/gap2)',2,2],['A4 (act4/gap2)',4,2]] as [string,number,number][]){
    console.log(`◆ ${nm}`);
    for(const[tf,data,LB,VW,MAXB]of TFS)row('  '+tf,st(sim(act,gap,data,LB,VW,MAXB)));
    console.log('');
  }
})();
