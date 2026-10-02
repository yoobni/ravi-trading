/**
 * 축 I — 듀얼 모멘텀 로테이션 (BTC ↔ ETH ↔ 현금/USDT) (2026-10-02)
 * 업비트 일봉(KST 09 시작). 판단 = 일봉 i 종가, 체결 = i+1 시가(+delay 일). 수익 = 시가→시가.
 * 비용(편도): 수수료 0.05% + 슬리피지 max(0.05%, 스프레드½). 자산 교체 = 매도+매수 2편도.
 * 기준선: BTC 보유, BTC_TREND(BTC>SMA50). 반증: N 고원, 워크포워드(2018~21 → 2022~), 플라시보(같은 현금 타이밍, BTC/ETH 무작위 블록),
 *   비용×2/×4, 지연 1일, 연도별, 동일위험 MDD17, BTC_TREND·F7 상관/합성.
 */
import fs from 'fs';
import path from 'path';

const D = 86400e3;
const load = (m: string) => {
  const b: any[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `data/research-ext/daily/${m}.json`), 'utf8'));
  return b.filter(x => x.ts + D <= Date.UTC(2026, 9, 2));   // 오늘(미완성) 봉 제외
};
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const A = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
const RAW = new Map(A.map(m => [m, load(m)]));
const USDT = load('KRW-USDT');
// 공통 날짜축: BTC 기준
const TS = RAW.get('KRW-BTC')!.map(x => x.ts);
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const UIDX = new Map(USDT.map((x, i) => [x.ts, i]));
const leg = (m: string) => 0.0005 + Math.max(0.0005, (SPREAD[m] ?? 10) / 2 / 1e4);
const USDT_LEG = 0.0005 + 0.0005;

const bar = (m: string, ts: number) => { const i = IDX.get(m)!.get(ts); return i === undefined ? null : RAW.get(m)![i]; };
const closeAgo = (m: string, ts: number, k: number) => { const i = IDX.get(m)!.get(ts); if (i === undefined || i - k < 0) return null; return RAW.get(m)![i - k].close; };
const sma = (m: string, ts: number, n: number) => { const i = IDX.get(m)!.get(ts); if (i === undefined || i < n - 1) return null; let s = 0; const b = RAW.get(m)!; for (let j = i - n + 1; j <= i; j++) s += b[j].close; return s / n; };
const ret = (m: string, ts: number, n: number) => { const c = closeAgo(m, ts, 0), p = closeAgo(m, ts, n); return c && p ? c / p - 1 : null; };

type Hold = string;                  // 'CASH' | 'USDT' | market
type Policy = (ts: number, cur: Hold) => Hold;

/** 시가→시가 일수익 시계열. delay = 판단 후 체결까지 추가 일수. */
function simulate(pol: Policy, opt: { costMult?: number; delay?: number; from?: number; to?: number; cashAs?: 'CASH' | 'USDT' } = {}) {
  const cm = opt.costMult ?? 1, dl = opt.delay ?? 0, from = opt.from ?? 0, to = opt.to ?? Infinity;
  const out: { ts: number; r: number; h: Hold }[] = [];
  let cur: Hold = 'CASH'; const queue: Hold[] = [];
  let sw = 0;
  for (let k = 0; k + 2 + dl < TS.length; k++) {
    const t = TS[k];
    let want = pol(t, cur);
    if (want === 'CASH' && opt.cashAs === 'USDT') want = 'USDT';
    queue.push(want);
    if (queue.length <= dl) continue;
    const target = queue.shift()!;
    const tE = TS[k + 1 + dl], tN = TS[k + 2 + dl];       // 체결일 시가 → 다음날 시가
    if (tE < from || tE > to) { cur = target; continue; }
    let r = 0;
    if (target !== cur) {
      const legs = (cur === 'CASH' ? 0 : cur === 'USDT' ? USDT_LEG : leg(cur)) + (target === 'CASH' ? 0 : target === 'USDT' ? USDT_LEG : leg(target));
      r -= legs * cm; sw++;
    }
    cur = target;
    if (cur === 'USDT') {
      const a = UIDX.get(tE), b = UIDX.get(tN);
      if (a !== undefined && b !== undefined) r += USDT[b].open / USDT[a].open - 1;
    } else if (cur !== 'CASH') {
      const a = bar(cur, tE), b = bar(cur, tN);
      if (a && b) r += b.open / a.open - 1;
    }
    out.push({ ts: tE, r, h: cur });
  }
  return { out, sw };
}

