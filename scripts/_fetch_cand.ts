import 'dotenv/config';
import { fetchMinutesCached } from '../algorithms/archive/_candle-cache';
const CAND=['KRW-ONDO','KRW-HBAR','KRW-SHIB','KRW-BONK','KRW-JTO','KRW-ENS','KRW-VIRTUAL','KRW-ZIL','KRW-XEC','KRW-KAITO'];
(async()=>{
  for(const c of CAND){
    let total=0;
    for(const p of [{from:'2024-06-10',to:'2025-06-10'},{from:'2025-06-10',to:'2026-06-10'}]){
      process.stdout.write(`[${c}] 4h ${p.from}~${p.to}... `);
      try{const b=await fetchMinutesCached(c,240,p.from,p.to);total+=b.length;console.log(`${b.length} bars`);}
      catch(e:any){console.log(`FAIL ${e?.message||e}`);}
    }
    console.log(`  → ${c} 총 ${total} bars\n`);
  }
  process.exit(0);
})();
