/**
 * 품질을 "필터"가 아니라 "비중"으로 쓰는 알고리즘 — 지금까지 배운 것의 종합.
 *
 * 관찰 정리:
 *   ① 병목은 자본 가동률이다 (현행 평균 투입 11.6%, 포지션 0개인 시간 72%).
 *   ② 그래서 품질을 필터로 쓰면 전부 실패한다 — 국면게이트·절반익절·13시필터·
 *      종목선발·유동성필터·유니버스축소가 모두 같은 이유로 떨어졌다.
 *   ③ 그런데 품질 차이는 실재한다 — 유동성 최상위 분위 PF 2.92 vs 최하위 2.09,
 *      중간 분위는 1.20까지 내려간다 (_bt_wide_f6 ①).
 *   ④ 품질을 안 희석하면서 가동률을 올린 유일한 수단이 같은 코인 증액이었다.
 *
 * 그래서: **신호를 버리지 않고, 품질에 비례해 크기만 바꾼다.**
 *   - 필터는 슬롯을 비워 현금을 놀리지만, 비중은 자본을 계속 굴린다.
 *   - 좋은 신호에 더 태우고 나쁜 신호에도 조금은 태운다.
 *
 * 품질 점수(전부 신호 시점의 확정봉 정보만 사용):
 *   liq   : 그 시점 후보군 내 거래대금 백분위
 *   volz  : 거래량 z 백분위 (F6 가 이미 쓰는 축, 시계열 기준)
 *   brk   : 돌파 강도 = (종가 − 직전 42봉 고가) / ATR 백분위
 *   합성  : 세 백분위의 평균 → 배수 m = mLow + (mHigh − mLow) × 점수
 *
 * 비교는 전부 MDD 를 현행 수준에 이분탐색으로 고정한 뒤 수행한다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const CUR28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function loadAll(): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^(KRW-[A-Z0-9]+)_240m_/);
    if (!m) continue;
    const bars = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    const cur = out.get(m[1]);
    if (!cur || bars.length > cur.length) out.set(m[1], bars);
  }
  return out;
}
const ALL = loadAll();
for (const [m, b] of [...ALL]) if (b.length < 500) ALL.delete(m);
const MKTS = [...ALL.keys()];
const IDX = new Map(MKTS.map((m) => [m, new Map(ALL.get(m)!.map((b, i) => [b.ts, i]))]));
// 캐시 종료 시점이 코인마다 달라 합집합을 쓰면 평가액이 왜곡된다 — 공통 종료 시점까지만 본다.
const ENDS = MKTS.map((m) => ALL.get(m)![ALL.get(m)!.length - 1].ts);
const COMMON_END = Math.min(...ENDS.filter((_, i) => CUR28.includes(MKTS[i])));
const TS = [...new Set(MKTS.flatMap((m) => ALL.get(m)!.map((b) => b.ts)))].filter((t) => t <= COMMON_END).sort((a, b) => a - b);

const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hi = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hi(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;
function atr(b: Bar[], i: number, w = 14) {
  if (i < w) return NaN;
  let s = 0;
  for (let j = i - w + 1; j <= i; j++) s += Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close));
  return s / w;
}
function turn(b: Bar[], i: number, w = 30) {
  if (i < w) return NaN;
  let s = 0;
  for (let j = i - w; j < i; j++) s += b[j].close * b[j].volume;
  return s / w;
}
/**
 * 시각별 "유니버스 전체 거래대금 분포"를 미리 만들어 둔다.
 * 동시에 뜬 신호(보통 1~3개)끼리 백분위를 매기면 표본이 없어 의미가 없다 —
 * _bt_wide_f6 ① 에서 품질 차이를 확인한 기준도 전체 유니버스 대비 순위였다.
 */
const TURNMAP = new Map<string, number[]>();
for (const m of MKTS) {
  const b = ALL.get(m)!;
  const arr = new Array(b.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    s += b[i].close * b[i].volume;
    if (i >= 30) s -= b[i - 30].close * b[i - 30].volume;
    if (i >= 30) arr[i] = s / 30;
  }
  TURNMAP.set(m, arr);
}
/** ts 시점 전 코인의 거래대금 정렬 배열 (백분위 계산용) */
const UNIV_TURN = new Map<number, number[]>();
for (const ts of TS) {
  const v: number[] = [];
  for (const m of MKTS) { const i = IDX.get(m)!.get(ts); if (i !== undefined) { const q = TURNMAP.get(m)![i]; if (Number.isFinite(q)) v.push(q); } }
  v.sort((a, b) => a - b);
  UNIV_TURN.set(ts, v);
}
/** 정렬된 배열에서 v 의 백분위 (0~1) */
function pctlIn(sorted: number[], v: number) {
  if (sorted.length < 2) return 0.5;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo / (sorted.length - 1);
}

type Tilt = { low: number; high: number; use: ('liq' | 'volz' | 'brk')[] };
interface Pos { m: string; ep: number; vol: number; used: number; entryIdx: number; peak: number; sl: number; armed: boolean; lastPx: number }

/**
 * @param tilt  null 이면 균등(현행). 아니면 품질 백분위로 배수 low~high 적용.
 * @param maxPerCoin 2 면 같은 코인 재신호 시 증액 허용(F6_v8 규칙)
 */
