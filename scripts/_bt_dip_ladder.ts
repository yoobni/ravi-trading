/**
 * 저점 흡수 확장 — BTC 15m (2021-04~2026-10-02) 실험. 엔진은 _bt_dip_ladder_lib.ts.
 * 모드: base | ladder | tf | regime | slots | wf | robust <id>
 * 출력은 파일로 리다이렉트: npx tsx scripts/_bt_dip_ladder.ts ladder > data/research-ext/dip-2026-10/ladder/ladder.log
 */
import fs from 'fs';
import path from 'path';
import { loadBtc15, sim, toDaily, win, metrics, eqMdd, tradeStats, byRegime, byPeriod, fleetCheck, P, median, H, DAY, Q, OUTDIR, type Cfg, type Series } from './_bt_dip_ladder_lib';

const B15 = loadBtc15();
const T0 = Date.UTC(2021, 3, 1), T1 = B15[B15.length - 1].ts + Q;
const FOUR = 4 * H;
const MODE = process.argv[2] || 'base';
const BASE: Cfg = { tf: FOUR, rungs: [3], y: 3, T: 72, pen: 0.002, from: T0 };

export function run(c: Partial<Cfg>, bars = B15, barMs = Q) { const cfg = { ...BASE, ...c } as Cfg; const r = sim(bars, barMs, cfg); return { cfg, r, d: toDaily(r.eqAt) }; }
function row(lab: string, x: ReturnType<typeof run>, a = T0, b = T1) {
  const rs = win(x.d, a, b); const m = metrics(rs), e = eqMdd(rs), ts = tradeStats(x.r.trades, a, b), rg = byRegime(rs);
  return `${lab.padEnd(34)} 총익 ${P(m.tot).padStart(6)} CAGR ${P(m.cagr, 1).padStart(6)} MDD ${m.mdd.toFixed(1).padStart(5)}% 샤프 ${m.sharpe.toFixed(2).padStart(5)} MDD17 ${P(e.tot).padStart(6)} | 거래/연 ${ts.perYr.toFixed(1).padStart(5)} 승률 ${ts.wr.toFixed(0)}% 평균 ${ts.avg.toFixed(2)}% 최악 ${ts.worst.toFixed(1)}% 가동 ${(100 * x.r.expo).toFixed(0)}% | a ${rg.a.mean.toFixed(1)}bp/${P(rg.a.cum)} b ${rg.b.mean.toFixed(1)}bp/${P(rg.b.cum)} c ${rg.c.mean.toFixed(1)}bp/${P(rg.c.cum)}`;
}
const save = (name: string, obj: any) => fs.writeFileSync(path.join(OUTDIR, name), JSON.stringify(obj, null, 1));

if (MODE === 'base') {
  // 재현: dipSim(pen 0.2%) 의 일수익과 비교
  const x = run({});
  const F = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8')).BTC_DIP as [number, number][];
  let e = 1; for (const [, r] of F) e *= 1 + r;
  console.log('daily-series BTC_DIP 누적', P(100 * (e - 1)), 'days', F.length);
  console.log(row('엔진 재현 4h −3/+3/72h 관통0.2%', x));
  const diffs = F.map(([t, r]) => Math.abs((x.d.get(t) ?? 0) - r)); console.log('일수익 차이 최대', Math.max(...diffs).toExponential(2), '평균', (diffs.reduce((a, b) => a + b, 0) / diffs.length).toExponential(2));
  console.log(row('관통 0.05%', run({ pen: 0.0005 })));
  for (const [lab, a, b] of [['IS 2021-04~2023', T0, Date.UTC(2024, 0, 1)], ['2024~', Date.UTC(2024, 0, 1), T1], ['2024-10~2025-09', Date.UTC(2024, 9, 1), Date.UTC(2025, 9, 1)], ['2025-10~', Date.UTC(2025, 9, 1), T1]] as const)
    console.log(row('  ' + lab, x, a, b));
  console.log('기간', byPeriod(x.d).map(([l, v]) => `${l} ${P(v)}`).join(' · '));
}

