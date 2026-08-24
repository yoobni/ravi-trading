/**
 * 피라미딩 반증 시험.
 *
 * _bt_deploy_validate 에서 "같은 코인 재신호 시 2번째 트란치 추가"가 동일 MDD 기준 +52%,
 * 4/4 기간 우세로 나왔다. 지금까지 MDD 통제와 기간분할을 동시에 통과한 유일한 후보라
 * 그만큼 의심해야 한다. 네 갈래로 깨보려 한다.
 *
 *   ① 플라시보 : 2번째 트란치를 "신호 없이" 넣어도 같은 성과가 나오면, 신호가 아니라 단순 노출 증가다.
 *                 - sched2 : 이미 보유한 코인에 N봉 뒤 무조건 추가
 *                 - other2 : 신호와 무관한 다른 코인에 추가(라운드로빈)
 *   ② 트란치별 : 2번 트란치 자체의 PF·WR 이 1번 트란치만 못하면 평균을 갉아먹는 중이다.
 *   ③ 마찰    : 거래가 늘어나므로 수수료·슬리피지에 더 취약하다. ×2 ×3 스트레스.
 *   ④ 워크포워드: 앞 절반에서 고른 파라미터가 뒤 절반에서도 통하는가.
 *
 * 비교는 전부 MDD 를 현행 수준(17.0%)에 맞춘 뒤 수행한다 — 총익 차이가 위험 차이가 아니게.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;
let FEE = 0.0005, SLIP = 0.0005;   // ③ 스트레스에서 바꾼다

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_240m_'));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const SERIES = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 400) SERIES.set(m, b); }
const TS = [...new Set([...SERIES.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const IDX = new Map<string, Map<number, number>>();
for (const [m, b] of SERIES) IDX.set(m, new Map(b.map((x, i) => [x.ts, i])));
let MKTS = [...SERIES.keys()];
const MKTS0 = [...MKTS];
/** 결정적 셔플 — 순서 의존성 검사용(Math.random 없이 재현 가능하게) */
function orderBy(kind: 'cap' | 'rev' | 'alpha' | 'seed1' | 'seed2') {
  if (kind === 'cap') MKTS = [...MKTS0];
  else if (kind === 'rev') MKTS = [...MKTS0].reverse();
  else if (kind === 'alpha') MKTS = [...MKTS0].sort();
  else {
    const k = kind === 'seed1' ? 7 : 13;
    MKTS = [...MKTS0].map((m, i) => [m, (i * k) % MKTS0.length] as [string, number]).sort((a, b) => a[1] - b[1]).map(([m]) => m);
  }
}