const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[], T = 17) => { const s = st(rs); if (s.mdd <= T) return { f: 1, ...s }; let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > T) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const Y = (y: number) => Date.UTC(y, 0, 1);
const YRS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const yearly = (rs: { ts: number; r: number }[], f: number) => YRS.map(y => P(st(rs.filter(x => new Date(x.ts).getUTCFullYear() === y), f).ret).padStart(6)).join('');
const show = (lab: string, rs: { ts: number; r: number; h?: Hold }[], sw?: number) => {
  const s = st(rs), e = eq(rs);
  const expo = rs.length ? 100 * rs.filter(x => x.h && x.h !== 'CASH' && x.h !== 'USDT').length / rs.length : 0;
  console.log(`${lab.padEnd(34)}${P(s.ret).padStart(9)} MDD${s.mdd.toFixed(0).padStart(4)}% | eq17 ${P(e.ret).padStart(6)} f${e.f.toFixed(2)} |${yearly(rs, e.f)}${sw != null ? `  전환${sw} 노출${expo.toFixed(0)}%` : ''}`);
  return e.ret;
};

// ── 정책들 ──
const BTC_HOLD: Policy = () => 'KRW-BTC';
const BTC_TREND = (n = 50): Policy => (t) => { const c = closeAgo('KRW-BTC', t, 0), s = sma('KRW-BTC', t, n); return c && s && c > s ? 'KRW-BTC' : 'CASH'; };
/** 듀얼 모멘텀: 후보 중 N일 수익 최대 → 절대 필터(abs: 'ret' = 그 수익>0, 'sma' = 그 자산 > SMA50, 'btc' = BTC>SMA50) */
const DUAL = (N: number, abs: 'ret' | 'sma' | 'btc', uni = ['KRW-BTC', 'KRW-ETH'], every = 1): Policy => {
  let lastDecide = -Infinity, last: Hold = 'CASH';
  return (t) => {
    if (t - lastDecide < every * D - 1) return last;
    lastDecide = t;
    const cands = uni.map(m => ({ m, r: ret(m, t, N) })).filter(x => x.r != null) as { m: string; r: number }[];
    if (!cands.length) return (last = 'CASH');
    const best = cands.sort((a, b) => b.r - a.r)[0];
    let ok = true;
    if (abs === 'ret') ok = best.r > 0;
    else if (abs === 'sma') { const c = closeAgo(best.m, t, 0), s = sma(best.m, t, 50); ok = !!(c && s && c > s); }
    else { const c = closeAgo('KRW-BTC', t, 0), s = sma('KRW-BTC', t, 50); ok = !!(c && s && c > s); }
    return (last = ok ? best.m : 'CASH');
  };
};
/** ETH/BTC 비율 추세: 비율 > SMA_K → ETH, 아니면 BTC. 현금 필터 = BTC>SMA50(또는 선택 자산 자신의 SMA50). */
const RATIO = (K: number, cash: 'btc' | 'own' | 'none'): Policy => (t) => {
  const iE = IDX.get('KRW-ETH')!.get(t), iB = IDX.get('KRW-BTC')!.get(t);
  if (iE === undefined || iB === undefined || iE < K || iB < K) return 'CASH';
  const E = RAW.get('KRW-ETH')!, B = RAW.get('KRW-BTC')!;
  let s = 0; for (let j = 0; j < K; j++) s += E[iE - j].close / B[iB - j].close;
  const pick = E[iE].close / B[iB].close > s / K ? 'KRW-ETH' : 'KRW-BTC';
  if (cash === 'none') return pick;
  const ref = cash === 'btc' ? 'KRW-BTC' : pick;
  const c = closeAgo(ref, t, 0), m = sma(ref, t, 50);
  return c && m && c > m ? pick : 'CASH';
};

