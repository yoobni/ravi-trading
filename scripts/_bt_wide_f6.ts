/**
 * 넓은 유니버스에서의 F6 — 두 가지를 본다.
 *
 * ① 자기검증: 방금 횡단면 반전이 "호가 튐"으로 기각됐다(_bt_panel_wide).
 *    같은 잣대를 **지금 운영 중인 F6 자신**에게 들이대야 공정하다.
 *    F6 수익이 유동성 낮은 종목에 몰려 있다면 페이퍼 성과도 실거래에서 안 나온다.
 *    F6 는 평균 13시간 보유라 튐 비중이 작을 것으로 예상되지만, 확인 전엔 모른다.
 *
 * ② 유니버스 확장: 리서치는 줄곧 손으로 고른 28종에서만 돌았다.
 *    거래대금 상위 116종으로 넓히면 F6 가 더 버는가? (같은 기간·같은 규칙·현금 제약 동일)
 *
 * 규칙은 F6_v5 와 동일: 7일(42봉) 신고가 돌파 + 양봉 + volZ≥0.5,
 * 진입은 신호봉 다음 봉 시가, 청산은 트레일링 A2(SL −2%, +2% 후 고점−2%), MAX 84봉.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const CUR28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005;
const INIT = 10_000_000;
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
/** 직전 30봉(5일) 평균 거래대금 */
function turn(b: Bar[], i: number, w = 30) {
  if (i < w) return NaN;
  let s = 0;
  for (let j = i - w; j < i; j++) s += b[j].close * b[j].volume;
  return s / w;
}

const D = (s: string) => Date.parse(s + 'T00:00:00Z');
const FROM = D('2024-08-15');   // 넓은 유니버스 캐시가 공통으로 존재하는 시작점

// ── ① 신호 단위 성과를 유동성 분위별로. 튐 성분도 같이 분리한다.
console.log(`=== F6 자기검증 · 유니버스 확장 (${MKTS.length}코인 4h 캐시) ===\n`);
console.log('◆ ① F6 신호의 유동성 분위별 성과 (트레일 청산, 진입=다음봉 시가)');
interface T { ret: number; retClose: number; liq: number; mkt: string; ts: number }
const trades: T[] = [];
for (const m of MKTS) {
  const b = ALL.get(m)!;
  for (let i = 43; i < b.length - 2; i++) {
    if (b[i].ts < FROM) continue;
    if (!sigF6(b, i)) continue;
    const liq = turn(b, i);
    if (!Number.isFinite(liq)) continue;
    // 실행 가능: 다음 봉 시가 진입
    const ep = b[i + 1].open * (1 + SLIP);
    // 비교용: 신호봉 종가 진입(= 튐 포함, 실제로는 못 사는 가격)
    const epClose = b[i].close * (1 + SLIP);
    let peak = ep, sl = ep * (1 + SL / 100), armed = false, exit = 0;
    for (let j = i + 2; j < Math.min(b.length, i + 2 + MAXB); j++) {
      if (b[j].low <= sl) { exit = sl; break; }
      peak = Math.max(peak, b[j].high);
      if (!armed && peak >= ep * (1 + ACT / 100)) armed = true;
      if (armed) sl = Math.max(sl, peak * (1 - GAP / 100));
      if (j === Math.min(b.length, i + 2 + MAXB) - 1) exit = b[j].close;
    }
    if (!exit) continue;
    const net = exit * (1 - SLIP) * (1 - FEE) * (1 - FEE);
    trades.push({ ret: net / ep - 1, retClose: net / epClose - 1, liq, mkt: m, ts: b[i].ts });
  }
}
trades.sort((a, b) => b.liq - a.liq);
const Q = 5, per = Math.floor(trades.length / Q);
console.log(`  전체 신호 ${trades.length}건 (${new Date(FROM).toISOString().slice(0,10)} 이후)\n`);
console.log('  분위        | 건수 | 평균 거래대금 | 시가진입 평균 |   승률 |    PF | 종가진입(튐) | 차이');
console.log('  ' + '-'.repeat(100));
for (let q = 0; q < Q; q++) {
  const sl = trades.slice(q * per, q === Q - 1 ? trades.length : (q + 1) * per);
  const avg = sl.reduce((s, t) => s + t.ret, 0) / sl.length * 100;
  const avgC = sl.reduce((s, t) => s + t.retClose, 0) / sl.length * 100;
  const w = sl.filter((t) => t.ret > 0);
  const gw = w.reduce((s, t) => s + t.ret, 0), gl = -sl.filter((t) => t.ret <= 0).reduce((s, t) => s + t.ret, 0);
  const liq = sl.reduce((s, t) => s + t.liq, 0) / sl.length;
  console.log(`  ${('Q' + (q + 1) + (q === 0 ? ' (최상위)' : q === Q - 1 ? ' (최하위)' : '')).padEnd(12)}| ${String(sl.length).padStart(4)} | ${((liq / 1e8).toFixed(1) + '억').padStart(13)} | ${(avg.toFixed(3) + '%').padStart(13)} | ${(w.length / sl.length * 100).toFixed(1).padStart(5)}% | ${(gl > 0 ? gw / gl : 99).toFixed(2).padStart(5)} | ${(avgC.toFixed(3) + '%').padStart(12)} | ${((avgC - avg).toFixed(3) + '%p').padStart(7)}`);
}

