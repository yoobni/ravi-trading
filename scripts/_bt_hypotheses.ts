/**
 * 가설 비교 백테스트 — F6 base 신호 + 5개 변형, 4년 4h 캐시.
 * per-coin 순차 상태머신(코인당 1포지션), per-trade expectancy 집계.
 * 마찰: fee 0.05% + slip 0.05% (round-trip ~0.1%).
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const LOOKBACK = 42, VOLZ_W = 30, MAX_BARS = 84;
const FEE = 0.0005, SLIP = 0.0005;
const FRICTION = (1-FEE)*(1-FEE)*(1-SLIP)/(1+SLIP); // net multiplier on (exit/entryOpen)

interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number; }
function load(m:string):Bar[]|null {
  const f = path.join(DIR, `${m}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f,'utf8'));
}

// F6 base signal at index i (매치 evaluateF6)
function signal(b:Bar[], i:number): {hit:boolean, volZ:number} {
  if (i < LOOKBACK + 1) return {hit:false,volZ:0};
  let pm = -Infinity;
  for (let j=i-LOOKBACK; j<i-1; j++) if (b[j].high>pm) pm=b[j].high;
  if (!(b[i-1].high>pm)) return {hit:false,volZ:0};
  if (!(b[i].close>b[i].open)) return {hit:false,volZ:0};
  if (!(b[i].close>b[i-1].high)) return {hit:false,volZ:0};
  // volZ over [i-30, i-1]
  let s=0,s2=0; for(let j=i-VOLZ_W;j<i;j++){s+=b[j].volume;s2+=b[j].volume*b[j].volume;}
  const mean=s/VOLZ_W, sd=Math.sqrt(Math.max(s2/VOLZ_W-mean*mean,1e-12));
  const z = sd>0 ? (b[i].volume-mean)/sd : 0;
  if (z < 0.5) return {hit:false,volZ:z};
  return {hit:true, volZ:z};
}

// BTC regime by ts: 42-bar 수익률 ±3% 밴드
function buildRegime(btc:Bar[]): Map<number,string> {
  const m = new Map<number,string>();
  for (let i=0;i<btc.length;i++){
    if (i<LOOKBACK){ m.set(btc[i].ts,'?'); continue; }
    const chg=(btc[i].close-btc[i-LOOKBACK].close)/btc[i-LOOKBACK].close;
    m.set(btc[i].ts, chg>0.03?'UP':chg<-0.03?'DOWN':'SIDE');
  }
  return m;
}

type Variant = {
  name:string;
  volZmin?:number;        // H5
  skipSide?:boolean;      // H1
  cooldownBars?:number;   // H2
  breakeven?:number;      // H3: +x% 도달시 SL→본전
  trailing?:{act:number, gap:number}; // H4: act% 후 gap% 트레일 (TP 제거)
  tp:number; sl:number;
};

const VARIANTS: Variant[] = [
  { name:'BASE (F6 원본)', tp:0.05, sl:-0.02 },
  { name:'H1 횡보회피',    tp:0.05, sl:-0.02, skipSide:true },
  { name:'H2 재진입쿨다운', tp:0.05, sl:-0.02, cooldownBars:18 },
  { name:'H3 본전스톱',    tp:0.05, sl:-0.02, breakeven:0.015 },
  { name:'H4 트레일링',    tp:0.05, sl:-0.02, trailing:{act:0.03, gap:0.03} },
  { name:'H5 volZ≥1.0',    tp:0.05, sl:-0.02, volZmin:1.0 },
  { name:'H1+H2 결합',     tp:0.05, sl:-0.02, skipSide:true, cooldownBars:18 },
];

interface Trade { ret:number; exitTs:number; win:boolean; }

function runVariant(v:Variant, data:Map<string,Bar[]>, regime:Map<number,string>): Trade[] {
  const trades:Trade[] = [];
  for (const [mkt,b] of data){
    let entryIdx=-1, entryPrice=0, peak=0, sl=0, tp=0, beDone=false, trailOn=false;
    let cooldownUntil=-1;
    for (let i=LOOKBACK+1; i<b.length; i++){
      if (entryIdx>=0){
        // 진입 다음 봉부터 청산 검사
        if (i>entryIdx){
          const bar=b[i]; let exit:null|{lvl:number,reason:string}=null;
          // H4 트레일링: TP 없음
          if (v.trailing){
            if (bar.low<=sl) exit={lvl:sl,reason:'SL'};
            else { peak=Math.max(peak,bar.high);
                   if(!trailOn && peak>=entryPrice*(1+v.trailing.act)) trailOn=true;
                   if(trailOn) sl=Math.max(sl, peak*(1-v.trailing.gap)); }
          } else {
            if (bar.low<=sl) exit={lvl:sl,reason:'SL'};
            else if (bar.high>=tp) exit={lvl:tp,reason:'TP'};
            else if (v.breakeven && !beDone && bar.high>=entryPrice*(1+v.breakeven)){ sl=Math.max(sl,entryPrice); beDone=true; }
          }
          if (!exit && (i-entryIdx)>=MAX_BARS) exit={lvl:bar.close,reason:'TIME'};
          if (exit){
            const ret = FRICTION*(exit.lvl/entryPrice) - 1;
            trades.push({ret, exitTs:bar.ts, win:ret>0});
            if (exit.reason==='SL' && v.cooldownBars) cooldownUntil = i + v.cooldownBars;
            entryIdx=-1;
          }
        }
        continue;
      }
      // flat → 진입 검토 (i+1 open 필요)
      if (i>=b.length-1) continue;
      if (v.cooldownBars && i<cooldownUntil) continue;
      const sg = signal(b,i);
      if (!sg.hit) continue;
      if (v.volZmin && sg.volZ<v.volZmin) continue;
      if (v.skipSide && regime.get(b[i].ts)==='SIDE') continue;
      // enter at i+1 open
      entryIdx=i+1; entryPrice=b[i+1].open*(1+SLIP);
      sl=entryPrice*(1+v.sl); tp=entryPrice*(1+v.tp); peak=entryPrice; beDone=false; trailOn=false;
    }
  }
  return trades;
}

function stats(trades:Trade[]){
  const n=trades.length; if(!n) return null;
  const wins=trades.filter(t=>t.win), losses=trades.filter(t=>!t.win);
  const gw=wins.reduce((a,t)=>a+t.ret,0), gl=Math.abs(losses.reduce((a,t)=>a+t.ret,0));
  const pf = gl>0? gw/gl : Infinity;
  const wr = wins.length/n*100;
  const avgW = wins.length? gw/wins.length*100:0, avgL=losses.length? -gl/losses.length*100:0;
  const exp = (gw-gl)/n*100;
  // equity: exit순 정렬, additive 누적 (fraction-free)
  const seq=[...trades].sort((a,b)=>a.exitTs-b.exitTs);
  let eq=0, peak=0, mdd=0;
  for(const t of seq){ eq+=t.ret; peak=Math.max(peak,eq); mdd=Math.max(mdd, peak-eq); }
  const total=eq*100;
  return {n, wr, avgW, avgL, pf, exp, total, mdd:mdd*100, tp:trades.filter(t=>t.win).length};
}

(async()=>{
  const data=new Map<string,Bar[]>();
  for (const m of COINS){ const b=load(m); if(b&&b.length>200) data.set(m,b); }
  const btc=data.get('KRW-BTC')!;
  const regime=buildRegime(btc);
  const span = `${new Date(btc[0].ts).toISOString().slice(0,10)} ~ ${new Date(btc[btc.length-1].ts).toISOString().slice(0,10)}`;
  console.log(`데이터: ${data.size}코인, BTC ${btc.length}봉, 기간 ${span}\n`);
  console.log('가설            | 거래  승률   평균익  평균손   PF    기대값  총손익%  MDD%');
  console.log('----------------|------------------------------------------------------------');
  for (const v of VARIANTS){
    const s=stats(runVariant(v,data,regime));
    if(!s){console.log(`${v.name.padEnd(15)}| 거래 없음`);continue;}
    const p=(x:number,d=1)=>x.toFixed(d);
    console.log(`${v.name.padEnd(15)}| ${String(s.n).padStart(4)} ${p(s.wr).padStart(5)}% ${(p(s.avgW)+'%').padStart(6)} ${(p(s.avgL)+'%').padStart(6)} ${p(s.pf,2).padStart(5)} ${(p(s.exp,2)+'%').padStart(6)} ${(p(s.total,0)+'%').padStart(7)} ${p(s.mdd,0).padStart(4)}%`);
  }
})();