// ════════════════ 격자 공통 ════════════════
const S1 = Date.UTC(2024, 0, 1), W2a = Date.UTC(2024, 9, 1), W2b = Date.UTC(2025, 9, 1);
export function cell(lab: string, c: Partial<Cfg>, bars = B15, barMs = Q, a0 = T0) {
  const x = run({ ...c, from: a0 }, bars, barMs); const rs = win(x.d, a0, T1);
  const m = metrics(rs), e = eqMdd(rs), ts = tradeStats(x.r.trades, a0, T1), rg = byRegime(rs);
  const sub = (a: number, b: number) => { const r = win(x.d, a, b); const mm = metrics(r); return { tot: mm.tot, sh: mm.sharpe, mdd: mm.mdd }; };
  return { lab, c, tot: m.tot, cagr: m.cagr, mdd: m.mdd, sh: m.sharpe, e17: e.tot, n: ts.n, perYr: ts.perYr, wr: ts.wr, avg: ts.avg, worst: ts.worst, expo: 100 * x.r.expo,
    ra: rg.a.mean, rb: rg.b.mean, rc: rg.c.mean, ca: rg.a.cum, cb: rg.b.cum, cc: rg.c.cum,
    raIS: byRegime(win(x.d, a0, S1)).a.mean, raOOS: byRegime(win(x.d, S1, T1)).a.mean, rbIS: byRegime(win(x.d, a0, S1)).b.mean, rbOOS: byRegime(win(x.d, S1, T1)).b.mean,
    is1: sub(a0, S1), oos1: sub(S1, T1), is2: sub(W2a, W2b), oos2: sub(W2b, T1), x };
}
type Cell = ReturnType<typeof cell>;
const fmt = (r: Cell) => `${r.lab.padEnd(40)} 총익 ${P(r.tot).padStart(6)} MDD ${r.mdd.toFixed(1).padStart(5)} 샤프 ${r.sh.toFixed(2).padStart(5)} MDD17 ${P(r.e17).padStart(6)} 거래/연 ${r.perYr.toFixed(0).padStart(3)} 승 ${r.wr.toFixed(0)}% 평균 ${r.avg.toFixed(2)}% 최악 ${r.worst.toFixed(1)}% 가동 ${r.expo.toFixed(0)}% | a ${r.ra.toFixed(1)} b ${r.rb.toFixed(1)} c ${r.rc.toFixed(1)}bp | IS21-23 ${r.is1.sh.toFixed(2)} OOS24~ ${r.oos1.sh.toFixed(2)} | IS2 ${r.is2.sh.toFixed(2)} OOS2 ${r.oos2.sh.toFixed(2)}`;
const strip = (r: Cell) => { const { x, ...o } = r; return o; };
/** 2차원 격자의 이웃(±1) 중앙값 */
function nbMed<T>(grid: T[][], i: number, j: number, f: (t: T) => number) { const v: number[] = []; for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) if (grid[a]?.[b] !== undefined) v.push(f(grid[a][b])); return median(v); }

