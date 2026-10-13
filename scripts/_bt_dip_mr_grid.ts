/**
 * mr 축 1단계 — 일봉 BTC·ETH 과매도 × 국면 필터 × 청산(TP 지정가 / SMA5 / 시간) 전수 격자.
 * 출력: data/research-ext/dip-2026-10/mr/grid_daily.json (셀별 지표) + 콘솔 요약 (→ grid_daily.txt 로 리다이렉트)
 * 실행: npx tsx scripts/_bt_dip_mr_grid.ts > data/research-ext/dip-2026-10/mr/grid_daily.txt
 */
import fs from 'fs';
import path from 'path';
import { DB, DE, FB, FE, RG, OUT, simulate, metrics, tradeStats, idxAtOrAfter, P, toDailyFromBars, regimeReport, type Cfg, type Bar } from './_bt_dip_mr_lib';

const TS = DB.map(b => b.ts);
const START = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), END = TS.length - 1;
const SPLIT = idxAtOrAfter(TS, Date.UTC(2023, 0, 1));
export const PERIODS: Array<[string, number, number]> = [
  ['2017-18', Date.UTC(2017, 10, 20), Date.UTC(2019, 0, 1)], ['2019-20', Date.UTC(2019, 0, 1), Date.UTC(2021, 0, 1)], ['2021', Date.UTC(2021, 0, 1), Date.UTC(2022, 0, 1)],
  ['2022', Date.UTC(2022, 0, 1), Date.UTC(2023, 0, 1)], ['2023', Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)], ['2024', Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)], ['2026', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)],
];

type F = typeof FB;
export function signals(Fx: F): Array<[string, Uint8Array]> {
  const n = Fx.c.length; const out: Array<[string, Uint8Array]> = [];
  const mk = (fn: (i: number) => boolean) => { const r = new Uint8Array(n); for (let i = 50; i < n; i++) r[i] = fn(i) ? 1 : 0; return r; };
  for (const t of [5, 10, 15, 20, 25]) out.push([`RSI2<${t}`, mk(i => Fx.rsi2[i] < t)]);
  for (const t of [10, 15, 20, 25, 30]) out.push([`RSI3<${t}`, mk(i => Fx.rsi3[i] < t)]);
  for (const k of [1.5, 2, 2.5]) out.push([`BB${k}`, mk(i => Fx.c[i] < Fx.sma20[i] - k * Fx.sd20[i])]);
  for (const N of [3, 5, 10]) { const a = Fx.lowestN(N); out.push([`NL${N}`, mk(i => !!a[i])]); }
  for (const k of [3, 4, 5]) out.push([`DN${k}`, mk(i => Fx.dnRun[i] >= k)]);
  const dd = Fx.ddFromHigh(20); for (const x of [5, 8, 10, 15, 20]) out.push([`DD${x}`, mk(i => dd[i] <= -x / 100)]);
  return out;
}
export function filters(Fx: F): Array<[string, (i: number) => boolean]> {
  return [
    ['all', () => true],
    ['a:<SMA50', i => !!RG.below[i]],
    ['b:ret20<=2', i => !!RG.side[i]],
    ['a|b', i => !!RG.below[i] || !!RG.side[i]],
    ['c:up', i => !RG.below[i] && !RG.side[i]],
    ['>SMA50', i => !RG.below[i]],
    ['volL', i => Fx.volPct[i] < 1 / 3], ['volM', i => Fx.volPct[i] >= 1 / 3 && Fx.volPct[i] < 2 / 3], ['volH', i => Fx.volPct[i] >= 2 / 3],
    ['boxL', i => Fx.boxPct[i] < 1 / 3], ['boxM', i => Fx.boxPct[i] >= 1 / 3 && Fx.boxPct[i] < 2 / 3], ['boxH', i => Fx.boxPct[i] >= 2 / 3],
  ];
}
export function exits(): Array<[string, Partial<Cfg>]> {
  const out: Array<[string, Partial<Cfg>]> = [];
  for (const tp of [2, 3, 4, 5, 7, 10]) for (const N of [2, 3, 5, 7, 10]) out.push([`TP${tp}/N${N}`, { tp, N, sma5x: false }]);
  for (const N of [5, 10]) out.push([`SMA5/N${N}`, { tp: null, N, sma5x: true }]);
  for (const tp of [3, 5]) out.push([`TP${tp}+SMA5/N10`, { tp, N: 10, sma5x: true }]);
  return out;
}

