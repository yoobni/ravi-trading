/**
 * 청산 규칙군 교체 — "고정 % 트레일" 대신 추세 구조로 나간다.
 *
 * 관찰: 지금 F6 는 이름은 추세추종인데 평균 보유가 13시간이다. 사실상 스캘핑이다.
 *   고점 대비 2% 라는 고정 폭이, 추세가 자리 잡기도 전에 잔파동에 끊긴다.
 *   그동안 바꿔본 것은 그 폭(ACT/GAP)과 초기 스톱뿐 — **규칙의 종류**는 4년간 하나였다.
 *
 * 진짜 추세추종은 가격의 구조로 나간다. 네 가지 계열을 시험한다(진입은 F6 로 고정):
 *   TRAIL  : 고점 대비 GAP% (현행, 대조군)
 *   MA     : 종가가 N봉 이동평균 아래로 마감하면 청산 — 추세의 기울기로 판정
 *   DON    : 종가가 직전 N봉 최저가 아래로 마감하면 청산 — 되돌림의 깊이로 판정
 *   CHAND  : 고점 − k×ATR (샹들리에) — 그 종목의 변동성에 비례한 폭
 *
 * 전부 초기 스톱 −2% 는 유지(진입 직후 붕괴 방어). MDD 이분탐색 고정, 기간분할 4구간.
 * 보유기간 분포도 같이 본다 — 규칙이 실제로 더 오래 들고 가는지 확인해야 한다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL0 = -2, MAXB = 84 * 3;   // 시간청산은 넉넉히(42일) — 규칙이 스스로 끝내게 둔다

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter((x) => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const ALL = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) ALL.set(m, b); }
const MKTS = [...ALL.keys()];
const IDX = new Map(MKTS.map((m) => [m, new Map(ALL.get(m)!.map((b, i) => [b.ts, i]))]));
const TS = [...new Set(MKTS.flatMap((m) => ALL.get(m)!.map((b) => b.ts)))].sort((a, b) => a - b);

const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const loOf = (b: Bar[], f: number, t: number) => { let m = Infinity; for (let j = f; j < t; j++) m = Math.min(m, b[j].low); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
function sma(b: Bar[], i: number, w: number) { if (i < w - 1) return NaN; let s = 0; for (let j = i - w + 1; j <= i; j++) s += b[j].close; return s / w; }
function atr(b: Bar[], i: number, w = 14) {
  if (i < w) return NaN;
  let s = 0;
  for (let j = i - w + 1; j <= i; j++) s += Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close));
  return s / w;
}

type Kind = 'TRAIL' | 'MA' | 'DON' | 'CHAND';
interface Exit { kind: Kind; act: number; gap: number; n: number; k: number }
interface Pos { m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number }

function run(ex: Exit, pct: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const holds: number[] = [];
  const t0 = Math.max(TS.findIndex((t) => t >= from), 200);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;
  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      // 초기 스톱은 모든 규칙 공통 — 진입 직후 붕괴 방어
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      if (!done) {
        pos.peak = Math.max(pos.peak, bar.high);
        if (ex.kind === 'TRAIL') {
          if (!pos.armed && pos.peak >= pos.ep * (1 + ex.act / 100)) pos.armed = true;
          if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - ex.gap / 100));
        } else if (ex.kind === 'MA') {
          const m = sma(b, i, ex.n);
          if (Number.isFinite(m) && bar.close < m) { px = bar.close; done = true; }
        } else if (ex.kind === 'DON') {
          const lo = loOf(b, Math.max(0, i - ex.n), i);
          if (Number.isFinite(lo) && bar.close < lo) { px = bar.close; done = true; }
        } else if (ex.kind === 'CHAND') {
          const a = atr(b, i);
          if (Number.isFinite(a)) pos.sl = Math.max(pos.sl, pos.peak - ex.k * a);
        }
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        holds.push((i - pos.ei) * 4);   // 시간 단위
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.last); }
    if (open.length < maxCon && t < t1 - 20) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length || !sigF6(b, i)) continue;
        const use = Math.min(cash, eqNow * pct);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + SL0 / 100), armed: false, last: ep });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.last = ALL.get(p.m)![i].close; eq += p.vol * p.last; }
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  holds.sort((a, b) => a - b);
  return {
    total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99,
    medHold: holds.length ? holds[Math.floor(holds.length / 2)] : 0,
    p90Hold: holds.length ? holds[Math.floor(holds.length * 0.9)] : 0,
  };
}
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (p: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 15; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { pct: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[200], TARGET = 17.0;
console.log(`=== 청산 규칙군 교체 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===`);
console.log('  진입(F6)·초기스톱(−2%) 고정. 청산 "규칙의 종류"만 바꾼다.\n');
const CASES: Array<[string, Exit]> = [
  ['TRAIL 고점−2% (현행)', { kind: 'TRAIL', act: 2, gap: 2, n: 0, k: 0 }],
  ['TRAIL 고점−4%', { kind: 'TRAIL', act: 2, gap: 4, n: 0, k: 0 }],
  ['MA 이탈 6봉(1일)', { kind: 'MA', act: 0, gap: 0, n: 6, k: 0 }],
  ['MA 이탈 12봉(2일)', { kind: 'MA', act: 0, gap: 0, n: 12, k: 0 }],
  ['MA 이탈 30봉(5일)', { kind: 'MA', act: 0, gap: 0, n: 30, k: 0 }],
  ['MA 이탈 60봉(10일)', { kind: 'MA', act: 0, gap: 0, n: 60, k: 0 }],
  ['DON 이탈 6봉 최저', { kind: 'DON', act: 0, gap: 0, n: 6, k: 0 }],
  ['DON 이탈 12봉 최저', { kind: 'DON', act: 0, gap: 0, n: 12, k: 0 }],
  ['DON 이탈 24봉 최저', { kind: 'DON', act: 0, gap: 0, n: 24, k: 0 }],
  ['샹들리에 고점−2ATR', { kind: 'CHAND', act: 0, gap: 0, n: 0, k: 2 }],
  ['샹들리에 고점−3ATR', { kind: 'CHAND', act: 0, gap: 0, n: 0, k: 3 }],
  ['샹들리에 고점−4ATR', { kind: 'CHAND', act: 0, gap: 0, n: 0, k: 4 }],
];
console.log('  청산 규칙                  | 그때pct |    총익 | 대조군대비 | 거래 |    WR |    PF | 중앙보유 | 상위10%보유');
console.log('  ' + '-'.repeat(112));
const out: Array<[string, number, ReturnType<typeof run>]> = [];
for (const [lbl, ex] of CASES) {
  const m = matchMdd((p) => run(ex, p, 3, FROM), TARGET);
  out.push([lbl, m.pct, m.res]);
  const base = out[0][2].total;
  console.log(`  ${lbl.padEnd(26)}| ${((m.pct * 100).toFixed(1) + '%').padStart(7)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.n).padStart(4)} | ${m.res.wr.toFixed(1).padStart(4)}% | ${m.res.pf.toFixed(2).padStart(5)} | ${(m.res.medHold + 'h').padStart(8)} | ${(m.res.p90Hold + 'h').padStart(10)}`);
}

// ── 2단 청산: 증명 전에는 빠르게, 증명 후에만 길게.
//    위 결과의 원인은 명확하다 — 넓은 청산은 "결국 안 될 거래"에도 되돌림을 다 내주고,
//    그래서 MDD 를 맞추려 포지션을 27.7%→12% 로 줄여야 해서 복리가 죽는다.
//    그러면 수익이 T% 를 넘어 "증명된" 뒤에만 넓은 규칙으로 갈아타면 된다.
type Stage2 = { kind: Kind; gap: number; n: number; k: number };
function run2(switchAt: number, s2: Stage2, pct: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Array<Pos & { staged: boolean }> = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0, staged = 0;
  const holds: number[] = [];
  const t0 = Math.max(TS.findIndex((t) => t >= from), 200);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;
  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      if (!done) {
        pos.peak = Math.max(pos.peak, bar.high);
        // 1단: 고점−2% 트레일. 수익이 switchAt% 를 넘으면 2단으로 승격.
        if (!pos.staged && pos.peak >= pos.ep * (1 + switchAt / 100)) { pos.staged = true; staged++; }
        if (!pos.staged) {
          if (!pos.armed && pos.peak >= pos.ep * 1.02) pos.armed = true;
          if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * 0.98);
        } else if (s2.kind === 'TRAIL') {
          pos.sl = Math.max(pos.sl, pos.peak * (1 - s2.gap / 100));
        } else if (s2.kind === 'MA') {
          const m = sma(b, i, s2.n);
          if (Number.isFinite(m) && bar.close < m) { px = bar.close; done = true; }
        } else if (s2.kind === 'DON') {
          const lo = loOf(b, Math.max(0, i - s2.n), i);
          if (Number.isFinite(lo) && bar.close < lo) { px = bar.close; done = true; }
        } else if (s2.kind === 'CHAND') {
          const a = atr(b, i);
          if (Number.isFinite(a)) pos.sl = Math.max(pos.sl, pos.peak - s2.k * a);
        }
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        holds.push((i - pos.ei) * 4);
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.last); }
    if (open.length < maxCon && t < t1 - 20) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length || !sigF6(b, i)) continue;
        const use = Math.min(cash, eqNow * pct);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + SL0 / 100), armed: false, last: ep, staged: false });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.last = ALL.get(p.m)![i].close; eq += p.vol * p.last; }
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  holds.sort((a, b) => a - b);
  return { total: (fin / INIT - 1) * 100, mdd, n, staged, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, p90Hold: holds.length ? holds[Math.floor(holds.length * 0.9)] : 0 };
}
function matchMdd2(make: (p: number) => ReturnType<typeof run2>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 15; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { pct: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
console.log('\n\n◆ 2단 청산 — 수익 T% 돌파 후에만 넓은 규칙으로 승격 (동일 MDD 17%)');
console.log('  승격문턱 | 2단 규칙        |    총익 | 대조군대비 | 거래 | 승격수 |    PF | 상위10%보유');
console.log('  ' + '-'.repeat(96));
const base = out[0][2].total;
const S2: Array<[string, Stage2]> = [
  ['고점−4% 트레일', { kind: 'TRAIL', gap: 4, n: 0, k: 0 }],
  ['고점−6% 트레일', { kind: 'TRAIL', gap: 6, n: 0, k: 0 }],
  ['MA 30봉 이탈', { kind: 'MA', gap: 0, n: 30, k: 0 }],
  ['DON 24봉 이탈', { kind: 'DON', gap: 0, n: 24, k: 0 }],
  ['샹들리에 3ATR', { kind: 'CHAND', gap: 0, n: 0, k: 3 }],
];
for (const th of [5, 10, 15]) {
  for (const [lbl, s2] of S2) {
    const m = matchMdd2((p) => run2(th, s2, p, 3, FROM), TARGET);
    console.log(`  ${('+' + th + '%').padStart(8)} | ${lbl.padEnd(15)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.n).padStart(4)} | ${String(m.res.staged).padStart(6)} | ${m.res.pf.toFixed(2).padStart(5)} | ${(m.res.p90Hold + 'h').padStart(10)}`);
  }
}
console.log(`\n  대조군(현행 고점−2%): ${base.toFixed(0)}%`);
