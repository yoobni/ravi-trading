import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE0 = 0.0005, SLIP0 = 0.0005, INIT = 10_000_000;
let FEE = FEE0, SLIP = SLIP0;
const H = 3600_000, FOUR = 4 * H;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
let ORDER: string[] = [];
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) RAW.set(m, b); }
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
ORDER = [...RAW.keys()];

const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
/**
 * 메커니즘 ⑤ 국면 적응 (2026-10-02) — 신호 필터가 아니라 "청산 방식·사이즈"만 국면에 따라 바꾼다.
 * 체결 모델은 _bt_execfree.ts 의 TPONLY 그대로: TP+6 지정가(슬리피지 0), 무스톱 또는 봉마감 −2%(종가 체결), 3일 시간청산.
 * 국면 지표(사전 고정 5개, 결정 시점 = 진입 봉 직전 봉까지만 사용, LAG 로 추가 지연):
 *   BTC50  BTC 종가 > 50일 이평(300봉)       BTC100 BTC 종가 > 100일 이평(600봉)
 *   BRD    28코인 중 50일선 위 비율 ≥ 50%
 *   SELF   F6 신호를 독립 F7 거래로 본 그림자 장부의 '청산 완료' 최근 20건 평균 > 0
 *   VOL    BTC 30일 실현변동성 ≤ 직전 1년 평균 (고변동 = 방어)
 * 방어 동작: SL(봉마감 −2% 손절) / HALF(사이즈 절반, 무스톱) / OFF(신규 진입 중단)
 */
