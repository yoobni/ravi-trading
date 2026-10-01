/**
 * "더 늦추면?" — 기다림이 필터라면 어디까지 기다리는 게 좋은가.
 *
 * 앞선 결과: 매시간 판정(빠름)은 4시간 판정보다 나빴다. 봉이 마감될 때까지 기다리는 것
 * 자체가 "그 상승을 지켜냈는가"를 검증하는 필터였다. 그렇다면 더 기다리면?
 *
 * 두 갈래로 늦춘다:
 *   A. 봉을 키운다      : 급등을 8h / 12h / 24h 봉에서 판정 (더 긴 창을 지켜내야 함)
 *   B. 확인봉을 요구한다 : 4h 급등 후 **다음 봉까지 보고** 조건을 만족할 때만 산다
 *      (F6 가 원래 쓰는 구조다 — "어제 뚫고 오늘 확인")
 *      b1 다음 봉이 양봉 · b2 다음 봉 종가가 급등봉 종가 위 · b3 다음 봉이 급등봉 저가를 안 깸
 *      무조건 늦추기(플라시보)는 이미 나빴다(1339% vs 2001%) — 조건부는 다를 수 있다.
 *
 * 청산·배분은 고정. 동일 MDD 이분탐색, MDD 는 4h 경계 기준(앞선 급등 실험들과 같은 기준).
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84, FOUR = 4 * 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter((x) => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const H4 = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) H4.set(m, b); }
const MKTS = [...H4.keys()];
const I4 = new Map(MKTS.map((m) => [m, new Map(H4.get(m)!.map((b, i) => [b.ts, i]))]));
const TS = [...new Set(MKTS.flatMap((m) => H4.get(m)!.map((b) => b.ts)))].sort((a, b) => a - b);

/** 4h 를 n개씩 시각 기준으로 묶어 긴 봉을 만든다. 반환: 마감 4h ts → 합성봉 */
function bigBars(m: string, n: number): Map<number, Bar> {
  const b = H4.get(m)!, span = n * FOUR, out = new Map<number, Bar>();
  const g = new Map<number, Bar[]>();
  for (const x of b) { const k = Math.floor(x.ts / span) * span; if (!g.has(k)) g.set(k, []); g.get(k)!.push(x); }
  for (const [k, seg] of g) {
    if (seg.length < n) continue;   // 불완전한 봉은 버린다
    seg.sort((p, q) => p.ts - q.ts);
    // 이 봉은 마지막 4h 봉이 마감되는 시점(= k + span)에 완성된다
    out.set(k + span, {
      ts: k, open: seg[0].open, high: Math.max(...seg.map((x) => x.high)), low: Math.min(...seg.map((x) => x.low)),
      close: seg[seg.length - 1].close, volume: seg.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}
const BIG = new Map<number, Map<string, Map<number, Bar>>>();
for (const n of [2, 3, 6]) { const mm = new Map<string, Map<number, Bar>>(); for (const m of MKTS) mm.set(m, bigBars(m, n)); BIG.set(n, mm); }
/** 합성봉의 거래량 z — 같은 크기의 직전 w개 봉 대비 */
function bigVolZ(seq: Bar[], idx: number, w = 30) {
  if (idx < w) return 0;
  let s = 0, s2 = 0;
  for (let j = idx - w; j < idx; j++) { s += seq[j].volume; s2 += seq[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (seq[idx].volume - mn) / sd : 0;
}
const BIGSEQ = new Map<number, Map<string, { seq: Bar[]; idxOf: Map<number, number> }>>();
for (const n of [2, 3, 6]) {
  const mm = new Map<string, { seq: Bar[]; idxOf: Map<number, number> }>();
  for (const m of MKTS) {
    const map = BIG.get(n)!.get(m)!;
    const keys = [...map.keys()].sort((a, b) => a - b);
    const seq = keys.map((k) => map.get(k)!);
    mm.set(m, { seq, idxOf: new Map(keys.map((k, i) => [k, i])) });
  }
  BIGSEQ.set(n, mm);
}

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
const surge4 = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && volZ(b, i) >= vz;

type Mode = 'F6ONLY' | 'BASE' | 'BIG2' | 'BIG3' | 'BIG6' | 'CONF1' | 'CONF2' | 'CONF3';
interface Pos { m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number; src: string }

function run(mode: Mode, pct: number, vz: number, size: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const bySrc = new Map<string, { n: number; s: number }>();
  const t0 = Math.max(TS.findIndex((t) => t >= from), 200);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  for (let t = t0; t < t1; t++) {
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
    if (open.length < maxCon && t < t1 - 20) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = H4.get(m)!; const i = I4.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length) continue;
        const f6 = sigF6(b, i);
        let sg = false;
        if (mode === 'BASE') sg = surge4(b, i, pct, vz);
        else if (mode === 'BIG2' || mode === 'BIG3' || mode === 'BIG6') {
          const nBig = mode === 'BIG2' ? 2 : mode === 'BIG3' ? 3 : 6;
          const rec = BIGSEQ.get(nBig)!.get(m)!;
          // 이 4h 봉 마감(ts+4h)에 완성되는 큰 봉이 있는가
          const idx = rec.idxOf.get(ts + FOUR);
          if (idx !== undefined && idx >= 30) {
            const bb = rec.seq[idx];
            sg = (bb.close / bb.open - 1) >= pct / 100 && bigVolZ(rec.seq, idx) >= vz;
          }
        } else if (mode === 'CONF1' || mode === 'CONF2' || mode === 'CONF3') {
          // 급등은 직전 봉(i-1)에서 나고, 이번 봉(i)이 확인봉 — 진입은 i+1 시가
          if (i >= 44 && surge4(b, i - 1, pct, vz)) {
            if (mode === 'CONF1') sg = b[i].close > b[i].open;
            else if (mode === 'CONF2') sg = b[i].close > b[i - 1].close;
            else sg = b[i].low > b[i - 1].low;
          }
        }
        const hit = mode === 'F6ONLY' ? f6 : (f6 || (sg && !f6));
        if (!hit) continue;
        const use = Math.min(cash, eqNow * size);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
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
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (x: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { size: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[200], TARGET = 17.0;
console.log(`=== 더 늦추면? (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}, MDD ${TARGET}%) ===\n`);
const CASES: Array<[string, Mode, number, number]> = [
  ['F6 단독 (대조군)', 'F6ONLY', 0, 0],
  ['기준: 4h 급등 +7%', 'BASE', 7, 1.0],
  ['A. 8h 봉 급등 +7%', 'BIG2', 7, 1.0],
  ['A. 8h 봉 급등 +10%', 'BIG2', 10, 1.0],
  ['A. 12h 봉 급등 +10%', 'BIG3', 10, 1.0],
  ['A. 12h 봉 급등 +14%', 'BIG3', 14, 1.0],
  ['A. 24h 봉 급등 +14%', 'BIG6', 14, 1.0],
  ['A. 24h 봉 급등 +20%', 'BIG6', 20, 1.0],
  ['B. 4h급등 + 다음봉 양봉', 'CONF1', 7, 1.0],
  ['B. 4h급등 + 다음봉 종가↑', 'CONF2', 7, 1.0],
  ['B. 4h급등 + 저가 안깸', 'CONF3', 7, 1.0],
];
console.log('  구성                        |    총익 | 대조군대비 | 거래 | 급등건수 | 급등 평균 |    PF');
console.log('  ' + '-'.repeat(94));
let base = 0;
for (const [lbl, mode, pct, vz] of CASES) {
  const m = matchMdd((x) => run(mode, pct, vz, x, 3, FROM), TARGET);
  if (!base) base = m.res.total;
  const sg = m.res.bySrc.get('SURGE') ?? { n: 0, s: 0 };
  console.log(`  ${lbl.padEnd(28)}| ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.n).padStart(4)} | ${String(sg.n).padStart(8)} | ${(sg.n ? (sg.s / sg.n * 100).toFixed(2) + '%' : '-').padStart(9)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}
