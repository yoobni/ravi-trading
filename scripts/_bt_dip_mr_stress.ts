/**
 * mr 축 — 후보(BTC RSI2<10 & 박스분위≥0.67, TP4/N3) 추가 스트레스.
 *  A. 분위 워밍업 민감도: 확장분위의 최소 이력(180일)이 2018-01~04 폭락기를 자동으로 빼 준 것 아닌가?
 *     → minHist 30/60/90/120 와 롤링 90/180/365일, 그리고 절대폭 컷과 비교 (2017-18 구간 성과 따로)
 *  B. 장중 진입 지연(15m 경로, 2021-01~): 시가 대비 +15m/+30m/+1h/+3h/+6h 진입 시 거래당 평균 (TP 는 진입 이후 15m 고가로 판정)
 *  C. BTC+ETH 두 슬리브 합(각 50%, 비리밸런싱)
 */
import fs from 'fs';
import { DB, DE, FB, FE, DAY, simulate, metrics, tradeStats, idxAtOrAfter, expandingPct, rollingPct, slipOf, P, type Cfg, type Bar } from './_bt_dip_mr_lib';
import { mkSig } from './_bt_dip_mr_plateau';

const TS = DB.map(b => b.ts);
const START = idxAtOrAfter(TS, Date.UTC(2017, 10, 20)), END = TS.length - 1;
const I19 = idxAtOrAfter(TS, Date.UTC(2019, 0, 1));
const cfg: Cfg = { entry: 'open', tp: 4, N: 3, sma5x: false };
function rep(lab: string, b: Bar[], Fx: typeof FB, bx: Float64Array, cut: number, mkt: string) {
  const s = mkSig(Fx, 'RSI2', 10, bx, cut); const r = simulate(b, Fx.sma5, s, cfg, mkt, START, END);
  const m = metrics(r.ret, TS, START, END), m18 = metrics(r.ret, TS, START, I19 - 1), m19 = metrics(r.ret, TS, I19, END);
  const t = tradeStats(r.trades, m.yrs); const t18 = r.trades.filter(x => x.e < I19).length;
  console.log(`  ${lab.padEnd(30)} 전체 ${P(m.tot).padStart(6)} MDD ${m.mdd.toFixed(1).padStart(5)}% 샤프 ${m.sharpe.toFixed(2)} 거래 ${t.n} 거래당 ${P(t.avg, 2)} | 2017-18 ${P(m18.tot, 1)} (${t18}건) | 2019~ ${P(m19.tot)}`);
  return r;
}
for (const [asset, b, Fx] of [['BTC', DB, FB], ['ETH', DE, FE]] as const) {
  console.log(`\n══ A. ${asset} 분위 정의·워밍업 민감도 (RSI2<10 · TP4 · N3) ══`);
  for (const mh of [30, 60, 90, 120, 180]) rep(`박스 확장분위 minHist ${mh}`, b, Fx, expandingPct(Fx.box20, mh), 0.67, `KRW-${asset}`);
  for (const w of [90, 180, 365]) rep(`박스 롤링분위 ${w}일 (min 30)`, b, Fx, rollingPct(Fx.box20, w, 30), 0.67, `KRW-${asset}`);
  for (const mh of [30, 60, 180]) rep(`변동성 확장분위 minHist ${mh}`, b, Fx, expandingPct(Fx.vol20, mh), 0.67, `KRW-${asset}`);
  for (const c of [0.15, 0.2, 0.25, 0.3]) rep(`박스 절대폭 ≥ ${c * 100}%`, b, Fx, Fx.box20, c, `KRW-${asset}`);
  rep('필터 없음', b, Fx, new Float64Array(TS.length).fill(1), 0, `KRW-${asset}`);
}

// ── B. 장중 진입 지연 (BTC 15m, 2021-01~) ──
console.log('\n══ B. BTC 장중 진입 지연 (15m 경로, 2021-01-01~2026-10-02) ══');
const RAW: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
const M = RAW.map(r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4] })); const MI = new Map(M.map((x, i) => [x.ts, i]));
const sig = mkSig(FB, 'RSI2', 10, FB.boxPct, 0.67);
const r0 = simulate(DB, FB.sma5, sig, cfg, 'KRW-BTC', START, END);
const fee = 0.0005, slip = slipOf('KRW-BTC'), pen = 0.002;
const tr = r0.trades.filter(t => TS[t.e] >= Date.UTC(2021, 0, 1) && TS[t.e] + 4 * DAY <= M[M.length - 1].ts);
for (const dm of [0, 15, 30, 60, 180, 360]) {
  const rs: number[] = [];
  for (const t of tr) {
    const k0 = MI.get(TS[t.e] + dm * 60e3); if (k0 === undefined) continue;
    const pe = M[k0].o * (1 + slip), tgt = pe * 1.04; const exitTs = TS[t.e] + 3 * DAY; let r: number | null = null;
    for (let k = k0; k < M.length && M[k].ts < exitTs; k++) if (M[k].h >= tgt * (1 + pen)) { r = (tgt * (1 - fee)) / (pe / (1 - fee)) - 1; break; }
    if (r === null) { const kx = MI.get(exitTs)!; r = (M[kx].o * (1 - slip) * (1 - fee)) / (pe / (1 - fee)) - 1; }
    rs.push(r);
  }
  console.log(`  지연 ${String(dm).padStart(3)}분: 거래 ${rs.length} 평균 ${P(100 * rs.reduce((a, v) => a + v, 0) / rs.length, 2)} 승률 ${(100 * rs.filter(v => v > 0).length / rs.length).toFixed(0)}% 누적 ${P(100 * (rs.reduce((a, v) => a * (1 + v), 1) - 1), 1)}`);
}
console.log(`  (일봉 엔진 같은 거래 ${tr.length}건 평균 ${P(100 * tr.reduce((a, t) => a + t.r, 0) / tr.length, 2)} — 0분과 일치해야 함)`);

// ── C. BTC+ETH 슬리브 합 ──
console.log('\n══ C. BTC·ETH 두 슬리브 (각 자본 50%, 비리밸런싱) ══');
const rb = simulate(DB, FB.sma5, sig, cfg, 'KRW-BTC', START, END), re = simulate(DE, FE.sma5, mkSig(FE, 'RSI2', 10, FE.boxPct, 0.67), cfg, 'KRW-ETH', START, END);
let eb = 1, ee = 1, prev = 1; const comb = new Float64Array(TS.length);
for (let i = START; i <= END; i++) { eb *= 1 + rb.ret[i]; ee *= 1 + re.ret[i]; const e = 0.5 * eb + 0.5 * ee; comb[i] = e / prev - 1; prev = e; }
for (const [lab, a, z] of [['전체', START, END], ['2017-18', START, I19 - 1], ['2019~', I19, END], ['2023~', idxAtOrAfter(TS, Date.UTC(2023, 0, 1)), END]] as const) { const m = metrics(comb, TS, a, z); console.log(`  ${lab.padEnd(8)} ${P(m.tot)} CAGR ${P(m.cagr, 1)} MDD ${m.mdd.toFixed(1)}% 샤프 ${m.sharpe.toFixed(2)}`); }
let same = 0; for (const t of rb.trades) if (re.trades.some(u => u.e === t.e)) same++;
console.log(`  같은 날 진입 겹침 ${same}/${rb.trades.length} (BTC 거래 기준)`);
fs.writeFileSync('data/research-ext/dip-2026-10/mr/combo_btc_eth.json', JSON.stringify([...comb].map((r, i) => [TS[i], r]).slice(START)));