const H4 = 4 * 3600_000;
let LAG = 0;
const TP = 6, MAXB = 18, SLP = -2;
const btc = RAW.get('KRW-BTC')!; const bI = IDX.get('KRW-BTC')!;
// BTC 계열 지표: i = 판단에 쓸 마지막 확정 봉 인덱스
const ma = (b: Bar[], i: number, n: number) => { if (i < n) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += b[j].close; return s / n; };
const btcRet = btc.map((x, i) => i ? Math.log(x.close / btc[i - 1].close) : 0);
const vol180 = btc.map((_, i) => { if (i < 180) return NaN; let s = 0, s2 = 0; for (let j = i - 179; j <= i; j++) { s += btcRet[j]; s2 += btcRet[j] ** 2; } const m = s / 180; return Math.sqrt(s2 / 180 - m * m); });
const volAvg = vol180.map((_, i) => { if (i < 180 + 2190) return NaN; let s = 0; for (let j = i - 2189; j <= i; j++) s += vol180[j]; return s / 2190; });
// breadth: 코인별 50일선 위 여부 (누적합)
const CS = new Map([...RAW].map(([m, b]) => { const c = [0]; for (const x of b) c.push(c[c.length - 1] + x.close); return [m, c]; }));
const breadthAt = (ts: number) => { // ts 봉 직전 확정봉 기준
  let up = 0, n = 0;
  for (const [m, b] of RAW) { const i0 = IDX.get(m)!.get(ts); if (i0 === undefined) continue; const i = i0 - 1 - LAG; if (i < 300) continue;
    const c = CS.get(m)!; const avg = (c[i + 1] - c[i + 1 - 300]) / 300; n++; if (b[i].close > avg) up++; }
  return n ? up / n : 1;
};
// 그림자 장부 — 모든 F6 신호를 독립 F7 거래로 (슬롯 무관). 결과는 "청산 봉 마감 시각"에 공개된다.
const shadow: { avail: number; r: number }[] = [];
for (const [, b] of RAW) for (let i = 45; i < b.length - 1; i++) {
  if (!sigF6(b, i)) continue;
  const ep = b[i + 1].open * (1 + SLIP); let r = NaN, k = i + 2, done = -1;
  for (; k < b.length && k <= i + 1 + MAXB; k++) {
    if (b[k].high >= ep * (1 + TP / 100)) { r = TP / 100; done = k; break; }
    if (k === i + 1 + MAXB) { r = b[k].close * (1 - SLIP) / ep - 1; done = k; break; }
  }
  if (done > 0) shadow.push({ avail: b[done].ts + H4, r: r - 2 * FEE });
}
shadow.sort((a, b) => a.avail - b.avail);
const selfAt = (ts: number) => { // ts 시점 공개된 최근 20건
  const cut = ts - LAG * H4; let lo = 0, hi = shadow.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (shadow[mid].avail <= cut) lo = mid + 1; else hi = mid; }
  if (lo < 20) return true; let s = 0; for (let j = lo - 20; j < lo; j++) s += shadow[j].r; return s > 0;
};
type Ind = 'BTC50' | 'BTC100' | 'BRD' | 'SELF' | 'VOL';
const IND: Ind[] = ['BTC50', 'BTC100', 'BRD', 'SELF', 'VOL'];
const bullCache = new Map<string, boolean>();
function bull(ind: Ind, ts: number): boolean {
  const key = `${ind}|${ts}|${LAG}`; const c = bullCache.get(key); if (c !== undefined) return c;
  let v = true;
  const bi0 = bI.get(ts); const bi = bi0 === undefined ? -1 : bi0 - 1 - LAG;
  if (ind === 'BTC50') v = bi < 300 ? true : btc[bi].close > ma(btc, bi, 300);
  else if (ind === 'BTC100') v = bi < 600 ? true : btc[bi].close > ma(btc, bi, 600);
  else if (ind === 'BRD') v = breadthAt(ts) >= 0.5;
  else if (ind === 'SELF') v = selfAt(ts);
  else if (ind === 'VOL') v = bi < 0 || isNaN(volAvg[bi]) ? true : vol180[bi] <= volAvg[bi];
  bullCache.set(key, v); return v;
}
type Act = 'F7' | 'SL' | 'HALF' | 'OFF';
interface Policy { bullAct: Act; bearAct: Act; ind?: Ind; rand?: { p: number; seed: number } }
// 플라시보: 30일 블록 단위 무작위 국면(국면은 지속되므로 블록으로)
const randBear = (ts: number, p: number, seed: number) => { let x = (Math.floor(ts / (30 * 86400e3)) * 2654435761 + seed * 97) >>> 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x % 10000) / 10000 < p; };
interface P2 { m: string; ep: number; vol: number; used: number; bars: number; last: number; sl: boolean }
function run(pol: Policy, size: number, from = 0, to = Infinity, cap = INIT) {
  let cash = cap; const open: P2[] = []; const eqs: Array<[number, number]> = [];
  let peak = cap, mdd = 0, n = 0, sumR = 0, bearN = 0, decN = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let px = 0;
      if (bar.high >= q.ep * (1 + TP / 100)) px = q.ep * (1 + TP / 100);
      else if (q.sl && bar.low <= q.ep * (1 + SLP / 100)) px = bar.close * (1 - SLIP);
      else if (q.bars >= MAXB) px = bar.close * (1 - SLIP);
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    if (open.length < 3) {
      let act: Act | null = null;
      for (const m of ORDER) {
        if (open.length >= 3) break;
        const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45 || !sigF6(bb, i - 1)) continue;
        if (open.some(q => q.m === m)) continue;
        if (act === null) {
          const isBear = pol.rand ? randBear(ts, pol.rand.p, pol.rand.seed) : pol.ind ? !bull(pol.ind, ts) : false;
          act = isBear ? pol.bearAct : pol.bullAct; decN++; if (isBear) bearN++;
        }
        if (act === 'OFF') break;
        const used = cash * size * (act === 'HALF' ? 0.5 : 1); if (used < 5000) continue;
        cash -= used; const ep = bb[i].open * (1 + SLIP);
        open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: ep, sl: act === 'SL' });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    eqs.push([ts, eq]); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = eqs.length ? eqs[eqs.length - 1][1] : cap;
  return { ret: 100 * (eq / cap - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, bearFrac: decN ? bearN / decN : 0, eqs };
}
// 50:50 혼합 — F7 과 F7_sl 을 반반 자본으로 따로 돌린 합
function runMix(size: number, from = 0, to = Infinity) {
  const a = run({ bullAct: 'F7', bearAct: 'F7' }, size, from, to, INIT / 2), b = run({ bullAct: 'SL', bearAct: 'SL' }, size, from, to, INIT / 2);
  let peak = INIT, mdd = 0; for (let k = 0; k < a.eqs.length; k++) { const e = a.eqs[k][1] + b.eqs[k][1]; peak = Math.max(peak, e); mdd = Math.max(mdd, (peak - e) / peak); }
  const e = a.eqs[a.eqs.length - 1][1] + b.eqs[b.eqs.length - 1][1];
  return { ret: 100 * (e / INIT - 1), mdd: 100 * mdd, n: a.n + b.n, avg: (a.avg * a.n + b.avg * b.n) / Math.max(a.n + b.n, 1), bearFrac: 0.5, eqs: [] as Array<[number, number]> };
}
type Runner = (size: number, from?: number, to?: number) => ReturnType<typeof run>;
const R = (pol: Policy): Runner => (s, f, t) => run(pol, s, f, t);
const sizeFor = (r: Runner, target = 17, from = 0, to = Infinity) => { let lo = 0.02, hi = 0.95; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (r(mid, from, to).mdd > target) hi = mid; else lo = mid; } return (lo + hi) / 2; };
const SP: Array<[string, number, number]> = [['22H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)], ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)],
  ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)], ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const pc = (x: number) => (x.toFixed(0) + '%').padStart(7);
