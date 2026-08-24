/**
 * 보유기간 실험 — 1h 탐색(_bt_1h ④)에서 나온 발견을 4년 표본으로 검증.
 *
 * 발견: 진입 후 중앙수익이 3일차 +0.91%로 정점을 찍고 14일차엔 −1.83%로 마이너스.
 *       승률도 3일 55.1% → 14일 45.3%. 평균이 플러스인 건 소수 대박 덕분이고,
 *       "보통의 거래"는 3일 이후 오히려 새는 중이다. 현행 MAX는 14일.
 *
 * 그래서 두 가지를 본다.
 *   A. 시간청산을 3/5/7/10/14일로 바꾸면? (트레일링은 그대로)
 *   B. 조건부 시간청산 — N일차에 수익이 X% 미만이면 정리(트레일 발동 전인 것만)
 *      "가만히 있는 놈은 빼고 달리는 놈만 태운다"
 *
 * 현금·동시보유 제약 포함(33%×3). 실행: npx tsx scripts/_bt_holdtime.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
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
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

interface Cfg { maxDays: number; cutDay?: number; cutBelowPct?: number; skipHours?: number[]; skipDays?: number[] }
function run(cfg: Cfg, from?: number, to?: number) {
  const SL = -2, ACT = 2, GAP = 2, PCT = 0.33, MAXC = 3;
  const MAXB = cfg.maxDays * 6;
  let cash = INIT;
  const open: Array<{ m: string; ep: number; vol: number; used: number; ei: number; peak: number; tsl: number; armed: boolean }> = [];
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0;
  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const t1r = to ? TS.findIndex(x => x >= to) : TS.length;
  const t1 = t1r < 0 ? TS.length : t1r;
  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = SERIES.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; const held = i - pos.ei;
      let px = 0, done = false;
      if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
      }
      // 조건부 컷: N일차에 아직 트레일 미발동 + 수익 미달이면 정리
      if (!done && cfg.cutDay != null && held >= cfg.cutDay * 6 && !pos.armed &&
          (bar.close / pos.ep - 1) * 100 < (cfg.cutBelowPct ?? 0)) { px = bar.close; done = true; }
      if (!done && held >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const proceeds = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        open.splice(p, 1);
      }
    }
    if (open.length < MAXC && t < t1 - 20) {
      for (const [m, b] of SERIES) {
        if (open.length >= MAXC) break;
        if (open.some(p => p.m === m)) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
        if (!sig(b, i)) continue;
        // 진입봉(= 다음 봉)의 KST 시각·요일로 거른다
        const entTs = b[i + 1].ts;
        const kd = new Date(entTs + 9 * 3600_000);
        if (cfg.skipHours?.includes(kd.getUTCHours())) continue;
        if (cfg.skipDays?.includes(kd.getUTCDay())) continue;
        const use = cash * PCT; if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) eq += p.vol * SERIES.get(p.m)![i].close; }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  let fin = cash;
  const lastTs = TS[Math.min(t1 - 1, TS.length - 1)];
  for (const p of open) { const i = IDX.get(p.m)!.get(lastTs); if (i !== undefined) fin += p.vol * SERIES.get(p.m)![i].close; }
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
}
const row = (l: string, r: ReturnType<typeof run>) => console.log(
  `  ${l.padEnd(28)}| ${(r.total.toFixed(0)+'%').padStart(8)} | ${(r.mdd.toFixed(1)+'%').padStart(6)} | ${(r.mdd>0?r.total/r.mdd:0).toFixed(2).padStart(8)} | ${String(r.n).padStart(4)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)}`);

console.log(`=== 보유기간 실험 (${SERIES.size}코인 4h, ${new Date(TS[200]).toISOString().slice(0,7)}~${new Date(TS[TS.length-1]).toISOString().slice(0,7)}, 33%×3) ===\n`);
console.log('◆ A. 시간청산 길이');
console.log('  변형                        |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF');
const CFGS: Array<[string, Cfg]> = [
  ['MAX 14일 (현행)', { maxDays: 14 }], ['MAX 10일', { maxDays: 10 }], ['MAX 7일', { maxDays: 7 }],
  ['MAX 5일', { maxDays: 5 }], ['MAX 3일', { maxDays: 3 }], ['MAX 2일', { maxDays: 2 }],
];
for (const [l, c] of CFGS) row(l, run(c));
console.log('\n◆ B. 조건부 컷 — N일차에 트레일 미발동 & 수익 X% 미만이면 정리 (MAX는 14일 유지)');
const CUTS: Array<[string, Cfg]> = [
  ['3일차 0% 미만 컷', { maxDays: 14, cutDay: 3, cutBelowPct: 0 }],
  ['3일차 +1% 미만 컷', { maxDays: 14, cutDay: 3, cutBelowPct: 1 }],
  ['2일차 0% 미만 컷', { maxDays: 14, cutDay: 2, cutBelowPct: 0 }],
  ['5일차 0% 미만 컷', { maxDays: 14, cutDay: 5, cutBelowPct: 0 }],
  ['5일차 +1% 미만 컷', { maxDays: 14, cutDay: 5, cutBelowPct: 1 }],
];
for (const [l, c] of CUTS) row(l, run(c));
console.log('\n◆ C. 시간대·요일 필터 (포트폴리오 레벨, MAX 14일)');
console.log('  변형                        |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF');
const FILT: Array<[string, Cfg]> = [
  ['필터 없음 (현행)', { maxDays: 14 }],
  ['KST 13시 진입 제외', { maxDays: 14, skipHours: [13] }],
  ['KST 09·13시 제외(한국낮)', { maxDays: 14, skipHours: [9, 13] }],
  ['월요일 진입 제외', { maxDays: 14, skipDays: [1] }],
  ['13시 + 월요일 제외', { maxDays: 14, skipHours: [13], skipDays: [1] }],
];
for (const [l, c] of FILT) row(l, run(c));

console.log('\n◆ 기간 분할 (총익/MDD)');
const P: Array<[string, string, string]> = [
  ['2022H2','2022-07-01','2023-01-01'],['2023','2023-01-01','2024-01-01'],['2024','2024-01-01','2025-01-01'],
  ['2025','2025-01-01','2026-01-01'],['2026','2026-01-01','2026-09-01']];
const SEL: Array<[string, Cfg]> = [['현행',{maxDays:14}],['13시제외',{maxDays:14,skipHours:[13]}],['월요일제외',{maxDays:14,skipDays:[1]}],['화요일제외',{maxDays:14,skipDays:[2]}],['목요일제외',{maxDays:14,skipDays:[4]}]];
console.log('  기간     | ' + SEL.map(([l]) => l.padStart(13)).join(' | '));
for (const [pn, f, t] of P) {
  console.log(`  ${pn.padEnd(8)} | ` + SEL.map(([, c]) => {
    const r = run(c, Date.parse(f+'T00:00:00Z'), Date.parse(t+'T00:00:00Z'));
    return `${(r.total.toFixed(0)+'%').padStart(6)}/${(r.mdd.toFixed(0)+'%').padStart(3)}`.padStart(13);
  }).join(' | '));
}
