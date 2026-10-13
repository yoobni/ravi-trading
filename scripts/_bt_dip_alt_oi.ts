/**
 * 축 ALT-1c: 청산 캐스케이드(바이낸스 선물 OI 급감 + 업비트 가격 급락) 후 매수 — 4h, 현실 체결 재검증.
 * 이전(축 D-5 △): OI 4h −8% & 업비트 −5% → 72h, MDD17 150%, n=54, 28코인 고정, 4h 경계 OI 사용.
 * 이번 변경:
 *   - 판단 시각 = 업비트 4h 봉 마감 t. OI 는 t−1h 스냅샷(공개 t−55분) 과 t−1h−win 비교 → 미래참조 0.
 *   - 진입 = t 에 시작하는 봉 시가 + 스프레드½. TP 지정가는 관통 0.2% 요구, 시간청산은 종가 시장가. 무스톱.
 *   - 시점별 유니버스: 그 전날 업비트 30일 거래대금 순위(전 종목 기준) 상위 N 인 코인만(28코인 중) — OI 데이터가 28코인뿐이라 완전 차단은 불가.
 *   - 대조군: 같은 가격조건만(OI 무시), 무작위(같은 빈도).
 */
import fs from 'fs';
import path from 'path';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const H1 = 3600e3, H4 = 4 * H1;
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
interface B { ts: number; open: number; high: number; low: number; close: number }
const BARS = new Map<string, B[]>(), IDX = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const f = fs.readdirSync('data/candle-cache').find(x => x.startsWith(`KRW-${c}_240m_2022-06-10_2026-10-13`)); if (!f) continue;
  const b: B[] = JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')).sort((a: B, z: B) => a.ts - z.ts);
  BARS.set(c, b); IDX.set(c, new Map(b.map((x, i) => [x.ts, i])));
}
const OI = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const f = path.resolve('data/research-ext/binance/metrics', c + '.csv'); if (!fs.existsSync(f)) continue;
  const m = new Map<number, number>();
  for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(1)) { const p = l.split(','); const t = Date.parse(p[0].replace(' ', 'T') + 'Z'); const v = +p[1]; if (Number.isFinite(t) && v > 0) m.set(t, v); }
  OI.set(c, m);
}
const OI_END = Date.UTC(2026, 8, 30, 23);
const TS = [...new Set([...BARS.values()].flatMap(b => b.map(x => x.ts)))].filter(t => t + H4 <= OI_END + H1).sort((a, z) => a - z);
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
let CX = 1; const slip = (c: string) => CX * Math.max(0.0005, (SPREAD['KRW-' + c] ?? 20) / 2 / 1e4); const FEE = () => 0.0005 * CX;
// 전날(일봉) 시점별 순위: 그 4h 봉 마감 시각 이전에 끝난 마지막 일봉
const rankAt = (c: string, t: number) => { const d = Math.floor((t - 1) / L.DAY) * L.DAY - L.DAY; const i = L.TI.get(d); if (i == null) return 999; return L.RANK[i].get('KRW-' + c) ?? 999; };