const row = (lab: string, r: Runner, eq: boolean) => {
  const s = eq ? sizeFor(r) : 0.33; const o = r(s);
  const per = SP.map(([, a, b]) => pc(r(s, a, b).ret)).join('');
  console.log(`${lab.padEnd(24)}${pc(o.ret)}${pc(o.mdd)}${String(o.n).padStart(6)}${((o.avg >= 0 ? '+' : '') + o.avg.toFixed(2) + '%').padStart(8)}${(o.bearFrac * 100).toFixed(0).padStart(5)}%${eq ? ('  sz' + (s * 100).toFixed(0) + '%').padStart(7) : '       '} |${per}`);
  return o;
};
const HDR = '정책'.padEnd(24) + '총익'.padStart(7) + 'MDD'.padStart(7) + '거래'.padStart(6) + '거래당'.padStart(8) + '방어%'.padStart(6) + '       ' + ' |' + SP.map(s => s[0].padStart(7)).join('');
const MODE = process.argv[2] || 'all';
const POLS: Array<[string, Policy]> = [];
for (const ind of IND) for (const bear of ['SL', 'HALF', 'OFF'] as Act[]) POLS.push([`${ind}→${bear}`, { bullAct: 'F7', bearAct: bear, ind }]);
const BASE: Array<[string, Runner]> = [['F7 (무스톱)', R({ bullAct: 'F7', bearAct: 'F7' })], ['F7_sl (−2% 봉마감)', R({ bullAct: 'SL', bearAct: 'SL' })], ['50:50 혼합', runMix as Runner]];
if (MODE === 'all' || MODE === 'fixed' || MODE === 'eq') {
  for (const eq of (MODE === 'all' ? [false, true] : [MODE === 'eq'])) {
    console.log(`\n══ ${eq ? '동일 MDD 17%' : '33%×3 고정'} ══\n${HDR}`);
    for (const [l, r] of BASE) row(l, r, eq);
    for (const [l, p] of POLS) row(l, R(p), eq);
  }
}
if (MODE === 'all' || MODE === 'wf') {
  // 워크포워드: IS(~2024-07) 에서 15개 정책 중 동일MDD 총익 최고를 고르고 OOS 에 적용. IS 에서 사이즈도 고정.
  const IS_END = Date.UTC(2024, 7, 1);
  console.log('\n══ 워크포워드 (IS 2022-06~2024-07 선택 → OOS 2024-08~ 적용, IS 에서 정한 사이즈 그대로) ══');
  const cands: Array<[string, Runner]> = [...BASE, ...POLS.map(([l, p]) => [l, R(p)] as [string, Runner])];
  const res = cands.map(([l, r]) => { const s = sizeFor(r, 17, 0, IS_END); return { l, r, s, is: r(s, 0, IS_END).ret, oos: r(s, IS_END).ret, oosMdd: r(s, IS_END).mdd }; });
  res.sort((a, b) => b.is - a.is);
  for (const x of res) console.log(`  ${x.l.padEnd(22)} IS ${pc(x.is)}  → OOS ${pc(x.oos)} (MDD ${x.oosMdd.toFixed(0)}%)`);
  console.log(`  ▶ IS 1위 = ${res[0].l} → OOS ${res[0].oos.toFixed(0)}%   / F7 OOS ${res.find(x => x.l === 'F7 (무스톱)')!.oos.toFixed(0)}%  / F7_sl OOS ${res.find(x => x.l.startsWith('F7_sl'))!.oos.toFixed(0)}%  / 혼합 OOS ${res.find(x => x.l === '50:50 혼합')!.oos.toFixed(0)}%`);
  const oosRank = res.slice().sort((a, b) => b.oos - a.oos).map(x => x.l);
  console.log(`  IS 1위의 OOS 순위: ${oosRank.indexOf(res[0].l) + 1}/${res.length}`);
  // 정책 유형별로 IS→OOS 순위 상관
  const n = res.length; const isR = res.map((_, k) => k); const oR = res.map(x => oosRank.indexOf(x.l));
  const mi = (n - 1) / 2; let num = 0, d1 = 0, d2 = 0; for (let k = 0; k < n; k++) { num += (isR[k] - mi) * (oR[k] - mi); d1 += (isR[k] - mi) ** 2; d2 += (oR[k] - mi) ** 2; }
  console.log(`  IS↔OOS 순위상관(스피어만) ${(num / Math.sqrt(d1 * d2)).toFixed(2)}`);
}
if (MODE === 'all' || MODE === 'lag') {
  console.log('\n══ 지표 지연 +1봉 (33%×3 / 동일MDD) — 결과가 크게 바뀌면 타이밍 민감 ══');
  for (const lag of [0, 1, 6]) { LAG = lag; bullCache.clear();
    for (const [l, p] of POLS.filter(([l]) => /→(SL|HALF)$/.test(l))) { const r = R(p); const a = r(0.33); const s = sizeFor(r); console.log(`  LAG ${lag}  ${l.padEnd(14)} 고정 ${pc(a.ret)}  동일MDD ${pc(r(s).ret)}`); } }
  LAG = 0; bullCache.clear();
}
if (MODE === 'all' || MODE === 'placebo') {
  console.log('\n══ 플라시보 — 같은 방어 비율의 무작위 국면(30일 블록), 시드 8개 ══');
  for (const [l, p] of POLS) {
    const real = R(p); const rs = sizeFor(real); const rv = real(rs).ret; const frac = real(0.33).bearFrac;
    const pl: number[] = [];
    for (let sd = 1; sd <= 8; sd++) { const r = R({ bullAct: 'F7', bearAct: p.bearAct, rand: { p: frac, seed: sd } }); pl.push(r(sizeFor(r)).ret); }
    pl.sort((a, b) => a - b);
    const beat = pl.filter(x => x >= rv).length;
    console.log(`  ${l.padEnd(14)} 실제 ${pc(rv)}  방어 ${(frac * 100).toFixed(0)}%  플라시보 중앙 ${pc(pl[4])} 범위 ${pl[0].toFixed(0)}~${pl[7].toFixed(0)}%  (플라시보가 실제 이상 ${beat}/8)`);
  }
}

