/**
 * mr 축 — 나머지 시험 3종.
 *  trend : BTC_TREND(종가>SMA50 보유) + TREND 현금일 때만 과매도 슬리브 (함대 전체 하락장 거동)
 *  ratio : ETH/BTC 비율 과매도 시 ETH 매수 (롱온리 상대가치)
 *  h4    : 4h 봉 (2022-06~) BTC·ETH 과매도 × 박스 분위 × TP/N
 * 실행: npx tsx scripts/_bt_dip_mr_misc.ts trend|ratio|h4 > .../misc_<mode>.txt
 */
import fs from 'fs';
import { DB, DE, FB, FE, RG, DAY, H4B, H4E, simulate, metrics, tradeStats, idxAtOrAfter, rsi, sma, sd, expandingPct, regimeReport, slipOf, toDailyFromBars, P, type Cfg, type Bar } from './_bt_dip_mr_lib';
import { mkSig } from './_bt_dip_mr_plateau';

const TS = DB.map(b => b.ts);
const START = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), END = TS.length - 1, SPLIT = idxAtOrAfter(TS, Date.UTC(2023, 0, 1));
const mode = process.argv[2] || 'trend';
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const YRS: Array<[string, number, number]> = [['2017-18', 2017, 2019], ['2019-20', 2019, 2021], ['2021', 2021, 2022], ['2022', 2022, 2023], ['2023', 2023, 2024], ['2024', 2024, 2025], ['2025', 2025, 2026], ['2026', 2026, 2027]];
function perYear(ret: Float64Array) { return YRS.map(([l, a, z]) => { const i0 = Math.max(idxAtOrAfter(TS, Date.UTC(a, 0, 1)), START), i1 = Math.min(idxAtOrAfter(TS, Date.UTC(z, 0, 1)) - 1, END); return `${l} ${P(metrics(ret, TS, i0, i1).tot)}`; }).join(' | '); }

/** BTC_TREND: i 일 종가 > SMA50 → i+1 시가부터 보유. 변경 시 시가 체결(수수료+슬리피지). */
function trend(lag = 0) {
  const fee = 0.0005, slip = slipOf('KRW-BTC'); const ret = new Float64Array(TS.length), w = new Uint8Array(TS.length);
  let cur = 0;
  for (let i = START; i <= END; i++) {
    const j = i - 1 - lag; const tgt = j >= 50 && DB[j].close > FB.sma50[j] ? 1 : 0; const x = DB[i], px = DB[i - 1];
    if (tgt !== cur) { ret[i] = cur * (x.open / px.close - 1) + tgt * (x.close / x.open - 1) - (fee + slip); cur = tgt; } else ret[i] = cur * (x.close / px.close - 1);
    w[i] = cur;
  }
  return { ret, w };
}

