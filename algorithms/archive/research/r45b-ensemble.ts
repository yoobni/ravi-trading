/**
 * R45b — R45a 신규 알고 조합(앙상블) 백테스트 (2년 4h, 28코인).
 * ★ 읽기 전용. 운영 paper 안 건드림. 2년 4h 캐시 재사용.
 *
 * 자본분할 앙상블: 각 알고를 INITIAL×weight로 독립 운영, ts별 equity 합산 → 합산 곡선 MDD/total/PF.
 * 음상관 MREV를 섞어 risk-adjusted 개선되는지 검증.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL = 10_000_000, POSITION_PCT = 0.33, MAX_CONCURRENT = 3, COST_RT = 0.001, MAXBARS = 84, LB = 42;
const FROM = '2024-06-10', TO = '2026-06-10';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcRSI(c:number[],p=14):(number|null)[]{ const o:(number|null)[]=new Array(c.length).fill(null); let ag=0,al=0;
  for(let i=1;i<c.length;i++){ const d=c[i]-c[i-1]; const g=Math.max(d,0),ls=Math.max(-d,0);
    if(i<=p){ag+=g;al+=ls; if(i===p){ag/=p;al/=p;o[i]=al===0?100:100-100/(1+ag/al);}} else {ag=(ag*(p-1)+g)/p;al=(al*(p-1)+ls)/p;o[i]=al===0?100:100-100/(1+ag/al);} } return o; }
function calcVolZ(v:number[],i:number,w=30):number|null{ if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null; }
function f6Bars(bars:CachedBar[]):number[]{ const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm)pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i);} return out; }

interface Entry { coin:string; entryIdx:number; ts:number; }
function buildEntries(algo:string, barsByCoin:Map<string,CachedBar[]>, btc:CachedBar[]):Entry[] {
  const out:Entry[]=[]; const btcRet=new Map<number,number>(); for(let i=30;i<btc.length;i++) btcRet.set(btc[i].ts,(btc[i].close-btc[i-30].close)/btc[i-30].close*100);
  for(const [coin,bars] of barsByCoin){ const closes=bars.map(b=>b.close);
    if(algo==='MREV'){ const rsi=calcRSI(closes,14); for(let i=15;i<bars.length-1;i++){ if(rsi[i-1]!=null&&rsi[i-1]!<25&&bars[i].close>bars[i].open) out.push({coin,entryIdx:i+1,ts:bars[i].ts}); } continue; }
    const brk=f6Bars(bars);
    for(const i of brk){ if(i+1>=bars.length)continue;
      if(algo==='RS_LEAD'){ if(i>=30){ const br=btcRet.get(bars[i].ts); const cr=(bars[i].close-bars[i-30].close)/bars[i-30].close*100; if(br!=null&&cr>br) out.push({coin,entryIdx:i+1,ts:bars[i].ts}); } }
      else if(algo==='CONFIRM'){ if(i+2>=bars.length)continue; if(bars[i+1].close>bars[i].high&&bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:i+2,ts:bars[i+1].ts}); }
      else if(algo==='BASE'){ out.push({coin,entryIdx:i+1,ts:bars[i].ts}); }
    }
  }
  return out;
}
// equity 시계열 반환 (ts→eq), trades도
function simulate(entries:Entry[], barsByCoin:Map<string,CachedBar[]>, initial:number, tp:number, sl:number, ps:number, pe:number) {
  let cash=initial; const positions:any[]=[]; const trades:any[]=[]; const eqSeries=new Map<number,number>();
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx; let ep=0,r:string|null=null;
      if(b.low<=pos.sl){ep=pos.sl;r='SL';} else if(b.high>=pos.tp){ep=pos.tp;r='TP';} else if(hb>=MAXBARS){ep=b.close;r='TIME';}
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({profitKrw:cg-pos.cashUsed}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=MAX_CONCURRENT)break; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open; const ctu=cash*POSITION_PCT; if(ctu<5000)continue; const vol=ctu*(1-COST_RT/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,vol,cashUsed:ctu,tp:ep*(1+tp/100),sl:ep*(1+sl/100)}); }
    let ov=0; for(const pos of positions){ const idx=idxMap.get(pos.coin)!.get(ts); if(idx!=null) ov+=pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    eqSeries.set(ts,cash+ov);
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({profitKrw:cg-pos.cashUsed}); }
  return { trades, eqSeries, finalCash:cash };
}
// 합산: 여러 알고 equity series를 공통 ts(grid)에서 forward-fill 후 합산 → total/MDD/PF
function combine(parts:{entries:Entry[];w:number;tp:number;sl:number}[], barsByCoin:Map<string,CachedBar[]>, grid:number[], ps:number, pe:number) {
  const sims=parts.map(p=>({ ...simulate(p.entries,barsByCoin,INITIAL*p.w,p.tp,p.sl,ps,pe) }));
  const allTrades=sims.flatMap(s=>s.trades);
  let peak=INITIAL,mdd=0; const gridF=grid.filter(t=>t>=ps&&t<=pe);
  const last=new Array(sims.length).fill(0).map((_,k)=>INITIAL*parts[k].w);
  for(const ts of gridF){ let sum=0; for(let k=0;k<sims.length;k++){ if(sims[k].eqSeries.has(ts)) last[k]=sims[k].eqSeries.get(ts)!; sum+=last[k]; } if(sum>peak)peak=sum; const dd=(peak-sum)/peak*100; if(dd>mdd)mdd=dd; }
  const finalEq=sims.reduce((s,x)=>s+x.finalCash,0);
  const w=allTrades.filter(t=>t.profitKrw>0),l=allTrades.filter(t=>t.profitKrw<=0);
  const tw=w.reduce((s,t)=>s+t.profitKrw,0),tl=Math.abs(l.reduce((s,t)=>s+t.profitKrw,0));
  return { n:allTrades.length, wr:allTrades.length?w.length/allTrades.length*100:0, total:(finalEq-INITIAL)/INITIAL*100, pf:tl>0?tw/tl:(tw>0?99:0), mdd };
}
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const bars=new Map<string,CachedBar[]>();
  for(const coin of COINS){ const b=await fetchMinutesCached(`KRW-${coin}`,240,FROM,TO); if(b.length>=4000) bars.set(coin,b); }
  const btc=bars.get('BTC')!; const grid=btc.map(b=>b.ts);
  const ps=new Date('2024-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();
  const quarters:[number,number][]=[]; const sd=new Date('2024-06-10');
  for(let q=0;q<8;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push([new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(),new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime()]); }

  const E:Record<string,Entry[]>={ RS_LEAD:buildEntries('RS_LEAD',bars,btc), CONFIRM:buildEntries('CONFIRM',bars,btc), BASE:buildEntries('BASE',bars,btc), MREV:buildEntries('MREV',bars,btc) };
  const TP=5, SL=-2, SLm=-3; // MREV는 SL-3

  const combos:{name:string; parts:{algo:string;w:number;tp:number;sl:number}[]}[]=[
    { name:'RS_LEAD 단독',         parts:[{algo:'RS_LEAD',w:1,tp:TP,sl:SL}] },
    { name:'CONFIRM 단독',         parts:[{algo:'CONFIRM',w:1,tp:TP,sl:SL}] },
    { name:'RS70+MREV30',          parts:[{algo:'RS_LEAD',w:0.7,tp:TP,sl:SL},{algo:'MREV',w:0.3,tp:TP,sl:SLm}] },
    { name:'CONFIRM60+MREV40',     parts:[{algo:'CONFIRM',w:0.6,tp:TP,sl:SL},{algo:'MREV',w:0.4,tp:TP,sl:SLm}] },
    { name:'RS40+CONF40+MREV20',   parts:[{algo:'RS_LEAD',w:0.4,tp:TP,sl:SL},{algo:'CONFIRM',w:0.4,tp:TP,sl:SL},{algo:'MREV',w:0.2,tp:TP,sl:SLm}] },
    { name:'RS80+MREV20',          parts:[{algo:'RS_LEAD',w:0.8,tp:TP,sl:SL},{algo:'MREV',w:0.2,tp:TP,sl:SLm}] },
  ];

  const L:string[]=[]; L.push('='.repeat(85));
  L.push(`R45b — 신규 알고 조합 앙상블 (2년 ${bars.size}코인). 자본분할, 합산 equity 기준`);
  L.push('='.repeat(85));
  L.push(`\n${pad('combo',22)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('2Y total',9)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',5)} | ${padS('수익/MDD',9)}`);
  L.push('-'.repeat(85));
  for(const c of combos){
    const parts=c.parts.map(p=>({entries:E[p.algo],w:p.w,tp:p.tp,sl:p.sl}));
    const r=combine(parts,bars,grid,ps,pe);
    let qp=0; for(const [qs,qe] of quarters){ const rr=combine(parts,bars,grid,qs,qe); if(rr.pf>=1.2&&rr.total>0)qp++; }
    const ratio = r.mdd>0? r.total/r.mdd : 0;
    L.push(`${pad(c.name,22)} | ${padS(String(r.n),5)} | ${padS(r.wr.toFixed(0)+'%',4)} | ${padS(fmt(r.total),9)} | ${padS(r.pf.toFixed(2),5)} | ${padS(r.mdd.toFixed(0)+'%',5)} | ${padS(qp+'/8',5)} | ${padS(ratio.toFixed(1),9)}`);
  }
  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45b_ensemble.txt'),out);
  process.exit(0);
})();
