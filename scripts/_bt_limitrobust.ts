/**
 * 눌림 지정가 매수 견고성 (2026-10-02, _bt_limitentry.ts 반증)
 *   A1 관통 요구 · A3 유니버스 확장(28코인 외 90코인) · A4 워크포워드 · A5 역선택 진단
 * 사용: npx tsx scripts/_bt_limitrobust.ts [base28|ext90]
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const C28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
// 현실 슬리피지: 시장가 주문(진입·시간청산)에 코인별 호가 스프레드 중앙값의 절반을 더한다
//   (data/microstructure 최근 10일 spreadBps p50). 지정가 주문(매수 지정가·TP)은 이 비용이 없다.
const REAL = process.argv.includes('real');
const SPREAD_BPS: Record<string, number> = {'KRW-AAVE':13.28,'KRW-ADA':29.81,'KRW-ALGO':59.7,'KRW-APT':18.8,'KRW-ARB':36.04,'KRW-ATOM':20.73,'KRW-AVAX':13.35,'KRW-AXS':14.62,'KRW-BAT':82.3,'KRW-BCH':11.16,'KRW-BTC':1.14,'KRW-CHZ':45.56,'KRW-DOGE':77.82,'KRW-DOT':17.92,'KRW-ETC':16.21,'KRW-ETH':2.75,'KRW-GRT':31.4,'KRW-IMX':48.9,'KRW-LINK':10.29,'KRW-MANA':82.99,'KRW-NEAR':12.43,'KRW-POL':67.8,'KRW-SAND':17.65,'KRW-SOL':6.3,'KRW-SUI':12.32,'KRW-TRX':21.76,'KRW-XLM':33.5,'KRW-XRP':4.91};
const slipOf = (m: string) => 0.0005 + (REAL ? (SPREAD_BPS[m] ?? 30) / 2 / 1e4 : 0);
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
const UNI = process.argv[2] || 'base28';
const RAW = new Map<string, Bar[]>();
if (UNI === 'base28') {
  for (const m of C28) {
    let best: Bar[] | null = null;
    for (const x of fs.readdirSync(DIR).filter(f => f.startsWith(`${m}_240m_`))) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')); if (!best || d.length > best.length) best = d; }
    if (best && best.length > 500) RAW.set(m, best.slice().sort((a, b) => a.ts - b.ts));
  }
} else {
  const ms = fs.readdirSync(DIR).filter(f => f.endsWith('_240m_2024-08-01_2025-08-01.json')).map(f => f.split('_')[0]).filter(m => !C28.includes(m));
  for (const m of ms) {
    const a = path.join(DIR, `${m}_240m_2024-08-01_2025-08-01.json`), b = path.join(DIR, `${m}_240m_2025-08-01_2026-08-24.json`);
    if (!fs.existsSync(b)) continue;
    const seen = new Set<number>();
    const bars = [...JSON.parse(fs.readFileSync(a, 'utf8')), ...JSON.parse(fs.readFileSync(b, 'utf8'))]
      .filter((x: Bar) => (seen.has(x.ts) ? false : (seen.add(x.ts), true))).sort((x: Bar, y: Bar) => x.ts - y.ts);
    if (bars.length > 1500) RAW.set(m, bars);
  }
}
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const ORDER = [...RAW.keys()];
const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0; let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const SIG = new Map<string, Set<number>>();
for (const [m, b] of RAW) { const s = new Set<number>(); for (let i = 43; i < b.length; i++) if (b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5) s.add(i); SIG.set(m, s); }

interface Pend { m: string; limit: number; used: number; left: number; rec: Rec }
interface Pos { m: string; ep: number; vol: number; used: number; bars: number; last: number }
interface Rec { m: string; ts: number; r3: number; filled: boolean }
let RECS: Rec[] = [];
function run(dip: number, W: number, pen: number, tp = 6, maxb = 18, size = 0.33, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = []; const pend: Pend[] = []; RECS = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0;
  const hit = (low: number, limit: number) => low <= limit * (1 - pen / 100);
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let px = 0;
      if (bar.high >= q.ep * (1 + tp / 100)) px = q.ep * (1 + tp / 100);
      else if (q.bars >= maxb) px = bar.close * (1 - slipOf(q.m));
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    for (let p = pend.length - 1; p >= 0; p--) {
      const o = pend[p]; const i = IDX.get(o.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(o.m)![i];
      if (hit(bar.low, o.limit)) { open.push({ m: o.m, ep: o.limit, vol: o.used * (1 - FEE) / o.limit, used: o.used, bars: 0, last: bar.close }); o.rec.filled = true; pend.splice(p, 1); }
      else if (--o.left <= 0) { cash += o.used; pend.splice(p, 1); }
    }
    for (const m of ORDER) {
      if (open.length + pend.length >= 3) break;
      const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
      if (i === undefined || i < 45 || !SIG.get(m)!.has(i - 1)) continue;
      if (open.some(q => q.m === m) || pend.some(o => o.m === m)) continue;
      const used = cash * size; if (used < 5000) continue;
      cash -= used;
      const ref = bb[i].open;
      const rec: Rec = { m, ts, r3: i + 17 < bb.length ? bb[i + 17].close / ref - 1 : 0, filled: false };
      RECS.push(rec);
      if (dip === 0) { const ep = ref * (1 + slipOf(m)); open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: bb[i].close }); rec.filled = true; continue; }
      const limit = ref * (1 - dip / 100);
      if (hit(bb[i].low, limit)) { open.push({ m, ep: limit, vol: used * (1 - FEE) / limit, used, bars: 0, last: bb[i].close }); rec.filled = true; }
      else pend.push({ m, limit, used, left: W - 1, rec });
    }
    const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
const sizeFor = (dip: number, W: number, pen: number, from = 0, to = Infinity, target = 17) => {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run(dip, W, pen, 6, 18, mid, from, to).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
};
const first = TS[0], last = TS[TS.length - 1];
const SP: Array<[string, number, number]> = UNI === 'base28'
  ? [['22H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)], ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)], ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]]
  : [['24-08~12', Date.UTC(2024,7,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)], ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const f = (x: number) => (x.toFixed(0) + '%').padStart(7);
console.log(`[${REAL ? "현실 슬리피지" : "기본 슬리피지"}] [${UNI}] ${RAW.size}코인 · ${new Date(first).toISOString().slice(0,10)} ~ ${new Date(last).toISOString().slice(0,10)}`);
const CFG: Array<[string, number, number]> = [['시가 시장가 (F7)', 0, 0], ['−1%·1봉', 1, 1], ['−2%·3봉', 2, 3], ['−3%·3봉', 3, 3], ['−4%·3봉', 4, 3]];
console.log('\n── A1 관통 요구 (33%×3 고정 · 동일 MDD17%) — 구간별은 MDD17% 사이징 ──');
console.log('설정'.padEnd(20) + '관통' + '  고정총익 고정MDD 거래당' + '  MDD17총익' + SP.map(s => s[0].padStart(9)).join(''));
for (const [lab, dip, W] of CFG) for (const pen of dip === 0 ? [0] : [0, 0.2, 0.5]) {
  const r = run(dip, W, pen); const sz = sizeFor(dip, W, pen); const e = run(dip, W, pen, 6, 18, sz);
  console.log(`${lab.padEnd(20)}${(pen + '%').padStart(4)} ${f(r.ret)} ${f(r.mdd)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(7)}  ${f(e.ret)}` + SP.map(([, a, b]) => f(run(dip, W, pen, 6, 18, sz, a, b).ret).padStart(9)).join(''));
}
console.log('\n── A5 역선택 — 주문 낸 신호 중 체결 vs 미체결, 3일 수익(기준가=다음 봉 시가) ──');
for (const [lab, dip, W] of CFG.slice(1)) {
  run(dip, W, 0.2);
  const fl = RECS.filter(r => r.filled), nf = RECS.filter(r => !r.filled);
  const mean = (a: Rec[]) => 100 * a.reduce((s, r) => s + r.r3, 0) / Math.max(a.length, 1);
  console.log(`  ${lab.padEnd(10)} 체결 ${String(fl.length).padStart(4)}건 ${mean(fl).toFixed(2).padStart(6)}%  미체결 ${String(nf.length).padStart(4)}건 ${mean(nf).toFixed(2).padStart(6)}%  (미체결 중 +6% 이상 ${(100 * nf.filter(r => r.r3 >= 0.06).length / Math.max(nf.length, 1)).toFixed(0)}%)`);
}
console.log('\n── A4 워크포워드 — 앞 절반에서 (dip,W) 선택(관통0.2%, MDD17 사이징은 IS 기준) → 뒤 절반 ──');
{
  const mid = first + (last - first) / 2;
  let best = { dip: 0, W: 0, v: -1e9 };
  const grid: Array<[number, number]> = [[0, 0]];
  for (const dip of [1, 2, 3, 4, 5]) for (const W of [1, 2, 3, 6]) grid.push([dip, W]);
  const isv: number[] = [], oosv: number[] = [];
  for (const [dip, W] of grid) {
    const sz = sizeFor(dip, W, 0.2, 0, mid); const v = run(dip, W, 0.2, 6, 18, sz, 0, mid).ret;
    const o = run(dip, W, 0.2, 6, 18, sz, mid, Infinity).ret;
    if (dip) { isv.push(v); oosv.push(o); }
    if (v > best.v) best = { dip, W, v };
    if (dip === 0) console.log(`  기준 F7: IS ${v.toFixed(0)}%  OOS ${o.toFixed(0)}%`);
  }
  const szb = sizeFor(best.dip, best.W, 0.2, 0, mid);
  console.log(`  IS 최적 = −${best.dip}%·${best.W}봉 (IS ${best.v.toFixed(0)}%) → OOS ${run(best.dip, best.W, 0.2, 6, 18, szb, mid, Infinity).ret.toFixed(0)}%`);
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const f7o = (() => { const sz = sizeFor(0, 0, 0, 0, mid); return run(0, 0, 0, 6, 18, sz, mid, Infinity).ret; })();
  console.log(`  격자 20칸 OOS 중앙값 ${med(oosv).toFixed(0)}% · OOS 에서 F7 기준(${f7o.toFixed(0)}%) 초과 ${oosv.filter(v => v > f7o).length}/20칸 · 분할점 ${new Date(mid).toISOString().slice(0,10)}`);
}