const YS = [2, 3, 4, 5], TS = [24, 48, 72, 120];
function yTgrid(lab: string, c: Partial<Cfg>, bars = B15, barMs = Q, a0 = T0) {
  const g: Cell[][] = YS.map(y => TS.map(T => cell(`${lab} y${y} T${T}`, { ...c, y, T }, bars, barMs, a0)));
  const all = g.flat();
  const sh = all.map(r => r.sh), e17 = all.map(r => r.e17);
  // 중앙칸(y3 T72) 이웃 중앙
  const ci = YS.indexOf(3), cj = TS.indexOf(72);
  return { lab, g, medSh: median(sh), medE17: median(e17), medTot: median(all.map(r => r.tot)), medA: median(all.map(r => r.ra)), medB: median(all.map(r => r.rb)), medC: median(all.map(r => r.rc)),
    medOos1: median(all.map(r => r.oos1.sh)), medIs1: median(all.map(r => r.is1.sh)), medOos2: median(all.map(r => r.oos2.sh)), medPerYr: median(all.map(r => r.perYr)), medExpo: median(all.map(r => r.expo)),
    center: g[ci][cj], centerNb: { sh: nbMed(g, ci, cj, r => r.sh), e17: nbMed(g, ci, cj, r => r.e17), tot: nbMed(g, ci, cj, r => r.tot) },
    best: all.reduce((a, b) => (b.sh > a.sh ? b : a)) };
}
const famLine = (f: ReturnType<typeof yTgrid>) => `${f.lab.padEnd(26)} 16칸 중앙: 샤프 ${f.medSh.toFixed(2)} MDD17 ${P(f.medE17)} 총익 ${P(f.medTot)} 거래/연 ${f.medPerYr.toFixed(0)} 가동 ${f.medExpo.toFixed(0)}% | 국면bp a ${f.medA.toFixed(1)} b ${f.medB.toFixed(1)} c ${f.medC.toFixed(1)} | 샤프 IS21-23 ${f.medIs1.toFixed(2)} OOS24~ ${f.medOos1.toFixed(2)} OOS2(25-10~) ${f.medOos2.toFixed(2)} | 중심 y3T72 이웃중앙 샤프 ${f.centerNb.sh.toFixed(2)} MDD17 ${P(f.centerNb.e17)} | 최고칸 ${f.best.lab.split(' ').slice(-2).join('')} 샤프 ${f.best.sh.toFixed(2)}`;

if (MODE === 'ladder') {
  const sets: Array<[string, number[], number[]?]> = [
    ['단일 −3', [3]], ['단일 −2', [2]], ['단일 −4', [4]],
    ['−2/−4', [2, 4]], ['−3/−6', [3, 6]], ['−2/−4/−6', [2, 4, 6]], ['−3/−6/−9', [3, 6, 9]], ['−1.5/−3/−4.5', [1.5, 3, 4.5]],
    ['−2/−3/−4', [2, 3, 4]], ['−2.5/−5/−7.5', [2.5, 5, 7.5]], ['0/−3/−6', [0, 3, 6]], ['−2/−4/−6 뒤가중1:2:3', [2, 4, 6], [1 / 6, 2 / 6, 3 / 6]], ['−3/−6/−9 뒤가중1:2:3', [3, 6, 9], [1 / 6, 2 / 6, 3 / 6]],
  ];
  const out: any[] = [];
  for (const [lab, rungs, wts] of sets) {
    const f = yTgrid(lab, { rungs, wts }); console.log(famLine(f));
    out.push({ lab, medSh: f.medSh, medE17: f.medE17, medTot: f.medTot, medA: f.medA, medB: f.medB, medC: f.medC, medOos1: f.medOos1, medOos2: f.medOos2, centerNb: f.centerNb, cells: f.g.flat().map(strip) });
  }
  console.log('\n── 중심칸(y3 T72) 상세 ──');
  for (const o of out) { const r = o.cells.find((c: any) => c.c.y === 3 && c.c.T === 72); console.log(fmt(r)); }
  save('ladder.json', out);
}

