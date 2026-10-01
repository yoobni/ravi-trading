/**
 * 급등 지속(surge continuation) — F6 가 구조적으로 못 잡는 신호.
 *
 * F6 는 "7일 신고가 돌파"다. 그런데 코인은 신고가가 아니어도 한 봉에 크게 튄다.
 * 하락 추세 중의 반등, 박스권 상단이 아닌 곳에서의 급등, 신고가까지는 못 간 강한 상승 —
 * 전부 F6 의 시야 밖이다. 그 급등이 이어지는지를 본다.
 *
 * 이미 반대편(급락 후 반전)은 시험해서 기각했다(호가 튐이었다). 이번은 같은 논리의 반대 방향이고,
 * **강세를 사는 쪽이라 호가 튐 문제가 없다**(F6 자기검증에서 확인된 성질).
 *
 * 핵심 설계 — 증분 가치만 재기:
 *   ALL      : 급등 전부
 *   NON_F6   : 그중 **F6 신호가 아닌 것만** ← F6 에 없는 수익원인지가 진짜 질문
 *   결합      : F6 + NON_F6 를 한 계좌에서 돌렸을 때 개선되는가
 *
 * 판정: 동일 MDD 이분탐색, 기간분할 4구간, 플라시보(무작위 진입), F6 월별수익 상관.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
let FEE = 0.0005, SLIP = 0.0005;
const INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;   // 청산은 F6_v5 와 동일 — 신호 효과만 분리

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter((x) => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const ALL = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) ALL.set(m, b); }
let MKTS = [...ALL.keys()];
const MKTS0 = [...MKTS];
/** 코인 배열 순서 = 슬롯 경쟁 시 우선순위. 결과가 여기 의존하면 인공물이다. */
function orderBy(kind: 'cap' | 'rev' | 'alpha' | 's1' | 's2') {
  if (kind === 'cap') MKTS = [...MKTS0];
  else if (kind === 'rev') MKTS = [...MKTS0].reverse();
  else if (kind === 'alpha') MKTS = [...MKTS0].sort();
  else {
    const k = kind === 's1' ? 7 : 13;
    MKTS = [...MKTS0].map((m, i) => [m, (i * k) % MKTS0.length] as [string, number]).sort((a, b) => a[1] - b[1]).map(([m]) => m);
  }
}
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
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
/** 급등: 한 봉 상승률이 문턱 이상 + 거래량 동반 */
const sigSurge = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && b[i].close > b[i].open && volZ(b, i) >= vz;

type Mode = 'F6' | 'SURGE_ALL' | 'SURGE_NON_F6' | 'BOTH' | 'RANDOM' | 'BOTH_MIRROR' | 'BOTH_LAG';
interface Cfg { mode: Mode; pct: number; vz: number; seed?: number }
interface Pos { m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number; src: string }

