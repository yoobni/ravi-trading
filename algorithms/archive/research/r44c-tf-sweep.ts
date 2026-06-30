/**
 * R44c — F6 신고가돌파를 TF별로 스윕 (1h~1d). 어느 TF가 sweet spot인가.
 * ★ 읽기 전용. 운영 paper 안 건드림. 1h 캐시 리샘플 → 모든 TF 생성(추가 fetch 0).
 *
 * TF: 1h,2h,3h,4h,6h,8h,12h,1d. 모두 "7일 신고가·14d 보유" 시간의미 유지로 lookback/MAX 환산.
 * TP+5/SL-2 고정, position 33%×max3, cost RT 0.1%. 28코인 2년.
 * 4h는 네이티브 240m 캔들과 교차검증(리샘플 신뢰성 확인).
 */
import 'dotenv/config';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const INITIAL_CASH = 10_000_000, POSITION_PCT = 0.33, MAX_CONCURRENT = 3, COST_RT = 0.001;
const FROM = '2024-06-10', TO = '2026-06-10';
const COINS_28 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null;
  let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += v[j]; s2 += v[j]*v[j]; }
  const m = s / w; const sd = Math.sqrt(Math.max((s2/w) - m*m, 1e-12));
  return sd > 0 ? (v[i] - m) / sd : null;
}
interface Signal { coin: string; barIdx: number; ts: number; }
function sigF6(bars: CachedBar[], coin: string, lookback: number): Signal[] {
  const vol = bars.map(b => b.volume); const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let pm = -Infinity; for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > pm) pm = bars[j].high;
    if (!(bars[i-1].high > pm)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(vol, i, 30); if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}
