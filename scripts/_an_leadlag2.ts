/** 축 A ② — 괴리 꼬리의 크기(bp)와 업비트 자체 반전 통제, 바이낸스 자기 미래 수익 대조 */
import { up, bn } from './_an_leadlag';
const COINS = [...bn.keys()]; const M = 60_000;
const SPREAD: Record<string, number> = require('../data/research-spread-p50.json');
const allT = [...up.get('BTC')!.keys()].sort((a, b) => a - b); const half = allT[Math.floor(allT.length / 2)];
for (const L of [0, 1]) {
  const k = 3;
  console.log(`\n── k=${k}분 괴리, 체결지연 L=${L}분 — 괴리 분위별 업비트 향후 mid 수익(bp), 왕복비용 = 10 + 스프레드p50(bp) ──`);
  for (const h of [2, 5, 10, 30]) {
    const rows: { g: number; xu: number; y: number; yb: number; cost: number; s: number }[] = [];
    for (const c of COINS) {
      const u = up.get('KRW-' + c) ?? up.get(c), b = bn.get(c)!; if (!u) continue;
      for (const [t, v] of u) {
        const u0 = u.get(t - k * M), b0 = b.get(t - k * M), bt = b.get(t), ua = u.get(t + L * M), ub = u.get(t + (L + h) * M), bh = b.get(t + h * M);
        if (!u0 || !b0 || !bt || !ua || !ub || !bh) continue;
        rows.push({ g: (bt / b0 - 1) - (v.mid / u0.mid - 1), xu: v.mid / u0.mid - 1, y: 1e4 * (ub.mid / ua.mid - 1), yb: 1e4 * (bh / bt - 1), cost: 10 + (SPREAD['KRW-' + c] ?? 20), s: t < half ? 0 : 1 });
      }
    }
    rows.sort((a, b) => a.g - b.g);
    const n = rows.length; const q = (lo: number, hi: number) => rows.slice(Math.floor(lo * n), Math.floor(hi * n));
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
    const top = (p: number) => { const r = q(1 - p, 1); return `${mean(r.map(x => x.y)).toFixed(1)}bp(전${mean(r.filter(x => !x.s).map(x => x.y)).toFixed(1)}/후${mean(r.filter(x => x.s).map(x => x.y)).toFixed(1)}) 비용${mean(r.map(x => x.cost)).toFixed(0)} 괴리≥${(1e4 * r[0].g).toFixed(0)}bp`; };
    console.log(`  h=${String(h).padStart(2)}  하위10% ${mean(q(0, .1).map(x => x.y)).toFixed(1)}bp · 상위10% ${mean(q(.9, 1).map(x => x.y)).toFixed(1)}bp · 상위1% ${top(.01)} · 상위0.1% ${top(.001)}`);
  }
}
// 업비트 자체 반전 통제: 업비트가 움직이지 않았는데(|xu|<5bp) 바이낸스만 움직인 경우
console.log('\n── 통제: 업비트 3분 수익 |xu|<5bp 인 경우만 — 바이낸스 3분 수익 분위별 업비트 향후 5분(bp), L=0/1 ──');
for (const L of [0, 1]) {
  const rows: { xb: number; y: number }[] = [];
  for (const c of COINS) { const u = up.get(c)!, b = bn.get(c)!; if (!u) continue;
    for (const [t, v] of u) { const u0 = u.get(t - 3 * M), b0 = b.get(t - 3 * M), bt = b.get(t), ua = u.get(t + L * M), ub = u.get(t + (L + 5) * M);
      if (!u0 || !b0 || !bt || !ua || !ub) continue; if (Math.abs(v.mid / u0.mid - 1) > 5e-4) continue; rows.push({ xb: bt / b0 - 1, y: 1e4 * (ub.mid / ua.mid - 1) }); } }
  rows.sort((a, b) => a.xb - b.xb); const n = rows.length; const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`  L=${L} n=${n}  ` + [[0, .01], [.01, .1], [.45, .55], [.9, .99], [.99, 1], [.999, 1]].map(([a, b]) => { const r = rows.slice(Math.floor(a * n), Math.floor(b * n)); return `[${a}-${b}] xb${(1e4 * mean(r.map(x => x.xb))).toFixed(0)}→${mean(r.map(x => x.y)).toFixed(1)}`; }).join('  '));
}
