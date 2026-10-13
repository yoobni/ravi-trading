/**
 * mr 축 3단계 — 후보 1개에 반증 전 항목.
 * 사용: npx tsx scripts/_bt_dip_mr_cand.ts BTC RSI2 10 volExp 0.67 4 3 > .../cand_xxx.txt
 *   인자: 자산 오실레이터 임계 박스정의 컷 TP% N일
 * 항목: 기본지표·거래통계·노출 / 국면 a·b·c(그날·전날 라벨) / 기간분할 / 비용×2·지연1·2봉·관통 0.5·1%·지정가 진입 /
 *   플라시보(같은 필터 내 무작위, 전체 무작위; 각 200회) / 이웃칸 중앙 / 연 단위 롤링 워크포워드 / 2019~ 시작 / 함대 보완성.
 */
import fs from 'fs';
import path from 'path';
import { DB, DE, FB, FE, RG, OUT, DAY, simulate, metrics, tradeStats, idxAtOrAfter, regimeReport, rng, P, type Cfg, type Bar } from './_bt_dip_mr_lib';
import { OSC, BOXDEF, TPS, NS, boxSeries, mkSig } from './_bt_dip_mr_plateau';

const [asset = 'BTC', osc = 'RSI2', thrS = '10', bd = 'volExp', cutS = '0.67', tpS = '4', NS_ = '3'] = process.argv.slice(2);
const thr = +thrS, cut = +cutS, tp = +tpS, N = +NS_;
const b: Bar[] = asset === 'BTC' ? DB : DE, Fx = asset === 'BTC' ? FB : FE, mkt = `KRW-${asset}`;
const TS = DB.map(x => x.ts);
const START = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), END = TS.length - 1, SPLIT = idxAtOrAfter(TS, Date.UTC(2023, 0, 1));
const BX = boxSeries(Fx);
const sig = mkSig(Fx, osc, thr, BX[bd], cut);
const base: Cfg = { entry: 'open', tp, N, sma5x: false };
const label = `${asset} ${osc}<${thr} & ${bd}≥${cut} → 다음날 시가 · TP+${tp}% 지정가(관통0.2%) · ${N}일 시간청산 · 무스톱`;
console.log(`후보: ${label}\n창 ${new Date(TS[START]).toISOString().slice(0, 10)} ~ ${new Date(TS[END]).toISOString().slice(0, 10)}`);

function run(cfg: Partial<Cfg> = {}, s = sig, i0 = START) { return simulate(b, Fx.sma5, s, { ...base, ...cfg } as Cfg, mkt, i0, END); }
function line(lab: string, r: ReturnType<typeof run>, i0 = START) {
  const m = metrics(r.ret, TS, i0, END), t = tradeStats(r.trades.filter(x => x.e >= i0), m.yrs);
  return `${lab.padEnd(26)} 총익 ${P(m.tot).padStart(6)} CAGR ${P(m.cagr, 1).padStart(6)} MDD ${m.mdd.toFixed(1).padStart(5)}% 샤프 ${m.sharpe.toFixed(2).padStart(5)} | 거래 ${t.n} (${t.perYr.toFixed(1)}/연) 승률 ${t.win.toFixed(0)}% 거래당 ${P(t.avg, 2)} 최악 ${P(t.worst, 1)}`;
}
const R0 = run();
console.log('\n── 1. 기본 ──');
console.log(line('기본', R0));
const expo = R0.inPos.slice(START, END + 1).reduce((a, v) => a + v, 0) / (END - START + 1);
console.log(`  보유일 비율 ${(100 * expo).toFixed(1)}% · 청산 사유 ${['TP', 'TIME'].map(w => `${w} ${R0.trades.filter(t => t.why === w).length}`).join(' / ')}`);
const bh = simulate(b, Fx.sma5, new Uint8Array(TS.length).fill(1), { entry: 'open', tp: null, N: 1e9, sma5x: false }, mkt, START, END);
console.log(line(`(참고) ${asset} 보유`, bh));

