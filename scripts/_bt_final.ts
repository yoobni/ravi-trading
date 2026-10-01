/**
 * 최종 — 권고 조합을 패키지로 검증 + 남은 투기 가설 (2026-10-01)
 *
 * 권고 조합: F6 신호 · 다음 봉 시가 진입 · **TP 지정가 +6% / 3일 시간청산 / 스톱 없음**
 *            · 2슬롯 · 유동성 가중 사이징
 * 투기 가설: "스톱 스윕"(최근 저점을 깨고 같은 봉에서 회복)을 진입 신호로.
 *   — 반전 계열은 두 번 기각됐으므로(호가 튐) 시가→종가 분리를 처음부터 걸고 본다.
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
const loOf = (b: Bar[], f: number, t: number) => { let m = Infinity; for (let j = f; j < t; j++) m = Math.min(m, b[j].low); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
/** 스톱 스윕: 최근 20봉 저점을 깨고(저가) 같은 봉에서 그 위로 회복(종가) + 거래량 */
const sigSweep = (b: Bar[], i: number) => {
  if (i < 43) return false;
  const lo20 = loOf(b, i - 20, i);
  return b[i].low < lo20 && b[i].close > lo20 && b[i].close > b[i].open && volZ(b, i) >= 1;
};

interface Pos { m: string; ep: number; vol: number; used: number; bars: number; last: number }
interface Cfg { tp: number; days: number; maxCon: number; liqW: boolean; sig: 'F6' | 'SWEEP' | 'BOTH' }
function run(c: Cfg, size: number, from = 0, to = Infinity) {
  const MAXB = c.days * 6;
  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      const target = q.ep * (1 + c.tp / 100);
      let px: number | null = null;
      if (bar.high >= target) px = target;
      else if (q.bars >= MAXB) px = bar.close * (1 - SLIP);
      if (px != null) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    if (open.length < c.maxCon) {
      for (const m of RAW.keys()) {
        if (open.length >= c.maxCon) break;
        const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        const f6 = sigF6(bb, i - 1), sw = sigSweep(bb, i - 1);
        const hit = c.sig === 'F6' ? f6 : c.sig === 'SWEEP' ? sw : (f6 || sw);
        if (!hit) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + SLIP);
        const w = c.liqW ? [1.5, 1.2, 1.0, 0.7, 0.4][LIQ.get(m)! - 1] : 1;
        const used = Math.min(cash, cash * size * w);
        if (used < 5000) continue;
        cash -= used;
        open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: ep });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
const szFor = (c: Cfg, t: number, a = 0, b = Infinity) => { let lo = 0.02, hi = 0.98; for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(c, mid, a, b).mdd > t) hi = mid; else lo = mid; } return (lo + hi) / 2; };
const PKG: Cfg = { tp: 6, days: 3, maxCon: 2, liqW: true, sig: 'F6' };

const W: Array<[string, number, number]> = [
  ['전체 4년', 0, Infinity], ['2022H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)],
  ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
  ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)], ['OOS 2024-08~', Date.UTC(2024,7,1), Infinity]];
console.log('권고 패키지 = F6 · TP지정가 +6% · 3일 시간청산 · 스톱없음 · 2슬롯 · 유동성가중\n');
console.log('구간              총익   MDD   거래수  거래당');
for (const [lab, a, b] of W) {
  const r = run(PKG, szFor(PKG, 17, a, b), a, b);
  console.log(`${lab.padEnd(16)} ${(r.ret.toFixed(0)+'%').padStart(6)} ${(r.mdd.toFixed(1)+'%').padStart(6)} ${String(r.n).padStart(6)} ${((r.avg>=0?'+':'')+r.avg.toFixed(2)+'%').padStart(8)}`);
}
console.log('\n투기 가설 — 스톱 스윕(최근20봉 저점 깨고 당봉 회복)을 진입 신호로');
console.log('신호            총익   MDD   거래수  거래당');
for (const sg of ['F6', 'SWEEP', 'BOTH'] as const) {
  const c = { ...PKG, sig: sg };
  const r = run(c, szFor(c, 17), 0, Infinity);
  console.log(`${sg.padEnd(15)} ${(r.ret.toFixed(0)+'%').padStart(6)} ${(r.mdd.toFixed(1)+'%').padStart(6)} ${String(r.n).padStart(6)} ${((r.avg>=0?'+':'')+r.avg.toFixed(2)+'%').padStart(8)}`);
}