if (mode === 'trend') {
  const T = trend();
  // 검증: daily-series BTC_TREND 와 상관
  const FL = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8'));
  const fm = new Map<number, number>(FL.BTC_TREND.map(([t, r]: [number, number]) => [Math.floor(t / DAY) * DAY, r]));
  const xs: number[] = [], ys: number[] = []; for (let i = START; i <= END; i++) if (fm.has(TS[i])) { xs.push(T.ret[i]); ys.push(fm.get(TS[i])!); }
  const c = (() => { const n = xs.length, mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n; let s = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { s += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; } return s / Math.sqrt(vx * vy); })();
  console.log(`BTC_TREND 재구현 ↔ daily-series BTC_TREND 일수익 상관 ${c.toFixed(3)} (${xs.length}일)`);
  const sleeves: Array<[string, Uint8Array, Bar[], typeof FB, string]> = [
    ['후보: BTC RSI2<10 & 박스분위≥0.67', mkSig(FB, 'RSI2', 10, FB.boxPct, 0.67), DB, FB, 'KRW-BTC'],
    ['고전: BTC RSI2<10 (필터 없음)', mkSig(FB, 'RSI2', 10, new Float64Array(TS.length).fill(1), 0), DB, FB, 'KRW-BTC'],
    ['고전: BTC RSI2<5 (필터 없음)', mkSig(FB, 'RSI2', 5, new Float64Array(TS.length).fill(1), 0), DB, FB, 'KRW-BTC'],
    ['ETH RSI2<10 & 박스분위≥0.67', mkSig(FE, 'RSI2', 10, FE.boxPct, 0.67), DE, FE, 'KRW-ETH'],
  ];
  const out = (lab: string, r: Float64Array) => { const m = metrics(r, TS, START, END), o = metrics(r, TS, SPLIT, END); const rg = regimeReport(new Map([...Array(END - START + 1)].map((_, k) => [TS[START + k], r[START + k]])), TS[START], TS[END] + 1); return `${lab.padEnd(44)} ${P(m.tot).padStart(7)} CAGR ${P(m.cagr, 1).padStart(6)} MDD ${m.mdd.toFixed(1).padStart(5)}% 샤프 ${m.sharpe.toFixed(2)} OOS ${P(o.tot)} | a ${rg.a.avgBp.toFixed(1)}bp(${P(rg.a.cum)}) b ${rg.b.avgBp.toFixed(1)}bp(${P(rg.b.cum)}) c ${rg.c.avgBp.toFixed(1)}bp\n      ${perYear(r)}`; };
  console.log('\n' + out('BTC_TREND 단독', T.ret));
  for (const [lab, s0, b, Fx, mkt] of sleeves) {
    // TREND 가 현금이 될 날(신호일 종가 ≤ SMA50 → 다음날 TREND 비중 0)에만 신호 허용
    const s = new Uint8Array(s0.length); for (let i = 0; i < s.length; i++) s[i] = s0[i] && DB[i].close <= FB.sma50[i] ? 1 : 0;
    const r = simulate(b, Fx.sma5, s, { entry: 'open', tp: 4, N: 3, sma5x: false }, mkt, START, END);
    // 합성: TREND 보유일은 TREND 수익, 아니면 슬리브 수익 (TREND 진입 시 같은 BTC 포지션은 인계 — 근사)
    const comb = new Float64Array(TS.length); let overlap = 0; for (let i = START; i <= END; i++) { if (T.w[i]) { comb[i] = T.ret[i]; if (r.inPos[i]) overlap++; } else comb[i] = r.ret[i]; }
    const t = tradeStats(r.trades, metrics(r.ret, TS, START, END).yrs);
    console.log(out(`TREND + [${lab}] (TREND 현금일 때만)`, comb) + `\n      슬리브 거래 ${t.n} 거래당 ${P(t.avg, 2)} 승률 ${t.win.toFixed(0)}% · TREND 와 겹친 날 ${overlap}`);
    console.log(out(`   └ 슬리브 단독(같은 신호)`, r.ret));
  }
}