if (MODE === 'tf') {
  const out: any[] = [];
  const grids: Array<[string, number, number[]]> = [['1h', H, [1, 1.5, 2, 3]], ['4h', FOUR, [2, 3, 4, 5]], ['1d', DAY, [3, 4, 5, 6, 8]]];
  for (const [tl, tf, xs] of grids) for (const x of xs) { const f = yTgrid(`${tl} 종가 −${x}`, { tf, rungs: [x] }); console.log(famLine(f)); out.push({ lab: f.lab, medSh: f.medSh, medE17: f.medE17, medTot: f.medTot, medA: f.medA, medB: f.medB, medC: f.medC, medIs1: f.medIs1, medOos1: f.medOos1, medOos2: f.medOos2, medPerYr: f.medPerYr, cells: f.g.flat().map(strip) }); }
  console.log('\n── 고점 대비 하락(drawdown-from-high) ──');
  const hg: Array<[string, number, number, number[]]> = [['4h·1일고점', FOUR, 6, [3, 4, 5, 6]], ['4h·3일고점', FOUR, 18, [4, 6, 8, 10]], ['4h·7일고점', FOUR, 42, [5, 7, 9, 12]], ['1d·7일고점', DAY, 7, [5, 7, 9, 12]], ['1d·14일고점', DAY, 14, [6, 9, 12, 15]], ['1d·30일고점', DAY, 30, [8, 12, 16, 20]]];
  for (const [tl, tf, n, xs] of hg) for (const x of xs) { const f = yTgrid(`${tl} −${x}`, { tf, ref: 'high', nHigh: n, rungs: [x] }); console.log(famLine(f)); out.push({ lab: f.lab, medSh: f.medSh, medE17: f.medE17, medTot: f.medTot, medA: f.medA, medB: f.medB, medC: f.medC, medIs1: f.medIs1, medOos1: f.medOos1, medOos2: f.medOos2, medPerYr: f.medPerYr, cells: f.g.flat().map(strip) }); }
  console.log('\n── 고점 대비, 이미 아래면 시장가 추격(chase) ──');
  for (const [tl, tf, n, xs] of hg.filter((_, i) => i === 1 || i === 4)) for (const x of xs) { const f = yTgrid(`${tl} −${x} chase`, { tf, ref: 'high', nHigh: n, rungs: [x], chase: true }); console.log(famLine(f)); out.push({ lab: f.lab, medSh: f.medSh, medE17: f.medE17, medTot: f.medTot, medA: f.medA, medB: f.medB, medC: f.medC, medIs1: f.medIs1, medOos1: f.medOos1, medOos2: f.medOos2, medPerYr: f.medPerYr, cells: f.g.flat().map(strip) }); }
  save('tf.json', out);
}

const FAMS: Array<[string, Partial<Cfg>]> = [
  ['4h −3', { rungs: [3] }], ['4h −5', { rungs: [5] }], ['1h −3', { tf: H, rungs: [3] }],
  ['4h −3/−6/−9 1:2:3', { rungs: [3, 6, 9], wts: [1 / 6, 2 / 6, 3 / 6] }], ['4h −3/−6', { rungs: [3, 6] }],
];
const famJson = (f: ReturnType<typeof yTgrid>) => ({ lab: f.lab, medSh: f.medSh, medE17: f.medE17, medTot: f.medTot, medA: f.medA, medB: f.medB, medC: f.medC, medIs1: f.medIs1, medOos1: f.medOos1, medOos2: f.medOos2, medPerYr: f.medPerYr, centerNb: f.centerNb, cells: f.g.flat().map(strip) });

if (MODE === 'regime') {
  const out: any[] = [];
  const vars: Array<[string, Partial<Cfg>]> = [
    ['항상', {}], ['BTC<SMA50 만', { regime: 'below' }], ['BTC>SMA50 만', { regime: 'above' }],
    ['하락시 깊이×1.5', { downMul: 1.5 }], ['하락시 깊이×2', { downMul: 2 }],
    ['하락시 T24', { downT: 24 }], ['하락시 T48', { downT: 48 }], ['하락시 ×1.5+T24', { downMul: 1.5, downT: 24 }],
    ['쿨다운 24h', { cool: 24 }], ['쿨다운 72h', { cool: 72 }],
  ];
  for (const [fl, fc] of FAMS) { console.log(`\n■ ${fl}`); for (const [vl, vc] of vars) { const f = yTgrid(`${fl} · ${vl}`, { ...fc, ...vc }); console.log(famLine(f)); out.push(famJson(f)); } }
  save('regime.json', out);
}

