/**
 * 축 ALT-4: '7일 신저가 + 반등 양봉' 일봉 스윙 (시점별 유니버스).
 * 이전 탈락(4h 항복반등: 28코인 고정 · 4h · 신저가+급락봉+volZ≥2 · 다음 4h 시가)과 다른 점:
 *   일봉, 시점별 거래대금 상위 N(생존편향 차단), '급락봉' 이 아니라 '신저가를 찍고 되돌린 양봉'(확인 후 진입), TP 지정가+시간청산·무스톱.
 * 신호(i 종가): A) low_i < 직전 7일 최저 low & close>open & CLV=(c−l)/(h−l) ≥ 0.6
 *              B) close_{i−1} ≤ 직전 7일 최저 종가(전일 신저가 마감) & close_i > open_i & close_i ≥ close_{i−1}×1.01
 * 강도 = −7일 수익(깊이 빠진 것 우선).
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const sigA = L.memo((m, i) => {
  const a = L.G.get(m)!; const x = a[i]; if (!x || x.close <= x.open || x.high <= x.low) return null;
  let lo = Infinity; for (let j = i - 7; j < i; j++) { if (!a[j]) return null; lo = Math.min(lo, a[j]!.low); }
  if (!(x.low < lo) || (x.close - x.low) / (x.high - x.low) < 0.6) return null;
  const r7 = L.ret(m, i, 7); return r7 == null ? null : -r7;
});
const sigB = L.memo((m, i) => {
  const a = L.G.get(m)!; const x = a[i], y = a[i - 1]; if (!x || !y || x.close <= x.open || x.close < y.close * 1.01) return null;
  let lo = Infinity; for (let j = i - 8; j < i - 1; j++) { if (!a[j]) return null; lo = Math.min(lo, a[j]!.close); }
  if (!(y.close <= lo)) return null;
  const r7 = L.ret(m, i, 7); return r7 == null ? null : -r7;
});
const SIG: Record<string, L.Sig> = { A: sigA, B: sigB };
const cells: L.Cell[] = [];
for (const s of ['A', 'B']) for (const N of [20, 30]) for (const bf of ['none', 'ab', 'a']) for (const tp of [4, 6, 8, 12]) for (const H of [2, 3, 5, 7])
  cells.push({ key: `${s}_N${N}_${bf}_tp${tp}_H${H}`, params: { s, N, bf, tp, H }, c: { sig: SIG[s], N, K: 3, x: { tp, H }, btcOk: L.btcFilters[bf] } });
const rows = L.runGrid(cells);
fs.writeFileSync(`${OUT}/low7-grid.tsv`, L.gridText(rows, ['s', 'N', 'bf', 'tp', 'H']));
const out: string[] = [];
for (const s of ['A', 'B']) for (const bf of ['none', 'ab', 'a']) {
  const sub = rows.filter(r => r.s === s && r.bf === bf);
  out.push(`${s} ${bf}: ` + JSON.stringify(L.wf(sub)));
}
out.push('ALL: ' + JSON.stringify(L.wf(rows)));
const top = [...rows].sort((a, b) => b.sh - a.sh).slice(0, 8); out.push('top by sharpe:\n' + L.gridText(top, ['s', 'N', 'bf', 'tp', 'H']));
// 대표 칸: 이웃 중앙에 가까운 칸 (사전 지정: A, N20, ab, tp6, H3 — ALT_SWING 과 같은 tp/H)
for (const [s, N, bf, tp, H] of [['A', 20, 'ab', 6, 3], ['A', 20, 'none', 6, 3], ['B', 20, 'ab', 6, 3]] as [string, number, string, number, number][]) {
  const rep = L.fullReport(`low7 ${s} N${N} ${bf} tp${tp} H${H}`, { sig: SIG[s], N, K: 3, x: { tp, H }, btcOk: L.btcFilters[bf] });
  out.push(rep.L.join('\n'));
}
fs.writeFileSync(`${OUT}/low7-report.txt`, out.join('\n\n'));
console.log('done');