if (mode === 'ratio') {
  const Rr = DE.map((e, i) => e.close / DB[i].close);
  const r2 = rsi(Rr, 2), s20 = sma(Rr, 20), d20 = sd(Rr, 20); const n = Rr.length;
  const z = new Float64Array(n).fill(NaN); for (let i = 19; i < n; i++) z[i] = (Rr[i] - s20[i]) / d20[i];
  const low = (N: number) => { const a = new Uint8Array(n); for (let i = N; i < n; i++) { let ok = true; for (let j = i - N + 1; j < i; j++) if (Rr[j] <= Rr[i]) { ok = false; break; } a[i] = ok ? 1 : 0; } return a; };
  const mk = (f: (i: number) => boolean) => { const a = new Uint8Array(n); for (let i = 50; i < n; i++) a[i] = f(i) ? 1 : 0; return a; };
  const sigs: Array<[string, Uint8Array]> = [];
  for (const t of [5, 10, 15]) sigs.push([`비율RSI2<${t}`, mk(i => r2[i] < t)]);
  for (const t of [1.5, 2, 2.5]) sigs.push([`비율z20<-${t}`, mk(i => z[i] < -t)]);
  for (const N of [5, 10, 20]) { const a = low(N); sigs.push([`비율NL${N}`, mk(i => !!a[i])]); }
  const fils: Array<[string, (i: number) => boolean]> = [['all', () => true], ['a|b', i => !!RG.below[i] || !!RG.side[i]], ['c:up', i => !RG.below[i] && !RG.side[i]], ['ETH박스≥0.67', i => FE.boxPct[i] >= 0.67]];
  // 원시 드리프트: 신호 후 k일 ETH 수익(시가→) 과 ETH−BTC 초과
  console.log('══ ETH/BTC 비율 과매도 → ETH 매수: 원시 드리프트 (시가→k일 종가) ══');
  const fw = (b: Bar[], i: number, k: number) => b[i + k].close / b[i + 1].open - 1;
  for (const [sn, s] of sigs) {
    const idx: number[] = []; for (let i = START; i + 5 <= END; i++) if (s[i]) idx.push(i);
    const is = idx.filter(i => i < SPLIT), oo = idx.filter(i => i >= SPLIT);
    const m = (arr: number[], f: (i: number) => number) => arr.length ? (100 * arr.reduce((a, i) => a + f(i), 0) / arr.length).toFixed(2) : '-';
    console.log(`  ${sn.padEnd(12)} n${String(idx.length).padStart(4)} ETH k1 ${m(idx, i => fw(DE, i, 1))}% k3 ${m(idx, i => fw(DE, i, 3))}% | ETH−BTC k1 ${m(idx, i => fw(DE, i, 1) - fw(DB, i, 1))}% k3 ${m(idx, i => fw(DE, i, 3) - fw(DB, i, 3))}% k5 ${m(idx, i => fw(DE, i, 5) - fw(DB, i, 5))}% | IS k3초과 ${m(is, i => fw(DE, i, 3) - fw(DB, i, 3))}% OOS ${m(oo, i => fw(DE, i, 3) - fw(DB, i, 3))}%`);
  }
  console.log('\n══ 포트폴리오: ETH 시가 진입 · TP 지정가 · N일 (셀 분포, 신호×TP{3,4,5}×N{2,3,5}) ══');
  const rows: any[] = [];
  for (const [sn, s0] of sigs) for (const [fn, ff] of fils) {
    const s = new Uint8Array(n); for (let i = 0; i < n; i++) s[i] = s0[i] && ff(i) ? 1 : 0;
    for (const tp of [3, 4, 5]) for (const N of [2, 3, 5]) { const r = simulate(DE, FE.sma5, s, { entry: 'open', tp, N, sma5x: false }, 'KRW-ETH', START, END); const m = metrics(r.ret, TS, START, END); rows.push({ sn, fn, tp, N, tot: m.tot, sh: m.sharpe, mdd: m.mdd, is: metrics(r.ret, TS, START, SPLIT - 1).tot, oos: metrics(r.ret, TS, SPLIT, END).tot, nT: r.trades.length }); }
  }
  for (const [fn] of fils) { const xs = rows.filter(r => r.fn === fn); console.log(`  필터 ${fn.padEnd(12)} ${xs.length}셀 중앙 ${P(med(xs.map(r => r.tot)))} 양수 ${xs.filter(r => r.tot > 0).length}/${xs.length} · IS중앙 ${P(med(xs.map(r => r.is)))} · OOS중앙 ${P(med(xs.map(r => r.oos)))} · 거래중앙 ${med(xs.map(r => r.nT))}`); }
  for (const [sn] of sigs) { const xs = rows.filter(r => r.sn === sn && r.fn === 'all'); console.log(`  ${sn.padEnd(12)} (all) 중앙 ${P(med(xs.map(r => r.tot)))} 최고 ${P(Math.max(...xs.map(r => r.tot)))} OOS중앙 ${P(med(xs.map(r => r.oos)))}`); }
}

