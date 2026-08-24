/**
 * 자본 가동률 발견(_bt_exposure) 검증 — 믿기 전에 세 가지를 통과해야 한다.
 *
 *   A 건전성  : equity×pct 가 사실상 레버리지가 아닌지. 최대 투입비중·최소 현금을 직접 잰다.
 *   B 기간분할: 4년 통짜 수치는 한 국면에 몰려 있을 수 있다. 4구간 전부에서 이겨야 한다.
 *   C 동일MDD: 총익 비교는 위험을 더 졌기 때문일 수 있다. MDD 를 현행 수준으로 맞춘 뒤 비교한다.
 *
 * 시뮬 본체는 _bt_exposure.ts 와 동일 로직을 복제 — 독립 실행 가능하게 유지한다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;

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

interface Cfg { sizing: 'cashPct' | 'equityPct'; pct: number; maxConcurrent: number; maxPerCoin: number }
const cfg = (o: Partial<Cfg>): Cfg => ({ sizing: 'cashPct', pct: 0.33, maxConcurrent: 3, maxPerCoin: 1, ...o });
interface Pos { market: string; entryPrice: number; vol: number; cashUsed: number; entryIdxBar: number; peak: number; tsl: number; armed: boolean }
interface Res { total: number; mdd: number; trades: number; wr: number; pf: number; deploy: number; maxDeploy: number; minCash: number }

function run(c: Cfg, from?: number, to?: number): Res {
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0;
  let deploySum = 0, maxDeploy = 0, minCash = Infinity, nBars = 0;

  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const tEndRaw = to ? TS.findIndex(x => x >= to) : -1;
  const tEnd = tEndRaw < 0 ? TS.length : tEndRaw;

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
        open.splice(p, 1);
      }
    }
    if (open.length < c.maxConcurrent && t < tEnd - 20) {
      let eqNow = cash;
      for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) eqNow += p.vol * SERIES.get(p.market)![i].close; }
      for (const [m, b] of SERIES) {
        if (open.length >= c.maxConcurrent) break;
        if (open.filter(p => p.market === m).length >= c.maxPerCoin) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
        if (!sigF6(b, i)) continue;
        const want = c.sizing === 'cashPct' ? cash * c.pct : eqNow * c.pct;
        const use = Math.min(want, cash);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ market: m, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, entryIdxBar: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
      }
    }
    let f6Val = 0;
    for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) f6Val += p.vol * SERIES.get(p.market)![i].close; }
    const eq = cash + f6Val;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    const d = eq > 0 ? f6Val / eq : 0;
    nBars++; deploySum += d; maxDeploy = Math.max(maxDeploy, d); minCash = Math.min(minCash, cash);
  }
  const lastTs = TS[Math.min(tEnd - 1, TS.length - 1)];
  let finalEq = cash;
  for (const p of open) { const i = IDX.get(p.market)!.get(lastTs); if (i !== undefined) finalEq += p.vol * SERIES.get(p.market)![i].close; }
  return {
    total: (finalEq / INIT - 1) * 100, mdd, trades: n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99,
    deploy: nBars ? deploySum / nBars * 100 : 0, maxDeploy: maxDeploy * 100, minCash: minCash === Infinity ? 0 : minCash,
  };
}

const D = (s: string) => Date.parse(s + 'T00:00:00Z');   // TS 는 KST 벽시계를 UTC 로 담고 있음
const PERIODS: Array<[string, number | undefined, number | undefined]> = [
  ['2022-07~2023', undefined, D('2024-01-01')],
  ['2024',         D('2024-01-01'), D('2025-01-01')],
  ['2025',         D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD',     D('2026-01-01'), undefined],
];

console.log('=== 자본 가동률 발견 검증 (28코인 4h) ===\n');

console.log('◆ A 건전성 — equity×pct 가 레버리지로 새지 않는가');
console.log('  구성                       | 평균가동 | 최대가동 |   최소현금 | 판정');
for (const [label, c] of [
  ['cash×33% ×3 (현행)', cfg({})],
  ['equity×33% ×3', cfg({ sizing: 'equityPct' })],
  ['equity×33% ×3 · 코인당2', cfg({ sizing: 'equityPct', maxPerCoin: 2 })],
  ['equity×50% ×2', cfg({ sizing: 'equityPct', pct: 0.5, maxConcurrent: 2 })],
] as Array<[string, Cfg]>) {
  const r = run(c);
  const ok = r.maxDeploy <= 100.001 && r.minCash >= -1;
  console.log(`  ${label.padEnd(26)}| ${(r.deploy.toFixed(1) + '%').padStart(8)} | ${(r.maxDeploy.toFixed(1) + '%').padStart(8)} | ${Math.round(r.minCash).toLocaleString().padStart(10)} | ${ok ? 'OK (무차입)' : '⚠ 차입 발생'}`);
}

console.log('\n◆ B 기간분할 — 4구간 전부에서 이겨야 채택');
const CANDS: Array<[string, Cfg]> = [
  ['cash×33% ×3 (현행)', cfg({})],
  ['equity×33% ×3', cfg({ sizing: 'equityPct' })],
  ['equity×33% ×3 · 코인당2', cfg({ sizing: 'equityPct', maxPerCoin: 2 })],
  ['equity×50% ×2', cfg({ sizing: 'equityPct', pct: 0.5, maxConcurrent: 2 })],
  ['equity×25% ×4 · 코인당3', cfg({ sizing: 'equityPct', pct: 0.25, maxConcurrent: 4, maxPerCoin: 3 })],
];
const head = '  구성                       |' + PERIODS.map(p => ` ${p[0].padStart(14)} |`).join('');
console.log(head);
console.log('  ' + '-'.repeat(head.length - 2));
const perPeriod = new Map<string, number[]>();
for (const [label, c] of CANDS) {
  const cells: string[] = []; const vals: number[] = [];
  for (const [, f, t] of PERIODS) { const r = run(c, f, t); vals.push(r.total); cells.push(`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(14)); }
  perPeriod.set(label, vals);
  console.log(`  ${label.padEnd(26)}|` + cells.map(s => ` ${s} |`).join(''));
}
console.log('  (총익 / MDD)');
const baseVals = perPeriod.get('cash×33% ×3 (현행)')!;
console.log('\n  현행 대비 승패:');
for (const [label] of CANDS.slice(1)) {
  const v = perPeriod.get(label)!;
  const w = v.filter((x, i) => x > baseVals[i]).length;
  console.log(`    ${label.padEnd(26)} ${w}/${PERIODS.length} 구간 우세` + (w === PERIODS.length ? '   ✔ 전구간' : ''));
}

console.log('\n◆ C 동일 MDD 정밀 비교 — 각 메커니즘의 pct 를 훑어 MDD 17.0% 지점의 총익을 보간');
interface Fam { label: string; make: (pct: number) => Cfg }
const FAMS: Fam[] = [
  { label: 'cash×pct ×3 (현행 방식)', make: (pct) => cfg({ sizing: 'cashPct', pct }) },
  { label: 'equity×pct ×3', make: (pct) => cfg({ sizing: 'equityPct', pct }) },
  { label: 'equity×pct ×3 · 코인당2', make: (pct) => cfg({ sizing: 'equityPct', pct, maxPerCoin: 2 }) },
  { label: 'equity×pct ×3 · 코인당3', make: (pct) => cfg({ sizing: 'equityPct', pct, maxPerCoin: 3 }) },
  { label: 'equity×pct ×2', make: (pct) => cfg({ sizing: 'equityPct', pct, maxConcurrent: 2 }) },
  { label: 'equity×pct ×5', make: (pct) => cfg({ sizing: 'equityPct', pct, maxConcurrent: 5 }) },
];
const TARGET = 17.0;
const GRID = [0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.22, 0.25, 0.28, 0.33, 0.40, 0.50, 0.60, 0.80, 1.0];
console.log('  구성                       | MDD17% 지점 pct |   그때 총익 | 현행 대비 | 거래');
const matched: Array<[string, number, number, Cfg]> = [];
for (const f of FAMS) {
  const pts = GRID.map((pct) => { const r = run(f.make(pct)); return { pct, mdd: r.mdd, total: r.total, trades: r.trades }; })
                  .filter((x) => x.trades > 0)
                  .sort((a, b) => a.mdd - b.mdd);
  // MDD 가 TARGET 을 가로지르는 두 점 사이 선형보간
  let lo = null as (typeof pts)[0] | null, hiP = null as (typeof pts)[0] | null;
  for (const p of pts) { if (p.mdd <= TARGET) lo = p; else if (!hiP) hiP = p; }
  if (!lo || !hiP) { console.log(`  ${f.label.padEnd(26)}| ${'구간 밖'.padStart(15)} |`); continue; }
  const w = (TARGET - lo.mdd) / (hiP.mdd - lo.mdd);
  const pct = lo.pct + w * (hiP.pct - lo.pct);
  const total = lo.total + w * (hiP.total - lo.total);
  matched.push([f.label, pct, total, f.make(pct)]);
  console.log(`  ${f.label.padEnd(26)}| ${((pct * 100).toFixed(1) + '%').padStart(15)} | ${(total.toFixed(0) + '%').padStart(11)} |`);
}
const baseTotal = matched.find((m) => m[0].startsWith('cash'))?.[2] ?? 1;
console.log('\n  → MDD 를 동일하게 맞췄을 때 현행 대비 순수 개선분:');
for (const [label, , total] of matched) console.log(`    ${label.padEnd(26)} ${((total / baseTotal - 1) * 100).toFixed(0).padStart(5)}%`);

console.log('\n◆ D 동일 MDD 지점에서 다시 기간분할 — 위험을 맞춰도 전구간 우세인가');
console.log(head);
console.log('  ' + '-'.repeat(head.length - 2));
const mBase = matched.find((m) => m[0].startsWith('cash'))!;
const mVals = new Map<string, number[]>();
for (const [label, , , c] of matched) {
  const cells: string[] = []; const vals: number[] = [];
  for (const [, f, t] of PERIODS) { const r = run(c, f, t); vals.push(r.total); cells.push(`${r.total.toFixed(0)}% / ${r.mdd.toFixed(0)}%`.padStart(14)); }
  mVals.set(label, vals);
  console.log(`  ${label.padEnd(26)}|` + cells.map((s) => ` ${s} |`).join(''));
}
const bv = mVals.get(mBase[0])!;
console.log('\n  현행(동일MDD) 대비 승패:');
for (const [label] of matched.filter((m) => m !== mBase)) {
  const v = mVals.get(label)!;
  const w = v.filter((x, i) => x > bv[i]).length;
  console.log(`    ${label.padEnd(26)} ${w}/${PERIODS.length} 구간 우세` + (w === PERIODS.length ? '   ✔ 전구간' : ''));
}
