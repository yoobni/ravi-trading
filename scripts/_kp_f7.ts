/** 과제 4: 김프가 F7(F6 신호 · TP+6 지정가 · 3일) 결과를 가르나 — 필터/사이징 보조 가치 */
import { COINS, UP, TS, FOUR, DAY, marketKimp, relKimp, slip, SPLIT, P, mean, spearman, type Bar } from './_kp_core';
const FEE = 0.0005;
const arr = new Map(COINS.map(c => [c, [...UP.get(c)!.values()].sort((a, b) => a.ts - b.ts)]));
const volZ = (b: Bar[], i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig = (b: Bar[], i: number) => i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
const relDev = (c: string, t: number) => { const v = relKimp(c, t); if (v == null) return null; const xs: number[] = []; for (let s = t - 30 * DAY; s < t; s += FOUR) { const x = relKimp(c, s); if (x != null) xs.push(x); } return xs.length > 100 ? v - mean(xs) : null; };
const R: { t: number; r: number; k: number; dk: number; rd: number | null }[] = [];
for (const c of COINS) { const b = arr.get(c)!;
  for (let i = 45; i < b.length - 19; i++) { if (!sig(b, i)) continue; const t = b[i].ts;
    const k = marketKimp(t), k7 = marketKimp(t - 7 * DAY); if (k == null || k7 == null) continue;
    const ep = b[i + 1].open * (1 + slip(c)); let r = 0;
    for (let j = 2; j <= 19; j++) { if (b[i + j].high >= ep * 1.06) { r = 1.06 * (1 - FEE) ** 2 - 1; break; } if (j === 19) r = b[i + j].close * (1 - slip(c)) / ep * (1 - FEE) ** 2 - 1; }
    R.push({ t, r, k, dk: k - k7, rd: c === 'BTC' ? null : relDev(c, t) }); } }
console.log(`F6 신호 ${R.length}건 (F7 청산·현실 슬리피지 근사), IS ${R.filter(x => x.t < SPLIT).length} / OOS ${R.filter(x => x.t >= SPLIT).length}`);
for (const [lab, key] of [['시장 김프 수준', (x: any) => x.k], ['시장 김프 7일 변화', (x: any) => x.dk], ['코인 상대김프 편차', (x: any) => x.rd]] as const) {
  for (const [part, xs0] of [['IS', R.filter(x => x.t < SPLIT)], ['OOS', R.filter(x => x.t >= SPLIT)]] as const) {
    const xs = xs0.filter(x => key(x) != null); const so = xs.slice().sort((a, b) => key(a) - key(b));
    const q = Array.from({ length: 5 }, (_, j) => mean(so.slice(Math.floor(j * so.length / 5), Math.floor((j + 1) * so.length / 5)).map(x => x.r)));
    console.log(`  ${lab.padEnd(14)} ${part.padEnd(3)} n=${String(xs.length).padStart(4)} ρ=${spearman(xs.map(key), xs.map(x => x.r)).toFixed(3)}  5분위 [${q.map(v => P(v)).join(' ')}]`);
  }
}
// 김프 7일 변화 상위 20%(과열) 제외 필터 — 임계값은 '직전 365일' 분포의 80분위(미래참조 없음)
const hist = TS.filter(t => t % DAY === 0).map(t => { const a = marketKimp(t), b = marketKimp(t - 7 * DAY); return a != null && b != null ? { t, d: a - b } : null; }).filter(Boolean) as { t: number; d: number }[];
const thrAt = (t: number) => { const xs = hist.filter(h => h.t < t && h.t >= t - 365 * DAY).map(h => h.d).sort((a, b) => a - b); return xs.length > 120 ? xs[Math.floor(xs.length * 0.8)] : null; };
console.log('\n과열 필터(7일 김프 상승이 직전 1년 80분위 초과 → 진입 안 함) 연도별: 걸린 신호 / 통과 신호 평균');
for (const y of ['2023', '2024', '2025', '2026']) {
  const xs = R.filter(x => new Date(x.t).toISOString().startsWith(y)).map(x => ({ ...x, thr: thrAt(x.t) })).filter(x => x.thr != null);
  const hot = xs.filter(x => x.dk > x.thr!), ok = xs.filter(x => x.dk <= x.thr!);
  console.log(`  ${y}  과열 n=${String(hot.length).padStart(3)} ${P(mean(hot.map(x => x.r)))}  |  통과 n=${String(ok.length).padStart(3)} ${P(mean(ok.map(x => x.r)))}`);
}
// 포트폴리오: F7 33%×3 (다음 봉 시가 진입·현실 슬리피지, TP+6 지정가, 18봉 시간청산) ± 과열 필터 / 플라시보(같은 비율 무작위 제외)
const thrCache = new Map<number, number | null>();
const hot = (t: number) => { const day = Math.floor(t / DAY) * DAY; if (!thrCache.has(day)) thrCache.set(day, thrAt(day)); const thr = thrCache.get(day); const a = marketKimp(t), b = marketKimp(t - 7 * DAY); return thr != null && a != null && b != null && a - b > thr; };
let sd = 1; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
const ALLTS = [...new Set(COINS.flatMap(c => arr.get(c)!.map(b => b.ts)))].sort((a, b) => a - b);
const IDX = new Map(COINS.map(c => [c, new Map(arr.get(c)!.map((b, i) => [b.ts, i]))]));
function pf(mode: 'none' | 'hot' | 'placebo', size: number, from = 0, to = Infinity, pRate = 0.15) {
  let cash = 1e7, peak = 1e7, mdd = 0; const open: { c: string; ep: number; vol: number; used: number; bars: number; last: number }[] = [];
  for (const ts of ALLTS) { if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) { const q = open[p]; const i = IDX.get(q.c)!.get(ts); if (i === undefined) continue; const b = arr.get(q.c)![i]; q.last = b.close; q.bars++;
      let px = 0; if (b.high >= q.ep * 1.06) px = q.ep * 1.06; else if (q.bars >= 18) px = b.close * (1 - slip(q.c));
      if (px) { cash += q.vol * px * (1 - FEE); open.splice(p, 1); } }
    const blocked = mode === 'hot' ? hot(ts - FOUR) : false;
    for (const c of COINS) { if (open.length >= 3) break; const b = arr.get(c)!; const i = IDX.get(c)!.get(ts); if (i === undefined || i < 45 || !sig(b, i - 1)) continue;
      if (open.some(q => q.c === c)) continue; if (blocked) continue; if (mode === 'placebo' && rnd() < pRate) continue;
      const used = cash * size; if (used < 5000) continue; const ep = b[i].open * (1 + slip(c)); cash -= used; open.push({ c, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: b[i].close }); }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd };
}
const szFor = (mode: 'none' | 'hot' | 'placebo') => { let lo = 0.02, hi = 0.95; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; sd = 7; if (pf(mode, m).mdd > 17) hi = m; else lo = m; } return (lo + hi) / 2; };
const YRS: Array<[string, number, number]> = [['22H2~23', 0, Date.UTC(2024, 0, 1)], ['2024', Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)], ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)], ['2026', Date.UTC(2026, 0, 1), Infinity]];
console.log('\n포트폴리오 (현실 슬리피지) — 33%×3 / MDD17 / 구간별(MDD17 사이즈)');
for (const mode of ['none', 'hot'] as const) { const a = pf(mode, 0.33); const s = szFor(mode); const e = pf(mode, s);
  console.log(`  ${mode === 'none' ? 'F7' : 'F7 + 김프과열 제외'}`.padEnd(22) + ` 33%×3 ${a.ret.toFixed(0)}% MDD ${a.mdd.toFixed(0)}% | MDD17 ${e.ret.toFixed(0)}% (sz ${(s * 100).toFixed(0)}%) | ` + YRS.map(([l, f, t]) => `${l} ${pf(mode, s, f, t).ret.toFixed(0)}%`).join(' ')); }