function simulate(tp: number, sl: number, maxBars: number, sigs: Signal[], barsByCoin: Map<string, CachedBar[]>, ps: number, pe: number) {
  let cash = INITIAL_CASH; const positions: any[] = []; const trades: any[] = [];
  const filtered = sigs.filter(s => s.ts >= ps && s.ts <= pe);
  const sigByTs = new Map<number, Signal[]>();
  for (const s of [...filtered].sort((a,b)=>a.ts-b.ts)) { if (!sigByTs.has(s.ts)) sigByTs.set(s.ts, []); sigByTs.get(s.ts)!.push(s); }
  const allTs = new Set<number>(); for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts>=ps&&b.ts<=pe) allTs.add(b.ts);
  const tsList = [...allTs].sort((a,b)=>a-b);
  const idxMap = new Map<string, Map<number, number>>();
  for (const [c, bars] of barsByCoin) { const m = new Map<number,number>(); for (let i=0;i<bars.length;i++) m.set(bars[i].ts, i); idxMap.set(c, m); }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length-1; q>=0; q--) {
      const pos = positions[q]; const idx = idxMap.get(pos.coin)!.get(ts); if (idx == null) continue;
      const b = barsByCoin.get(pos.coin)![idx]; const hb = idx - pos.entryIdx;
      let ep = 0, reason: string|null = null, rr = 0;
      if (b.low <= pos.sl) { ep = pos.sl; reason='SL'; rr=(pos.sl-pos.entryPrice)/pos.entryPrice*100; }
      else if (b.high >= pos.tp) { ep = pos.tp; reason='TP'; rr=(pos.tp-pos.entryPrice)/pos.entryPrice*100; }
      else if (hb >= pos.maxBars) { ep = b.close; reason='TIME'; rr=(b.close-pos.entryPrice)/pos.entryPrice*100; }
      if (reason) { const cg = pos.vol*ep*(1-COST_RT/2); cash += cg; trades.push({ profitKrw: cg-pos.cashUsed, reason }); positions.splice(q,1); }
    }
    for (const sig of (sigByTs.get(ts)||[])) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin); if (!bars) continue;
      const ei = sig.barIdx+1; if (ei>=bars.length) continue;
      const ep = bars[ei].open; const ctu = cash*POSITION_PCT; if (ctu<5000) continue;
      const vol = ctu*(1-COST_RT/2)/ep; cash -= ctu;
      positions.push({ coin: sig.coin, entryIdx: ei, entryPrice: ep, vol, cashUsed: ctu, tp: ep*(1+tp/100), sl: ep*(1+sl/100), maxBars });
    }
    let ov = 0; for (const pos of positions) { const idx = idxMap.get(pos.coin)!.get(ts); if (idx!=null) ov += pos.vol*barsByCoin.get(pos.coin)![idx].close; }
    const eq = cash+ov; if (eq>peak) peak=eq; const dd=(peak-eq)/peak*100; if (dd>mdd) mdd=dd;
  }
  for (const pos of positions) { const bars = barsByCoin.get(pos.coin)!; let li=bars.length-1; for (let i=bars.length-1;i>=0;i--){if(bars[i].ts<=pe){li=i;break;}} const cg=pos.vol*bars[li].close*(1-COST_RT/2); cash+=cg; trades.push({ profitKrw: cg-pos.cashUsed, reason:'END' }); }
  return { trades, finalCash: cash, mdd };
}
function stats(trades: any[], finalCash: number, mdd: number) {
  const n = trades.length; if (!n) return { n:0, wr:0, total:0, pf:0, mdd };
  const wins = trades.filter(t=>t.profitKrw>0), losses = trades.filter(t=>t.profitKrw<=0);
  const tw = wins.reduce((s,t)=>s+t.profitKrw,0), tl = Math.abs(losses.reduce((s,t)=>s+t.profitKrw,0));
  return { n, wr: wins.length/n*100, total: (finalCash-INITIAL_CASH)/INITIAL_CASH*100, pf: tl>0?tw/tl:(tw>0?99:0), mdd };
}
// 1h bars → factor 시간 리샘플 (UTC factor-h 경계 floor 버킷)
function resample(bars1h: CachedBar[], factor: number): CachedBar[] {
  if (factor === 1) return bars1h;
  const bucketMs = factor * 3600_000;
  const groups = new Map<number, CachedBar[]>();
  for (const b of bars1h) { const k = Math.floor(b.ts / bucketMs) * bucketMs; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(b); }
  const out: CachedBar[] = [];
  for (const [k, g] of [...groups.entries()].sort((a,b)=>a[0]-b[0])) {
    g.sort((a,b)=>a.ts-b.ts);
    out.push({ ts: k, date: new Date(k).toISOString().slice(0,16), open: g[0].open, high: Math.max(...g.map(x=>x.high)), low: Math.min(...g.map(x=>x.low)), close: g[g.length-1].close, volume: g.reduce((s,x)=>s+x.volume,0) });
  }
  return out;
}
function fmt(n:number){return `${n>=0?'+':''}${n.toFixed(2)}%`;}
function pad(s:string,w:number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s:string,w:number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async () => {
  // 1h 캐시 로드 (이미 받아둠 → 즉시) + 4h 네이티브(교차검증용)
  const bars1hRaw = new Map<string, CachedBar[]>(); const bars4hNative = new Map<string, CachedBar[]>();
  for (const coin of COINS_28) {
    const b1 = await fetchMinutesCached(`KRW-${coin}`, 60, FROM, TO);
    const b4 = await fetchMinutesCached(`KRW-${coin}`, 240, FROM, TO);
    if (b1.length>=12000 && b4.length>=4000) { bars1hRaw.set(coin,b1); bars4hNative.set(coin,b4); }
  }
  const pool = bars1hRaw.size;
  const periodStart = new Date('2024-06-10T00:00:00+09:00').getTime();
  const periodEnd = new Date('2026-06-10T23:59:59+09:00').getTime();
  const quarters: [number,number][] = [];
  const sd = new Date('2024-06-10');
  for (let q=0;q<8;q++){ const s=new Date(sd); s.setMonth(s.getMonth()+q*3); const e=new Date(s); e.setMonth(e.getMonth()+3); quarters.push([new Date(s.toISOString().slice(0,10)+'T00:00:00+09:00').getTime(), new Date(e.toISOString().slice(0,10)+'T23:59:59+09:00').getTime()]); }

  const TFS: { label: string; hours: number; factor: number }[] = [
    { label:'1h', hours:1, factor:1 }, { label:'2h', hours:2, factor:2 }, { label:'3h', hours:3, factor:3 },
    { label:'4h', hours:4, factor:4 }, { label:'6h', hours:6, factor:6 }, { label:'8h', hours:8, factor:8 },
    { label:'12h', hours:12, factor:12 }, { label:'1d', hours:24, factor:24 },
    { label:'2d', hours:48, factor:48 }, { label:'3d', hours:72, factor:72 },
  ];

  const L: string[] = [];
  L.push('='.repeat(95));
  L.push(`R44c — F6 신고가돌파 TF 스윕 (2년 2024-06~2026-06, ${pool}코인, 1h 리샘플)`);
  L.push(`각 TF: 7일 신고가 + 14d MAX 시간의미 유지, TP+5/SL-2, pos 33%×3, cost 0.1%`);
  L.push('='.repeat(95));
  L.push(`\n${pad('TF',5)} | ${padS('lookbk',7)} | ${padS('MAX',5)} | ${padS('n',5)} | ${padS('WR',4)} | ${padS('2Y total',10)} | ${padS('PF',5)} | ${padS('MDD',6)} | ${padS('분기',5)}`);
  L.push('-'.repeat(80));

  for (const tf of TFS) {
    const lookback = Math.round(7*24/tf.hours);
    const maxBars = Math.round(14*24/tf.hours);
    const byCoin = new Map<string, CachedBar[]>();
    for (const [c, b1] of bars1hRaw) byCoin.set(c, resample(b1, tf.factor));
    const sigs: Signal[] = []; for (const c of byCoin.keys()) for (const s of sigF6(byCoin.get(c)!, c, lookback)) sigs.push(s);
    const full = stats(...(()=>{const r=simulate(5,-2,maxBars,sigs,byCoin,periodStart,periodEnd);return [r.trades,r.finalCash,r.mdd] as const;})());
    let qp=0; for (const [qs,qe] of quarters){ const r=simulate(5,-2,maxBars,sigs,byCoin,qs,qe); const s=stats(r.trades,r.finalCash,r.mdd); if (s.pf>=1.2&&s.total>0) qp++; }
    const star = tf.label==='4h'?' ★':'';
    L.push(`${pad(tf.label,5)} | ${padS(String(lookback),7)} | ${padS(String(maxBars),5)} | ${padS(String(full.n),5)} | ${padS(full.wr.toFixed(0)+'%',4)} | ${padS(fmt(full.total),10)} | ${padS(full.pf.toFixed(2),5)} | ${padS(full.mdd.toFixed(1)+'%',6)} | ${padS(qp+'/8',5)}${star}`);
  }

  // 4h 교차검증: 리샘플 vs 네이티브 240m
  L.push(`\n[4h 교차검증: 리샘플 vs 네이티브 240m] (리샘플 신뢰성)`);
  for (const [label, src] of [['리샘플4h', new Map([...bars1hRaw].map(([c,b])=>[c,resample(b,4)]))], ['네이티브240m', bars4hNative]] as const) {
    const sigs: Signal[] = []; for (const c of (src as Map<string,CachedBar[]>).keys()) for (const s of sigF6((src as Map<string,CachedBar[]>).get(c)!, c, 42)) sigs.push(s);
    const r = simulate(5,-2,84,sigs,src as Map<string,CachedBar[]>,periodStart,periodEnd); const s = stats(r.trades,r.finalCash,r.mdd);
    L.push(`  ${pad(label,12)} n=${padS(String(s.n),5)} PF=${s.pf.toFixed(2)} total=${fmt(s.total)} MDD=${s.mdd.toFixed(1)}%`);
  }

  const out = L.join('\n'); console.log(out);
  const fs = await import('fs'); fs.writeFileSync(path.resolve('data/research','R44c_tf_sweep.txt'), out);
  process.exit(0);
})();
