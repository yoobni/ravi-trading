/**
 * 진입·스톱 역학 — 지금까지 한 번도 안 건드린 축.
 *
 * 그동안의 시도는 전부 "무엇을 살까"였다(신호·유니버스·선발·사이징·필터·타임프레임).
 * 정작 **어떻게 사고 어떻게 손절하는가**는 4년간 고정이었다:
 *   진입 = 신호봉 다음 봉 시가에 시장가, 초기 스톱 = 진입가 −2% 고정.
 *
 *   ① 재진입   : 손절 후 추세가 살아나도 F6 는 새 7일 신고가가 날 때까지 안 산다.
 *                손절당한 코인이 직전 고점을 되찾으면 다시 태운다.
 *                → 검증된 국면에 자본을 재투입하므로 가동률이 오르되 품질은 안 희석된다.
 *   ② 지정가 진입: 돌파 다음 봉은 되밀리는 경우가 많다. 시가보다 d% 아래에 지정가를 걸고
 *                닿을 때만 산다. 진입가가 좋아지지만 안 걸리면 거래를 놓친다(가동률 ↓).
 *                두 힘의 순효과를 본다.
 *   ③ 구조적 스톱: −2% 고정은 코인 변동성과 무관하다. 돌파봉 저가 아래로 두면
 *                "돌파가 무효화됐을 때"만 잘린다. 스톱은 넓어지지만 흔들려 나가는 게 준다.
 *
 * 전부 동일 MDD 이분탐색 고정 + 기간분할 4구간. 플라시보가 가능한 항목은 같이 잰다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const ACT_REF = { v: 2 };
const GAP = 2, MAXB = 84;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const fsx = fs.readdirSync(DIR).filter((f) => f.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const f of fsx) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
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
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hi = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hi(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

interface Cfg {
  slPct: number;          // 초기 스톱(음수 %). structStop 이 켜지면 상한 역할
  structStop: boolean;    // 돌파봉 저가 아래로 스톱
  structCap: number;      // 구조적 스톱의 최대 손실 폭(음수 %)
  limitPct: number;       // >0 이면 시가 대신 (신호봉 종가 × (1−limitPct%)) 지정가, 닿을 때만 체결
  reentry: 0 | 1 | 2;     // 손절 후 재진입 허용 횟수
  reWindow: number;       // 재진입 유효 기간(봉)
  rePlacebo: boolean;     // 재진입 조건을 "고점 회복" 대신 "N봉 경과"로 (플라시보)
  /**
   * 스톱 체결 품질. 0 = 정확히 스톱 가격(이상적).
   * f > 0 이면 스톱과 그 봉 저가 사이에서 f 만큼 밀려 체결된다고 본다:
   *   체결가 = sl − f × (sl − low)
   * 급락으로 뚫고 지나가는 정도를 한 개 파라미터로 표현한다.
   */
  stopFillSlip: number;
  /**
   * true 면 "4시간에 한 번만 확인하는" 실제 운영 방식을 모사한다.
   * 봉이 마감된 뒤 크론이 돌아 시장가로 판다 → 체결가 = 다음 봉 시가.
   * 지금 페이퍼(paper-f6v5-tick.ts)는 스톱 '가격'에 체결됐다고 기록하지만,
   * 실제로는 스톱을 걸어두지 않는 한 그 가격에 나갈 방법이 없다.
   */
  liveFill: boolean;
  /**
   * true 면 저가가 스톱을 스쳐도 자르지 않고, **종가가 스톱 아래일 때만** 자른다(종가 확정).
   * "스톱이 노이즈 꼬리에 걸린다"는 가설의 정면 검증. 체결가는 그 봉 종가.
   */
  stopOnClose: boolean;
  /** true 면 초기 손절(SL)만 3시간 뒤(다음 봉 시가)에 체결. 트레일/시간청산은 그대로. */
  slDelayOnly: boolean;
  /**
   * 봉 안에서 고가와 저가 중 어느 쪽이 먼저 왔는지는 알 수 없다.
   * 'lowFirst'  = 이전 스톱으로 저가를 먼저 확인한 뒤 고가로 스톱을 올린다 (현행 백테스트·라이브 로직).
   *               한 봉 안에서 고점을 찍고 되밀려 스톱을 건드린 경우를 놓친다 → 낙관적.
   * 'highFirst' = 고가로 스톱을 먼저 올린 뒤 갱신된 스톱으로 저가를 확인한다 → 보수적.
   * 진실은 둘 사이다. 좁은 스톱일수록 차이가 커진다.
   */
  path: 'lowFirst' | 'highFirst';
  stopSlipMult: number;   // 스톱 청산에만 붙는 추가 슬리피지 배수
}
const cfg = (o: Partial<Cfg> = {}): Cfg => ({ slPct: -2, structStop: false, structCap: -6, limitPct: 0, reentry: 0, reWindow: 12, rePlacebo: false, stopFillSlip: 0, liveFill: false, stopOnClose: false, slDelayOnly: false, stopSlipMult: 1, path: 'lowFirst', ...o });

