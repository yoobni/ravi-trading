import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import fs from 'fs';
const FOUR=4*3600_000;
type Bar={ts:number;open:number;high:number;low:number;close:number};
async function bars(m:string):Promise<Bar[]>{
  const c=await getUpbitClient().getCandlesMinutes(240,m,200);
  return c.map((x:any)=>({ts:new Date(x.candle_date_time_utc+'Z').getTime(),open:x.opening_price,high:x.high_price,low:x.low_price,close:x.trade_price})).sort((a,b)=>a.ts-b.ts);
}
const DIRS=[['paper-f6','F6','미정렬'],['paper-f6v2','F6_v2','미정렬'],['paper-f6v3','F6_v3','미정렬'],
  ['paper-f6v5','F6_v5','미정렬'],['paper-f6v6','F6_v6','정렬'],['paper-f6v7','F6_v7','정렬'],['paper-f6v8','F6_v8','미정렬']];
(async()=>{
  // 모든 거래 수집 (최근 200봉 = 33일 이내 진입건만 측정 가능)
  const need=new Set<string>(); const all:any[]=[];
  for(const [d,n,al] of DIRS){
    const bft=new Set<number>();
    for(const l of fs.readFileSync(`data/${d}/ticks.jsonl`,'utf8').split('\n').filter(Boolean)){
      const t=JSON.parse(l); if(t.backfilled) bft.add(t.ts);
    }
    for(const l of fs.readFileSync(`data/${d}/trades.jsonl`,'utf8').split('\n').filter(Boolean)){
      const t=JSON.parse(l);
      const ra=t.recordedAt?Date.parse(t.recordedAt):null;
      all.push({...t,strat:n,align:al,bf:ra!=null&&bft.has(ra)}); need.add(t.market);
    }
  }
  const cache=new Map<string,Bar[]>();
  for(const m of need){ try{cache.set(m,await bars(m)); await new Promise(r=>setTimeout(r,140));}catch{} }
  const groups=new Map<string,number[]>();
  let measured=0, skipped=0;
  for(const t of all){
    const bs=cache.get(t.market); if(!bs){skipped++;continue;}
    const bar=bs.find(b=>b.ts<=t.entryTs && t.entryTs<b.ts+FOUR);
    if(!bar||bar.high===bar.low){skipped++;continue;}
    // 진입가가 진입봉 시가 대비 몇 % 위/아래인가 (슬리피지 0.05% 포함된 값)
    const vsOpen=(t.entryPrice/bar.open-1)*100;
    const key=`${t.align}|${t.bf?'백필':'라이브'}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key)!.push(vsOpen); measured++;
  }
  console.log(`측정 ${measured}건 / 범위 밖(200봉 초과) ${skipped}건\n`);
  console.log('그룹'.padEnd(16),'n'.padStart(5),'진입가-시가 평균'.padStart(16),'중앙값'.padStart(9));
  for(const k of ['미정렬|백필','미정렬|라이브','정렬|백필','정렬|라이브']){
    const v=groups.get(k)||[]; if(!v.length){console.log(k.padEnd(16),'—');continue;}
    const avg=v.reduce((a,b)=>a+b,0)/v.length; const s=[...v].sort((a,b)=>a-b);
    const med=s[Math.floor(s.length/2)];
    console.log(k.padEnd(16),String(v.length).padStart(5),(avg>=0?'+':'')+avg.toFixed(3)+'%',' '.repeat(6),(med>=0?'+':'')+med.toFixed(3)+'%');
  }
})();
