/**
 * R45g — BASE(TP5/SL2) vs CONFIRM(TP10/SL3) 승률·매수/매도 비율 (4년 4h).
 * ★ 읽기 전용. 운영 paper 안 건드림.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL=10_000_000, COST_RT=0.001, MAXBARS=84, LB=42, POS=0.33, MC=3;
const FROM='2022-06-10', TO='2026-06-10';
const COINS=['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v:number[],i:number,w=30):number|null{ if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null; }
function f6Bars(bars:CachedBar[]):number[]{ const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm)pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i);} return out; }
interface Entry{coin:string;entryIdx:number;ts:number;}
function buildEntries(algo:string,barsByCoin:Map<string,CachedBar[]>):Entry[]{
  const out:Entry[]=[]; for(const [coin,bars] of barsByCoin){ for(const i of f6Bars(bars)){ if(i+1>=bars.length)continue;
    if(algo==='BASE') out.push({coin,entryIdx:i+1,ts:bars[i].ts});
    else { if(i+2>=bars.length)continue; if(bars[i+1].close>bars[i].high&&bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:i+2,ts:bars[i+1].ts}); } } } return out; }
function simulate(entries:Entry[],barsByCoin:Map<string,CachedBar[]>,tp:number,sl:number,ps:number,pe:number){
  let cash=INITIAL; const positions:any[]=[]; const trades:any[]=[];
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  let signalsSeen=0;
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx; let ep=0,r:string|null=null;
      if(b.low<=pos.sl){ep=pos.sl;r='SL';} else if(b.high>=pos.tp){ep=pos.tp;r='TP';} else if(hb>=MAXBARS){ep=b.close;r='TIME';}
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({holdBars:hb,profitKrw:cg-pos.cashUsed,reason:r}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ signalsSeen++; if(positions.length>=MC)continue; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open; const ctu=cash*POS; if(ctu<5000)continue; const vol=ctu*(1-COST_RT/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,vol,cashUsed:ctu,tp:ep*(1+tp/100),sl:ep*(1+sl/100)}); }
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({holdBars:li-pos.entryIdx,profitKrw:cg-pos.cashUsed,reason:'END'}); }
  return {trades,finalCash:cash,signalsSeen};
}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const bars=new Map<string,CachedBar[]>(); for(const c of COINS){ const b=await fetchMinutesCached(`KRW-${c}`,240,FROM,TO); if(b.length>=8000) bars.set(c,b); }
  const ps=new Date('2022-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();
  const L:string[]=[]; L.push('='.repeat(78));
  L.push(`R45g — 승률·매수/매도 비율 (4년 ${bars.size}코인)`); L.push('='.repeat(78));
  const cfgs:[string,string,number,number][]=[['운영 F6 (BASE)','BASE',5,-2],['CONFIRM+TP10/SL3','CONFIRM',10,-3]];
  for(const [label,algo,tp,sl] of cfgs){
    const en=buildEntries(algo,bars); const r=simulate(en,bars,tp,sl,ps,pe); const t=r.trades; const n=t.length;
    const wins=t.filter(x=>x.profitKrw>0).length, losses=n-wins;
    const tpN=t.filter(x=>x.reason==='TP').length, slN=t.filter(x=>x.reason==='SL').length, tiN=t.filter(x=>x.reason==='TIME').length, enN=t.filter(x=>x.reason==='END').length;
    const total=(r.finalCash-INITIAL)/INITIAL*100;
    L.push(`\n${'━'.repeat(50)}\n■ ${label}  (4년)\n${'━'.repeat(50)}`);
    L.push(`  매수(진입) 건수   : ${n}건  (연 ${(n/4).toFixed(0)}건, 약 ${(n/4/12).toFixed(1)}건/월)`);
    L.push(`  신호 발생→진입 전환: ${r.signalsSeen}건 신호 중 ${n}건 진입 (${(n/r.signalsSeen*100).toFixed(0)}%, 나머지는 동시보유 max3 초과로 스킵)`);
    L.push(`  승률(WR)         : ${(wins/n*100).toFixed(1)}%   (이긴 매도 ${wins} / 진 매도 ${losses})`);
    L.push(`  ── 매도(청산) 사유 비율 ──`);
    L.push(`     TP 익절   : ${padS(String(tpN),4)}건  ${padS((tpN/n*100).toFixed(1)+'%',6)}`);
    L.push(`     SL 손절   : ${padS(String(slN),4)}건  ${padS((slN/n*100).toFixed(1)+'%',6)}`);
    L.push(`     TIME 만기 : ${padS(String(tiN),4)}건  ${padS((tiN/n*100).toFixed(1)+'%',6)}  (MAX 84bar=14일 도달)`);
    if(enN) L.push(`     END 기간말: ${padS(String(enN),4)}건  ${padS((enN/n*100).toFixed(1)+'%',6)}`);
    L.push(`     → 익절:손절 = ${(tpN/Math.max(slN,1)).toFixed(2)} : 1`);
    L.push(`  평균 보유기간     : ${(t.reduce((s,x)=>s+x.holdBars,0)/n*4).toFixed(0)}시간`);
    L.push(`  4년 누적수익      : ${total>=0?'+':''}${total.toFixed(1)}%`);
  }
  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45g_winrate.txt'),out);
  process.exit(0);
})();