interface Pos { m: string; ep: number; vol: number; used: number; entryIdx: number; peak: number; sl: number; armed: boolean; lastPx: number; reCount: number; sigPeak: number }
interface Watch { peak: number; until: number; reCount: number; since: number }

function run(c: Cfg, pct: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  const watch = new Map<string, Watch>();   // 손절당한 코인의 재진입 감시
  let peakEq = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0, deploySum = 0, nBars = 0;
  let entries = 0, reEntries = 0, missed = 0;
  const t0 = Math.max(TS.findIndex((t) => t >= from), 0);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  const openPos = (m: string, i: number, eqNow: number, isRe: boolean, sigPeak: number, reCount: number): boolean => {
    const b = ALL.get(m)!;
    if (i + 1 >= b.length) return false;
    let ep: number;
    if (c.limitPct > 0) {
      const limit = b[i].close * (1 - c.limitPct / 100);
      if (b[i + 1].low > limit) { missed++; return false; }   // 지정가 미체결
      ep = limit * (1 + SLIP);
    } else {
      ep = b[i + 1].open * (1 + SLIP);
    }
    const use = Math.min(cash, eqNow * pct);
    if (use < 5000) return false;
    // 초기 스톱
    let sl = ep * (1 + c.slPct / 100);
    if (c.structStop) {
      const struct = b[i].low;                      // 돌파봉 저가
      const capped = ep * (1 + c.structCap / 100);  // 최대 손실 한도
      sl = Math.min(ep * (1 + c.slPct / 100), Math.max(struct, capped));
    }
    cash -= use;
    open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, entryIdx: i + 1, peak: ep, sl, armed: false, lastPx: ep, reCount, sigPeak });
    entries++; if (isRe) reEntries++;
    return true;
  };

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.entryIdx) continue;
      const bar = b[i]; let px = 0, done = false, stopped = false;
      // 종가 확정 스톱: 저가 터치는 무시하고 종가만 본다
      if (c.stopOnClose) {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT_REF.v / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
        if (bar.close <= pos.sl) { px = bar.close; done = true; stopped = !pos.armed; }
      } else if (c.path === 'highFirst') {
        // 고가로 먼저 트레일을 올리고, 그 스톱으로 저가를 본다 (보수적)
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT_REF.v / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
        if (bar.low <= pos.sl) { px = c.liveFill ? (i + 1 < b.length ? b[i + 1].open : bar.close) : pos.sl - c.stopFillSlip * (pos.sl - bar.low); done = true; stopped = !pos.armed; }
      } else if (bar.low <= pos.sl) { px = c.liveFill ? (i + 1 < b.length ? b[i + 1].open : bar.close) : pos.sl - c.stopFillSlip * (pos.sl - bar.low); done = true; stopped = !pos.armed;
        if (c.slDelayOnly && stopped && i + 1 < b.length) px = b[i + 1].open; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT_REF.v / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.entryIdx) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const slipMul = (px <= pos.sl * 1.0000001) ? c.stopSlipMult : 1;   // 스톱 체결이면 추가 슬리피지
        const pr = pos.vol * px * (1 - SLIP * slipMul) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        // 재진입 감시 등록 — 초기 스톱에 잘린 경우만(트레일 청산은 이미 먹고 나온 것)
        if (c.reentry > 0 && stopped && pos.reCount < c.reentry) {
          watch.set(pos.m, { peak: Math.max(pos.peak, pos.sigPeak), until: i + c.reWindow, reCount: pos.reCount + 1, since: i });
        }
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.lastPx); }

    if (t < t1 - 20) {
      // 재진입 먼저 (검증된 국면 우선)
      if (c.reentry > 0) {
        for (const [m, w] of [...watch]) {
          if (open.length >= maxCon) break;
          const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
          if (i === undefined) continue;
          if (i > w.until) { watch.delete(m); continue; }
          if (open.some((p) => p.m === m)) continue;
          const ok = c.rePlacebo ? (i - w.since) >= 3 : b[i].close > w.peak;
          if (!ok) continue;
          if (openPos(m, i, eqNow, true, w.peak, w.reCount)) watch.delete(m);
        }
      }
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || !sigF6(b, i)) continue;
        openPos(m, i, eqNow, false, b[i].high, 0);
        watch.delete(m);
      }
    }
    let posVal = 0;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.lastPx = ALL.get(p.m)![i].close; posVal += p.vol * p.lastPx; }
    const eq = cash + posVal;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    nBars++; deploySum += eq > 0 ? posVal / eq : 0;
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.lastPx;
  return { total: (fin / INIT - 1) * 100, mdd, n, entries, reEntries, missed, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, deploy: nBars ? deploySum / nBars * 100 : 0 };
}

