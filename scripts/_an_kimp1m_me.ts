/** 축 A ⑦ — 1분 해상도로 본 월말 UTC16 봉(2026-08-31, 2026-09-30): 바이낸스가 튀었나, 업비트가 체결 가능한 시점부터 따라갔나 */
import { up, bn } from './_an_leadlag';
const M = 60_000, H = 3600e3;
for (const d of ['2026-08-31', '2026-09-30']) {
  const t0 = Date.parse(d + 'T16:00:00Z'), t1 = t0 + 4 * H;
  const rows: string[] = []; const ok: number[][] = [];
  for (const c of [...bn.keys()]) {
    const u = up.get(c)!, b = bn.get(c)!;
    const b0 = b.get(t0), b1 = b.get(t1), u0 = u?.get(t0), u1 = u?.get(t1), ue = u?.get(t1 + 1 * M), uf = u?.get(t1 + 4 * H), bf = b.get(t1 + 4 * H);
    if (!b0 || !b1 || !u0 || !u1) { rows.push(`${c}:결손`); continue; }
    const rB = b1 / b0 - 1, rU = u1.mid / u0.mid - 1;
    ok.push([rB - rU, ue && uf ? uf.mid / ue.mid - 1 : NaN, bf ? bf / b1 - 1 : NaN]);
    if (rB - rU >= 0.015) rows.push(`${c} 괴리${(100 * (rB - rU)).toFixed(1)}% → 업비트(+1분→+4h) ${ue && uf ? (100 * (uf.mid / ue.mid - 1)).toFixed(2) : '?'}% 바이낸스 ${bf ? (100 * (bf / b1 - 1)).toFixed(2) : '?'}%`);
  }
  const big = ok.filter(x => x[0] >= 0.015);
  console.log(`${d} UTC16~20 봉: 집계 ${ok.length}코인, 괴리≥1.5% ${big.length}코인, 괴리 최대 ${(100 * Math.max(...ok.map(x => x[0]))).toFixed(2)}%`);
  for (const r of rows.filter(r => !r.includes('결손'))) console.log('   ' + r);
  const miss = rows.filter(r => r.includes('결손')); if (miss.length) console.log('   결손: ' + miss.join(' '));
}
