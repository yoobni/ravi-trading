/**
 * 축 ALT-3 최종 점검: 롤링 워크포워드, 이웃칸 중앙, K·N·L·thr 민감도, 잭나이프, 함대 합성 효과.
 * 규칙(RS_LAG): i 종가에 BTC 7일 수익 ≤ −5% 이면, 시점별 알트 거래대금 상위 20 중 (14일 수익 − BTC 14일 수익) ≤ −15% 인 코인을
 *   덜 오른 순으로 → i+1 시가 시장가 매수(빈 슬롯만, K=3, 슬롯당 평가액×size), TP +10% 지정가(관통 0.2%), 7일째 종가 청산, 무스톱.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const dn7 = (k: number) => (i: number) => { const r = L.btcRet(i, 7); return r != null && r <= -k; };
const SC = new Map<string, L.Sig>();
const lag = (Lb: number, thr: number) => { const key = `${Lb}_${thr}`; if (!SC.has(key)) SC.set(key, L.memo((m, i) => { const r = L.ret(m, i, Lb), b = L.btcRet(i, Lb); if (r == null || b == null) return null; const s = r - b; return s <= -thr ? -s : null; })); return SC.get(key)!; };
const cfg = (o: Partial<{ Lb: number; thr: number; N: number; K: number; tp: number; H: number; k: number }> = {}): L.PCfg => { const p = { Lb: 14, thr: 0.15, N: 20, K: 3, tp: 10, H: 7, k: 0.05, ...o }; return { sig: lag(p.Lb, p.thr), N: p.N, K: p.K, x: { tp: p.tp, H: p.H }, btcOk: dn7(p.k) }; };
const out: string[] = [];
// 1) 민감도 (eq17 동일위험)
const sens: [string, Partial<any>][] = [['base', {}], ['K2', { K: 2 }], ['K5', { K: 5 }], ['N10', { N: 10 }], ['N30', { N: 30 }], ['N50', { N: 50 }], ['L7', { Lb: 7 }], ['L21', { Lb: 21 }], ['thr0.10', { thr: 0.10 }], ['thr0.20', { thr: 0.20 }], ['thr0.25', { thr: 0.25 }], ['btc−3%', { k: 0.03 }], ['btc−8%', { k: 0.08 }], ['tp6', { tp: 6 }], ['tp15', { tp: 15 }], ['H3', { H: 3 }], ['H14', { H: 14 }]];
out.push('sensitivity (eq17): name | ret MDD sh n | from2022-07 ret(same size) | OOS2023~');
for (const [nm, o] of sens) { const c = cfg(o); const sz = L.sizeFor(c, 17, L.START); const r = L.port(c, sz, L.START); out.push(`${nm.padEnd(8)} | ${L.f0(r.ret)}% ${r.mdd.toFixed(0)} ${r.sharpe.toFixed(2)} ${r.n} | ${L.f0(L.port(c, sz, Date.UTC(2022, 6, 1)).ret)}% | ${L.f0(L.port(c, sz, L.SPLIT).ret)}% (size ${(sz * 100).toFixed(0)}%)`); }
// 2) 이웃칸 중앙 (tp 8/10/12 × H 5/7/10 × btc 4/5/7%, L14 thr .15): 고정 1/3 과 eq17
const nb: number[] = [], nbS: number[] = [];
for (const tp of [8, 10, 12]) for (const H of [5, 7, 10]) for (const k of [0.04, 0.05, 0.07]) { const c = cfg({ tp, H, k }); nb.push(L.port(c, 1 / 3, L.START).ret); nbS.push(L.port(c, L.sizeFor(c, 17, L.START), L.START).ret); }
out.push(`neighbors 27: fixed33 median ${L.median(nb).toFixed(0)}% min ${Math.min(...nb).toFixed(0)}% | eq17 median ${L.median(nbS).toFixed(0)}% min ${Math.min(...nbS).toFixed(0)}%`);
// 3) 롤링 워크포워드: 연도 Y 를 Y 이전 전체(2019~) 에서 샤프 최고 칸으로 거래
const grid: Partial<any>[] = []; for (const Lb of [7, 14]) for (const thr of [0.05, 0.10, 0.15, 0.20]) for (const tp of [6, 10, 15]) for (const H of [3, 7]) for (const k of [0.04, 0.05, 0.07]) grid.push({ Lb, thr, tp, H, k });
let wfEq = 1; const wfRows: string[] = [];
for (const Y of [2021, 2022, 2023, 2024, 2025, 2026]) {
  const a = L.START, b = Date.UTC(Y, 0, 1), e = Date.UTC(Y + 1, 0, 1);
  let best: any = null, bs = -Infinity; for (const g of grid) { const s = L.port(cfg(g), 1 / 3, a, b).sharpe; if (s > bs) { bs = s; best = g; } }
  const allY = grid.map(g => L.port(cfg(g), 1 / 3, b, e).ret);
  const r = L.port(cfg(best), 1 / 3, b, e).ret; wfEq *= 1 + r / 100;
  wfRows.push(`${Y}: IS-best ${JSON.stringify(best)} (IS sh ${bs.toFixed(2)}) → ${L.f1(r)}% | grid median that year ${L.median(allY).toFixed(1)}% (${(100 * allY.filter(x => x > 0).length / allY.length).toFixed(0)}% cells >0)`);
}
out.push('rolling WF (fixed 33%×3):\n' + wfRows.join('\n') + `\nchained OOS 2021~2026: ${L.f0(100 * (wfEq - 1))}%`);
// 4) 잭나이프 (기여 상위 신호일 제거)
const base = cfg(); const sz = L.sizeFor(base, 17, L.START);
const ev = L.events(base.sig, 20, base.x, { from: L.START, btcOk: base.btcOk }); const byDay = new Map<number, number>(); for (const e of ev) byDay.set(e.i, (byDay.get(e.i) ?? 0) + e.rExec);
const ranked = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
for (const k of [10, 20, 40]) { const drop = new Set(ranked.slice(0, k).map(([i]) => i)); const r = L.port({ ...base, sig: (m, i) => drop.has(i) ? null : base.sig(m, i) }, sz, L.START); out.push(`jackknife drop top${k} of ${byDay.size} signal days: ret ${L.f0(r.ret)}% MDD ${r.mdd.toFixed(0)}%`); }
// 5) 함대 합성: 공통창(2024-11-22~2026-09-30) 함대 7개 균등 vs 함대 + RS_LAG(8등분)
const r0 = L.port(base, sz, L.START);
const FL: Record<string, [number, number][]> = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8'));
const maps = L.FLEET_KEYS.map(k => new Map(FL[k])); const mine = new Map<number, number>(); L.TS.forEach((t, i) => { if (!Number.isNaN(r0.daily[i])) mine.set(t, r0.daily[i]); });
const f7: number[] = [], f8: number[] = [];
for (let t = Date.UTC(2024, 10, 22); t <= Date.UTC(2026, 8, 30); t += L.DAY) { if (!maps.every(m => m.has(t)) || !mine.has(t)) continue; const s = maps.reduce((a, m) => a + m.get(t)!, 0); f7.push(s / 7); f8.push((s + mine.get(t)!) / 8); }
const st = (a: number[]) => { let e = 1, pk = 1, dd = 0; for (const x of a) { e *= 1 + x; pk = Math.max(pk, e); dd = Math.max(dd, 1 - e / pk); } const mu = a.reduce((s, x) => s + x, 0) / a.length, sd = Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length); return `ret ${L.f1(100 * (e - 1))}% MDD ${(100 * dd).toFixed(1)}% Sh ${(mu / sd * Math.sqrt(365)).toFixed(2)}`; };
out.push(`fleet common window (${f7.length}d): fleet7 equal ${st(f7)} | fleet7+RS_LAG(eq17 series) 1/8 each ${st(f8)} | RS_LAG alone same window ${st(f7.map((_, k) => 0).length ? [...mine.entries()].filter(([t]) => t >= Date.UTC(2024, 10, 22) && t <= Date.UTC(2026, 8, 30)).map(([, r]) => r) : [])}`);
// 일수익 저장
fs.writeFileSync(`${OUT}/rs-lag-daily-eq17.json`, JSON.stringify({ RS_LAG: L.TS.map((t, i) => [t, r0.daily[i]]).filter(([, r]) => !Number.isNaN(r as number)), size: sz }));
// 최근 거래 목록(2026)
const tr = ev.filter(e => e.ts >= Date.UTC(2026, 0, 1)).map(e => `${new Date(e.ts).toISOString().slice(0, 10)} ${e.m} r${e.rank + 1} ${(e.rExec * 100).toFixed(1)}% ${e.kind}`);
out.push('2026 events (top20, no slot limit): ' + tr.join(' | '));
fs.writeFileSync(`${OUT}/rs3-report.txt`, out.join('\n'));
console.log('done');
