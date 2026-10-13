/**
 * 축 ALT-1a: 투매 대리변수(가격·거래대금만) 후 반등 — 시점별 유니버스 일봉.
 * 신호(i 종가): 일간 수익 ≤ −x & 거래대금 z(30일) ≥ z0   (변형 '3d': 3일 수익 ≤ −x3 & 오늘 z ≥ z0)
 * 변형 'mkt': 시장 투매일(상위 30 알트 중 일 −x 이하 비율 ≥ 40%) 에 그날 가장 많이 빠진 코인 매수.
 * 진입 i+1 시가, TP 지정가(관통 0.2%)/H일 시간청산, 무스톱, K=3.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const SIG = new Map<string, L.Sig>();
const getSig = (kind: string, x: number, z0: number) => {
  const k = `${kind}_${x}_${z0}`; if (SIG.has(k)) return SIG.get(k)!;
  let f: L.Sig;
  if (kind === '1d') f = (m, i) => { const r = L.ret(m, i, 1); if (r == null || r > -x / 100) return null; const z = L.valZ(m, i); return z != null && z >= z0 ? -r : null; };
  else if (kind === '3d') f = (m, i) => { const r = L.ret(m, i, 3); if (r == null || r > -x / 100) return null; const z = L.valZ(m, i); return z != null && z >= z0 ? -r : null; };
  else { // mkt
    const brd = new Float64Array(L.TS.length); for (let i = 1; i < L.TS.length; i++) { let n = 0, d = 0; for (const [m, r] of L.ARANK[i]) { if (r >= 30) continue; const q = L.ret(m, i, 1); if (q == null) continue; n++; if (q <= -x / 100) d++; } brd[i] = n ? d / n : 0; }
    f = (m, i) => { if (brd[i] < 0.4) return null; const r = L.ret(m, i, 1); return r == null ? null : -r; };
  }
  const g = L.memo(f); SIG.set(k, g); return g;
};
const cells: L.Cell[] = [];
for (const [kind, xs] of [['1d', [7, 10, 15]], ['3d', [15, 25]], ['mkt', [7, 10]]] as [string, number[]][]) for (const x of xs) for (const z0 of kind === 'mkt' ? [0] : [1, 2])
  for (const N of [20, 30]) for (const bf of ['none', 'ab']) for (const tp of [5, 8, 12]) for (const H of [3, 5, 7])
    cells.push({ key: `${kind}_x${x}_z${z0}_N${N}_${bf}_tp${tp}_H${H}`, params: { kind, x, z0, N, bf, tp, H }, c: { sig: getSig(kind, x, z0), N, K: 3, x: { tp, H }, btcOk: L.btcFilters[bf] } });
const rows = L.runGrid(cells);
fs.writeFileSync(`${OUT}/cap-grid.tsv`, L.gridText(rows, ['kind', 'x', 'z0', 'N', 'bf', 'tp', 'H']));
const out: string[] = [];
for (const kind of ['1d', '3d', 'mkt']) for (const bf of ['none', 'ab']) out.push(`${kind} ${bf}: ` + JSON.stringify(L.wf(rows.filter(r => r.kind === kind && r.bf === bf))));
out.push('ALL: ' + JSON.stringify(L.wf(rows)));
out.push('top by sharpe:\n' + L.gridText([...rows].sort((a, b) => b.sh - a.sh).slice(0, 10), ['kind', 'x', 'z0', 'N', 'bf', 'tp', 'H']));
for (const [kind, x, z0, N, bf, tp, H] of [['1d', 10, 2, 20, 'none', 8, 5], ['1d', 10, 1, 30, 'none', 8, 5], ['3d', 25, 1, 30, 'none', 8, 5], ['mkt', 10, 0, 20, 'none', 8, 5]] as [string, number, number, number, string, number, number][]) {
  const rep = L.fullReport(`cap ${kind} x${x} z${z0} N${N} ${bf} tp${tp} H${H}`, { sig: getSig(kind, x, z0), N, K: 3, x: { tp, H }, btcOk: L.btcFilters[bf] });
  out.push(rep.L.join('\n'));
}
fs.writeFileSync(`${OUT}/cap-report.txt`, out.join('\n\n'));
console.log('done');
