/**
 * mr 축 — 신호별·연도별 원시 드리프트(시가→k일 종가, 절대값과 같은 연도·국면 무조건 대비 초과). 시간 안정성 확인용.
 * 실행: npx tsx scripts/_bt_dip_mr_year.ts > data/research-ext/dip-2026-10/mr/drift_year.txt
 */
import { DB, DE, FB, FE, RG, idxAtOrAfter } from './_bt_dip_mr_lib';
import { signals, PERIODS } from './_bt_dip_mr_grid';
const TS = DB.map(b => b.ts); const E = TS.length - 1;
const f = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(1);
for (const k of [1, 3, 5]) for (const [asset, b, Fx] of [['BTC', DB, FB], ['ETH', DE, FE]] as const) {
  console.log(`\n══ ${asset} k=${k}일 — 연도별 '신호 평균(절대) [초과]' (n) ══`);
  console.log('신호      국면  ' + PERIODS.map(p => p[0].padStart(16)).join(''));
  const regs: Array<[string, (i: number) => boolean]> = [['all', () => true], ['a|b', i => !!RG.below[i] || !!RG.side[i]], ['volH', i => Fx.volPct[i] >= 2 / 3]];
  const fwd = (i: number) => b[i + k].close / b[i + 1].open - 1;
  for (const [sn, sig] of signals(Fx)) {
    if (!/^(RSI2<5|RSI2<10|RSI3<20|BB2|BB2\.5|NL5|DN4|DD15)$/.test(sn)) continue;
    for (const [rn, rf] of regs) {
      const cells = PERIODS.map(([, a, z]) => {
        const i0 = Math.max(idxAtOrAfter(TS, a), 55), i1 = Math.min(idxAtOrAfter(TS, z), E - k);
        let s = 0, n = 0, bs = 0, bn = 0; for (let i = i0; i < i1; i++) { if (!rf(i)) continue; bs += fwd(i); bn++; if (sig[i]) { s += fwd(i); n++; } }
        return n ? `${f(s / n)}[${f(s / n - bs / bn)}](${n})` : '-';
      });
      console.log(`${sn.padEnd(9)} ${rn.padEnd(5)} ` + cells.map(c => c.padStart(16)).join(''));
    }
  }
}