// ── ② 유니버스 확장 — 현금·동시보유 제약을 둔 포트폴리오 시뮬.
//    유니버스만 바꾸고 규칙·배분은 고정한다. 비교 기간도 동일하게 맞춘다.
// lastPx: 해당 봉이 없는 시각에도 평가액을 유지하기 위한 마지막 확인가.
// (코인마다 캐시 종료 시점이 달라서, 없는 봉을 0으로 두면 자산이 증발해 가짜 MDD 가 생긴다)
interface Pos { m: string; ep: number; vol: number; used: number; entryIdx: number; peak: number; sl: number; armed: boolean; lastPx: number }
/**
 * @param universe 후보 코인 집합
 * @param liqTop   >0 이면 신호 발생 시점의 거래대금 상위 liqTop 종목만 진입 허용
 * @param pick     'order' = 코인 배열 순서(현행), 'liq' = 거래대금 큰 순
 */
function runF6(universe: string[], liqTop: number, pick: 'order' | 'liq', pct: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const uni = universe.filter((m) => ALL.has(m));
  const t0 = TS.findIndex((t) => t >= from);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;
  for (let t = Math.max(t0, 0); t < t1; t++) {
    const ts = TS[t];
    // 청산
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
    // 진입
    if (open.length < maxCon && t < t1 - 20) {
      const hits: Array<[string, number]> = [];
      for (const m of uni) {
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length) continue;
        if (!sigF6(b, i)) continue;
        const q = turn(b, i);
        if (!Number.isFinite(q)) continue;
        hits.push([m, q]);
      }
      let ordered = hits;
      if (liqTop > 0) {
        // 그 시점 전체 유니버스의 거래대금 상위 liqTop 안에 드는 신호만
        const rank = uni.map((m) => { const i = IDX.get(m)!.get(ts); const b = ALL.get(m)!; return [m, i === undefined ? NaN : turn(b, i)] as [string, number]; })
                        .filter(([, q]) => Number.isFinite(q)).sort((a, b) => b[1] - a[1]).slice(0, liqTop);
        const ok = new Set(rank.map(([m]) => m));
        ordered = hits.filter(([m]) => ok.has(m));
      }
      if (pick === 'liq') ordered = [...ordered].sort((a, b) => b[1] - a[1]);
      for (const [m] of ordered) {
        if (open.length >= maxCon) break;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts)!;
        const use = cash * pct;
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, entryIdx: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, lastPx: ep });
      }
    }
    let eq = cash;
    for (const p of open) {
      const i = IDX.get(p.m)!.get(ts);
      if (i !== undefined) p.lastPx = ALL.get(p.m)![i].close;
      eq += p.vol * p.lastPx;
    }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.lastPx;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
}
const WIDE = MKTS;
const row = (l: string, r: ReturnType<typeof runF6>) => console.log(
  `  ${l.padEnd(30)}| ${(r.total.toFixed(0) + '%').padStart(7)} | ${(r.mdd.toFixed(1) + '%').padStart(6)} | ${(r.mdd > 0 ? r.total / r.mdd : 0).toFixed(2).padStart(8)} | ${String(r.n).padStart(4)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)}`);

console.log('\n\n◆ ② 유니버스 확장 (2024-08-15~, 33%×3, 트레일 A2)');
console.log('  구성                          |    총익 |    MDD | 수익/MDD | 거래 |    WR |    PF');
console.log('  ' + '-'.repeat(84));
row('현재 28종 (현행)', runF6(CUR28, 0, 'order', 0.33, 3, FROM));
row(`전체 ${WIDE.length}종`, runF6(WIDE, 0, 'order', 0.33, 3, FROM));
row(`전체 ${WIDE.length}종 · 거래대금 큰 순 선발`, runF6(WIDE, 0, 'liq', 0.33, 3, FROM));
console.log('  ── 유동성 상위 N종만 진입 허용');
for (const L of [10, 20, 30, 50]) row(`전체 ${WIDE.length}종 · 유동성 상위 ${L}만`, runF6(WIDE, L, 'liq', 0.33, 3, FROM));

