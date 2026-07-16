/** H4 변형 종합 백테스트: A스윕 B walk-forward C ATR트레일 D넓은SL E부분익절 F coiled G볼타깃 */
import fs from 'fs'; import path from 'path';
const DIR=path.resolve(process.cwd(),'data','candle-cache');
const COINS=['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LB=42,VW=30,MAXB=84,FEE=0.0005,SLIP=0.0005,ATRN=14;
const FR=(1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP);
interface Bar{ts:number;open:number;high:number;low:number;close:number;volume:number;}
const load=(m:string):Bar[]|null=>{const f=path.join(DIR,`${m}_240m_2022-06-10_2026-06-10.json`);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
function sig(b:Bar[],i:number){if(i<LB+1)return{hit:false};let pm=-Infinity;for(let j=i-LB;j<i-1;j++)if(b[j].high>pm)pm=b[j].high;if(!(b[i-1].high>pm)||!(b[i].close>b[i].open)||!(b[i].close>b[i-1].high))return{hit:false};let s=0,s2=0;for(let j=i-VW;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/VW,sd=Math.sqrt(Math.max(s2/VW-mn*mn,1e-12));const z=sd>0?(b[i].volume-mn)/sd:0;return{hit:z>=0.5};}
// precompute ATR% per bar
function atrPct(b:Bar[]):number[]{const tr:number[]=[0];for(let i=1;i<b.length;i++)tr.push(Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close)));const out:number[]=[];let sum=0;for(let i=0;i<b.length;i++){sum+=tr[i];if(i>=ATRN)sum-=tr[i-ATRN];out.push(i>=ATRN?(sum/ATRN)/b[i].close:NaN);}return out;}

interface Trade{coin:string;exitTs:number;ret:number;win:boolean;w:number;}
type Opt={sl:number;kind:'trail'|'atr'|'scaleout';act?:number;gap?:number;atrK?:number;tpP?:number;coiled?:boolean;volTarget?:boolean;from?:number;to?:number;};

function sim(o:Opt,data:Map<string,Bar[]>,atrs:Map<string,number[]>,medATR:Map<string,number>):Trade[]{
  const T:Trade[]=[];
  for(const[mkt,b]of data){
    const A=atrs.get(mkt)!,med=medATR.get(mkt)!;
    let ei=-1,ep=0,peak=0,sl=0,trailOn=false,ets=0,gapFrac=0,wgt=1,partDone=false,partRet=0;
    for(let i=LB+1;i<b.length;i++){
      if(ei>=0){ if(i>ei){const bar=b[i];let done=false,lvl=0,rsn='';
        // trailing stop 공통
        if(bar.low<=sl){lvl=sl;rsn=trailOn?'TR':'SL';done=true;}
        else{ if(o.kind==='scaleout'&&!partDone&&bar.high>=ep*(1+o.tpP!/100)){partDone=true;partRet=FR*(1+o.tpP!/100)-1;}
              peak=Math.max(peak,bar.high);
              const act=(o.act??3)/100;
              if(!trailOn&&peak>=ep*(1+act))trailOn=true;
              if(trailOn)sl=Math.max(sl,peak*(1-gapFrac)); }
        if(!done&&(i-ei)>=MAXB){lvl=bar.close;rsn='TI';done=true;}
        if(done){ let ret;
          if(o.kind==='scaleout'&&partDone){const rest=FR*(lvl/ep)-1;ret=0.5*partRet+0.5*rest;}
          else ret=FR*(lvl/ep)-1;
          if(!o.to||bar.ts< o.to) if(!o.from||bar.ts>=o.from) T.push({coin:mkt,exitTs:bar.ts,ret,win:ret>0,w:wgt});
          ei=-1;partDone=false;
        }
      } continue; }
      if(i>=b.length-1)continue;
      const g=sig(b,i);if(!g.hit)continue;
      const ap=A[i];
      if(o.coiled&&!(ap<med))continue;            // F: 진입봉 ATR%가 코인 중앙값보다 낮을때만
      ei=i+1;ep=b[i+1].open*(1+SLIP);ets=b[i+1].ts;sl=ep*(1+o.sl/100);peak=ep;trailOn=false;partDone=false;
      gapFrac=o.kind==='atr'?Math.min(0.15,(o.atrK??3)*(ap||0.02)):(o.gap??3)/100;
      wgt=o.volTarget?Math.max(0.25,Math.min(4,0.03/(ap||0.03))):1;  // G: 목표 ATR%3% 대비 역변동성
    }
  }
  return T;
}
function stat(T:Trade[]){if(!T.length)return null;const w=T.filter(t=>t.win);const gw=w.reduce((a,t)=>a+t.ret*t.w,0),gl=Math.abs(T.filter(t=>!t.win).reduce((a,t)=>a+t.ret*t.w,0));const seq=[...T].sort((a,b)=>a.exitTs-b.exitTs);let eq=0,pk=0,mdd=0;for(const t of seq){eq+=t.ret*t.w;pk=Math.max(pk,eq);mdd=Math.max(mdd,pk-eq);}const avgW=T.reduce((a,t)=>a+t.w,0)/T.length;return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:eq/avgW*100,mdd:mdd/avgW*100};}
const P=(x:number,d=0)=>x.toFixed(d);
function row(l:string,s:any){if(!s){console.log(l.padEnd(20)+'| -');return;}console.log(`${l.padEnd(20)}| ${String(s.n).padStart(4)} ${(P(s.wr,1)+'%').padStart(6)} PF${P(s.pf,2).padStart(5)} 총${(P(s.total)+'%').padStart(6)} MDD${(P(s.mdd)+'%').padStart(5)}`);}

