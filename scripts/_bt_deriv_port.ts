/**
 * 축 D-2: 파생 신호 포트폴리오 시뮬 (리서치 전용). 4h 28코인 업비트 2022-06~2026-08.
 * 비용: 수수료 0.05%, 시장가 슬리피지 = max(0.05%, 코인 스프레드 p50/2), TP 지정가 슬리피지 0, 관통 옵션.
 * 진입: 신호 판단 시각 t 의 다음 4h 봉 시가(외부 데이터는 t 에 확정된 것만).
 * 청산: TP 지정가(진입봉 이후 고가 ≥ 목표) / maxb 봉 시간청산(종가 시장가). 33%×3 또는 동일 MDD.
 */
import fs from 'fs';
import path from 'path';
export const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const CC = path.resolve('data/candle-cache');
export const FOUR = 4 * 3600e3, DAY = 86400e3, SPLIT = Date.UTC(2024, 7, 1);
export interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
export const BARS = new Map<string, B[]>(), IDX = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const f = fs.readdirSync(CC).filter(x => x.startsWith(`KRW-${c}_240m_2022-06-10_2026-08`));
  if (!f.length) continue;
  const b: B[] = JSON.parse(fs.readFileSync(path.join(CC, f[0]), 'utf8')).sort((a: B, b: B) => a.ts - b.ts);
  if (b.length > 500) { BARS.set(c, b); IDX.set(c, new Map(b.map((x, i) => [x.ts, i]))); }
}
export const TS = [...new Set([...BARS.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
let COSTX = 1;
export const setCost = (x: number) => { COSTX = x; };
const slip = (c: string) => COSTX * Math.max(0.0005, (SPREAD['KRW-' + c] ?? 20) / 2 / 1e4);
const FEE = () => 0.0005 * COSTX;
export interface Design { tp: number | null; maxb: number }
/** sig(c, i) = i번째 봉 마감 시점에 c 에 진입 신호(진입은 i+1 봉 시가). allow(t) = 그 봉 시각에 신규진입 허용 */
export function run(sig: (c: string, i: number) => boolean, d: Design, size = 0.33, from = 0, to = Infinity, slots = 3, pen = 0, order?: (cs: string[], t: number) => string[]) {
  let cash = 1e7; const open: Array<{ c: string; ep: number; vol: number; used: number; bars: number; last: number }> = [];
  let peak = 1e7, mdd = 0, n = 0, sumR = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.c)!.get(ts); if (i === undefined) continue;
      const bar = BARS.get(q.c)![i]; q.last = bar.close; q.bars++;
      let px = 0;
      if (d.tp != null && bar.high >= q.ep * (1 + d.tp / 100) * (1 + pen)) px = q.ep * (1 + d.tp / 100);
      else if (q.bars >= d.maxb) px = bar.close * (1 - slip(q.c));
      if (px) { const got = q.vol * px * (1 - FEE()); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    if (open.length < slots) {
      let cands = [...BARS.keys()];
      if (order) cands = order(cands, ts);
      for (const c of cands) {
        if (open.length >= slots) break;
        const i = IDX.get(c)!.get(ts); if (i === undefined || i < 50) continue;
        if (open.some(q => q.c === c) || !sig(c, i - 1)) continue;
        const used = cash * size; if (used < 5000) continue;
        const ep = BARS.get(c)![i].open * (1 + slip(c));
        cash -= used; open.push({ c, ep, vol: used * (1 - FEE()) / ep, used, bars: 0, last: ep });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
export function eqRisk(sig: (c: string, i: number) => boolean, d: Design, slots = 3, target = 17, pen = 0) {
  let lo = 0.01, hi = 0.95;
  for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (run(sig, d, m, 0, Infinity, slots, pen).mdd > target) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
export const SP: Array<[string, number, number]> = [['22H2~23', Date.UTC(2022, 6, 1), Date.UTC(2023, 11, 31)], ['2024', Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31)], ['2025', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31)], ['2026', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)]];
// ── F6 신호 (기준선)
const volZ = (b: B[], i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: B[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
export const sigF6 = (c: string, i: number) => { const b = BARS.get(c)!; return i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5; };
export function report(lab: string, sig: (c: string, i: number) => boolean, d: Design, slots = 3) {
  const r = run(sig, d, 1 / slots, 0, Infinity, slots);
  const sz = eqRisk(sig, d, slots); const e = run(sig, d, sz, 0, Infinity, slots);
  const per = SP.map(([, a, b]) => (run(sig, d, sz, a, b, slots).ret.toFixed(0) + '%').padStart(7)).join('');
  const oos = run(sig, d, sz, SPLIT, Infinity, slots).ret;
  console.log(`${lab.padEnd(34)}${(r.ret.toFixed(0) + '%').padStart(7)}${(r.mdd.toFixed(0) + '%').padStart(5)}${String(r.n).padStart(6)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)} | ${(e.ret.toFixed(0) + '%').padStart(6)} sz${(sz * 100).toFixed(0).padStart(3)}% |${per} | OOS ${oos.toFixed(0)}%`);
  return e.ret;
}
export const HEAD = '설계'.padEnd(34) + '1/K'.padStart(7) + 'MDD'.padStart(5) + '거래'.padStart(6) + '거래당'.padStart(8) + ' | MDD17'.padStart(8) + '         |' + SP.map(s => s[0].padStart(7)).join('') + ' | OOS(24-08~)';