const volZ = (b: Bar[], i: number, w: number) => {
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

type Mode = 'none' | 'signal2' | 'sched2' | 'other2' | 'mixed' | 'addfirst' | 'mixedPlacebo';
interface Cfg { pct: number; maxConcurrent: number; maxPerCoin: number; mode: Mode }
const cfg = (o: Partial<Cfg>): Cfg => ({ pct: 0.33, maxConcurrent: 3, maxPerCoin: 1, mode: 'none', ...o });
interface Pos { market: string; tranche: number; entryPrice: number; vol: number; cashUsed: number; entryIdxBar: number; peak: number; tsl: number; armed: boolean }
interface Res { total: number; mdd: number; trades: number; wr: number; pf: number; byTranche: Map<number, { n: number; wins: number; gw: number; gl: number; sum: number }> }

function run(c: Cfg, from?: number, to?: number): Res {
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0;
  const byTranche = new Map<number, { n: number; wins: number; gw: number; gl: number; sum: number }>();
  let rr = 0;   // other2 라운드로빈 커서

  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const tEndRaw = to ? TS.findIndex(x => x >= to) : -1;
  const tEnd = tEndRaw < 0 ? TS.length : tEndRaw;

  const addPos = (m: string, i: number, tranche: number, eqNow: number) => {
    const b = SERIES.get(m)!;
    if (i + 1 >= b.length) return false;
    const use = Math.min(eqNow * c.pct, cash);
    if (use < 5000) return false;
    const ep = b[i + 1].open * (1 + SLIP);
    cash -= use;
    open.push({ market: m, tranche, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, entryIdxBar: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
    return true;
  };

  for (let t = t0; t < tEnd; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = SERIES.get(pos.market)!; const i = IDX.get(pos.market)!.get(ts);
      if (i === undefined || i <= pos.entryIdxBar) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.entryPrice * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.entryIdxBar) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const proceeds = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / pos.cashUsed - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        const k = byTranche.get(pos.tranche) ?? { n: 0, wins: 0, gw: 0, gl: 0, sum: 0 };
        k.n++; k.sum += r; if (r > 0) { k.wins++; k.gw += r; } else k.gl += -r;
        byTranche.set(pos.tranche, k);
        open.splice(p, 1);
      }
    }
    if (t < tEnd - 20) {
      let eqNow = cash;
      for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) eqNow += p.vol * SERIES.get(p.market)![i].close; }
      if (c.mode === 'mixedPlacebo') {
        // 플라시보: 단일패스와 동일한 슬롯 경쟁이되, 증액은 '재신호' 없이 3봉 경과만으로 허용
        for (const m of MKTS) {
          if (open.length >= c.maxConcurrent) break;
          const heldArr = open.filter((p) => p.market === m);
          const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
          if (heldArr.length) {
            if (heldArr.length >= c.maxPerCoin) continue;
            if (i - heldArr[0].entryIdxBar < 3) continue;
            addPos(m, i, heldArr.length + 1, eqNow);
          } else if (sigF6(SERIES.get(m)!, i)) {
            addPos(m, i, 1, eqNow);
          }
        }
      } else if (c.mode === 'addfirst') {
        // 보유 종목 증액을 신규 진입보다 먼저 채운다 — '분산보다 집중' 가설의 극단형
        for (const m of MKTS) {
          if (open.length >= c.maxConcurrent) break;
          const held = open.filter((p) => p.market === m).length;
          if (!held || held >= c.maxPerCoin) continue;
          const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
          if (!sigF6(SERIES.get(m)!, i)) continue;
          addPos(m, i, held + 1, eqNow);
        }
        for (const m of MKTS) {
          if (open.length >= c.maxConcurrent) break;
          if (open.some((p) => p.market === m)) continue;
          const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
          if (!sigF6(SERIES.get(m)!, i)) continue;
          addPos(m, i, 1, eqNow);
        }
      } else if (c.mode === 'mixed') {
        // _bt_deploy_validate 의 원래 규칙 — 코인 배열을 한 번만 돌면서 신규/추가를 구분 없이 채운다
        for (const m of MKTS) {
          if (open.length >= c.maxConcurrent) break;
          const held = open.filter((p) => p.market === m).length;
          if (held >= c.maxPerCoin) continue;
          const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
          if (!sigF6(SERIES.get(m)!, i)) continue;
          addPos(m, i, held + 1, eqNow);
        }
        // 아래 (a)(b) 는 건너뛴다
      } else {
      // (a) 1번 트란치 — 신호 기반, 미보유 코인만
      for (const m of MKTS) {
        if (open.length >= c.maxConcurrent) break;
        if (open.some(p => p.market === m)) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
        if (!sigF6(SERIES.get(m)!, i)) continue;
        addPos(m, i, 1, eqNow);
      }
      // (b) 2번 트란치 — 모드별
      if (c.maxPerCoin >= 2 && c.mode !== 'none') {
        if (c.mode === 'signal2') {
          for (const m of MKTS) {
            if (open.length >= c.maxConcurrent) break;
            const held = open.filter(p => p.market === m);
            if (!held.length || held.length >= c.maxPerCoin) continue;
            const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
            if (!sigF6(SERIES.get(m)!, i)) continue;
            addPos(m, i, held.length + 1, eqNow);
          }
        } else if (c.mode === 'sched2') {
          // 플라시보: 보유 3봉 경과한 코인에 신호와 무관하게 추가
          for (const m of MKTS) {
            if (open.length >= c.maxConcurrent) break;
            const held = open.filter(p => p.market === m);
            if (!held.length || held.length >= c.maxPerCoin) continue;
            const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
            if (i - held[0].entryIdxBar < 3) continue;
            addPos(m, i, held.length + 1, eqNow);
          }
        } else if (c.mode === 'other2') {
          // 플라시보: 포지션이 있을 때 신호와 무관한 다른 코인을 라운드로빈으로 추가
          if (open.length && open.length < c.maxConcurrent) {
            for (let k = 0; k < MKTS.length && open.length < c.maxConcurrent; k++) {
              const m = MKTS[(rr + k) % MKTS.length];
              if (open.some(p => p.market === m)) continue;
              const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
              if (addPos(m, i, 2, eqNow)) { rr = (rr + k + 1) % MKTS.length; break; }
            }
          }
        }
      }
      }
    }
    let f6Val = 0;
    for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) f6Val += p.vol * SERIES.get(p.market)![i].close; }
    const eq = cash + f6Val;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  const lastTs = TS[Math.min(tEnd - 1, TS.length - 1)];
  let finalEq = cash;
  for (const p of open) { const i = IDX.get(p.market)!.get(lastTs); if (i !== undefined) finalEq += p.vol * SERIES.get(p.market)![i].close; }
  return { total: (finalEq / INIT - 1) * 100, mdd, trades: n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, byTranche };
}

