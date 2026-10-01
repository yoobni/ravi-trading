/**
 * 급등 전략 종합 백테스트 — 여러 변형을 한 번에.
 *
 * 지금까지 급등은 "신호 파라미터(문턱·volZ)"만 훑었고, 청산·배분은 F6_v5 값으로 고정해뒀다
 * (신호 효과만 분리하려고). 이제 그 축들도 같이 열어 조합을 본다.
 *
 * 축:
 *   신호   F6 단독 / 급등 단독 / F6+급등        (급등은 F6 와 겹치지 않는 것만 더한다)
 *   문턱   +5 ~ +9% · volZ 0.5 ~ 2.0
 *   청산   트레일 A2(기준) · 트레일 A4 · TP+5/SL−2 · TP+10/SL−3
 *   배분   33%×3(기준) · 50%×2 · 25%×4
 *   증액   코인당 1트란치(기준) · 2트란치 (F6_v8 규칙)
 *
 * 판정은 전부 동일 MDD 17% 이분탐색 후 비교. 상위 후보는 기간 4분할까지 본다.
 * ⚠ MDD 는 4h 경계 기준이다. 매시간 평가하면 더 깊게 잡히고 포지션이 1/3 로 줄어든다
 *   (_bt_surge_watch 참조) — 실거래 사이징은 그쪽을 봐야 한다.
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
let MKTS = [...ALL.keys()];
const MKTS0 = [...MKTS];
function orderBy(k: 'cap' | 'rev' | 'alpha' | 's1' | 's2') {
  if (k === 'cap') MKTS = [...MKTS0];
  else if (k === 'rev') MKTS = [...MKTS0].reverse();
  else if (k === 'alpha') MKTS = [...MKTS0].sort();
  else { const q = k === 's1' ? 7 : 13; MKTS = [...MKTS0].map((m, i) => [m, (i * q) % MKTS0.length] as [string, number]).sort((a, b) => a[1] - b[1]).map(([m]) => m); }
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
const sigSurge = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && volZ(b, i) >= vz;

type Signal = 'F6' | 'SURGE' | 'BOTH';
type Exit = 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A8' | 'TP5' | 'TP10';
interface Cfg {
  signal: Signal; pct: number; vz: number; exit: Exit;
  maxCon: number; maxPerCoin: number;
}
const EXITS: Record<Exit, { sl: number; act?: number; gap?: number; tp?: number; maxb: number; label: string }> = {
  A2: { sl: -2, act: 2, gap: 2, maxb: 84, label: '트레일 A2' },
  A3: { sl: -2, act: 3, gap: 2, maxb: 84, label: '트레일 A3' },
  A4: { sl: -2, act: 4, gap: 2, maxb: 84, label: '트레일 A4' },
  A5: { sl: -2, act: 5, gap: 2, maxb: 84, label: '트레일 A5' },
  A6: { sl: -2, act: 6, gap: 2, maxb: 84, label: '트레일 A6' },
  A8: { sl: -2, act: 8, gap: 2, maxb: 84, label: '트레일 A8' },
  TP5: { sl: -2, tp: 5, maxb: 84, label: 'TP+5/SL−2' },
  TP10: { sl: -3, tp: 10, maxb: 84, label: 'TP+10/SL−3' },
};
interface Pos { m: string; ep: number; vol: number; used: number; ei: number; peak: number; sl: number; armed: boolean; last: number; src: string }

function run(c: Cfg, size: number, from: number, to?: number) {
  const E = EXITS[c.exit];
  let cash = INIT;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const bySrc = new Map<string, { n: number; s: number; w: number }>();
  const t0 = Math.max(TS.findIndex((t) => t >= from), 200);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = ALL.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      else if (E.tp !== undefined && bar.high >= pos.ep * (1 + E.tp / 100)) { px = pos.ep * (1 + E.tp / 100); done = true; }
      else if (E.act !== undefined) {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + E.act / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - E.gap! / 100));
      }
      if (!done && (i - pos.ei) >= E.maxb) { px = bar.close; done = true; }
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
    if (open.length < c.maxCon && t < t1 - 20) {
      for (const m of MKTS) {
        if (open.length >= c.maxCon) break;
        if (open.filter((p) => p.m === m).length >= c.maxPerCoin) continue;
        const b = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i + 1 >= b.length) continue;
        const f6 = sigF6(b, i), sg = sigSurge(b, i, c.pct, c.vz);
        let hit = false, src = '';
        if (c.signal === 'F6') { hit = f6; src = 'F6'; }
        else if (c.signal === 'SURGE') { hit = sg; src = 'SURGE'; }
        else { hit = f6 || (sg && !f6); src = f6 ? 'F6' : 'SURGE'; }
        if (!hit) continue;
        const use = Math.min(cash, eqNow * size);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, sl: ep * (1 + E.sl / 100), armed: false, last: ep, src });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) p.last = ALL.get(p.m)![i].close; eq += p.vol * p.last; }
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.last;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, bySrc };
}
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(c: Cfg, target: number, from: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (run(c, mid, from).mdd > target) hi = mid; else lo = mid; }
  const size = (lo + hi) / 2;
  return { size, res: run(c, size, from) };
}
const FROM = TS[200], TARGET = 17.0;
const PER: Array<[string, number, number | undefined]> = [
  ['2022H2~2023', FROM, D('2024-01-01')],
  ['2024', D('2024-01-01'), D('2025-01-01')],
  ['2025', D('2025-01-01'), D('2026-01-01')],
  ['2026 YTD', D('2026-01-01'), undefined],
];

const VARIANTS: Array<[string, Cfg]> = [];
const add = (label: string, c: Partial<Cfg>) =>
  VARIANTS.push([label, { signal: 'BOTH', pct: 7, vz: 1.0, exit: 'A2', maxCon: 3, maxPerCoin: 1, ...c } as Cfg]);

add('① F6 단독 (현행 v5)', { signal: 'F6' });
add('② 급등 단독 +7% z1', { signal: 'SURGE' });
add('③ 급등 단독 +5% z1.5', { signal: 'SURGE', pct: 5, vz: 1.5 });
add('④ 결합 +6% z1', { pct: 6 });
add('⑤ 결합 +7% z1  ★기준', {});
add('⑥ 결합 +8% z1', { pct: 8 });
add('⑦ 결합 +7% z0.5', { vz: 0.5 });
add('⑧ 결합 +7% z1.5', { vz: 1.5 });
add('⑨ 결합 +7% z2', { vz: 2.0 });
add('⑩ 결합 · 트레일 A4', { exit: 'A4' });
add('⑪ 결합 · TP+5/SL−2', { exit: 'TP5' });
add('⑫ 결합 · TP+10/SL−3', { exit: 'TP10' });
add('⑬ 결합 · 50%×2 집중', { maxCon: 2 });
add('⑭ 결합 · 25%×4 분산', { maxCon: 4 });
add('⑮ 결합 · 증액 허용(코인당2)', { maxPerCoin: 2 });
add('⑯ 결합 · 집중+증액', { maxCon: 2, maxPerCoin: 2 });
add('⑰ 결합 +6% z1.5 · 증액', { pct: 6, vz: 1.5, maxPerCoin: 2 });
// ── A4 가 급등 덕인지 그냥 A4 가 좋은 건지 가르는 대조군
add('⑱ F6 단독 · 트레일 A4', { signal: 'F6', exit: 'A4' });
add('⑲ 급등 단독 · 트레일 A4', { signal: 'SURGE', exit: 'A4' });
add('⑳ 결합 · A4 + 증액', { exit: 'A4', maxPerCoin: 2 });

console.log(`=== 급등 전략 종합 백테스트 (${MKTS.length}코인 4h, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===`);
console.log(`  동일 MDD ${TARGET}% 고정 후 비교. 급등은 F6 와 겹치지 않는 것만 추가.\n`);
console.log('  구성                         | 그때size |    총익 | ①대비 | 거래 |    WR |    PF | F6건 | 급등건 | 급등평균');
console.log('  ' + '-'.repeat(118));
const results: Array<{ label: string; cfg: Cfg; size: number; res: ReturnType<typeof run> }> = [];
for (const [label, cfg] of VARIANTS) {
  const m = matchMdd(cfg, TARGET, FROM);
  results.push({ label, cfg, size: m.size, res: m.res });
  const f6c = m.res.bySrc.get('F6') ?? { n: 0, s: 0, w: 0 };
  const sgc = m.res.bySrc.get('SURGE') ?? { n: 0, s: 0, w: 0 };
  const base = results[0].res.total;
  console.log(`  ${label.padEnd(29)}| ${((m.size * 100).toFixed(1) + '%').padStart(8)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / base - 1) * 100).toFixed(0) + '%').padStart(5)} | ${String(m.res.n).padStart(4)} | ${m.res.wr.toFixed(1).padStart(4)}% | ${m.res.pf.toFixed(2).padStart(5)} | ${String(f6c.n).padStart(4)} | ${String(sgc.n).padStart(6)} | ${(sgc.n ? (sgc.s / sgc.n * 100).toFixed(2) + '%' : '-').padStart(8)}`);
}

const base = results[0].res.total;
const top = [...results].sort((a, b) => b.res.total - a.res.total).slice(0, 6);
console.log('\n◆ 상위 6개 기간분할 (동일 MDD 지점 size 고정)');
console.log('  구성                         |' + PER.map((p) => ` ${p[0].padStart(13)} |`).join('') + ' 우세');
const ctrl = results[0];
const ctrlVals = PER.map(([, f, t]) => run(ctrl.cfg, ctrl.size, f, t).total);
console.log(`  ${ctrl.label.padEnd(29)}|` + ctrlVals.map((v, i) => ` ${`${v.toFixed(0)}%`.padStart(13)} |`).join('') + '   —');
for (const r of top) {
  if (r.label === ctrl.label) continue;
  const vv = PER.map(([, f, t]) => run(r.cfg, r.size, f, t).total);
  const win = vv.filter((v, i) => v > ctrlVals[i]).length;
  console.log(`  ${r.label.padEnd(29)}|` + vv.map((v) => ` ${`${v.toFixed(0)}%`.padStart(13)} |`).join('') + ` ${win}/4`);
}
console.log('\n◆ 순위 (총익, 동일 MDD)');
[...results].sort((a, b) => b.res.total - a.res.total).forEach((r, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${r.label.padEnd(29)} ${(r.res.total.toFixed(0) + '%').padStart(7)}  (①대비 ${((r.res.total / base - 1) * 100).toFixed(0)}%)`);
});


console.log('\n\n◆ 트레일 개시(ACT) 기울기 — 고원인가 스파이크인가 (동일 MDD 17%)');
console.log('  ACT |  F6 단독 | 급등 단독 |    결합 | 결합+증액');
for (const ex of ['A2', 'A3', 'A4', 'A5', 'A6', 'A8'] as Exit[]) {
  const a = matchMdd({ signal: 'F6', pct: 7, vz: 1, exit: ex, maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const b = matchMdd({ signal: 'SURGE', pct: 7, vz: 1, exit: ex, maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const c = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: ex, maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const d = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: ex, maxCon: 3, maxPerCoin: 2 }, TARGET, FROM).res.total;
  console.log(`  ${ex.padStart(3)} | ${(a.toFixed(0) + '%').padStart(8)} | ${(b.toFixed(0) + '%').padStart(9)} | ${(c.toFixed(0) + '%').padStart(7)} | ${(d.toFixed(0) + '%').padStart(9)}`);
}

console.log('\n◆ 코인 순서 민감도 — 슬롯 경쟁 우선순위를 바꿔도 유지되는가');
console.log('  순서        | F6 단독 | 결합 A2 | 결합A2+증액 | 결합 A4 | 결합 A4+증액');
for (const k of ['cap', 'rev', 'alpha', 's1', 's2'] as const) {
  orderBy(k);
  const f = matchMdd({ signal: 'F6', pct: 7, vz: 1, exit: 'A2', maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const a2 = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: 'A2', maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const a4 = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: 'A4', maxCon: 3, maxPerCoin: 1 }, TARGET, FROM).res.total;
  const a4p = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: 'A4', maxCon: 3, maxPerCoin: 2 }, TARGET, FROM).res.total;
  const a2p = matchMdd({ signal: 'BOTH', pct: 7, vz: 1, exit: 'A2', maxCon: 3, maxPerCoin: 2 }, TARGET, FROM).res.total;
  const lbl = { cap: '시총순(현행)', rev: '역순', alpha: '알파벳', s1: '셔플A', s2: '셔플B' }[k];
  console.log(`  ${lbl.padEnd(12)}| ${(f.toFixed(0) + '%').padStart(7)} | ${(a2.toFixed(0) + '%').padStart(7)} | ${(a2p.toFixed(0) + '%').padStart(11)} | ${(a4.toFixed(0) + '%').padStart(7)} | ${(a4p.toFixed(0) + '%').padStart(12)}`);
}
orderBy('cap');