console.log('\n── 2. 국면별 일수익 (a: BTC<SMA50, b: BTC 20일수익≤+2% (a와 겹침), c: 둘 다 아님) ──');
const daily = new Map<number, number>(); for (let i = START; i <= END; i++) daily.set(TS[i], R0.ret[i]);
for (const prior of [false, true]) {
  const rg = regimeReport(daily, TS[START], TS[END] + 1, prior);
  console.log(`  ${prior ? '전날 라벨' : '그날 라벨'}: ` + (['a', 'b', 'c'] as const).map(k => `${k} ${rg[k].days}일 평균 ${rg[k].avgBp.toFixed(2)}bp 누적 ${P(rg[k].cum, 1)}`).join(' | '));
}
// 거래 단위: 신호일 국면별
const byReg: Record<string, number[]> = { a: [], b: [], c: [] };
for (const t of R0.trades) { const i = t.si; if (RG.below[i]) byReg.a.push(t.r); if (RG.side[i]) byReg.b.push(t.r); if (!RG.below[i] && !RG.side[i]) byReg.c.push(t.r); }
console.log('  신호일 국면별 거래: ' + Object.entries(byReg).map(([k, v]) => `${k} n${v.length} 평균 ${P(100 * v.reduce((x, y) => x + y, 0) / Math.max(v.length, 1), 2)} 승률 ${(100 * v.filter(x => x > 0).length / Math.max(v.length, 1)).toFixed(0)}%`).join(' | '));

console.log('\n── 3. 기간 분할 ──');
const PER: Array<[string, number, number]> = [['2017-18', 2017, 2019], ['2019-20', 2019, 2021], ['2021', 2021, 2022], ['2022H1', 2022, 2022.5], ['2022H2', 2022.5, 2023], ['2023', 2023, 2024], ['2024H1', 2024, 2024.5], ['2024H2', 2024.5, 2025], ['2025', 2025, 2026], ['2026YTD', 2026, 2027]];
const yts = (y: number) => Date.UTC(Math.floor(y), y % 1 ? 6 : 0, 1);
const perOut: string[] = [];
for (const [lab, a, z] of PER) {
  const i0 = Math.max(idxAtOrAfter(TS, yts(a)), START), i1 = Math.min(idxAtOrAfter(TS, yts(z)) - 1, END);
  const m = metrics(R0.ret, TS, i0, i1), nt = R0.trades.filter(t => t.e >= i0 && t.e <= i1).length;
  const bm = metrics(bh.ret, TS, i0, i1);
  perOut.push(`${lab} ${P(m.tot, 1)}(${nt}건, 보유 ${P(bm.tot, 0)})`);
}
console.log('  ' + perOut.join(' | '));

console.log('\n── 4. 반증: 비용·지연·체결 ──');
console.log(line('비용×2', run({ feeMul: 2 })));
console.log(line('신호 1일 지연', run({ lag: 1 })));
console.log(line('신호 2일 지연', run({ lag: 2 })));
console.log(line('TP 관통 0.5%', run({ pen: 0.005 })));
console.log(line('TP 관통 1.0%', run({ pen: 0.01 })));
console.log(line('관통 0 (닿으면 체결)', run({ pen: 0 })));
for (const k of [1, 2, 3]) console.log(line(`지정가 진입 종가−${k}%`, run({ entry: k })));
console.log(line('2019-01 시작(초기 고변동 제외)', run({}, sig, idxAtOrAfter(TS, Date.UTC(2019, 0, 1))), idxAtOrAfter(TS, Date.UTC(2019, 0, 1))));

console.log('\n── 5. 플라시보 (200회, 같은 청산) ──');
const nSig = [...sig.slice(START, END + 1)].filter(Boolean).length;
const filtDays: number[] = []; for (let i = START; i <= END; i++) if (BX[bd][i] >= cut) filtDays.push(i);
const allDays: number[] = []; for (let i = START; i <= END; i++) allDays.push(i);
const realTot = metrics(R0.ret, TS, START, END).tot, realSh = metrics(R0.ret, TS, START, END).sharpe;
for (const [lab, pool] of [['같은 박스필터 내 무작위', filtDays], ['전체 무작위', allDays]] as const) {
  const R = rng(7); const tots: number[] = [], shs: number[] = [];
  for (let k = 0; k < 200; k++) {
    const s = new Uint8Array(TS.length); for (let j = 0; j < nSig; j++) s[pool[Math.floor(R() * pool.length)]] = 1;
    const r = run({}, s); const m = metrics(r.ret, TS, START, END); tots.push(m.tot); shs.push(m.sharpe);
  }
  tots.sort((x, y) => x - y); shs.sort((x, y) => x - y);
  console.log(`  ${lab.padEnd(18)} 신호수 ${nSig} · 총익 중앙 ${P(tots[100])} (5~95% ${P(tots[10])}~${P(tots[190])}) · 샤프 중앙 ${shs[100].toFixed(2)} · 실제 이상 ${tots.filter(x => x >= realTot).length}/200 (샤프 ${shs.filter(x => x >= realSh).length}/200)`);
}

