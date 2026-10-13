/**
 * 저점 흡수 확장 — 자산 확장 (ETH · BTC+ETH · 시점별 거래대금 상위 알트) + 공유 현금 풀(가동률)
 * 모드: eth | calib | alt | pool
 *  - eth:   ETH 15m(2024-10~) 단독, 같은 창의 BTC, 50/50(일 리밸런스), ETH 4h(2022-06~, 관통 0.5% 근사)
 *  - calib: 15m 이 없는 기간 근사의 편향 점검 — BTC 를 4h/1h 로 집계해 관통 0.5% 로 돌린 값 vs 15m 관통 0.2%
 *  - alt:   다자산 슬롯 풀. 유니버스 = 그 시점 직전 30일 업비트 거래대금(전 종목 일봉) 상위 N(BTC·ETH·스테이블 제외),
 *           그 중 경로 데이터가 있는 코인만 거래. 경로: 28코인 15m(관통 0.2%) / 120코인 4h(관통 0.5%) / 전 종목 일봉(1d 트리거, 관통 0.5%)
 *  - pool:  BTC(여러 트리거)·ETH 레그가 현금 하나를 공유(각 레그 1회 진입 시 자산의 s 배, 현금 한도) — 가동률 레버
 * 출력은 파일 리다이렉트.
 */
import fs from 'fs';
import path from 'path';
import { simLegs, type Leg } from './_bt_dip_ladder_lib';
import { loadBtc15, loadCache, loadDaily, agg, sim, toDaily, win, metrics, eqMdd, tradeStats, byRegime, byPeriod, fleetCheck, slipOf, belowAt, P, median, H, DAY, Q, OUTDIR, type Bar, type Cfg, type Series } from './_bt_dip_ladder_lib';

const MODE = process.argv[2] || 'eth';
const FOUR = 4 * H;
const save = (name: string, obj: any) => fs.writeFileSync(path.join(OUTDIR, name), JSON.stringify(obj, null, 1));
const YS = [2, 3, 4, 5], TS = [24, 48, 72, 120];
function line(lab: string, d: Series, trades: any[], a: number, b: number, expo?: number) {
  const rs = win(d, a, b); const m = metrics(rs), e = eqMdd(rs), t = tradeStats(trades, a, b), rg = byRegime(rs);
  return { txt: `${lab.padEnd(38)} 총익 ${P(m.tot).padStart(6)} CAGR ${P(m.cagr, 1).padStart(6)} MDD ${m.mdd.toFixed(1).padStart(5)}% 샤프 ${m.sharpe.toFixed(2).padStart(5)} MDD17 ${P(e.tot).padStart(6)} | 거래/연 ${t.perYr.toFixed(0).padStart(3)} 승 ${t.wr.toFixed(0)}% 평균 ${t.avg.toFixed(2)}% 최악 ${t.worst.toFixed(1)}%${expo != null ? ` 가동 ${(100 * expo).toFixed(0)}%` : ''} | a ${rg.a.mean.toFixed(1)} b ${rg.b.mean.toFixed(1)} c ${rg.c.mean.toFixed(1)}bp`, m, e, t, rg };
}
function famGrid(lab: string, bars: Bar[], barMs: number, c: Partial<Cfg>, a: number, b: number) {
  const cells: any[] = [];
  for (const y of YS) for (const T of TS) { const r = sim(bars, barMs, { tf: FOUR, rungs: [3], pen: 0.002, ...c, y, T, from: a, to: b } as Cfg); const d = toDaily(r.eqAt); const rs = win(d, a, b); const m = metrics(rs); cells.push({ y, T, sh: m.sharpe, tot: m.tot, mdd: m.mdd, e17: eqMdd(rs).tot, ra: byRegime(rs).a.mean }); }
  const ctr = cells.find(x => x.y === 3 && x.T === 72);
  return { lab, cells, txt: `${lab.padEnd(40)} 16칸 중앙 샤프 ${median(cells.map(x => x.sh)).toFixed(2)} 총익 ${P(median(cells.map(x => x.tot)))} MDD17 ${P(median(cells.map(x => x.e17)))} 양수 ${cells.filter(x => x.tot > 0).length}/16 | 국면a ${median(cells.map(x => x.ra)).toFixed(1)}bp | 중심 y3T72 총익 ${P(ctr.tot)} 샤프 ${ctr.sh.toFixed(2)} MDD ${ctr.mdd.toFixed(1)}%` };
}

