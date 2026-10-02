/**
 * 축 N — 알트 2~3일 스윙, 생존편향 차단 (2026-10-02)
 *
 * 유니버스: 매일 '그날까지 알 수 있었던' 직전 30일 업비트 거래대금(value) 상위 N, 스테이블 제외, 이력 ≥ 30일.
 *   상폐 코인은 업비트가 캔들을 안 주므로 빠져 있다 → 결과는 상한.
 * 타이밍(일봉, KST 09:00 경계): 신호 = t일 종가 확정 직후 판단 → t+1 시가 시장가 진입(슬리피지 = 스프레드½, 없으면 0.3%).
 *   TP: 진입 직후 지정가 → t+1 부터 고가 ≥ 목표×(1+관통) 이면 목표가 체결(진입일 포함 — 시가 진입이라 그날 고가는 진입 이후).
 *   손절(봉마감): 종가 ≤ 손절선이면 다음날 시가에 시장가. 같은 날 TP·손절 → TP 우선 아님: 손절선 이하 종가인 날은 TP 도 닿았으면 TP(장중 먼저였을 수 있음)
 *     → 보수적으로 '그날 시가→고가 순서 불명'이므로 TP 닿고 종가 ≤ 손절선이면 TP 인정하지 않고 손절 처리.
 *   시간청산: 보유 H일째 종가에 시장가.
 * 포트폴리오: 동시 K 슬롯, 진입 시 현금 × size. MDD 17% 동일위험은 size 이분탐색.
 */
import fs from 'fs';
import path from 'path';

const D = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const STABLE = new Set(['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'TUSD', 'PYUSD', 'FDUSD', 'USDE', 'RLUSD', 'EURC', 'USD0']);
const FEE0 = 0.0005;
let FEE = FEE0, SLIPMUL = 1, PEN = 0.002, DELAYPEN = 0;
const DAY = 86400e3;

interface Bar { ts: number; open: number; high: number; low: number; close: number; value: number }
const RAW = new Map<string, Bar[]>();
for (const f of fs.readdirSync(D).filter(f => f.startsWith('KRW-'))) {
  const m = f.replace('.json', '');
  if (STABLE.has(m.slice(4))) continue;
  const b: Bar[] = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  // 진행 중인 오늘 봉 제외
  const done = b.filter(x => x.ts + DAY <= Date.now()).sort((a, c) => a.ts - c.ts);
  if (done.length >= 60) RAW.set(m, done);
}
const MK = [...RAW.keys()];
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const TI = new Map(TS.map((t, i) => [t, i]));
// 코인별 전 일자 배열(없으면 null)
const G = new Map<string, (Bar | null)[]>();
for (const [m, b] of RAW) { const a: (Bar | null)[] = new Array(TS.length).fill(null); for (const x of b) a[TI.get(x.ts)!] = x; G.set(m, a); }
const slipOf = (m: string) => SLIPMUL * (SPREAD[m] != null ? Math.max(0.0005, SPREAD[m] / 2 / 1e4) : 0.003);

// 30일 거래대금 합(그날 포함, t 종가 확정 시점에 알 수 있음) → 순위
const VAL30 = new Map<string, Float64Array>(), HIST = new Map<string, Int32Array>();
for (const m of MK) {
  const a = G.get(m)!; const v = new Float64Array(TS.length); const h = new Int32Array(TS.length);
  let s = 0, cnt = 0; const q: number[] = [];
  for (let i = 0; i < TS.length; i++) {
    const x = a[i]; const val = x ? x.value : 0; q.push(val); s += val; if (q.length > 30) s -= q.shift()!;
    if (x) cnt++; v[i] = s; h[i] = cnt;
  }
  VAL30.set(m, v); HIST.set(m, h);
}
const RANK: Map<string, number>[] = TS.map((_, i) => {
  const arr = MK.filter(m => G.get(m)![i] && HIST.get(m)![i] >= 30).map(m => [m, VAL30.get(m)![i]] as [string, number]).sort((a, b) => b[1] - a[1]);
  return new Map(arr.map(([m], r) => [m, r]));
});
const btc = G.get('KRW-BTC')!;
const BTCON: boolean[] = TS.map((_, i) => {
  if (i < 50 || !btc[i]) return false; let s = 0, n = 0;
  for (let j = i - 49; j <= i; j++) if (btc[j]) { s += btc[j]!.close; n++; }
  return n >= 45 && btc[i]!.close > s / n;
});

// ── 신호 (t일 종가까지의 정보) ──
type Sig = (m: string, i: number) => number | null;   // 강도(클수록 우선) 또는 null
const closeAt = (m: string, i: number) => G.get(m)![i]?.close;
const ret = (m: string, i: number, k: number) => { const a = closeAt(m, i), b = closeAt(m, i - k); return a && b ? a / b - 1 : null; };
const valZ = (m: string, i: number, w = 30) => {
  const a = G.get(m)!; let s = 0, s2 = 0, n = 0;
  for (let j = i - w; j < i; j++) { const x = a[j]; if (!x) continue; s += x.value; s2 += x.value ** 2; n++; }
  if (n < 20 || !a[i]) return null; const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-9));
  return (a[i]!.value - mu) / sd;
};
const SIGS: Record<string, Sig> = {
  // F6 류: 종가가 직전 7일 고가 돌파 + 양봉 + 거래대금 z ≥ 0.5
  breakout7: (m, i) => {
    const a = G.get(m)!; const x = a[i]; if (!x || x.close <= x.open) return null;
    let hi = -Infinity; for (let j = i - 7; j < i; j++) { if (!a[j]) return null; hi = Math.max(hi, a[j]!.high); }
    const z = valZ(m, i); return x.close > hi && z != null && z >= 0.5 ? z : null;
  },
  // 거래대금 급증 + 양봉
  valSurge: (m, i) => { const x = G.get(m)![i]; const z = valZ(m, i); return x && x.close > x.open && z != null && z >= 2.5 ? z : null; },
  // BTC 대비 3일 상대강도 급상승
  relStr: (m, i) => { const r = ret(m, i, 3), b = ret('KRW-BTC', i, 3); return r != null && b != null && r - b >= 0.15 ? r - b : null; },
  // 3일 연속 양봉 + 7일 고가 근처
  green3: (m, i) => {
    const a = G.get(m)!; for (let j = i - 2; j <= i; j++) { const x = a[j]; if (!x || x.close <= x.open) return null; }
    return a[i - 3] ? a[i]!.close / a[i - 3]!.close - 1 : null;
  },
  // 급락 흡수는 별도 처리(지정가) — 여기선 '전일 종가'를 기준가로만 씀
  dip: (m, i) => (G.get(m)![i] ? 0 : null),
};