if (MODE === 'slots') {
  // (1) 같은 규칙, 보유 중에도 다음 경계에 새 사다리(최대 K 슬롯, 각 1/K)
  const out: any[] = [];
  for (const [fl, fc] of FAMS.slice(0, 3)) for (const K of [1, 2, 3, 4]) { const f = yTgrid(`${fl} 슬롯${K}`, { ...fc, slots: K }); console.log(famLine(f)); out.push(famJson(f)); }
  save('slots.json', out);
}

export const CANDS: Record<string, Partial<Cfg>> = {
  LIVE: { rungs: [3], y: 3, T: 72 },
  B: { rungs: [3, 6], y: 3, T: 72, downMul: 2 },                                     // 4h −3/−6 균등, BTC<SMA50 이면 −6/−12
  C: { rungs: [3, 6, 9], wts: [1 / 6, 2 / 6, 3 / 6], y: 3, T: 72, downMul: 2 },       // 뒤가중 사다리
  D: { rungs: [5], y: 3, T: 72 },                                                     // 4h −5 단일
};

if (MODE === 'wf') {
  // 지금까지 격자 전부(사다리·국면·TF 단일·슬롯)를 한 풀로: IS 샤프 최고칸의 OOS
  const pool: any[] = [];
  for (const f of ['ladder.json', 'regime.json', 'tf.json', 'slots.json']) for (const fam of JSON.parse(fs.readFileSync(path.join(OUTDIR, f), 'utf8'))) for (const c of fam.cells) pool.push({ fam: fam.lab, ...c });
  console.log('풀 크기', pool.length, '칸');
  for (const crit of ['sh', 'tot'] as const) for (const [isK, oosK, lab0] of [['is1', 'oos1', 'IS 2021-04~2023 → OOS 2024~2026-10'], ['is2', 'oos2', 'IS 2024-10~2025-09 → OOS 2025-10~2026-10']] as const) {
    const lab = lab0 + ` [선택 기준: IS ${crit === 'sh' ? '샤프' : '총익'}]`;
    const s = [...pool].sort((a, b) => b[isK][crit] - a[isK][crit]);
    const oosAll = pool.map(p => p[oosK].sh), oosTot = pool.map(p => p[oosK].tot);
    console.log(`\n■ ${lab}`);
    console.log(`  전체 OOS 샤프 중앙 ${median(oosAll).toFixed(2)} · OOS 총익 중앙 ${P(median(oosTot), 1)} · OOS 양수 비율 ${(100 * oosTot.filter(x => x > 0).length / oosTot.length).toFixed(0)}%`);
    const top = s.slice(0, 10); console.log(`  IS 상위10 OOS 샤프 중앙 ${median(top.map(p => p[oosK].sh)).toFixed(2)} · OOS 총익 중앙 ${P(median(top.map(p => p[oosK].tot)), 1)}`);
    const top50 = s.slice(0, 50); console.log(`  IS 상위50 OOS 샤프 중앙 ${median(top50.map(p => p[oosK].sh)).toFixed(2)} · OOS 총익 중앙 ${P(median(top50.map(p => p[oosK].tot)), 1)}`);
    for (const p of top.slice(0, 5)) console.log(`   ${p.lab.padEnd(44)} IS 샤프 ${p[isK].sh.toFixed(2)} 총익 ${P(p[isK].tot)} → OOS 샤프 ${p[oosK].sh.toFixed(2)} 총익 ${P(p[oosK].tot, 1)} MDD ${p[oosK].mdd.toFixed(1)}%`);
    // IS→OOS 순위 상관(스피어만)
    const rk = (arr: number[]) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
    const ri = rk(pool.map(p => p[isK].sh)), ro = rk(pool.map(p => p[oosK].sh)); const n = pool.length; let d2 = 0; for (let i = 0; i < n; i++) d2 += (ri[i] - ro[i]) ** 2;
    console.log(`  IS↔OOS 순위상관(스피어만) ${(1 - 6 * d2 / (n * (n * n - 1))).toFixed(2)}`);
    // 가족 단위: 가족 IS 중앙 최고 → OOS
    const fams = new Map<string, any[]>(); for (const p of pool) { if (!fams.has(p.fam)) fams.set(p.fam, []); fams.get(p.fam)!.push(p); }
    const fs2 = [...fams].map(([k, v]) => ({ k, is: median(v.map(p => p[isK].sh)), oos: median(v.map(p => p[oosK].sh)), oosT: median(v.map(p => p[oosK].tot)) })).sort((a, b) => b.is - a.is);
    console.log('  가족(16칸 중앙) IS 상위5 →'); for (const f of fs2.slice(0, 5)) console.log(`   ${f.k.padEnd(36)} IS ${f.is.toFixed(2)} → OOS 샤프 ${f.oos.toFixed(2)} 총익 ${P(f.oosT, 1)}`);
    const live = pool.find(p => p.fam === '단일 −3' && p.c.y === 3 && p.c.T === 72);
    console.log(`  (참고) 라이브 BTC_DIP 칸: IS ${live[isK].sh.toFixed(2)} → OOS ${live[oosK].sh.toFixed(2)} 총익 ${P(live[oosK].tot, 1)} · IS 순위 ${s.indexOf(s.find(p => p.lab === live.lab && p.fam === live.fam)) + 1}/${n}`);
  }
}