/** MDD 를 target 에 맞추는 pct 를 이분탐색으로 찾는다 */
function matchMdd(make: (pct: number) => Cfg, target: number, from?: number, to?: number) {
  let lo = 0.03, hi = 1.0;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (run(make(mid), from, to).mdd > target) hi = mid; else lo = mid;
  }
  const pct = (lo + hi) / 2;
  return { pct, res: run(make(pct), from, to) };
}

const HDR = '  구성                          |     총익 |    MDD |  pct | 거래 |    WR |    PF';
const row = (l: string, pct: number, r: Res) => console.log(
  `  ${l.padEnd(30)}| ${(r.total.toFixed(0) + '%').padStart(8)} | ${(r.mdd.toFixed(1) + '%').padStart(6)} | ${((pct * 100).toFixed(0) + '%').padStart(4)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)}`,
);
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
const TARGET = 17.0;

console.log(`=== 피라미딩 반증 시험 (${SERIES.size}코인 4h, MDD ${TARGET}% 로 통제) ===\n`);

console.log('◆ ① 플라시보 — 2번째 트란치를 신호 없이 넣어도 같은가');
console.log(HDR);
const mNone = matchMdd((pct) => cfg({ pct }), TARGET);
row('트란치1만 (대조군)', mNone.pct, mNone.res);
const mSig = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'signal2' }), TARGET);
row('재신호 추가 (후보)', mSig.pct, mSig.res);
const mSch = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'sched2' }), TARGET);
row('플라시보: 3봉 뒤 무조건 추가', mSch.pct, mSch.res);
const mOth = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'other2' }), TARGET);
row('플라시보: 무관한 코인 추가', mOth.pct, mOth.res);
console.log(`\n  후보 vs 대조군  ${((mSig.res.total / mNone.res.total - 1) * 100).toFixed(0)}%`);
console.log(`  후보 vs 플라시보(3봉뒤) ${((mSig.res.total / mSch.res.total - 1) * 100).toFixed(0)}%   ← 이게 작으면 신호가 아니라 노출 효과`);
console.log(`  후보 vs 플라시보(타코인) ${((mSig.res.total / mOth.res.total - 1) * 100).toFixed(0)}%`);

