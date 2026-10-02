/**
 * (b) 상대 김프 수렴 — 포트폴리오 백테스트 (롱 온리, 업비트 현물만)
 * 신호: 4h 봉 마감에 코인 c 의 상대 김프 편차(= 지금 − 직전 30일 평균) < D 이고 z < Z
 * 진입: 다음 봉 시가 + 슬리피지(코인별 스프레드½ × mult) · 수수료 0.05%
 * 청산: 봉 마감에 편차 ≥ exitDev 면 다음 봉 시가, 또는 maxH 봉 경과 시 — 시장가
 * 포트폴리오: K 슬롯 각 1/K × size
 * 반증 모드: placebo(같은 시각 같은 개수, 무작위 코인), cost×2, IS/OOS, 코인 반반, 구간별
 */
import { COINS, UP, BN, TS, FOUR, relKimp, slip, SPLIT, P, mean } from './_kp_core';
const FEE = 0.0005, INIT = 1e7, W = 180; // 30일 = 180봉
// 상대 김프 시계열 + 롤링 통계 (직전 W봉, 자신 제외)
const DEV = new Map<string, Map<number, { dev: number; z: number }>>();
for (const c of COINS) { if (c === 'BTC') continue;
  const ser = TS.map(t => ({ t, v: relKimp(c, t) }));
  const m = new Map<number, { dev: number; z: number }>();
  for (let i = W; i < ser.length; i++) { if (ser[i].v == null) continue;
    const win = ser.slice(i - W, i).map(x => x.v).filter(v => v != null) as number[]; if (win.length < W * 0.7) continue;
    const mu = mean(win), sd = Math.sqrt(mean(win.map(v => (v - mu) ** 2))); if (!(sd > 0)) continue;
    m.set(ser[i].t, { dev: ser[i].v! - mu, z: (ser[i].v! - mu) / sd }); }
  DEV.set(c, m); }