function run(universe: string[], pct: number, maxCon: number, maxPerCoin: number, tilt: Tilt | null, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0, deploySum = 0, nBars = 0;
  const uni = universe.filter((m) => ALL.has(m));
  const t0 = Math.max(TS.findIndex((t) => t >= from), 0);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.entryIdx) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.entryIdx) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        open.splice(p, 1);
      }
    }
    if (open.length < maxCon && t < t1 - 20) {
      // 이 시점 후보군 전체의 품질 분포를 만들어 백분위를 매긴다
      const rows: Array<{ m: string; i: number; liq: number; vz: number; brk: number }> = [];
      for (const m of uni) {
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length || !sigF6(b, i)) continue;
        const q = turn(b, i), a = atr(b, i);
        if (!Number.isFinite(q) || !Number.isFinite(a) || a <= 0) continue;
        rows.push({ m, i, liq: q, vz: volZ(b, i, 30), brk: (b[i].close - hi(b, i - 42, i - 1)) / a });
      }
      if (rows.length) {
        // 백분위: 후보가 1개뿐이면 0.5 로 둔다(비교 대상이 없으므로 중립)
        const univ = UNIV_TURN.get(ts) ?? [];
        let eqNow = cash;
        for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.lastPx); }
        for (const r of rows) {
          if (open.length >= maxCon) break;
          if (open.filter((p) => p.m === r.m).length >= maxPerCoin) continue;
          let mult = 1;
          if (tilt) {
            const parts: number[] = [];
            // liq 는 유니버스 전체 대비 백분위, volz·brk 는 값 자체가 표준화돼 있으므로 고정 스케일로 환산
            if (tilt.use.includes('liq')) parts.push(pctlIn(univ, r.liq));
            if (tilt.use.includes('volz')) parts.push(Math.max(0, Math.min(1, (r.vz - 0.5) / 2.5)));
            if (tilt.use.includes('brk')) parts.push(Math.max(0, Math.min(1, r.brk / 2)));
            const score = parts.reduce((s, x) => s + x, 0) / parts.length;
            mult = tilt.low + (tilt.high - tilt.low) * score;
          }
          const use = Math.min(cash, eqNow * pct * mult);
          if (use < 5000) continue;
          const b = ALL.get(r.m)!;
          const ep = b[r.i + 1].open * (1 + SLIP);
          cash -= use;
          open.push({ m: r.m, ep, vol: use * (1 - FEE) / ep, used: use, entryIdx: r.i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, lastPx: ep });
        }
      }
    }
    let eq = cash, posVal = 0;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.lastPx = ALL.get(p.m)![i].close; posVal += p.vol * p.lastPx; }
    eq += posVal;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    nBars++; deploySum += eq > 0 ? posVal / eq : 0;
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.lastPx;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, deploy: nBars ? deploySum / nBars * 100 : 0 };
}

const D = (s: string) => Date.parse(s + 'T00:00:00Z');
const FROM = D('2024-08-15');
function matchMdd(make: (pct: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  const pct = (lo + hi) / 2;
  return { pct, res: make(pct) };
}
console.log(`=== 품질 가중 사이징 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(COMMON_END).toISOString().slice(0,10)}) ===\n`);
const TARGET = 8.1;
const CASES: Array<[string, string[], number, Tilt | null]> = [
  ['현행: 28종 균등 · 증액X', CUR28, 1, null],
  ['28종 균등 · 증액O', CUR28, 2, null],
  ['28종 품질가중(liq) · 증액O', CUR28, 2, { low: 0.5, high: 1.5, use: ['liq'] }],
  ['28종 품질가중(3축) · 증액O', CUR28, 2, { low: 0.5, high: 1.5, use: ['liq', 'volz', 'brk'] }],
  ['28종 품질가중(3축·강) · 증액O', CUR28, 2, { low: 0.3, high: 1.7, use: ['liq', 'volz', 'brk'] }],
  ['111종 균등 · 증액O', MKTS, 2, null],
  ['111종 품질가중(liq) · 증액O', MKTS, 2, { low: 0.5, high: 1.5, use: ['liq'] }],
  ['111종 품질가중(3축) · 증액O', MKTS, 2, { low: 0.5, high: 1.5, use: ['liq', 'volz', 'brk'] }],
  ['111종 품질가중(3축·강) · 증액O', MKTS, 2, { low: 0.3, high: 1.7, use: ['liq', 'volz', 'brk'] }],
];
console.log(`◆ 동일 MDD(${TARGET}%) 고정 후 비교`);
console.log('  구성                            | 그때pct |    총익 | 현행대비 | 거래 |    PF | 가동률');
console.log('  ' + '-'.repeat(90));
const out: Array<[string, number, number]> = [];
for (const [lbl, uni, mpc, tilt] of CASES) {
  const m = matchMdd((pct) => run(uni, pct, 3, mpc, tilt, FROM), TARGET);
  out.push([lbl, m.pct, m.res.total]);
  const base = out[0][2];
  console.log(`  ${lbl.padEnd(32)}| ${((m.pct * 100).toFixed(1) + '%').padStart(7)} | ${(m.res.total.toFixed(0) + '%').padStart(7) } | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.n).padStart(4)} | ${m.res.pf.toFixed(2).padStart(5)} | ${(m.res.deploy.toFixed(0) + '%').padStart(6)}`);
}
