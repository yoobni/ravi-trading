/**
 * R50 — Cross-sectional 상대강도 모멘텀 (F6와 다른 알파 후보).
 *
 * F6 = 시계열 모멘텀(절대 돌파). 이건 횡단면: 매 리밸런스 코인을 최근수익률로 랭크 → 상위 k 롱, 로테이션.
 * 두 변형:
 *   PURE : 무조건 상위 k
 *   DUAL : 상위 k 중 추세 양수(lookback ret>0)인 것만, 나머지 슬롯 현금 (dual momentum)
 * 핵심: 4년 total/MDD + F6_v2와 월별 상관(무상관이면 스택 가치) + 합성 MDD.
 *
 * 롱 온리(Upbit 현물). 리밸런스 시 turnover에만 비용. lookahead-safe(확정 close만).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL = 10_000_000, COST_RT = 0.001, LOOKBACK_F6 = 42;
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(c: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${c}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(fp)) return [];
  return (JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBar[]).sort((a,b)=>a.ts-b.ts);
}
const kst=(ts:number)=>new Date(ts+9*3600000).toISOString().slice(0,10);

// ─── F6_v2 롱 (상관 비교용) → eqByDate ───
function volZ(v:number[],i:number,w=30):number|null{if(i<w)return null;let s=0,s2=0;for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];}const m=s/w,sd=Math.sqrt(Math.max(s2/w-m*m,1e-12));return sd>0?(v[i]-m)/sd:null;}
function simF6v2(barsByCoin:Map<string,CachedBar[]>, idx:Map<string,Map<number,number>>, ps:number, pe:number){
  const TP=7,SL=-2.5,MAXB=84,POS=0.33,MAXC=3; let cash=INITIAL;const positions:any[]=[];
  const sigs:{coin:string;barIdx:number;ts:number}[]=[];
  for(const [c,bars] of barsByCoin){const vol=bars.map(b=>b.volume);for(let i=LOOKBACK_F6+1;i<bars.length;i++){let mx=-Infinity;for(let j=i-LOOKBACK_F6;j<i-1;j++)if(bars[j].high>mx)mx=bars[j].high;if(!(bars[i-1].high>mx))continue;if(!(bars[i].close>bars[i].open))continue;if(!(bars[i].close>bars[i-1].high))continue;const z=volZ(vol,i,30);if(z==null||z<0.5)continue;sigs.push({coin:c,barIdx:i,ts:bars[i].ts});}}
  const byTs=new Map<number,any[]>();for(const s of sigs.sort((a,b)=>a.ts-b.ts)){if(!byTs.has(s.ts))byTs.set(s.ts,[]);byTs.get(s.ts)!.push(s);}
  const allTs=new Set<number>();for(const bars of barsByCoin.values())for(const b of bars)if(b.ts>=ps&&b.ts<=pe)allTs.add(b.ts);
  const tsList=[...allTs].sort((a,b)=>a-b);let peak=INITIAL,mdd=0;const eq=new Map<string,number>();
  for(const ts of tsList){
    for(let q=positions.length-1;q>=0;q--){const p=positions[q];const ix=idx.get(p.coin)!.get(ts);if(ix==null)continue;const b=barsByCoin.get(p.coin)![ix];const hold=ix-p.entryIdx;let xp=0,hit=false;if(b.low<=p.sl){xp=p.sl;hit=true;}else if(b.high>=p.tp){xp=p.tp;hit=true;}else if(hold>=MAXB){xp=b.close;hit=true;}if(hit){cash+=p.cashUsed*(1+(xp-p.entryPrice)/p.entryPrice)*(1-COST_RT);positions.splice(q,1);}}
    for(const s of (byTs.get(ts)||[])){if(positions.length>=MAXC)break;const bars=barsByCoin.get(s.coin)!;const ei=s.barIdx+1;if(ei>=bars.length)continue;const ep=bars[ei].open;const use=cash*POS;if(use<5000)continue;cash-=use;positions.push({coin:s.coin,entryIdx:ei,entryPrice:ep,cashUsed:use,tp:ep*(1+TP/100),sl:ep*(1+SL/100)});}
    let mv=0;for(const p of positions){const ix=idx.get(p.coin)!.get(ts);if(ix!=null)mv+=p.cashUsed*(1+(barsByCoin.get(p.coin)![ix].close-p.entryPrice)/p.entryPrice);}
    const e=cash+mv;if(e>peak)peak=e;const dd=(peak-e)/peak*100;if(dd>mdd)mdd=dd;eq.set(kst(ts),e);
  }
  for(const p of positions){const bars=barsByCoin.get(p.coin)!;let li=bars.length-1;for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=pe){li=i;break;}cash+=p.cashUsed*(1+(bars[li].close-p.entryPrice)/p.entryPrice)*(1-COST_RT);}
  return {total:(cash-INITIAL)/INITIAL*100,mdd,eq};
}

// ─── Cross-sectional momentum ───
interface XCfg{name:string;lookback:number;k:number;rebal:number;dual:boolean;}
function simXsec(cfg:XCfg, barsByCoin:Map<string,CachedBar[]>, idx:Map<string,Map<number,number>>, commonTs:number[], ps:number, pe:number){
  const tsIn = commonTs.filter(t=>t>=ps&&t<=pe);
  let equity=INITIAL; let holdings=new Map<string,number>(); // coin -> vol
  let peak=INITIAL,mdd=0; const eqByDate=new Map<string,number>();
  const periodRets:number[]=[]; // 각 리밸런스 구간 포트폴리오 수익률(대략) — WR/PF용
  const priceAt=(c:string,ts:number)=>{const ix=idx.get(c)!.get(ts);return ix!=null?barsByCoin.get(c)![ix].close:null;};
  let lastRebalEquity=INITIAL;
  for(let t=0;t<tsIn.length;t++){
    const ts=tsIn[t];
    // 리밸런스 시점?
    const globalIdx = commonTs.indexOf(ts); // 느리지만 OK
    const isRebal = t===0 || (globalIdx>=0 && globalIdx % cfg.rebal===0);
    // mark to market
    let mv=0; for(const [c,vol] of holdings){const p=priceAt(c,ts); if(p!=null) mv+=vol*p;}
    // cash = equity - invested at last rebal; 간단화: equity 추적을 holdings+cash로
    // 여기선 holdings만 쓰고 잔여는 cash로 관리
    if(isRebal){
      // 현재 청산 가치 = mv + cashLeft. cashLeft 추적 위해 equity를 직접 씀:
      // 리밸런스 직전 equity 계산
      let curEq = mv; // 아래 cash 별도
      curEq += cashLeft;
      // 구간 수익률 기록
      if(t>0){ periodRets.push((curEq-lastRebalEquity)/lastRebalEquity*100); lastRebalEquity=curEq; }
      // 랭크: lookback 수익률
      const ranked:{c:string;ret:number}[]=[];
      for(const c of barsByCoin.keys()){
        const ix=idx.get(c)!.get(ts); if(ix==null||ix<cfg.lookback) continue;
        const bars=barsByCoin.get(c)!; const now=bars[ix].close, then=bars[ix-cfg.lookback].close;
        ranked.push({c, ret:(now-then)/then});
      }
      ranked.sort((a,b)=>b.ret-a.ret);
      let picks=ranked.slice(0,cfg.k);
      if(cfg.dual) picks=picks.filter(p=>p.ret>0);
      // turnover 비용: 이전 holdings 집합 vs 새 picks 집합
      const newSet=new Set(picks.map(p=>p.c)); const oldSet=new Set(holdings.keys());
      let turnoverFrac=0; for(const c of oldSet) if(!newSet.has(c)) turnoverFrac+=1; for(const c of newSet) if(!oldSet.has(c)) turnoverFrac+=1;
      const slotEq = picks.length>0 ? curEq/cfg.k : 0; // 빈 슬롯은 현금(dual)
      // 비용: 바뀐 슬롯 수 × slotEq × COST_RT
      const cost = turnoverFrac * (curEq/cfg.k) * (COST_RT/2);
      curEq -= cost;
      // 새 holdings 구성
      holdings=new Map(); let invested=0;
      for(const p of picks){ const pr=priceAt(p.c,ts); if(pr!=null){ const v=slotEq/pr; holdings.set(p.c,v); invested+=slotEq; } }
      cashLeft = curEq - invested; if(cashLeft<0) cashLeft=0;
      equity=curEq;
    } else {
      equity = mv + cashLeft;
    }
    if(equity>peak)peak=equity;const dd=(peak-equity)/peak*100;if(dd>mdd)mdd=dd;
    eqByDate.set(kst(ts),equity);
  }
  const wins=periodRets.filter(r=>r>0),losses=periodRets.filter(r=>r<=0);
  const pf=losses.length?wins.reduce((s,x)=>s+x,0)/Math.abs(losses.reduce((s,x)=>s+x,0)):(wins.length?99:0);
  const ds=[...eqByDate.keys()].sort(); const total=ds.length?(eqByDate.get(ds[ds.length-1])!-INITIAL)/INITIAL*100:0;
  return {total,mdd,eqByDate,wr:periodRets.length?wins.length/periodRets.length*100:0,pf,periods:periodRets.length};
}
let cashLeft=0; // module-level 임시 (simXsec 내 리셋)

function monthly(eq:Map<string,number>):Map<string,number>{const ds=[...eq.keys()].sort();const me=new Map<string,number>();for(const d of ds)me.set(d.slice(0,7),eq.get(d)!);const ms=[...me.keys()].sort();const r=new Map<string,number>();for(let i=1;i<ms.length;i++)r.set(ms[i],(me.get(ms[i])!-me.get(ms[i-1])!)/me.get(ms[i-1])!*100);return r;}
function pearson(a:number[],b:number[]):number{const n=Math.min(a.length,b.length);if(n<3)return NaN;const ma=a.reduce((s,x)=>s+x,0)/n,mb=b.reduce((s,x)=>s+x,0)/n;let c=0,va=0,vb=0;for(let i=0;i<n;i++){c+=(a[i]-ma)*(b[i]-mb);va+=(a[i]-ma)**2;vb+=(b[i]-mb)**2;}return c/Math.sqrt(va*vb+1e-12);}
function mddOf(eq:Map<string,number>){const ds=[...eq.keys()].sort();let pk=-Infinity,m=0;for(const d of ds){const e=eq.get(d)!;if(e>pk)pk=e;const dd=(pk-e)/pk*100;if(dd>m)m=dd;}return m;}
function totalOf(eq:Map<string,number>){const ds=[...eq.keys()].sort();return (eq.get(ds[ds.length-1])!-INITIAL)/INITIAL*100;}
function fmt(x:number,s=true){return `${s&&x>=0?'+':''}${x.toFixed(1)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async()=>{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const barsByCoin=new Map<string,CachedBar[]>();for(const c of COINS){const b=loadBars(c);if(b.length>=8000)barsByCoin.set(c,b);}
  const idx=new Map<string,Map<number,number>>();for(const[c,bs]of barsByCoin){const m=new Map<number,number>();for(let i=0;i<bs.length;i++)m.set(bs[i].ts,i);idx.set(c,m);}
  const btcTs=barsByCoin.get('BTC')!.map(b=>b.ts); // 공통 grid = BTC ts
  const ps=new Date('2022-06-10T00:00:00+09:00').getTime(), pe=new Date('2026-06-10T23:59:59+09:00').getTime();

  const f6=simF6v2(barsByCoin,idx,ps,pe);
  const rF6=monthly(f6.eq);

  const cfgs:XCfg[]=[];
  for(const lb of [42,84]) for(const k of [3,5]) for(const dual of [false,true])
    cfgs.push({name:`L${lb/6}d k${k} ${dual?'DUAL':'PURE'}`, lookback:lb, k, rebal:42, dual}); // 주간 리밸런스

  const L:string[]=[];
  L.push('='.repeat(96));
  L.push(`R50 — Cross-sectional 모멘텀 (${barsByCoin.size}코인, 주간 리밸런스, 4Y). F6_v2 벤치: total ${fmt(f6.total)} MDD ${f6.mdd.toFixed(1)}%`);
  L.push('='.repeat(96));
  L.push(`${pad('config',18)} | ${padS('total',9)} | ${padS('MDD',6)} | ${padS('WR',5)} | ${padS('PF',5)} | ${padS('vs F6 상관',10)} | ${padS('합성MDD',8)}`);
  L.push('-'.repeat(80));
  for(const cfg of cfgs){
    cashLeft=INITIAL; // 리셋
    const r=simXsec(cfg,barsByCoin,idx,btcTs,ps,pe);
    const rx=monthly(r.eqByDate); const ms=[...rF6.keys()].filter(m=>rx.has(m)).sort();
    const corr=pearson(ms.map(m=>rF6.get(m)!),ms.map(m=>rx.get(m)!));
    // 50/50 합성
    const allD=[...new Set([...f6.eq.keys(),...r.eqByDate.keys()])].sort();
    const fill=(eq:Map<string,number>)=>{const o=new Map<string,number>();let last=INITIAL;for(const d of allD){if(eq.has(d))last=eq.get(d)!;o.set(d,last);}return o;};
    const a=fill(f6.eq),b=fill(r.eqByDate);const combo=new Map<string,number>();for(const d of allD)combo.set(d,0.5*a.get(d)!+0.5*b.get(d)!);
    L.push(`${pad(cfg.name,18)} | ${padS(fmt(r.total),9)} | ${padS(r.mdd.toFixed(1)+'%',6)} | ${padS(r.wr.toFixed(0)+'%',5)} | ${padS(r.pf.toFixed(2),5)} | ${padS(corr.toFixed(2),10)} | ${padS(mddOf(combo).toFixed(1)+'%',8)}`);
  }
  L.push(`\n해석: total 양수 + F6 상관 낮음(≤0.5) + 합성MDD가 F6단독(${f6.mdd.toFixed(1)}%)보다 낮으면 스택 가치.`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R50_XSEC_MOMENTUM.txt`), L.join('\n'));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