// ═══════════════ ETH ═══════════════
if (MODE === 'eth') {
  const B15 = loadBtc15(), E15 = loadCache('KRW-ETH', 15);
  const a = Math.max(E15[0].ts, Date.UTC(2024, 9, 2)), b = Math.min(B15[B15.length - 1].ts, E15[E15.length - 1].ts) + Q;
  console.log(`15m 공통창 ${new Date(a).toISOString().slice(0, 10)} ~ ${new Date(b).toISOString().slice(0, 16)}`);
  const sE = slipOf('KRW-ETH');
  const fams: Array<[string, Partial<Cfg>]> = [['−3 (라이브형)', { rungs: [3] }], ['−3/−6 하락×2 (B)', { rungs: [3, 6], downMul: 2 }], ['−5', { rungs: [5] }], ['−4', { rungs: [4] }], ['−3/−6/−9 1:2:3 하락×2 (C)', { rungs: [3, 6, 9], wts: [1 / 6, 2 / 6, 3 / 6], downMul: 2 }]];
  const out: any = { a, b, fams: [] };
  for (const [l, c] of fams) {
    const fb = famGrid(`BTC 15m ${l}`, B15, Q, { ...c, slip: 0.0002 }, a, b); console.log(fb.txt);
    const fe = famGrid(`ETH 15m ${l}`, E15, Q, { ...c, slip: sE }, a, b); console.log(fe.txt);
    out.fams.push({ l, btc: fb.cells, eth: fe.cells });
  }
  console.log('\n── 중심칸 상세 + 50/50 (일 리밸런스) ──');
  for (const [l, c] of fams.slice(0, 3)) {
    const rb = sim(B15, Q, { tf: FOUR, pen: 0.002, y: 3, T: 72, slip: 0.0002, ...c, from: a, to: b } as Cfg), re = sim(E15, Q, { tf: FOUR, pen: 0.002, y: 3, T: 72, slip: sE, ...c, from: a, to: b } as Cfg);
    const db = toDaily(rb.eqAt), de = toDaily(re.eqAt); const dm: Series = new Map(); for (const [t, r] of db) if (de.has(t)) dm.set(t, (r + de.get(t)!) / 2);
    const xs = [db, de].map(d => [...d].filter(([t]) => t >= a && t < b).map(([t, r]) => r));
    const cdays = [...db.keys()].filter(t => de.has(t) && t >= a && t < b);
    const cc = (() => { const A = cdays.map(t => db.get(t)!), B = cdays.map(t => de.get(t)!); const ma = A.reduce((x, y) => x + y, 0) / A.length, mb = B.reduce((x, y) => x + y, 0) / B.length; let s = 0, va = 0, vb = 0; for (let i = 0; i < A.length; i++) { s += (A[i] - ma) * (B[i] - mb); va += (A[i] - ma) ** 2; vb += (B[i] - mb) ** 2; } return s / Math.sqrt(va * vb); })();
    console.log(line(`BTC ${l}`, db, rb.trades, a, b, rb.expo).txt); console.log(line(`ETH ${l}`, de, re.trades, a, b, re.expo).txt);
    console.log(line(`BTC+ETH 50/50 ${l}`, dm, [...rb.trades, ...re.trades], a, b).txt + ` · BTC↔ETH 일수익 상관 ${cc.toFixed(2)}`);
    void xs;
  }
  // ETH 4h 근사 (관통 0.5%) — 2022-06~
  const E4 = loadCache('KRW-ETH', 240); const a4 = Date.UTC(2022, 6, 1), b4 = E4[E4.length - 1].ts + FOUR;
  console.log(`\n── ETH 4h 근사(관통 0.5%, 봉 안 순서 불명 → 체결봉 TP 금지) ${new Date(a4).toISOString().slice(0, 10)}~${new Date(b4).toISOString().slice(0, 10)} ──`);
  const B4 = agg(B15, FOUR);
  for (const [l, c] of fams) {
    console.log(famGrid(`ETH 4h ${l}`, E4, FOUR, { ...c, pen: 0.005, slip: sE }, a4, b4).txt);
    console.log(famGrid(`BTC 4h ${l}`, B4, FOUR, { ...c, pen: 0.005, slip: 0.0002 }, a4, B15[B15.length - 1].ts).txt);
  }
  for (const [l, c] of fams.slice(0, 2)) {
    const re = sim(E4, FOUR, { tf: FOUR, pen: 0.005, y: 3, T: 72, slip: sE, ...c, from: a4, to: b4 } as Cfg); const de = toDaily(re.eqAt);
    console.log(line(`ETH 4h ${l} y3T72`, de, re.trades, a4, b4, re.expo).txt);
    console.log('   기간', byPeriod(de).filter(([, v]) => v !== 0).map(([x, v]) => `${x} ${P(v)}`).join(' · '));
  }
  save('eth.json', out);
}

