/**
 * 축 ALT-3: BTC 하락 국면의 상대강도 — BTC 대비 덜/더 빠진 대형 알트의 다음 3~7일 (일봉, 시가→종가).
 * 국면(i 종가): dn50 = BTC < SMA50 / dn7 = BTC 7일 ≤ −5% / dnAB = 국면 a 또는 b
 * 점수 = 알트 L일 수익 − BTC L일 수익 (L = 7, 14). 
 *   lag  : 점수 ≤ −thr 인 코인, 가장 많이 덜 오른(더 빠진) 순 → 반전 가설
 *   lead : 점수 ≥ +thr, 가장 강한 순 → 모멘텀 가설
 * 진입 i+1 시가, 시간청산 H (또는 TP), 무스톱, K=3, 유니버스 시점별 알트 상위 N.
 * 크로스섹션 이벤트: 하락국면 날마다 상위 20 알트를 점수 5분위로 → H일 (시가 진입) 수익 − 같은 창 BTC.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const DN: Record<string, (i: number) => boolean> = {
  dn50: (i) => L.REGIME[i] === 'a',
  dn7: (i) => { const r = L.btcRet(i, 7); return r != null && r <= -0.05; },
  dnAB: (i) => L.REGIME[i] === 'a' || L.REGIME[i] === 'b',
};
const SC = new Map<string, L.Sig>();
function sig(dir: string, Lb: number, thr: number): L.Sig {
  const k = `${dir}_${Lb}_${thr}`; if (SC.has(k)) return SC.get(k)!;
  const f = L.memo((m, i) => { const r = L.ret(m, i, Lb), b = L.btcRet(i, Lb); if (r == null || b == null) return null; const s = r - b; if (dir === 'lag') return s <= -thr ? -s : null; return s >= thr ? s : null; });
  SC.set(k, f); return f;
}
const out: string[] = [];
const cells: L.Cell[] = [];
for (const dir of ['lag', 'lead']) for (const dn of Object.keys(DN)) for (const Lb of [7, 14]) for (const thr of [0.05, 0.15]) for (const N of [10, 20]) for (const [tp, H] of [[null, 3], [null, 5], [null, 7], [10, 7]] as [number | null, number][])
  cells.push({ key: `${dir}_${dn}_L${Lb}_t${thr}_N${N}_tp${tp}_H${H}`, params: { dir, dn, Lb, thr, N, tp: tp ?? '-', H }, c: { sig: sig(dir, Lb, thr), N, K: 3, x: { tp, H }, btcOk: DN[dn] } });
const rows = L.runGrid(cells);
fs.writeFileSync(`${OUT}/rs-grid.tsv`, L.gridText(rows, ['dir', 'dn', 'Lb', 'thr', 'N', 'tp', 'H']));
for (const dir of ['lag', 'lead']) for (const dn of Object.keys(DN)) out.push(`${dir} ${dn}: ` + JSON.stringify(L.wf(rows.filter(r => r.dir === dir && r.dn === dn))));
out.push('top by sharpe:\n' + L.gridText([...rows].sort((a, b) => b.sh - a.sh).slice(0, 10), ['dir', 'dn', 'Lb', 'thr', 'N', 'tp', 'H']));
// 크로스섹션 5분위 (시가→종가, BTC 초과)
for (const dn of Object.keys(DN)) for (const Lb of [7, 14]) for (const H of [3, 7]) {
  const q: number[][] = [[], [], [], [], []]; const qc: number[][] = [[], [], [], [], []];
  for (let i = L.TI.get(L.START)!; i < L.TS.length - H - 1; i += H) {   // 겹치지 않게 H일 간격
    if (!DN[dn](i)) continue; const b0 = L.BTC[i + 1], b1 = L.BTC[i + H]; if (!b0 || !b1) continue; const bR = b1.close / b0.open - 1;
    const xs: [string, number][] = [];
    for (const [m, r] of L.ARANK[i]) { if (r >= 20) continue; const a = L.ret(m, i, Lb), b = L.btcRet(i, Lb); const g = L.G.get(m)!; if (a == null || b == null || !g[i + 1] || !g[i + H]) continue; xs.push([m, a - b]); }
    if (xs.length < 10) continue; xs.sort((a, b) => a[1] - b[1]);
    xs.forEach(([m], k) => { const g = L.G.get(m)!; const qi = Math.min(4, Math.floor(5 * k / xs.length)); q[qi].push(g[i + H]!.close / g[i + 1]!.open - 1 - bR); qc[qi].push(g[i + H]!.close / g[i]!.close - 1 - (b1.close / L.BTC[i]!.close - 1)); });
  }
  const mean = (a: number[]) => 100 * a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  out.push(`xsec ${dn} L${Lb} H${H}: Q1(most lagging)→Q5(strongest) open→close excess vs BTC: ${q.map(mean).map(x => x.toFixed(2)).join(' / ')} | close→close: ${qc.map(mean).map(x => x.toFixed(2)).join(' / ')} | n/q ${q[0].length}`);
}
const reps: [string, L.PCfg][] = [
  ['RS lag dnAB L7 t0.15 N20 H5', { sig: sig('lag', 7, 0.15), N: 20, K: 3, x: { tp: null, H: 5 }, btcOk: DN.dnAB }],
  ['RS lead dnAB L7 t0.15 N20 H5', { sig: sig('lead', 7, 0.15), N: 20, K: 3, x: { tp: null, H: 5 }, btcOk: DN.dnAB }],
];
for (const [nm, c] of reps) out.push(L.fullReport(nm, c, { seeds: 30 }).L.join('\n'));
fs.writeFileSync(`${OUT}/rs-report.txt`, out.join('\n\n'));
console.log('done');
