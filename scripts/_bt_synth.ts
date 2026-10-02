/**
 * 종합 대조 (2026-10-02) — 8갈래 리서치 결과를 하나의 현실적 시뮬레이터로 맞대 본다.
 * 15m 28코인 2024-10~2026-10. 4h 봉은 15m 을 UTC 4h 경계로 합성, 신호 = sigF6.
 * 라이브 운영을 그대로 모사:
 *   - tick 은 4h 봉마감 + LAG (0 = 봉마감 정렬, 3h = 현재 KST 정각 크론)
 *   - 진입: tick 시점 가격(그 시각 15m 봉 시가)에 시장가 — 슬리피지 = max(0.05%, 코인별 스프레드 p50 / 2)
 *   - TP: 진입 직후 지정가, 이후 15m 고가가 닿으면 목표가 체결(슬리피지 0)
 *   - 손절: tick 시점에 '확정된 4h 봉' 저가가 손절선 이하였으면 tick 가격에 시장가
 *   - 시간청산: 진입 후 확정된 4h 봉이 maxb 개면 tick 가격에 시장가
 *   - 옵션 BTC50: tick 시점 BTC 가 일봉 50일선(4h 300봉 평균 근사) 아래면 신규 진입 안 함
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const FEE = 0.0005, H = 3600e3, FOUR = 4 * H, Q = 15 * 60e3, INIT = 1e7;
interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
const M15 = new Map<string, B[]>(), M4 = new Map<string, B[]>();
for (const m of COINS) {
  const f = fs.readdirSync(DIR).find(x => x.startsWith(`${m}_15m_`)); if (!f) continue;
  const b: B[] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  M15.set(m, b);
  const agg: B[] = [];
  for (const x of b) {
    const k = Math.floor(x.ts / FOUR) * FOUR; const l = agg[agg.length - 1];
    if (!l || l.ts !== k) agg.push({ ts: k, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume });
    else { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume += x.volume; }
  }
  M4.set(m, agg);
}
const I15 = new Map([...M15].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const I4 = new Map([...M4].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const volZ = (b: B[], i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: B[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: B[], i: number) => i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
const slipOf = (m: string, real: boolean) => real ? Math.max(0.0005, (SPREAD[m] ?? 10) / 2 / 1e4) : 0.0005;
/** ts 시점 가격 = 그 시각을 포함하는 15m 봉 시가 */
const px = (m: string, ts: number) => { const i = I15.get(m)!.get(Math.floor(ts / Q) * Q); return i === undefined ? null : M15.get(m)![i].open; };
const btc4 = M4.get('KRW-BTC')!;
const btcBelow50 = (barTs: number) => { const i = I4.get('KRW-BTC')!.get(barTs); if (i === undefined || i < 300) return false; let s = 0; for (let j = i - 299; j <= i; j++) s += btc4[j].close; return btc4[i].close < s / 300; };