console.log('\n◆ ② 트란치별 성과 — 2번 트란치 자체가 벌고 있나');
console.log('  트란치 | 건수 |    WR |    PF | 평균수익');
for (const [k, v] of [...mSig.res.byTranche.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(k).padStart(6)} | ${String(v.n).padStart(4)} | ${(v.wins / v.n * 100).toFixed(1).padStart(4)}% | ${(v.gl > 0 ? v.gw / v.gl : 99).toFixed(2).padStart(5)} | ${(v.sum / v.n * 100).toFixed(2).padStart(7)}%`);
}

console.log('\n◆ ③ 마찰 스트레스 — 거래가 늘어난 만큼 비용에 약해지는가');
console.log('  마찰        | 트란치1만 | 재신호추가 | 개선분');
for (const mult of [1, 2, 3]) {
  FEE = 0.0005 * mult; SLIP = 0.0005 * mult;
  const a = matchMdd((pct) => cfg({ pct }), TARGET);
  const b = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'signal2' }), TARGET);
  console.log(`  ×${mult} (${(mult * 0.1).toFixed(1)}% 왕복) | ${(a.res.total.toFixed(0) + '%').padStart(9)} | ${(b.res.total.toFixed(0) + '%').padStart(10)} | ${((b.res.total / a.res.total - 1) * 100).toFixed(0).padStart(5)}%`);
}
FEE = 0.0005; SLIP = 0.0005;

console.log('\n◆ ④ 워크포워드 — 앞 절반(~2024-08)에서 고른 pct 를 뒤 절반에 그대로 적용');
const SPLIT = D('2024-08-01');
const inA = matchMdd((pct) => cfg({ pct }), TARGET, undefined, SPLIT);
const inB = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'signal2' }), TARGET, undefined, SPLIT);
console.log(`  [IS  ~2024-08] 트란치1만 pct=${(inA.pct * 100).toFixed(0)}% → ${inA.res.total.toFixed(0)}% / MDD ${inA.res.mdd.toFixed(1)}%`);
console.log(`  [IS  ~2024-08] 재신호추가 pct=${(inB.pct * 100).toFixed(0)}% → ${inB.res.total.toFixed(0)}% / MDD ${inB.res.mdd.toFixed(1)}%`);
const ooA = run(cfg({ pct: inA.pct }), SPLIT);
const ooB = run(cfg({ pct: inB.pct, maxPerCoin: 2, mode: 'signal2' }), SPLIT);
console.log(`  [OOS 2024-08~] 트란치1만            → ${ooA.total.toFixed(0)}% / MDD ${ooA.mdd.toFixed(1)}%  PF ${ooA.pf.toFixed(2)}`);
console.log(`  [OOS 2024-08~] 재신호추가            → ${ooB.total.toFixed(0)}% / MDD ${ooB.mdd.toFixed(1)}%  PF ${ooB.pf.toFixed(2)}`);
console.log(`  OOS 개선분 ${((ooB.total / ooA.total - 1) * 100).toFixed(0)}%  ${ooB.total > ooA.total && ooB.mdd <= ooA.mdd * 1.15 ? '✔ 통과' : '✘'}`);

console.log('\n◆ ⑤ 트란치 상한 스윕 (동일 MDD)');
console.log(HDR);
for (const mp of [1, 2, 3, 4]) {
  const m = matchMdd((pct) => cfg({ pct, maxConcurrent: Math.max(3, mp + 1), maxPerCoin: mp, mode: mp > 1 ? 'signal2' : 'none' }), TARGET);
  row(`코인당 최대 ${mp} 트란치`, m.pct, m.res);
}

console.log('\n◆ ⑥ 진입 우선순위 규칙 비교 (동일 MDD, 이분탐색으로 정밀 매칭)');
console.log(HDR);
const m1 = matchMdd((pct) => cfg({ pct }), TARGET);
row('추가 없음 (대조군)', m1.pct, m1.res);
const m2 = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'signal2' }), TARGET);
row('신규코인 우선 후 추가', m2.pct, m2.res);
const m3 = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' }), TARGET);
row('단일패스(원래 규칙)', m3.pct, m3.res);
console.log(`\n  신규우선 ${((m2.res.total / m1.res.total - 1) * 100).toFixed(0)}%   단일패스 ${((m3.res.total / m1.res.total - 1) * 100).toFixed(0)}%`);

console.log('\n◆ ⑦ 사이징 규칙도 정밀 재검 — equity×pct 의 순수 기여분');
console.log(HDR);
// cash×pct 계열을 같은 하네스로 재현: 진입액을 cash 기준으로
console.log('  (cash×pct 는 _bt_deploy_validate 참조 — 여기서는 equity 계열 내부 비교만)');
for (const [label, mc] of [['equity×pct ×2', 2], ['equity×pct ×3', 3], ['equity×pct ×5', 5], ['equity×pct ×8', 8]] as Array<[string, number]>) {
  const m = matchMdd((pct) => cfg({ pct, maxConcurrent: mc }), TARGET);
  row(label, m.pct, m.res);
}

console.log('\n◆ ⑧ 순서 의존성 — 단일패스의 +22% 가 코인 배열 순서 때문인가');
console.log('  코인 순서        | 추가없음 | 단일패스추가 | 개선분');
for (const k of ['cap', 'rev', 'alpha', 'seed1', 'seed2'] as const) {
  orderBy(k);
  const a = matchMdd((pct) => cfg({ pct }), TARGET);
  const b = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' }), TARGET);
  const lbl = { cap: '시총순(현행)', rev: '역순', alpha: '알파벳', seed1: '셔플A', seed2: '셔플B' }[k];
  console.log(`  ${lbl.padEnd(16)}| ${(a.res.total.toFixed(0) + '%').padStart(8)} | ${(b.res.total.toFixed(0) + '%').padStart(12)} | ${((b.res.total / a.res.total - 1) * 100).toFixed(0).padStart(5)}%`);
}
orderBy('cap');

console.log('\n◆ ⑨ 슬롯 경쟁 규칙 — 슬롯이 모자랄 때 무엇을 포기하나 (동일 MDD)');
console.log('  코인 순서        | 신규만 | 신규우선 | 단일패스 | 증액우선');
for (const k of ['cap', 'rev', 'seed1', 'seed2'] as const) {
  orderBy(k);
  const a = matchMdd((pct) => cfg({ pct }), TARGET).res.total;
  const b = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'signal2' }), TARGET).res.total;
  const c2 = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' }), TARGET).res.total;
  const d = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'addfirst' }), TARGET).res.total;
  const lbl = { cap: '시총순(현행)', rev: '역순', seed1: '셔플A', seed2: '셔플B' }[k];
  console.log(`  ${lbl.padEnd(16)}| ${(a.toFixed(0) + '%').padStart(6)} | ${(b.toFixed(0) + '%').padStart(8)} | ${(c2.toFixed(0) + '%').padStart(8)} | ${(d.toFixed(0) + '%').padStart(8)}`);
}
orderBy('cap');

console.log('\n◆ ⑩ 승자 후보들의 기간분할 + OOS (동일 MDD)');
const PER: Array<[string, number | undefined, number | undefined]> = [
  ['2022-07~2023', undefined, D('2024-01-01')],
  ['2024', D('2024-01-01'), D('2025-01-01')],
  ['2025', D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];
const WIN: Array<[string, (pct: number) => Cfg]> = [
  ['신규만 (대조군)', (pct) => cfg({ pct })],
  ['단일패스 추가', (pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' })],
  ['증액우선', (pct) => cfg({ pct, maxPerCoin: 2, mode: 'addfirst' })],
];
console.log('  구성            |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
const vals = new Map<string, number[]>();
for (const [label, make] of WIN) {
  const m = matchMdd(make, TARGET);              // pct 는 전체구간에서 한 번 고정 후 각 구간 평가
  const cells: string[] = []; const vv: number[] = [];
  for (const [, f, t] of PER) { const r = run(make(m.pct), f, t); vv.push(r.total); cells.push(`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)); }
  vals.set(label, vv);
  console.log(`  ${label.padEnd(15)}|` + cells.map((x) => ` ${x} |`).join(''));
}
const bb = vals.get('신규만 (대조군)')!;
for (const [label] of WIN.slice(1)) {
  const v = vals.get(label)!;
  console.log(`    ${label.padEnd(15)} ${v.filter((x, i) => x > bb[i]).length}/4 구간 우세`);
}
const SP = D('2024-08-01');
console.log('\n  워크포워드 (pct 를 ~2024-08 에서 고정 → 이후 평가):');
for (const [label, make] of WIN) {
  const is = matchMdd(make, TARGET, undefined, SP);
  const oos = run(make(is.pct), SP);
  console.log(`    ${label.padEnd(15)} IS pct=${(is.pct * 100).toFixed(0)}%  OOS ${oos.total.toFixed(0)}% / MDD ${oos.mdd.toFixed(1)}% / PF ${oos.pf.toFixed(2)}`);
}

