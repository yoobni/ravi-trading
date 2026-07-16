/**
 * H4(트레일링) 검증: 연도별 OOS + 수익집중도 + H4+H2 결합 비교.
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LOOKBACK=42, VOLZ_W=30, MAX_BARS=84, FEE=0.0005, SLIP=0.0005;
const FRICTION=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function signal(b:Bar[],i:number){if(i<LOOKBACK+1)return{hit:false,volZ:0};let pm=-Infinity;for(let j=i-LOOKBACK;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm))return{hit:false,volZ:0};if(!(b[i].close>b[i].open))return{hit:false,volZ:0};if(!(b[i].close>b[i-1].high))return{hit:false,volZ:0};let s=0,s2=0;for(let j=i-VOLZ_W;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mean=s/VOLZ_W,sd=Math.sqrt(Math.max(s2/VOLZ_W-mean*mean,1e-12));const z=sd>0?(b[i].volume-mean)/sd:0;if(z<0.5)return{hit:false,volZ:z};return{hit:true,volZ:z};}

type Variant={trailing?:{act:number,gap:number};tp:number;sl:number;cooldownBars?:number;};
interface Trade{coin:string;entryTs:number;exitTs:number;ret:number;win:boolean;reason:string;}

function run(v:Variant,data:Map<string,Bar[]>):Trade[]{
  const trades:Trade[]=[];
  for(const [mkt,b] of data){
    let ei=-1,ep=0,peak=0,sl=0,tp=0,trailOn=false,ets=0,cd=-1;
    for(let i=LOOKBACK+1;i<b.length;i++){
      if(ei>=0){
        if(i>ei){const bar=b[i];let ex:null|{lvl:number,r:string}=null;
          if(v.trailing){ if(bar.low<=sl)ex={lvl:sl,r:'TRAIL/SL'}; else{peak=Math.max(peak,bar.high);if(!trailOn&&peak>=ep*(1+v.trailing.act))trailOn=true;if(trailOn)sl=Math.max(sl,peak*(1-v.trailing.gap));} }
          else{ if(bar.low<=sl)ex={lvl:sl,r:'SL'}; else if(bar.high>=tp)ex={lvl:tp,r:'TP'}; }
          if(!ex&&(i-ei)>=MAX_BARS)ex={lvl:bar.close,r:'TIME'};
          if(ex){const ret=FRICTION*(ex.lvl/ep)-1;trades.push({coin:mkt,entryTs:ets,exitTs:bar.ts,ret,win:ret>0,reason:ex.r});if(ex.r.includes('SL')&&v.cooldownBars)cd=i+v.cooldownBars;ei=-1;}
        }
        continue;
      }
      if(i>=b.length-1)continue;
      if(v.cooldownBars&&i<cd)continue;
      const sg=signal(b,i);if(!sg.hit)continue;
      ei=i+1;ep=b[i+1].open*(1+SLIP);ets=b[i+1].ts;sl=ep*(1+v.sl);tp=ep*(1+v.tp);peak=ep;trailOn=false;
    }
  }
  return trades;
}
const yr=(ts:number)=>new Date(ts+9*3600000).getUTCFullYear();
function stats(ts:Trade[]){if(!ts.length)return null;const w=ts.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(ts.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));const seq=[...ts].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}return{n:ts.length,wr:w.length/ts.length*100,pf:gl>0?gw/gl:99,total:eq*100,mdd:mdd*100};}
function line(lbl:string,s:any){if(!s){console.log(`${lbl.padEnd(12)}| 거래없음`);return;}console.log(`${lbl.padEnd(12)}| ${String(s.n).padStart(4)}  ${s.wr.toFixed(1).padStart(5)}%  PF ${s.pf.toFixed(2).padStart(5)}  총 ${(s.total.toFixed(0)+'%').padStart(6)}  MDD ${(s.mdd.toFixed(0)+'%').padStart(5)}`);}

(async()=>{
  const data=new Map<string,Bar[]>();for(const m of COINS){const b=load(m);if(b&&b.length>200)data.set(m,b);}
  const BASE=run({tp:0.05,sl:-0.02},data);
  const H4=run({tp:0.05,sl:-0.02,trailing:{act:0.03,gap:0.03}},data);
  const H4H2=run({tp:0.05,sl:-0.02,trailing:{act:0.03,gap:0.03},cooldownBars:18},data);

  const years=[2022,2023,2024,2025,2026];
  for(const [nm,tr] of [['BASE',BASE],['H4',H4],['H4+H2',H4H2]] as [string,Trade[]][]){
    console.log(`\n===== ${nm} 연도별 (exit 연도) =====`);
    line('전체',stats(tr));
    for(const y of years){const s=stats(tr.filter(t=>yr(t.exitTs)===y));if(s)line(String(y),s);}
  }

  // 수익 집중도 (H4)
  console.log('\n===== H4 수익 집중도 =====');
  const gross=H4.filter(t=>t.win).reduce((a,t)=>a+t.ret,0);
  const sorted=[...H4].sort((a,b)=>b.ret-a.ret);
  const topN=(n:number)=>sorted.slice(0,n).reduce((a,t)=>a+t.ret,0);
  console.log(`총 승리이익(gross win): ${(gross*100).toFixed(0)}% | 순총익: ${(stats(H4)!.total).toFixed(0)}%`);
  console.log(`상위 10건 = 순총익의 ${(topN(10)/(stats(H4)!.total/100)*100).toFixed(0)}%`);
  console.log(`상위 1% (${Math.round(H4.length*0.01)}건) = gross win의 ${(sorted.slice(0,Math.round(H4.length*0.01)).filter(t=>t.win).reduce((a,t)=>a+t.ret,0)/gross*100).toFixed(0)}%`);
  // 코인별 집중도
  const byCoin:Record<string,number>={};H4.forEach(t=>byCoin[t.coin]=(byCoin[t.coin]||0)+t.ret);
  const coinRank=Object.entries(byCoin).sort((a,b)=>b[1]-a[1]);
  console.log('코인별 순익 상위5:',coinRank.slice(0,5).map(([c,v])=>c.replace('KRW-','')+' '+(v*100).toFixed(0)+'%').join(' / '));
  console.log('코인별 순익 하위3:',coinRank.slice(-3).map(([c,v])=>c.replace('KRW-','')+' '+(v*100).toFixed(0)+'%').join(' / '));
  // 최고 단일 승/최고 연도 제거 시
  const bestYear=years.map(y=>[y,stats(H4.filter(t=>yr(t.exitTs)===y))?.total||0] as [number,number]).sort((a,b)=>b[1]-a[1])[0];
  console.log(`최고 연도 ${bestYear[0]}: +${bestYear[1].toFixed(0)}% | 그 해 제외한 총익: ${(stats(H4)!.total-bestYear[1]).toFixed(0)}%`);
  console.log(`최고 단일거래: ${(sorted[0].ret*100).toFixed(0)}% (${sorted[0].coin.replace('KRW-','')})`);
})();
