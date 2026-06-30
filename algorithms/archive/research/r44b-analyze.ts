/**
 * R44b — R44(F6 1h TF) 결과 심층 분석. 왜 1h가 무너졌나.
 * ★ 읽기 전용. 운영 paper 안 건드림. 캐시(data/candle-cache) 재사용.
 *
 * 분석: 청산사유 분포 / 보유기간 / 코인 기여 / 월별 realized PnL(MDD 시점) / 진입 동시성.
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
interface Trade { coin: string; entryTs: number; exitTs: number; holdBars: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }
function simulate(tp: number, sl: number, maxBars: number, sigs: Signal[], barsByCoin: Map<string, CachedBar[]>) {
  let cash = INITIAL_CASH; const positions: any[] = []; const trades: Trade[] = [];
  const sigByTs = new Map<number, Signal[]>();
  for (const s of [...sigs].sort((a,b)=>a.ts-b.ts)) { if (!sigByTs.has(s.ts)) sigByTs.set(s.ts, []); sigByTs.get(s.ts)!.push(s); }
  const allTs = new Set<number>(); for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a,b)=>a-b);
  const idxMap = new Map<string, Map<number, number>>();
  for (const [c, bars] of barsByCoin) { const m = new Map<number,number>(); for (let i=0;i<bars.length;i++) m.set(bars[i].ts, i); idxMap.set(c, m); }
  for (const ts of tsList) {
    for (let q = positions.length-1; q>=0; q--) {
      const pos = positions[q]; const idx = idxMap.get(pos.coin)!.get(ts); if (idx == null) continue;
      const b = barsByCoin.get(pos.coin)![idx]; const hb = idx - pos.entryIdx;
      let ep = 0, reason: Trade['reason']|null = null, rr = 0;
      if (b.low <= pos.sl) { ep = pos.sl; reason='SL'; rr=(pos.sl-pos.entryPrice)/pos.entryPrice*100; }
      else if (b.high >= pos.tp) { ep = pos.tp; reason='TP'; rr=(pos.tp-pos.entryPrice)/pos.entryPrice*100; }
      else if (hb >= pos.maxBars) { ep = b.close; reason='TIME'; rr=(b.close-pos.entryPrice)/pos.entryPrice*100; }
      if (reason) {
        const cg = pos.vol*ep*(1-COST_RT/2); cash += cg;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, holdBars: hb, netRet: rr-COST_RT*100, profitKrw: cg-pos.cashUsed, reason });
        positions.splice(q,1);
      }
    }
    for (const sig of (sigByTs.get(ts)||[])) {
      if (positions.length >= MAX_CONCURRENT) break;
      const bars = barsByCoin.get(sig.coin); if (!bars) continue;
      const ei = sig.barIdx+1; if (ei>=bars.length) continue;
      const ep = bars[ei].open; const ctu = cash*POSITION_PCT; if (ctu<5000) continue;
      const vol = ctu*(1-COST_RT/2)/ep; cash -= ctu;
      positions.push({ coin: sig.coin, entryTs: bars[ei].ts, entryIdx: ei, entryPrice: ep, vol, cashUsed: ctu, tp: ep*(1+tp/100), sl: ep*(1+sl/100), maxBars });
    }
  }
  for (const pos of positions) {
    const bars = barsByCoin.get(pos.coin)!; const b = bars[bars.length-1]; const cg = pos.vol*b.close*(1-COST_RT/2); cash += cg;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: b.ts, holdBars: bars.length-1-pos.entryIdx, netRet:(b.close-pos.entryPrice)/pos.entryPrice*100-COST_RT*100, profitKrw: cg-pos.cashUsed, reason:'END' });
  }
  return { trades, finalCash: cash };
}

function analyze(label: string, trades: Trade[], tfHours: number, L: string[]) {
  L.push(`\n${'='.repeat(70)}\n## ${label}  (n=${trades.length})\n${'='.repeat(70)}`);
  // 1) 청산사유
  L.push(`\n[청산 사유 분포]`);
  for (const r of ['TP','SL','TIME','END'] as const) {
    const t = trades.filter(x=>x.reason===r); if (!t.length) continue;
    const sumK = t.reduce((s,x)=>s+x.profitKrw,0);
    const avgRet = t.reduce((s,x)=>s+x.netRet,0)/t.length;
    const avgHold = t.reduce((s,x)=>s+x.holdBars,0)/t.length;
    L.push(`  ${r.padEnd(5)} ${String(t.length).padStart(4)}건 (${(t.length/trades.length*100).toFixed(0).padStart(2)}%) | 평균 ${avgRet>=0?'+':''}${avgRet.toFixed(2)}% | 합계 ${(sumK/1e6).toFixed(2)}M | 평균보유 ${avgHold.toFixed(1)}bar(${(avgHold*tfHours).toFixed(0)}h)`);
  }
  // 2) 코인 기여
  const byCoin = new Map<string, number>();
  for (const t of trades) byCoin.set(t.coin, (byCoin.get(t.coin)||0)+t.profitKrw);
  const sorted = [...byCoin.entries()].sort((a,b)=>b[1]-a[1]);
  L.push(`\n[코인 기여 top3 / bottom3 (순익 KRW)]`);
  for (const [c,v] of sorted.slice(0,3)) L.push(`  +${c.padEnd(5)} ${(v/1e6).toFixed(2)}M`);
  for (const [c,v] of sorted.slice(-3)) L.push(`  -${c.padEnd(5)} ${(v/1e6).toFixed(2)}M`);
  const winCoins = sorted.filter(([,v])=>v>0).length;
  L.push(`  → 수익 코인 ${winCoins}/${sorted.length}`);
  // 3) 월별 realized PnL (MDD 시점)
  const byMonth = new Map<string, number>();
  for (const t of trades) { const m = new Date(t.exitTs).toISOString().slice(0,7); byMonth.set(m,(byMonth.get(m)||0)+t.profitKrw); }
  L.push(`\n[월별 realized PnL]`);
  let cum = 0, peak = 0, worstMonth = '', worstVal = 0;
  for (const [m,v] of [...byMonth.entries()].sort()) {
    cum += v; if (cum>peak) peak = cum;
    if (v < worstVal) { worstVal = v; worstMonth = m; }
    const bar = v>=0 ? '+'.repeat(Math.min(20,Math.round(v/5e5))) : '-'.repeat(Math.min(20,Math.round(-v/5e5)));
    L.push(`  ${m} ${(v/1e6).toFixed(2).padStart(7)}M  ${bar}`);
  }
  L.push(`  → 최악의 달: ${worstMonth} (${(worstVal/1e6).toFixed(2)}M)`);
  // 4) 진입 동시성
  const entryDays = new Map<string, number>();
  for (const t of trades) { const d = new Date(t.entryTs).toISOString().slice(0,10); entryDays.set(d,(entryDays.get(d)||0)+1); }
  const multiDays = [...entryDays.values()].filter(v=>v>=2).length;
  L.push(`\n[진입 집중도] 진입일 ${entryDays.size}일 중 ${multiDays}일이 2건+ 동시진입 (${(multiDays/entryDays.size*100).toFixed(0)}%)`);
}

(async () => {
  const bars4h = new Map<string, CachedBar[]>(); const bars1h = new Map<string, CachedBar[]>();
  for (const coin of COINS_28) {
    const b4 = await fetchMinutesCached(`KRW-${coin}`, 240, FROM, TO);
    const b1 = await fetchMinutesCached(`KRW-${coin}`, 60, FROM, TO);
    if (b4.length>=4000 && b1.length>=12000) { bars4h.set(coin,b4); bars1h.set(coin,b1); }
  }
  const L: string[] = [];
  L.push(`R44b — F6 1h 실패 원인 심층 분석 (2년 ${bars4h.size}코인)`);

  const sig4h: Signal[] = []; for (const c of bars4h.keys()) for (const s of sigF6(bars4h.get(c)!, c, 42)) sig4h.push(s);
  const sig1hT: Signal[] = []; for (const c of bars1h.keys()) for (const s of sigF6(bars1h.get(c)!, c, 168)) sig1hT.push(s);
  const sig1hB: Signal[] = []; for (const c of bars1h.keys()) for (const s of sigF6(bars1h.get(c)!, c, 42)) sig1hB.push(s);

  analyze('4h BASE (lookback42, MAX84)', simulate(5,-2,84, sig4h, bars4h).trades, 4, L);
  analyze('1h TIME (lookback168, MAX336)', simulate(5,-2,336, sig1hT, bars1h).trades, 1, L);
  analyze('1h BAR (lookback42, MAX84)', simulate(5,-2,84, sig1hB, bars1h).trades, 1, L);

  const out = L.join('\n');
  console.log(out);
  const fs = await import('fs');
  fs.writeFileSync(path.resolve('data/research', 'R44b_analysis.txt'), out);
  process.exit(0);
})();
