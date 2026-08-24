/**
 * 시간대·요일 효과 검증 — 1h 탐색에서 유일하게 신호가 보인 축.
 *
 * 위험: 6개 시간대 × 7개 요일을 훑으면 우연히 좋아 보이는 칸이 반드시 나온다.
 *       그래서 (1) 표본을 4년으로 늘리고 (2) 전반/후반 반분에서 순위가 유지되는지 보고
 *       (3) 세션 단위로 묶어 자유도를 줄인다. 세 개를 다 통과해야 실재하는 효과다.
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, FR = (1-FEE)**2*(1-SLIP)/(1+SLIP), H = 3600_000;
interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number }
function load(m:string){const fs2=fs.readdirSync(DIR).filter(f=>f.startsWith(m+'_240m_'));let best:Bar[]|null=null;for(const f of fs2){const d=JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'));if(!best||d.length>best.length)best=d;}return best;}
const volZ=(b:Bar[],i:number,w:number)=>{if(i<w)return 0;let s=0,s2=0;for(let j=i-w;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}const mn=s/w,sd=Math.sqrt(Math.max(s2/w-mn*mn,1e-12));return sd>0?(b[i].volume-mn)/sd:0;};
const hiOf=(b:Bar[],f:number,t:number)=>{let m=-Infinity;for(let j=f;j<t;j++)m=Math.max(m,b[j].high);return m;};
const sig=(b:Bar[],i:number)=>i>=43&&b[i-1].high>hiOf(b,i-42,i-1)&&b[i].close>b[i].open&&b[i].close>b[i-1].high&&volZ(b,i,30)>=0.5;

interface T{entryTs:number;exitTs:number;ret:number}
const trades:T[]=[];
for(const m of COINS){
  const b=load(m); if(!b||b.length<400) continue;
  for(let i=43;i<b.length-1;i++){
    if(!sig(b,i)) continue;
    const eb=b[i+1], ep=eb.open*(1+SLIP);
    let peak=ep,tsl=ep*0.98,armed=false,px=0,ts=0;
    for(let j=i+2;j<b.length&&j-(i+1)<84;j++){
      const bar=b[j];
      if(bar.low<=tsl){px=tsl;ts=bar.ts;break;}
      peak=Math.max(peak,bar.high);
      if(!armed&&peak>=ep*1.02)armed=true;
      if(armed)tsl=Math.max(tsl,peak*0.98);
      if(j-(i+1)>=83){px=bar.close;ts=bar.ts;break;}
    }
    if(px>0) trades.push({entryTs:eb.ts,exitTs:ts,ret:FR*(px/ep)-1});
  }
}
function st(T:T[]){if(T.length<30)return null;const w=T.filter(t=>t.ret>0);const gw=w.reduce((a,t)=>a+t.ret,0),gl=Math.abs(T.filter(t=>t.ret<=0).reduce((a,t)=>a+t.ret,0));return{n:T.length,wr:w.length/T.length*100,pf:gl>0?gw/gl:99,total:T.reduce((a,t)=>a+t.ret,0)*100};}
const mid = trades.map(t=>t.entryTs).sort((a,b)=>a-b)[Math.floor(trades.length/2)];
function line(l:string,T:T[]){
  const a=st(T), f=st(T.filter(t=>t.entryTs<mid)), s=st(T.filter(t=>t.entryTs>=mid));
  const c=(x:ReturnType<typeof st>)=>x?`${x.pf.toFixed(2).padStart(5)}(n${String(x.n).padStart(4)})`:'   부족    ';
  console.log(`  ${l.padEnd(16)}| ${c(a)} | ${c(f)} | ${c(s)} | ${a?(a.total.toFixed(0)+'%').padStart(7):''}`);
}
console.log(`=== 시간대·요일 검증 (28코인 4h 4년, 신호마다 독립거래 n=${trades.length}) ===`);
console.log(`  반분 기준: ${new Date(mid).toISOString().slice(0,10)}\n`);
console.log('  구간            |   전체 PF   |   전반 PF   |   후반 PF   |    총익');
console.log('  ── 진입 시각 (KST) ──');
for(const h of [1,5,9,13,17,21]) line(`${String(h).padStart(2,'0')}시`, trades.filter(t=>new Date(t.entryTs+9*H).getUTCHours()===h));
console.log('  ── 세션 묶음 ──');
line('한국 낮 09·13시', trades.filter(t=>[9,13].includes(new Date(t.entryTs+9*H).getUTCHours())));
line('저녁~새벽 17·21·01·05시', trades.filter(t=>[17,21,1,5].includes(new Date(t.entryTs+9*H).getUTCHours())));
const WD=['일','월','화','수','목','금','토'];
console.log('  ── 요일 (KST) ──');
for(let d=0;d<7;d++) line(`${WD[d]}요일`, trades.filter(t=>new Date(t.entryTs+9*H).getUTCDay()===d));
console.log('  ── 주말 묶음 ──');
line('금·토·일', trades.filter(t=>[5,6,0].includes(new Date(t.entryTs+9*H).getUTCDay())));
line('월~목', trades.filter(t=>[1,2,3,4].includes(new Date(t.entryTs+9*H).getUTCDay())));