console.log('\n── 6. 이웃칸 (임계·컷·TP·N 각 ±1단계, 최대 81칸) ──');
const ti = OSC[osc].indexOf(thr), ci = BOXDEF[bd].indexOf(cut), pi = TPS.indexOf(tp), ni = NS.indexOf(N);
const nb: Array<{ tot: number; oos: number; is: number; sh: number }> = [];
for (const dt of [-1, 0, 1]) for (const dc of [-1, 0, 1]) for (const dp of [-1, 0, 1]) for (const dn of [-1, 0, 1]) {
  const T2 = OSC[osc][ti + dt], C2 = BOXDEF[bd][ci + dc], P2 = TPS[pi + dp], N2 = NS[ni + dn];
  if (T2 === undefined || C2 === undefined || P2 === undefined || N2 === undefined) continue;
  const r = simulate(b, Fx.sma5, mkSig(Fx, osc, T2, BX[bd], C2), { entry: 'open', tp: P2, N: N2, sma5x: false }, mkt, START, END);
  nb.push({ tot: metrics(r.ret, TS, START, END).tot, is: metrics(r.ret, TS, START, SPLIT - 1).tot, oos: metrics(r.ret, TS, SPLIT, END).tot, sh: metrics(r.ret, TS, START, END).sharpe });
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`  ${nb.length}칸 · 총익 중앙 ${P(med(nb.map(x => x.tot)))} (최저 ${P(Math.min(...nb.map(x => x.tot)))}, 최고 ${P(Math.max(...nb.map(x => x.tot)))}) · 샤프 중앙 ${med(nb.map(x => x.sh)).toFixed(2)} · IS 중앙 ${P(med(nb.map(x => x.is)))} · OOS 중앙 ${P(med(nb.map(x => x.oos)))} · 양수 ${nb.filter(x => x.tot > 0).length}/${nb.length}`);

console.log('\n── 7. 워크포워드 ──');
const fixed = metrics(R0.ret, TS, SPLIT, END), fixedIS = metrics(R0.ret, TS, START, SPLIT - 1);
console.log(`  고정 분할: IS(2017-11~2022) ${P(fixedIS.tot)} 샤프 ${fixedIS.sharpe.toFixed(2)} → OOS(2023~) ${P(fixed.tot)} 샤프 ${fixed.sharpe.toFixed(2)}`);
// 연 단위 롤링: 매년 1/1 에 그 이전 전체로 (임계·컷·TP·N) 격자에서 샤프 최고 칸 선택 → 그 해 적용
const cells: Array<{ T: number; C: number; P: number; N: number; ret: Float64Array }> = [];
for (const T2 of OSC[osc]) for (const C2 of BOXDEF[bd]) { const s2 = mkSig(Fx, osc, T2, BX[bd], C2); for (const P2 of TPS) for (const N2 of NS) cells.push({ T: T2, C: C2, P: P2, N: N2, ret: simulate(b, Fx.sma5, s2, { entry: 'open', tp: P2, N: N2, sma5x: false }, mkt, START, END).ret }); }
const wf = new Float64Array(TS.length); const picks: string[] = [];
for (let y = 2020; y <= 2026; y++) {
  const a = idxAtOrAfter(TS, Date.UTC(y, 0, 1)), z = Math.min(idxAtOrAfter(TS, Date.UTC(y + 1, 0, 1)) - 1, END);
  const best = cells.map(c => ({ c, sh: metrics(c.ret, TS, START, a - 1).sharpe })).sort((p, q) => q.sh - p.sh)[0].c;
  for (let i = a; i <= z; i++) wf[i] = best.ret[i]; // 그 셀의 연속 실행 경로를 그 해에 사용 (연초 진행 중 포지션은 근사)
  picks.push(`${y}:${osc}<${best.T}/c${best.C}/TP${best.P}/N${best.N} ${P(metrics(best.ret, TS, a, z).tot, 1)} (후보 ${P(metrics(R0.ret, TS, a, z).tot, 1)})`);
}
const w0 = idxAtOrAfter(TS, Date.UTC(2020, 0, 1));
console.log(`  연 단위 롤링 선택 2020~: ${P(metrics(wf, TS, w0, END).tot)} 샤프 ${metrics(wf, TS, w0, END).sharpe.toFixed(2)} vs 후보 고정 ${P(metrics(R0.ret, TS, w0, END).tot)} vs 격자 전체 중앙 ${P(med(cells.map(c => metrics(c.ret, TS, w0, END).tot)))}`);
console.log('  ' + picks.join('\n  '));