// ═══════════════ 근사 보정 ═══════════════
if (MODE === 'calib') {
  const B15 = loadBtc15(); const a = Date.UTC(2021, 3, 1), b = B15[B15.length - 1].ts;
  const B1 = agg(B15, H), B4 = agg(B15, FOUR);
  for (const [l, c] of [['4h −3 (라이브형)', { rungs: [3] }], ['4h −3/−6 하락×2 (B)', { rungs: [3, 6], downMul: 2 }], ['4h −5', { rungs: [5] }]] as Array<[string, Partial<Cfg>]>) {
    console.log(famGrid(`15m 관통0.2% ${l}`, B15, Q, c, a, b).txt);
    console.log(famGrid(`1h  관통0.2% ${l}`, B1, H, c, a, b).txt);
    console.log(famGrid(`1h  관통0.5% ${l}`, B1, H, { ...c, pen: 0.005 }, a, b).txt);
    console.log(famGrid(`4h  관통0.2% ${l}`, B4, FOUR, c, a, b).txt);
    console.log(famGrid(`4h  관통0.5% ${l}`, B4, FOUR, { ...c, pen: 0.005 }, a, b).txt);
    console.log(famGrid(`15m 관통0.5% ${l}`, B15, Q, { ...c, pen: 0.005 }, a, b).txt);
    console.log('');
  }
}