if (MODE === 'robust') {
  const id = process.argv[3] || 'B'; const base = CANDS[id]; const out: any = { id, cfg: base };
  console.log(`══ 후보 ${id} ${JSON.stringify(base)} ══`);
  const x = run(base); console.log(row('기본(관통 0.2%)', x));
  const rs = win(x.d, T0, T1), m = metrics(rs), e = eqMdd(rs), ts = tradeStats(x.r.trades, T0, T1), rg = byRegime(rs);
  out.base = { ...m, e17: e.tot, f17: e.f, ...ts, expo: x.r.expo, regime: rg };
  console.log('기간', byPeriod(x.d).map(([l, v]) => `${l} ${P(v)}`).join(' · ')); out.periods = byPeriod(x.d);
  console.log('국면(배타)', JSON.stringify(rg));
  const vari: Array<[string, Partial<Cfg>]> = [
    ['비용×2 (수수료 0.1%·슬리피지 0.04%)', { fee: 0.001, slip: 0.0004 }], ['관통 0.5%', { pen: 0.005 }], ['관통 0.05%(낙관)', { pen: 0.0005 }],
    ['주문 지연 15분', { delay: 15 }], ['주문 지연 30분', { delay: 30 }], ['주문 지연 60분', { delay: 60 }],
    ['TP 다음 4h 크론부터', { tpDelay: true }], ['지연 30분 + TP 크론', { delay: 30, tpDelay: true }], ['비용×2+지연30+TP크론+관통0.5', { fee: 0.001, slip: 0.0004, delay: 30, tpDelay: true, pen: 0.005 }],
  ];
  out.vari = {};
  for (const [l, v] of vari) { const xv = run({ ...base, ...v }); console.log(row(l, xv)); const r2 = win(xv.d, T0, T1); out.vari[l] = { ...metrics(r2), e17: eqMdd(r2).tot, periods: byPeriod(xv.d) }; console.log('   기간', byPeriod(xv.d).map(([l2, v2]) => `${l2} ${P(v2)}`).join(' · ')); }
  // 플라시보: 같은 사다리 시작 빈도로 무작위 시점 시작(첫 단 시장가)
  const p = x.r.ladders / Math.max(x.r.eligible, 1); const pl: number[] = [], plSh: number[] = [];
  for (let s = 1; s <= 50; s++) { const xp = run({ ...base, placebo: { p, seed: s * 7919 } }); const r2 = win(xp.d, T0, T1); const mm = metrics(r2); pl.push(mm.tot); plSh.push(mm.sharpe); }
  const beat = pl.filter(v => v >= m.tot).length;
  console.log(`플라시보 50회 (시작확률 ${p.toFixed(3)}/경계): 총익 중앙 ${P(median(pl))} 최대 ${P(Math.max(...pl))} · 샤프 중앙 ${median(plSh).toFixed(2)} 최대 ${Math.max(...plSh).toFixed(2)} · 실제 이상 ${beat}/50`);
  out.placebo = { p, medTot: median(pl), maxTot: Math.max(...pl), medSh: median(plSh), maxSh: Math.max(...plSh), beat };
  // 고원: x1 × downMul × y × T (y,T 는 ±1칸)
  const cellsP: any[] = [];
  const x1s = id === 'D' ? [4, 4.5, 5, 5.5, 6] : [2.5, 3, 3.5];
  const dms = base.downMul ? [1.5, 2, 2.5] : [1];
  for (const x1 of x1s) for (const dm of dms) for (const y of [2, 3, 4]) for (const T of [48, 72, 96]) {
    const rungs = base.rungs!.map(v => v * x1 / base.rungs![0]);
    const xx = run({ ...base, rungs, downMul: base.downMul ? dm : undefined, y, T }); const r2 = win(xx.d, T0, T1); const mm = metrics(r2);
    cellsP.push({ x1, dm, y, T, sh: mm.sharpe, tot: mm.tot, e17: eqMdd(r2).tot, is1: metrics(win(xx.d, T0, S1)).sharpe, oos1: metrics(win(xx.d, S1, T1)).sharpe });
  }
  console.log(`고원 ${cellsP.length}칸 (x1 ${x1s} × 하락배수 ${dms} × y2-4 × T48-96): 샤프 중앙 ${median(cellsP.map(c => c.sh)).toFixed(2)} [최소 ${Math.min(...cellsP.map(c => c.sh)).toFixed(2)}] · MDD17 중앙 ${P(median(cellsP.map(c => c.e17)))} · 총익 중앙 ${P(median(cellsP.map(c => c.tot)))} · IS21-23 샤프 중앙 ${median(cellsP.map(c => c.is1)).toFixed(2)} 양수 ${cellsP.filter(c => c.is1 > 0).length}/${cellsP.length} · OOS24~ 샤프 중앙 ${median(cellsP.map(c => c.oos1)).toFixed(2)}`);
  out.plateau = cellsP;
  // 거래 목록 요약: 최악 10
  const worst = [...x.r.trades].sort((a, b) => a.ret - b.ret).slice(0, 8);
  console.log('최악 거래', worst.map(t => `${new Date(t.te).toISOString().slice(0, 10)} ${(100 * t.ret).toFixed(1)}%(${t.reason},${t.fills}단,투입${(100 * t.used).toFixed(0)}%)`).join(' · '));
  // 연도별 거래
  for (const yv of [2021, 2022, 2023, 2024, 2025, 2026]) { const t = tradeStats(x.r.trades, Date.UTC(yv, 0, 1), Date.UTC(yv + 1, 0, 1)); console.log(`  ${yv}: 거래 ${t.n} 승률 ${t.wr.toFixed(0)}% 평균 ${t.avg.toFixed(2)}% 최악 ${t.worst.toFixed(1)}% TP비율 ${t.tpShare.toFixed(0)}%`); }
  // 함대 보완성
  const fc = fleetCheck(x.d); console.log('함대 보완성', JSON.stringify(Object.fromEntries(Object.entries(fc).map(([k, v]) => [k, typeof v === 'number' && Math.abs(v) < 1e6 ? +v.toFixed(3) : v]))));
  out.fleet = fc;
  save(`robust-${id}.json`, out);
  fs.writeFileSync(path.join(OUTDIR, `daily-${id}.json`), JSON.stringify([...x.d]));
}

