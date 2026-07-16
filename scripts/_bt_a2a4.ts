/** act2/gap2 vs act4/gap2 정밀 비교 (기준: act3/gap3). */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005;
const FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function sig(b:Bar[],i:number){if(i<LB+1)return false;let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return false;let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));return (sd>0?(b[i].volume-mn)/sd:0)>=0.5;}
interface Tr{coin:string;exitTs:number;ret:number;win:boolean;}
function sim(act:number,gap:number,data:Map<string,Bar[]>):Tr[]{
  const T:Tr[]=[];
  for(const[mkt,b]of data){let ei=-1,ep=0,peak=0,sl=0,on=false;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){if(i>ei){const bar=b[i];let done=false,lvl=0;
        if(bar.low<=sl){lvl=sl;done=true;}
        else{peak=Math.max(peak,bar.high);if(!on&&peak>=ep*(1+act/100))on=true;if(on)sl=Math.max(sl,peak*(1-gap/100));}
        if(!done&&(i-ei)>=MAXB){lvl=bar.close;done=true;}
        if(done){T.push({coin:mkt,exitTs:bar.ts,ret:FR*(lvl/ep)-1,win:FR*(lvl/ep)-1>0});ei=-1;}
      }continue;}
      if(i>=b.length-1||!sig(b,i))continue;
      ei=i+1;ep=b[i+1].open*(1+SLIP);sl=ep*0.98;peak=ep;on=false;
    }}
  return T;
}
const yr=(ts:number)=>new Date(ts+9*3600000).getUTCFullYear();
const ym=(ts:number)=>new Date(ts+9*3600000).toISOString().slice(0,7);
function metrics(T:Tr[]){
  const n=T.length,w=T.filter(t=>t.win),l=T.filter(t=>!t.win);
  const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(l.reduce((a,t)=>a+t.ret,0));
  const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);
  let eq=0,pk=0,mdd=0,cur=0,maxLoss=0,curW=0,maxWin=0;
  for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);
    if(t.win){curW++;cur=0;maxWin=Math.max(maxWin,curW);}else{cur++;curW=0;maxLoss=Math.max(maxLoss,cur);}}
  // 월별 손익
  const mo:Record<string,number>={};seq.forEach(t=>mo[ym(t.exitTs)]=(mo[ym(t.exitTs)]||0)+t.ret);
  const months=Object.values(mo),posMo=months.filter(x=>x>0).length;
  // 집중도
  const sorted=[...T].sort((a,b)=>b.ret-a.ret);
  const top10=sorted.slice(0,10).reduce((a,t)=>a+t.ret,0);
  const byCoin:Record<string,number>={};T.forEach(t=>byCoin[t.coin]=(byCoin[t.coin]||0)+t.ret);
  const coinV=Object.values(byCoin),posCoins=coinV.filter(x=>x>0).length;
  return {n,wr:w.length/n*100,pf:gw/gl,exp:(gw-gl)/n*100,
    avgW:gw/w.length*100,avgL:-gl/l.length*100,bigW:sorted[0].ret*100,bigL:sorted[sorted.length-1].ret*100,
    total:eq*100,mdd:mdd*100,maxLossStreak:maxLoss,maxWinStreak:maxWin,
    posMonthPct:posMo/months.length*100,nMonths:months.length,
    top10Share:top10/eq*100,posCoins,totalCoins:coinV.length,
    topCoin:Object.entries(byCoin).sort((a,b)=>b[1]-a[1])[0]};
}
function yearRows(T:Tr[]){const out:Record<number,any>={};for(const y of[2022,2023,2024,2025,2026]){const s=T.filter(t=>yr(t.exitTs)===y);if(!s.length){out[y]=null;continue;}const seq=[...s].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}const w=s.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(s.filter(t=>!t.win).reduce((a,t)=>a+t.ret,0));out[y]={total:eq*100,pf:gl>0?gw/gl:99,mdd:mdd*100,n:s.length};}return out;}

(async()=>{
  const data=new Map<string,Bar[]>();for(const m of COINS){const b=load(m);if(b&&b.length>200)data.set(m,b);}
  const configs:[string,number,number][]=[['현재 a3/g3',3,3],['A2 (act2/gap2)',2,2],['A4 (act4/gap2)',4,2]];
  const R=configs.map(([nm,a,g])=>({nm,m:metrics(sim(a,g,data)),y:yearRows(sim(a,g,data))}));
  const p=(x:number,d=0)=>x.toFixed(d);
  const pad=(s:string,n:number)=>s.padStart(n);

  console.log('════ 종합 지표 ════');
  console.log('지표'.padEnd(16)+R.map(r=>pad(r.nm,16)).join(''));
  const rows:[string,(m:any)=>string][]=[
    ['거래수',m=>p(m.n)],['승률',m=>p(m.wr,1)+'%'],['PF',m=>p(m.pf,2)],['기대값/건',m=>p(m.exp,2)+'%'],
    ['평균익',m=>'+'+p(m.avgW,1)+'%'],['평균손',m=>p(m.avgL,1)+'%'],['최대익',m=>'+'+p(m.bigW)+'%'],['최대손',m=>p(m.bigL,1)+'%'],
    ['총손익',m=>p(m.total)+'%'],['MDD',m=>p(m.mdd)+'%'],['수익/MDD',m=>p(m.total/m.mdd,2)],
    ['최대연속손실',m=>p(m.maxLossStreak)+'회'],['흑자월%',m=>p(m.posMonthPct,0)+'%'],
    ['상위10건=총익',m=>p(m.top10Share,0)+'%'],['흑자코인',m=>m.posCoins+'/'+m.totalCoins],
    ['최고코인',m=>m.topCoin[0].replace('KRW-','')+' +'+p(m.topCoin[1]*100)+'%'],
  ];
  for(const[lbl,fn]of rows)console.log(lbl.padEnd(16)+R.map(r=>pad(fn(r.m),16)).join(''));

  console.log('\n════ 연도별 총손익% (PF) ════');
  console.log('연도'.padEnd(16)+R.map(r=>pad(r.nm,16)).join(''));
  for(const y of[2022,2023,2024,2025,2026]){
    console.log(String(y).padEnd(16)+R.map(r=>{const c=r.y[y];return pad(c?`${p(c.total)}%(${p(c.pf,2)})`:'-',16);}).join(''));
  }
})();
