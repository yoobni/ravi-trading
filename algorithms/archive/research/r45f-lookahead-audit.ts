/**
 * R45f — CONFIRM+TP10/SL3 lookahead(미래참조) 정밀 감사 (4년 4h).
 * ★ 읽기 전용. 운영 paper 안 건드림.
 *
 * 백테스트가 미래 정보를 미리 보고 매매하지 않았는지 실증 stress test:
 *  T1 BASELINE      : 현 로직 (신호=i+1확정, 진입=i+2 open, SL우선, 진입봉 당봉청산 포함)
 *  T2 ENTRY_DELAY+1 : 진입 한 봉 더 지연(i+3 open). lookahead 없으면 소폭만 하락해야.
 *  T3 ENTRY_DELAY+2 : 두 봉 지연. 견고성 확인.
 *  T4 TP_FIRST      : 동시도달봉 TP우선(낙관). baseline(SL우선)과 차이=intrabar 불확실성.
 *  T5 NO_SAMEBAR    : 진입봉 당봉청산 금지(다음봉부터). 더 보수적.
 * + 같은 봉 SL&TP 동시도달 거래수/비율 (intrabar 모호성 크기).
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL=10_000_000, COST_RT=0.001, MAXBARS=84, LB=42, POS=0.33, MC=3, TP=10, SL=-3;
const FROM='2022-06-10', TO='2026-06-10';
const COINS=['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v:number[],i:number,w=30):number|null{ if(i<w)return null; let s=0,s2=0; for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w; const sd=Math.sqrt(Math.max((s2/w)-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null; }
function f6Bars(bars:CachedBar[]):number[]{ const vol=bars.map(b=>b.volume); const out:number[]=[];
  for(let i=LB+1;i<bars.length;i++){ let pm=-Infinity; for(let j=i-LB;j<i-1;j++) if(bars[j].high>pm)pm=bars[j].high;
    if(!(bars[i-1].high>pm))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; out.push(i);} return out; }
interface Entry{coin:string;entryIdx:number;ts:number;}
// delay: 진입을 추가로 몇 봉 늦출지 (0=현 로직 i+2)
function confirmEntries(barsByCoin:Map<string,CachedBar[]>,delay:number):Entry[]{
  const out:Entry[]=[]; for(const [coin,bars] of barsByCoin){ for(const i of f6Bars(bars)){ const ei=i+2+delay; if(ei>=bars.length)continue;
    if(bars[i+1].close>bars[i].high&&bars[i+1].close>bars[i+1].open) out.push({coin,entryIdx:ei,ts:bars[ei-1].ts}); } } return out; }

function simulate(entries:Entry[],barsByCoin:Map<string,CachedBar[]>,tpFirst:boolean,sameBarExit:boolean,ps:number,pe:number){
  let cash=INITIAL; const positions:any[]=[]; const trades:any[]=[]; let ambig=0;
  const filt=entries.filter(e=>e.ts>=ps&&e.ts<=pe).sort((a,b)=>a.ts-b.ts);
  const byTs=new Map<number,Entry[]>(); for(const e of filt){ if(!byTs.has(e.ts))byTs.set(e.ts,[]); byTs.get(e.ts)!.push(e); }
  const allTs=new Set<number>(); for(const bars of barsByCoin.values()) for(const b of bars) if(b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);
  const idxMap=new Map<string,Map<number,number>>(); for(const [c,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++) m.set(bars[i].ts,i); idxMap.set(c,m); }
  let peak=INITIAL,mdd=0;
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){ const pos=positions[q]; const idx=idxMap.get(pos.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(pos.coin)![idx]; const hb=idx-pos.entryIdx;
      if(!sameBarExit && hb===0) continue; // 진입봉 당봉청산 금지 옵션
      const hitSL=b.low<=pos.sl, hitTP=b.high>=pos.tp; if(hitSL&&hitTP) ambig++;
      let ep=0,r:string|null=null;
      if(tpFirst){ if(hitTP){ep=pos.tp;r='TP';} else if(hitSL){ep=pos.sl;r='SL';} else if(hb>=MAXBARS){ep=b.close;r='TIME';} }
      else { if(hitSL){ep=pos.sl;r='SL';} else if(hitTP){ep=pos.tp;r='TP';} else if(hb>=MAXBARS){ep=b.close;r='TIME';} }
      if(r){ const cg=pos.vol*ep*(1-COST_RT/2); cash+=cg; trades.push({profitKrw:cg-pos.cashUsed}); positions.splice(q,1); } }
    for(const e of (byTs.get(ts)||[])){ if(positions.length>=MC)break; const bars=barsByCoin.get(e.coin); if(!bars)continue; if(e.entryIdx>=bars.length)continue;
      const ep=bars[e.entryIdx].open; const ctu=cash*POS; if(ctu<5000)continue; const vol=ctu*(1-COST_RT/2)/ep; cash-=ctu;
      positions.push({coin:e.coin,entryIdx:e.entryIdx,entryPrice:ep,vol,cashUsed:ctu,tp:ep*(1+TP/100),sl:ep*(1+SL/100)}); }
    let ov=0; for(const pos of positions){ const idx=idxMap.get(pos.coin)!.get(ts); if(idx!=null) ov+=pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq=cash+ov; if(eq>peak)peak=eq; const dd=(peak-eq)/peak*100; if(dd>mdd)mdd=dd;
  }
  for(const pos of positions){ const bars=barsByCoin.get(pos.coin)!; let li=bars.length-1; for(let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({profitKrw:cg-pos.cashUsed}); }
  return {trades,finalCash:cash,mdd,ambig};
}
function stats(t:any[],fc:number,mdd:number){ const n=t.length; if(!n)return{n:0,wr:0,total:0,pf:0,mdd};
  const w=t.filter(x=>x.profitKrw>0),l=t.filter(x=>x.profitKrw<=0); const tw=w.reduce((s,x)=>s+x.profitKrw,0),tl=Math.abs(l.reduce((s,x)=>s+x.profitKrw,0));
  return{n,wr:w.length/n*100,total:(fc-INITIAL)/INITIAL*100,pf:tl>0?tw/tl:(tw>0?99:0),mdd}; }
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}
const T=(s:string)=>new Date(s+'T00:00:00+09:00').getTime(); const Te=(s:string)=>new Date(s+'T23:59:59+09:00').getTime();

(async()=>{
  const bars=new Map<string,CachedBar[]>(); for(const c of COINS){ const b=await fetchMinutesCached(`KRW-${c}`,240,FROM,TO); if(b.length>=8000) bars.set(c,b); }
  const ps=T('2022-06-10'), pe=Te('2026-06-10');
  const e0=confirmEntries(bars,0), e1=confirmEntries(bars,1), e2=confirmEntries(bars,2);

  const L:string[]=[]; L.push('='.repeat(90));
  L.push(`R45f — CONFIRM+TP10/SL3 lookahead 감사 (4년 ${bars.size}코인, pos 33%×3)`); L.push('='.repeat(90));
  L.push(`\n${pad('test',18)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('4Y total',9)} | ${padS('PF',5)} | ${padS('MDD',5)} | 비고`);
  L.push('-'.repeat(80));

  const tests:[string,Entry[],boolean,boolean,string][]=[
    ['T1 BASELINE',      e0, false, true,  '현 로직 (SL우선, 당봉청산O)'],
    ['T2 ENTRY_DELAY+1', e1, false, true,  '진입 1봉 지연'],
    ['T3 ENTRY_DELAY+2', e2, false, true,  '진입 2봉 지연'],
    ['T4 TP_FIRST',      e0, true,  true,  '동시봉 TP우선(낙관)'],
    ['T5 NO_SAMEBAR',    e0, false, false, '진입봉 당봉청산 금지'],
  ];
  let baseTotal=0, ambigInfo='';
  for(const [nm,en,tpf,sbe,note] of tests){ const r=simulate(en,bars,tpf,sbe,ps,pe); const s=stats(r.trades,r.finalCash,r.mdd);
    if(nm.startsWith('T1')){ baseTotal=s.total; ambigInfo=`${r.ambig}건 (${(r.ambig/s.n*100).toFixed(1)}% of ${s.n})`; }
    const delta = nm.startsWith('T1')?'' : ` Δtotal ${fmt(s.total-baseTotal)}`;
    L.push(`${pad(nm,18)} | ${padS(String(s.n),5)} | ${padS(s.wr.toFixed(0)+'%',4)} | ${padS(fmt(s.total),9)} | ${padS(s.pf.toFixed(2),5)} | ${padS(s.mdd.toFixed(0)+'%',5)} | ${note}${delta}`);
  }
  L.push(`\n[intrabar 모호성] 같은 봉에서 SL·TP 동시도달: ${ambigInfo}`);
  L.push(`  → SL우선(보수)으로 처리. 이 비율이 낮을수록 결과 신뢰도↑`);

  const out=L.join('\n'); console.log(out);
  const fs=await import('fs'); fs.writeFileSync(path.resolve('data/research','R45f_lookahead_audit.txt'),out);
  process.exit(0);
})();
