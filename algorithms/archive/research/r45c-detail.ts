/**
 * R45c — BASE / CONFIRM / RS_LEAD 승률·수익 구조 상세 (2년 4h, 28코인).
 * ★ 읽기 전용. 운영 paper 안 건드림.
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL=10_000_000, POSITION_PCT=0.33, MAX_CONCURRENT=3, COST_RT=0.001, MAXBARS=84, LB=42;
const FROM='2024-06-10', TO='2026-06-10';
const COINS=['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v:number[],i:number,w=30):number|null{ if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null; }
function f6Bars(bars:CachedBar[]):number[]{ const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm)pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i);} return out; }
interface Entry{coin:string;entryIdx:number;ts:number;}
function buildEntries(algo:string,barsByCoin:Map<string,CachedBar[]>,btc:CachedBar[]):Entry[]{
  const out:Entry[]=[]; const btcRet=new Map<number,number>(); for(let i=30;i<btc.length;i++) btcRet.set(btc[i].ts,(btc[i].close-btc[i-30].close)/btc[i-30].close*100);
  for(const [coin,bars] of barsByCoin){ const brk=f6Bars(bars);
    for(const i of brk){ if(i+1>=bars.length)continue;
      if(algo==='BASE') out.push({coin,entryIdx:i+1,ts:bars[i].ts});
      else if(algo==='CONFIRM'){ if(i+2>=bars.length)continue; if(bars[i+1].close>bars[i].high&&bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:i+2,ts:bars[i+1].ts}); }
      else if(algo==='RS_LEAD'){ if(i>=30){ const br=btcRet.get(bars[i].ts); const cr=(bars[i].close-bars[i-30].close)/bars[i-30].close*100; if(br!=null&&cr>br) out.push({coin,entryIdx:i+1,ts:bars[i].ts}); } }
    } } return out;
}
interface Trade{coin:string;holdBars:number;netRet:number;profitKrw:number;reason:string;exitTs:number;}
function simulate(entries:Entry[],barsByCoin:Map<string,CachedBar[]>,tp:number,sl:number,ps:number,pe:number){
  let cash=INITIAL; const positions:any[]=[]; const trades:Trade[]=[];
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx; let ep=0,r:string|null=null,rr=0;
      if(b.low<=pos.sl){ep=pos.sl;r='SL';rr=(pos.sl-pos.entryPrice)/pos.entryPrice*100;} else if(b.high>=pos.tp){ep=pos.tp;r='TP';rr=(pos.tp-pos.entryPrice)/pos.entryPrice*100;} else if(hb>=MAXBARS){ep=b.close;r='TIME';rr=(b.close-pos.entryPrice)/pos.entryPrice*100;}
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({coin:pos.coin,holdBars:hb,netRet:rr-COST_RT*100,profitKrw:cg-pos.cashUsed,reason:r,exitTs:ts}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=MAX_CONCURRENT)break; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open; const ctu=cash*POSITION_PCT; if(ctu<5000)continue; const vol=ctu*(1-COST_RT/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,entryPrice:ep,vol,cashUsed:ctu,tp:ep*(1+tp/100),sl:ep*(1+sl/100)}); }
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({coin:pos.coin,holdBars:bars[li].ts<=pe?li-pos.entryIdx:0,netRet:(bars[li].close-pos.entryPrice)/pos.entryPrice*100-COST_RT*100,profitKrw:cg-pos.cashUsed,reason:'END',exitTs:bars[li].ts}); }
  return {trades,finalCash:cash};
}
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(2)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const bars=new Map<string,CachedBar[]>(); for(const c of COINS){ const b=await fetchMinutesCached(`KRW-${c}`,240,FROM,TO); if(b.length>=4000) bars.set(c,b); }
  const btc=bars.get('BTC')!;
  const ps=new Date('2024-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();
  const quarters:{n:string;s:number;e:number}[]=[]; const sd=new Date('2024-06-10');
  for(let q=0;q<8;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push({n:`Q${q+1}`,s:new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(),e:new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime()}); }

  const L:string[]=[]; L.push('='.repeat(80)); L.push(`R45c — BASE / CONFIRM / RS_LEAD 승률·수익 구조 (2년 ${bars.size}코인)`); L.push('='.repeat(80));

  for(const algo of ['BASE','CONFIRM','RS_LEAD']){
    const entries=buildEntries(algo,bars,btc);
    const { trades, finalCash } = simulate(entries,bars,5,-2,ps,pe);
    const n=trades.length; const wins=trades.filter(t=>t.profitKrw>0), losses=trades.filter(t=>t.profitKrw<=0);
    const wr=wins.length/n*100;
    const avgWin=wins.reduce((s,t)=>s+t.netRet,0)/(wins.length||1);
    const avgLoss=losses.reduce((s,t)=>s+t.netRet,0)/(losses.length||1);
    const payoff=Math.abs(avgWin/(avgLoss||1));
    const expect=trades.reduce((s,t)=>s+t.netRet,0)/n; // 거래당 기대수익%
    const total=(finalCash-INITIAL)/INITIAL*100;
    const tw=wins.reduce((s,t)=>s+t.profitKrw,0), tl=Math.abs(losses.reduce((s,t)=>s+t.profitKrw,0)); const pf=tl>0?tw/tl:99;
    L.push(`\n${'━'.repeat(60)}\n■ ${algo}   (n=${n}, 2Y total ${fmt(total)}, PF ${pf.toFixed(2)})\n${'━'.repeat(60)}`);
    L.push(`  승률(WR)        : ${wr.toFixed(1)}%  (승 ${wins.length} / 패 ${losses.length})`);
    L.push(`  평균 익절폭      : ${fmt(avgWin)}   (수익 거래 1건당)`);
    L.push(`  평균 손절폭      : ${fmt(avgLoss)}   (손실 거래 1건당)`);
    L.push(`  손익비(payoff)   : ${payoff.toFixed(2)} : 1   (이기면 ${payoff.toFixed(1)}배 먹고 지면 1배 잃음)`);
    L.push(`  거래당 기대수익   : ${fmt(expect)}   ★ (WR×익절 − (1-WR)×손절, 비용반영)`);
    // 청산사유
    L.push(`  청산 사유:`);
    for(const r of ['TP','SL','TIME','END']){ const t=trades.filter(x=>x.reason===r); if(!t.length)continue;
      const avg=t.reduce((s,x)=>s+x.netRet,0)/t.length; const hold=t.reduce((s,x)=>s+x.holdBars,0)/t.length;
      L.push(`     ${r.padEnd(4)} ${String(t.length).padStart(3)}건 (${(t.length/n*100).toFixed(0).padStart(2)}%)  평균 ${fmt(avg)}  보유 ${hold.toFixed(1)}bar(${(hold*4).toFixed(0)}h)`); }
    // 코인
    const byCoin=new Map<string,number>(); for(const t of trades) byCoin.set(t.coin,(byCoin.get(t.coin)||0)+t.profitKrw);
    const sorted=[...byCoin.entries()].sort((a,b)=>b[1]-a[1]); const winCoins=sorted.filter(([,v])=>v>0).length;
    L.push(`  코인: 수익 ${winCoins}/${sorted.length}  | top3 ${sorted.slice(0,3).map(([c,v])=>`${c}+${(v/1e6).toFixed(1)}M`).join(' ')}  | worst ${sorted.slice(-2).map(([c,v])=>`${c}${(v/1e6).toFixed(1)}M`).join(' ')}`);
    // 분기
    const qstr=quarters.map(q=>{ const r=simulate(entries,bars,5,-2,q.s,q.e); const w=r.trades.filter(t=>t.profitKrw>0).length; const tt=(r.finalCash-INITIAL)/INITIAL*100; return `${q.n}:${fmt(tt)}`; });
    L.push(`  분기: ${qstr.join('  ')}`);
  }
  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45c_detail.txt'),out);
  process.exit(0);
})();
