/** 축 A ④ — F7 주문 타이밍 보조: 4h 봉마감(UTC 4h 경계) 시점의 괴리로 시장가 주문을 몇 분 미루면 이득인가 */
import { up, bn } from './_an_leadlag';
const M = 60_000, FOUR = 4 * 3600_000; const COINS = [...bn.keys()];
const rows: { g: number; d: Record<number, number>; spr: number[] }[] = [];
for (const c of COINS) { const u = up.get(c)!, b = bn.get(c)!; if (!u) continue;
  for (const [t, v] of u) { if (t % FOUR !== 0) continue;
    const u0 = u.get(t - 3 * M), b0 = b.get(t - 3 * M), bt = b.get(t); if (!u0 || !b0 || !bt) continue;
    const d: Record<number, number> = {}; const spr: number[] = [];
    for (const w of [1, 3, 5, 10, 15]) { const s = u.get(t + w * M); if (s) { d[w] = 1e4 * (s.mid / v.mid - 1); spr[w] = s.spr; } }
    rows.push({ g: 1e4 * ((bt / b0 - 1) - (v.mid / u0.mid - 1)), d, spr }); } }
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
console.log(`4h 봉마감 시점 ${rows.length}건 — 괴리 구간별, 지금 대신 w분 뒤 체결했을 때 mid 변화(bp; 매수면 +가 손해, 매도면 +가 이득)`);
for (const [lab, f] of [['괴리 ≤ −20bp', (g: number) => g <= -20], ['−20~−5', (g: number) => g > -20 && g <= -5], ['−5~+5', (g: number) => Math.abs(g) < 5], ['+5~+20', (g: number) => g >= 5 && g < 20], ['≥ +20bp', (g: number) => g >= 20]] as Array<[string, (g: number) => boolean]>) {
  const r = rows.filter(x => f(x.g));
  console.log(`  ${lab.padEnd(12)} ${String(r.length).padStart(5)}건  ` + [1, 3, 5, 10, 15].map(w => `${w}분 ${mean(r.filter(x => x.d[w] != null).map(x => x.d[w])).toFixed(1)}`).join('  '));
}