const F = Y(2018);
console.log(`데이터: 업비트 일봉 ${new Date(TS[0]).toISOString().slice(0, 10)}~${new Date(TS[TS.length - 1]).toISOString().slice(0, 10)}, 비용 편도 BTC ${(leg('KRW-BTC') * 100).toFixed(3)}% ETH ${(leg('KRW-ETH') * 100).toFixed(3)}%`);
console.log('전략'.padEnd(34) + '     총익    MDD   |   동일위험17%      |' + YRS.map(y => String(y).padStart(6)).join(''));
const MODE = process.argv[2] || 'main';

if (MODE === 'main') {
  show('BTC 보유', simulate(BTC_HOLD, { from: F }).out);
  show('ETH 보유', simulate(() => 'KRW-ETH', { from: F }).out);
  { const r = simulate(BTC_TREND(50), { from: F }); show('BTC_TREND SMA50', r.out, r.sw); }
  { const r = simulate((t) => { const c = closeAgo('KRW-ETH', t, 0), s = sma('KRW-ETH', t, 50); return c && s && c > s ? 'KRW-ETH' : 'CASH'; }, { from: F }); show('ETH_TREND SMA50', r.out, r.sw); }
  console.log('── ① 듀얼 모멘텀 BTC/ETH: N × 절대필터 (일간 판단) ──');
  for (const abs of ['ret', 'sma', 'btc'] as const) for (const N of [20, 30, 45, 60, 90, 120]) {
    const r = simulate(DUAL(N, abs), { from: F }); show(`DUAL N${N} abs=${abs}`, r.out, r.sw);
  }
  console.log('── ①b 주간 판단(7일) ──');
  for (const N of [30, 60, 90]) { const r = simulate(DUAL(N, 'sma', ['KRW-BTC', 'KRW-ETH'], 7), { from: F }); show(`DUAL N${N} sma 주간`, r.out, r.sw); }
  console.log('── ② ETH/BTC 비율 추세 ──');
  for (const cash of ['none', 'btc', 'own'] as const) for (const K of [20, 50, 100]) {
    const r = simulate(RATIO(K, cash), { from: F }); show(`RATIO K${K} 현금=${cash}`, r.out, r.sw);
  }
  console.log('── ①c 4자산(BTC·ETH·XRP·SOL, SOL 은 상장 후만) ──');
  for (const N of [30, 60, 90]) { const r = simulate(DUAL(N, 'sma', A), { from: F }); show(`DUAL4 N${N} sma`, r.out, r.sw); }
}

