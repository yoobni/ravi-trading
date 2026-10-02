import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE0 = 0.0005, SLIP0 = 0.0005, INIT = 10_000_000;
let FEE = FEE0, SLIP = SLIP0;
const H = 3600_000, FOUR = 4 * H;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
let ORDER: string[] = [];
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) RAW.set(m, b); }
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
ORDER = [...RAW.keys()];

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
/**
 * 메커니즘 ① 눌림 지정가 매수 (2026-10-02)
 * 근거: F6 신호 후 최저점의 21% 가 진입 직후 첫 봉에서 나온다(_an_paths.ts). 시장가로 쫓지 말고 아래에 걸어둔다.
 * 주문: 신호 확정 시 기준가 = 다음 봉 시가. 매수 지정가 = 기준가 × (1 − dip%). W봉 동안 유효, 미체결 시 취소.
 *   체결 = 봉 저가가 지정가 이하 → 지정가 체결(슬리피지 0). 주문 중엔 현금을 묶는다(업비트 실제 동작).
 *   체결 봉 자체에선 TP 를 보지 않는다(봉 내 순서 불명 → 보수적).
 * 청산: TP 지정가 +tp% (체결가 기준) · maxb 봉 시간청산 · 스톱 없음 — F7 과 동일.
 * dip=0 은 "다음 봉 시가 시장가 진입" = 현행 F7 (슬리피지 적용).
 */
interface Pend { m: string; limit: number; used: number; left: number }
interface Pos2 { m: string; ep: number; vol: number; used: number; bars: number; last: number }
function run2(dip: number, W: number, tp: number, maxb: number, size = 0.33, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos2[] = []; const pend: Pend[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, fills = 0, orders = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    // 청산
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let px = 0;
      if (bar.high >= q.ep * (1 + tp / 100)) px = q.ep * (1 + tp / 100);
      else if (q.bars >= maxb) px = bar.close * (1 - SLIP);
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    // 대기 주문 체결/만료
    for (let p = pend.length - 1; p >= 0; p--) {
      const o = pend[p]; const i = IDX.get(o.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(o.m)![i];
      if (bar.low <= o.limit) {
        open.push({ m: o.m, ep: o.limit, vol: o.used * (1 - FEE) / o.limit, used: o.used, bars: 0, last: bar.close });
        pend.splice(p, 1); fills++;
      } else if (--o.left <= 0) { cash += o.used; pend.splice(p, 1); }
    }
    // 신호 → 주문 (dip=0 이면 즉시 시가 체결)
    for (const m of ORDER) {
      if (open.length + pend.length >= 3) break;
      const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
      if (i === undefined || i < 45 || !sigF6(bb, i - 1)) continue;
      if (open.some(q => q.m === m) || pend.some(o => o.m === m)) continue;
      const used = cash * size; if (used < 5000) continue;
      cash -= used; orders++;
      const ref = bb[i].open;
      if (dip === 0) { const ep = ref * (1 + SLIP); open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: bb[i].close }); fills++; continue; }
      const limit = ref * (1 - dip / 100);
      // 이 봉(i) 안에서도 체결될 수 있다 — 주문은 봉 시작에 걸린다
      if (bb[i].low <= limit) { open.push({ m, ep: limit, vol: used * (1 - FEE) / limit, used, bars: 0, last: bb[i].close }); fills++; }
      else pend.push({ m, limit, used, left: W - 1 });
    }
    const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, fill: orders ? 100 * fills / orders : 0 };
}
const SP: Array<[string, number, number]> = [['22H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)],
  ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
  ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const line = (lab: string, dip: number, W: number, tp: number, maxb: number) => {
  const r = run2(dip, W, tp, maxb);
  const per = SP.map(([, a, b]) => (run2(dip, W, tp, maxb, 0.33, a, b).ret.toFixed(0) + '%').padStart(7)).join('');
  console.log(`${lab.padEnd(26)}${(r.ret.toFixed(0) + '%').padStart(7)}${(r.mdd.toFixed(0) + '%').padStart(6)}${String(r.n).padStart(6)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)}${(r.fill.toFixed(0) + '%').padStart(6)}  |${per}`);
};
const sizeFor = (dip: number, W: number, tp: number, maxb: number, target = 17) => {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run2(dip, W, tp, maxb, mid).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
};
const MODE = process.argv[2] || 'fixed';
if (MODE === 'eq') {
  console.log('── 동일 위험 MDD 17% (사이징을 맞춤) ──');
  console.log('설정'.padEnd(26) + '총익'.padStart(7) + '사이즈'.padStart(7) + '  |' + SP.map(s => s[0].padStart(7)).join(''));
  const C: Array<[string, number, number, number, number]> = [['F7 현행 (시가 시장가)', 0, 0, 6, 18], ['지정가 −1% · 1봉', 1, 1, 6, 18], ['지정가 −2% · 3봉', 2, 3, 6, 18],
    ['지정가 −3% · 3봉', 3, 3, 6, 18], ['지정가 −4% · 3봉', 4, 3, 6, 18], ['F7_p 현행', 0, 0, 4, 12], ['F7_p + 지정가 −3% · 3봉', 3, 3, 4, 12]];
  for (const [lab, dip, W, tp, mb] of C) {
    const sz = sizeFor(dip, W, tp, mb); const r = run2(dip, W, tp, mb, sz);
    const per = SP.map(([, a, b]) => (run2(dip, W, tp, mb, sz, a, b).ret.toFixed(0) + '%').padStart(7)).join('');
    console.log(`${lab.padEnd(26)}${(r.ret.toFixed(0) + '%').padStart(7)}${((sz * 100).toFixed(0) + '%').padStart(7)}  |${per}`);
  }
  process.exit(0);
}
console.log('설정'.padEnd(26) + '총익'.padStart(7) + 'MDD'.padStart(6) + '거래'.padStart(6) + '거래당'.padStart(8) + '체결률'.padStart(6) + '  |' + SP.map(s => s[0].padStart(7)).join(''));
console.log('── F7 청산(TP+6 · 3일) 고정, 진입만 바꿈 ──');
line('시가 시장가 (= 현행 F7)', 0, 0, 6, 18);
for (const dip of [1, 2, 3, 4]) for (const W of [1, 3, 6]) line(`지정가 −${dip}% · ${W}봉 유효`, dip, W, 6, 18);
console.log('── F7_p 청산(TP+4 · 2일) ──');
line('시가 시장가 (= 현행 F7_p)', 0, 0, 4, 12);
for (const dip of [1, 2, 3]) line(`지정가 −${dip}% · 3봉 유효`, dip, 3, 4, 12);
