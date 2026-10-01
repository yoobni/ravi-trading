/**
 * "얼마나 자주 쳐다볼 것인가" — 판정 주기 자체를 바꾼다.
 *
 * 앞선 실험(_bt_surge_offset)은 **위상** 문제를 다뤘다: 봉이 마감된 뒤 몇 시간 있다가 사느냐.
 * 그런데 더 근본적인 제약이 있다 — **4시간에 한 번만 쳐다본다는 것.**
 * 급등이 봉 시작 30분 만에 일어나도, 그 봉이 마감될 때까지 존재 자체를 모른다.
 * 구조적으로 0~4시간 늦고, 평균 2시간 늦다.
 *
 * 매시간 쳐다보면 그 지연이 0~1시간으로 줄어든다. 대신 신호가 달라진다 —
 * "완성된 4시간봉이 +7%" 가 아니라 "지금까지 4시간 동안 +7%" 가 된다(이동창).
 *
 *   A. 4h 봉 판정 (현행 설계)      : 4시간마다, 확정봉 기준
 *   B. 1h 판정 · 이동 4시간 상승률 : 매시간, 직전 4시간 누적 상승률이 문턱을 처음 넘을 때
 *   C. 1h 판정 · 1시간 상승률      : 매시간, 그 1시간의 상승률 기준
 *
 * 청산은 셋 다 4h 봉 경계에서 판정한다(현행 라이브와 동일) — 진입 주기 효과만 분리하기 위해.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84, FOUR = 4 * 3600_000, HOUR = 3600_000;

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
// 1h 시계 (판정 루프의 기준). 1h 캐시 공통 시작 + 워밍업 이후.
const START = Math.max(...MKTS.map((m) => H1.get(m)![0].ts)) + 300 * HOUR;
const T1 = [...new Set(MKTS.flatMap((m) => H1.get(m)!.map((b) => b.ts)))].filter((t) => t >= START).sort((a, b) => a - b);

const volZ4 = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ4(b, i) >= 0.5;
const sigSurge4 = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && volZ4(b, i) >= vz;
/** 1h 배열에서 직전 win시간 누적 상승률 */
const roll = (b: Bar[], i: number, win: number) => (i < win ? NaN : b[i].close / b[i - win].close - 1);
/** 1h 거래량 z (직전 w봉) */
const volZ1 = (b: Bar[], i: number, w = 120) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};

type Watch = 'BAR4' | 'ROLL4' | 'H1' | 'F6ONLY';
interface Pos { m: string; ep: number; vol: number; used: number; entryTs: number; entry4Idx: number; peak: number; sl: number; armed: boolean; last: number; src: string }

/**
 * @param mddEvery4h true 면 MDD 를 4h 경계에서만 잰다(다른 스크립트와 동일 기준).
 *   매시간 재면 더 깊은 골이 잡혀 MDD 가 커지고, 동일 MDD 매칭 시 포지션이 작아진다.
 *   즉 시간 단위 평가가 더 보수적이다.
 */