if (MODE === 'break') {
  const base = (p: Policy, o = {}) => simulate(p, { from: F, ...o });
  const cand: Array<[string, () => Policy]> = [['DUAL N60 btc', () => DUAL(60, 'btc')], ['DUAL N30 btc', () => DUAL(30, 'btc')], ['RATIO K50 btc', () => RATIO(50, 'btc')], ['DUAL N60 sma', () => DUAL(60, 'sma')], ['BTC_TREND', () => BTC_TREND(50)]];
  console.log('── 비용·지연 스트레스 ──');
  for (const [lab, mk] of cand) for (const [tag, o] of [['기본', {}], ['비용×2', { costMult: 2 }], ['비용×4', { costMult: 4 }], ['지연1일', { delay: 1 }]] as Array<[string, any]>) {
    const r = base(mk(), o); show(`${lab} ${tag}`, r.out, r.sw);
  }
  console.log('── 워크포워드: 2018~2021 에서 (방식,N/K) 선택 → 2022~ 적용 ──');
  const grid: Array<[string, () => Policy]> = [];
  for (const abs of ['ret', 'sma', 'btc'] as const) for (const N of [20, 30, 45, 60, 90, 120]) grid.push([`DUAL N${N} ${abs}`, () => DUAL(N, abs)]);
  for (const cash of ['none', 'btc', 'own'] as const) for (const K of [20, 50, 100]) grid.push([`RATIO K${K} ${cash}`, () => RATIO(K, cash)]);
  const isv = grid.map(([lab, mk]) => ({ lab, mk, v: eq(simulate(mk(), { from: F, to: Y(2022) - 1 }).out).ret }));
  isv.sort((a, b) => b.v - a.v);
  const oosOf = (mk: () => Policy) => eq(simulate(mk(), { from: Y(2022) }).out).ret;
  const oosBT = oosOf(() => BTC_TREND(50)), oosHold = eq(simulate(BTC_HOLD, { from: Y(2022) }).out).ret;
  console.log(`  IS 상위 5: ${isv.slice(0, 5).map(x => `${x.lab} ${P(x.v)}`).join(' · ')}`);
  console.log(`  IS 1위 ${isv[0].lab} → OOS ${P(oosOf(isv[0].mk))}   (OOS BTC_TREND ${P(oosBT)}, BTC 보유 ${P(oosHold)})`);
  const oosAll = grid.map(([lab, mk]) => ({ lab, v: oosOf(mk) }));
  const beat = oosAll.filter(x => x.v > oosBT).length;
  const sorted = oosAll.map(x => x.v).sort((a, b) => a - b);
  console.log(`  OOS 격자 ${grid.length}칸 중 BTC_TREND 초과 ${beat}칸, 중앙 ${P(sorted[Math.floor(sorted.length / 2)])}, 최대 ${P(sorted[sorted.length - 1])}`);
  // 순위 상관
  const rk = (a: number[]) => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k)); return r; };
  const ri = rk(grid.map(([lab]) => isv.find(x => x.lab === lab)!.v)), ro = rk(oosAll.map(x => x.v));
  const n = ri.length, mr = (n - 1) / 2; let c = 0, a = 0, b = 0; for (let i = 0; i < n; i++) { c += (ri[i] - mr) * (ro[i] - mr); a += (ri[i] - mr) ** 2; b += (ro[i] - mr) ** 2; }
  console.log(`  IS↔OOS 순위상관 ${(c / Math.sqrt(a * b)).toFixed(2)}`);

  console.log('── 플라시보: 현금 타이밍은 BTC_TREND 그대로, 보유 자산(BTC/ETH)을 실제 전략과 같은 블록 길이로 무작위 ──');
  for (const [lab, mk] of cand.slice(0, 4)) {
    const real = simulate(mk(), { from: F });
    const timing = simulate(BTC_TREND(50), { from: F }).out;      // 현금 타이밍 기준
    // 실제 전략의 '보유 중 자산' 블록 길이
    const blocks: number[] = []; let prevH: Hold | null = null;
    for (const x of real.out) { if (x.h === 'CASH') { prevH = null; continue; } if (x.h === prevH) blocks[blocks.length - 1]++; else { blocks.push(1); prevH = x.h; } }
    const ethFrac = real.out.filter(x => x.h === 'KRW-ETH').length / Math.max(1, real.out.filter(x => x.h !== 'CASH').length);
    const vals: number[] = [];
    for (let s = 0; s < 40; s++) {
      let seed = s * 7919 + 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      let bi = 0, left = 0, pick: Hold = 'KRW-BTC';
      const pol: Policy = (t) => {
        const want = BTC_TREND(50)(t, 'CASH');
        if (want === 'CASH') return 'CASH';
        if (left <= 0) { left = blocks[Math.floor(rnd() * blocks.length)] || 1; pick = rnd() < ethFrac ? 'KRW-ETH' : 'KRW-BTC'; bi++; }
        left--; return pick;
      };
      vals.push(eq(simulate(pol, { from: F }).out).ret);
    }
    vals.sort((a, b) => a - b);
    const realV = eq(real.out).ret;
    console.log(`  ${lab}: 실제 ${P(realV)} / 무작위 BTC·ETH 배정(같은 BTC_TREND 현금 타이밍) 중앙 ${P(vals[20])} 90분위 ${P(vals[36])} 최대 ${P(vals[39])} — 초과 ${vals.filter(v => v >= realV).length}/40 (참고 BTC_TREND ${P(eq(timing).ret)})`);
  }
}

