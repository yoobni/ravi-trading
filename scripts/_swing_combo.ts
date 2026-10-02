/** 축 N: 알트스윙(breakout7+BTC on, N20) × BTC_TREND 일별 수익 상관·합성 */
import { run, TS, START, SPLIT, Y, btcTrend, type Cfg } from './_swing_daily';
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const BASE: Cfg = { sig: 'breakout7', N: 20, K: 3, tp: 6, sl: null, H: 3, btcOn: true };
const cA: number[] = [], cB: number[] = [];
run(BASE, 1 / 3, START, Infinity, cA); btcTrend(1, START, Infinity, cB);   // 각자 '전액' 기준 일별 자산
const idx = TS.map((_, i) => i).filter(i => cA[i] && cB[i]);
const rA: number[] = [], rB: number[] = [], days: number[] = [];
for (let k = 1; k < idx.length; k++) { rA.push(cA[idx[k]] / cA[idx[k - 1]] - 1); rB.push(cB[idx[k]] / cB[idx[k - 1]] - 1); days.push(TS[idx[k]]); }
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };
console.log(`일별 상관 ${corr(rA, rB).toFixed(2)} (n=${rA.length})`);
// 고정 비중 w(스윙) + (1−w)(BTC_TREND), 레버리지 k 로 MDD 17 맞춤 (일별 리밸런스 근사)
const sim = (w: number, k: number, from = 0, to = Infinity) => { let e = 1, pk = 1, md = 0; for (let i = 0; i < rA.length; i++) { if (days[i] < from || days[i] > to) continue; e *= 1 + k * (w * rA[i] + (1 - w) * rB[i]); pk = Math.max(pk, e); md = Math.max(md, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * md }; };
const kFor = (w: number, from = 0, to = Infinity) => { let lo = 0.01, hi = 3; for (let t = 0; t < 30; t++) { const m = (lo + hi) / 2; if (sim(w, m, from, to).mdd > 17) hi = m; else lo = m; } return (lo + hi) / 2; };
for (const w of [0, 0.25, 0.5, 0.75, 1]) {
  const k = kFor(w); const all = sim(w, k);
  const kIs = kFor(w, START, SPLIT); const oos = sim(w, kIs, SPLIT);
  console.log(`스윙 ${String(w * 100).padStart(3)}% / BTC_TREND ${String((1 - w) * 100).padStart(3)}% : eq17 ${fmt(all.ret).padStart(7)} (k ${k.toFixed(2)}) | IS 에서 k 정하고 OOS ${fmt(oos.ret).padStart(6)} mdd ${oos.mdd.toFixed(0)}% | 2025~ ${fmt(sim(w, k, Y(2025)).ret)}`);
}