console.log('\n◆ ③ 기간분할 (총익% / MDD%)');
const PER: Array<[string, number, number | undefined]> = [
  ['2024-08~12', FROM, D('2025-01-01')],
  ['2025 상반', D('2025-01-01'), D('2025-07-01')],
  ['2025 하반', D('2025-07-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];
const CANDS: Array<[string, () => string[], number, 'order' | 'liq']> = [
  ['현재 28종', () => CUR28, 0, 'order'],
  [`전체 ${WIDE.length}종`, () => WIDE, 0, 'order'],
  [`전체 · 유동성상위20`, () => WIDE, 20, 'liq'],
  [`전체 · 유동성상위30`, () => WIDE, 30, 'liq'],
];
console.log('  구성                |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
for (const [lbl, uf, L, pk] of CANDS) {
  let line = `  ${lbl.padEnd(19)}|`;
  for (const [, f, t] of PER) { const r = runF6(uf(), L, pk, 0.33, 3, f, t); line += ` ${`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)} |`; }
  console.log(line);
}

// ── ④ 동일 MDD 비교. 총익 차이가 "위험을 더 진 것"이 아님을 보이려면 필수다.
//     (앞서 성긴 격자 보간이 피라미딩을 +52%로 과대평가한 적이 있어 이분탐색으로 맞춘다)
function matchMdd(make: (pct: number) => ReturnType<typeof runF6>, target: number) {
  let lo = 0.03, hi = 1.0;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  const pct = (lo + hi) / 2;
  return { pct, res: make(pct) };
}
const TARGET = 8.1;   // 현행 28종의 MDD
console.log(`\n\n◆ ④ 동일 MDD(${TARGET}%) 비교 — 위험을 맞춘 뒤의 순수 차이`);
console.log('  구성                          | 그때 pct |    총익 |    MDD | 거래 |    PF');
console.log('  ' + '-'.repeat(76));
const MM: Array<[string, string[], number, 'order' | 'liq']> = [
  ['현재 28종 (현행)', CUR28, 0, 'order'],
  [`전체 ${WIDE.length}종`, WIDE, 0, 'order'],
  [`전체 · 유동성상위50`, WIDE, 50, 'liq'],
  [`전체 · 유동성상위30`, WIDE, 30, 'liq'],
];
const matched: Array<[string, number, number]> = [];
for (const [lbl, uni, L, pk] of MM) {
  const m = matchMdd((pct) => runF6(uni, L, pk, pct, 3, FROM), TARGET);
  matched.push([lbl, m.pct, m.res.total]);
  console.log(`  ${lbl.padEnd(30)}| ${((m.pct * 100).toFixed(1) + '%').padStart(8)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(m.res.mdd.toFixed(1) + '%').padStart(6)} | ${String(m.res.n).padStart(4)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}
const b0 = matched[0][2];
console.log('\n  현행 대비 (동일 MDD):');
for (const [lbl, , tot] of matched.slice(1)) console.log(`    ${lbl.padEnd(24)} ${((tot / b0 - 1) * 100).toFixed(0).padStart(5)}%`);

console.log('\n◆ ⑤ 동일 MDD 지점에서 기간분할 — 전 구간에서 이기는가');
console.log('  구성                |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
const vals = new Map<string, number[]>();
for (let k = 0; k < MM.length; k++) {
  const [lbl, uni, L, pk] = MM[k];
  const pct = matched[k][1];
  let line = `  ${lbl.padEnd(19)}|`; const vv: number[] = [];
  for (const [, f, t] of PER) { const r = runF6(uni, L, pk, pct, 3, f, t); vv.push(r.total); line += ` ${`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)} |`; }
  vals.set(lbl, vv); console.log(line);
}
const bv = vals.get(MM[0][0])!;
for (const [lbl] of MM.slice(1)) {
  const v = vals.get(lbl)!;
  console.log(`    ${lbl.padEnd(24)} ${v.filter((x, i) => x > bv[i]).length}/${PER.length} 구간 우세`);
}
console.log('\n⚠ 생존 편향: 이 111종은 "2026-08 현재 상장돼 있고 거래대금 상위"인 코인이다.');
console.log('   2024~26 사이 상장폐지된 코인은 업비트 API 에서 사라져 표본에 없다.');
console.log('   소형주 비중이 큰 확장 유니버스일수록 이 편향이 크다 — 위 수치는 낙관 쪽이다.');
