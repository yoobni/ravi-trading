/**
 * "이기는 포지션에 더 태우기"의 일반화 — 배운 것 중 유일하게 통한 메커니즘의 확장.
 *
 * 정리된 사실:
 *   - 병목은 자본 가동률(평균 투입 14%, 포지션 0개인 시간 72%).
 *   - 품질을 필터로 쓰면 실패(6전 6패), 비중으로 써도 실패(_bt_qualsize, -19~-31%).
 *   - 통한 것은 하나: 같은 코인 재신호 시 증액(+14%, 동일 MDD).
 *
 * 그 하나를 더 밀어본다. 지금 증액은 "7일 신고가 재돌파"라는 F6 신호 전체를 요구해서
 * 좀처럼 안 걸린다(2년간 44건). 문턱을 낮추면 더 자주 태울 수 있다 —
 * 단, 아무 때나가 아니라 **그 포지션이 이미 잘 되고 있을 때만**:
 *
 *   A 재신호   : 현행 — F6 신호가 다시 뜰 때 (대조군)
 *   B 무장후신고가: 트레일이 무장(+2% 도달)된 뒤, 진입 후 최고가를 다시 경신할 때
 *   C 수익률문턱 : 포지션 수익률이 +X% 를 넘을 때 한 번
 *   D 시간경과   : 보유 N봉 경과 시 무조건 (플라시보 — 조건에 정보가 없을 때의 대조)
 *
 * 전부 동일 MDD 로 맞춘 뒤 비교한다. D 를 못 이기면 조건에 정보가 없는 것이다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const CUR28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const ALL = new Map<string, Bar[]>();
for (const m of CUR28) { const b = load(m); if (b && b.length > 500) ALL.set(m, b); }
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

type Mode = 'none' | 'resignal' | 'armedHigh' | 'profit' | 'time';
interface Pos { m: string; ep: number; vol: number; used: number; entryIdx: number; peak: number; sl: number; armed: boolean; lastPx: number; added: boolean; tranche: number }

/**
 * @param oneAdd true 면 한 포지션당 증액 1회로 제한. false 면 트란치 상한만 지키면 반복 가능
 *   (_bt_pyramid 는 false 였다 — 두 구현 차이가 결과를 갈랐는지 확인용)
 */
function run(pct: number, maxCon: number, maxPerCoin: number, mode: Mode, param: number, from: number, to?: number, oneAdd = true) {
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0, deploySum = 0, nBars = 0, adds = 0;
  const byTranche = new Map<number, { n: number; s: number; w: number }>();
  const t0 = Math.max(TS.findIndex((t) => t >= from), 0);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  for (let t = t0; t < t1; t++) {
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
        const k = byTranche.get(pos.tranche) ?? { n: 0, s: 0, w: 0 };
        k.n++; k.s += r; if (r > 0) k.w++; byTranche.set(pos.tranche, k);
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? ALL.get(p.m)![i].close : p.lastPx); }

    if (t < t1 - 20) {
      // ── 추가 진입(증액) — 이미 보유 중이고 조건을 만족한 포지션에만
      if (mode !== 'none' && open.length < maxCon) {
        for (const pos of [...open]) {
          if (open.length >= maxCon) break;
          if (oneAdd && pos.added) continue;
          if (open.filter((p) => p.m === pos.m).length >= maxPerCoin) continue;
          const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
          if (i === undefined || i + 1 >= b.length || i <= pos.entryIdx) continue;
          let ok = false;
          if (mode === 'resignal') ok = sigF6(b, i);
          else if (mode === 'armedHigh') ok = pos.armed && b[i].close > hi(b, pos.entryIdx, i);
          else if (mode === 'profit') ok = b[i].close / pos.ep - 1 >= param / 100;
          else if (mode === 'time') ok = (i - pos.entryIdx) >= param;
          if (!ok) continue;
          const use = Math.min(cash, eqNow * pct);
          if (use < 5000) continue;
          const ep = b[i + 1].open * (1 + SLIP);
          cash -= use; adds++;
          pos.added = true;
          open.push({ m: pos.m, ep, vol: use * (1 - FEE) / ep, used: use, entryIdx: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, lastPx: ep, added: true, tranche: pos.tranche + 1 });
        }
      }
      // ── 신규 진입
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length || !sigF6(b, i)) continue;
        const use = Math.min(cash, eqNow * pct);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, entryIdx: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, lastPx: ep, added: false, tranche: 1 });
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
  return { total: (fin / INIT - 1) * 100, mdd, n, adds, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, deploy: nBars ? deploySum / nBars * 100 : 0, byTranche };
}