console.log('\n── 8. 함대 보완성 (daily-series.json, ~2026-09-30) ──');
const FLEET = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8')) as Record<string, [number, number][]>;
const keys = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP', 'F7_sl*'];
const fm = Object.fromEntries(keys.map(k => [k, new Map(FLEET[k].map(([t, r]) => [Math.floor(t / DAY) * DAY, r]))]));
const corr = (x: number[], y: number[]) => { const n = x.length, mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n; let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; } return c / Math.sqrt(vx * vy); };
console.log('  상관(겹치는 날): ' + keys.map(k => { const ds = [...fm[k].keys()].filter(t => daily.has(t)); return `${k} ${corr(ds.map(t => daily.get(t)!), ds.map(t => fm[k].get(t)!)).toFixed(2)}(${ds.length}일)`; }).join(' · '));
const common = [...daily.keys()].filter(t => keys.every(k => fm[k].has(t)));
const fleetR = common.map(t => keys.reduce((a, k) => a + fm[k].get(t)!, 0) / keys.length);
const lossDays = common.filter((_, i) => fleetR[i] < 0);
const avgOn = (ds: number[]) => 1e4 * ds.reduce((a, t) => a + daily.get(t)!, 0) / Math.max(ds.length, 1);
console.log(`  공통창 ${new Date(common[0]).toISOString().slice(0, 10)}~${new Date(common[common.length - 1]).toISOString().slice(0, 10)} ${common.length}일 · 함대 균등합 손실일 ${lossDays.length}일에서 후보 평균 ${avgOn(lossDays).toFixed(2)}bp (전체일 ${avgOn(common).toFixed(2)}bp) · 함대 하위10% 날 ${avgOn(common.filter((_, i) => fleetR[i] <= [...fleetR].sort((x, y) => x - y)[Math.floor(fleetR.length * 0.1)])).toFixed(2)}bp`);
const mixed = common.map((t, i) => 0.875 * fleetR[i] + 0.125 * daily.get(t)!);
const mc = (rs: number[]) => { let e = 1, pk = 1, mdd = 0; for (const r of rs) { e *= 1 + r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } const mu = rs.reduce((a, v) => a + v, 0) / rs.length, sd = Math.sqrt(rs.reduce((a, v) => a + (v - mu) ** 2, 0) / rs.length); return `${P(100 * (e - 1))} MDD ${(100 * mdd).toFixed(1)}% 샤프 ${(mu / sd * Math.sqrt(365)).toFixed(2)}`; };
console.log(`  함대 7종 균등: ${mc(fleetR)} · 후보 단독: ${mc(common.map(t => daily.get(t)!))} · 함대 7 + 후보 1 (8등분): ${mc(mixed)}`);

const tag = `${asset}_${osc}${thr}_${bd}${cut}_TP${tp}_N${N}`;
fs.writeFileSync(path.join(OUT, `cand_${tag}.json`), JSON.stringify({ label, daily: [...daily], trades: R0.trades.map(t => ({ sig: new Date(TS[t.si]).toISOString().slice(0, 10), e: new Date(TS[t.e]).toISOString().slice(0, 10), x: new Date(TS[t.x]).toISOString().slice(0, 10), r: t.r, why: t.why })) }));
console.log(`\n저장: ${path.join(OUT, `cand_${tag}.json`)}`);
