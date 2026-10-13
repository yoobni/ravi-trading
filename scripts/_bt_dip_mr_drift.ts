/**
 * mr 축 — 원시 드리프트 진단 (청산·사이징 없이): 신호 다음 봉 시가 → k봉 뒤 종가 평균, 같은 국면의 무조건 평균 대비 초과분.
 * "시가→종가(실행 가능)" 와 "종가→종가" 를 분리(차이 = 호가 튐·종가 체결 불가 성분).
 * 실행: npx tsx scripts/_bt_dip_mr_drift.ts > data/research-ext/dip-2026-10/mr/drift.txt
 */
import { DB, DE, FB, FE, RG, idxAtOrAfter } from './_bt_dip_mr_lib';
import { signals } from './_bt_dip_mr_grid';

const TS = DB.map(b => b.ts);
const S = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), E = TS.length - 1, SPLIT = idxAtOrAfter(TS, Date.UTC(2023, 0, 1));
const KS = [1, 3, 5, 10];
const f = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2);
for (const [asset, b, Fx] of [['BTC', DB, FB], ['ETH', DE, FE]] as const) {
  console.log(`\n════ ${asset} — 신호 후 원시 드리프트 (%, 시가→k일 종가, 같은 국면 무조건 평균 차감 = 초과) ════`);
  const regs: Array<[string, (i: number) => boolean]> = [['all', () => true], ['a', i => !!RG.below[i]], ['b', i => !!RG.side[i]], ['c', i => !RG.below[i] && !RG.side[i]], ['volH', i => Fx.volPct[i] >= 2 / 3]];
  const fwdO = (i: number, k: number) => b[i + k].close / b[i + 1].open - 1, fwdC = (i: number, k: number) => b[i + k].close / b[i].close - 1;
  const base: Record<string, number[]> = {};
  for (const [rn, rf] of regs) base[rn] = KS.map(k => { let s = 0, n = 0; for (let i = S; i + k <= E; i++) if (rf(i)) { s += fwdO(i, k); n++; } return s / n; });
  console.log('기준(무조건) ' + regs.map(([rn]) => `${rn}: ${base[rn].map(f).join('/')}`).join(' | '));
  console.log('신호      국면  n   초과(시가→)k=1/3/5/10            종가→종가 k=3 초과  | IS(~22) k5초과  OOS(23~) k5초과  k5 승률');
  for (const [sn, sig] of signals(Fx)) {
    if (!/RSI2<10|RSI3<20|BB2$|NL5|DN4|DD10|DD15|RSI2<5|BB2.5|DN5/.test(sn)) continue;
    for (const [rn, rf] of regs) {
      const idx: number[] = []; for (let i = S; i + 10 <= E; i++) if (sig[i] && rf(i)) idx.push(i);
      if (idx.length < 8) continue;
      const ex = KS.map((k, j) => idx.reduce((a, i) => a + fwdO(i, k), 0) / idx.length - base[rn][j]);
      const exC3 = idx.reduce((a, i) => a + fwdC(i, 3), 0) / idx.length - base[rn][1];
      const isI = idx.filter(i => i < SPLIT), ooI = idx.filter(i => i >= SPLIT);
      const k5 = (arr: number[]) => arr.length ? f(arr.reduce((a, i) => a + fwdO(i, 5), 0) / arr.length - base[rn][2]) + `(${arr.length})` : '-';
      const win = 100 * idx.filter(i => fwdO(i, 5) > 0).length / idx.length;
      console.log(`${sn.padEnd(9)} ${rn.padEnd(5)}${String(idx.length).padStart(4)}  ${ex.map(f).join(' / ').padEnd(30)}  ${f(exC3).padStart(7)}             | ${k5(isI).padStart(12)}  ${k5(ooI).padStart(12)}  ${win.toFixed(0)}%`);
    }
  }
}