const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (pct: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { pct: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[200], TARGET = 17.0;
console.log(`=== 증액 규칙 일반화 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===\n`);
console.log(`◆ 동일 MDD(${TARGET}%) 고정`);
console.log('  증액 조건                       | 그때pct |    총익 | 대조군대비 | 증액수 | 가동률 |    PF');
console.log('  ' + '-'.repeat(96));
const CASES: Array<[string, Mode, number]> = [
  ['증액 없음 (대조군)', 'none', 0],
  ['A 재신호 (현행 v8)', 'resignal', 0],
  ['B 무장 후 진입가 대비 신고가', 'armedHigh', 0],
  ['C 수익률 +3% 돌파', 'profit', 3],
  ['C 수익률 +5% 돌파', 'profit', 5],
  ['C 수익률 +8% 돌파', 'profit', 8],
  ['D 플라시보: 3봉 경과', 'time', 3],
  ['D 플라시보: 6봉 경과', 'time', 6],
];
let base = 0;
const results: Array<[string, number, ReturnType<typeof run>]> = [];
for (const [lbl, mode, param] of CASES) {
  const m = matchMdd((pct) => run(pct, 3, mode === 'none' ? 1 : 2, mode, param, FROM), TARGET);
  if (!base) base = m.res.total;
  results.push([lbl, m.pct, m.res]);
  console.log(`  ${lbl.padEnd(32)}| ${((m.pct * 100).toFixed(1) + '%').padStart(7)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(10)} | ${String(m.res.adds).padStart(6)} | ${(m.res.deploy.toFixed(0) + '%').padStart(6)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}
console.log('\n◆ 트란치별 성과 (상위 후보)');
for (const [lbl, , r] of results.slice(1, 4)) {
  const parts = [...r.byTranche.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `T${k} n=${v.n} 평균 ${(v.s / v.n * 100).toFixed(2)}% 승률 ${(v.w / v.n * 100).toFixed(0)}%`);
  console.log(`  ${lbl.padEnd(32)} ${parts.join(' | ')}`);
}

// ── 검증: 문턱 고원 / 기간분할 / 플라시보 대비. 한 칸만 좋으면 과최적화다.
console.log('\n\n◆ 수익률 문턱 고원 (동일 MDD 17%)');
console.log('  문턱  |    총익 | 대조군대비 | 증액수 |    PF');
const ctrl = matchMdd((pct) => run(pct, 3, 1, 'none', 0, FROM), TARGET).res.total;
const grid: Array<[number, number]> = [];
for (const th of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12]) {
  const m = matchMdd((pct) => run(pct, 3, 2, 'profit', th, FROM), TARGET);
  grid.push([th, m.res.total]);
  console.log(`  ${(th + '%').padStart(5)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / ctrl - 1) * 100).toFixed(0) + '%').padStart(10)} | ${String(m.res.adds).padStart(6)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}
const pos = grid.filter(([, v]) => v > ctrl).length;
console.log(`\n  대조군(${ctrl.toFixed(0)}%)보다 나은 칸: ${pos}/${grid.length}`);

console.log('\n◆ 기간분할 (동일 MDD 지점의 pct 고정)');
const PER: Array<[string, number, number | undefined]> = [
  ['2022-07~2023', FROM, D('2024-01-01')],
  ['2024', D('2024-01-01'), D('2025-01-01')],
  ['2025', D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];
const CMP: Array<[string, Mode, number]> = [
  ['증액 없음 (대조군)', 'none', 0],
  ['B 무장 후 신고가', 'armedHigh', 0],
  ['C 수익률 +3%', 'profit', 3],
  ['C 수익률 +4%', 'profit', 4],
  ['D 플라시보 3봉', 'time', 3],
];
console.log('  구성                |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
const vv = new Map<string, number[]>();
for (const [lbl, mode, param] of CMP) {
  const mpc = mode === 'none' ? 1 : 2;
  const m = matchMdd((pct) => run(pct, 3, mpc, mode, param, FROM), TARGET);
  let line = `  ${lbl.padEnd(19)}|`; const arr: number[] = [];
  for (const [, f, t] of PER) { const r = run(m.pct, 3, mpc, mode, param, f, t); arr.push(r.total); line += ` ${`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)} |`; }
  vv.set(lbl, arr); console.log(line);
}
const bl = vv.get('증액 없음 (대조군)')!;
for (const [lbl] of CMP.slice(1)) {
  const a = vv.get(lbl)!;
  console.log(`    ${lbl.padEnd(19)} ${a.filter((x, i) => x > bl[i]).length}/${PER.length} 구간 우세`);
}


console.log('\n\n◆ 재신호 증액(현행 v8) 구현 차이 확인 — "포지션당 1회 제한" 유무');
console.log('  구성                                  |    총익 | 대조군대비 | 증액수 |    PF');
for (const [lbl, mode, param, one] of [
  ['증액 없음 (대조군)', 'none', 0, true],
  ['재신호 · 포지션당 1회', 'resignal', 0, true],
  ['재신호 · 제한 없음 (_bt_pyramid 방식)', 'resignal', 0, false],
  ['무장후신고가 · 포지션당 1회', 'armedHigh', 0, true],
  ['무장후신고가 · 제한 없음', 'armedHigh', 0, false],
] as Array<[string, Mode, number, boolean]>) {
  const mpc = mode === 'none' ? 1 : 2;
  const m = matchMdd((pct) => run(pct, 3, mpc, mode, param, FROM, undefined, one), TARGET);
  console.log(`  ${lbl.padEnd(38)}| ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / ctrl - 1) * 100).toFixed(0) + '%').padStart(10)} | ${String(m.res.adds).padStart(6)} | ${m.res.pf.toFixed(2).padStart(5)}`);
}