if (MODE === 'knife') {
  const out: any[] = [];
  const vars: Array<[string, Partial<Cfg>]> = [
    ['4h −3 기본', { rungs: [3] }],
    ['4h −3 하락(SMA50) 사이즈½', { rungs: [3], downSize: 0.5 }],
    ['4h −3 SMA100 하락 깊이×2', { rungs: [3], downMul: 2, sma: 100 }], ['4h −3 SMA200 하락 깊이×2', { rungs: [3], downMul: 2, sma: 200 }],
    ['4h −3 SMA200 하락 사이즈½', { rungs: [3], downSize: 0.5, sma: 200 }], ['4h −3 SMA200 아래 금지', { rungs: [3], regime: 'above', sma: 200 }],
    ['4h −3/−6 SMA50 ×2 (B)', { rungs: [3, 6], downMul: 2 }], ['4h −3/−6 SMA200 ×2', { rungs: [3, 6], downMul: 2, sma: 200 }], ['4h −3/−6 SMA100 ×2', { rungs: [3, 6], downMul: 2, sma: 100 }],
    ['4h −3/−6 SMA50 ×1.5', { rungs: [3, 6], downMul: 1.5 }], ['4h −3/−6 항상', { rungs: [3, 6] }],
  ];
  for (const [l, v] of vars) {
    const f = yTgrid(l, v); const all = f.g.flat();
    console.log(famLine(f));
    console.log(`     국면a(SMA50 아래) bp: IS21-23 중앙 ${median(all.map(r => r.raIS)).toFixed(1)} / OOS24~ 중앙 ${median(all.map(r => r.raOOS)).toFixed(1)} · 국면b: IS ${median(all.map(r => r.rbIS)).toFixed(1)} / OOS ${median(all.map(r => r.rbOOS)).toFixed(1)} · 중심 y3T72: 총익 ${P(f.center.tot)} MDD ${f.center.mdd.toFixed(1)}% 샤프 ${f.center.sh.toFixed(2)} 2025-10~ ${P(f.center.oos2.tot, 1)}`);
    out.push(famJson(f));
  }
  save('knife.json', out);
}

