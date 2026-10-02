/** 축 L-1d 꼬리 의존 검사 — 플라시보에도 같은 절사를 적용해 비교 */
import { B, EVENTS, barAt, H, P, mean, FEE, SLIP } from './_mac_core';
const COST = 2 * (FEE + SLIP), L = 4;
const evI = (['FOMC', 'CPI', 'NFP'] as const).flatMap(n => EVENTS[n].map(barAt)).filter((i): i is number => i !== undefined && i >= L);
const evSet = new Set(evI.map(i => B[i].ts));
const tr = (i: number) => (B[i].ts - B[i - L].ts === L * H ? B[i].close / B[i - L].open - 1 - COST : NaN);
const stats = (xs: number[]) => { const s = xs.slice().sort((a, b) => b - a); const n = s.length;
  return { mean: mean(s), top10: mean(s.slice(10)), top20: mean(s.slice(20)), trim5: mean(s.slice(Math.ceil(n * .05), Math.floor(n * .95))), med: s[Math.floor(n / 2)], win: s.filter(x => x > 0).length / n }; };
const real = stats(evI.map(tr).filter(Number.isFinite));
const hours = evI.map(i => new Date(B[i].ts).getUTCHours()), dows = evI.map(i => new Date(B[i].ts).getUTCDay());
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const sims: ReturnType<typeof stats>[] = [];
for (let k = 0; k < 500; k++) {
  const xs: number[] = [];
  evI.forEach((_, q) => {
    for (let t = 0; t < 50; t++) {
      const d = Math.floor(rnd() * 3000) + 40; const day = Math.floor(B[0].ts / 86400e3) * 86400e3 + d * 86400e3;
      if (new Date(day).getUTCDay() !== dows[q]) continue;
      const j = barAt(day + hours[q] * H); if (j === undefined || j < L || evSet.has(B[j].ts)) continue;
      const v = tr(j); if (Number.isFinite(v)) { xs.push(v); break; }
    }
  });
  sims.push(stats(xs));
}
for (const key of ['mean', 'trim5', 'top10', 'top20', 'med', 'win'] as const) {
  const v = sims.map(s => s[key]).sort((a, b) => a - b);
  const fmt = (x: number) => key === 'win' ? (100 * x).toFixed(1) + '%' : P(100 * x);
  console.log(`${key.padEnd(6)} 실제 ${fmt(real[key]).padStart(8)} | 플라시보 중앙 ${fmt(v[250]).padStart(8)} 95분위 ${fmt(v[475]).padStart(8)} | 실제 이상 비율 ${(100 * v.filter(x => x >= real[key]).length / v.length).toFixed(1)}%`);
}