// 신호 캐시: sig → coin → Float64Array(NaN = 없음)
const CACHE = new Map<string, Map<string, Float64Array>>();
function sigArr(sig: string, m: string) {
  let c = CACHE.get(sig); if (!c) { c = new Map(); CACHE.set(sig, c); }
  let a = c.get(m);
  if (!a) { a = new Float64Array(TS.length).fill(NaN); for (let i = 40; i < TS.length; i++) { const v = SIGS[sig](m, i); if (v != null) a[i] = v; } c.set(m, a); }
  return a;
}
interface Cfg { sig: string; N: number; K: number; tp: number; sl: number | null; H: number; btcOn: boolean; dip?: number; rand?: number; seed?: number }
interface Pos { m: string; ep: number; vol: number; used: number; d: number; stop: boolean; tp: number }
function run(c: Cfg, size: number, from = 0, to = Infinity, curve?: number[]) {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, sumR = 0; const open: Pos[] = [];
  let seed = c.seed ?? 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 60; i < TS.length; i++) {
    if (TS[i] < from || TS[i] > to) continue;
    // 1) 오늘(i) 봉에서 보유분 처리
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const x = G.get(q.m)![i]; if (!x) continue;
      let px = 0;
      if (q.stop) px = x.open * (1 - slipOf(q.m));                                   // 어제 종가 손절 → 오늘 시가
      else {
        q.d++;
        const tgt = q.ep * (1 + c.tp / 100);
        const hitTp = x.high >= tgt * (1 + PEN);
        const slLine = c.sl != null ? q.ep * (1 + c.sl / 100) : -Infinity;
        if (hitTp && !(x.close <= slLine)) px = tgt;                                  // 지정가 — 슬리피지 0
        else if (x.close <= slLine) { q.stop = true; }
        else if (q.d >= c.H) px = x.close * (1 - slipOf(q.m));
      }
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    // 2) 어제(i−1) 종가 신호 → 오늘(i) 시가 진입 / 급락 흡수는 오늘 저가 체결
    const j = i - 1;
    if (!c.btcOn || BTCON[j]) {
      const cands: [string, number][] = [];
      for (const [m, r] of RANK[j]) {
        if (r >= c.N) break;
        if (m === 'KRW-BTC' || !G.get(m)![i]) continue;
        if (c.rand != null) { if (rnd() < c.rand) cands.push([m, rnd()]); continue; }
        const s = sigArr(c.sig, m)[j]; if (!Number.isNaN(s)) cands.push([m, s]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      for (const [m] of cands) {
        if (open.length >= c.K) break;
        if (open.some(q => q.m === m)) continue;
        const x = G.get(m)![i]!; const prev = G.get(m)![j]!;
        let ep: number;
        if (c.dip != null) {                                                          // 급락 흡수: 전일 종가 × (1−dip) 지정가
          const lim = prev.close * (1 - c.dip / 100);
          if (x.low > lim * (1 - PEN)) continue; ep = lim;
        } else ep = x.open * (1 + slipOf(m) + DELAYPEN);
        const used = cash * size; if (used < 5000) continue;
        cash -= used;
        const pos: Pos = { m, ep, vol: used * (1 - FEE) / ep, used, d: 0, stop: false, tp: c.tp };
        // 시가 진입이면 그날 고가는 진입 이후 → 당일 익절 인정(단 종가가 손절선 이하면 순서 불명 → 인정 안 함)
        const tgt = ep * (1 + c.tp / 100), slLine = c.sl != null ? ep * (1 + c.sl / 100) : -Infinity;
        if (c.dip == null && x.high >= tgt * (1 + PEN) && x.close > slLine) {
          const got = pos.vol * tgt * (1 - FEE); cash += got; n++; sumR += got / used - 1; continue;
        }
        if (x.close <= slLine) pos.stop = true;
        open.push(pos);
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * (G.get(q.m)![i]?.close ?? q.ep), 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
    if (curve) curve[i] = eq;
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.ep, 0);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
const sizeFor = (c: Cfg, from = 0, to = Infinity) => {
  let lo = 0.02, hi = 0.99;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run(c, mid, from, to).mdd > 17) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
};
const Y = (y: number) => Date.UTC(y, 0, 1);
const START = Y(2019), SPLIT = Y(2023);
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

export { run, sizeFor, SIGS, TS, G, RANK, BTCON, START, SPLIT, YEARS, Y, type Cfg };
const setFee = (k: number) => { FEE = FEE0 * k; SLIPMUL = k; };
const setPen = (p: number) => { PEN = p; };
const setDelay = (d: number) => { DELAYPEN = d; };
export { setFee, setPen, setDelay };

// ── BTC_TREND 기준선(같은 엔진: BTC 를 SMA50 위에서 보유) ──
function btcTrend(size: number, from = 0, to = Infinity, curve?: number[]) {
  let cash = 1e7, vol = 0, used = 0, peak = 1e7, mdd = 0;
  for (let i = 60; i < TS.length; i++) {
    if (TS[i] < from || TS[i] > to) continue; const x = btc[i]; if (!x) continue;
    const want = BTCON[i - 1];
    if (want && !vol) { used = cash * size; cash -= used; vol = used * (1 - FEE) / (x.open * 1.0005); }
    else if (!want && vol) { cash += vol * x.open * 0.9995 * (1 - FEE); vol = 0; }
    const eq = cash + vol * x.close; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); if (curve) curve[i] = eq;
  }
  const eq = cash + vol * (btc[TS.length - 1]?.close ?? 0);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd };
}
export { btcTrend };

if (require.main === module) {
  const mode = process.argv[2] || 'grid';
  const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
  if (mode === 'grid') {
    let s = 0.02, h = 0.99; for (let k = 0; k < 16; k++) { const mid = (s + h) / 2; if (btcTrend(mid, START).mdd > 17) h = mid; else s = mid; }
    const bt = (s + h) / 2;
    console.log(`BTC_TREND eq17 ${fmt(btcTrend(bt, START).ret)} | IS ${fmt(btcTrend(bt, START, SPLIT).ret)} OOS ${fmt(btcTrend(bt, SPLIT).ret)}  (size ${(bt * 100).toFixed(0)}%)`);
    const rows: string[] = [];
    for (const sig of ['breakout7', 'valSurge', 'relStr', 'green3', 'dip5', 'dip8', 'rand'])
      for (const N of [10, 20, 30]) for (const btcOn of [false, true])
        for (const [tp, sl, H] of [[6, null, 3], [6, -3, 3], [4, null, 2], [8, null, 3], [8, -4, 3]] as [number, number | null, number][]) {
          const c: Cfg = { sig: sig.startsWith('dip') ? 'dip' : sig === 'rand' ? 'breakout7' : sig, N, K: 3, tp, sl, H, btcOn,
            dip: sig === 'dip5' ? 5 : sig === 'dip8' ? 8 : undefined, rand: sig === 'rand' ? 0.03 : undefined };
          const sz = sizeFor(c, START); const r = run(c, sz, START);
          const is = run(c, sz, START, SPLIT).ret, oos = run(c, sz, SPLIT).ret; const fx = run(c, 0.33, START);
          rows.push(`${sig.padEnd(10)} N${String(N).padEnd(3)}${btcOn ? 'BTC' : '   '} tp${tp} sl${sl ?? '-'} H${H} | eq17 ${fmt(r.ret).padStart(7)} IS ${fmt(is).padStart(6)} OOS ${fmt(oos).padStart(6)} n${String(r.n).padStart(5)} avg ${r.avg.toFixed(2).padStart(6)}% | 33%×3 ${fmt(fx.ret).padStart(7)} mdd ${fx.mdd.toFixed(0)}%`);
        }
    console.log(rows.join('\n'));
  }
}
