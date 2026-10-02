/** 김프 탐색: 분포 · (a) 시장 김프 → 미래 수익 · (b) 상대 김프 평균회귀 · (c) 김프 급변 */
import { COINS, UP, BN, TS, FOUR, DAY, marketKimp, usdtKimp, relKimp, SPLIT, P, mean, spearman } from './_kp_core';
const H = [6, 18, 42]; // 1일·3일·7일 (4h 봉)
const upRet = (c: string, ts: number, h: number) => { const a = UP.get(c)!.get(ts + FOUR), b = UP.get(c)!.get(ts + h * FOUR); return a && b ? b.close / a.open - 1 : null; }; // 다음 봉 시가 진입
const bnRet = (c: string, ts: number, h: number) => { const a = BN.get(c)!.get(ts + FOUR), b = BN.get(c)!.get(ts + h * FOUR); return a && b ? b.close / a.open - 1 : null; };
// 분포
const K = TS.map(t => ({ t, k: marketKimp(t) })).filter(x => x.k != null) as { t: number; k: number }[];
const byY: Record<string, number[]> = {}; for (const x of K) (byY[new Date(x.t).toISOString().slice(0, 4)] ??= []).push(x.k);
console.log('시장 김프(BTC 기준) 연도별 평균 [p10, p90]');
for (const [y, a] of Object.entries(byY)) { const s = a.slice().sort((p, q) => p - q); console.log(`  ${y} ${P(mean(a))} [${P(s[Math.floor(s.length * .1)])}, ${P(s[Math.floor(s.length * .9)])}]  n=${a.length}`); }
const both = TS.map(t => [marketKimp(t), usdtKimp(t)]).filter(([a, b]) => a != null && b != null) as number[][];
console.log(`  BTC기준 vs USDT기준 (2024-06~, n=${both.length}): 평균 ${P(mean(both.map(x => x[0])))} vs ${P(mean(both.map(x => x[1])))}, 상관 ${spearman(both.map(x => x[0]), both.map(x => x[1])).toFixed(2)}`);

// (a) 시장 김프 수준·변화 → BTC·알트 등가 바스켓 미래 수익
const basket = (ts: number, h: number) => { const r = COINS.map(c => upRet(c, ts, h)).filter(x => x != null) as number[]; return r.length > 10 ? mean(r) : null; };
const feat = {
  '김프 수준': (t: number) => marketKimp(t),
  '김프 7일 변화': (t: number) => { const a = marketKimp(t), b = marketKimp(t - 7 * DAY); return a != null && b != null ? a - b : null; },
  '김프 vs 90일 평균': (t: number) => { const a = marketKimp(t); if (a == null) return null; const xs: number[] = []; for (let s = t - 90 * DAY; s < t; s += DAY) { const v = marketKimp(Math.floor(s / FOUR) * FOUR); if (v != null) xs.push(v); } return xs.length > 60 ? a - mean(xs) : null; },
};
console.log('\n(a) 시장 김프 → 미래 수익 (5분위 평균, 1=낮은 김프). 하루 1샘플(UTC 00시)로 중첩 완화');
const daily = TS.filter(t => t % DAY === 0);
for (const [lab, f] of Object.entries(feat)) for (const [tgtLab, tgt] of [['BTC', (t: number, h: number) => upRet('BTC', t, h)], ['알트바스켓', basket]] as const) {
  for (const h of [6, 42]) {
    const row = (from: number, to: number) => {
      const xs = daily.filter(t => t >= from && t < to).map(t => ({ x: f(t), y: tgt(t, h) })).filter(p => p.x != null && p.y != null) as { x: number; y: number }[];
      const so = xs.slice().sort((a, b) => a.x - b.x); const q = 5;
      const qs = Array.from({ length: q }, (_, j) => mean(so.slice(Math.floor(j * so.length / q), Math.floor((j + 1) * so.length / q)).map(p => p.y)));
      return { qs, rho: spearman(xs.map(p => p.x), xs.map(p => p.y)), n: xs.length };
    };
    const a = row(0, SPLIT), b = row(SPLIT, Infinity);
    console.log(`  ${lab.padEnd(12)} → ${tgtLab.padEnd(6)} ${h === 6 ? '1일' : '7일'}  IS ρ=${a.rho.toFixed(2)} [${a.qs.map(x => P(x, 1)).join(' ')}]  OOS ρ=${b.rho.toFixed(2)} [${b.qs.map(x => P(x, 1)).join(' ')}]`);
  }
}

