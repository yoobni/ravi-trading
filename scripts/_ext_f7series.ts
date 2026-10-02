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
let LAG = 0;        // 신호를 N봉 늦춘다 (미래참조 검사)
let RANDF = 0;      // >0 이면 그 확률로 무작위 진입 (플라시보)
let SEED = 1;
const rnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
let FRIC = 1;
const setFric = (f: number) => { FRIC = f; FEE = FEE0 * f; SLIP = SLIP0 * f; };
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

/** 청산 설계 */
interface Design {
  kind: 'TRAIL' | 'TPONLY';
  sl?: number; act?: number; gap?: number;        // TRAIL
  rungs?: Array<[number, number]>;                // TPONLY: [목표%, 비중] 사다리
  maxb: number;                                   // 시간청산 (4h봉 수)
  disaster?: number;                               // 재난 스톱 % (음수) — 없으면 미사용
}
interface Pos { m: string; ep: number; vol: number; used: number; left: number; bars: number; peak: number; stop: number; armed: boolean; last: number; done: number[] }

export const EQLOG: { ts: number; eq: number }[] = [];
function run(d: Design, size: number, from = 0, to = Infinity) {
  EQLOG.length = 0;
  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, gapCost = 0, gapN = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let closed = false;
      if (d.kind === 'TRAIL') {
        if (bar.low <= q.stop) {                           // 스톱: 확인시점 종가 체결(현실)
          const px = bar.close;
          gapCost += (px / q.stop - 1); gapN++;
          cash += q.left * px * (1 - SLIP) * (1 - FEE); n++; sumR += (q.left * px * (1 - SLIP) * (1 - FEE)) / q.used - 1;
          closed = true;
        } else {
          q.peak = Math.max(q.peak, bar.high);
          if (!q.armed && q.peak >= q.ep * (1 + d.act! / 100)) q.armed = true;
          if (q.armed) q.stop = Math.max(q.stop, q.peak * (1 - d.gap! / 100));
        }
      } else {
        // TPONLY: 호가창에 올려둔 지정가 매도 — 고가가 닿으면 **그 가격에** 체결 (슬리피지 0)
        for (let k = 0; k < d.rungs!.length; k++) {
          if (q.done.includes(k)) continue;
          const [tp, w] = d.rungs![k];
          const target = q.ep * (1 + tp / 100);
          if (bar.high >= target) {
            const part = q.used * w;
            const volPart = (part / q.used) * (q.used * (1 - FEE) / q.ep);
            cash += volPart * target * (1 - FEE);          // 슬리피지 없음 = 지정가 체결
            q.left -= volPart; q.done.push(k);
            n++; sumR += (volPart * target * (1 - FEE)) / part - 1;
          }
        }
        if (d.disaster != null && bar.low <= q.ep * (1 + d.disaster / 100) && q.left > 0) {
          const px = bar.close;                             // 재난 스톱만 시장가(격차 발생)
          const basis = q.used * (1 - d.rungs!.filter((_, k) => q.done.includes(k)).reduce((a, r) => a + r[1], 0));
          gapCost += (px / (q.ep * (1 + d.disaster / 100)) - 1); gapN++;
          cash += q.left * px * (1 - SLIP) * (1 - FEE); n++; sumR += (q.left * px * (1 - SLIP) * (1 - FEE)) / Math.max(basis, 1) - 1;
          q.left = 0; closed = true;
        }
        if (q.left <= 1e-12) closed = true;
      }
      if (!closed && q.bars >= d.maxb) {                    // 시간청산 — 시장가, 격차 개념 없음
        const basis = d.kind === 'TPONLY'
          ? q.used * (1 - d.rungs!.filter((_, k) => q.done.includes(k)).reduce((a, r) => a + r[1], 0))
          : q.used;
        if (q.left > 0 && basis > 1) {
          cash += q.left * bar.close * (1 - SLIP) * (1 - FEE); n++;
          sumR += (q.left * bar.close * (1 - SLIP) * (1 - FEE)) / basis - 1;
        }
        closed = true;
      }
      if (closed) open.splice(p, 1);
    }
    if (open.length < 3) {
      for (const m of ORDER) {
        if (open.length >= 3) break;
        const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        const ok = RANDF > 0 ? rnd() < RANDF : sigF6(bb, i - 1 - LAG);
        if (!ok) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + SLIP); const used = cash * size;
        if (used < 5000) continue;
        cash -= used;
        const vol = used * (1 - FEE) / ep;
        open.push({ m, ep, vol, used, left: vol, bars: 0, peak: ep, stop: ep * (1 + (d.sl ?? -99) / 100), armed: false, last: ep, done: [] });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.left * q.last, 0);
    EQLOG.push({ ts, eq }); peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.left * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0,
           gap: gapN ? 100 * gapCost / gapN : 0, gapN };
}
/** F7(TP+6 · 3일 · 무스톱, 33%×3) 4h 자산곡선 → 일별(UTC 00 = KST 09) 수익 시계열. 축 E 상관 분석용. */
run({ kind: 'TPONLY', rungs: [[6, 1]], maxb: 18 }, 0.33);
const DAY = 86400e3; const byDay = new Map<number, number>();
for (const x of EQLOG) byDay.set(Math.floor(x.ts / DAY) * DAY, x.eq);
const ds = [...byDay.keys()].sort((a, b) => a - b);
const out = ds.slice(1).map((t, i) => ({ ts: t, r: byDay.get(t)! / byDay.get(ds[i])! - 1 }));
fs.writeFileSync(path.resolve(process.cwd(), 'data/research-ext/f7_daily.json'), JSON.stringify(out));
console.log('F7 daily', out.length, 'days', new Date(out[0].ts).toISOString().slice(0, 10), '~', new Date(out[out.length - 1].ts).toISOString().slice(0, 10), 'final eq', EQLOG[EQLOG.length - 1].eq.toFixed(0));