if (mode === 'h4') {
  console.log('══ 4h 봉 (2022-06~2026-10-12): 과매도 × 박스분위(120봉 박스, 확장분위) × TP/N봉, 다음 봉 시가 진입 ══');
  for (const [asset, b] of [['BTC', H4B], ['ETH', H4E]] as const) {
    const c = b.map(x => x.close); const n = c.length; const r2 = rsi(c, 2), r3 = rsi(c, 3), s5 = sma(c, 5);
    const box = new Float64Array(n).fill(NaN); for (let i = 119; i < n; i++) { let mh = -Infinity, ml = Infinity; for (let j = i - 119; j <= i; j++) { mh = Math.max(mh, b[j].high); ml = Math.min(ml, b[j].low); } box[i] = mh / ml - 1; }
    const bp = expandingPct(box, 540);
    const ts4 = b.map(x => x.ts); const S4 = idxAtOrAfter(ts4, Date.UTC(2022, 11, 1)), E4 = n - 1; // 분위 워밍업 후
    const dI = (t: number) => { const k = idxAtOrAfter(TS, Math.floor(t / DAY) * DAY) - 1; return k; }; // 직전 완료 일봉
    const fils: Array<[string, (i: number) => boolean]> = [['all', () => true], ['a|b(일봉)', i => { const k = dI(ts4[i]); return !!RG.below[k] || !!RG.side[k]; }], ['박스≥0.67', i => bp[i] >= 0.67], ['박스<0.33', i => bp[i] < 0.33]];
    const rows: any[] = [];
    for (const [on, o, ths] of [['RSI2', r2, [5, 10, 15]], ['RSI3', r3, [10, 20, 30]]] as const) for (const th of ths) for (const [fn, ff] of fils) {
      const s = new Uint8Array(n); for (let i = 0; i < n; i++) s[i] = o[i] < th && ff(i) ? 1 : 0;
      for (const tp of [2, 3, 4, 5]) for (const N of [6, 12, 18]) {
        const r = simulate(b, s5, s, { entry: 'open', tp, N, sma5x: false }, `KRW-${asset}`, S4, E4);
        const m = metrics(r.ret, ts4, S4, E4, 6 * 365); const t = tradeStats(r.trades, m.yrs);
        const mid = idxAtOrAfter(ts4, Date.UTC(2024, 6, 1));
        rows.push({ on, th, fn, tp, N, tot: m.tot, sh: m.sharpe, mdd: m.mdd, n: t.n, avg: t.avg, h1: metrics(r.ret, ts4, S4, mid - 1, 2190).tot, h2: metrics(r.ret, ts4, mid, E4, 2190).tot });
      }
    }
    console.log(`\n── ${asset} 4h (${new Date(ts4[S4]).toISOString().slice(0, 10)}~) ──`);
    for (const [fn] of fils) { const xs = rows.filter(r => r.fn === fn); console.log(`  필터 ${fn.padEnd(10)} ${xs.length}셀 중앙 ${P(med(xs.map(r => r.tot)))} 양수 ${xs.filter(r => r.tot > 0).length}/${xs.length} 샤프중앙 ${med(xs.map(r => r.sh)).toFixed(2)} 거래당중앙 ${P(med(xs.map(r => r.avg)), 2)} 거래중앙 ${med(xs.map(r => r.n))} · 전반(~24H1) ${P(med(xs.map(r => r.h1)))} 후반(24H2~) ${P(med(xs.map(r => r.h2)))}`); }
    const best = [...rows].sort((a, b2) => b2.sh - a.sh).slice(0, 5);
    for (const r of best) console.log(`    상위: ${r.on}<${r.th} ${r.fn} TP${r.tp} N${r.N}봉 → ${P(r.tot)} MDD ${r.mdd.toFixed(0)}% 샤프 ${r.sh.toFixed(2)} 거래 ${r.n} 전반 ${P(r.h1)} 후반 ${P(r.h2)}`);
  }
}
