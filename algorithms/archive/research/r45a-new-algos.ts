/**
 * R45a — 기존 F6 단점 보완 신규 알고 6종 개별 백테스트 + 상관행렬 (2년 4h, 28코인).
 * ★ 읽기 전용. 운영 paper 안 건드림. 2년 4h 캐시 재사용.
 *
 * BASE     : F6 원본 (lb42, vz0.5, TP5/SL-2/MAX84)
 * CONFIRM  : 돌파 다음봉도 종가>돌파봉고가 확정 후 진입 (거짓돌파 보완)
 * TREND    : 코인 4h EMA100 위에서만 진입 (추세 정렬)
 * RS_LEAD  : 직전 30봉 수익률 > BTC 동기간 (상대강도)
 * ATR_EXIT : TP=3×ATR, SL=1.2×ATR (변동성 적응)
 * MREV     : RSI14<25 과매도 + 양봉전환 롱, TP+5/SL-3 (약세장 비상관)
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL_CASH = 10_000_000, POSITION_PCT = 0.33, MAX_CONCURRENT = 3, COST_RT = 0.001;
const FROM = '2024-06-10', TO = '2026-06-10';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const LB = 42, MAXBARS = 84;

function calcEMA(v: number[], p: number): (number|null)[] {
  const k=2/(p+1); const o:(number|null)[]=new Array(v.length).fill(null); let e:number|null=null,s=0;
  for (let i=0;i<v.length;i++){ if(i<p-1){s+=v[i];continue;} if(e===null){s+=v[i];e=s/p;} else e=v[i]*k+e*(1-k); o[i]=e; } return o;
}
function calcATR(h:number[],l:number[],c:number[],p=14):(number|null)[] {
  const tr:number[]=[]; for(let i=0;i<c.length;i++){ if(i===0){tr.push(h[i]-l[i]);continue;} tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); }
  const o:(number|null)[]=new Array(c.length).fill(null); let a:number|null=null,s=0;
  for(let i=0;i<tr.length;i++){ if(i<p-1){s+=tr[i];continue;} if(a===null){s+=tr[i];a=s/p;} else a=(a*(p-1)+tr[i])/p; o[i]=a; } return o;
}
function calcRSI(c:number[],p=14):(number|null)[] {
  const o:(number|null)[]=new Array(c.length).fill(null); let ag=0,al=0;
  for(let i=1;i<c.length;i++){ const d=c[i]-c[i-1]; const g=Math.max(d,0),ls=Math.max(-d,0);
    if(i<=p){ ag+=g; al+=ls; if(i===p){ag/=p;al/=p; o[i]=al===0?100:100-100/(1+ag/al);} }
    else { ag=(ag*(p-1)+g)/p; al=(al*(p-1)+ls)/p; o[i]=al===0?100:100-100/(1+ag/al); } } return o;
}
function calcVolZ(v:number[],i:number,w=30):number|null {
  if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];}
  const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null;
}

interface Entry { coin:string; entryIdx:number; ts:number; }
// F6 신고가-돌파-양봉-volZ 신호의 신고가봉 인덱스 i 반환
function f6BreakoutBars(bars:CachedBar[]):number[] {
  const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm) pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i); } return out;
}

// BTC 직전 30봉 수익률 맵 (ts → ret%) — RS_LEAD용
function btcRetByTs(btc:CachedBar[], win=30):Map<number,number> {
  const m=new Map<number,number>(); for(let i=win;i<btc.length;i++) m.set(btc[i].ts,(btc[i].close-btc[i-win].close)/btc[i-win].close*100); return m;
}

function buildEntries(algo:string, barsByCoin:Map<string,CachedBar[]>, btc:CachedBar[]):Entry[] {
  const out:Entry[]=[]; const btcRet=btcRetByTs(btc,30);
  for(const [coin,bars] of barsByCoin){
    const closes=bars.map(b=>b.close);
    if(algo==='MREV'){
      const rsi=calcRSI(closes,14);
      for(let i=15;i<bars.length-1;i++){ if(rsi[i-1]!=null && rsi[i-1]!<25 && bars[i].close>bars[i].open){ out.push({coin,entryIdx:i+1,ts:bars[i].ts}); } }
      continue;
    }
    const brk=f6BreakoutBars(bars);
    const ema100= algo==='TREND'?calcEMA(closes,100):null;
    for(const i of brk){
      if(i+1>=bars.length)continue;
      if(algo==='BASE'||algo==='ATR_EXIT'){ out.push({coin,entryIdx:i+1,ts:bars[i].ts}); }
      else if(algo==='CONFIRM'){ if(i+2>=bars.length)continue; if(bars[i+1].close>bars[i].high && bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:i+2,ts:bars[i+1].ts}); }
      else if(algo==='TREND'){ if(ema100![i]!=null && closes[i]>ema100![i]!) out.push({coin,entryIdx:i+1,ts:bars[i].ts}); }
      else if(algo==='RS_LEAD'){ const br=btcRet.get(bars[i].ts); if(i>=30){ const cr=(bars[i].close-bars[i-30].close)/bars[i-30].close*100; if(br!=null && cr>br) out.push({coin,entryIdx:i+1,ts:bars[i].ts}); } }
    }
  }
  return out;
}

function simulate(entries:Entry[], barsByCoin:Map<string,CachedBar[]>, exitMode:'fixed'|'atr', tp:number, sl:number, atrByCoin:Map<string,(number|null)[]>, ps:number, pe:number) {
  let cash=INITIAL_CASH; const positions:any[]=[]; const trades:any[]=[];
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  let peak=INITIAL_CASH,mdd=0;
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx; let ep=0,r:string|null=null;
      if(b.low<=pos.sl){ep=pos.sl;r='SL';} else if(b.high>=pos.tp){ep=pos.tp;r='TP';} else if(hb>=MAXBARS){ep=b.close;r='TIME';}
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({exitTs:ts,profitKrw:cg-pos.cashUsed}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=MAX_CONCURRENT)break; const bars=barsByCoin.get(e.coin); if(!bars)continue;
      if(e.entryIdx>=bars.length)continue; const ep=bars[e.entryIdx].open; const ctu=cash*POSITION_PCT; if(ctu<5000)continue;
      const vol=ctu*(1-COST_RT/2)/ep; let tpP,slP;
      if(exitMode==='atr'){ const a=atrByCoin.get(e.coin)![e.entryIdx-1]; if(a==null)continue; tpP=ep+tp*a; slP=ep-sl*a; }
      else { tpP=ep*(1+tp/100); slP=ep*(1+sl/100); }
      cash-=ctu; positions.push({coin:e.coin,entryIdx:e.entryIdx,vol,cashUsed:ctu,tp:tpP,sl:slP}); }
    let ov=0; for(const pos of positions){ const idx=idxMap.get(pos.coin)!.get(ts); if(idx!=null) ov+=pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq=cash+ov; if(eq>peak)peak=eq; const dd=(peak-eq)/peak*100; if(dd>mdd)mdd=dd;
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({exitTs:bars[li].ts,profitKrw:cg-pos.cashUsed}); }
  return {trades,finalCash:cash,mdd};
}
function stats(t:any[],fc:number,mdd:number){ const n=t.length; if(!n)return{n:0,wr:0,total:0,pf:0,mdd};
  const w=t.filter(x=>x.profitKrw>0),l=t.filter(x=>x.profitKrw<=0); const tw=w.reduce((s,x)=>s+x.profitKrw,0),tl=Math.abs(l.reduce((s,x)=>s+x.profitKrw,0));
  return{n,wr:w.length/n*100,total:(fc-INITIAL_CASH)/INITIAL_CASH*100,pf:tl>0?tw/tl:(tw>0?99:0),mdd}; }
function monthly(t:any[]):Map<string,number>{ const m=new Map<string,number>(); for(const x of t){ const k=new Date(x.exitTs).toISOString().slice(0,7); m.set(k,(m.get(k)||0)+x.profitKrw); } return m; }
function corr(a:number[],b:number[]):number{ const n=a.length; if(n<2)return 0; const ma=a.reduce((s,x)=>s+x,0)/n,mb=b.reduce((s,x)=>s+x,0)/n;
  let num=0,da=0,db=0; for(let i=0;i<n;i++){ num+=(a[i]-ma)*(b[i]-mb); da+=(a[i]-ma)**2; db+=(b[i]-mb)**2; } return (da&&db)?num/Math.sqrt(da*db):0; }
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const bars=new Map<string,CachedBar[]>();
  for(const coin of COINS){ const b=await fetchMinutesCached(`KRW-${coin}`,240,FROM,TO); if(b.length>=4000) bars.set(coin,b); }
  const btc=bars.get('BTC')!;
  const atrByCoin=new Map<string,(number|null)[]>(); for(const [c,b] of bars) atrByCoin.set(c,calcATR(b.map(x=>x.high),b.map(x=>x.low),b.map(x=>x.close),14));
  const ps=new Date('2024-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();
  const quarters:[number,number][]=[]; const sd=new Date('2024-06-10');
  for(let q=0;q<8;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push([new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(),new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime()]); }

  const ALGOS=['BASE','CONFIRM','TREND','RS_LEAD','ATR_EXIT','MREV'];
  const L:string[]=[]; L.push('='.repeat(95));
  L.push(`R45a — F6 단점보완 신규 알고 6종 (2년 ${bars.size}코인)`); L.push(`pos 33%×3, cost 0.1%`); L.push('='.repeat(95));
  L.push(`\n${pad('algo',10)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('2Y total',9)} | ${padS('PF',5)} | ${padS('MDD',5)} | ${padS('분기',5)}`);
  L.push('-'.repeat(60));
  const mret:Record<string,Map<string,number>>={};
  const results:Record<string,any>={};
  for(const algo of ALGOS){
    const entries=buildEntries(algo,bars,btc);
    const exitMode = algo==='ATR_EXIT'?'atr':'fixed';
    const tp = algo==='ATR_EXIT'?3 : 5; const sl = algo==='ATR_EXIT'?1.2 : (algo==='MREV'?-3:-2);
    const r=simulate(entries,bars,exitMode as any,tp,sl,atrByCoin,ps,pe); const s=stats(r.trades,r.finalCash,r.mdd);
    let qp=0; for(const [qs,qe] of quarters){ const rr=simulate(entries,bars,exitMode as any,tp,sl,atrByCoin,qs,qe); const ss=stats(rr.trades,rr.finalCash,rr.mdd); if(ss.pf>=1.2&&ss.total>0)qp++; }
    mret[algo]=monthly(r.trades); results[algo]={s,qp};
    L.push(`${pad(algo,10)} | ${padS(String(s.n),5)} | ${padS(s.wr.toFixed(0)+'%',4)} | ${padS(fmt(s.total),9)} | ${padS(s.pf.toFixed(2),5)} | ${padS(s.mdd.toFixed(0)+'%',5)} | ${padS(qp+'/8',5)}`);
  }
  // 상관행렬 (월별 PnL)
  const months=[...new Set(ALGOS.flatMap(a=>[...mret[a].keys()]))].sort();
  const series:Record<string,number[]>={}; for(const a of ALGOS) series[a]=months.map(m=>mret[a].get(m)||0);
  L.push(`\n## 월별 PnL 상관행렬 (낮을수록 조합 분산효과↑)\n`);
  L.push(`${pad('',10)} | ${ALGOS.map(a=>padS(a.slice(0,7),8)).join(' | ')}`);
  L.push('-'.repeat(10+ALGOS.length*11));
  for(const a of ALGOS){ L.push(`${pad(a,10)} | ${ALGOS.map(b=>padS(corr(series[a],series[b]).toFixed(2),8)).join(' | ')}`); }

  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45a_new_algos.txt'),out);
  process.exit(0);
})();