console.log('\n◆ ⑪ 단일패스 추가 — 최종 반증 (동일 MDD)');
console.log('  ① 플라시보: 재신호 없이 3봉 경과만으로 증액');
console.log(HDR);
const z1 = matchMdd((pct) => cfg({ pct }), TARGET);
row('신규만 (대조군)', z1.pct, z1.res);
const z2 = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' }), TARGET);
row('재신호 증액 (후보)', z2.pct, z2.res);
const z3 = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixedPlacebo' }), TARGET);
row('플라시보: 3봉뒤 무조건 증액', z3.pct, z3.res);
console.log(`  → 후보가 플라시보보다 ${((z2.res.total / z3.res.total - 1) * 100).toFixed(0)}% 우위 (작으면 신호 무의미)`);

console.log('\n  ② 마찰 스트레스');
console.log('  마찰            | 신규만 | 재신호증액 | 개선분');
for (const mult of [1, 2, 3]) {
  FEE = 0.0005 * mult; SLIP = 0.0005 * mult;
  const a = matchMdd((pct) => cfg({ pct }), TARGET);
  const b = matchMdd((pct) => cfg({ pct, maxPerCoin: 2, mode: 'mixed' }), TARGET);
  console.log(`  ×${mult} (${(mult * 0.1).toFixed(1)}% 왕복)  | ${(a.res.total.toFixed(0) + '%').padStart(6)} | ${(b.res.total.toFixed(0) + '%').padStart(10)} | ${((b.res.total / a.res.total - 1) * 100).toFixed(0).padStart(5)}%`);
}
FEE = 0.0005; SLIP = 0.0005;