function run(c: Cfg, size: number, maxCon: number, from: number, to?: number) {
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const bySrc = new Map<string, { n: number; s: number; w: number }>();
  const monthly = new Map<string, number>();
  let prevEq = INIT;
  let seed = (c.seed ?? 1) * 7919 + 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const t0 = Math.max(TS.findIndex((t) => t >= from), 200);
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
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        const k = bySrc.get(pos.src) ?? { n: 0, s: 0, w: 0 };
        k.n++; k.s += r; if (r > 0) k.w++; bySrc.set(pos.src, k);
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
        if (i === undefined || i + 1 >= b.length) continue;
        const f6 = sigF6(b, i), sg = sigSurge(b, i, c.pct, c.vz);
        let hit = false, src = '';
        if (c.mode === 'F6') { hit = f6; src = 'F6'; }
        else if (c.mode === 'SURGE_ALL') { hit = sg; src = 'SURGE'; }
        else if (c.mode === 'SURGE_NON_F6') { hit = sg && !f6; src = 'SURGE'; }
        else if (c.mode === 'BOTH') { hit = f6 || (sg && !f6); src = f6 ? 'F6' : 'SURGE'; }
        else if (c.mode === 'RANDOM') { hit = rnd() < 0.0012; src = 'RND'; }
        // 플라시보 ①: 급등 대신 **급락**을 산다(같은 크기, 부호만 반대). 부호에 정보가 있다면 크게 나빠야 한다.
        else if (c.mode === 'BOTH_MIRROR') {
          const dn = i >= 43 && (b[i].close / b[i].open - 1) <= -c.pct / 100 && volZ(b, i) >= c.vz;
          hit = f6 || (dn && !f6); src = f6 ? 'F6' : 'SURGE';
        }
        // 플라시보 ②: 급등을 3봉 뒤에 산다. 즉시성이 중요하면 크게 나빠야 한다.
        else if (c.mode === 'BOTH_LAG') {
          const lagged = i >= 46 && sigSurge(b, i - 3, c.pct, c.vz);
          hit = f6 || (lagged && !f6 && !sigSurge(b, i, c.pct, c.vz)); src = f6 ? 'F6' : 'SURGE';
        }
        if (!hit) continue;
        const use = Math.min(cash, eqNow * size);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, last: ep, src });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.last = ALL.get(p.m)![i].close; eq += p.vol * p.last; }
    const mk = new Date(ts).toISOString().slice(0, 7);
    monthly.set(mk, (monthly.get(mk) ?? 0) + (prevEq > 0 ? eq / prevEq - 1 : 0));
    prevEq = eq;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, bySrc, monthly };
}
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (x: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 15; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { size: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
function corr(a: Map<string, number>, b: Map<string, number>) {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const x = keys.map((k) => a.get(k) ?? 0), y = keys.map((k) => b.get(k) ?? 0);
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : NaN;
}
const FROM = TS[200], TARGET = 17.0;
console.log(`=== 급등 지속 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}, MDD ${TARGET}% 고정) ===`);
console.log('  청산(트레일 A2)·배분 고정. 신호만 교체해 "F6 가 못 보는 급등"에 값이 있는지 본다.\n');
const f6 = matchMdd((x) => run({ mode: 'F6', pct: 0, vz: 0 }, x, 3, FROM), TARGET);
console.log(`  F6 (대조군): ${f6.res.total.toFixed(0)}% · 거래 ${f6.res.n} · PF ${f6.res.pf.toFixed(2)}\n`);
console.log('  급등 조건      |          모드 |    총익 | F6대비 | 거래 |    WR |    PF | F6상관');
console.log('  ' + '-'.repeat(94));
for (const [pct, vz] of [[3, 0.5], [5, 0.5], [5, 1.5], [8, 1.0], [12, 1.0]] as Array<[number, number]>) {
  for (const mode of ['SURGE_ALL', 'SURGE_NON_F6'] as Mode[]) {
    const m = matchMdd((x) => run({ mode, pct, vz }, x, 3, FROM), TARGET);
    const c = corr(f6.res.monthly, m.res.monthly);
    console.log(`  ${('+' + pct + '% volZ≥' + vz).padEnd(15)}| ${(mode === 'SURGE_ALL' ? '급등 전부' : 'F6 아닌 것만').padStart(13)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / f6.res.total - 1) * 100).toFixed(0) + '%').padStart(6)} | ${String(m.res.n).padStart(4)} | ${m.res.wr.toFixed(1).padStart(4)}% | ${m.res.pf.toFixed(2).padStart(5)} | ${(Number.isNaN(c) ? '-' : c.toFixed(2)).padStart(6)}`);
  }
}
console.log('\n◆ 플라시보 (같은 빈도 무작위 진입)');
for (const seed of [1, 2, 3]) {
  const m = matchMdd((x) => run({ mode: 'RANDOM', pct: 0, vz: 0, seed }, x, 3, FROM), TARGET);
  console.log(`  무작위 #${seed} | 총익 ${(m.res.total.toFixed(0) + '%').padStart(7)} · 거래 ${m.res.n} · PF ${m.res.pf.toFixed(2)}`);
}
console.log('\n◆ 결합 — F6 + (F6 아닌 급등) 을 한 계좌에서');
console.log('  급등 조건      |    총익 | F6대비 | 거래 |    PF | 출처별 (건수·평균수익)');
for (const [pct, vz] of [[3, 0.5], [5, 0.5], [8, 1.0]] as Array<[number, number]>) {
  const m = matchMdd((x) => run({ mode: 'BOTH', pct, vz }, x, 3, FROM), TARGET);
  const parts = [...m.res.bySrc.entries()].sort().map(([k, v]) => `${k} ${v.n}건 ${(v.s / v.n * 100).toFixed(2)}%`).join(' · ');
  console.log(`  ${('+' + pct + '% volZ≥' + vz).padEnd(15)}| ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / f6.res.total - 1) * 100).toFixed(0) + '%').padStart(6)} | ${String(m.res.n).padStart(4)} | ${m.res.pf.toFixed(2).padStart(5)} | ${parts}`);
}

// ── 검증: 문턱 고원 / 기간분할. 한 칸만 튀면 과최적화다.
console.log('\n\n◆ 결합 문턱 고원 (F6 + F6아닌급등, 동일 MDD 17%)');
console.log('  급등문턱 | volZ |    총익 | F6대비 | 거래 | 급등건수 | 급등 평균수익 |    PF');
console.log('  ' + '-'.repeat(90));
const grid: Array<[string, number]> = [];
for (const vz of [0.5, 1.0, 1.5]) {
  for (const pct of [5, 6, 7, 8, 9, 10, 12]) {
    const m = matchMdd((x) => run({ mode: 'BOTH', pct, vz }, x, 3, FROM), TARGET);
    const sg = m.res.bySrc.get('SURGE') ?? { n: 0, s: 0, w: 0 };
    grid.push([`${pct}/${vz}`, m.res.total]);
    console.log(`  ${('+' + pct + '%').padStart(8)} | ${String(vz).padStart(4)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / f6.res.total - 1) * 100).toFixed(0) + '%').padStart(6)} | ${String(m.res.n).padStart(4)} | ${String(sg.n).padStart(8)} | ${(sg.n ? (sg.s / sg.n * 100).toFixed(2) + '%' : '-').padStart(13)} | ${m.res.pf.toFixed(2).padStart(5)}`);
  }
}
const better = grid.filter(([, v]) => v > f6.res.total).length;
console.log(`\n  F6(${f6.res.total.toFixed(0)}%)보다 나은 칸: ${better}/${grid.length}`);

console.log('\n◆ 기간분할 (동일 MDD 지점의 size 고정)');
const PER: Array<[string, number, number | undefined]> = [
  ['2022-07~2023', FROM, D('2024-01-01')],
  ['2024', D('2024-01-01'), D('2025-01-01')],
  ['2025', D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];
const CMP: Array<[string, Cfg]> = [
  ['F6 단독 (대조군)', { mode: 'F6', pct: 0, vz: 0 }],
  ['결합 +7% volZ≥1', { mode: 'BOTH', pct: 7, vz: 1.0 }],
  ['결합 +8% volZ≥1', { mode: 'BOTH', pct: 8, vz: 1.0 }],
  ['결합 +9% volZ≥1', { mode: 'BOTH', pct: 9, vz: 1.0 }],
  ['결합 +8% volZ≥1.5', { mode: 'BOTH', pct: 8, vz: 1.5 }],
];
console.log('  구성                |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join(''));
const vals = new Map<string, number[]>();
for (const [lbl, cfg] of CMP) {
  const m = matchMdd((x) => run(cfg, x, 3, FROM), TARGET);
  let line = `  ${lbl.padEnd(19)}|`; const arr: number[] = [];
  for (const [, f, t] of PER) { const r = run(cfg, m.size, 3, f, t); arr.push(r.total); line += ` ${`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(13)} |`; }
  vals.set(lbl, arr); console.log(line);
}
const bl = vals.get('F6 단독 (대조군)')!;
for (const [lbl] of CMP.slice(1)) {
  const a = vals.get(lbl)!;
  console.log(`    ${lbl.padEnd(19)} ${a.filter((x, i) => x > bl[i]).length}/${PER.length} 구간 우세`);
}


console.log('\n\n◆ 반증 시험 (결합 +7% volZ≥1 기준, 동일 MDD 17%)');
const BEST: Cfg = { mode: 'BOTH', pct: 7, vz: 1.0 };
const base7 = matchMdd((x) => run(BEST, x, 3, FROM), TARGET).res.total;
console.log(`  후보: ${base7.toFixed(0)}%   (F6 단독 ${f6.res.total.toFixed(0)}%)\n`);
console.log('  ① 플라시보');
for (const [lbl, mode] of [['급락을 산다 (부호 반전)', 'BOTH_MIRROR'], ['3봉 늦게 산다 (즉시성 제거)', 'BOTH_LAG']] as Array<[string, Mode]>) {
  const m = matchMdd((x) => run({ ...BEST, mode }, x, 3, FROM), TARGET);
  const sg = m.res.bySrc.get('SURGE') ?? { n: 0, s: 0, w: 0 };
  console.log(`     ${lbl.padEnd(28)} ${(m.res.total.toFixed(0) + '%').padStart(7)} · 추가거래 ${String(sg.n).padStart(4)}건 평균 ${sg.n ? (sg.s / sg.n * 100).toFixed(2) : '-'}%`);
}
console.log('\n  ② 마찰 스트레스');
for (const mult of [1, 2, 3]) {
  FEE = 0.0005 * mult; SLIP = 0.0005 * mult;
  const a = matchMdd((x) => run({ mode: 'F6', pct: 0, vz: 0 }, x, 3, FROM), TARGET).res.total;
  const b2 = matchMdd((x) => run(BEST, x, 3, FROM), TARGET).res.total;
  console.log(`     왕복 ${(mult * 0.2).toFixed(1)}%  F6 ${(a.toFixed(0) + '%').padStart(7)} → 결합 ${(b2.toFixed(0) + '%').padStart(7)}  (${((b2 / a - 1) * 100).toFixed(0)}%)`);
}
FEE = 0.0005; SLIP = 0.0005;

console.log('\n  ③ 워크포워드 — 앞 절반(~2024-08)에서 문턱을 고르고 뒤 절반에 적용');
const SP = D('2024-08-01');
let bestPct = 0, bestVal = -Infinity;
for (const pct of [5, 6, 7, 8, 9, 10]) {
  const v = matchMdd((x) => run({ mode: 'BOTH', pct, vz: 1.0 }, x, 3, FROM, SP), TARGET).res.total;
  if (v > bestVal) { bestVal = v; bestPct = pct; }
}
const isF6 = matchMdd((x) => run({ mode: 'F6', pct: 0, vz: 0 }, x, 3, FROM, SP), TARGET);
const isBoth = matchMdd((x) => run({ mode: 'BOTH', pct: bestPct, vz: 1.0 }, x, 3, FROM, SP), TARGET);
const oosF6 = run({ mode: 'F6', pct: 0, vz: 0 }, isF6.size, 3, SP);
const oosBoth = run({ mode: 'BOTH', pct: bestPct, vz: 1.0 }, isBoth.size, 3, SP);
console.log(`     IS 최적 문턱 = +${bestPct}% (IS 총익 ${bestVal.toFixed(0)}%)`);
console.log(`     OOS F6   ${oosF6.total.toFixed(0)}% / MDD ${oosF6.mdd.toFixed(1)}% / PF ${oosF6.pf.toFixed(2)}`);
console.log(`     OOS 결합 ${oosBoth.total.toFixed(0)}% / MDD ${oosBoth.mdd.toFixed(1)}% / PF ${oosBoth.pf.toFixed(2)}   → ${((oosBoth.total / oosF6.total - 1) * 100).toFixed(0)}%`);

// ── ④ 호가 튐 검사. 횡단면 반전은 이 검사에서 죽었다(수익의 정체가 bid-ask bounce 였다).
//     급등은 "강세를 사는" 쪽이라 원리상 안전하지만, 확인 전엔 모른다.
//     시가진입(실행 가능) vs 종가진입(튐 포함)의 차이가 튐 성분이다.
console.log('\n\n◆ ④ 호가 튐 검사 — 급등 신호가 소형주 잔파동을 잡는 것인가');
{
  function turn(b: Bar[], i: number, w = 30) {
    if (i < w) return NaN;
    let s = 0; for (let j = i - w; j < i; j++) s += b[j].close * b[j].volume;
    return s / w;
  }
  interface T { ret: number; retClose: number; liq: number }
  const rows: T[] = [];
  for (const m of MKTS) {
    const b = ALL.get(m)!;
    for (let i = 43; i < b.length - 2; i++) {
      if (b[i].ts < FROM) continue;
      if (!sigSurge(b, i, 7, 1.0) || sigF6(b, i)) continue;   // F6 가 못 잡는 급등만
      const liq = turn(b, i);
      if (!Number.isFinite(liq)) continue;
      const ep = b[i + 1].open * (1 + SLIP);          // 실행 가능
      const epC = b[i].close * (1 + SLIP);            // 튐 포함(실제로는 못 사는 가격)
      let peak = ep, sl = ep * (1 + SL / 100), armed = false, exit = 0;
      for (let j = i + 2; j < Math.min(b.length, i + 2 + MAXB); j++) {
        if (b[j].low <= sl) { exit = sl; break; }
        peak = Math.max(peak, b[j].high);
        if (!armed && peak >= ep * (1 + ACT / 100)) armed = true;
        if (armed) sl = Math.max(sl, peak * (1 - GAP / 100));
        if (j === Math.min(b.length, i + 2 + MAXB) - 1) exit = b[j].close;
      }
      if (!exit) continue;
      const net = exit * (1 - SLIP) * (1 - FEE) ** 2;
      rows.push({ ret: net / ep - 1, retClose: net / epC - 1, liq });
    }
  }
  rows.sort((a, b) => b.liq - a.liq);
  const Q = 5, per = Math.floor(rows.length / Q);
  console.log(`  급등 신호(F6 제외) ${rows.length}건\n`);
  console.log('  분위        | 건수 | 평균 거래대금 | 시가진입(실행가능) | 종가진입(튐포함) | 튐 성분');
  console.log('  ' + '-'.repeat(94));
  for (let q = 0; q < Q; q++) {
    const sl2 = rows.slice(q * per, q === Q - 1 ? rows.length : (q + 1) * per);
    const a = sl2.reduce((s, t) => s + t.ret, 0) / sl2.length * 100;
    const c = sl2.reduce((s, t) => s + t.retClose, 0) / sl2.length * 100;
    const liq = sl2.reduce((s, t) => s + t.liq, 0) / sl2.length;
    console.log(`  ${('Q' + (q + 1) + (q === 0 ? ' (최상위)' : q === Q - 1 ? ' (최하위)' : '')).padEnd(12)}| ${String(sl2.length).padStart(4)} | ${((liq / 1e8).toFixed(1) + '억').padStart(13)} | ${(a.toFixed(3) + '%').padStart(18)} | ${(c.toFixed(3) + '%').padStart(16)} | ${((c - a).toFixed(3) + '%p').padStart(8)}`);
  }
  console.log('\n  (횡단면 반전은 이 값이 0.036~0.176%p 로 유동성 하락에 따라 단조 증가했고, 그래서 기각됐다)');
}


console.log('\n\n◆ ⑤ 하네스 민감도 — 코인 배열 순서(슬롯 경쟁 우선순위)를 바꿔도 유지되는가');
console.log('  (증액 후보는 이 검사에서 -7%~+22% 로 흔들려 판정 불가가 됐다)');
console.log('  코인 순서        | F6 단독 | 결합 +7%v1 | 개선분');
for (const k of ['cap', 'rev', 'alpha', 's1', 's2'] as const) {
  orderBy(k);
  const a = matchMdd((x) => run({ mode: 'F6', pct: 0, vz: 0 }, x, 3, FROM), TARGET).res.total;
  const b2 = matchMdd((x) => run({ mode: 'BOTH', pct: 7, vz: 1.0 }, x, 3, FROM), TARGET).res.total;
  const lbl = { cap: '시총순(현행)', rev: '역순', alpha: '알파벳', s1: '셔플A', s2: '셔플B' }[k];
  console.log(`  ${lbl.padEnd(16)}| ${(a.toFixed(0) + '%').padStart(7)} | ${(b2.toFixed(0) + '%').padStart(10)} | ${(((b2 / a - 1) * 100).toFixed(0) + '%').padStart(6)}`);
}
orderBy('cap');