interface Cfg { k: number; y: number; win: number; tp: number | null; hold: number; K: number; N: number; noOI?: boolean; btcOnly?: boolean; rand?: number; seed?: number; delay?: number }
/** 신호: 봉 i (마감 t = ts+4h) */
function sigAt(c: string, i: number, cfg: Cfg): boolean {
  const b = BARS.get(c)!; const t = b[i].ts + H4; const nb = Math.round(cfg.win / 4);
  if (i - nb < 0) return false;
  const pr = b[i].close / b[i - nb].close - 1; if (pr > -cfg.y) return false;
  if (b[i].ts - b[i - nb].ts !== nb * H4) return false;
  if (cfg.noOI) return true;
  const o1 = OI.get(c)?.get(t - H1), o0 = OI.get(c)?.get(t - H1 - cfg.win * H1); if (!o1 || !o0) return false;
  return o1 / o0 - 1 <= -cfg.k;
}
function run(cfg: Cfg, size: number, from = 0, to = Infinity, trades?: any[]) {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, wins = 0, sumR = 0;
  const open: any[] = []; const last = new Map<string, number>(); let seed = cfg.seed ?? 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const dayEq = new Map<number, number>(); const dl = cfg.delay ?? 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    // 보유분 (이 봉 ts 에서)
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.c)!.get(ts); if (i === undefined) continue; const b = BARS.get(q.c)![i];
      let px = 0;
      if (cfg.tp != null && b.high >= q.tgt * 1.002) px = q.tgt;
      else if (ts + H4 - q.t0 >= cfg.hold * H1) px = b.close * (1 - slip(q.c));
      if (px) { const got = q.vol * px * (1 - FEE()); cash += got; n++; const r = got / q.used - 1; sumR += r; if (r > 0) wins++; trades?.push({ ...q, r, exit: ts }); open.splice(p, 1); }
      else q.last = b.close;
    }
    // 진입: 신호봉 = ts 직전 봉(마감 ts) [+ delay 봉]
    const eqNow = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    const cands: [string, number][] = [];
    for (const c of COINS) {
      if (cfg.btcOnly && c !== 'BTC') continue;
      const m = IDX.get(c)!; const i0 = m.get(ts); const is = m.get(ts - H4 * (1 + dl)); if (i0 === undefined || is === undefined) continue;
      if (rankAt(c, ts - H4 * dl) >= cfg.N) continue;
      if ((last.get(c) ?? -Infinity) > ts - L.DAY || open.some(q => q.c === c)) continue;
      if (cfg.rand != null) { if (rnd() < cfg.rand) cands.push([c, rnd()]); continue; }
      if (!sigAt(c, is, cfg)) continue;
      const b = BARS.get(c)!; cands.push([c, -(b[is].close / b[is - Math.round(cfg.win / 4)].close - 1)]);
    }
    cands.sort((a, z) => z[1] - a[1]);
    for (const [c] of cands) {
      if (open.length >= cfg.K) break;
      const b = BARS.get(c)![IDX.get(c)!.get(ts)!]; const ep = b.open * (1 + slip(c)); const used = Math.min(cash, eqNow * size); if (used < 5000) continue;
      cash -= used; last.set(c, ts);
      const q = { c, ep, vol: used * (1 - FEE()) / ep, used, tgt: cfg.tp != null ? ep * (1 + cfg.tp / 100) : Infinity, t0: ts, last: b.close, rank: rankAt(c, ts), sigClose: BARS.get(c)![IDX.get(c)!.get(ts - H4)!]?.close, openPx: b.open };
      // 진입봉 자체 처리(시가 진입 → 그 봉 고가로 TP 가능, 시간청산 체크)
      if (cfg.tp != null && b.high >= q.tgt * 1.002) { const got = q.vol * q.tgt * (1 - FEE()); cash += got; n++; const r = got / used - 1; sumR += r; if (r > 0) wins++; trades?.push({ ...q, r, exit: ts }); continue; }
      open.push(q);
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
    dayEq.set(Math.floor((ts + H4 - 1) / L.DAY) * L.DAY, eq);   // 봉 마감이 속한 UTC 날짜의 마지막 평가액
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  // 일수익 (L.TS 정렬)
  const daily = new Float64Array(L.TS.length).fill(NaN); let prev = 1e7;
  for (let i = 0; i < L.TS.length; i++) { const e = dayEq.get(L.TS[i]); if (e == null) continue; daily[i] = e / prev - 1; prev = e; }
  const dr = [...daily].filter(x => !Number.isNaN(x)); const mu = dr.reduce((a, b) => a + b, 0) / dr.length; const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mu) ** 2, 0) / dr.length);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, win: n ? 100 * wins / n : 0, avg: n ? 100 * sumR / n : 0, sharpe: sd ? mu / sd * Math.sqrt(365) : 0, cagr: 100 * (Math.pow(eq / 1e7, 365 / Math.max(dr.length, 1)) - 1), daily, yrs: dr.length / 365 };
}
const eq17 = (cfg: Cfg, from?: number) => { let lo = 0.01, hi = 1; if (run(cfg, 1, from).mdd <= 17) return 1; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (run(cfg, m, from).mdd > 17) hi = m; else lo = m; } return (lo + hi) / 2; };
const out: string[] = [];
const line = (nm: string, r: ReturnType<typeof run>) => `${nm.padEnd(40)} ret ${L.f0(r.ret).padStart(6)}% CAGR ${L.f1(r.cagr)}% MDD ${r.mdd.toFixed(1)}% Sh ${r.sharpe.toFixed(2)} n ${r.n} (${(r.n / r.yrs).toFixed(0)}/y) win ${r.win.toFixed(0)}% avg ${r.avg.toFixed(2)}%`;
const per = (r: ReturnType<typeof run>) => L.PERIODS.slice(2).map(([p, a, z]) => `${p} ${L.f1(L.periodRet(r.daily, a, z))}`).join(' | ');
const SPLIT = Date.UTC(2024, 6, 1);
function reportCell(nm: string, c: Cfg) {
  const sz = eq17(c); const tr: any[] = []; const r = run(c, sz, 0, Infinity, tr);
  out.push(`### OI ${nm} (eq17 size ${(sz * 100).toFixed(0)}%)`); out.push(line('eq17', r)); out.push(line(`fixed ${(100 / c.K).toFixed(0)}%`, run(c, 1 / c.K)));
  out.push('periods: ' + per(r));
  const rg = L.regimeStats(r.daily); out.push('regime: ' + Object.entries(rg).map(([g, v]) => `${g} days ${v.n} mean ${v.mean.toFixed(1)}bp cum ${L.f1(v.cum)}%`).join(' | '));
  CX = 2; const c2 = run(c, sz); CX = 1; const d1 = run({ ...c, delay: 1 }, sz); const po = run({ ...c, noOI: true }, sz);
  out.push(`cost×2 ${L.f0(c2.ret)}% | delay 4h ${L.f0(d1.ret)}% | price-only same size ${L.f0(po.ret)}% (n ${po.n}) | IS(<2024-07) ${L.f1(run(c, sz, 0, SPLIT).ret)}% OOS ${L.f1(run(c, sz, SPLIT).ret)}%`);
  // 플라시보: 같은 빈도
  const freq = r.n / Math.max(1, TS.length * (c.btcOnly ? 1 : 15)); const pl: number[] = [];
  for (let s = 1; s <= 30; s++) pl.push(run({ ...c, rand: freq, seed: s * 31 }, sz).ret); pl.sort((a, z) => a - z);
  out.push(`placebo 30: med ${L.f0(pl[15])}% max ${L.f0(pl[29])}% → ${pl.filter(x => x >= r.ret).length}/30 ≥`);
  const fc = L.fleetCompare(r.daily); out.push(`fleet corr ${JSON.stringify(fc.corr)} | fleet-loss days ${fc.fleetLossDays}: ${fc.avgOnFleetLoss_bp}bp`);
  // 튐: 신호봉 종가 진입 vs 다음봉 시가 진입(무슬리피지) — 같은 청산가
  const bounce = tr.filter(t => t.sigClose).map(t => (t.openPx / t.sigClose - 1) * 100); const uniqDays = new Set(tr.map(t => Math.floor(t.t0 / L.DAY))).size;
  out.push(`trades ${tr.length}, unique days ${uniqDays}, mean(open/sigClose−1) ${(bounce.reduce((a, b) => a + b, 0) / Math.max(1, bounce.length)).toFixed(3)}%  by rank: ` + [[0, 10], [10, 20], [20, 30], [30, 999]].map(([lo, hi]) => { const t = tr.filter(x => x.rank >= lo && x.rank < hi); return `${lo + 1}-${hi}: n${t.length} avg ${(100 * t.reduce((a, x) => a + x.r, 0) / Math.max(1, t.length)).toFixed(2)}%`; }).join(' '));
}
const MODE = process.argv[2] || 'main';
if (MODE === 'main') {
// 1) 격자 (고정 1/K)
const rows: string[] = ['k y win tp hold N | OI: ret mdd sh n | price-only: ret sh n | IS(<2024-07) OOS'];
const cellRes: { key: string; oi: number; po: number; oos: number; isSh: number }[] = [];
for (const k of [0.05, 0.08, 0.12]) for (const y of [0.03, 0.05, 0.08]) for (const win of [4, 12, 24]) for (const [tp, hold] of [[null, 72], [5, 72], [3, 48], [8, 120]] as [number | null, number][]) for (const N of [30, 999]) {
  const c: Cfg = { k, y, win, tp, hold, K: 3, N };
  const r = run(c, 1 / 3), po = run({ ...c, noOI: true }, 1 / 3), is = run(c, 1 / 3, 0, SPLIT), oos = run(c, 1 / 3, SPLIT);
  cellRes.push({ key: `${k}/${y}/${win}/${tp}/${hold}/${N}`, oi: r.ret, po: po.ret, oos: oos.ret, isSh: is.sharpe });
  rows.push(`${k} ${y} ${win} ${tp ?? '-'} ${hold} ${N} | ${L.f1(r.ret)} ${r.mdd.toFixed(0)} ${r.sharpe.toFixed(2)} ${r.n} | ${L.f1(po.ret)} ${po.sharpe.toFixed(2)} ${po.n} | ${L.f1(is.ret)} ${L.f1(oos.ret)}`);
}
fs.writeFileSync(`${OUT}/oi-grid.txt`, rows.join('\n'));
const N30 = cellRes.filter(c => c.key.endsWith('/30'));
out.push(`grid N30 (${N30.length} cells, fixed 33%×3): OI median ${L.median(N30.map(c => c.oi)).toFixed(1)}% pos ${(100 * N30.filter(c => c.oi > 0).length / N30.length).toFixed(0)}% | price-only median ${L.median(N30.map(c => c.po)).toFixed(1)}% | OI−price>0 in ${(100 * N30.filter(c => c.oi > c.po).length / N30.length).toFixed(0)}% | OOS median ${L.median(N30.map(c => c.oos)).toFixed(1)}%`);
const best = [...N30].sort((a, z) => z.isSh - a.isSh)[0]; out.push(`WF: IS-best ${best.key} → OOS ${L.f1(best.oos)}%`);
// 2) 대표칸 = 이전 △ 칸 그대로 (k 8%, y 5%, win 4h, 72h, 무 TP), N30 / N999
for (const [nm, c] of [['prev-cell N30', { k: 0.08, y: 0.05, win: 4, tp: null, hold: 72, K: 3, N: 30 }], ['prev-cell all28', { k: 0.08, y: 0.05, win: 4, tp: null, hold: 72, K: 3, N: 999 }], ['k8 y5 win24 72h N30', { k: 0.08, y: 0.05, win: 24, tp: null, hold: 72, K: 3, N: 30 }], ['BTC only OI−5% y−3% win24 72h', { k: 0.05, y: 0.03, win: 24, tp: null, hold: 72, K: 1, N: 999, btcOnly: true }]] as [string, Cfg][]) reportCell(nm, c);

fs.writeFileSync(`${OUT}/oi-report.txt`, out.join('\n'));
}
if (MODE === 'rep') {
  for (const [nm, c] of [['k8 y5 win24 72h N10', { k: 0.08, y: 0.05, win: 24, tp: null, hold: 72, K: 3, N: 10 }], ['k8 y5 win24 72h N15', { k: 0.08, y: 0.05, win: 24, tp: null, hold: 72, K: 3, N: 15 }], ['k8 y5 win24 72h N10 K2', { k: 0.08, y: 0.05, win: 24, tp: null, hold: 72, K: 2, N: 10 }]] as [string, Cfg][]) reportCell(nm, c);
  fs.writeFileSync(`${OUT}/oi-rep.txt`, out.join('\n'));
}
if (MODE === 'robust') {
  // 24h 창 계열: 보유기간·유니버스 크기·기간분할·2024H2 제외
  const rows: string[] = ['k y hold N | ret(fixed33) sh n | 22H2 23 24H1 24H2 25 26 | ex-2024H2 chain | price-only ret'];
  const ex24: number[] = [];
  for (const k of [0.05, 0.08, 0.12]) for (const y of [0.03, 0.05, 0.08]) for (const hold of [48, 72, 96]) for (const N of [10, 15, 30]) {
    const c: Cfg = { k, y, win: 24, tp: null, hold, K: 3, N }; const r = run(c, 1 / 3); const po = run({ ...c, noOI: true }, 1 / 3);
    const ps = L.PERIODS.slice(2).map(([, a, z]) => L.periodRet(r.daily, a, z));
    const ex = 100 * (ps.reduce((a, v, j) => j === 3 ? a : a * (1 + v / 100), 1) - 1); ex24.push(ex);
    rows.push(`${k} ${y} ${hold} ${N} | ${L.f1(r.ret)} ${r.sharpe.toFixed(2)} ${r.n} | ${ps.map(L.f1).join(' ')} | ${L.f1(ex)} | ${L.f1(po.ret)}`);
  }
  const byN = (n: number) => rows.slice(1).filter(r => r.split(' ')[3] === String(n));
  const med = (rs: string[], col: number) => L.median(rs.map(r => +r.split('|')[col].trim().split(' ')[0]));
  out.push(`24h family (81 cells): ex-2024H2 median ${L.median(ex24).toFixed(1)}%, positive ${(100 * ex24.filter(x => x > 0).length / ex24.length).toFixed(0)}%`);
  for (const n of [10, 15, 30]) out.push(`N${n}: median ret ${med(byN(n), 1).toFixed(1)}% | ex-2024H2 median ${L.median(byN(n).map(r => +r.split('|')[3].trim())).toFixed(1)}% | price-only median ${L.median(byN(n).map(r => +r.split('|')[4].trim())).toFixed(1)}%`);
  for (const h of [48, 72, 96]) { const rs = rows.slice(1).filter(r => r.split(' ')[2] === String(h)); out.push(`hold ${h}h: median ret ${med(rs, 1).toFixed(1)}%`); }
  out.push(rows.join('\n'));
  fs.writeFileSync(`${OUT}/oi-robust.txt`, out.join('\n'));
}
console.log('done');