const ALTS = [...DEV.keys()];
let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
interface Cfg { D: number; Z: number; exitDev: number; maxH: number; K: number; costMult?: number; placebo?: boolean; coins?: string[] }
function run(cfg: Cfg, size: number, from = 0, to = Infinity) {
  const coins = cfg.coins ?? ALTS; const cm = cfg.costMult ?? 1;
  let cash = INIT; const open: { c: string; ep: number; vol: number; used: number; h: number; exitNext: boolean }[] = [];
  let peak = INIT, mdd = 0, n = 0, sumR = 0, wins = 0; const pend: string[] = [];
  for (let i = 0; i < TS.length; i++) { const t = TS[i]; if (t < from || t > to) continue;
    // 1) 봉 시가: 직전 마감에서 정해진 청산·진입 실행
    for (let p = open.length - 1; p >= 0; p--) { const q = open[p]; if (!q.exitNext) continue;
      const b = UP.get(q.c)!.get(t); if (!b) continue;
      const got = q.vol * b.open * (1 - slip(q.c, cm)) * (1 - FEE * cm); cash += got; n++; const r = got / q.used - 1; sumR += r; if (r > 0) wins++; open.splice(p, 1); }
    for (const c of pend.splice(0)) { if (open.length >= cfg.K || open.some(q => q.c === c)) continue;
      const b = UP.get(c)!.get(t); if (!b) continue; const used = Math.min(cash, INIT * 0 + (cash + open.reduce((a, q) => a + q.used, 0)) * size / cfg.K); if (used < 5000) continue;
      const ep = b.open * (1 + slip(c, cm)); cash -= used; open.push({ c, ep, vol: used * (1 - FEE * cm) / ep, used, h: 0, exitNext: false }); }
    // 2) 봉 마감: 청산 판단 · 신호
    for (const q of open) { q.h++; const d = DEV.get(q.c)!.get(t); if ((d && d.dev >= cfg.exitDev) || q.h >= cfg.maxH) q.exitNext = true; }
    const sigs = coins.filter(c => { const d = DEV.get(c)!.get(t); return d && d.dev < cfg.D && d.z < cfg.Z; });
    if (cfg.placebo) { const k = sigs.length; const pool = coins.filter(c => DEV.get(c)!.has(t)); sigs.length = 0; for (let j = 0; j < k && pool.length; j++) sigs.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]); }
    sigs.sort((a, b) => DEV.get(a)!.get(t)!.dev - DEV.get(b)!.get(t)!.dev); pend.push(...sigs);
    const eq = cash + open.reduce((a, q) => { const b = UP.get(q.c)!.get(t); return a + q.vol * (b ? b.close : q.ep); }, 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.ep, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, wr: n ? 100 * wins / n : 0 };
}
const sizeFor = (cfg: Cfg, from = 0, to = Infinity) => { let lo = 0.02, hi = 1; for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (run(cfg, m, from, to).mdd > 17) hi = m; else lo = m; } return (lo + hi) / 2; };
const SP: Array<[string, number, number]> = [['22H2~23', 0, Date.UTC(2024, 0, 1)], ['2024', Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)], ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)], ['2026', Date.UTC(2026, 0, 1), Infinity]];
const MODE = process.argv[2] || 'grid';
const line = (lab: string, cfg: Cfg) => {
  const r = run(cfg, 1); const sz = sizeFor(cfg); const e = run(cfg, sz);
  const per = SP.map(([, a, b]) => (run(cfg, sz, a, b).ret.toFixed(0) + '%').padStart(6)).join('');
  console.log(`${lab.padEnd(34)} 풀투입 ${(r.ret.toFixed(0) + '%').padStart(6)} MDD ${(r.mdd.toFixed(0) + '%').padStart(4)} n ${String(r.n).padStart(4)} 거래당 ${(r.avg >= 0 ? '+' : '') + r.avg.toFixed(2)}% 승률 ${r.wr.toFixed(0)}% | MDD17 ${(e.ret.toFixed(0) + '%').padStart(5)} sz ${(sz * 100).toFixed(0)}% |${per}`);
};
if (MODE === 'grid') {
  for (const D of [-0.005, -0.01, -0.015, -0.02]) for (const Z of [-2, -3]) for (const maxH of [1, 3, 6])
    line(`D${P(D, 1)} Z${Z} exit≥0 maxH${maxH} K3`, { D, Z, exitDev: 0, maxH, K: 3 });
}
if (MODE === 'stress') {
  const base: Cfg = { D: -0.015, Z: -2, exitDev: 0, maxH: 1, K: 3 };
  line('기준 D−1.5% Z−2 maxH1 K3', base);
  line('  IS 만(~2024-07)', base); line('  (IS/OOS 아래 별도)', base);
  line('  비용×2', { ...base, costMult: 2 });
  line('  비용×3', { ...base, costMult: 3 });
  const ev = ALTS.filter((_, i) => i % 2 === 0), od = ALTS.filter((_, i) => i % 2 === 1);
  line('  코인 짝수 절반', { ...base, coins: ev }); line('  코인 홀수 절반', { ...base, coins: od });
  for (const s of [1, 2, 3, 4, 5]) { seed = s * 7919; line(`  플라시보 #${s}`, { ...base, placebo: true }); }
  const big = ['ETH','SOL','XRP','LINK','BCH','NEAR','SUI','AVAX','AAVE','DOT','ETC','AXS','APT','SAND','ATOM','TRX'];
  line('  스프레드 좁은 코인만(<25bps)', { ...base, coins: ALTS.filter(c => big.includes(c)) });
  line('  스프레드 넓은 코인만', { ...base, coins: ALTS.filter(c => !big.includes(c)) });
}

