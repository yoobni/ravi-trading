/**
 * 축 ⑥ 자본 가동률 · 유니버스 확장 (2026-10-02)
 * F7 청산(TP+6 지정가 · 3일 · 무스톱), 진입 = 신호 다음 4h 봉 시가(슬리피지), 현실 체결.
 * 1) 28코인 vs 118코인 vs 유동성 상위N (직전 30일 거래대금, 매 시점 계산)
 * 2) 슬롯 3/5/8/12 × 동일 MDD 17%
 * 3) 유휴 현금을 BTC 로 보유
 * 4) 동시 신호 우선순위 (volZ / 돌파폭 / 유동성 / 무작위)
 * 사용: npx tsx scripts/_bt_capacity.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const C28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const TP = 6, MAXB = 18;
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }

function loadSet(kind: '118' | '28L'): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  const files = fs.readdirSync(DIR);
  if (kind === '118') {
    const ms = files.filter(f => f.endsWith('_240m_2024-08-01_2025-08-01.json')).map(f => f.split('_')[0]);
    for (const m of ms) {
      const b2 = `${m}_240m_2025-08-01_2026-08-24.json`;
      if (!files.includes(b2)) continue;
      const a = JSON.parse(fs.readFileSync(path.join(DIR, `${m}_240m_2024-08-01_2025-08-01.json`), 'utf8')) as Bar[];
      const b = JSON.parse(fs.readFileSync(path.join(DIR, b2), 'utf8')) as Bar[];
      const seen = new Set<number>(); const all = [...a, ...b].filter(x => seen.has(x.ts) ? false : (seen.add(x.ts), true)).sort((x, y) => x.ts - y.ts);
      if (all.length > 300) out.set(m, all);
    }
  } else {
    for (const m of C28) {
      const f = files.filter(x => x.startsWith(`${m}_240m_2022-06-10_`));
      let best: Bar[] | null = null;
      for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
      if (best) out.set(m, best.slice().sort((a, b) => a.ts - b.ts));
    }
  }
  return out;
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

interface Data { RAW: Map<string, Bar[]>; IDX: Map<string, Map<number, number>>; TS: number[]; LIQ: Map<string, number[]>; SIG: Map<string, Uint8Array> }
function prep(RAW: Map<string, Bar[]>): Data {
  const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
  const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
  // 직전 30일(180봉) 거래대금 — 인덱스 i 의 값은 봉 0..i-1 까지(미래참조 없음)
  const LIQ = new Map<string, number[]>(); const SIG = new Map<string, Uint8Array>();
  for (const [m, b] of RAW) {
    const l = new Array(b.length).fill(0); let s = 0;
    for (let i = 0; i < b.length; i++) { l[i] = s; s += b[i].volume * b[i].close; if (i >= 180) s -= b[i - 180].volume * b[i - 180].close; }
    LIQ.set(m, l);
    const sg = new Uint8Array(b.length); for (let i = 45; i < b.length; i++) if (sigF6(b, i)) sg[i] = 1;
    SIG.set(m, sg);
  }
  return { RAW, IDX, TS, LIQ, SIG };
}

interface Opt {
  slots: number; size: number; from?: number; to?: number;
  universe?: (m: string, ts: number, liqRank: Map<string, number>) => boolean;
  topN?: number;                          // 유동성 상위 N 만
  prio?: 'order' | 'volz' | 'brk' | 'liq' | 'rand'; seed?: number;
  idleBtc?: boolean;
}
interface Pos { m: string; ep: number; vol: number; used: number; bars: number; last: number }

function run(D: Data, o: Opt) {
  const { RAW, IDX, TS, LIQ, SIG } = D;
  const from = o.from ?? 0, to = o.to ?? Infinity;
  let cash = INIT; let btcU = 0;            // idleBtc: 유휴 현금은 BTC 수량으로 보관
  const btc = RAW.get('KRW-BTC')!, bI = IDX.get('KRW-BTC')!;
  let btcPx = 0;
  const open: Pos[] = [];
  let peak = INIT, mdd = 0, n = 0, sumR = 0, invSum = 0, bars = 0, sigTot = 0, sigBusy = 0, multi = 0, tsWithSig = 0;
  let seed = o.seed ?? 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ORDER = [...RAW.keys()];
  let started = false;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    const bi = bI.get(ts); if (bi !== undefined) btcPx = btc[bi].close;
    if (!started) { started = true; if (o.idleBtc && btcPx) { btcU = cash * (1 - FEE) / (btcPx * (1 + SLIP)); cash = 0; } }
    // 청산
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let px = 0;
      if (bar.high >= q.ep * (1 + TP / 100)) px = q.ep * (1 + TP / 100);
      else if (q.bars >= MAXB) px = bar.close * (1 - SLIP);
      if (px) {
        const got = q.vol * px * (1 - FEE); n++; sumR += got / q.used - 1; open.splice(p, 1);
        if (o.idleBtc && btcPx) btcU += got * (1 - FEE) / (btcPx * (1 + SLIP)); else cash += got;
      }
    }
    // 유동성 순위 (topN / liq 우선순위용)
    let liqRank: Map<string, number> | null = null;
    if (o.topN || o.prio === 'liq') {
      const arr: Array<[string, number]> = [];
      for (const [m, b] of RAW) { const i = IDX.get(m)!.get(ts); if (i !== undefined && i >= 180) arr.push([m, LIQ.get(m)![i]]); }
      arr.sort((a, b) => b[1] - a[1]); liqRank = new Map(arr.map(([m], k) => [m, k]));
    }
    // 신호 후보
    const cands: Array<{ m: string; i: number; key: number }> = [];
    for (const m of ORDER) {
      const i = IDX.get(m)!.get(ts);
      if (i === undefined || i < 46 || !SIG.get(m)![i - 1]) continue;
      if (o.topN) { const r = liqRank!.get(m); if (r === undefined || r >= o.topN) continue; }
      const b = RAW.get(m)!;
      let key = 0;
      if (o.prio === 'volz') key = volZ(b, i - 1);
      else if (o.prio === 'brk') key = b[i - 1].close / hiOf(b, i - 43, i - 2) - 1;
      else if (o.prio === 'liq') key = -(liqRank!.get(m) ?? 999);
      else if (o.prio === 'rand') key = rnd();
      cands.push({ m, i, key });
    }
    if (cands.length) { tsWithSig++; if (cands.length > 1) multi++; }
    sigTot += cands.length;
    if (o.prio && o.prio !== 'order') cands.sort((a, b) => b.key - a.key);
    for (const c of cands) {
      if (open.length >= o.slots) { sigBusy++; continue; }
      if (open.some(q => q.m === c.m)) continue;
      const b = RAW.get(c.m)!;
      const avail = o.idleBtc ? btcU * btcPx : cash;
      const used = avail * o.size; if (used < 5000) continue;
      if (o.idleBtc) { btcU -= used / btcPx; const net = used * (1 - SLIP) * (1 - FEE); const ep = b[c.i].open * (1 + SLIP); open.push({ m: c.m, ep, vol: net * (1 - FEE) / ep, used: net, bars: 0, last: b[c.i].close }); }
      else { cash -= used; const ep = b[c.i].open * (1 + SLIP); open.push({ m: c.m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: b[c.i].close }); }
    }
    const posV = open.reduce((a, q) => a + q.vol * q.last, 0);
    const eq = cash + btcU * btcPx + posV;
    invSum += eq > 0 ? posV / eq : 0; bars++;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = cash + btcU * btcPx + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, util: 100 * invSum / Math.max(bars, 1),
    sigs: sigTot, skipped: sigBusy, multiFrac: tsWithSig ? 100 * multi / tsWithSig : 0 };
}
function sizeFor(D: Data, o: Opt, target = 17) {
  let lo = 0.01, hi = 0.99;
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(D, { ...o, size: mid }).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

const U = (y: number, mo: number, d = 1) => Date.UTC(y, mo, d);
const SP_A: Array<[string, number, number]> = [['24-08~12', U(2024, 7), U(2024, 11, 31)], ['2025', U(2025, 0), U(2025, 11, 31)], ['2026YTD', U(2026, 0), U(2026, 11, 31)]];
const SP_L: Array<[string, number, number]> = [['22H2~23', U(2022, 6), U(2023, 11, 31)], ['2024', U(2024, 0), U(2024, 11, 31)], ['2025', U(2025, 0), U(2025, 11, 31)], ['2026YTD', U(2026, 0), U(2026, 11, 31)]];
const pc = (x: number) => (x.toFixed(0) + '%');
const hdr = (sp: Array<[string, number, number]>) => 'name'.padEnd(30) + '총익'.padStart(7) + 'MDD'.padStart(6) + '거래'.padStart(6) + '거래당'.padStart(8) + '가동률'.padStart(7) + '  |' + sp.map(s => s[0].padStart(9)).join('');
function row(D: Data, lab: string, o: Opt, sp: Array<[string, number, number]>, from = 0) {
  const r = run(D, { ...o, from });
  const per = sp.map(([, a, b]) => pc(run(D, { ...o, from: Math.max(a, from), to: b }).ret).padStart(9)).join('');
  console.log(`${lab.padEnd(30)}${pc(r.ret).padStart(7)}${(r.mdd.toFixed(1) + '%').padStart(6)}${String(r.n).padStart(6)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)}${(r.util.toFixed(0) + '%').padStart(7)}  |${per}`);
  return r;
}
function eqRow(D: Data, lab: string, o: Omit<Opt, 'size'>, sp: Array<[string, number, number]>, from = 0) {
  const s = sizeFor(D, { ...o, size: 0.3, from } as Opt);
  return row(D, `${lab} [s=${(s * 100).toFixed(0)}%]`, { ...o, size: s } as Opt, sp, from);
}

const D118 = prep(loadSet('118'));
const D28L = prep(loadSet('28L'));
// 28코인 부분집합 (118 캐시와 같은 기간)
const sub = new Map([...D118.RAW].filter(([m]) => C28.includes(m)));
const D28S = prep(sub);
const FROM_A = U(2024, 7, 1) + 31 * 86400e3;   // 118 캐시 앞 30일은 유동성 워밍업
console.log(`118 캐시: ${D118.RAW.size}코인, 28코인 부분집합 ${D28S.RAW.size}코인, 28코인 4년 ${D28L.RAW.size}코인`);
console.log(`기간 A: ${new Date(FROM_A).toISOString().slice(0, 10)} ~ ${new Date(D118.TS[D118.TS.length - 1]).toISOString().slice(0, 10)}`);

console.log('\n══ ① 유니버스 (3슬롯) ══');
console.log('-- 33%×3 고정 --'); console.log(hdr(SP_A));
const u1 = row(D28S, '28코인', { slots: 3, size: 0.33 }, SP_A, FROM_A);
const u2 = row(D118, `전체 ${D118.RAW.size}코인`, { slots: 3, size: 0.33 }, SP_A, FROM_A);
const u3 = row(D118, '유동성 상위 28', { slots: 3, size: 0.33, topN: 28 }, SP_A, FROM_A);
const u4 = row(D118, '유동성 상위 50', { slots: 3, size: 0.33, topN: 50 }, SP_A, FROM_A);
for (const [lab, r] of [['28코인', u1], ['전체', u2], ['상위28', u3], ['상위50', u4]] as const)
  console.log(`   ${lab.padEnd(8)} 신호 ${r.sigs} · 슬롯부족으로 놓친 신호 ${r.skipped} (${(100 * r.skipped / Math.max(r.sigs, 1)).toFixed(0)}%) · 신호 있는 봉 중 동시 2개+ ${r.multiFrac.toFixed(0)}%`);
console.log('-- 동일 MDD 17% --'); console.log(hdr(SP_A));
eqRow(D28S, '28코인', { slots: 3 }, SP_A, FROM_A);
eqRow(D118, `전체 ${D118.RAW.size}코인`, { slots: 3 }, SP_A, FROM_A);
eqRow(D118, '유동성 상위 28', { slots: 3, topN: 28 }, SP_A, FROM_A);
eqRow(D118, '유동성 상위 50', { slots: 3, topN: 50 }, SP_A, FROM_A);

console.log('\n══ ② 슬롯 수 ══');
for (const [lab, D, from, sp] of [['28코인 4년', D28L, 0, SP_L], [`전체 ${D118.RAW.size}코인 2년`, D118, FROM_A, SP_A]] as Array<[string, Data, number, Array<[string, number, number]>]>) {
  console.log(`-- ${lab}: 고정 1/K 사이징 --`); console.log(hdr(sp));
  for (const K of [3, 5, 8, 12]) row(D, `${K}슬롯 × ${(100 / K).toFixed(0)}%`, { slots: K, size: K === 3 ? 0.33 : 1 / K }, sp, from);
  console.log(`-- ${lab}: 동일 MDD 17% --`); console.log(hdr(sp));
  for (const K of [3, 5, 8, 12]) eqRow(D, `${K}슬롯`, { slots: K }, sp, from);
}

console.log('\n══ ③ 유휴 현금 BTC 보유 (3슬롯) ══');
for (const [lab, D, from, sp] of [['28코인 4년', D28L, 0, SP_L], [`전체 ${D118.RAW.size}코인 2년`, D118, FROM_A, SP_A]] as Array<[string, Data, number, Array<[string, number, number]>]>) {
  console.log(`-- ${lab} --`); console.log(hdr(sp));
  row(D, '현금 33%×3', { slots: 3, size: 0.33 }, sp, from);
  row(D, 'BTC 33%×3', { slots: 3, size: 0.33, idleBtc: true }, sp, from);
  eqRow(D, '현금 MDD17', { slots: 3 }, sp, from);
  eqRow(D, 'BTC MDD17', { slots: 3, idleBtc: true }, sp, from);
}

console.log('\n══ ④ 동시 신호 우선순위 (3슬롯, 33%×3) ══');
for (const [lab, D, from, sp] of [['28코인 4년', D28L, 0, SP_L], [`전체 ${D118.RAW.size}코인 2년`, D118, FROM_A, SP_A]] as Array<[string, Data, number, Array<[string, number, number]>]>) {
  console.log(`-- ${lab} --`); console.log(hdr(sp));
  const res: Record<string, number> = {};
  for (const p of ['order', 'volz', 'brk', 'liq'] as const) res[p] = row(D, `우선=${p}`, { slots: 3, size: 0.33, prio: p }, sp, from).ret;
  const rr: number[] = [];
  for (let s = 1; s <= 20; s++) rr.push(run(D, { slots: 3, size: 0.33, prio: 'rand', seed: s * 7919 + 3, from }).ret);
  rr.sort((a, b) => a - b);
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  console.log(`   무작위 20회: 평균 ${pc(mean)} · 중앙 ${pc(rr[10])} · 5%~95% ${pc(rr[1])}~${pc(rr[18])} · 최소 ${pc(rr[0])} 최대 ${pc(rr[19])}`);
  for (const p of ['order', 'volz', 'brk', 'liq']) console.log(`   ${p.padEnd(6)} 무작위 분포 내 백분위 ${(100 * rr.filter(x => x < res[p]).length / rr.length).toFixed(0)}%`);
}
