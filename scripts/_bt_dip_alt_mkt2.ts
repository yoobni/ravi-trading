/**
 * 축 ALT-1b 보강: 실제 선택(투매일 낙폭 상위 K) 만으로 이벤트 스터디 — 유동성 구간별로 '그 구간 안에서' 낙폭 상위 3.
 * 그리고 2022-07 이후 구간의 대표칸 이웃 고원.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const out: string[] = [];
const breadth = (x: number) => { const brd = new Float64Array(L.TS.length); for (let i = 1; i < L.TS.length; i++) { let n = 0, d = 0; for (const [m, r] of L.ARANK[i]) { if (r >= 30) continue; const q = L.ret(m, i, 1); if (q == null) continue; n++; if (q <= -x / 100) d++; } brd[i] = n ? d / n : 0; } return brd; };
const B7 = breadth(7);
/** 투매일 i 에 순위 [lo,hi) 안에서 낙폭 상위 k 만 신호 */
function topK(brd: Float64Array, b: number, lo: number, hi: number, k: number): L.Sig {
  const pick = new Map<number, Set<string>>();
  for (let i = 1; i < L.TS.length; i++) {
    if (brd[i] < b) continue;
    const c: [string, number][] = []; for (const [m, r] of L.ARANK[i]) { if (r < lo || r >= hi) continue; const q = L.ret(m, i, 1); if (q != null) c.push([m, q]); }
    c.sort((a, z) => a[1] - z[1]); pick.set(i, new Set(c.slice(0, k).map(([m]) => m)));
  }
  return (m, i) => (pick.get(i)?.has(m) ? -(L.ret(m, i, 1) ?? 0) : null);
}
const x = { tp: 8, H: 5 };
for (const [from, lab] of [[L.START, '2019~'], [Date.UTC(2022, 6, 1), '2022-07~'], [Date.UTC(2024, 0, 1), '2024~']] as [number, string][]) {
  out.push(`== events: panic x7 b0.4, 낙폭 상위3 within rank bin, tp8 H5, from ${lab}`);
  out.push('bin     n   exec%  oo%   cc%   bounce  win  t   spread');
  for (const [lo, hi] of [[0, 10], [10, 20], [20, 30], [30, 50], [0, 20]]) {
    const ev = L.events(topK(B7, 0.4, lo, hi, 3), 50, x, { from });
    const s = L.evStats(ev); const sp = ev.length ? ev.reduce((a, e) => a + e.spread, 0) / ev.length : 0;
    out.push(`${lo + 1}-${hi}`.padEnd(7) + ` ${String(s.n).padStart(4)} ${s.mean.toFixed(2).padStart(6)} ${s.oo.toFixed(2).padStart(6)} ${s.cc.toFixed(2).padStart(6)} ${(s.cc - s.oo).toFixed(2).padStart(6)} ${s.win.toFixed(0).padStart(4)} ${s.t.toFixed(1).padStart(5)} ${sp.toFixed(0).padStart(5)}`);
  }
}
// 연도별 (상위 20 안 낙폭 상위 3)
const ev = L.events(topK(B7, 0.4, 0, 20, 3), 50, x, { from: L.START });
const yrs: Record<string, L.Ev[]> = {}; for (const e of ev) (yrs[new Date(e.ts).getUTCFullYear()] ??= []).push(e);
out.push('by year (top20 losers3): ' + Object.entries(yrs).map(([y, e]) => { const s = L.evStats(e); return `${y} n${s.n} ${s.mean.toFixed(2)}% win${s.win.toFixed(0)} t${s.t.toFixed(1)}`; }).join(' | '));
// 2022-07 이후 고원 (고정 1/3, 칸별 수익)
const F = Date.UTC(2022, 6, 1);
const rows: string[] = ['x b N tp H | ret22-07~ mdd sh n | 22H2 23 24 25 26'];
const rets: number[] = [];
for (const xx of [5, 7, 10]) { const br = xx === 7 ? B7 : breadth(xx); for (const b of [0.3, 0.4, 0.5]) for (const N of [20, 30]) for (const [tp, H] of [[5, 3], [8, 5], [12, 7], [0, 3], [0, 5]]) {
  const c: L.PCfg = { sig: topK(br, b, 0, N, 3), N, K: 3, x: { tp: tp || null, H } }; const r = L.port(c, 1 / 3, F);
  rets.push(r.ret);
  rows.push(`${xx} ${b} ${N} ${tp || '-'} ${H} | ${L.f1(r.ret)} ${r.mdd.toFixed(0)} ${r.sharpe.toFixed(2)} ${r.n} | ${L.PERIODS.slice(2).map(([, a, z]) => L.f1(L.periodRet(r.daily, a, z))).join(' ')}`);
} }
out.push(`plateau 2022-07~ (90 cells, fixed 33%x3): median ${L.median(rets).toFixed(1)}% positive ${(100 * rets.filter(r => r > 0).length / rets.length).toFixed(0)}%`);
out.push(rows.join('\n'));
fs.writeFileSync(`${OUT}/mkt2-report.txt`, out.join('\n'));
console.log('done');
