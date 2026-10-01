/**
 * H4/H5 — 구조 레버를 "체결손실 0 설계" 위에서 다시 본다 (2026-10-01)
 *
 * 이 프로젝트에서 살아남은 개선은 전부 구조였다: 집중 배분(50%×2), 같은 코인 증액.
 * 그런데 **그 측정도 "스톱 가격에 체결" 가정 위에 있었다.** 청산 설계가 바뀌면 결론도 바뀔 수 있다.
 *
 * 베이스 설계 = TP단일 +7% · 3일 시간청산 · 스톱 없음 (체결격차 0)
 * 레버 4개:
 *   ① 슬롯 수 / 비중      — 집중(50%×2) vs 분산(20%×5)
 *   ② 같은 코인 증액       — 코인당 최대 2트란치 (v8 규칙)
 *   ③ 유동성 가중 사이징   — 거래대금 분위로 비중 차등 (체결비용 대리변수)
 *   ④ 자본 가동률 측정     — 병목이 남아 있는가
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) RAW.set(m, b); }
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
/** 유동성 등급: 전 기간 평균 거래대금 분위 (1=최상위) */
const LIQ = new Map<string, number>();
{
  const avg = [...RAW].map(([m, b]) => [m, b.reduce((a, x) => a + x.volume * x.close, 0) / b.length] as [string, number]);
  avg.sort((a, b) => b[1] - a[1]);
  avg.forEach(([m], i) => LIQ.set(m, Math.floor(i / Math.ceil(avg.length / 5)) + 1));
}
const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;

const TP = 7, MAXB = 18;      // 베이스 설계
/** 지정가 체결 보수성: 고가가 목표가를 EPS 만큼 **관통**해야 체결로 본다.
 *  0 이면 '닿으면 체결'(낙관), 0.002 면 0.2% 더 올라야 체결(보수). 스톱 문제의 거울상 점검. */
let EPS = 0;
interface Pos { m: string; ep: number; vol: number; used: number; bars: number; last: number }
interface Cfg { maxCon: number; addOn?: boolean; liqW?: boolean }

function run(c: Cfg, size: number, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, deployedTicks = 0, ticks = 0, sumExp = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      const target = q.ep * (1 + TP / 100);
      let px: number | null = null;
      if (bar.high >= target * (1 + EPS)) px = target;            // 지정가 체결 (슬리피지 0)
      else if (q.bars >= MAXB) px = bar.close * (1 - SLIP);       // 시간청산 (시장가)
      if (px != null) {
        const got = q.vol * px * (1 - FEE);
        cash += got; n++; sumR += got / q.used - 1;
        open.splice(p, 1);
      }
    }
    if (open.length < c.maxCon) {
      for (const m of RAW.keys()) {
        if (open.length >= c.maxCon) break;
        const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        if (!sig(bb, i - 1)) continue;
        const held = open.filter(q => q.m === m).length;
        if (held >= (c.addOn ? 2 : 1)) continue;                   // 증액: 코인당 최대 2트란치
        const ep = bb[i].open * (1 + SLIP);
        const w = c.liqW ? [1.5, 1.2, 1.0, 0.7, 0.4][LIQ.get(m)! - 1] : 1;
        const used = Math.min(cash, cash * size * w);
        if (used < 5000) continue;
        cash -= used;
        open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: ep });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    ticks++; if (open.length > 0) deployedTicks++;
    sumExp += (eq - cash) / Math.max(eq, 1);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0,
           dep: 100 * deployedTicks / ticks, exp: 100 * sumExp / ticks };
}
function sizeFor(c: Cfg, target: number) {
  let lo = 0.02, hi = 0.98;
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(c, mid).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
let T = 17;
const show = (lab: string, c: Cfg) => {
  const s = sizeFor(c, T); const r = run(c, s);
  console.log(`${lab.padEnd(28)} ${(r.ret.toFixed(0) + '%').padStart(7)} ${(r.mdd.toFixed(1) + '%').padStart(6)} ${((s * 100).toFixed(1) + '%').padStart(7)} ${String(r.n).padStart(6)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)} ${(r.dep.toFixed(0) + '%').padStart(8)} ${(r.exp.toFixed(1) + '%').padStart(8)}`);
  return r;
};
console.log(`베이스 = TP+${TP}% · ${MAXB / 6}일 · 스톱없음 · 동일 MDD ${T}%\n`);
console.log('구성                             총익    MDD    size  거래수   거래당   보유시간  평균투입');
console.log('① 슬롯 수 / 집중도');
for (const mc of [1, 2, 3, 4, 5, 6]) show(`  ${mc}슬롯`, { maxCon: mc });
console.log('\n② 같은 코인 증액 (코인당 2트란치)');
show('  3슬롯 + 증액', { maxCon: 3, addOn: true });
show('  2슬롯 + 증액', { maxCon: 2, addOn: true });
console.log('\n③ 유동성 가중 사이징 (상위 1.5x ~ 하위 0.4x)');
show('  3슬롯 + 유동성가중', { maxCon: 3, liqW: true });
show('  2슬롯 + 유동성가중', { maxCon: 2, liqW: true });

console.log('\n④ 지정가 체결 보수성 — 고가가 목표가를 얼마나 관통해야 체결로 볼 것인가');
console.log('  (스톱 문제의 거울상: "닿으면 체결"이 낙관적일 수 있다)');
for (const e of [0, 0.001, 0.002, 0.005, 0.01]) {
  EPS = e;
  const r = show(`  관통 ${(e * 100).toFixed(1)}% 요구`, { maxCon: 3 });
}
EPS = 0;

console.log('\n⑤ 위험대별 비교 — MDD 17% 는 인위적 제약이다. BTC 는 원래 MDD 51% 를 감당하며 +150% 였다.');
console.log('  MDD목표   후보(TP+7%/3일, 3슬롯)   후보(1슬롯)        BTC 축소보유');
{
  const b = RAW.get('KRW-BTC')!;
  const btc = (f: number) => {
    let peak = -1, mdd = 0; const p0 = b[0].open;
    for (const x of b) { const lo = 1 + f * (x.low / p0 - 1), hi = 1 + f * (x.high / p0 - 1); peak = Math.max(peak, hi); mdd = Math.max(mdd, (peak - lo) / peak); }
    return { ret: 100 * f * (b[b.length - 1].close / p0 - 1), mdd: 100 * mdd };
  };
  for (const target of [17, 25, 35, 51]) {
    T = target;
    const s3 = sizeFor({ maxCon: 3 }, target), r3 = run({ maxCon: 3 }, s3);
    const s1 = sizeFor({ maxCon: 1 }, target), r1 = run({ maxCon: 1 }, s1);
    let lo = 0.01, hi = 1.0;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (btc(mid).mdd > target) hi = mid; else lo = mid; }
    const rb = btc((lo + hi) / 2);
    console.log(`  ${(target + '%').padStart(6)}   ${(r3.ret.toFixed(0) + '%').padStart(10)} (투입 ${r3.exp.toFixed(0)}%)   ${(r1.ret.toFixed(0) + '%').padStart(8)}   ${(rb.ret.toFixed(0) + '%').padStart(10)} (BTC ${((lo+hi)/2*100).toFixed(0)}%)`);
  }
  T = 17;
}