// (b) 상대 김프 평균회귀: z(30일) 가 낮은 코인 → 미래 업비트 수익 vs 바이낸스 수익(수렴분 분해)
console.log('\n(b) 코인 상대 김프 z(자기 30일) → 미래 수익. 4h 매 봉 횡단면, 5분위 (1=가장 할인)');
const zOf = (c: string, t: number) => {
  const now = relKimp(c, t); if (now == null) return null;
  const xs: number[] = []; for (let s = t - 30 * DAY; s < t; s += FOUR) { const v = relKimp(c, s); if (v != null) xs.push(v); }
  if (xs.length < 120) return null; const m = mean(xs), sd = Math.sqrt(mean(xs.map(v => (v - m) ** 2)));
  return sd > 0 ? { z: (now - m) / sd, dev: now - m, raw: now } : null;
};
const rows: { t: number; c: string; z: number; dev: number; raw: number; up: number[]; bn: number[] }[] = [];
for (const t of TS) { if (t % (2 * FOUR) !== 0) continue; // 8h 마다 샘플 (계산량)
  for (const c of COINS) { if (c === 'BTC') continue; const z = zOf(c, t); if (!z) continue;
    const up = [1, 6, 18].map(h => upRet(c, t, h)), bn = [1, 6, 18].map(h => bnRet(c, t, h));
    if (up.some(x => x == null) || bn.some(x => x == null)) continue; rows.push({ t, c, ...z, up: up as number[], bn: bn as number[] }); } }
const quint = (xs: typeof rows, key: (r: typeof rows[0]) => number, val: (r: typeof rows[0]) => number) => {
  const so = xs.slice().sort((a, b) => key(a) - key(b)); return Array.from({ length: 5 }, (_, j) => mean(so.slice(Math.floor(j * so.length / 5), Math.floor((j + 1) * so.length / 5)).map(val)));
};
for (const [hi, hl] of [[0, '4h'], [1, '1일'], [2, '3일']] as const) for (const [part, xs] of [['IS', rows.filter(r => r.t < SPLIT)], ['OOS', rows.filter(r => r.t >= SPLIT)]] as const) {
  console.log(`  ${hl} ${part.padEnd(3)} n=${xs.length}  업비트수익 [${quint(xs, r => r.z, r => r.up[hi]).map(x => P(x)).join(' ')}]  수렴분(업−바) [${quint(xs, r => r.z, r => r.up[hi] - r.bn[hi]).map(x => P(x)).join(' ')}]`);
}
// 극단: z < −2 이고 편차 < −0.5%
for (const thr of [-2, -3]) for (const dv of [-0.005, -0.01, -0.02]) {
  const ex = rows.filter(r => r.z < thr && r.dev < dv);
  const f = (xs: typeof rows, i: number) => `${P(mean(xs.map(r => r.up[i])))} (수렴 ${P(mean(xs.map(r => r.up[i] - r.bn[i])))})`;
  console.log(`  극단 z<${thr} & 편차<${P(dv, 1)}: n=${ex.length} IS ${ex.filter(r => r.t < SPLIT).length}/OOS ${ex.filter(r => r.t >= SPLIT).length}  4h ${f(ex, 0)}  1일 ${f(ex, 1)}  3일 ${f(ex, 2)}`);
}

// (c) 시장 김프 급변(4h·1일 변화) → BTC·바스켓 단기 수익
console.log('\n(c) 시장 김프 급변 → 이후 수익 (BTC 1봉·1일)');
const dK = TS.map(t => { const a = marketKimp(t), b = marketKimp(t - FOUR), d = marketKimp(t - DAY); return { t, d4: a != null && b != null ? a - b : null, d24: a != null && d != null ? a - d : null }; });
for (const key of ['d4', 'd24'] as const) {
  const xs = dK.filter(x => x[key] != null).map(x => ({ t: x.t, x: x[key] as number, y1: upRet('BTC', x.t, 1), y6: upRet('BTC', x.t, 6), b6: basket(x.t, 6) })).filter(p => p.y1 != null && p.y6 != null && p.b6 != null) as any[];
  const so = xs.slice().sort((a, b) => a.x - b.x); const n = so.length;
  for (const [lab, sel] of [['하위1%(김프 급락)', so.slice(0, Math.floor(n * .01))], ['하위10%', so.slice(0, Math.floor(n * .1))], ['중간', so.slice(Math.floor(n * .45), Math.floor(n * .55))], ['상위10%', so.slice(Math.floor(n * .9))], ['상위1%(김프 급등)', so.slice(Math.floor(n * .99))]] as const) {
    const s = sel as any[]; const isS = s.filter(p => p.t < SPLIT), oos = s.filter(p => p.t >= SPLIT);
    console.log(`  ${key === 'd4' ? '4h변화' : '1일변화'} ${lab.padEnd(14)} n=${String(s.length).padStart(5)}  BTC 4h ${P(mean(s.map(p => p.y1)))} 1일 ${P(mean(s.map(p => p.y6)))} 바스켓1일 ${P(mean(s.map(p => p.b6)))} | IS 1일 ${P(mean(isS.map(p => p.y6)))} OOS 1일 ${P(mean(oos.map(p => p.y6)))}`);
  }
}