if (MODE === 'extra') {
  console.log('══ 추가: OFF 계열 지연 민감도 + 플라시보 시드 40개 ══');
  for (const lab of ['BTC50→OFF', 'BRD→OFF', 'BTC50→SL']) {
    const p = POLS.find(([l]) => l === lab)![1];
    const out: string[] = [];
    for (const lag of [0, 1, 6, 18]) { LAG = lag; bullCache.clear(); const r = R(p); const s = sizeFor(r); out.push(`LAG${lag} ${r(0.33).ret.toFixed(0)}%/${r(s).ret.toFixed(0)}%[25:${r(s, Date.UTC(2025,0,1), Date.UTC(2025,11,31)).ret.toFixed(0)}%]`); }
    LAG = 0; bullCache.clear();
    const real = R(p); const rv = real(sizeFor(real)).ret; const frac = real(0.33).bearFrac;
    const pl: number[] = []; for (let sd = 1; sd <= 40; sd++) { const r = R({ bullAct: 'F7', bearAct: p.bearAct, rand: { p: frac, seed: sd * 31 } }); pl.push(r(sizeFor(r)).ret); }
    pl.sort((a, b) => a - b);
    console.log(`  ${lab.padEnd(11)} ${out.join('  ')}`);
    console.log(`              플라시보40 중앙 ${pl[20].toFixed(0)}% 90분위 ${pl[36].toFixed(0)}% 최대 ${pl[39].toFixed(0)}% → 실제 ${rv.toFixed(0)}% 이상인 시드 ${pl.filter(x => x >= rv).length}/40`);
  }
}