function run(watch: Watch, pct: number, vz: number, size: number, maxCon: number, mddEvery4h = false) {
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const bySrc = new Map<string, { n: number; s: number }>();

  for (let t = 1; t < T1.length - 2; t++) {
    const ts = T1[t];
    const is4Boundary = ts % FOUR === 0;   // 캐시 ts 는 UTC — 4h 봉은 UTC 00/04/08…

    // ── 청산: 4h 봉 경계에서만 (현행 라이브와 동일)
    if (is4Boundary) {
      for (let p = open.length - 1; p >= 0; p--) {
        const pos = open[p]; const b = H4.get(pos.m)!; const i = I4.get(pos.m)!.get(ts);
        if (i === undefined || i <= pos.entry4Idx) continue;
        const bar = b[i]; let px = 0, done = false;
        if (bar.low <= pos.sl) { px = pos.sl; done = true; }
        else {
          pos.peak = Math.max(pos.peak, bar.high);
          if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
          if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
        }
        if (!done && (i - pos.entry4Idx) >= MAXB) { px = bar.close; done = true; }
        if (done) {
          const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
          cash += pr;
          const r = pr / pos.used - 1;
          n++; if (r > 0) { wins++; gw += r; } else gl += -r;
          const k = bySrc.get(pos.src) ?? { n: 0, s: 0 }; k.n++; k.s += r; bySrc.set(pos.src, k);
          open.splice(p, 1);
        }
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = I1.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? H1.get(p.m)![i].close : p.last); }

    // ── 진입 판정
    //   ⚠ 시각 ts 에서 "완성된" 봉은 ts 에 **끝난** 봉이다.
    //      1h: 인덱스 i1−1 (ts−1h 에 시작해 ts 에 마감)
    //      4h: ts−4h 에 시작한 봉 (ts 가 4h 경계일 때만)
    //      I4/I1.get(ts) 는 ts 에 **시작하는** 봉(아직 진행 중)이므로 그대로 쓰면 미래참조다.
    const evaluate = (watch === 'BAR4' || watch === 'F6ONLY') ? is4Boundary : true;
    if (evaluate && open.length < maxCon) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b1 = H1.get(m)!; const i1 = I1.get(m)!.get(ts);
        if (i1 === undefined || i1 < 1 || i1 >= b1.length) continue;
        const b4 = H4.get(m)!;
        const i4done = is4Boundary ? I4.get(m)!.get(ts - FOUR) : undefined;   // 방금 마감된 4h 봉
        let hit = false, src = '';

        if (watch === 'F6ONLY') {
          if (i4done === undefined) continue;
          hit = sigF6(b4, i4done); src = 'F6';
        } else if (watch === 'BAR4') {
          if (i4done === undefined) continue;
          const f6 = sigF6(b4, i4done), sg = sigSurge4(b4, i4done, pct, vz);
          hit = f6 || (sg && !f6); src = f6 ? 'F6' : 'SURGE';
        } else {
          const win = watch === 'ROLL4' ? 4 : 1;
          const j = i1 - 1;   // 방금 마감된 1h 봉
          const cur = roll(b1, j, win), prev = roll(b1, j - 1, win);
          const cross = Number.isFinite(cur) && Number.isFinite(prev) && cur >= pct / 100 && prev < pct / 100;
          if (cross && volZ1(b1, j) >= vz) { hit = true; src = 'SURGE'; }
          if (!hit && i4done !== undefined && sigF6(b4, i4done)) { hit = true; src = 'F6'; }
        }
        if (!hit) continue;
        const use = Math.min(cash, eqNow * size);
        if (use < 5000) continue;
        const ep = b1[i1].open * (1 + SLIP);   // 지금 이 순간(막 시작한 1h 봉의 시가)에 시장가 매수
        const cur4 = I4.get(m)!.get(Math.floor(ts / FOUR) * FOUR);
        if (cur4 === undefined) continue;
        cash -= use;
        open.push({
          m, ep, vol: use * (1 - FEE) / ep, used: use, entryTs: ts,
          entry4Idx: cur4, peak: ep, sl: ep * (1 + SL / 100), armed: false, last: ep, src,
        });
      }
    }
    let eq = cash;
    for (const p of open) { const i = I1.get(p.m)!.get(ts); if (i !== undefined) p.last = H1.get(p.m)![i].close; eq += p.vol * p.last; }
    if (!mddEvery4h || is4Boundary) { peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100); }
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, bySrc };
}
function matchMdd(make: (x: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 13; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { size: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const TARGET = 17.0;
console.log(`=== 판정 주기 (${MKTS.length}코인, ${new Date(T1[0]).toISOString().slice(0,10)}~${new Date(T1[T1.length-1]).toISOString().slice(0,10)}) ===`);
console.log('  청산은 셋 다 4h 봉 경계 판정(현행 라이브와 동일). 진입 판정 주기만 다르다.\n');
console.log('  판정 방식                              |    총익 |    MDD | 거래 | 급등건수 | 급등 평균 |    PF');
console.log('  ' + '-'.repeat(96));
const CASES: Array<[string, Watch, number, number]> = [
  ['대조군. F6 단독 (4시간마다)', 'F6ONLY', 0, 0],
  ['A. 4시간마다 · 완성된 4h봉 +7%', 'BAR4', 7, 1.0],
  ['B. 1시간마다 · 직전 4시간 +7%', 'ROLL4', 7, 1.0],
  ['B2. 1시간마다 · 직전 4시간 +5%', 'ROLL4', 5, 1.0],
  ['B3. 1시간마다 · 직전 4시간 +10%', 'ROLL4', 10, 1.0],
  ['C. 1시간마다 · 그 1시간 +4%', 'H1', 4, 1.0],
  ['C2. 1시간마다 · 그 1시간 +7%', 'H1', 7, 1.0],
];
for (const [lbl, w, pct, vz] of CASES) {
  const m = matchMdd((x) => run(w, pct, vz, x, 3), TARGET);
  const sg = m.res.bySrc.get('SURGE') ?? { n: 0, s: 0 };
  console.log(`  ${lbl.padEnd(38)}| ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(m.res.mdd.toFixed(1) + '%').padStart(6)} | ${String(m.res.n).padStart(4)} | ${String(sg.n).padStart(8)} | ${(sg.n ? (sg.s / sg.n * 100).toFixed(2) + '%' : '-').padStart(9)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}


console.log('\n◆ MDD 측정 주기의 영향 — 왜 스크립트마다 절대값이 다른가');
console.log('  측정 주기 | F6 단독 | F6+급등(A) | 비고');
for (const every4 of [false, true]) {
  const a = matchMdd((x) => run('F6ONLY', 0, 0, x, 3, every4), TARGET);
  const b = matchMdd((x) => run('BAR4', 7, 1.0, x, 3, every4), TARGET);
  console.log(`  ${(every4 ? '4시간마다' : '매시간').padEnd(9)} | ${(a.res.total.toFixed(0) + '%').padStart(7)} | ${(b.res.total.toFixed(0) + '%').padStart(10)} | 포지션 크기 ${(a.size * 100).toFixed(1)}% / ${(b.size * 100).toFixed(1)}%`);
}
console.log('\n  → 매시간 평가하면 골이 더 깊게 잡혀 같은 MDD 를 맞추려 포지션을 줄이게 된다.');
console.log('    절대값 비교는 같은 기준끼리만. 순위(무엇이 더 나은가)는 두 기준에서 동일하다.');
