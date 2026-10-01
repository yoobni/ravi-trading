/**
 * 가설 H3 — 타임프레임을 "현실 체결"로 다시 스윕 (2026-10-01)
 *
 * 왜: 살아 있는 7전략 중 통계적으로 유의한 건 v6(12h) 하나다. 과거 스윕도 12h>4h>1h 였다.
 *   오늘 그 이유에 메커니즘이 생겼다 — **긴 봉 = 청산 결정 횟수가 적음 = 체결격차 노출이 적음.**
 *   과거 스윕은 "트리거 가격에 체결"을 가정했으므로 짧은 타임프레임을 과대평가했을 것이다.
 *
 * 검증 가능한 예측: 정산을 stop→market 으로 바꾸면 **긴 타임프레임의 상대 우위가 커져야 한다.**
 *   (안 커지면 메커니즘이 틀린 것이고, 12h 우위는 다른 이유다.)
 *
 * 규칙은 전부 비례 축소: lookback 7일, volZ 창 5일, 시간청산 14일 로 고정하고 봉 수만 환산.
 * 판정은 프로젝트 표준 — 동일 MDD 이분탐색 후 총익 비교, 그리고 기간분할.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2;
const H = 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load4h(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
/** 4h 봉 n개를 묶어 상위 타임프레임 합성. phase = 위상 오프셋(4h 단위) */
function agg(b4: Bar[], n: number, phase = 0): Bar[] {
  if (n === 1) return b4;
  const span = n * 4 * H;
  const bk = new Map<number, Bar[]>();
  for (const b of b4) {
    const k = Math.floor((b.ts - phase * 4 * H) / span) * span + phase * 4 * H;
    (bk.get(k) ?? bk.set(k, []).get(k)!).push(b);
  }
  const out: Bar[] = [];
  for (const k of [...bk.keys()].sort((a, b) => a - b)) {
    const s = bk.get(k)!.sort((p, q) => p.ts - q.ts);
    if (s.length !== n) continue;                      // 미완성 창 버림 (lookahead 방지)
    out.push({ ts: k, open: s[0].open, high: Math.max(...s.map(x => x.high)), low: Math.min(...s.map(x => x.low)), close: s[n - 1].close, volume: s.reduce((a, x) => a + x.volume, 0) });
  }
  return out;
}
const volZ = (b: Bar[], i: number, w: number) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };

const TFS = [
  { name: '4h', n: 1, lb: 42, vw: 30, maxb: 84 },
  { name: '8h', n: 2, lb: 21, vw: 15, maxb: 42 },
  { name: '12h', n: 3, lb: 14, vw: 10, maxb: 28 },
  { name: '24h', n: 6, lb: 7, vw: 5, maxb: 14 },
  { name: '48h', n: 12, lb: 4, vw: 3, maxb: 7 },
];
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load4h(m); if (b && b.length > 500) RAW.set(m, b); }

interface Pos { m: string; ep: number; vol: number; used: number; bars: number; peak: number; stop: number; armed: boolean; last: number }

/** mgmt='tf' 신호TF로 포지션 관리(초기 테스트) · 'h4' 신호는 TF, **스톱 감시·체결은 4h** (실제 구현) */
function run(tf: typeof TFS[number], size: number, settle: 'stop' | 'market', phase = 0, from = 0, to = Infinity, mgmt: 'tf' | 'h4' = 'tf') {
  const BARS = new Map<string, Bar[]>(), IDX = new Map<string, Map<number, number>>();
  for (const [m, b] of RAW) { const a = agg(b, tf.n, phase); BARS.set(m, a); IDX.set(m, new Map(a.map((x, i) => [x.ts, i]))); }
  const TS = [...new Set([...BARS.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
  // 관리 격자: 'h4' 면 원본 4h 봉으로 청산을 감시한다 (신호만 상위 TF)
  const MB = mgmt === 'h4' ? RAW : BARS;
  const MI = mgmt === 'h4' ? new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))])) : IDX;
  const MTS = mgmt === 'h4' ? [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b) : TS;
  const ENTRY = new Set(TS);
  const maxMgmtBars = mgmt === 'h4' ? tf.maxb * tf.n : tf.maxb;
  const sig = (b: Bar[], i: number) =>
    i >= tf.lb + 1 && b[i - 1].high > hiOf(b, i - tf.lb, i - 1) && b[i].close > b[i].open &&
    b[i].close > b[i - 1].high && volZ(b, i, tf.vw) >= 0.5;

  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0;
  for (const ts of MTS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const bb = MB.get(q.m)!; const i = MI.get(q.m)!.get(ts);
      if (i === undefined) continue;
      const bar = bb[i]; q.last = bar.close; q.bars++;
      let px: number | null = null;
      if (bar.low <= q.stop) px = settle === 'stop' ? q.stop : bar.close;
      else if (q.bars >= maxMgmtBars) px = bar.close;
      if (px != null) {
        const got = q.vol * px * (1 - SLIP) * (1 - FEE);
        cash += got; n++; sumR += got / q.used - 1;
        open.splice(p, 1); continue;
      }
      q.peak = Math.max(q.peak, bar.high);
      if (!q.armed && q.peak >= q.ep * (1 + ACT / 100)) q.armed = true;
      if (q.armed) q.stop = Math.max(q.stop, q.peak * (1 - GAP / 100));
    }
    if (ENTRY.has(ts) && open.length < 3) {
      for (const m of RAW.keys()) {
        if (open.length >= 3) break;
        const bb = BARS.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < tf.lb + 3) continue;
        if (!sig(bb, i - 1)) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + SLIP);
        const eqNow = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
        const used = EQSIZE ? Math.min(cash, eqNow * size) : cash * size;
        if (used < 5000) continue;
        cash -= used;
        open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, peak: ep, stop: ep * (1 + SL / 100), armed: false, last: ep });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