/** run 과 동일하되 트레일 개시 문턱(ACT)만 인자로 받는다 */
function runAct(c: Cfg, pct: number, maxCon: number, from: number, act: number) {
  const saved = ACT_REF.v; ACT_REF.v = act;
  try { return run(c, pct, maxCon, from); } finally { ACT_REF.v = saved; }
}
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (pct: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { pct: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[200], TARGET = 17.0;
console.log(`=== 진입·스톱 역학 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}, MDD ${TARGET}% 고정) ===\n`);
const ctrl = matchMdd((pct) => run(cfg(), pct, 3, FROM), TARGET);
const CTRL = ctrl.res.total;
const row = (l: string, r: ReturnType<typeof run>, extra = '') => console.log(
  `  ${l.padEnd(30)}| ${(r.total.toFixed(0) + '%').padStart(7)} | ${(((r.total / CTRL - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(r.entries).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${(r.deploy.toFixed(0) + '%').padStart(6)} | ${extra}`);

console.log('  구성                          |    총익 | 대조군대비 | 진입수 |    PF | 가동률 | 비고');
console.log('  ' + '-'.repeat(96));
row('현행 (시가 진입 · SL −2%)', ctrl.res);

console.log('  ── ① 재진입 (손절 후 직전 고점 회복 시)');
for (const [re, w] of [[1, 6], [1, 12], [1, 24], [2, 12]] as Array<[1 | 2, number]>) {
  const m = matchMdd((pct) => run(cfg({ reentry: re, reWindow: w }), pct, 3, FROM), TARGET);
  row(`재진입 ${re}회 · ${w}봉 내`, m.res, `재진입 ${m.res.reEntries}건`);
}
{
  const m = matchMdd((pct) => run(cfg({ reentry: 1, reWindow: 12, rePlacebo: true }), pct, 3, FROM), TARGET);
  row('플라시보: 3봉 뒤 무조건 재진입', m.res, `재진입 ${m.res.reEntries}건`);
}

console.log('  ── ② 지정가 진입 (신호봉 종가 대비 d% 아래)');
for (const d of [0.1, 0.3, 0.5, 1.0, 2.0]) {
  const m = matchMdd((pct) => run(cfg({ limitPct: d }), pct, 3, FROM), TARGET);
  row(`지정가 −${d}%`, m.res, `미체결 ${m.res.missed}건`);
}

console.log('  ── ③ 구조적 스톱 (돌파봉 저가 아래, 최대 손실 한도)');
for (const cap of [-3, -4, -6, -8]) {
  const m = matchMdd((pct) => run(cfg({ structStop: true, structCap: cap }), pct, 3, FROM), TARGET);
  row(`돌파봉 저가 · 한도 ${cap}%`, m.res);
}
for (const sl of [-1.5, -3, -4]) {
  const m = matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET);
  row(`고정 스톱 ${sl}% (비교)`, m.res);
}

// ── ④ 뜻밖의 발견: 초기 스톱을 "조이는" 방향. 4년간 −2% 고정이었고 조이는 쪽은 훑은 적이 없다.
//     넓히는 방향(구조적 스톱 −3~−8%)은 전부 크게 졌는데 −1.5% 는 +12% 다.
console.log('\n\n◆ ④ 초기 스톱 폭 스윕 (동일 MDD 17%, 트레일 ACT/GAP 은 2/2 고정)');
console.log('  초기 스톱 |    총익 | 대조군대비 | 진입수 |    WR |    PF | 가동률');
console.log('  ' + '-'.repeat(76));
const slGrid: Array<[number, number]> = [];
for (const sl of [-0.75, -1.0, -1.25, -1.5, -1.75, -2.0, -2.25, -2.5, -3.0]) {
  const m = matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET);
  slGrid.push([sl, m.res.total]);
  console.log(`  ${(sl + '%').padStart(9)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / CTRL - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.entries).padStart(6)} | ${m.res.wr.toFixed(1).padStart(4)}% | ${m.res.pf.toFixed(2).padStart(5)} | ${(m.res.deploy.toFixed(0) + '%').padStart(6)}`);
}