if (MODE === 'usdt') {
  console.log('── ③ 현금 대신 KRW-USDT (2024-06~, USDT 가격엔 김프 포함) ──');
  const from = USDT[0].ts + 2 * D;
  for (const [lab, mk] of [['BTC_TREND', () => BTC_TREND(50)], ['DUAL N60 sma', () => DUAL(60, 'sma')], ['RATIO K50 btc', () => RATIO(50, 'btc')]] as Array<[string, () => Policy]>) {
    const a = simulate(mk(), { from }), b = simulate(mk(), { from, cashAs: 'USDT' });
    const sa = st(a.out), sb = st(b.out);
    console.log(`  ${lab.padEnd(16)} 현금 ${P(sa.ret)} MDD${sa.mdd.toFixed(0)}% / USDT ${P(sb.ret)} MDD${sb.mdd.toFixed(0)}%  (전환 ${a.sw} vs ${b.sw})`);
  }
  // USDT 자체: 현금 국면에서 USDT 보유 수익 분해
  const t0 = USDT[0], t1 = USDT[USDT.length - 1];
  console.log(`  KRW-USDT 단순 보유 ${t0.date}→${t1.date}: ${P(100 * (t1.close / t0.open - 1))}`);
  // 김프 분해: USDT/FX
  const fxRaw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/fx-usdkrw.json'), 'utf8'));
  const fx: Array<[string, number]> = Array.isArray(fxRaw) ? fxRaw : Object.entries(fxRaw);
  const fxm = new Map(fx); const fxAt = (d: string) => { for (let k = 0; k < 6; k++) { const dd = new Date(Date.parse(d) - k * D).toISOString().slice(0, 10); if (fxm.has(dd)) return fxm.get(dd)!; } return null; };
  const f0 = fxAt(t0.date), f1 = fxAt(t1.date);
  if (f0 && f1) console.log(`  분해: 환율 ${f0}→${f1} (${P(100 * (f1 / f0 - 1))}), 김프 ${(100 * (t0.open / f0 - 1)).toFixed(1)}%→${(100 * (t1.close / f1 - 1)).toFixed(1)}%`);
  // 원화 약세 국면(환율 60일 상승)에서만 USDT 를 현금 대용
  console.log('  조건부: BTC_TREND 현금 국면 중 (환율 60일 상승 & 김프 < 1%) 일 때만 USDT');
  const cond: Policy = (t) => {
    const w = BTC_TREND(50)(t, 'CASH'); if (w !== 'CASH') return w;
    const d = new Date(t).toISOString().slice(0, 10), d60 = new Date(t - 60 * D).toISOString().slice(0, 10);
    const a = fxAt(d), b = fxAt(d60); const ui = UIDX.get(t);
    if (!a || !b || ui === undefined) return 'CASH';
    const kp = USDT[ui].close / a - 1;
    return a > b && kp < 0.01 ? 'USDT' : 'CASH';
  };
  const c0 = simulate(BTC_TREND(50), { from }), c1 = simulate(cond, { from });
  console.log(`  BTC_TREND 현금 ${P(st(c0.out).ret)} / 조건부 USDT ${P(st(c1.out).ret)} (USDT 보유일 ${c1.out.filter(x => x.h === 'USDT').length})`);
}