interface D { tp: number; sl: number | null; maxb: number; btc50?: boolean }
interface P { m: string; ep: number; vol: number; used: number; t0: number; slip: number }
const T0 = Math.max(...[...M4.values()].map(b => b[0].ts)) + 50 * FOUR;
const T1 = Math.min(...[...M4.values()].map(b => b[b.length - 1].ts));
function run(d: D, lagH: number, size: number, real: boolean, from = T0, to = T1) {
  let cash = INIT; const open: P[] = []; let peak = INIT, mdd = 0, n = 0, sumR = 0, tpN = 0, slN = 0;
  const lag = lagH * H;
  // 15m 단위로 TP 체결을 보고, tick(봉마감+lag)마다 손절·시간청산·진입
  for (let bar = Math.ceil(from / FOUR) * FOUR; bar <= to; bar += FOUR) {
    const tick = bar + lag;   // 직전 4h 봉(bar−4h ~ bar)이 bar 에 마감, tick 에 판단
    // (a) 직전 tick 이후 ~ 이번 tick 까지 15m 경로에서 TP 지정가 체결
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const b15 = M15.get(q.m)!; const tgt = q.ep * (1 + d.tp / 100);
      for (let t = Math.max(q.t0, tick - FOUR); t < tick; t += Q) {
        const i = I15.get(q.m)!.get(t); if (i === undefined || t < q.t0) continue;
        if (b15[i].high >= tgt) { const got = q.vol * tgt * (1 - FEE); cash += got; n++; tpN++; sumR += got / q.used - 1; open.splice(p, 1); break; }
      }
    }
    // (b) tick: 손절·시간청산 — 진입 이후 확정된 4h 봉 기준
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const b4 = M4.get(q.m)!;
      const conf = b4.filter(x => x.ts >= Math.floor(q.t0 / FOUR) * FOUR + FOUR && x.ts + FOUR <= tick);
      const hitSL = d.sl != null && conf.some(x => x.low <= q.ep * (1 + d.sl! / 100));
      if (hitSL || conf.length >= d.maxb) {
        const pr = px(q.m, tick); if (pr == null) continue;
        const got = q.vol * pr * (1 - q.slip) * (1 - FEE); cash += got; n++; if (hitSL) slN++; sumR += got / q.used - 1; open.splice(p, 1);
      }
    }
    // (c) 진입 — 방금 마감한 봉(bar−4h)에서 신호
    if (!(d.btc50 && btcBelow50(bar - FOUR))) {
      for (const m of COINS) {
        if (open.length >= 3) break;
        const b4 = M4.get(m); if (!b4) continue; const i = I4.get(m)!.get(bar - FOUR);
        if (i === undefined || !sigF6(b4, i) || open.some(q => q.m === m)) continue;
        const pr = px(m, tick); if (pr == null) continue;
        const used = cash * size; if (used < 5000) continue;
        const slip = slipOf(m, real); const ep = pr * (1 + slip);
        cash -= used; open.push({ m, ep, vol: used * (1 - FEE) / ep, used, t0: tick, slip });
      }
    }
    const eq = cash + open.reduce((a, q) => { const pr = px(q.m, tick) ?? q.ep; return a + q.vol * pr; }, 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.ep, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, tpN, slN };
}
const sizeFor = (d: D, lag: number, real: boolean) => { let lo = 0.02, hi = 0.95; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run(d, lag, mid, real).mdd > 17) hi = mid; else lo = mid; } return (lo + hi) / 2; };
const SP: Array<[string, number, number]> = [['24Q4', Date.UTC(2024, 9, 1), Date.UTC(2024, 11, 31)], ['2025', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31)], ['2026', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)]];
const DES: Array<[string, D]> = [
  ['F6  TP5/SL-2/14d', { tp: 5, sl: -2, maxb: 84 }],
  ['F7  TP6/3d/무스톱', { tp: 6, sl: null, maxb: 18 }],
  ['F7_sl TP6/3d/SL-2', { tp: 6, sl: -2, maxb: 18 }],
  ['F7_p TP4/2d/무스톱', { tp: 4, sl: null, maxb: 12 }],
  ['F7_sl + BTC50', { tp: 6, sl: -2, maxb: 18, btc50: true }],
  ['F7 + BTC50', { tp: 6, sl: null, maxb: 18, btc50: true }],
  ['SL-1.5 TP6/3d', { tp: 6, sl: -1.5, maxb: 18 }],
  ['SL-2 TP8/5d', { tp: 8, sl: -2, maxb: 30 }],
];
if (process.argv[2] === "lag") { for (const [lab, d] of DES.slice(0, 4).concat([DES[5]])) console.log(lab.padEnd(20) + [0, 0.5, 1, 2, 3].map(l => { const r = run(d, l, 0.33, true); return `${l}h ${r.ret.toFixed(0)}%/${r.mdd.toFixed(0)}%`.padStart(14); }).join("")); process.exit(0); }
console.log(`기간 ${new Date(T0).toISOString().slice(0, 10)} ~ ${new Date(T1).toISOString().slice(0, 10)} · 28코인 · 15m 경로\n`);
for (const real of [false, true]) for (const lag of [0, 3]) {
  console.log(`── 슬리피지 ${real ? '현실(코인별 스프레드½)' : '0.05%'} · 판단 지연 ${lag}h ──`);
  console.log('설계'.padEnd(20) + '33%×3'.padStart(8) + 'MDD'.padStart(6) + '거래'.padStart(5) + '거래당'.padStart(8) + ' | MDD17'.padStart(8) + SP.map(s => s[0].padStart(7)).join(''));
  for (const [lab, d] of DES) {
    const r = run(d, lag, 0.33, real); const sz = sizeFor(d, lag, real); const e = run(d, lag, sz, real);
    const per = SP.map(([, a, b]) => (run(d, lag, sz, real, Math.max(a, T0), Math.min(b, T1)).ret.toFixed(0) + '%').padStart(7)).join('');
    console.log(`${lab.padEnd(20)}${(r.ret.toFixed(0) + '%').padStart(8)}${(r.mdd.toFixed(0) + '%').padStart(6)}${String(r.n).padStart(5)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)} | ${(e.ret.toFixed(0) + '%').padStart(6)}${per}`);
  }
  console.log('');
}