console.log('\n⑥ 최근 2년만 (OOS: 2024-08~2026-08) — "요즘도 되는가"');
{
  const A = Date.UTC(2024, 7, 1), B = Infinity;
  const b = RAW.get('KRW-BTC')!.filter(x => x.ts >= A);
  const btc = (f: number) => {
    let peak = -1, mdd = 0; const p0 = b[0].open;
    for (const x of b) { const lo = 1 + f * (x.low / p0 - 1), hi = 1 + f * (x.high / p0 - 1); peak = Math.max(peak, hi); mdd = Math.max(mdd, (peak - lo) / peak); }
    return { ret: 100 * f * (b[b.length - 1].close / p0 - 1), mdd: 100 * mdd };
  };
  const sizeForP = (c: Cfg, target: number) => { let lo = 0.02, hi = 0.98; for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(c, mid, A, B).mdd > target) hi = mid; else lo = mid; } return (lo + hi) / 2; };
  console.log('  MDD목표   후보 3슬롯   후보 2슬롯   BTC 축소보유');
  for (const target of [17, 25, 35]) {
    const r3 = run({ maxCon: 3 }, sizeForP({ maxCon: 3 }, target), A, B);
    const r2 = run({ maxCon: 2 }, sizeForP({ maxCon: 2 }, target), A, B);
    let lo = 0.01, hi = 1.0;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (btc(mid).mdd > target) hi = mid; else lo = mid; }
    const rb = btc((lo + hi) / 2);
    console.log(`  ${(target+'%').padStart(6)}   ${(r3.ret.toFixed(0)+'%').padStart(9)}   ${(r2.ret.toFixed(0)+'%').padStart(9)}   ${(rb.ret.toFixed(0)+'%').padStart(9)}`);
  }
  console.log(`  (참고) 같은 기간 BTC 전액보유 = ${btc(1).ret.toFixed(0)}% · MDD ${btc(1).mdd.toFixed(0)}%`);
}

console.log('\n⑦ 하네스 정합성 — 같은 설계·같은 구간을 _bt_execfree 와 맞춰본다');
{
  const sizeForP = (c: Cfg, target: number, a: number, b: number) => { let lo = 0.02, hi = 0.98; for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(c, mid, a, b).mdd > target) hi = mid; else lo = mid; } return (lo + hi) / 2; };
  const W: Array<[string, number, number]> = [
    ['2022H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)],
    ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)],
    ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
    ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)],
    ['2024-08~2026-08 (OOS)', Date.UTC(2024,7,1), Infinity],
    ['전체', 0, Infinity]];
  console.log('  구간                      총익   MDD   size  거래수  평균투입');
  for (const [lab, a, b] of W) {
    const sz = sizeForP({ maxCon: 3 }, 17, a, b); const r = run({ maxCon: 3 }, sz, a, b);
    console.log(`  ${lab.padEnd(24)} ${(r.ret.toFixed(0)+'%').padStart(6)} ${(r.mdd.toFixed(1)+'%').padStart(6)} ${((sz*100).toFixed(1)+'%').padStart(6)} ${String(r.n).padStart(6)} ${(r.exp.toFixed(1)+'%').padStart(8)}`);
  }
}
