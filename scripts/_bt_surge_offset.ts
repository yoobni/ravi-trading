/**
 * 급등 신호의 진입 지연 민감도 — "4시간 크론으로도 되는가"에 대한 답.
 *
 * 백테스트는 신호봉 마감 직후(다음 봉 시가)에 산다고 가정한다. 그런데 실제 크론은
 * KST 00/04/08/12/16/20 에 도는 반면 Upbit 4h 봉은 01/05/09/13/17/21 에 마감된다
 * → 라이브는 매번 **3시간 늦게** 산다.
 *
 * F6 는 그 지연이 PF 1.81→1.31 이었다(_bt_tickoffset). 급등은 "방금 튄 직후"를 사는
 * 신호라 더 취약할 수 있다. 실제로 얼마나 깎이는지 1h 캐시로 시간 단위 측정한다.
 *
 * 방법: 신호는 4h 확정봉에서 판정하고, 진입만 그 봉 마감 + N시간 지점의 1h 시가로 바꾼다.
 *       N=0 이 백테스트 가정, N=3 이 현행 크론, N=2 는 v7 처럼 정렬한 크론의 여유분.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84, FOUR = 4 * 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string, unit: number): Bar[] | null {
  const f = fs.readdirSync(DIR).filter((x) => x.startsWith(`${m}_${unit}m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const H4 = new Map<string, Bar[]>(), H1 = new Map<string, Bar[]>();
for (const m of COINS) {
  const a = load(m, 240), b = load(m, 60);
  if (a && b && a.length > 500 && b.length > 1000) { H4.set(m, a); H1.set(m, b); }
}
const MKTS = [...H4.keys()];
const I4 = new Map(MKTS.map((m) => [m, new Map(H4.get(m)!.map((b, i) => [b.ts, i]))]));
const I1 = new Map(MKTS.map((m) => [m, new Map(H1.get(m)!.map((b, i) => [b.ts, i]))]));
// 1h 캐시가 있는 구간만 (2024-06~)
const START = Math.max(...MKTS.map((m) => H1.get(m)![0].ts));
const TS = [...new Set(MKTS.flatMap((m) => H4.get(m)!.map((b) => b.ts)))].filter((t) => t >= START + 60 * FOUR).sort((a, b) => a - b);

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
const sigSurge = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && volZ(b, i) >= vz;

/** 신호봉 마감 + offsetH 시간 지점의 1h 봉 시가 = 그때 시장가 매수했을 때의 체결가 */
function entryPriceAt(m: string, sigTs: number, offsetH: number): number | null {
  const target = sigTs + FOUR + offsetH * 3600_000;   // 신호봉 마감 = sigTs + 4h
  const i = I1.get(m)!.get(target);
  if (i === undefined) return null;
  return H1.get(m)![i].open;
}

interface Pos { m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number; src: string }
function run(mode: 'F6' | 'BOTH', pct: number, vz: number, offsetH: number, size: number, maxCon: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const bySrc = new Map<string, { n: number; s: number }>();
  for (let t = 0; t < TS.length; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = H4.get(pos.m)!; const i = I4.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        const k = bySrc.get(pos.src) ?? { n: 0, s: 0 }; k.n++; k.s += r; bySrc.set(pos.src, k);
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = I4.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? H4.get(p.m)![i].close : p.last); }
    if (open.length < maxCon && t < TS.length - 20) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = H4.get(m)!; const i = I4.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length) continue;
        const f6 = sigF6(b, i), sg = sigSurge(b, i, pct, vz);
        const hit = mode === 'F6' ? f6 : (f6 || (sg && !f6));
        if (!hit) continue;
        const raw = entryPriceAt(m, ts, offsetH);
        if (raw === null || !(raw > 0)) continue;
        const use = Math.min(cash, eqNow * size);
        if (use < 5000) continue;
        const ep = raw * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, last: ep, src: f6 ? 'F6' : 'SURGE' });
      }
    }
    let eq = cash;
    for (const p of open) { const i = I4.get(p.m)!.get(ts); if (i !== undefined) p.last = H4.get(p.m)![i].close; eq += p.vol * p.last; }
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, bySrc };
}
function matchMdd(make: (x: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { size: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const TARGET = 17.0;
console.log(`=== 진입 지연 민감도 (${MKTS.length}코인, ${new Date(TS[0]).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===`);
console.log('  신호는 4h 확정봉에서. 진입만 "봉 마감 + N시간" 지점의 시장가로 바꾼다.');
console.log('  N=0 백테스트 가정 · N=3 현행 크론(00/04/08…) · N=1~2 정렬 크론의 실행 여유\n');
console.log('  지연 |   F6 단독 |  F6+급등 | 개선분 | 급등거래 | 급등 평균수익 |    PF');
console.log('  ' + '-'.repeat(84));
for (const off of [0, 1, 2, 3]) {
  const a = matchMdd((x) => run('F6', 7, 1, off, x, 3), TARGET);
  const b = matchMdd((x) => run('BOTH', 7, 1, off, x, 3), TARGET);
  const sg = b.res.bySrc.get('SURGE') ?? { n: 0, s: 0 };
  console.log(`  ${(off + 'h').padStart(4)} | ${(a.res.total.toFixed(0) + '%').padStart(9)} | ${(b.res.total.toFixed(0) + '%').padStart(8)} | ${(((b.res.total / a.res.total - 1) * 100).toFixed(0) + '%').padStart(6)} | ${String(sg.n).padStart(8)} | ${(sg.n ? (sg.s / sg.n * 100).toFixed(2) + '%' : '-').padStart(13)} | ${b.res.pf.toFixed(2).padStart(5)}`);
}
