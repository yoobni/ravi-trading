/**
 * R51 — 시간대·요일 효과 (싸고 빠른 탐색).
 *
 * (a) 4h 봉 수익률을 KST 시각(0/4/8/12/16/20)·요일별로 집계 — 체계적 drift 있나?
 * (b) F6 진입을 세션별로 나눠 성과 차이 — 특정 시간대 진입이 유리한가?
 * 결론: 시간대 구조가 있으면 F6 필터/미세알파로 쓸 여지.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const LOOKBACK = 42;
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBars(c: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${c}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(fp)) return [];
  return (JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBar[]).sort((a,b)=>a.ts-b.ts);
}
const kstHour=(ts:number)=>new Date(ts+9*3600000).getUTCHours();
const kstDow=(ts:number)=>new Date(ts+9*3600000).getUTCDay(); // 0=일
const DOW=['일','월','화','수','목','금','토'];
function volZ(v:number[],i:number,w=30):number|null{if(i<w)return null;let s=0,s2=0;for(let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];}const m=s/w,sd=Math.sqrt(Math.max(s2/w-m*m,1e-12));return sd>0?(v[i]-m)/sd:null;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}
function fmt(x:number){return `${x>=0?'+':''}${x.toFixed(3)}%`;}

(async()=>{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const barsByCoin=new Map<string,CachedBar[]>();for(const c of COINS){const b=loadBars(c);if(b.length>=8000)barsByCoin.set(c,b);}

  // (a) 4h 봉 수익률 by KST 시각
  const byHour=new Map<number,number[]>(); const byDow=new Map<number,number[]>();
  for(const bars of barsByCoin.values()){
    for(let i=1;i<bars.length;i++){
      const ret=(bars[i].close-bars[i-1].close)/bars[i-1].close*100;
      const h=kstHour(bars[i].ts), d=kstDow(bars[i].ts);
      if(!byHour.has(h))byHour.set(h,[]);byHour.get(h)!.push(ret);
      if(!byDow.has(d))byDow.set(d,[]);byDow.get(d)!.push(ret);
    }
  }
  const stat=(a:number[])=>({n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,wr:a.filter(x=>x>0).length/a.length*100});

  const L:string[]=[];
  L.push('='.repeat(72));
  L.push(`R51 — 시간대·요일 효과 (${barsByCoin.size}코인 4h, 4Y)`);
  L.push('='.repeat(72));
  L.push(`\n## (a) KST 시각별 4h 봉 평균수익률`);
  L.push(`${pad('KST시',6)} | ${padS('평균ret',9)} | ${padS('상승%',6)} | ${padS('n',7)}`);
  L.push('-'.repeat(38));
  const hours=[...byHour.keys()].sort((a,b)=>a-b);
  for(const h of hours){const s=stat(byHour.get(h)||[]);L.push(`${pad(h+'시',6)} | ${padS(fmt(s.mean),9)} | ${padS(s.wr.toFixed(1)+'%',6)} | ${padS(String(s.n),7)}`);}
  L.push(`\n## (b) 요일별 4h 봉 평균수익률`);
  L.push(`${pad('요일',6)} | ${padS('평균ret',9)} | ${padS('상승%',6)} | ${padS('n',7)}`);
  L.push('-'.repeat(38));
  for(const d of [0,1,2,3,4,5,6]){const s=stat(byDow.get(d)||[]);L.push(`${pad(DOW[d],6)} | ${padS(fmt(s.mean),9)} | ${padS(s.wr.toFixed(1)+'%',6)} | ${padS(String(s.n),7)}`);}

  // (c) F6 진입 세션별 성과
  const tradesByHour=new Map<number,number[]>(); // 진입시각 → profitRate%
  for(const [c,bars] of barsByCoin){
    const vol=bars.map(b=>b.volume);
    for(let i=LOOKBACK+1;i<bars.length-1;i++){
      let mx=-Infinity;for(let j=i-LOOKBACK;j<i-1;j++)if(bars[j].high>mx)mx=bars[j].high;
      if(!(bars[i-1].high>mx))continue;if(!(bars[i].close>bars[i].open))continue;if(!(bars[i].close>bars[i-1].high))continue;
      const z=volZ(vol,i,30);if(z==null||z<0.5)continue;
      // 진입 = i+1 open, exit = F6_v2 TP7/SL2.5/84
      const ei=i+1; const ep=bars[ei].open; const tp=ep*1.07, sl=ep*0.975; let ret=0;
      for(let k=ei;k<Math.min(ei+84,bars.length);k++){ if(bars[k].low<=sl){ret=-2.5;break;} if(bars[k].high>=tp){ret=7;break;} if(k===Math.min(ei+84,bars.length)-1)ret=(bars[k].close-ep)/ep*100; }
      const h=kstHour(bars[ei].ts); if(!tradesByHour.has(h))tradesByHour.set(h,[]);tradesByHour.get(h)!.push(ret);
    }
  }
  L.push(`\n## (c) F6 진입 세션별 성과 (TP7/SL2.5)`);
  L.push(`${pad('진입KST',7)} | ${padS('평균ret',9)} | ${padS('WR',6)} | ${padS('n',5)}`);
  L.push('-'.repeat(36));
  for(const h of [...tradesByHour.keys()].sort((a,b)=>a-b)){const a=tradesByHour.get(h)||[];const s=a.length?{mean:a.reduce((x,y)=>x+y,0)/a.length,wr:a.filter(x=>x>0).length/a.length*100}:{mean:0,wr:0};L.push(`${pad(h+'시',7)} | ${padS(fmt(s.mean),9)} | ${padS(s.wr.toFixed(0)+'%',6)} | ${padS(String(a.length),5)}`);}
  L.push(`\n해석: 시각/요일별 평균이 뚜렷하게 갈리고 n 충분하면 미세알파/필터 후보. 다 비슷하면 효과 없음.`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R51_SESSION.txt`), L.join('\n'));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
