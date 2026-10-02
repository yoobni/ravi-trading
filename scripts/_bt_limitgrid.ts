/**
 * 축 ⑦ 지정가 전용 전략 (2026-10-02) — F6 신호를 쓰지 않는 독립 신호원.
 *
 * 업비트에서 체결손실이 0 인 건 지정가뿐이다. 과거 반전 전략 3종은 시장가 체결·'호가 튐'으로 기각됐다.
 * 여기선 지정가로만 들어가고 지정가로만 나온다(시간청산만 시장가).
 *
 * 체결 모델 (15m 봉):
 *   매수 — 봉 시작에 limit = ref × (1 − x) 를 건다(ref 는 직전 봉까지의 정보만). 저가 ≤ limit × (1 − pen) 이면 체결.
 *          체결가 = min(limit, 봉 시가) (시가가 이미 아래면 즉시 체결 = 시가).
 *   매도 — 체결 다음 봉부터 target = 체결가 × (1 + y) 지정가. 고가 ≥ target × (1 + pen) 이면 체결가 = max(target, 시가).
 *   시간청산 — T 시간 경과 봉 종가 × (1 − 0.05%) 시장가. 무스톱.
 *   수수료 0.05% 양쪽.
 * 포트폴리오: 동시 최대 K 포지션, 체결 시점 자산 × frac. 같은 봉에서 여러 코인이 체결되면 코인 목록 순서대로 K 까지.
 *   ⚠ 낙관 가정: 실제로는 28코인에 상시 주문을 걸면 KRW 가 묶인다. 감시 프로세스가 근접 시 주문을 거는 구현을 전제한다.
 *
 * 실행: npx tsx scripts/_bt_limitgrid.ts [grid|trig|trend|wf|stress|halves|bench|all]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const Q = 15 * 60_000, H4 = 4 * 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
interface Coin { m: string; b: Bar[]; idx: Map<number, number>; h16: Float64Array; h96: Float64Array; trend: Uint8Array }

function slidingMax(b: Bar[], n: number): Float64Array {
  const out = new Float64Array(b.length).fill(NaN); const dq: number[] = [];
  for (let i = 0; i < b.length; i++) {
    // out[i] = 직전 n봉(i-n..i-1) 고가 최대
    if (i >= n) out[i] = b[dq[0]].high;
    while (dq.length && b[dq[dq.length - 1]].high <= b[i].high) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
  }
  return out;
}
function trendFlags(b: Bar[]): Uint8Array {
  // 4h 버킷 종가 → SMA50. 15m 봉 i 에서는 직전에 완성된 4h 봉 종가 > 그 시점 SMA50 이면 1.
  const bucketClose = new Map<number, number>();
  for (const x of b) bucketClose.set(Math.floor(x.ts / H4), x.close);
  const keys = [...bucketClose.keys()].sort((a, c) => a - c);
  const flag = new Map<number, number>(); // bucket → 그 버킷 '이후'에 쓸 플래그
  for (let k = 50; k < keys.length; k++) {
    let s = 0; for (let j = k - 49; j <= k; j++) s += bucketClose.get(keys[j])!;
    flag.set(keys[k], bucketClose.get(keys[k])! > s / 50 ? 1 : 0);
  }
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) { const prev = Math.floor(b[i].ts / H4) - 1; out[i] = flag.get(prev) ?? 0; }
  return out;
}
const ALL: Coin[] = [];
for (const m of COINS) {
  const f = fs.readdirSync(DIR).find(x => x.startsWith(`${m}_15m_`));
  if (!f) continue;
  const b = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]).sort((a, c) => a.ts - c.ts);
  ALL.push({ m, b, idx: new Map(b.map((x, i) => [x.ts, i])), h16: slidingMax(b, 16), h96: slidingMax(b, 96), trend: trendFlags(b) });
}
const TS = [...new Set(ALL.flatMap(c => c.b.map(x => x.ts)))].sort((a, c) => a - c);
const T0 = TS[0], T1 = TS[TS.length - 1];

interface Cfg {
  ref: 'c' | 'h4' | 'h24';   // 직전 종가 / 직전 4h 고점 / 직전 24h 고점
  x: number; y: number; T: number;  // %, %, 시간
  trig?: { win: number; z: number }; // 급락 흡수: 직전 win 개 15m 봉 수익 ≤ −z% 일 때만 주문
  trend?: boolean;
  pen?: number;               // 관통 요구 (비율)
  K?: number;
}
interface Pos { c: Coin; ep: number; vol: number; used: number; i0: number; ts0: number }
const LOG: Array<{ m: string; ts0: number; ts1: number; r: number; krw: number; ep: number; tx: number }> = [];
let EXCL = new Set<string>();   // 진입 제외할 KST 날짜
const kday = (ts: number) => new Date(ts + 9 * 3600e3).toISOString().slice(0, 10);

function run(cfg: Cfg, frac: number, coins = ALL, from = 0, to = Infinity) {
  const K = cfg.K ?? 5, pen = cfg.pen ?? 0, holdBars = cfg.T * 4;
  let cash = INIT, peak = INIT, mdd = 0, n = 0, sumR = 0, wins = 0, timeEx = 0, eq = INIT;
  const open: Pos[] = [];
  const held = new Set<string>();
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    // 청산
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = q.c.idx.get(ts); if (i === undefined) continue;
      if (i <= q.i0) continue;
      const bar = q.c.b[i]; const tgt = q.ep * (1 + cfg.y / 100);
      let px = 0;
      if (bar.high >= tgt * (1 + pen)) px = Math.max(tgt, bar.open);
      else if (i - q.i0 >= holdBars) { px = bar.close * (1 - SLIP); timeEx++; }
      if (px) {
        const got = q.vol * px * (1 - FEE); cash += got; n++; const r = got / q.used - 1; sumR += r; if (r > 0) wins++;
        LOG.push({ m: q.c.m, ts0: q.ts0, ts1: ts, r, krw: got - q.used, ep: q.ep, tx: q.ep * (1 + cfg.y / 100) });
        open.splice(p, 1); held.delete(q.c.m);
      }
    }
    // 진입
    if (open.length < K) {
      for (const c of coins) {
        if (open.length >= K) break;
        if (held.has(c.m)) continue;
        const i = c.idx.get(ts); if (i === undefined || i < 100) continue;
        if (cfg.trend && !c.trend[i]) continue;
        if (EXCL.size && EXCL.has(kday(ts))) continue;
        const b = c.b;
        if (cfg.trig && !(b[i - 1].close / b[i - 1 - cfg.trig.win].close - 1 <= -cfg.trig.z / 100)) continue;
        const ref = cfg.ref === 'c' ? b[i - 1].close : cfg.ref === 'h4' ? c.h16[i] : c.h96[i];
        if (!(ref > 0)) continue;
        const limit = ref * (1 - cfg.x / 100);
        if (b[i].low > limit * (1 - pen)) continue;
        const ep = Math.min(limit, b[i].open);
        const used = Math.min(eq * frac, cash); if (used < 5000) continue;
        cash -= used;
        open.push({ c, ep, vol: used * (1 - FEE) / ep, used, i0: i, ts0: ts }); held.add(c.m);
      }
    }
    let v = cash;
    for (const q of open) { const i = q.c.idx.get(ts); v += q.vol * (i !== undefined ? q.c.b[i].close : q.ep); }
    // 인덱스가 없는 봉(상장 공백)은 진입가로 평가 — 드물다
    eq = v; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, wr: n ? 100 * wins / n : 0, tex: n ? 100 * timeEx / n : 0 };
}
function sizeFor(cfg: Cfg, target = 17, coins = ALL, from = 0, to = Infinity) {
  const K = cfg.K ?? 5; let lo = 0.005, hi = 1 / K;
  if (run(cfg, hi, coins, from, to).mdd <= target) return hi;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (run(cfg, mid, coins, from, to).mdd > target) hi = mid; else lo = mid; }
  return lo;
}

// ── 기준선: BTC 보유(축소), F7 (15m → 4h 합성, TP+6 지정가 · 18봉 · 무스톱, 33%×3) ──
function btcHold(frac: number, from = 0, to = Infinity) {
  const c = ALL.find(x => x.m === 'KRW-BTC')!; const bs = c.b.filter(x => x.ts >= from && x.ts <= to);
  let peak = 1, mdd = 0, v = 1;
  for (const x of bs) { v = 1 - frac + frac * x.close / bs[0].open; peak = Math.max(peak, v); mdd = Math.max(mdd, (peak - v) / peak); }
  return { ret: 100 * (v - 1), mdd: 100 * mdd };
}
function agg4h(b: Bar[]): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null; let key = -1;
  for (const x of b) {
    const k = Math.floor(x.ts / H4);
    if (k !== key) { if (cur) out.push(cur); key = k; cur = { ts: k * H4, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }; }
    else { cur!.high = Math.max(cur!.high, x.high); cur!.low = Math.min(cur!.low, x.low); cur!.close = x.close; cur!.volume += x.volume; }
  }
  if (cur) out.push(cur);
  return out;
}
const B4 = new Map(ALL.map(c => [c.m, agg4h(c.b)]));
const I4 = new Map([...B4].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS4 = [...new Set([...B4.values()].flatMap(b => b.map(x => x.ts)))].sort((a, c) => a - c);
const volZ = (b: Bar[], i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) => i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
function f7(size: number, from = 0, to = Infinity) {
  let cash = INIT, peak = INIT, mdd = 0, eq = INIT;
  const open: { m: string; ep: number; vol: number; bars: number; last: number }[] = [];
  for (const ts of TS4) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = I4.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = B4.get(q.m)![i]; q.last = bar.close; q.bars++;
      let px = 0; if (bar.high >= q.ep * 1.06) px = q.ep * 1.06; else if (q.bars >= 18) px = bar.close * (1 - SLIP);
      if (px) { cash += q.vol * px * (1 - FEE); open.splice(p, 1); }
    }
    for (const c of ALL) {
      if (open.length >= 3) break;
      const b = B4.get(c.m)!; const i = I4.get(c.m)!.get(ts);
      if (i === undefined || i < 45 || !sigF6(b, i - 1) || open.some(q => q.m === c.m)) continue;
      const used = cash * size; if (used < 5000) continue;
      cash -= used; const ep = b[i].open * (1 + SLIP);
      open.push({ m: c.m, ep, vol: used * (1 - FEE) / ep, bars: 0, last: b[i].close });
    }
    eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd };
}
function sizeGeneric(fn: (s: number) => { mdd: number }, hi: number, target = 17) {
  let lo = 0.005; if (fn(hi).mdd <= target) return hi;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (fn(mid).mdd > target) hi = mid; else lo = mid; }
  return lo;
}

// ── 출력 ──
const SEG: Array<[string, number, number]> = [['2024Q4', Date.UTC(2024, 9, 1), Date.UTC(2024, 11, 31, 23, 59)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31, 23, 59)], ['2026YTD', Date.UTC(2026, 0, 1), Infinity]];
const MID = Date.UTC(2025, 9, 1);
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const lab = (c: Cfg) => `${c.ref}-${c.x}/+${c.y}/${c.T}h${c.trig ? ` trig${c.trig.win}b-${c.trig.z}` : ''}${c.trend ? ' TR' : ''}${c.pen ? ` pen${(c.pen * 100).toFixed(1)}` : ''}`;
function row(c: Cfg, coins = ALL) {
  const fx = run(c, 0.2, coins);                      // 고정 사이징 20%×5
  const s = sizeFor(c, 17, coins); const e = run(c, s, coins);
  const seg = SEG.map(([, a, b]) => P(run(c, s, coins, a, b).ret).padStart(7)).join('');
  return { c, fx, s, e, line: `${lab(c).padEnd(30)} 고정 ${P(fx.ret).padStart(6)} MDD${fx.mdd.toFixed(0).padStart(3)}% n${String(fx.n).padStart(5)} 거래당${fx.avg.toFixed(2).padStart(6)}% 승률${fx.wr.toFixed(0).padStart(3)}% 시간청산${fx.tex.toFixed(0).padStart(3)}% | MDD17: ${P(e.ret).padStart(6)} (슬롯${(s * 100).toFixed(1)}%) |${seg}` };
}
const mode = process.argv[2] || 'all';
console.log(`15m ${ALL.length}코인 ${new Date(T0).toISOString().slice(0, 10)} ~ ${new Date(T1).toISOString().slice(0, 10)} · 고정=20%×5 · MDD17=동일위험 사이징 · 구간: ${SEG.map(s => s[0]).join('/')}`);

const GRID: Cfg[] = [];
for (const ref of ['c', 'h4', 'h24'] as const) for (const x of [2, 3, 5, 8]) for (const y of [1, 2, 3, 5]) for (const T of [24, 72]) {
  if (ref === 'c' && x > 5) continue;
  GRID.push({ ref, x, y, T });
}
const results: Array<ReturnType<typeof row>> = [];
if (mode === 'bench' || mode === 'all') {
  const sb = sizeGeneric(s => btcHold(s), 1); const b = btcHold(sb);
  const sf = sizeGeneric(s => f7(s), 0.33); const f = f7(sf);
  console.log(`\n[기준선] BTC 축소보유 MDD17 ${P(b.ret)} (비중 ${(sb * 100).toFixed(0)}%) | 구간 ${SEG.map(([, a, z]) => P(btcHold(sb, a, z).ret)).join(' / ')}`);
  console.log(`[기준선] F7 (15m→4h, 33%×3) 고정 ${P(f7(0.33).ret)} MDD${f7(0.33).mdd.toFixed(0)}% | MDD17 ${P(f.ret)} (${(sf * 100).toFixed(0)}%) | 구간 ${SEG.map(([, a, z]) => P(f7(sf, a, z).ret)).join(' / ')}`);
}
if (mode === 'grid' || mode === 'all') {
  console.log('\n── ① 눌림 그리드 (무스톱, 지정가 진입·청산) ──');
  for (const c of GRID) { const r = row(c); results.push(r); console.log(r.line); }
  const sorted = results.slice().sort((a, b) => b.e.ret - a.e.ret);
  const med = sorted[Math.floor(sorted.length / 2)].e.ret;
  console.log(`  격자 ${sorted.length}칸 MDD17 중앙값 ${P(med)}, 양수 ${sorted.filter(r => r.e.ret > 0).length}칸`);
  console.log('  상위 5:'); for (const r of sorted.slice(0, 5)) console.log('   ' + r.line);
}
if (mode === 'trig' || mode === 'all') {
  console.log('\n── ② 급락 흡수 (직전 win 봉 수익 ≤ −z% 일 때만, 더 아래 지정가) ──');
  for (const win of [4, 16]) for (const z of [3, 5, 8]) for (const x of [1, 2, 3]) for (const y of [2, 3, 5]) {
    if (win === 4 && z === 8) continue;
    const r = row({ ref: 'c', x, y, T: 48, trig: { win, z } }); console.log(r.line);
  }
}
if (mode === 'trend' || mode === 'all') {
  console.log('\n── ③ 추세 필터 (4h SMA50 위에서만) — IS(~2025-09) 에서 최적칸 선택 후 OOS ──');
  const cands = GRID.filter(c => c.T === 72 || c.T === 24).map(c => ({ ...c, trend: true }));
  let best: { c: Cfg; v: number } | null = null;
  for (const c of cands) { const s = sizeFor(c, 17, ALL, 0, MID); const v = run(c, s, ALL, 0, MID).ret; if (!best || v > best.v) best = { c, v }; }
  const c = best!.c; const sIS = sizeFor(c, 17, ALL, 0, MID);
  console.log(`  IS 최적 ${lab(c)} IS ${P(best!.v)} → OOS(같은 사이즈) ${P(run(c, sIS, ALL, MID).ret)} MDD ${run(c, sIS, ALL, MID).mdd.toFixed(0)}%`);
  const nf = { ...c, trend: false };
  console.log(`  같은 칸 필터 없음: IS ${P(run(nf, sizeFor(nf, 17, ALL, 0, MID), ALL, 0, MID).ret)} → OOS ${P(run(nf, sizeFor(nf, 17, ALL, 0, MID), ALL, MID).ret)}`);
  console.log('  ' + row(c).line);
}
if (mode === 'wf' || mode === 'all') {
  console.log('\n── ④ 워크포워드 — 무필터 그리드, IS(2024-10~2025-09) 최적 → OOS(2025-10~) ──');
  const scored = GRID.map(c => { const s = sizeFor(c, 17, ALL, 0, MID); return { c, s, is: run(c, s, ALL, 0, MID).ret }; }).sort((a, b) => b.is - a.is);
  for (const k of scored.slice(0, 5)) {
    const o = run(k.c, k.s, ALL, MID);
    console.log(`  ${lab(k.c).padEnd(26)} IS ${P(k.is).padStart(6)} → OOS ${P(o.ret).padStart(6)} (MDD ${o.mdd.toFixed(0)}%)`);
  }
  const oosAll = scored.map(k => run(k.c, k.s, ALL, MID).ret).sort((a, b) => a - b);
  console.log(`  OOS 격자 전체 중앙값 ${P(oosAll[Math.floor(oosAll.length / 2)])}, 양수 ${oosAll.filter(v => v > 0).length}/${oosAll.length}`);
}
if (mode === 'stress' || mode === 'halves' || mode === 'all') {
  const pick: Cfg[] = process.env.PICK ? JSON.parse(process.env.PICK) : [{ ref: 'h24', x: 5, y: 3, T: 72 }, { ref: 'h4', x: 3, y: 2, T: 24 }];
  console.log('\n── ⑤ 관통 요구 0.2% 스트레스 / ⑥ 코인 절반 재현 ──');
  for (const c of pick) {
    console.log('  기본      ' + row(c).line);
    for (const pen of [0.002, 0.005, 0.01]) console.log(`  관통${(pen * 100).toFixed(1)}%  ` + row({ ...c, pen }).line);
    console.log('  짝수코인  ' + row(c, ALL.filter((_, i) => i % 2 === 0)).line);
    console.log('  홀수코인  ' + row(c, ALL.filter((_, i) => i % 2 === 1)).line);
  }
}

if (mode === 'deep') {
  const DEEP: Cfg[] = [
    { ref: 'c', x: 4, y: 2, T: 72 }, { ref: 'c', x: 5, y: 2, T: 72 }, { ref: 'c', x: 5, y: 3, T: 72 }, { ref: 'c', x: 6, y: 2, T: 72 },
    { ref: 'c', x: 8, y: 2, T: 72 }, { ref: 'c', x: 8, y: 3, T: 72 }, { ref: 'c', x: 5, y: 2, T: 24 },
    { ref: 'c', x: 1, y: 3, T: 48, trig: { win: 16, z: 8 } }, { ref: 'c', x: 3, y: 3, T: 48, trig: { win: 16, z: 5 } },
    { ref: 'c', x: 3, y: 3, T: 48, trig: { win: 4, z: 3 } }, { ref: 'c', x: 2, y: 2, T: 48, trig: { win: 16, z: 3 } },
  ];
  console.log('\n── ⑦ 깊은 급락 흡수 계열: 관통 0.5% / 폭락일 집중도 / 상위일 제외 ──');
  for (const c0 of DEEP) {
    for (const pen of [0, 0.005]) {
      const c = { ...c0, pen };
      LOG.length = 0; EXCL = new Set();
      const fx = run(c, 0.2);
      const byDay = new Map<string, number>(); for (const t of LOG) byDay.set(kday(t.ts0), (byDay.get(kday(t.ts0)) || 0) + t.krw);
      const days = [...byDay].sort((a, b) => b[1] - a[1]); const tot = days.reduce((a, d) => a + d[1], 0);
      const top3 = days.slice(0, 3).reduce((a, d) => a + d[1], 0);
      const r = row(c);
      EXCL = new Set(days.slice(0, 5).map(d => d[0]));
      const ex = run(c, sizeFor(c)); EXCL = new Set();
      console.log(r.line);
      console.log(`      진입일 ${byDay.size}일 · 상위3일 손익비중 ${(100 * top3 / tot).toFixed(0)}% (${days.slice(0, 3).map(d => d[0]).join(', ')}) · 상위5일 진입 제외 시 MDD17 ${P(ex.ret)} MDD ${ex.mdd.toFixed(0)}%`);
    }
  }
  // 체결 로그를 마이크로구조 검증용으로 저장 (기본 c-5/+2/72h)
  LOG.length = 0; run({ ref: 'c', x: 5, y: 2, T: 72 }, 0.2);
  fs.writeFileSync(path.join(process.env.SCRATCH || '/tmp', 'deep_trades.json'), JSON.stringify(LOG));
}
if (mode === 'lock') {
  // 현실 제약: 지정가 주문은 KRW 를 묶는다 → 28코인 상시 주문이면 코인당 자산의 1/28 만 걸 수 있다(무레버리지).
  console.log('\n── ⑧ 자금 잠김 현실화: K=28, 코인당 1/28 상시 주문 ──');
  for (const c0 of [{ ref: 'c', x: 4, y: 2, T: 72 }, { ref: 'c', x: 5, y: 2, T: 72 }, { ref: 'c', x: 5, y: 3, T: 72 }, { ref: 'c', x: 6, y: 2, T: 72 }] as Cfg[]) {
    for (const pen of [0, 0.005]) {
      const c = { ...c0, K: 28, pen };
      const r = run(c, 1 / 28);
      const seg = SEG.map(([, a, b]) => P(run(c, 1 / 28, ALL, a, b).ret).padStart(7)).join('');
      console.log(`${lab(c).padEnd(26)} ${P(r.ret).padStart(6)} MDD ${r.mdd.toFixed(1)}% n ${r.n} 거래당 ${r.avg.toFixed(2)}% |${seg}`);
    }
  }
}