if (MODE === 'stress') {
  const base: Cfg = { D: -0.015, Z: -2, exitDev: 0, maxH: 1, K: 3 };
  for (const [lab, a, b] of [['IS ~2024-07', 0, SPLIT], ['OOS 2024-07~', SPLIT, Infinity]] as const) { const r = run(base, 1, a, b); console.log(`  ${lab} 풀투입 ${r.ret.toFixed(1)}% n ${r.n} 거래당 ${r.avg.toFixed(2)}%`); }
}
if (MODE === 'events') {
  // 극단 이벤트 목록: 날짜·코인·편차·4h 업비트 수익·바이낸스 수익
  const ev: string[] = []; const byCoin: Record<string, number> = {}; const byMonth: Record<string, number> = {};
  for (const t of TS) for (const c of ALTS) { const d = DEV.get(c)!.get(t); if (!d || d.dev >= -0.015 || d.z >= -2) continue;
    const a = UP.get(c)!.get(t + FOUR), ba = BN.get(c)!.get(t + FOUR); if (!a || !ba) continue;
    const up = a.close / a.open - 1, bn = ba.close / ba.open - 1;
    byCoin[c] = (byCoin[c] || 0) + 1; const mo = new Date(t).toISOString().slice(0, 7); byMonth[mo] = (byMonth[mo] || 0) + 1;
    ev.push(`${new Date(t + 9 * 3600e3).toISOString().slice(0, 16)} ${c.padEnd(5)} 편차 ${P(d.dev)} z ${d.z.toFixed(1)} | 다음4h 업 ${P(up)} 바 ${P(bn)} 수렴 ${P(up - bn)}`); }
  console.log(`극단 이벤트 ${ev.length}건 (D<−1.5%, z<−2, 봉 단위, 중복 포함)`);
  console.log('코인별', JSON.stringify(Object.entries(byCoin).sort((a, b) => b[1] - a[1])));
  console.log('월별 상위', JSON.stringify(Object.entries(byMonth).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  for (const e of ev) console.log('  ' + e);
}
if (MODE === 'clean') {
  // 바이낸스 종가 이상치 제거: 신호 봉에서 바이낸스가 직전 봉 대비 튀었고(|ret| > 업비트 |ret| + 2%) 다음 봉에 되돌린 경우를 '바이낸스측 이벤트'로 분류
  const rows: { t: number; c: string; up: number; bn: number; binSide: boolean }[] = [];
  for (const t of TS) for (const c of ALTS) { const d = DEV.get(c)!.get(t); if (!d || d.dev >= -0.01 || d.z >= -2) continue;
    const u0 = UP.get(c)!.get(t), b0 = BN.get(c)!.get(t), u1 = UP.get(c)!.get(t + FOUR), b1 = BN.get(c)!.get(t + FOUR); if (!u0 || !b0 || !u1 || !b1) continue;
    const bnMove = b0.close / b0.open - 1, upMove = u0.close / u0.open - 1;
    rows.push({ t, c, up: u1.close / u1.open - 1, bn: b1.close / b1.open - 1, binSide: bnMove - upMove > 0.01 }); }
  const all4h: number[] = []; for (const t of TS) for (const c of ALTS) { const u = UP.get(c)!.get(t + FOUR); if (u) all4h.push(u.close / u.open - 1); }
  const f = (xs: typeof rows) => `n ${String(xs.length).padStart(4)}  업비트 다음4h ${P(mean(xs.map(r => r.up)))}  바이낸스 ${P(mean(xs.map(r => r.bn)))}  IS ${P(mean(xs.filter(r => r.t < SPLIT).map(r => r.up)))} / OOS ${P(mean(xs.filter(r => r.t >= SPLIT).map(r => r.up)))}`;
  console.log(`무조건 알트 4h 평균 ${P(mean(all4h))} (편도 비용 왕복 ≈ 0.1% + 스프레드)`);
  console.log(`할인 신호(D<−1%, z<−2) 전체     ${f(rows)}`);
  console.log(`  바이낸스측(바이낸스가 튐)    ${f(rows.filter(r => r.binSide))}`);
  console.log(`  업비트측(업비트가 빠짐)      ${f(rows.filter(r => !r.binSide))}`);
  const mEnd = (t: number) => new Date(t + 8 * 3600e3).getUTCDate() === 1;
  console.log(`  월말 16Z 봉 제외             ${f(rows.filter(r => !mEnd(r.t) || new Date(r.t).getUTCHours() !== 16))}`);
}
