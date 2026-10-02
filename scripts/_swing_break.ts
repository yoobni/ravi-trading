/** 축 N 반증 — 일봉 breakout7 + BTC_TREND on, 시점별 유니버스 (scripts/_swing_daily.ts 엔진 재사용) */
import { run, sizeFor, SIGS, TS, G, RANK, BTCON, START, SPLIT, YEARS, Y, setFee, setPen, setDelay, btcTrend, type Cfg } from './_swing_daily';
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const mode = process.argv[2] || 'all';
const BASE: Cfg = { sig: 'breakout7', N: 20, K: 3, tp: 6, sl: null, H: 3, btcOn: true };
const eq = (c: Cfg, from = START, to = Infinity) => { const s = sizeFor(c, from, to); return { s, r: run(c, s, from, to) }; };
const yearly = (c: Cfg, s: number) => YEARS.map(y => fmt(run(c, s, Y(y), Y(y + 1)).ret).padStart(6)).join('');
function line(lab: string, c: Cfg) {
  const { s, r } = eq(c);
  console.log(`${lab.padEnd(30)} eq17 ${fmt(r.ret).padStart(7)} IS ${fmt(run(c, s, START, SPLIT).ret).padStart(6)} OOS ${fmt(run(c, s, SPLIT).ret).padStart(6)} n${String(r.n).padStart(5)} avg ${r.avg.toFixed(2).padStart(5)}% sz${(s * 100).toFixed(0).padStart(3)}% |${yearly(c, s)}`);
}
console.log('연도열: ' + YEARS.join('   '));
if (mode === 'all' || mode === 'base') {
  for (const N of [10, 20, 30]) line(`base N${N}`, { ...BASE, N });
  line('base N20, BTC 필터 없음', { ...BASE, btcOn: false });
}
if (mode === 'all' || mode === 'plateau') {
  console.log('\n── 고원: TP × H (N20, 무스톱) ──');
  for (const tp of [3, 4, 5, 6, 8, 10, 15]) for (const H of [1, 2, 3, 5, 7]) { const { r } = eq({ ...BASE, tp, H }); process.stdout.write(`tp${tp}/H${H} ${fmt(r.ret).padStart(6)}  `); if (H === 7) console.log(); }
  console.log('\n── 손절(봉마감) ──');
  for (const sl of [-3, -5, -8, -12]) line(`sl ${sl}`, { ...BASE, sl });
  console.log('\n── 슬롯 K ──');
  for (const K of [1, 2, 3, 5, 8]) line(`K${K}`, { ...BASE, K });
}
if (mode === 'all' || mode === 'stress') {
  console.log('\n── 비용·체결 ──');
  setFee(2); line('비용 ×2', BASE); setFee(3); line('비용 ×3', BASE); setFee(1);
  setPen(0.005); line('TP 관통 0.5%', BASE); setPen(0.01); line('TP 관통 1%', BASE); setPen(0.002);
  setDelay(0.01); line('진입 +1% 불리(지연 근사)', BASE); setDelay(0.02); line('진입 +2% 불리', BASE); setDelay(0);
}
if (mode === 'all' || mode === 'placebo') {
  console.log('\n── 플라시보: 같은 날·같은 유니버스에서 신호 개수만큼 무작위 코인 (40시드) ──');
  // 신호 빈도 맞추기: 실제 신호의 일평균 후보 수 / 유니버스 크기
  let sig = 0, uni = 0;
  for (let j = 60; j < TS.length; j++) { if (TS[j] < START || !BTCON[j]) continue; for (const [m, r] of RANK[j]) { if (r >= 20) break; if (m === 'KRW-BTC') continue; uni++; const a = G.get(m)!; if (SIGS.breakout7(m, j) != null) sig++; } }
  const p = sig / uni; console.log(`신호 빈도 ${(p * 100).toFixed(2)}% (후보 ${sig}/${uni})`);
  const real = eq(BASE).r.ret; const res: number[] = [];
  for (let sd = 1; sd <= 40; sd++) { const c = { ...BASE, rand: p, seed: sd * 7919 }; res.push(eq(c).r.ret); }
  res.sort((a, b) => a - b);
  console.log(`실제 ${fmt(real)} | 무작위 중앙 ${fmt(res[20])} 90분위 ${fmt(res[36])} 최대 ${fmt(res[39])} · 실제 초과 ${res.filter(x => x >= real).length}/40`);
}
if (mode === 'all' || mode === 'wf') {
  console.log('\n── 워크포워드: IS(2019~22)에서 lookback·TP·H·N 고르고 OOS 적용 ──');
  // lookback 변형 신호 등록
  for (const L of [5, 7, 10, 14, 20]) (SIGS as any)[`bo${L}`] = (m: string, i: number) => {
    const a = G.get(m)!; const x = a[i]; if (!x || x.close <= x.open) return null; let hi = -Infinity;
    for (let j = i - L; j < i; j++) { if (!a[j]) return null; hi = Math.max(hi, a[j]!.high); }
    const z = (SIGS as any).valSurgeZ?.(m, i); return x.close > hi ? 1 : null;
  };
  const grid: { c: Cfg; is: number; oos: number }[] = [];
  for (const L of [5, 7, 10, 14, 20]) for (const tp of [4, 6, 8]) for (const H of [2, 3, 5]) for (const N of [10, 20, 30]) {
    const c: Cfg = { ...BASE, sig: `bo${L}`, tp, H, N };
    grid.push({ c, is: eq(c, START, SPLIT).r.ret, oos: eq(c, SPLIT).r.ret });
  }
  grid.sort((a, b) => b.is - a.is);
  const best = grid[0];
  const oosSorted = grid.map(g => g.oos).sort((a, b) => a - b);
  console.log(`IS 1위 bo${best.c.sig.slice(2)} tp${best.c.tp} H${best.c.H} N${best.c.N}: IS ${fmt(best.is)} → OOS ${fmt(best.oos)}`);
  console.log(`OOS 격자 ${grid.length}칸: 중앙 ${fmt(oosSorted[Math.floor(grid.length / 2)])}, 하위10% ${fmt(oosSorted[Math.floor(grid.length * 0.1)])}, 음수 ${grid.filter(g => g.oos < 0).length}칸`);
  const bt = (() => { let s = 0.02, h = 0.99; for (let k = 0; k < 16; k++) { const mid = (s + h) / 2; if (btcTrend(mid, SPLIT).mdd > 17) h = mid; else s = mid; } return btcTrend((s + h) / 2, SPLIT).ret; })();
  console.log(`같은 OOS BTC_TREND eq17 ${fmt(bt)} · OOS 격자 중 BTC_TREND 초과 ${grid.filter(g => g.oos > bt).length}/${grid.length}`);
  const r = (a: number[]) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]).map(([, i]) => i); const rk = new Array(a.length); idx.forEach((i, k) => rk[i] = k); return rk; };
  const ri = r(grid.map(g => g.is)), ro = r(grid.map(g => g.oos)); const n = grid.length;
  const rho = 1 - 6 * ri.reduce((s: number, v: number, i: number) => s + (v - ro[i]) ** 2, 0) / (n * (n * n - 1));
  console.log(`IS↔OOS 순위상관 ${rho.toFixed(2)}`);
}
