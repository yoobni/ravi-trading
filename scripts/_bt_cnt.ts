/** 연도별 거래건수 4h vs 12h (A2/A4). 거래=진입1+청산1. */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE=0.0005,SLIP=0.0005,FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
const agg=(b:Bar[],n:number):Bar[]=>{const o:Bar[]=[];for(let i=0;i+n<=b.length;i+=n){const s=b.slice(i,i+n);o.push({ts:s[0].ts,open:s[0].open,high:Math.max(...s.map(x=>x.high)),low:Math.min(...s.map(x=>x.low)),close:s[s.length-1].close,volume:s.reduce((a,x)=>a+x.volume,0)});}return o;};
function sig(b:Bar[],i:number,LB:number,VW:number){if(i<LB+1||i<VW)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{entryTs:number;exitTs:number;win:boolean;}
function sim(act:number,gap:number,data:Map<string,Bar[]>,LB:number,VW:number,MAXB:number):Tr[]{const T:Tr[]=[];for(const[,b]of data){let ei=-1,ep=0,peak=0,sl=0,on=false,ets=0;for(let i=LB+1;i<b.length;i++){if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;if(bar.low<=sl){lvl=sl;done=true;}else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*(1+act/100))on=true;if(on)sl=Math.max(sl,peak*(1-gap/100));}if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}if(done){T.push({entryTs:ets,exitTs:bar.ts,win:FR*(lvl/ep)-1>0});ei=-1;}}continue;}if(i>=b.length-1||!sig(b,i,LB,VW))continue;ei=i+1;ep=b[i+1].open*(1+SLIP);ets=b[i+1].ts;sl=ep*0.98;peak=ep;on=false;}}return T;}
const yr=(ts:number)=>new Date(ts+9*3600000).getUTCFullYear();
(async()=>{
  const h4=new Map<string,Bar[]>(),h12=new Map<string,Bar[]>();
  for(const m of COINS){const b=load(m);if(b&&b.length>200){h4.set(m,b);h12.set(m,agg(b,3));}}
  const years=[2022,2023,2024,2025,2026];
  for(const[nm,act,gap]of[['A2',2,2],['A4',4,2]]as[string,number,number][]){
    const t4=sim(act,gap,h4,42,30,84), t12=sim(act,gap,h12,14,10,28);
    console.log(`\n════ ${nm} 연도별 거래건수 (진입연도 기준) ════`);
    console.log('연도     4h건    12h건   (승/패)');
    for(const y of years){
      const a=t4.filter(t=>yr(t.entryTs)===y),c=t12.filter(t=>yr(t.entryTs)===y);
      const wl=(arr:Tr[])=>`${arr.filter(t=>t.win).length}승/${arr.filter(t=>!t.win).length}패`;
      console.log(`${y}   ${String(a.length).padStart(5)}   ${String(c.length).padStart(5)}    4h:${wl(a)}  12h:${wl(c)}`);
    }
    console.log(`전체   ${String(t4.length).padStart(5)}   ${String(t12.length).padStart(5)}    (4h ${(t4.length/4).toFixed(0)}건/년, 12h ${(t12.length/4).toFixed(0)}건/년)`);
  }
})();
