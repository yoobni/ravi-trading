/**
 * mr 축 2단계 — 1단계에서 유일하게 살아난 '넓은 박스(고변동) 국면의 과매도 → 짧은 TP' 계열의 고원·워크포워드.
 * 차원: 오실레이터(RSI2/RSI3) × 임계 × 박스 정의(확장분위/365일 롤링분위/절대폭/변동성 확장분위) × 컷 × TP × N.
 * 출력: plateau.json + 콘솔(→ plateau.txt)
 */
import fs from 'fs';
import path from 'path';
import { DB, DE, FB, FE, OUT, simulate, metrics, tradeStats, idxAtOrAfter, rollingPct, type Cfg, type Bar } from './_bt_dip_mr_lib';

const TS = DB.map(b => b.ts);
const START = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), END = TS.length - 1, SPLIT = idxAtOrAfter(TS, Date.UTC(2023, 0, 1));
export const OSC: Record<string, number[]> = { RSI2: [5, 7.5, 10, 12.5, 15], RSI3: [10, 15, 20, 25, 30] };
export const BOXDEF: Record<string, number[]> = { boxExp: [0.5, 0.6, 0.67, 0.75, 0.8], boxRoll: [0.5, 0.6, 0.67, 0.75, 0.8], boxAbs: [0.12, 0.15, 0.2, 0.25, 0.3], volExp: [0.5, 0.6, 0.67, 0.75, 0.8] };
export const TPS = [2, 3, 4, 5, 7], NS = [1, 2, 3, 4, 5];
export function boxSeries(Fx: typeof FB) { return { boxExp: Fx.boxPct, boxRoll: rollingPct(Fx.box20, 365), boxAbs: Fx.box20, volExp: Fx.volPct } as Record<string, Float64Array>; }
export function mkSig(Fx: typeof FB, osc: string, thr: number, bx: Float64Array, cut: number) {
  const o = osc === 'RSI2' ? Fx.rsi2 : Fx.rsi3; const s = new Uint8Array(Fx.c.length);
  for (let i = 50; i < s.length; i++) s[i] = o[i] < thr && bx[i] >= cut ? 1 : 0; return s;
}
const isMain = process.argv[1]?.includes('_bt_dip_mr_plateau');
if (isMain) {
  const rows: any[] = [];
  for (const [asset, b, Fx, mkt] of [['BTC', DB, FB, 'KRW-BTC'], ['ETH', DE, FE, 'KRW-ETH']] as const) {
    const BX = boxSeries(Fx);
    for (const osc of Object.keys(OSC)) for (const [ti, thr] of OSC[osc].entries()) for (const bd of Object.keys(BOXDEF)) for (const [ci, cut] of BOXDEF[bd].entries()) {
      const sig = mkSig(Fx, osc, thr, BX[bd], cut);
      for (const [pi, tp] of TPS.entries()) for (const [ni, N] of NS.entries()) {
        const s = simulate(b as Bar[], Fx.sma5, sig, { entry: 'open', tp, N, sma5x: false } as Cfg, mkt, START, END);
        const full = metrics(s.ret, TS, START, END), is = metrics(s.ret, TS, START, SPLIT - 1), oos = metrics(s.ret, TS, SPLIT, END);
        const t = tradeStats(s.trades, full.yrs);
        rows.push({ asset, osc, ti, thr, bd, ci, cut, pi, tp, ni, N, tot: full.tot, mdd: full.mdd, sh: full.sharpe, isTot: is.tot, isSh: is.sharpe, oosTot: oos.tot, oosSh: oos.sharpe, n: t.n, win: t.win, avg: t.avg });
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'plateau.json'), JSON.stringify(rows));
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const pf = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
  for (const asset of ['BTC', 'ETH']) for (const osc of Object.keys(OSC)) for (const bd of Object.keys(BOXDEF)) {
    const xs = rows.filter(r => r.asset === asset && r.osc === osc && r.bd === bd);
    console.log(`\n══ ${asset} ${osc} × ${bd}: ${xs.length}셀 — 전체 중앙 ${pf(med(xs.map(r => r.tot)))} · 양수 ${(100 * xs.filter(r => r.tot > 0).length / xs.length).toFixed(0)}% · IS중앙 ${pf(med(xs.map(r => r.isTot)))} · OOS중앙 ${pf(med(xs.map(r => r.oosTot)))} · OOS양수 ${(100 * xs.filter(r => r.oosTot > 0).length / xs.length).toFixed(0)}%`);
    // 임계×컷 표 (TP·N 25칸 중앙)
    console.log('  임계\\컷  ' + BOXDEF[bd].map(c => String(c).padStart(14)).join(''));
    for (const [ti, thr] of OSC[osc].entries()) console.log(`  ${String(thr).padEnd(8)}` + BOXDEF[bd].map((_, ci) => { const y = xs.filter(r => r.ti === ti && r.ci === ci); return `${pf(med(y.map(r => r.tot)))}/${pf(med(y.map(r => r.oosTot)))}`.padStart(14); }).join(''));
    console.log('  TP\\N     ' + NS.map(n => String(n).padStart(14)).join(''));
    for (const [pi, tp] of TPS.entries()) console.log(`  ${String(tp).padEnd(8)}` + NS.map((_, ni) => { const y = xs.filter(r => r.pi === pi && r.ni === ni); return `${pf(med(y.map(r => r.tot)))}/${pf(med(y.map(r => r.oosTot)))}`.padStart(14); }).join(''));
    // 워크포워드: IS 샤프 최고 셀 → OOS
    const best = [...xs].filter(r => r.n >= 15).sort((a, b) => b.isSh - a.isSh)[0];
    if (best) { const oosRank = xs.filter(r => r.oosTot > best.oosTot).length; console.log(`  WF: IS최고 ${osc}<${best.thr} cut${best.cut} TP${best.tp} N${best.N} (IS ${pf(best.isTot)} sh${best.isSh.toFixed(2)}) → OOS ${pf(best.oosTot)} (OOS 순위 ${oosRank + 1}/${xs.length}, OOS 중앙 ${pf(med(xs.map(r => r.oosTot)))})`); }
  }
}
