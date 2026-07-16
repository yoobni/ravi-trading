/**
 * R53 — 리스크 기반 동적 배분 vs 고정/균등.
 *
 * "장 보고 옮기기"(regime 타이밍, R46서 깨짐) 아님.
 * 리스크패리티: 각 전략 최근 실현변동성에 역가중, 매월 리밸런스 (후행적, 예측 X).
 * 검증된 4개(F1F2/F6/F6v2/F6v3) 4년 일별곡선으로 균등·고정최적·동적 비교.
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';
import { aggregateDaily, evalF1F2, type FundingFetchPoint } from '@/lib/paper-funding-strategy';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL = 10_000_000, COST = 0.001, LB = 42;
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const thresholds = JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/paper-trading/train-thresholds.json'),'utf-8'));

function loadBars(c:string):CachedBar[]{const fp=path.join(CACHE_DIR,`KRW-${c}_240m_2022-06-10_2026-06-10.json`);if(!fs.existsSync(fp))return [];return (JSON.parse(fs.readFileSync(fp,'utf-8')) as CachedBar[]).sort((a,b)=>a.ts-b.ts);}
const kst=(ts:number)=>new Date(ts+9*3600000).toISOString().slice(0,10);
function volZ(v:number[],i:number,w=30):number|null{if(i<w)return null;let s=0,s2=0;for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];}const m=s/w,sd=Math.sqrt(Math.max(s2/w-m*m,1e-12));return sd>0?(v[i]-m)/sd:null;}

async function fetchFundingHistory(startMs:number):Promise<FundingFetchPoint[]>{const out:FundingFetchPoint[]=[];let cur=startMs;for(let c=0;c<30;c++){const{data}=await axios.get<Array<{fundingTime:number;fundingRate:string}>>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${cur}&limit=1000`,{timeout:15000});if(!data.length)break;for(const d of data)out.push({ts:d.fundingTime,date:kst(d.fundingTime),rate:parseFloat(d.fundingRate)*100});if(data.length<1000)break;cur=data[data.length-1].fundingTime+1;}return out;}

interface DayBar{date:string;open:number;high:number;low:number;close:number;}
function toDaily(bars:CachedBar[]):DayBar[]{const bd=new Map<string,CachedBar[]>();for(const b of bars){const d=kst(b.ts);if(!bd.has(d))bd.set(d,[]);bd.get(d)!.push(b);}const o:DayBar[]=[];for(const[date,bs]of[...bd.entries()].sort((a,b)=>a[0]<b[0]?-1:1)){bs.sort((a,b)=>a.ts-b.ts);o.push({date,open:bs[0].open,high:Math.max(...bs.map(x=>x.high)),low:Math.min(...bs.map(x=>x.low)),close:bs[bs.length-1].close});}return o;}

function simF1F2(daily:DayBar[],dm:ReturnType<typeof aggregateDaily>):Map<string,number>{
  const TP=8,SL=-5,MAXD=10,FEE=0.0005,SLIP=0.0005,SIZE=0.5;let cash=INITIAL;let pos:any=null;const eq=new Map<string,number>();
  const bbd=new Map(daily.map(b=>[b.date,b]));const db=(a:string,b:string)=>Math.round((new Date(a+'T00:00:00Z').getTime()-new Date(b+'T00:00:00Z').getTime())/86400000);
  for(let k=0;k<daily.length;k++){const D=daily[k].date;const y=daily[k-1]?.date;
    if(pos&&y){const yb=bbd.get(y)!;if(pos.entryDate<=y&&pos.entryDate!==D){const tp=pos.entryPrice*(1+TP/100),sl=pos.entryPrice*(1+SL/100);const held=db(y,pos.entryDate);let xp=0,hit=false;if(yb.low<=sl){xp=sl*(1-SLIP);hit=true;}else if(yb.high>=tp){xp=tp*(1-SLIP);hit=true;}else if(held>=MAXD){xp=yb.close*(1-SLIP);hit=true;}if(hit){cash+=pos.vol*xp*(1-FEE);pos=null;}}}
    const sig=evalF1F2({evalDate:y??D,dailyMap:dm,thresholds});if(sig.label&&!pos){const ep=daily[k].open*(1+SLIP);const buy=cash*SIZE*0.995;const fee=buy*FEE;if(buy>=5000&&buy+fee<=cash){const vol=buy/ep;cash-=buy+fee;pos={entryDate:D,entryPrice:ep,vol};}}
    eq.set(D,cash+(pos?pos.vol*daily[k].close:0));}
  return eq;
}
function sigF6(bars:CachedBar[],c:string,confirm:boolean){const vol=bars.map(b=>b.volume);const o:{coin:string;barIdx:number;ts:number}[]=[];
  if(!confirm){for(let i=LB+1;i<bars.length;i++){let mx=-Infinity;for(let j=i-LB;j<i-1;j++)if(bars[j].high>mx)mx=bars[j].high;if(!(bars[i-1].high>mx))continue;if(!(bars[i].close>bars[i].open))continue;if(!(bars[i].close>bars[i-1].high))continue;const z=volZ(vol,i,30);if(z==null||z<0.5)continue;o.push({coin:c,barIdx:i,ts:bars[i].ts});}}
  else{for(let Lx=LB+3;Lx<bars.length;Lx++){const i=Lx-1;let mx=-Infinity;for(let j=i-LB;j<i-1;j++)if(bars[j].high>mx)mx=bars[j].high;if(!(bars[i-1].high>mx))continue;if(!(bars[i].close>bars[i].open))continue;if(!(bars[i].close>bars[i-1].high))continue;const z=volZ(vol,i,30);if(z==null||z<0.5)continue;if(!(bars[Lx].close>bars[i].high))continue;if(!(bars[Lx].close>bars[Lx].open))continue;o.push({coin:c,barIdx:Lx,ts:bars[Lx].ts});}}
  return o;}
function simF6(tp:number,sl:number,pos:number,maxC:number,confirm:boolean,barsByCoin:Map<string,CachedBar[]>,idx:Map<string,Map<number,number>>):Map<string,number>{
  const MAXB=84;let cash=INITIAL;const positions:any[]=[];const eq=new Map<string,number>();
  const sigs:any[]=[];for(const[c,b]of barsByCoin)for(const s of sigF6(b,c,confirm))sigs.push(s);
  const byTs=new Map<number,any[]>();for(const s of sigs.sort((a,b)=>a.ts-b.ts)){if(!byTs.has(s.ts))byTs.set(s.ts,[]);byTs.get(s.ts)!.push(s);}
  const allTs=new Set<number>();for(const b of barsByCoin.values())for(const x of b)allTs.add(x.ts);const tsList=[...allTs].sort((a,b)=>a-b);
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){const p=positions[q];const ix=idx.get(p.coin)!.get(ts);if(ix==null)continue;const b=barsByCoin.get(p.coin)![ix];const hold=ix-p.entryIdx;let xp=0,hit=false;if(b.low<=p.sl){xp=p.sl;hit=true;}else if(b.high>=p.tp){xp=p.tp;hit=true;}else if(hold>=MAXB){xp=b.close;hit=true;}if(hit){cash+=p.cashUsed*(1+(xp-p.entryPrice)/p.entryPrice)*(1-COST);positions.splice(q,1);}}
    for(const s of (byTs.get(ts)||[])){if(positions.length>=maxC)break;const bars=barsByCoin.get(s.coin)!;const ei=s.barIdx+1;if(ei>=bars.length)continue;const ep=bars[ei].open;const use=cash*pos;if(use<5000)continue;cash-=use;positions.push({coin:s.coin,entryIdx:ei,entryPrice:ep,cashUsed:use,tp:ep*(1+tp/100),sl:ep*(1+sl/100)});}
    let mv=0;for(const p of positions){const ix=idx.get(p.coin)!.get(ts);if(ix!=null)mv+=p.cashUsed*(1+(barsByCoin.get(p.coin)![ix].close-p.entryPrice)/p.entryPrice);}
    eq.set(kst(ts),cash+mv);
  }
  return eq;
}
function mddOf(eq:number[]){let pk=-Infinity,m=0;for(const e of eq){if(e>pk)pk=e;const dd=(pk-e)/pk*100;if(dd>m)m=dd;}return m;}
function fmt(x:number,s=true){return `${s&&x>=0?'+':''}${x.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const barsByCoin=new Map<string,CachedBar[]>();for(const c of COINS){const b=loadBars(c);if(b.length>=8000)barsByCoin.set(c,b);}
  const idx=new Map<string,Map<number,number>>();for(const[c,bs]of barsByCoin){const m=new Map<number,number>();for(let i=0;i<bs.length;i++)m.set(bs[i].ts,i);idx.set(c,m);}
  const btcDaily=toDaily(barsByCoin.get('BTC')!);
  console.log('Fetching funding...');const funding=await fetchFundingHistory(new Date(btcDaily[0].date+'T00:00:00+09:00').getTime());
  const dm=aggregateDaily(funding);

  const strat:Record<string,Map<string,number>>={
    F1F2: simF1F2(btcDaily,dm),
    F6:   simF6(5,-2,0.33,3,false,barsByCoin,idx),
    F6v2: simF6(7,-2.5,0.33,3,false,barsByCoin,idx),
    F6v3: simF6(10,-3,0.25,4,true,barsByCoin,idx),
  };
  const names=Object.keys(strat);
  const allDates=[...new Set(names.flatMap(n=>[...strat[n].keys()]))].sort();
  const norm:Record<string,number[]>={};
  for(const n of names){const o:number[]=[];let last=INITIAL;for(const d of allDates){if(strat[n].has(d))last=strat[n].get(d)!;o.push(last/INITIAL);}norm[n]=o;}
  const T=allDates.length;
  const ret:Record<string,number[]>={};
  for(const n of names){const r:number[]=[0];for(let t=1;t<T;t++)r.push(norm[n][t]/norm[n][t-1]-1);ret[n]=r;}

  const staticStats=(w:number[])=>{const eq:number[]=[];for(let t=0;t<T;t++){let v=0;for(let i=0;i<names.length;i++)v+=w[i]*norm[names[i]][t];eq.push(v);}return {total:(eq[T-1]-1)*100,mdd:mddOf(eq)};};

  // 리스크패리티: 매월 리밸런스, 최근 lb일 vol 역가중 (dormant vol~0 제외)
  function riskParity(lb:number){
    const eq:number[]=[1];let curW=names.map(()=>1/names.length);const wHist:number[][]=[];
    for(let t=1;t<T;t++){
      if(allDates[t].slice(0,7)!==allDates[t-1].slice(0,7) && t>lb){
        const inv:number[]=[];let sum=0;
        for(const n of names){let s=0,s2=0;for(let k=t-lb;k<t;k++){s+=ret[n][k];s2+=ret[n][k]*ret[n][k];}const m=s/lb,v=Math.sqrt(Math.max(s2/lb-m*m,0));const iv=v<1e-5?0:1/v;inv.push(iv);sum+=iv;}
        curW=sum>0?inv.map(x=>x/sum):names.map(()=>1/names.length);wHist.push(curW);
      }
      let pr=0;for(let i=0;i<names.length;i++)pr+=curW[i]*ret[names[i]][t];eq.push(eq[t-1]*(1+pr));
    }
    const total=(eq[T-1]-1)*100,mdd=mddOf(eq);
    const avgW=names.map((_,i)=>wHist.length?wHist.reduce((s,w)=>s+w[i],0)/wHist.length:1/names.length);
    return {total,mdd,avgW};
  }

  // 고정 최적 (ret/MDD 최대)
  let best:any=null;const Wgrid:number[][]=[];
  for(let a=0;a<=10;a++)for(let b=0;a+b<=10;b++)for(let c=0;a+b+c<=10;c++){Wgrid.push([a/10,b/10,c/10,(10-a-b-c)/10]);}
  for(const w of Wgrid){const s=staticStats(w);const rpm=s.mdd>0?s.total/s.mdd:s.total;if(!best||rpm>best.rpm)best={w,...s,rpm};}
  const eqs=staticStats([0.25,0.25,0.25,0.25]);

  const rpm=(t:number,m:number)=>m>0?(t/m).toFixed(2):'-';
  const L:string[]=[];
  L.push('='.repeat(84));
  L.push(`R53 — 리스크 기반 동적 배분 vs 고정/균등 (${names.join('/')}, 4년 일별)`);
  L.push('='.repeat(84));
  L.push(`\n${pad('배분 방식',30)} | ${padS('total',9)} | ${padS('MDD',7)} | ${padS('ret/MDD',8)}`);
  L.push('-'.repeat(62));
  L.push(`${pad('균등 25/25/25/25',30)} | ${padS(fmt(eqs.total),9)} | ${padS(eqs.mdd.toFixed(1)+'%',7)} | ${padS(rpm(eqs.total,eqs.mdd),8)}`);
  L.push(`${pad('고정최적 '+best.w.map((x:number)=>Math.round(x*100)).join('/'),30)} | ${padS(fmt(best.total),9)} | ${padS(best.mdd.toFixed(1)+'%',7)} | ${padS(best.rpm.toFixed(2),8)}`);
  for(const lb of [30,60]){
    const r=riskParity(lb);
    L.push(`${pad(`리스크패리티 ${lb}d (동적)`,30)} | ${padS(fmt(r.total),9)} | ${padS(r.mdd.toFixed(1)+'%',7)} | ${padS(rpm(r.total,r.mdd),8)}`);
    L.push(`  └ 평균가중: ${names.map((n,i)=>n+' '+Math.round(r.avgW[i]*100)+'%').join(' / ')}`);
  }
  L.push(`\n해석: 동적이 고정최적에 근접하면서 in-sample 과최적화 없이 얻으면 실전 우위 (미래 데이터에 강건).`);
  L.push(`주의: 라이브 F6_v3는 저빈도→vol~0 구간에서 과대가중 위험. 백테스트는 정상거래라 무관.`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R53_RISK_ALLOC.txt`), L.join('\n'));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