console.log('\n  ③ 트란치별 성과');
console.log('  트란치 | 건수 |    WR |    PF | 평균수익');
for (const [k, v] of [...z2.res.byTranche.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(k).padStart(6)} | ${String(v.n).padStart(4)} | ${(v.wins / v.n * 100).toFixed(1).padStart(4)}% | ${(v.gl > 0 ? v.gw / v.gl : 99).toFixed(2).padStart(5)} | ${(v.sum / v.n * 100).toFixed(2).padStart(7)}%`);
}

console.log('\n  ④ 트란치 상한 (동일 MDD, 단일패스)');
console.log(HDR);
for (const mp of [1, 2, 3, 4]) {
  const m = matchMdd((pct) => cfg({ pct, maxPerCoin: mp, mode: mp > 1 ? 'mixed' : 'none' }), TARGET);
  row(`코인당 최대 ${mp}`, m.pct, m.res);
}

// ── 실운영 드롭인 검증: 사이징은 현행(cash×pct) 그대로 두고 증액 규칙만 얹으면?
console.log('\n◆ ⑫ 실운영 드롭인 — 사이징은 현행(cash×33%) 유지, 증액 규칙만 추가');
{
  // cash 기준 사이징을 이 하네스에 재현하기 위해 addPos 의 기준을 바꾼 별도 시뮬
  const runCash = (maxPerCoin: number, from?: number, to?: number) => {
    let cash = INIT; const open: Pos[] = [];
    let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0;
    const t0 = from ? Math.max(200, TS.findIndex((x) => x >= from)) : 200;
    const tR = to ? TS.findIndex((x) => x >= to) : -1; const tEnd = tR < 0 ? TS.length : tR;
    for (let t = t0; t < tEnd; t++) {
      const ts = TS[t];
      for (let p = open.length - 1; p >= 0; p--) {
        const pos = open[p]; const b = SERIES.get(pos.market)!; const i = IDX.get(pos.market)!.get(ts);
        if (i === undefined || i <= pos.entryIdxBar) continue;
        const bar = b[i]; let px = 0, done = false;
        if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
        else {
          pos.peak = Math.max(pos.peak, bar.high);
          if (!pos.armed && pos.peak >= pos.entryPrice * (1 + ACT / 100)) pos.armed = true;
          if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
        }
        if (!done && (i - pos.entryIdxBar) >= MAXB) { px = bar.close; done = true; }
        if (done) {
          const pr = pos.vol * px * (1 - SLIP) * (1 - FEE); cash += pr;
          const r = pr / pos.cashUsed - 1; n++; if (r > 0) { wins++; gw += r; } else gl += -r;
          open.splice(p, 1);
        }
      }
      if (t < tEnd - 20) {
        for (const m of MKTS) {
          if (open.length >= 3) break;
          const held = open.filter((p) => p.market === m).length;
          if (held >= maxPerCoin) continue;
          const i = IDX.get(m)!.get(ts); if (i === undefined) continue;
          const b = SERIES.get(m)!; if (i + 1 >= b.length) continue;
          if (!sigF6(b, i)) continue;
          const use = cash * 0.33; if (use < 5000) continue;
          const ep = b[i + 1].open * (1 + SLIP);
          cash -= use;
          open.push({ market: m, tranche: held + 1, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, entryIdxBar: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
        }
      }
      let v = 0; for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) v += p.vol * SERIES.get(p.market)![i].close; }
      const eq = cash + v; peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    }
    const lt = TS[Math.min(tEnd - 1, TS.length - 1)];
    let fe = cash; for (const p of open) { const i = IDX.get(p.market)!.get(lt); if (i !== undefined) fe += p.vol * SERIES.get(p.market)![i].close; }
    return { total: (fe / INIT - 1) * 100, mdd, trades: n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
  };
  const PER2: Array<[string, number | undefined, number | undefined]> = [
    ['2022-07~2023', undefined, D('2024-01-01')], ['2024', D('2024-01-01'), D('2025-01-01')],
    ['2025', D('2025-01-01'), D('2026-01-01')], ['2026 YTD', D('2026-01-01'), undefined],
  ];
  console.log('  구성                | 전체(총익/MDD) |' + PER2.map((p) => ` ${p[0].padStart(13)} |`).join(''));
  const store: number[][] = [];
  for (const mp of [1, 2]) {
    const all = runCash(mp);
    const cells: string[] = []; const vv: number[] = [];
    for (const [, f, t] of PER2) { const r = runCash(mp, f, t); vv.push(r.total); cells.push(`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)); }
    store.push(vv);
    const lbl = mp === 1 ? '현행 (코인당 1)' : '증액 허용 (코인당 2)';
    console.log(`  ${lbl.padEnd(19)}| ${(all.total.toFixed(0) + '% / ' + all.mdd.toFixed(1) + '%').padStart(14)} |` + cells.map((x) => ` ${x} |`).join(''));
  }
  console.log(`\n  기간별 우세: ${store[1].filter((x, i) => x > store[0][i]).length}/4`);
}