export function evalCell(b: Bar[], Fx: F, sig: Uint8Array, cfg: Cfg, market: string) {
  const s = simulate(b, Fx.sma5, sig, cfg, market, START, END);
  const full = metrics(s.ret, TS, START, END), is = metrics(s.ret, TS, START, SPLIT - 1), oos = metrics(s.ret, TS, SPLIT, END);
  const ts = tradeStats(s.trades, full.yrs);
  const per: Record<string, number> = {};
  for (const [lab, a, z] of PERIODS) { const i0 = idxAtOrAfter(TS, a), i1 = Math.min(idxAtOrAfter(TS, z) - 1, END); if (i1 > i0) per[lab] = metrics(s.ret, TS, Math.max(i0, START), i1).tot; }
  const daily = new Map<number, number>(); for (let i = START; i <= END; i++) daily.set(TS[i], s.ret[i]);
  const rg = regimeReport(daily, TS[START], TS[END] + 1);
  const expo = s.inPos.slice(START, END + 1).reduce((a, v) => a + v, 0) / (END - START + 1);
  return { full, is, oos, ts, per, rg, expo, s };
}

const isMain = process.argv[1]?.includes('_bt_dip_mr_grid');
if (isMain) {
  const rows: any[] = [];
  for (const [asset, b, Fx, mkt] of [['BTC', DB, FB, 'KRW-BTC'], ['ETH', DE, FE, 'KRW-ETH']] as const) {
    const SIG = signals(Fx), FIL = filters(Fx), EX = exits();
    for (const [sn, s0] of SIG) for (const [fn, ff] of FIL) {
      const sig = new Uint8Array(s0.length); for (let i = 0; i < sig.length; i++) sig[i] = s0[i] && ff(i) ? 1 : 0;
      for (const [en, ec] of EX) {
        const cfg: Cfg = { entry: 'open', tp: null, sma5x: false, N: 5, ...ec } as Cfg;
        const r = evalCell(b, Fx, sig, cfg, mkt);
        rows.push({ asset, sig: sn, fil: fn, exit: en, tot: r.full.tot, cagr: r.full.cagr, mdd: r.full.mdd, sh: r.full.sharpe, isTot: r.is.tot, isSh: r.is.sharpe, oosTot: r.oos.tot, oosSh: r.oos.sharpe,
          n: r.ts.n, perYr: r.ts.perYr, win: r.ts.win, avg: r.ts.avg, worst: r.ts.worst, expo: r.expo, per: r.per, rgA: r.rg.a.avgBp, rgB: r.rg.b.avgBp, rgC: r.rg.c.avgBp, cumA: r.rg.a.cum, cumB: r.rg.b.cum, cumC: r.rg.c.cum });
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'grid_daily.json'), JSON.stringify(rows));
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.log(`격자 ${rows.length} 셀 · 창 ${new Date(TS[START]).toISOString().slice(0, 10)}~${new Date(TS[END]).toISOString().slice(0, 10)} · IS ~2022 / OOS 2023~`);
  // 1) 국면 필터별 셀 분포 (신호×청산 전체)
  for (const asset of ['BTC', 'ETH']) {
    console.log(`\n══ ${asset}: 국면 필터별 — 모든 신호×청산 셀 분포 ══`);
    console.log('필터'.padEnd(12) + '셀  중앙총익  중앙샤프  양수비율  중앙IS   중앙OOS  OOS양수  중앙거래/연 중앙거래당');
    for (const fil of [...new Set(rows.map(r => r.fil))]) {
      const xs = rows.filter(r => r.asset === asset && r.fil === fil && r.n >= 10);
      console.log(`${fil.padEnd(12)}${String(xs.length).padStart(4)} ${P(med(xs.map(r => r.tot))).padStart(8)} ${med(xs.map(r => r.sh)).toFixed(2).padStart(8)} ${(100 * xs.filter(r => r.tot > 0).length / xs.length).toFixed(0).padStart(7)}% ${P(med(xs.map(r => r.isTot))).padStart(8)} ${P(med(xs.map(r => r.oosTot))).padStart(8)} ${(100 * xs.filter(r => r.oosTot > 0).length / xs.length).toFixed(0).padStart(6)}% ${med(xs.map(r => r.perYr)).toFixed(1).padStart(9)} ${med(xs.map(r => r.avg)).toFixed(2).padStart(9)}%`);
    }
    console.log(`\n── ${asset}: 신호별 (필터 all / a|b) — 청산 34종 중앙 ──`);
    for (const sig of [...new Set(rows.map(r => r.sig))]) {
      const line = ['all', 'a|b', 'a:<SMA50', 'b:ret20<=2', 'c:up'].map(fil => { const xs = rows.filter(r => r.asset === asset && r.fil === fil && r.sig === sig && r.n >= 5); return xs.length ? `${fil}: ${P(med(xs.map(r => r.tot))).padStart(6)} sh${med(xs.map(r => r.sh)).toFixed(2)} oos${P(med(xs.map(r => r.oosTot)))}` : `${fil}: -`; });
      console.log(`${sig.padEnd(9)} ${line.join(' | ')}`);
    }
  }
}
