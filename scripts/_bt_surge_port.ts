/**
 * 급등 결합 최종 판정 — 포트폴리오 시뮬 × 체결 현실 (2026-10-01).
 *
 * 핵심: 폴링이 4h 봉마감이면 "확인 시점 종가 = 그 4h봉의 close" 이므로 4h 캐시만으로
 *   체결 현실을 정확히 모사할 수 있다(1h 경로는 '저가가 스톱을 깼나'와 무관). 덕분에
 *   원 연구와 **같은 4년 창**에서 직접 비교된다.
 *
 * settle='stop'   : 트리거 가격에 체결 — 기존 모든 `_bt_*` 의 가정. 업비트에선 불가능.
 * settle='market' : 확인 시점(봉마감) 종가에 체결 — 예약 스톱이 없을 때의 현실.
 *
 * 판정은 프로젝트 표준대로 **동일 MDD 이분탐색** 후 총익 비교.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const ALL = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) ALL.set(m, b); }
let MKTS = [...ALL.keys()];
const MKTS0 = [...MKTS];
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
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && b[i].close > b[i].open && volZ(b, i) >= vz;

/** 전 코인 공통 타임라인 */
const TS = [...new Set([...ALL.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const IDX = new Map<string, Map<number, number>>();
for (const [m, b] of ALL) IDX.set(m, new Map(b.map((x, i) => [x.ts, i])));

interface Pos { m: string; ep: number; vol: number; used: number; bars: number; peak: number; stop: number; armed: boolean; last: number; src: string }

function run(use: 'F6' | 'BOTH', pct: number, vz: number, size: number, settle: 'stop' | 'market', from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0;
  const bySrc = new Map<string, { n: number; s: number }>();
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    // ── 청산 (봉마감 확인) ──
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const bb = ALL.get(q.m)!; const i = IDX.get(q.m)!.get(ts);
      if (i === undefined) continue;
      const bar = bb[i]; q.last = bar.close; q.bars++;
      let px: number | null = null;
      if (bar.low <= q.stop) px = settle === 'stop' ? q.stop : bar.close;   // ★ 여기가 유일한 차이
      else if (q.bars >= MAXB) px = bar.close;
      if (px != null) {
        const got = q.vol * px * (1 - SLIP) * (1 - FEE);
        cash += got;
        const r = got / q.used - 1;
        const e = bySrc.get(q.src) ?? { n: 0, s: 0 }; e.n++; e.s += r; bySrc.set(q.src, e);
        open.splice(p, 1); continue;
      }
      q.peak = Math.max(q.peak, bar.high);
      if (!q.armed && q.peak >= q.ep * (1 + ACT / 100)) q.armed = true;
      if (q.armed) q.stop = Math.max(q.stop, q.peak * (1 - GAP / 100));
    }
    // ── 진입 (직전 확정봉 신호 → 이번 봉 시가) ──
    if (open.length < 3) {
      for (const m of MKTS) {
        if (open.length >= 3) break;
        const bb = ALL.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        const s = i - 1;                      // 직전 봉이 신호봉
        const f6 = sigF6(bb, s);
        const sg = use === 'BOTH' && !f6 && sigSurge(bb, s, pct, vz);
        if (!f6 && !sg) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + SLIP);
        const used = cash * size;
        if (used < 5000) continue;
        cash -= used;
        open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, peak: ep, stop: ep * (1 + SL / 100), armed: false, last: ep, src: f6 ? 'F6' : 'SURGE' });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, bySrc };
}

/** 목표 MDD 에 맞춰 size 를 이분탐색 (메모리 경고: 성긴 격자 보간 금지) */
function sizeForMdd(use: 'F6' | 'BOTH', pct: number, vz: number, target: number, settle: 'stop' | 'market') {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (run(use, pct, vz, mid, settle).mdd > target) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

const TARGET = 17;
console.log(`28코인 4h · ${new Date(TS[0]).toISOString().slice(0, 10)}~${new Date(TS[TS.length - 1]).toISOString().slice(0, 10)} · 동일 MDD ${TARGET}% 고정\n`);
for (const settle of ['stop', 'market'] as const) {
  const sF6 = sizeForMdd('F6', 0, 0, TARGET, settle);
  const rF6 = run('F6', 0, 0, sF6, settle);
  console.log(`[정산 ${settle}]  F6 단독: 총익 ${rF6.ret.toFixed(0)}% · MDD ${rF6.mdd.toFixed(1)}% · size ${(sF6 * 100).toFixed(1)}%`);
  for (const [pct, vz] of [[7, 1], [6, 1.5], [8, 1]] as const) {
    const s = sizeForMdd('BOTH', pct, vz, TARGET, settle);
    const r = run('BOTH', pct, vz, s, settle);
    const f6e = r.bySrc.get('F6'), sge = r.bySrc.get('SURGE');
    console.log(`   결합 +${pct}% z${vz}: 총익 ${r.ret.toFixed(0)}% (F6대비 ${(r.ret - rF6.ret >= 0 ? '+' : '')}${(r.ret - rF6.ret).toFixed(0)}%p) · MDD ${r.mdd.toFixed(1)}%` +
      `  | F6 ${f6e?.n ?? 0}건 ${(100 * (f6e?.s ?? 0) / Math.max(1, f6e?.n ?? 1)).toFixed(2)}% · SURGE ${sge?.n ?? 0}건 ${(100 * (sge?.s ?? 0) / Math.max(1, sge?.n ?? 1)).toFixed(2)}%`);
  }
  console.log('');
}