function sizeFor(tf: typeof TFS[number], target: number, settle: 'stop' | 'market', phase = 0, mgmt: 'tf' | 'h4' = 'tf') {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (run(tf, mid, settle, phase, 0, Infinity, mgmt).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

let EQSIZE = false;   // true = equity×size (원 연구 방식) / false = cash×size (라이브 코드 방식)
const T = 17;
console.log(`28코인 · 4h 캐시 합성 · 동일 MDD ${T}% 이분탐색 · 트레일 A2 고정\n`);
const res: Record<string, Record<string, number>> = {};
for (const settle of ['stop', 'market'] as const) {
  console.log(`[정산 ${settle === 'stop' ? '트리거가격 (기존 가정)' : '시장가 (현실)'}]`);
  console.log('  TF    총익    MDD    size   거래수  거래당');
  res[settle] = {};
  for (const tf of TFS) {
    const s = sizeFor(tf, T, settle); const r = run(tf, s, settle);
    res[settle][tf.name] = r.ret;
    console.log(`  ${tf.name.padEnd(5)} ${(r.ret.toFixed(0) + '%').padStart(6)} ${(r.mdd.toFixed(1) + '%').padStart(6)} ${((s * 100).toFixed(1) + '%').padStart(7)} ${String(r.n).padStart(7)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)}`);
  }
  console.log('');
}
console.log('── 예측 검정: 정산을 현실로 바꾸면 긴 TF 의 상대 우위가 커지는가 ──');
console.log('  TF    4h대비(트리거가격)   4h대비(시장가)   우위 변화');
for (const tf of TFS) {
  const a = res['stop'][tf.name] / res['stop']['4h'], b = res['market'][tf.name] / res['market']['4h'];
  console.log(`  ${tf.name.padEnd(5)} ${(a.toFixed(2) + '배').padStart(14)} ${(b.toFixed(2) + '배').padStart(16)}   ${b > a ? '커짐 ✓' : b < a ? '작아짐 ✗' : '동일'}`);
}

console.log('\n══ 수정판: 신호는 상위 TF, 스톱 감시·체결은 4h (실제 구현 방식) ══');
console.log('  TF    총익    MDD    size   거래수  거래당   수익/MDD');
for (const tf of TFS) {
  const sz = sizeFor(tf, T, 'market', 0, 'h4');
  const r = run(tf, sz, 'market', 0, 0, Infinity, 'h4');
  console.log(`  ${tf.name.padEnd(5)} ${(r.ret.toFixed(0)+'%').padStart(6)} ${(r.mdd.toFixed(1)+'%').padStart(6)} ${((sz*100).toFixed(1)+'%').padStart(7)} ${String(r.n).padStart(7)} ${((r.avg>=0?'+':'')+r.avg.toFixed(2)+'%').padStart(8)} ${(r.ret/Math.max(r.mdd,0.01)).toFixed(2).padStart(9)}`);
}
// ── 기준점: BTC 를 같은 MDD 로 낮춰서 보유 ──
{
  const b = RAW.get('KRW-BTC')!;
  const sim = (f: number) => {
    let peak = -1, mdd = 0;
    const p0 = b[0].open;
    for (const x of b) {
      const lo = 1 + f * (x.low / p0 - 1), hi = 1 + f * (x.high / p0 - 1);
      peak = Math.max(peak, hi); mdd = Math.max(mdd, (peak - lo) / peak);
    }
    return { ret: 100 * f * (b[b.length - 1].close / p0 - 1), mdd: 100 * mdd };
  };
  let lo = 0.01, hi = 1;
  for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (sim(mid).mdd > T) hi = mid; else lo = mid; }
  const r = sim((lo + hi) / 2);
  console.log(`\n  [기준점] BTC ${((lo+hi)/2*100).toFixed(1)}% 보유 + 나머지 현금 → 총익 ${r.ret.toFixed(0)}% · MDD ${r.mdd.toFixed(1)}% · 수익/MDD ${(r.ret/r.mdd).toFixed(2)}`);
}

console.log('\n══ 사이징 방식 비교 (신호TF, 스톱감시 4h, 현실 체결, 동일 MDD 17%) ══');
console.log('  TF    cash×size   equity×size');
for (const tf of TFS) {
  EQSIZE = false; const a = run(tf, sizeFor(tf, T, 'market', 0, 'h4'), 'market', 0, 0, Infinity, 'h4');
  EQSIZE = true;  const b = run(tf, sizeFor(tf, T, 'market', 0, 'h4'), 'market', 0, 0, Infinity, 'h4');
  EQSIZE = false;
  console.log(`  ${tf.name.padEnd(5)} ${(a.ret.toFixed(0)+'%').padStart(9)} ${(b.ret.toFixed(0)+'%').padStart(13)}`);
}
console.log('\n  (참고) 같은 MDD 17% 에서 BTC 축소보유 = +15%');