if (MODE === 'combo') {
  console.log('── ④ BTC_TREND·F7 대비 상관·합성 ──');
  const f7: { ts: number; r: number }[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/f7_daily.json'), 'utf8'));
  const S = {
    BT: simulate(BTC_TREND(50), { from: F }).out,
    DUAL60: simulate(DUAL(60, 'sma'), { from: F }).out,
    RATIO50: simulate(RATIO(50, 'btc'), { from: F }).out,
  };
  const corr = (x: { ts: number; r: number }[], y: { ts: number; r: number }[]) => {
    const m = new Map(y.map(z => [z.ts, z.r])); const c = x.filter(z => m.has(z.ts)).map(z => [z.r, m.get(z.ts)!]);
    const ma = c.reduce((s, z) => s + z[0], 0) / c.length, mb = c.reduce((s, z) => s + z[1], 0) / c.length;
    let cv = 0, va = 0, vb = 0; for (const [a, b] of c) { cv += (a - ma) * (b - mb); va += (a - ma) ** 2; vb += (b - mb) ** 2; }
    return cv / Math.sqrt(va * vb);
  };
  console.log(`  상관: DUAL60↔BTC_TREND ${corr(S.DUAL60, S.BT).toFixed(2)}, RATIO50↔BTC_TREND ${corr(S.RATIO50, S.BT).toFixed(2)}, DUAL60↔F7 ${corr(S.DUAL60, f7).toFixed(2)}, BTC_TREND↔F7 ${corr(S.BT, f7).toFixed(2)}`);
  const f7s = f7[0].ts, f7e = f7[f7.length - 1].ts;
  const win = (rs: { ts: number; r: number }[]) => rs.filter(x => x.ts >= f7s && x.ts <= f7e);
  const mix = (parts: Array<[number, { ts: number; r: number }[]]>) => {
    const maps = parts.map(([w, rs]) => [w, new Map(rs.map(x => [x.ts, x.r]))] as const);
    const ts = [...maps[0][1].keys()].filter(t => maps.every(([, m]) => m.has(t))).sort((a, b) => a - b);
    return ts.map(t => ({ ts: t, r: maps.reduce((s, [w, m]) => s + w * m.get(t)!, 0) }));
  };
  console.log(`  같은 기간(${new Date(f7s).toISOString().slice(0, 10)}~${new Date(f7e).toISOString().slice(0, 10)}) eq17:`);
  for (const [lab, rs] of [['BTC_TREND', win(S.BT)], ['DUAL60', win(S.DUAL60)], ['RATIO50', win(S.RATIO50)], ['F7', f7]] as Array<[string, any]>) console.log(`    ${lab.padEnd(12)} ${P(eq(rs).ret)}`);
  for (const [lab, parts] of [
    ['BT 50 + F7 50', [[0.5, win(S.BT)], [0.5, f7]]],
    ['DUAL60 50 + F7 50', [[0.5, win(S.DUAL60)], [0.5, f7]]],
    ['RATIO50 50 + F7 50', [[0.5, win(S.RATIO50)], [0.5, f7]]],
    ['BT 50 + DUAL60 50', [[0.5, win(S.BT)], [0.5, win(S.DUAL60)]]],
  ] as Array<[string, Array<[number, any]>]>) console.log(`    ${lab.padEnd(20)} ${P(eq(mix(parts)).ret)}`);
}

if (MODE === 'oos') {
  const O = Y(2022);
  const ETH_TREND: Policy = (t) => { const c = closeAgo('KRW-ETH', t, 0), s = sma('KRW-ETH', t, 50); return c && s && c > s ? 'KRW-ETH' : 'CASH'; };
  console.log('── OOS 2022~ 만 (동일위험 MDD17) ──');
  const R: Array<[string, () => Policy]> = [['BTC 보유', () => BTC_HOLD], ['BTC_TREND', () => BTC_TREND(50)], ['ETH_TREND', () => ETH_TREND],
    ['DUAL N30 btc', () => DUAL(30, 'btc')], ['DUAL N60 btc', () => DUAL(60, 'btc')], ['RATIO K20 btc', () => RATIO(20, 'btc')], ['RATIO K50 btc', () => RATIO(50, 'btc')], ['RATIO K100 btc', () => RATIO(100, 'btc')]];
  for (const [lab, mk] of R) { const r = simulate(mk(), { from: O }); show(lab, r.out, r.sw); }
  // BTC_TREND 50 + ETH_TREND 50 (자본 반반, 각자 타이밍)
  const a = simulate(BTC_TREND(50), { from: O }).out, b = simulate(ETH_TREND, { from: O }).out;
  const mb = new Map(b.map(x => [x.ts, x.r]));
  show('BTC_TREND 50 + ETH_TREND 50', a.filter(x => mb.has(x.ts)).map(x => ({ ts: x.ts, r: 0.5 * x.r + 0.5 * mb.get(x.ts)! })));
  console.log('── OOS 플라시보 (BTC_TREND 현금 타이밍 고정, BTC/ETH 무작위 블록, 40시드) ──');
  for (const [lab, mk] of R.slice(3)) {
    const real = simulate(mk(), { from: O });
    const blocks: number[] = []; let prevH: Hold | null = null;
    for (const x of real.out) { if (x.h === 'CASH') { prevH = null; continue; } if (x.h === prevH) blocks[blocks.length - 1]++; else { blocks.push(1); prevH = x.h; } }
    const held = real.out.filter(x => x.h !== 'CASH');
    const ethFrac = held.filter(x => x.h === 'KRW-ETH').length / Math.max(1, held.length);
    const vals: number[] = [];
    for (let s = 0; s < 40; s++) {
      let seed = s * 104729 + 17; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      let left = 0, pick: Hold = 'KRW-BTC';
      const pol: Policy = (t) => { if (BTC_TREND(50)(t, 'CASH') === 'CASH') return 'CASH'; if (left <= 0) { left = blocks[Math.floor(rnd() * blocks.length)] || 1; pick = rnd() < ethFrac ? 'KRW-ETH' : 'KRW-BTC'; } left--; return pick; };
      vals.push(eq(simulate(pol, { from: O }).out).ret);
    }
    vals.sort((x, y) => x - y);
    const rv = eq(real.out).ret;
    console.log(`  ${lab.padEnd(16)} 실제 ${P(rv)} / 무작위 중앙 ${P(vals[20])} 90분위 ${P(vals[36])} 최대 ${P(vals[39])} — 초과 ${vals.filter(v => v >= rv).length}/40, ETH 보유비중 ${(100 * ethFrac).toFixed(0)}%`);
  }
}

if (MODE === 'trendmix') {
  // 각 대형 코인을 자기 SMA 로 독립 추세추종 → 자본 균등 분할(코인별 슬리브). 상대 선택 없음.
  const TR = (m: string, n: number): Policy => (t) => { const c = closeAgo(m, t, 0), s = sma(m, t, n); return c && s && c > s ? m : 'CASH'; };
  const sleeve = (m: string, n: number, o: any = {}) => simulate(TR(m, n), { from: F, ...o });
  const mixOf = (parts: { ts: number; r: number }[][], w?: number[]) => {
    const maps = parts.map(p => new Map(p.map(x => [x.ts, x.r])));
    const ts = parts[0].map(x => x.ts);
    return ts.map(t => {
      const av = maps.map((m, i) => [m.get(t), w ? w[i] : 1] as const).filter(([r]) => r !== undefined) as Array<readonly [number, number]>;
      const ws = av.reduce((s, [, ww]) => s + ww, 0);
      return { ts: t, r: av.reduce((s, [r, ww]) => s + r * ww, 0) / ws };   // 아직 상장 전 코인은 제외하고 재정규화
    });
  };
  console.log('── 코인별 SMA 고원 (단독 슬리브, 2018~) ──');
  for (const m of A) {
    const row = [20, 30, 50, 75, 100, 150].map(n => `${n}:${P(eq(sleeve(m, n).out).ret)}`).join(' ');
    console.log(`  ${m.padEnd(9)} ${row}`);
  }
  console.log('── 혼합 (각 코인 독립 SMA50 타이밍, 자본 균등) ──');
  const B = sleeve('KRW-BTC', 50).out, E = sleeve('KRW-ETH', 50).out, X = sleeve('KRW-XRP', 50).out, S = sleeve('KRW-SOL', 50).out;
  show('BTC_TREND 단독', B);
  show('BTC+ETH 반반', mixOf([B, E]));
  show('BTC+ETH+XRP 1/3', mixOf([B, E, X]));
  show('BTC+ETH+XRP+SOL 1/4', mixOf([B, E, X, S]));
  console.log('── 반반(BTC+ETH) 스트레스 ──');
  for (const [tag, o] of [['비용×2', { costMult: 2 }], ['비용×4', { costMult: 4 }], ['지연1일', { delay: 1 }]] as Array<[string, any]>)
    show(`BTC+ETH 반반 ${tag}`, mixOf([sleeve('KRW-BTC', 50, o).out, sleeve('KRW-ETH', 50, o).out]));
  for (const n of [20, 30, 75, 100, 150]) show(`BTC+ETH 반반 SMA${n}`, mixOf([sleeve('KRW-BTC', n).out, sleeve('KRW-ETH', n).out]));
  console.log('── 워크포워드: SMA 길이를 2018~21 에서 고름 → 2022~ ──');
  {
    const Ns = [20, 30, 50, 75, 100, 150];
    const isv = Ns.map(n => ({ n, v: eq(mixOf([sleeve('KRW-BTC', n).out, sleeve('KRW-ETH', n).out]).filter(x => x.ts < Y(2022))).ret })).sort((a, b) => b.v - a.v);
    const oo = (n: number) => eq(mixOf([sleeve('KRW-BTC', n, { from: Y(2022) }).out, sleeve('KRW-ETH', n, { from: Y(2022) }).out])).ret;
    console.log(`  IS 최적 SMA${isv[0].n} (IS ${P(isv[0].v)}) → OOS ${P(oo(isv[0].n))} · OOS 전 격자 ${Ns.map(n => `${n}:${P(oo(n))}`).join(' ')} · OOS BTC_TREND ${P(eq(simulate(BTC_TREND(50), { from: Y(2022) }).out).ret)}`);
  }
  console.log('── ETH 타이밍 플라시보 (ETH 보유, 같은 국면 블록 길이 셔플, 20시드, 반반 기준) ──');
  {
    const real = mixOf([B, E]); const rv = eq(real).ret;
    const ethHold = simulate(() => 'KRW-ETH', { from: F }).out;
    const blocks: { on: boolean; len: number }[] = []; for (const x of E) { const on = x.h !== 'CASH'; const l = blocks[blocks.length - 1]; if (l && l.on === on) l.len++; else blocks.push({ on, len: 1 }); }
    const vals: number[] = [];
    for (let s = 0; s < 20; s++) {
      let seed = s * 7919 + 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const onB = blocks.filter(x => x.on).map(x => x.len).sort(() => rnd() - 0.5), offB = blocks.filter(x => !x.on).map(x => x.len).sort(() => rnd() - 0.5);
      const mask: boolean[] = []; let a = 0, c = 0, cur = rnd() < 0.5;
      while (mask.length < ethHold.length && (a < onB.length || c < offB.length)) { const L = cur ? onB[a++] : offB[c++]; if (L == null) { cur = !cur; continue; } for (let k = 0; k < L; k++) mask.push(cur); cur = !cur; }
      const fakeE = ethHold.map((x, i) => ({ ts: x.ts, r: mask[i] ? x.r : 0 }));
      vals.push(eq(mixOf([B, fakeE])).ret);
    }
    vals.sort((a, b) => a - b);
    console.log(`  실제 반반 ${P(rv)} / ETH 타이밍 무작위 중앙 ${P(vals[10])} 최대 ${P(vals[19])} — 초과 ${vals.filter(v => v >= rv).length}/20`);
  }
  console.log('── F7 과의 합성 (F7 기간) ──');
  {
    const f7: { ts: number; r: number }[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/f7_daily.json'), 'utf8'));
    const mix2 = mixOf([B, E]); const m = new Map(mix2.map(x => [x.ts, x.r])); const mb = new Map(B.map(x => [x.ts, x.r]));
    const c = f7.filter(x => m.has(x.ts));
    const corr = (key: Map<number, number>) => { const pr = c.map(x => [x.r, key.get(x.ts)!]); const ma = pr.reduce((s, z) => s + z[0], 0) / pr.length, mbb = pr.reduce((s, z) => s + z[1], 0) / pr.length; let cv = 0, va = 0, vb = 0; for (const [a, b] of pr) { cv += (a - ma) * (b - mbb); va += (a - ma) ** 2; vb += (b - mbb) ** 2; } return cv / Math.sqrt(va * vb); };
    console.log(`  상관 F7↔(BTC+ETH 반반) ${corr(m).toFixed(2)}, F7↔BTC_TREND ${corr(mb).toFixed(2)}`);
    console.log(`  eq17: BTC+ETH 반반 ${P(eq(c.map(x => ({ ts: x.ts, r: m.get(x.ts)! }))).ret)} · BTC_TREND ${P(eq(c.map(x => ({ ts: x.ts, r: mb.get(x.ts)! }))).ret)} · F7 ${P(eq(c).ret)}`);
    console.log(`  합성 F7 50 + (BTC+ETH 반반) 50 → ${P(eq(c.map(x => ({ ts: x.ts, r: 0.5 * x.r + 0.5 * m.get(x.ts)! }))).ret)} · F7 50 + BTC_TREND 50 → ${P(eq(c.map(x => ({ ts: x.ts, r: 0.5 * x.r + 0.5 * mb.get(x.ts)! }))).ret)}`);
  }
}