// ═══════════════ 다자산 풀 엔진 ═══════════════
const STABLE = new Set(['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'TUSD', 'PYUSD', 'FDUSD', 'USDE', 'RLUSD', 'EURC', 'USD0', 'USDG']);
let RANKS: Map<number, string[]> | null = null;   // 일 시작 ts → 그날 종가까지의 30일 거래대금 순위(알트)
function ranks(): Map<number, string[]> {
  if (RANKS) return RANKS;
  const dir = path.resolve(process.cwd(), 'data/research-ext/daily'); const mk = fs.readdirSync(dir).filter(f => f.startsWith('KRW-')).map(f => f.replace('.json', '')).filter(m => !STABLE.has(m.slice(4)) && m !== 'KRW-BTC' && m !== 'KRW-ETH');
  const val = new Map<string, Map<number, number>>(); const days = new Set<number>();
  for (const m of mk) { const d = loadDaily(m); const mp = new Map<number, number>(); for (const x of d) { mp.set(x.ts, x.val ?? 0); days.add(x.ts); } val.set(m, mp); }
  const D = [...days].sort((a, b) => a - b); RANKS = new Map();
  const sums = new Map<string, { s: number; q: number[]; n: number }>(); for (const m of mk) sums.set(m, { s: 0, q: [], n: 0 });
  for (const d of D) {
    const arr: Array<[string, number]> = [];
    for (const m of mk) { const st = sums.get(m)!; const v = val.get(m)!.get(d); const x = v ?? 0; st.q.push(x); st.s += x; if (st.q.length > 30) st.s -= st.q.shift()!; if (v != null) st.n++; if (v != null && st.n >= 30) arr.push([m, st.s]); }
    arr.sort((x, y) => y[1] - x[1]); RANKS.set(d, arr.slice(0, 40).map(x => x[0]));
  }
  return RANKS;
}
interface PoolCfg { N: number; K: number; x: number; y: number; T: number; pen: number; tf: number; downMul?: number; regime?: 'all' | 'below' | 'above'; slipMul?: number; fee?: number; from: number; to: number; placebo?: { p: number; seed: number }; sizeFrac?: number }
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** 코인별 봉(같은 격자) → 공유 현금 K 슬롯 풀. 유니버스는 직전 확정일의 상위 N 중 데이터 있는 코인. */
function simPool(data: Map<string, Bar[]>, barMs: number, c: PoolCfg) {
  const R = ranks(); const FEE = c.fee ?? 0.0005;
  const idx = new Map<string, Map<number, Bar>>(); const tsSet = new Set<number>();
  for (const [m, bs] of data) { const mp = new Map<number, Bar>(); for (const b of bs) if (b.ts >= c.from - 2 * c.tf && b.ts < c.to) { mp.set(b.ts, b); tsSet.add(b.ts); } idx.set(m, mp); }
  const TL = [...tsSet].sort((a, b) => a - b);
  const rnd = c.placebo ? rng(c.placebo.seed) : null;
  let cash = 1; const pos = new Map<string, { units: number; cost: number; pe: number; te: number; cap: number; tpOn: number }>();
  const orders = new Map<string, { lim: number; until: number }>(); const last = new Map<string, number>(); const prevC = new Map<string, number>();
  const trades: any[] = []; const eqAt: Array<[number, number]> = []; let expoS = 0, expoN = 0, cover = 0, coverN = 0, starts = 0, elig = 0;
  for (const t of TL) {
    if (t < c.from) { for (const [m, mp] of idx) { const b = mp.get(t); if (b) prevC.set(m, b.c); } continue; }
    const boundary = t % c.tf === 0; const day = Math.floor(t / DAY) * DAY - DAY; const uni = R.get(day) ?? R.get(day - DAY) ?? [];
    const top = uni.slice(0, c.N);
    // 청산
    for (const [m, p] of [...pos]) {
      const b = idx.get(m)!.get(t); if (!b) continue;
      let px = 0, why = '';
      if (t - p.te >= c.T * H) { px = b.o * (1 - slipOf(m) * (c.slipMul ?? 1)); why = 'TIME'; }
      else if (t >= p.tpOn && b.h >= p.pe * (1 + c.y / 100) * (1 + c.pen)) { px = p.pe * (1 + c.y / 100); why = 'TP'; }
      if (px) { const got = p.units * px * (1 - FEE); cash += got; trades.push({ m, te: p.te, tx: t, ret: got / p.cost - 1, reason: why, used: p.cost / p.cap }); pos.delete(m); }
    }
    // 경계: 주문 갱신
    if (boundary) {
      orders.clear();
      const eq = cash + [...pos].reduce((s, [m, p]) => s + p.units * (last.get(m) ?? p.pe), 0);
      const ok = c.regime === 'below' ? belowAt(t) : c.regime === 'above' ? !belowAt(t) : true;
      const mul = belowAt(t) && c.downMul ? c.downMul : 1;
      coverN += c.N; cover += top.filter(m => idx.has(m)).length;
      if (ok) for (const m of top) {
        if (pos.has(m) || !idx.has(m)) continue; const pc = prevC.get(m); if (!pc) continue;
        elig++;
        if (rnd) { if (pos.size < c.K && rnd() < c.placebo!.p) { const b = idx.get(m)!.get(t); if (!b) continue; const e0 = b.o * (1 + slipOf(m) * (c.slipMul ?? 1)); const cap = Math.min(eq / c.K, cash); if (cap < 1e-6) continue; cash -= cap; pos.set(m, { units: cap * (1 - FEE) / e0, cost: cap, pe: e0, te: t, cap, tpOn: t + barMs }); starts++; } continue; }
        orders.set(m, { lim: pc * (1 - c.x * mul / 100), until: t + c.tf });
      }
    }
    // 체결(순위 우선)
    if (orders.size) for (const m of top) {
      const o = orders.get(m); if (!o || t >= o.until || pos.size >= c.K) continue; const b = idx.get(m)!.get(t); if (!b) continue;
      if (b.l <= o.lim * (1 - c.pen)) {
        const eq = cash + [...pos].reduce((s, [mm, p]) => s + p.units * (last.get(mm) ?? p.pe), 0);
        const cap = Math.min(eq / c.K * (c.sizeFrac ?? 1), cash); if (cap < 1e-6) continue;
        cash -= cap; pos.set(m, { units: cap * (1 - FEE) / o.lim, cost: cap, pe: o.lim, te: t, cap, tpOn: t + barMs }); orders.delete(m); starts++;
      }
    }
    for (const [m, mp] of idx) { const b = mp.get(t); if (b) { last.set(m, b.c); prevC.set(m, b.c); } }
    const inv = [...pos].reduce((s, [m, p]) => s + p.units * (last.get(m) ?? p.pe), 0); const eq = cash + inv; expoS += inv / eq; expoN++;
    eqAt.push([t + barMs, eq]);
  }
  return { eqAt, trades, expo: expoS / Math.max(expoN, 1), cover: cover / Math.max(coverN, 1), starts, elig };
}

if (MODE === 'alt') {
  const which = process.argv[3] || 'all';
  const out: any = {};
  const sets: Array<{ lab: string; barMs: number; pen: number; tf: number; load: () => Map<string, Bar[]>; a: number; b: number }> = [];
  const L28 = () => { const m = new Map<string, Bar[]>(); for (const f of fs.readdirSync('data/candle-cache').filter(f => f.includes('_15m_'))) { const k = f.split('_')[0]; if (k === 'KRW-BTC' || k === 'KRW-ETH') continue; m.set(k, loadCache(k, 15)); } return m; };
  const L120 = () => { const m = new Map<string, Bar[]>(); const ks = new Set(fs.readdirSync('data/candle-cache').filter(f => f.includes('_240m_2024-08-01') || f.includes('_240m_2025-08-01')).map(f => f.split('_')[0])); for (const k of ks) { if (k === 'KRW-BTC' || k === 'KRW-ETH') continue; m.set(k, loadCache(k, 240)); } return m; };
  const LD = () => { const m = new Map<string, Bar[]>(); for (const f of fs.readdirSync('data/research-ext/daily').filter(f => f.startsWith('KRW-'))) { const k = f.replace('.json', ''); if (k === 'KRW-BTC' || k === 'KRW-ETH' || STABLE.has(k.slice(4))) continue; m.set(k, loadDaily(k)); } return m; };
  const A = Date.UTC(2024, 9, 2), Bend = Date.UTC(2026, 7, 24);   // 28코인 15m ∩ 120코인 4h 공통창
  if (which === 'all' || which === '15m') sets.push({ lab: '28코인 15m (관통0.2%)', barMs: Q, pen: 0.002, tf: FOUR, load: L28, a: A, b: Bend });
  if (which === 'all' || which === '4h') sets.push({ lab: '120코인 4h (관통0.5%)', barMs: FOUR, pen: 0.005, tf: FOUR, load: L120, a: A, b: Bend });
  if (which === 'all' || which === '4h28') sets.push({ lab: '28코인 4h (관통0.5%, 2022-07~)', barMs: FOUR, pen: 0.005, tf: FOUR, load: () => { const m = new Map<string, Bar[]>(); for (const f of fs.readdirSync('data/candle-cache').filter(f => f.includes('_240m_2022-06-10_2026-10-13'))) { const k = f.split('_')[0]; if (k === 'KRW-BTC' || k === 'KRW-ETH') continue; m.set(k, loadCache(k, 240)); } return m; }, a: Date.UTC(2022, 6, 1), b: Date.UTC(2026, 9, 1) });
  const S28 = new Set(fs.readdirSync('data/candle-cache').filter(f => f.includes('_15m_')).map(f => f.split('_')[0]));
  if (which === '4h28w') sets.push({ lab: '28코인 4h (관통0.5%, 같은 창)', barMs: FOUR, pen: 0.005, tf: FOUR, load: () => { const m = L120(); for (const k of [...m.keys()]) if (!S28.has(k)) m.delete(k); return m; }, a: A, b: Bend });
  if (which === '4hx28') sets.push({ lab: '120코인 중 28 제외 4h (관통0.5%)', barMs: FOUR, pen: 0.005, tf: FOUR, load: () => { const m = L120(); for (const k of [...m.keys()]) if (S28.has(k)) m.delete(k); return m; }, a: A, b: Bend });
  if (which === '15m05') sets.push({ lab: '28코인 15m (관통0.5%)', barMs: Q, pen: 0.005, tf: FOUR, load: L28, a: A, b: Bend });
  for (const S of sets) {
    const data = S.load(); console.log(`\n■ ${S.lab} · ${data.size}코인 · ${new Date(S.a).toISOString().slice(0, 10)}~${new Date(S.b).toISOString().slice(0, 10)}`);
    const rows: any[] = [];
    for (const N of [5, 10]) for (const x of [3, 5, 7, 10]) for (const y of [3, 5]) for (const T of [24, 72]) for (const dm of [1, 2]) {
      const K = N === 5 ? 3 : 5;
      const r = simPool(data, S.barMs, { N, K, x, y, T, pen: S.pen, tf: S.tf, downMul: dm === 1 ? undefined : dm, from: S.a, to: S.b });
      const d = toDaily(r.eqAt); const rs = win(d, S.a, S.b); const m = metrics(rs); const t = tradeStats(r.trades, S.a, S.b); const rg = byRegime(rs);
      rows.push({ N, K, x, y, T, dm, tot: m.tot, sh: m.sharpe, mdd: m.mdd, e17: eqMdd(rs).tot, n: t.n, perYr: t.perYr, wr: t.wr, avg: t.avg, worst: t.worst, expo: r.expo, cover: r.cover, ra: rg.a.mean, rb: rg.b.mean, rc: rg.c.mean });
    }
    for (const N of [5, 10]) for (const x of [3, 5, 7, 10]) for (const dm of [1, 2]) {
      const g = rows.filter(r => r.N === N && r.x === x && r.dm === dm);
      console.log(`  상위${N} −${x}%${dm === 2 ? ' 하락×2' : '      '} (y3/5×T24/72 4칸) 샤프 중앙 ${median(g.map(r => r.sh)).toFixed(2)} 총익 중앙 ${P(median(g.map(r => r.tot)))} MDD 중앙 ${median(g.map(r => r.mdd)).toFixed(0)}% 양수 ${g.filter(r => r.tot > 0).length}/4 거래/연 ${median(g.map(r => r.perYr)).toFixed(0)} 승 ${median(g.map(r => r.wr)).toFixed(0)}% 평균 ${median(g.map(r => r.avg)).toFixed(2)}% 가동 ${(100 * median(g.map(r => r.expo))).toFixed(0)}% 데이터커버 ${(100 * g[0].cover).toFixed(0)}% | a ${median(g.map(r => r.ra)).toFixed(1)} b ${median(g.map(r => r.rb)).toFixed(1)} c ${median(g.map(r => r.rc)).toFixed(1)}bp`);
    }
    console.log(`  전체 ${rows.length}칸: 양수 ${rows.filter(r => r.tot > 0).length} · 샤프 중앙 ${median(rows.map(r => r.sh)).toFixed(2)}`);
    // 플라시보(상위10 −5 y5 T72 기준 빈도)
    const ref = { N: 10, K: 5, x: 5, y: 5, T: 72, pen: S.pen, tf: S.tf, from: S.a, to: S.b };
    const r0 = simPool(data, S.barMs, ref); const m0 = metrics(win(toDaily(r0.eqAt), S.a, S.b));
    const p = r0.starts / Math.max(r0.elig, 1); const pl: number[] = [];
    for (let s = 1; s <= 20; s++) { const rp = simPool(data, S.barMs, { ...ref, placebo: { p, seed: s * 104729 } }); pl.push(metrics(win(toDaily(rp.eqAt), S.a, S.b)).tot); }
    console.log(`  플라시보(상위10 −5 y5 T72, 20회): 실제 ${P(m0.tot)} vs 무작위 중앙 ${P(median(pl))} 최대 ${P(Math.max(...pl))} · 실제 이상 ${pl.filter(v => v >= m0.tot).length}/20`);
    out[S.lab] = rows;
  }
  save(`alt-${which}.json`, out);
}

// 전 종목 일봉: 1d 트리거(전일 종가 −x 지정가, 일봉 관통 0.5%) — 2021-04~
if (MODE === 'altd') {
  const data = new Map<string, Bar[]>(); for (const f of fs.readdirSync('data/research-ext/daily').filter(f => f.startsWith('KRW-'))) { const k = f.replace('.json', ''); if (k === 'KRW-BTC' || k === 'KRW-ETH' || STABLE.has(k.slice(4))) continue; data.set(k, loadDaily(k)); }
  const a = Date.UTC(2021, 3, 1), b = Date.UTC(2026, 9, 1); const rows: any[] = [];
  console.log(`■ 전 종목 일봉 ${data.size}코인 · 1d 트리거 · 관통 0.5% · ${new Date(a).toISOString().slice(0, 10)}~`);
  for (const N of [5, 10, 20]) for (const x of [5, 8, 12]) for (const y of [3, 5, 8]) for (const T of [48, 120]) for (const dm of [1, 2]) {
    const K = N === 5 ? 3 : 5;
    const r = simPool(data, DAY, { N, K, x, y, T, pen: 0.005, tf: DAY, downMul: dm === 1 ? undefined : dm, from: a, to: b });
    const d = toDaily(r.eqAt); const rs = win(d, a, b); const m = metrics(rs); const t = tradeStats(r.trades, a, b); const rg = byRegime(rs);
    rows.push({ N, x, y, T, dm, tot: m.tot, sh: m.sharpe, mdd: m.mdd, perYr: t.perYr, wr: t.wr, avg: t.avg, expo: r.expo, ra: rg.a.mean, rb: rg.b.mean, rc: rg.c.mean, per: byPeriod(d) });
  }
  for (const N of [5, 10, 20]) for (const x of [5, 8, 12]) for (const dm of [1, 2]) {
    const g = rows.filter(r => r.N === N && r.x === x && r.dm === dm);
    console.log(`  상위${N} −${x}%${dm === 2 ? ' 하락×2' : '      '} (6칸) 샤프 중앙 ${median(g.map(r => r.sh)).toFixed(2)} 총익 중앙 ${P(median(g.map(r => r.tot)))} MDD 중앙 ${median(g.map(r => r.mdd)).toFixed(0)}% 양수 ${g.filter(r => r.tot > 0).length}/6 거래/연 ${median(g.map(r => r.perYr)).toFixed(0)} 평균 ${median(g.map(r => r.avg)).toFixed(2)}% | a ${median(g.map(r => r.ra)).toFixed(1)} b ${median(g.map(r => r.rb)).toFixed(1)} c ${median(g.map(r => r.rc)).toFixed(1)}bp | 기간(중앙) ${g[0].per.map((_: any, i: number) => `${g[0].per[i][0]} ${P(median(g.map(r => r.per[i][1])))}`).join(' ')}`);
  }
  console.log(`  전체 ${rows.length}칸: 양수 ${rows.filter(r => r.tot > 0).length} · 샤프 중앙 ${median(rows.map(r => r.sh)).toFixed(2)}`);
  save('alt-daily.json', rows);
}

if (MODE === 'pool') {
  const B15 = loadBtc15(), E15 = loadCache('KRW-ETH', 15);
  const base = { pen: 0.002, fee: 0.0005 } as const;
  const LIVE = (sz: number): Leg => ({ name: 'BTC 4h−3', bars: B15, barMs: Q, size: sz, cfg: { ...base, tf: FOUR, rungs: [3], y: 3, T: 72, slip: 0.0002 } as Cfg });
  const BB = (sz: number): Leg => ({ name: 'BTC B', bars: B15, barMs: Q, size: sz, cfg: { ...base, tf: FOUR, rungs: [3, 6], downMul: 2, y: 3, T: 72, slip: 0.0002 } as Cfg });
  const D5 = (sz: number): Leg => ({ name: 'BTC 4h−5', bars: B15, barMs: Q, size: sz, cfg: { ...base, tf: FOUR, rungs: [5], y: 3, T: 72, slip: 0.0002 } as Cfg });
  const H3 = (sz: number): Leg => ({ name: 'BTC 1h−3', bars: B15, barMs: Q, size: sz, cfg: { ...base, tf: H, rungs: [3], y: 3, T: 24, slip: 0.0002 } as Cfg });
  const EB = (sz: number): Leg => ({ name: 'ETH B', bars: E15, barMs: Q, size: sz, cfg: { ...base, tf: FOUR, rungs: [3, 6], downMul: 2, y: 3, T: 72, slip: 0.0005 } as Cfg });
  const E5 = (sz: number): Leg => ({ name: 'ETH 4h−5', bars: E15, barMs: Q, size: sz, cfg: { ...base, tf: FOUR, rungs: [5], y: 3, T: 72, slip: 0.0005 } as Cfg });
  const run = (lab: string, legs: Leg[], a: number, b: number) => {
    const r = simLegs(legs, a, b); const d = toDaily(r.eqAt); const L = line(lab, d, r.trades, a, b, r.expo);
    const per = byPeriod(d).filter(([, v]) => v !== 0).map(([x, v]) => `${x} ${P(v)}`).join(' · ');
    console.log(L.txt); console.log('    기간 ' + per);
    return { lab, d, ...L.m, e17: L.e.tot, rg: L.rg, expo: r.expo };
  };
  const A = Date.UTC(2021, 3, 1), Bn = B15[B15.length - 1].ts;
  console.log('■ BTC 레그만, 2021-04~ (15m, 관통 0.2%)');
  const res: any[] = [];
  res.push(run('LIVE 단독 (검증: sim 과 같아야)', [LIVE(1)], A, Bn));
  res.push(run('B 단독', [BB(1)], A, Bn));
  res.push(run('LIVE+1h−3+4h−5 각 100% 선착순', [LIVE(1), H3(1), D5(1)], A, Bn));
  res.push(run('LIVE+1h−3+4h−5 각 50%', [LIVE(0.5), H3(0.5), D5(0.5)], A, Bn));
  res.push(run('LIVE+1h−3+4h−5 각 33%', [LIVE(1 / 3), H3(1 / 3), D5(1 / 3)], A, Bn));
  res.push(run('B+1h−3+4h−5 각 50%', [BB(0.5), H3(0.5), D5(0.5)], A, Bn));
  res.push(run('B 100% + 4h−5 100%', [BB(1), D5(1)], A, Bn));
  res.push(run('B 50% + LIVE 50%', [BB(0.5), LIVE(0.5)], A, Bn));
  const A2 = Date.UTC(2024, 9, 2), B2 = Math.min(Bn, E15[E15.length - 1].ts);
  console.log('\n■ BTC+ETH 레그, 2024-10~ (15m 공통창)');
  res.push(run('LIVE 단독', [LIVE(1)], A2, B2));
  res.push(run('B 단독', [BB(1)], A2, B2));
  res.push(run('BTC B 100% + ETH B 100% 선착순', [BB(1), EB(1)], A2, B2));
  res.push(run('BTC B 50% + ETH B 50%', [BB(0.5), EB(0.5)], A2, B2));
  res.push(run('LIVE 50% + ETH B 50%', [LIVE(0.5), EB(0.5)], A2, B2));
  res.push(run('LIVE 100% + ETH B 100% 선착순', [LIVE(1), EB(1)], A2, B2));
  res.push(run('BTC B·BTC 4h−5·ETH B·ETH 4h−5 각 50%', [BB(0.5), D5(0.5), EB(0.5), E5(0.5)], A2, B2));
  res.push(run('BTC LIVE·1h−3·4h−5·ETH B 각 50%', [LIVE(0.5), H3(0.5), D5(0.5), EB(0.5)], A2, B2));
  console.log('\n── 함대 보완성 (2024-11-22~2026-09-30) ──');
  for (const r of res) { const fc = fleetCheck(r.d); console.log(`${r.lab.padEnd(38)} 함대균등합 상관 ${fc.corr_fleet.toFixed(2)} · BTC_DIP 상관 ${fc.corr_BTC_DIP.toFixed(2)} · 함대 손실일(${fc.lossDays}일) 평균 ${fc.meOnLoss_bp.toFixed(1)}bp (BTC_DIP ${fc.dipOnLoss_bp.toFixed(1)}bp) · BTC_DIP 자리 교체 시 함대 샤프 ${fc.fleetSharpe.toFixed(2)}→${fc.swapSharpe.toFixed(2)} MDD ${fc.fleetMdd.toFixed(1)}→${fc.swapMdd.toFixed(1)}%`); }
  save('pool.json', res.map(({ d, ...o }) => o));
}

if (MODE === 'poolrob') {
  const B15 = loadBtc15(); const A = Date.UTC(2021, 3, 1), Bn = B15[B15.length - 1].ts;
  const mk = (name: string, tf: number, rungs: number[], T: number, sz: number, ex: Partial<Cfg>): Leg => ({ name, bars: B15, barMs: Q, size: sz, cfg: { pen: 0.002, fee: 0.0005, slip: 0.0002, tf, rungs, y: 3, T, ...ex } as Cfg });
  const S1 = Date.UTC(2024, 0, 1);
  for (const [vl, ex] of [['기본', {}], ['관통 0.5%', { pen: 0.005 }], ['비용×2', { fee: 0.001, slip: 0.0004 }], ['주문지연 30분', { delay: 30 }]] as Array<[string, Partial<Cfg>]>) {
    console.log(`\n■ ${vl}`);
    for (const [lab, legs] of [
      ['LIVE 100%', [mk('L', FOUR, [3], 72, 1, ex)]],
      ['LIVE 50% 단독', [mk('L', FOUR, [3], 72, 0.5, ex)]],
      ['LIVE·1h−3(T24)·4h−5 각 50%', [mk('L', FOUR, [3], 72, 0.5, ex), mk('H', H, [3], 24, 0.5, ex), mk('D', FOUR, [5], 72, 0.5, ex)]],
      ['LIVE·1h−3(T72)·4h−5 각 50%', [mk('L', FOUR, [3], 72, 0.5, ex), mk('H', H, [3], 72, 0.5, ex), mk('D', FOUR, [5], 72, 0.5, ex)]],
      ['LIVE·4h−5 각 50%', [mk('L', FOUR, [3], 72, 0.5, ex), mk('D', FOUR, [5], 72, 0.5, ex)]],
      ['LIVE·4h−4·4h−5 각 50%', [mk('L', FOUR, [3], 72, 0.5, ex), mk('X', FOUR, [4], 72, 0.5, ex), mk('D', FOUR, [5], 72, 0.5, ex)]],
      ['B·1h−3(T24)·4h−5 각 50%', [mk('B', FOUR, [3, 6], 72, 0.5, { downMul: 2, ...ex }), mk('H', H, [3], 24, 0.5, ex), mk('D', FOUR, [5], 72, 0.5, ex)]],
    ] as Array<[string, Leg[]]>) {
      const r = simLegs(legs, A, Bn); const d = toDaily(r.eqAt); const L = line(lab, d, r.trades, A, Bn, r.expo);
      const is = metrics(win(d, A, S1)), oos = metrics(win(d, S1, Bn));
      console.log(L.txt + ` | IS21-23 ${P(is.tot)} 샤프 ${is.sharpe.toFixed(2)} · OOS24~ ${P(oos.tot)} 샤프 ${oos.sharpe.toFixed(2)}`);
      if (vl === '기본') console.log('    기간 ' + byPeriod(d).map(([x, v]) => `${x} ${P(v)}`).join(' · '));
    }
  }
}
