/** a4/g2 등 g2 후보 walk-forward (train 22-24 / test 25-26). 반영 안 함, 검증만. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005;
const FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function sig(b:Bar[],i:number){if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{exitTs:number;ret:number;win:boolean;}
function sim(act:number,gap:number,data:Map<string,Bar[]>,from?:number,to?:number):Tr[]{
  const T:Tr[]=[];
  for(const[,b]of data){let ei=-1,ep=0,peak=0,sl=0,on=false;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;
        if(bar.low<=sl){lvl=sl;done=true;}
        else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*(1+act/100))on=true;if(on)sl=Math.max(sl,peak*(1-gap/100));}
        if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}
        if(done){const ret=FR*(lvl/ep)-1;if((!to||bar.ts<to)&&(!from||bar.ts>=from))T.push({exitTs:bar.ts,ret,win:ret>0});ei=-1;}
      }continue;}
      if(i>=b.length-1)continue;
      if(!sig(b,i))continue;
      ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*0.98;peak=ep;on=false;
    }}
  return T;
}
function st(T:Tr[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
const p=(x:number,d=0)=>x.toFixed(d);
function show(lbl:string,s:any){console.log(`${lbl.padEnd(18)}| ${String(s.n).padStart(4)} ${(p(s.wr,1)+'%').padStart(6)}  PF ${p(s.pf,2).padStart(5)}  총 ${(p(s.total)+'%').padStart(6)}  MDD ${(p(s.mdd)+'%').padStart(5)}`);}

(async()=>{
  const data=new Map<string,Bar[]>();for(const m of COINS){const b=load(m);if(b&&b.length>200)data.set(m,b);}
  const TR=Date.parse('2025-01-01T00:00:00Z');
  console.log('walk-forward: TRAIN=2022~2024, TEST=2025~2026 (완전 아웃샘플)\n');
  for(const[act,gap]of[[3,3],[4,2],[3,2],[2,2],[5,2]]){
    console.log(`◆ act${act}/gap${gap}`);
    show('  TRAIN',st(sim(act,gap,data,undefined,TR)));
    show('  TEST ',st(sim(act,gap,data,TR)));
    show('  전체',st(sim(act,gap,data)));
  }
})();