(async()=>{
  const data=new Map<string,Bar[]>(),atrs=new Map<string,number[]>(),medATR=new Map<string,number>();
  for(const m of COINS){const b=load(m);if(b&&b.length>200){data.set(m,b);const a=atrPct(b);atrs.set(m,a);const v=a.filter(x=>!isNaN(x)).sort((x,y)=>x-y);medATR.set(m,v[Math.floor(v.length/2)]||0.03);}}
  const TR=Date.parse('2025-01-01T00:00:00Z'); // train<TR, test>=TR

  console.log('◆ A. 트레일 스윕 (act×gap) — 셀=총익%(PF)');
  let hdr='act\\gap  '; for(const g of[2,3,4,5])hdr+=('g'+g).padStart(11); console.log(hdr);
  for(const act of[2,3,4,5]){let ln=('a'+act).padEnd(9);for(const gap of[2,3,4,5]){const s=stat(sim({sl:-2,kind:'trail',act,gap},data,atrs,medATR))!;ln+=(`${P(s.total)}%(${P(s.pf,2)})`).padStart(11);}console.log(ln);}

  console.log('\n◆ B. Walk-forward (train 22-24 / test 25-26)');
  for(const[nm,o]of[['trail 3/3',{sl:-2,kind:'trail',act:3,gap:3}],['trail 4/3',{sl:-2,kind:'trail',act:4,gap:3}],['trail 3/4',{sl:-2,kind:'trail',act:3,gap:4}]]as[string,Opt][]){
    row(nm+' TRAIN',stat(sim({...o,to:TR},data,atrs,medATR)));
    row(nm+' TEST ',stat(sim({...o,from:TR},data,atrs,medATR)));
  }

  console.log('\n◆ C. ATR 트레일 (gap=k×ATR, act3) vs 고정3/3');
  row('고정 trail 3/3',stat(sim({sl:-2,kind:'trail',act:3,gap:3},data,atrs,medATR)));
  for(const k of[2,3,4])row('ATR k='+k,stat(sim({sl:-2,kind:'atr',act:3,atrK:k},data,atrs,medATR)));

  console.log('\n◆ D. 초기 SL 넓히기 (+ trail 3/3)');
  for(const sl of[-2,-3,-4])row('SL '+sl+'%',stat(sim({sl,kind:'trail',act:3,gap:3},data,atrs,medATR)));

  console.log('\n◆ E. 부분익절 (+5% 절반) + trail 3/3');
  row('trail 3/3 (기준)',stat(sim({sl:-2,kind:'trail',act:3,gap:3},data,atrs,medATR)));
  row('scaleout 5%+trail',stat(sim({sl:-2,kind:'scaleout',act:3,gap:3,tpP:5},data,atrs,medATR)));

  console.log('\n◆ F. Coiled 진입필터 (진입봉 ATR%<코인중앙값) + trail 3/3');
  row('필터 없음',stat(sim({sl:-2,kind:'trail',act:3,gap:3},data,atrs,medATR)));
  row('coiled only',stat(sim({sl:-2,kind:'trail',act:3,gap:3,coiled:true},data,atrs,medATR)));

  console.log('\n◆ G. 변동성타깃 사이징 (역ATR) vs 등가중 — trail 3/3');
  row('등가중',stat(sim({sl:-2,kind:'trail',act:3,gap:3},data,atrs,medATR)));
  row('vol-target',stat(sim({sl:-2,kind:'trail',act:3,gap:3,volTarget:true},data,atrs,medATR)));
})();