// 스톱을 조이면 트레일 개시(ACT) 문턱도 같이 조여야 정합적일 수 있다 — 2차원으로 본다
console.log('\n◆ ⑤ 스톱 × 트레일 개시 2차원 (동일 MDD 17%, 총익%)');
let hdr = '  SL\\ACT  |';
const ACTS = [1.0, 1.5, 2.0, 3.0];
for (const a of ACTS) hdr += `${('+' + a + '%').padStart(9)} |`;
console.log(hdr);
for (const sl of [-1.0, -1.25, -1.5, -2.0]) {
  let line = `  ${(sl + '%').padStart(8)} |`;
  for (const a of ACTS) {
    const m = matchMdd((pct) => {
      // ACT 를 바꾸려면 상수를 갈아끼워야 하므로 지역 시뮬을 쓴다
      return runAct(cfg({ slPct: sl }), pct, 3, FROM, a);
    }, TARGET);
    line += `${(m.res.total.toFixed(0) + '%').padStart(9)} |`;
  }
  console.log(line);
}

console.log('\n◆ ⑥ 기간분할 (동일 MDD 지점 pct 고정)');
const PER: Array<[string, number, number | undefined]> = [
  ['2022-07~2023', FROM, D('2024-01-01')],
  ['2024', D('2024-01-01'), D('2025-01-01')],
  ['2025', D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];
console.log('  구성            |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
const store = new Map<string, number[]>();
for (const sl of [-2.0, -1.5, -1.25, -1.0]) {
  const m = matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET);
  let line = `  ${('SL ' + sl + '%').padEnd(15)}|`; const arr: number[] = [];
  for (const [, f, t] of PER) { const r = run(cfg({ slPct: sl }), m.pct, 3, f, t); arr.push(r.total); line += ` ${`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)} |`; }
  store.set(String(sl), arr); console.log(line);
}
const b2 = store.get('-2')!;
for (const sl of [-1.5, -1.25, -1.0]) {
  const a = store.get(String(sl))!;
  console.log(`    SL ${sl}% : ${a.filter((x, i) => x > b2[i]).length}/4 구간 우세`);
}

// ── ⑦ 좁은 스톱의 현실성 스트레스. 조일수록 좋다는 결과는 세 가지 가정에 기대고 있다:
//     (a) 스톱 가격에 정확히 체결된다 — 실제로는 갭으로 뚫고 지나간다
//     (b) 4h 봉 안에서 저가가 고가보다 먼저 왔는지 모른다 (경로 가정)
//     (c) 동일 MDD 를 맞추느라 포지션이 커진다 — 그 크기가 현실적인가
console.log('\n\n◆ ⑦ 좁은 스톱 현실성 스트레스');
console.log('  (a) 필요 포지션 크기 — MDD 17% 를 맞추려면 얼마를 태워야 하나');
console.log('  초기 스톱 | 필요 pct | 1회 손절이 자본에서 차지하는 비중');
for (const sl of [-2.0, -1.5, -1.25, -1.0, -0.75]) {
  const m = matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET);
  console.log(`  ${(sl + '%').padStart(9)} | ${((m.pct * 100).toFixed(1) + '%').padStart(8)} | ${((m.pct * Math.abs(sl)).toFixed(2) + '%')}`);
}

console.log('\n  ⚠ 정정: lowFirst(현행)가 이미 보수적 가정이다.');
console.log('    고가를 먼저 반영하면 되밀릴 때 더 높은 스톱에서 나가므로 오히려 낙관적이다.\n');
console.log('  (b) 스톱 체결 품질 — 체결가 = 스톱 − f × (스톱 − 그 봉 저가)');
console.log('  초기 스톱 |   f=0(이상) |    f=0.1 |   f=0.25 |    f=0.5 |  대조군(−2%,f동일) 대비');
for (const sl of [-2.0, -1.5, -1.25, -1.0, -0.75]) {
  const cells: number[] = [];
  for (const f of [0, 0.1, 0.25, 0.5]) cells.push(matchMdd((pct) => run(cfg({ slPct: sl, stopFillSlip: f }), pct, 3, FROM), TARGET).res.total);
  const base05 = matchMdd((pct) => run(cfg({ slPct: -2, stopFillSlip: 0.5 }), pct, 3, FROM), TARGET).res.total;
  console.log(`  ${(sl + '%').padStart(9)} | ${cells.map((v) => (v.toFixed(0) + '%').padStart(9)).join(' | ')} | ${(((cells[3] / base05 - 1) * 100).toFixed(0) + '%').padStart(8)} (f=0.5)`);
}

console.log('\n\n◆ ⑧ 실제 운영 방식 모사 — "4시간에 한 번 확인 후 시장가 매도"');
console.log('  지금 페이퍼는 스톱 가격에 체결됐다고 기록한다. 그러나 크론이 4시간에 한 번 도는 이상');
console.log('  실제로는 봉 마감 후 시장가로 파는 것이고, 체결가는 다음 봉 시가에 가깝다.\n');
console.log('  초기 스톱 | 스톱가 체결(현행 기록) | 봉마감 후 시장가(실제) | 차이');
for (const sl of [-2.0, -1.5, -1.25, -1.0]) {
  const ideal = matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET).res;
  const live = matchMdd((pct) => run(cfg({ slPct: sl, liveFill: true }), pct, 3, FROM), TARGET).res;
  console.log(`  ${(sl + '%').padStart(9)} | ${(ideal.total.toFixed(0) + '%').padStart(21)} | ${(live.total.toFixed(0) + '%').padStart(21)} | ${(((live.total / ideal.total - 1) * 100).toFixed(0) + '%').padStart(6)}`);
}
console.log('\n  → 이 차이는 전략 개선이 아니라 "지금 페이퍼 숫자가 무엇을 가정하고 있는가"의 문제다.');

console.log('\n\n◆ ⑨ "스톱이 노이즈에 걸리는가" 직접 검증 (동일 MDD 17%)');
console.log('  가설: 손절 3시간 뒤 시세가 평균 +1.09% 였다 → 스톱이 잘못 잡힌 것 아닌가?');
console.log('  두 가지가 개선되어야 가설이 맞다.\n');
console.log('  구성                                  |    총익 | 대조군대비 | 진입수 |    WR |    PF');
console.log('  ' + '-'.repeat(86));
const c0 = matchMdd((pct) => run(cfg(), pct, 3, FROM), TARGET);
const show = (l: string, r: ReturnType<typeof run>) => console.log(
  `  ${l.padEnd(38)}| ${(r.total.toFixed(0) + '%').padStart(7)} | ${(((r.total / c0.res.total - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(r.entries).padStart(6)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)}`);
show('현행 (저가 터치 시 스톱가 체결)', c0.res);
show('① 종가 확정 스톱 (꼬리 무시)', matchMdd((pct) => run(cfg({ stopOnClose: true }), pct, 3, FROM), TARGET).res);
show('② 초기 손절만 3시간 지연 체결', matchMdd((pct) => run(cfg({ slDelayOnly: true }), pct, 3, FROM), TARGET).res);
show('③ 둘 다', matchMdd((pct) => run(cfg({ stopOnClose: true, slDelayOnly: true }), pct, 3, FROM), TARGET).res);
console.log('\n  ── 참고: 스톱 폭을 넓히는 것도 같은 가설의 다른 표현이다');
for (const sl of [-2.5, -3, -4]) show(`스톱 ${sl}% 로 넓힘`, matchMdd((pct) => run(cfg({ slPct: sl }), pct, 3, FROM), TARGET).res);
