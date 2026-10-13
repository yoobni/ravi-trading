/**
 * 축 ALT-2b: 코인별 상대 역프 회귀 — 4h (28코인만: 바이낸스 4h 캐시가 28코인뿐 → 생존편향 경고, 일봉판의 보조 확인용)
 *   rp_c = ln(업비트 4h 종가 / 바이낸스 4h 종가) − 그 봉 28코인 중앙값   (경계 동일: 00/04/.../20 UTC)
 *   z = (rp − 직전 180봉 평균)/sd. 신호: z ≤ −Z & dev ≤ −gap, 시점별 상위 N(전날 일봉 순위).
 *   진입 다음 4h 시가+스프레드½, 청산 z ≥ 0(봉마감 판단 → 다음 시가) / TP 지정가(관통 0.2%) / 최대 hold 시간. 무스톱.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const H4 = 4 * 3600e3;
const COINS = ['ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT','BTC'];
interface B { ts: number; open: number; high: number; low: number; close: number }
const U = new Map<string, Map<number, B>>(), BN = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const f = fs.readdirSync('data/candle-cache').find(x => x.startsWith(`KRW-${c}_240m_2022-06-10_2026-10-13`)); if (!f) continue;
  U.set(c, new Map((JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')) as B[]).map(b => [b.ts, b])));
  const g = `data/research-ext/binance-${c}_240m.json`; if (!fs.existsSync(g)) continue;
  BN.set(c, new Map((JSON.parse(fs.readFileSync(g, 'utf8')) as B[]).map(b => [b.ts, b.close])));
}
const TS = [...new Set([...U.values()].flatMap(m => [...m.keys()]))].filter(t => [...BN.values()].some(m => m.has(t))).sort((a, b) => a - b);
const TI = new Map(TS.map((t, i) => [t, i]));
const RP = new Map<string, Float64Array>();
{ const P = new Map<string, Float64Array>();
  for (const c of COINS) { const p = new Float64Array(TS.length).fill(NaN); const u = U.get(c), b = BN.get(c); if (!u || !b) continue; TS.forEach((t, i) => { const x = u.get(t), y = b.get(t); if (x && y) p[i] = Math.log(x.close / y); }); P.set(c, p); }
  const med = TS.map((_, i) => { const v = [...P.values()].map(p => p[i]).filter(x => !Number.isNaN(x)); return v.length >= 10 ? L.median(v) : NaN; });
  for (const [c, p] of P) RP.set(c, p.map((x, i) => x - med[i]));
}
const Z = new Map<string, { z: Float64Array; dev: Float64Array }>();
for (const [c, r] of RP) { const z = new Float64Array(TS.length).fill(NaN), dev = new Float64Array(TS.length).fill(NaN);
  for (let i = 180; i < TS.length; i++) { if (Number.isNaN(r[i])) continue; let s = 0, s2 = 0, n = 0; for (let j = i - 180; j < i; j++) { if (Number.isNaN(r[j])) continue; s += r[j]; s2 += r[j] ** 2; n++; } if (n < 150) continue; const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-12)); z[i] = (r[i] - mu) / sd; dev[i] = r[i] - mu; }
  Z.set(c, { z, dev }); }
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
let CX = 1; const slip = (c: string) => CX * Math.max(0.0005, (SPREAD['KRW-' + c] ?? 20) / 2 / 1e4); const FEE = () => 0.0005 * CX;
const rankAt = (c: string, t: number) => { const d = Math.floor((t - 1) / L.DAY) * L.DAY - L.DAY; const i = L.TI.get(d); if (i == null) return 999; return L.RANK[i].get('KRW-' + c) ?? 999; };
interface Cfg { Z: number; gap: number; tp: number | null; hold: number; K: number; N: number; delay?: number; rand?: number; seed?: number }
function run(cfg: Cfg, size: number, from = 0, to = Infinity, evs?: any[]) {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, wins = 0, sumR = 0; const open: any[] = []; const dayEq = new Map<number, number>();
  let seed = cfg.seed ?? 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const dl = cfg.delay ?? 0;
  for (let i = 181 + dl; i < TS.length; i++) {
    const ts = TS[i]; if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const b = U.get(q.c)!.get(ts); if (!b) continue; let px = 0;
      if (q.exitNext) px = b.open * (1 - slip(q.c));
      else if (b.high >= q.tgt * 1.002) px = q.tgt;
      else if (ts + H4 - q.t0 >= cfg.hold * 3600e3) px = b.close * (1 - slip(q.c));
      else { const z = Z.get(q.c)!.z[i]; if (!Number.isNaN(z) && z >= 0) q.exitNext = true; q.last = b.close; }
      if (px) { const got = q.vol * px * (1 - FEE()); cash += got; n++; const r = got / q.used - 1; sumR += r; if (r > 0) wins++; evs?.push({ ...q, r }); open.splice(p, 1); }
    }
    const j = i - 1 - dl; const eqNow = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    const cands: [string, number][] = [];
    for (const c of Z.keys()) {
      if (c === 'BTC' || open.some(q => q.c === c) || !U.get(c)!.get(ts)) continue; if (rankAt(c, TS[j] + H4) >= cfg.N) continue;
      if (cfg.rand != null) { if (rnd() < cfg.rand) cands.push([c, rnd()]); continue; }
      const z = Z.get(c)!.z[j], dv = Z.get(c)!.dev[j]; if (Number.isNaN(z) || z > -cfg.Z || dv > -cfg.gap / 100) continue; cands.push([c, -z]);
    }
    cands.sort((a, b) => b[1] - a[1]);
    for (const [c] of cands) {
      if (open.length >= cfg.K) break; const b = U.get(c)!.get(ts)!; const ep = b.open * (1 + slip(c)); const used = Math.min(cash, eqNow * size); if (used < 5000) continue;
      cash -= used; const q = { c, ep, vol: used * (1 - FEE()) / ep, used, tgt: cfg.tp != null ? ep * (1 + cfg.tp / 100) : Infinity, t0: ts, last: b.close, exitNext: false, rank: rankAt(c, ts), sigClose: U.get(c)!.get(TS[j])?.close, openPx: b.open };
      if (b.high >= q.tgt * 1.002) { const got = q.vol * q.tgt * (1 - FEE()); cash += got; n++; const r = got / used - 1; sumR += r; if (r > 0) wins++; evs?.push({ ...q, r }); continue; }
      open.push(q);
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
    dayEq.set(Math.floor((ts + H4 - 1) / L.DAY) * L.DAY, eq);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  const daily = new Float64Array(L.TS.length).fill(NaN); let prev = 1e7; for (let i = 0; i < L.TS.length; i++) { const e = dayEq.get(L.TS[i]); if (e == null) continue; daily[i] = e / prev - 1; prev = e; }
  const dr = [...daily].filter(x => !Number.isNaN(x)); const mu = dr.reduce((a, b) => a + b, 0) / dr.length, sd = Math.sqrt(dr.reduce((a, b) => a + (b - mu) ** 2, 0) / dr.length);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, win: n ? 100 * wins / n : 0, avg: n ? 100 * sumR / n : 0, sharpe: sd ? mu / sd * Math.sqrt(365) : 0, daily, yrs: dr.length / 365 };
}
const out: string[] = []; const SPLIT = Date.UTC(2024, 6, 1);
const rows: string[] = ['Z gap tp hold N | ret sh n avg | IS OOS | 22H2 23 24H1 24H2 25 26']; const res: { k: string; ret: number; oos: number; isSh: number }[] = [];
for (const Zt of [2, 2.5, 3]) for (const gap of [0.5, 1, 2]) for (const [tp, hold] of [[null, 24], [null, 72], [3, 72]] as [number | null, number][]) for (const N of [20, 30]) {
  const c: Cfg = { Z: Zt, gap, tp, hold, K: 3, N }; const r = run(c, 1 / 3), is = run(c, 1 / 3, 0, SPLIT), oos = run(c, 1 / 3, SPLIT);
  res.push({ k: `${Zt}/${gap}/${tp}/${hold}/${N}`, ret: r.ret, oos: oos.ret, isSh: is.sharpe });
  rows.push(`${Zt} ${gap} ${tp ?? '-'} ${hold} ${N} | ${L.f1(r.ret)} ${r.sharpe.toFixed(2)} ${r.n} ${r.avg.toFixed(2)} | ${L.f1(is.ret)} ${L.f1(oos.ret)} | ${L.PERIODS.slice(2).map(([, a, z]) => L.f1(L.periodRet(r.daily, a, z))).join(' ')}`);
}
out.push(`grid ${res.length} cells (fixed 33%×3): median ${L.median(res.map(r => r.ret)).toFixed(1)}% pos ${(100 * res.filter(r => r.ret > 0).length / res.length).toFixed(0)}% | OOS median ${L.median(res.map(r => r.oos)).toFixed(1)}% pos ${(100 * res.filter(r => r.oos > 0).length / res.length).toFixed(0)}%`);
const best = [...res].sort((a, b) => b.isSh - a.isSh)[0]; out.push(`WF IS-best ${best.k} → OOS ${L.f1(best.oos)}%`);
const c0: Cfg = { Z: 2.5, gap: 1, tp: null, hold: 72, K: 3, N: 30 };
let lo = 0.01, hi = 1; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (run(c0, m).mdd > 17) hi = m; else lo = m; } const sz = (lo + hi) / 2;
const evs: any[] = []; const r0 = run(c0, sz, 0, Infinity, evs);
out.push(`center Z2.5 gap1 72h N30 eq17(size ${(sz * 100).toFixed(0)}%): ret ${L.f0(r0.ret)}% MDD ${r0.mdd.toFixed(0)} Sh ${r0.sharpe.toFixed(2)} n ${r0.n} win ${r0.win.toFixed(0)} avg ${r0.avg.toFixed(2)}%`);
out.push('periods ' + L.PERIODS.slice(2).map(([p, a, z]) => `${p} ${L.f1(L.periodRet(r0.daily, a, z))}`).join(' | '));
out.push('regime ' + JSON.stringify(L.regimeStats(r0.daily)));
CX = 2; out.push(`cost×2 ${L.f0(run(c0, sz).ret)}%`); CX = 1; out.push(`delay 1 bar ${L.f0(run({ ...c0, delay: 1 }, sz).ret)}%`);
const pl: number[] = []; const fq = r0.n / (TS.length * 15); for (let s = 1; s <= 30; s++) pl.push(run({ ...c0, rand: fq, seed: s * 17 }, sz).ret); pl.sort((a, b) => a - b);
out.push(`placebo med ${L.f0(pl[15])}% max ${L.f0(pl[29])}% → ${pl.filter(x => x >= r0.ret).length}/30 ≥`);
out.push(`bounce: mean(open/sigClose−1) ${(evs.reduce((a, e) => a + (e.openPx / e.sigClose - 1), 0) / evs.length * 100).toFixed(3)}%; by rank ` + [[0, 10], [10, 20], [20, 30]].map(([a, b]) => { const t = evs.filter(e => e.rank >= a && e.rank < b); return `${a + 1}-${b}: n${t.length} avg ${(100 * t.reduce((s, e) => s + e.r, 0) / Math.max(1, t.length)).toFixed(2)}%`; }).join(' '));
out.push('fleet ' + JSON.stringify(L.fleetCompare(r0.daily)));
out.push(rows.join('\n'));
fs.writeFileSync(`${OUT}/prem4h-report.txt`, out.join('\n'));
console.log('done');
