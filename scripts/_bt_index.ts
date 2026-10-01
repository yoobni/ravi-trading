/**
 * 시장 타이밍 전략 — 결정 단위를 "코인"에서 "시장"으로 바꾼다.
 *
 * F6 는 "어떤 코인을 언제 살까"를 묻는다. 지금까지의 모든 시도(봉 종류·필터·사이징·스톱·
 * 유니버스·증액)는 그 질문 안에서의 변주였다. 전혀 다른 질문은 이것이다:
 *   **"지금 시장에 들어가 있을까 말까."**
 * 종목을 아예 고르지 않고 28코인 균등 바스켓을 통째로 들었다 놨다 한다.
 *
 * 신호 후보 (전부 확정봉까지의 정보만):
 *   MA    : 지수의 단기MA > 장기MA
 *   DON   : 지수가 N일 신고가 (돌파 — F6 와 같은 발상이나 개별코인이 아닌 지수에)
 *   BREADTH_MA : 자기 30일선 위에 있는 코인 비율 > 문턱
 *   BREADTH_HI : 7일 신고가를 낸 코인 비율 > 문턱  ← 횡단면 집계, F6 가 못 보는 정보
 *   VOL   : 지수 실현변동성이 하위 X 백분위 (수축 후 확장 베팅)
 *
 * 판정 기준(기존과 동일): 동일 MDD 이분탐색 고정, 기간분할 4구간, 비용 반영.
 * 그리고 **F6 와의 월별수익 상관**을 같이 잰다 — 약해도 상관이 낮으면 합쳤을 때 가치가 있다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;

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
const counts = new Map<number, number>();
for (const b of ALL.values()) for (const x of b) counts.set(x.ts, (counts.get(x.ts) ?? 0) + 1);
const TS = [...counts.entries()].filter(([, c]) => c === MKTS.length).map(([t]) => t).sort((a, b) => a - b);

/** 균등가중 지수 — 매 봉 코인별 수익률의 평균을 누적 (리밸런싱 비용은 별도로 안 잡는다: 신호용) */
const INDEX: number[] = [1];
for (let t = 1; t < TS.length; t++) {
  let s = 0, n = 0;
  for (const m of MKTS) {
    const i = IDX.get(m)!.get(TS[t]), j = IDX.get(m)!.get(TS[t - 1]);
    if (i === undefined || j === undefined) continue;
    const b = ALL.get(m)!;
    s += b[i].close / b[j].close - 1; n++;
  }
  INDEX.push(INDEX[t - 1] * (1 + (n ? s / n : 0)));
}
const sma = (v: number[], i: number, w: number) => { if (i < w) return NaN; let s = 0; for (let j = i - w + 1; j <= i; j++) s += v[j]; return s / w; };
/** 지수 실현변동성 (직전 w봉 수익률 표준편차) */
function rvol(i: number, w: number) {
  if (i < w + 1) return NaN;
  const r: number[] = [];
  for (let j = i - w + 1; j <= i; j++) r.push(INDEX[j] / INDEX[j - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}
/** 자기 30일선(180봉) 위에 있는 코인 비율 */
function breadthMA(t: number, w = 180) {
  let up = 0, n = 0;
  for (const m of MKTS) {
    const i = IDX.get(m)!.get(TS[t]); if (i === undefined || i < w) continue;
    const b = ALL.get(m)!;
    let s = 0; for (let j = i - w + 1; j <= i; j++) s += b[j].close;
    if (b[i].close > s / w) up++;
    n++;
  }
  return n ? up / n : NaN;
}
/** 직전 42봉(7일) 신고가를 낸 코인 비율 */
function breadthHigh(t: number, w = 42) {
  let up = 0, n = 0;
  for (const m of MKTS) {
    const i = IDX.get(m)!.get(TS[t]); if (i === undefined || i < w + 1) continue;
    const b = ALL.get(m)!;
    let hi = -Infinity; for (let j = i - w; j < i; j++) hi = Math.max(hi, b[j].high);
    if (b[i].high > hi) up++;
    n++;
  }
  return n ? up / n : NaN;
}
// 브레드스는 무거우므로 미리 계산
const BMA: number[] = [], BHI: number[] = [];
for (let t = 0; t < TS.length; t++) { BMA.push(breadthMA(t)); BHI.push(breadthHigh(t)); }

type Sig = (t: number) => boolean | null;
const SIGNALS: Array<[string, Sig]> = [
  ['MA 30/120봉 (5일/20일)', (t) => { const f = sma(INDEX, t, 30), s = sma(INDEX, t, 120); return Number.isFinite(f) && Number.isFinite(s) ? f > s : null; }],
  ['MA 42/252봉 (7일/42일)', (t) => { const f = sma(INDEX, t, 42), s = sma(INDEX, t, 252); return Number.isFinite(f) && Number.isFinite(s) ? f > s : null; }],
  ['지수 > 직전 120봉 최고', (t) => { if (t < 121) return null; let h = -Infinity; for (let j = t - 120; j < t; j++) h = Math.max(h, INDEX[j]); return INDEX[t] > h; }],
  ['지수 > 30일 이동평균', (t) => { const s = sma(INDEX, t, 180); return Number.isFinite(s) ? INDEX[t] > s : null; }],
  ['브레드스: 30일선 위 >50%', (t) => (Number.isFinite(BMA[t]) ? BMA[t] > 0.5 : null)],
  ['브레드스: 30일선 위 >60%', (t) => (Number.isFinite(BMA[t]) ? BMA[t] > 0.6 : null)],
  ['브레드스: 7일신고가 >10%', (t) => (Number.isFinite(BHI[t]) ? BHI[t] > 0.10 : null)],
  ['브레드스: 7일신고가 >20%', (t) => (Number.isFinite(BHI[t]) ? BHI[t] > 0.20 : null)],
  ['저변동성 (하위 30%)', (t) => { const v = rvol(t, 60); if (!Number.isFinite(v)) return null; const hist: number[] = []; for (let j = Math.max(60, t - 720); j <= t; j++) { const x = rvol(j, 60); if (Number.isFinite(x)) hist.push(x); } if (hist.length < 50) return null; hist.sort((a, b) => a - b); return v <= hist[Math.floor(hist.length * 0.3)]; }],
];

/** 신호가 켜지면 균등 바스켓 보유, 꺼지면 현금. 전환 시에만 비용. */
function runTiming(sig: Sig, expo: number, from: number, to?: number) {
  let eq = INIT, inMkt = false;
  let peak = INIT, mdd = 0, switches = 0, barsIn = 0, n = 0;
  let prevEqT = INIT;   // 전환비용까지 포함해 봉 간 자산 변화로 월수익을 잰다
  const monthly = new Map<string, number>();
  const t0 = Math.max(TS.findIndex((t) => t >= from), 300);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;
  for (let t = t0; t < t1 - 1; t++) {
    const want = sig(t);
    if (want !== null && want !== inMkt) { eq *= 1 - (FEE + SLIP) * expo; inMkt = want; switches++; }
    // 다음 봉 수익률을 얻는다 (신호는 확정봉 t 기준 → 미래참조 없음)
    let s = 0, c = 0;
    for (const m of MKTS) {
      const i = IDX.get(m)!.get(TS[t + 1]), j = IDX.get(m)!.get(TS[t]);
      if (i === undefined || j === undefined) continue;
      const b = ALL.get(m)!; s += b[i].close / b[j].close - 1; c++;
    }
    const r = c ? s / c : 0;
    const before = eq;
    if (inMkt) { eq *= 1 + r * expo; barsIn++; }
    n++;
    // 월별 수익은 **직전 자산 대비**로 적립해야 결합·복리 계산이 맞다.
    // 초기자본(INIT) 대비로 적립하면 자산이 커진 뒤의 수익률이 과대평가된다.
    const k = new Date(TS[t]).toISOString().slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + (prevEqT > 0 ? eq / prevEqT - 1 : 0));
    prevEqT = eq;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  return { total: (eq / INIT - 1) * 100, mdd, switches, inPct: n ? barsIn / n * 100 : 0, monthly };
}
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (e: number) => ReturnType<typeof runTiming>, target: number) {
  let lo = 0.05, hi = 3.0;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { expo: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[300], TARGET = 17.0;
console.log(`=== 시장 타이밍 (28코인 균등 바스켓, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===`);
console.log('  종목을 고르지 않는다. 시장에 "들어가 있을까 말까"만 결정한다.\n');
const bh = runTiming(() => true, 1, FROM);
console.log(`  단순 보유(항상 인)  총익 ${bh.total.toFixed(0)}% · MDD ${bh.mdd.toFixed(1)}%`);
console.log(`\n◆ 동일 MDD(${TARGET}%) 고정 — 노출배수를 조절해 위험을 맞춘다`);
console.log('  신호                        | 배수 |    총익 | MDD매칭 | 시장내% | 전환 | 수익/MDD');
console.log('  ' + '-'.repeat(92));
const results: Array<[string, ReturnType<typeof runTiming>]> = [];
for (const [lbl, s] of SIGNALS) {
  const m = matchMdd((e) => runTiming(s, e, FROM), TARGET);
  results.push([lbl, m.res]);
  console.log(`  ${lbl.padEnd(28)}| ${m.expo.toFixed(2).padStart(4)} | ${(m.res.total.toFixed(0) + '%').padStart(7) } | ${(m.res.mdd.toFixed(1) + '%').padStart(7)} | ${(m.res.inPct.toFixed(0) + '%').padStart(7)} | ${String(m.res.switches).padStart(4)} | ${(m.res.mdd > 0 ? m.res.total / m.res.mdd : 0).toFixed(2).padStart(8)}`);
}
const mbh = matchMdd((e) => runTiming(() => true, e, FROM), TARGET);
console.log(`  ${'단순 보유 (대조군)'.padEnd(28)}| ${mbh.expo.toFixed(2).padStart(4)} | ${(mbh.res.total.toFixed(0) + '%').padStart(7)} | ${(mbh.res.mdd.toFixed(1) + '%').padStart(7)} | ${'100%'.padStart(7)} | ${'0'.padStart(4)} | ${(mbh.res.total / mbh.res.mdd).toFixed(2).padStart(8)}`);

// ── F6 를 같은 하네스에 넣어 월별수익 상관과 결합 효과를 본다.
//    타이밍 전략이 F6 보다 약해도, 상관이 낮으면 합쳤을 때 수익/MDD 가 오를 수 있다.
//    (이게 이 실험의 진짜 목적이다 — 더 좋은 단일 전략이 아니라 다른 수익원)
const LB = 42, VW = 30, SL = -2, ACT = 2, GAP = 2, MAXB = 84;
const volZ = (b: Bar[], i: number) => {
  if (i < VW) return 0;
  let s = 0, s2 = 0;
  for (let j = i - VW; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / VW, sd = Math.sqrt(Math.max(s2 / VW - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= LB + 1 && b[i - 1].high > hiOf(b, i - LB, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;

function runF6(pct: number, from: number, to?: number) {
  let cash = INIT;
  const open: Array<{ m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number }> = [];
  let peak = INIT, mdd = 0;
  // ⚠ 월수익은 **봉과 봉 사이**의 자산 변화로 재야 한다.
  //   같은 봉 안에서 before/after 를 재면 둘 다 같은 가격이라 가격 변동이 통째로 빠지고
  //   거래비용만 남는다(실제로 총익 564% 가 재구성에서 51% 로 나왔다).
  let prevEq = INIT;
  const monthly = new Map<string, number>();
  const t0 = Math.max(TS.findIndex((t) => t >= from), 300);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;
  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) { cash += pos.vol * px * (1 - SLIP) * (1 - FEE); open.splice(p, 1); }
    }
    let eqNow = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.last); }
    if (open.length < 3 && t < t1 - 20) {
      for (const m of MKTS) {
        if (open.length >= 3) break;
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length || !sigF6(b, i)) continue;
        const use = Math.min(cash, eqNow * pct);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, last: ep });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.last = ALL.get(p.m)![i].close; eq += p.vol * p.last; }
    const k = new Date(ts).toISOString().slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + (prevEq > 0 ? eq / prevEq - 1 : 0));
    prevEq = eq;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  return { total: (fin / INIT - 1) * 100, mdd, monthly };
}
function corr(a: Map<string, number>, b: Map<string, number>) {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const x = keys.map((k) => a.get(k) ?? 0), y = keys.map((k) => b.get(k) ?? 0);
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : NaN;
}
/** 월별수익 시계열에서 총익·MDD 재구성 (결합 평가용) */
function statsFromMonthly(m: Map<string, number>) {
  const keys = [...m.keys()].sort();
  let eq = 1, peak = 1, mdd = 0;
  for (const k of keys) { eq *= 1 + (m.get(k) ?? 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100); }
  return { total: (eq - 1) * 100, mdd };
}
console.log('\n\n◆ F6 와의 관계 — 약해도 상관이 낮으면 합쳤을 때 가치가 있다');
const f6 = (() => { let lo = 0.02, hi = 1.2; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (runF6(mid, FROM).mdd > TARGET) hi = mid; else lo = mid; } return runF6((lo + hi) / 2, FROM); })();
console.log(`  F6 (동일 MDD ${TARGET}%) 총익 ${f6.total.toFixed(0)}%\n`);
console.log('  타이밍 신호                  | 단독 총익 | F6 상관 | F6와 50:50 결합 총익 / MDD | 수익/MDD | F6단독 대비');
console.log('  ' + '-'.repeat(112));
const f6s = statsFromMonthly(f6.monthly);
for (const [lbl, r] of results) {
  const c = corr(f6.monthly, r.monthly);
  const mix = new Map<string, number>();
  for (const k of new Set([...f6.monthly.keys(), ...r.monthly.keys()])) mix.set(k, 0.5 * (f6.monthly.get(k) ?? 0) + 0.5 * (r.monthly.get(k) ?? 0));
  const s = statsFromMonthly(mix);
  console.log(`  ${lbl.padEnd(28)}| ${(r.total.toFixed(0) + '%').padStart(9)} | ${(Number.isNaN(c) ? '-' : c.toFixed(2)).padStart(7)} | ${(s.total.toFixed(0) + '% / ' + s.mdd.toFixed(1) + '%').padStart(26)} | ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(8)} | ${((s.total / s.mdd) / (f6s.total / f6s.mdd) - 1 >= 0 ? '+' : '') + (((s.total / s.mdd) / (f6s.total / f6s.mdd) - 1) * 100).toFixed(0) + '%'}`);
}
console.log(`\n  F6 단독 (월별 재구성): ${f6s.total.toFixed(0)}% / MDD ${f6s.mdd.toFixed(1)}% · 수익/MDD ${(f6s.total / f6s.mdd).toFixed(2)}`);