if (MODE === 'vol') {
  // σ 배수 트리거(자산 간 이식성 점검): BTC 15m 2021-04~, ETH 15m 2024-10~, ETH 4h(관통 0.5%) 2022-07~
  const { loadCache } = require('./_bt_dip_ladder_lib');
  const E15 = loadCache('KRW-ETH', 15), E4 = loadCache('KRW-ETH', 240);
  const out: any[] = [];
  const A2 = Date.UTC(2024, 9, 2), A4 = Date.UTC(2022, 6, 1);
  for (const [l, c] of [['σ×1.5', { rungs: [1.5] }], ['σ×2', { rungs: [2] }], ['σ×2.5', { rungs: [2.5] }], ['σ×3', { rungs: [3] }], ['σ×4', { rungs: [4] }], ['σ×2/×4 하락×2', { rungs: [2, 4], downMul: 2 }], ['σ×2.5/×5 하락×2', { rungs: [2.5, 5], downMul: 2 }], ['σ×3 하락×1.5', { rungs: [3], downMul: 1.5 }]] as Array<[string, Partial<Cfg>]>) {
    const fb = yTgrid(`BTC 15m ${l}`, { ...c, volK: true }); console.log(famLine(fb)); out.push(famJson(fb));
    const fb2 = yTgrid(`BTC 15m ${l} [2024-10~]`, { ...c, volK: true }, B15, Q, A2); console.log(famLine(fb2).replace(/IS21-23 [-0-9.]+ /, ''));
    const fe = yTgrid(`ETH 15m ${l} [2024-10~]`, { ...c, volK: true, slip: 0.0005 }, E15, Q, A2); console.log(famLine(fe).replace(/IS21-23 [-0-9.]+ /, '')); out.push(famJson(fe));
    const f4 = yTgrid(`ETH 4h ${l} 관통0.5% [2022-07~]`, { ...c, volK: true, slip: 0.0005, pen: 0.005 }, E4, FOUR, A4); console.log(famLine(f4)); out.push(famJson(f4));
  }
  save('vol.json', out);
}