const plac: number[] = []; for (let k = 1; k <= 20; k++) { sd = k * 7919; plac.push(pf('placebo', 0.33).ret); }
plac.sort((a, b) => a - b); console.log(`  플라시보(신호 15% 무작위 제외, 20회) 33%×3: 중앙 ${plac[10].toFixed(0)}%  [${plac[0].toFixed(0)}, ${plac[19].toFixed(0)}]`);
const hotShare = R.filter(x => { const thr = thrAt(Math.floor(x.t / DAY) * DAY); return thr != null && x.dk > thr; }).length / R.length;
console.log(`  (실제 과열 제외 비율 ${(100 * hotShare).toFixed(0)}%)`);
const pl9: number[] = []; for (let k = 1; k <= 40; k++) { sd = k * 104729; pl9.push(pf('placebo', 0.33, 0, Infinity, 0.09).ret); }
pl9.sort((a, b) => a - b); console.log(`  플라시보(9% 무작위 제외, 40회): 중앙 ${pl9[20].toFixed(0)}%  90분위 ${pl9[36].toFixed(0)}%  최대 ${pl9[39].toFixed(0)}%  → 실제 306% 초과 ${pl9.filter(x => x >= 306).length}/40`);
// IS/OOS 별 필터 효과
for (const [l, f, t] of [['IS ~2024-07', 0, SPLIT], ['OOS 2024-07~', SPLIT, Infinity]] as const) console.log(`  ${l}: F7 ${pf('none', 0.33, f, t).ret.toFixed(0)}% → 필터 ${pf('hot', 0.33, f, t).ret.toFixed(0)}%`);
