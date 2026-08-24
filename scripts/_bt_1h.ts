/**
 * 1시간 해상도로 지금 구조가 못 보는 것들을 본다. 페이퍼 추가용이 아니라 탐색용.
 *
 *   ① 청산을 1h로 관리하면? — 신호는 4h 그대로, 트레일링 스톱만 1시간마다 갱신.
 *      지금은 스톱이 4시간에 한 번만 움직여서, 급등 후 되돌림을 4시간 동안 못 피한다.
 *   ② 시간대 효과 — KST 몇 시에 난 돌파가 좋은가. 업비트는 한국 리테일 비중이 커서
 *      한국 낮 / 미국장 시간의 성격이 다를 수 있는데 지금껏 한 번도 안 봤다.
 *   ③ 요일 효과
 *   ④ 보유시간 곡선 — 진입 후 시간당 평균수익이 어떻게 흘러가나. MAX 14d가 맞는지,
 *      엣지가 언제 소멸하는지.
 *   ⑤ 순수 1h 전략 — 신호까지 1h로 내리면 (과거 스윕에선 나빴음, 트레일 청산으로 재확인)
 *
 * 청산 규칙 비교의 공정성을 위해 ①에서는 "신호마다 독립 거래"로 센다(동시보유 제약 없음).
 * 그래야 진입 집합이 완전히 같아서 차이가 청산 효과라고 말할 수 있다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, FR = (1 - FEE) ** 2 * (1 - SLIP) / (1 + SLIP);
const H = 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load1h(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_60m_'));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
/** 1h → 4h (UTC 4h 경계). 4개 다 있는 창만. 각 4h봉의 1h 하위봉도 같이 돌려준다. */
function to4h(h1: Bar[]) {
  const buckets = new Map<number, Bar[]>();
  for (const b of h1) {
    const key = Math.floor(b.ts / (4 * H)) * 4 * H;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(b);
  }
  const bars: Bar[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const s = buckets.get(key)!.sort((a, b) => a.ts - b.ts);
    if (s.length !== 4) continue;
    bars.push({ ts: key, open: s[0].open, high: Math.max(...s.map(x => x.high)), low: Math.min(...s.map(x => x.low)), close: s[3].close, volume: s.reduce((a, x) => a + x.volume, 0) });
  }
  return bars;
}
const volZ = (b: Bar[], i: number, w: number) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const mkSig = (LB: number, VW: number) => (b: Bar[], i: number) =>
  i >= LB + 1 && b[i - 1].high > hiOf(b, i - LB, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, VW) >= 0.5;

const DATA: Array<{ m: string; h1: Bar[]; h4: Bar[]; idx1: Map<number, number> }> = [];
for (const m of COINS) {
  const h1 = load1h(m); if (!h1 || h1.length < 2000) continue;
  DATA.push({ m, h1, h4: to4h(h1), idx1: new Map(h1.map((b, i) => [b.ts, i])) });
}

interface T { entryTs: number; exitTs: number; ret: number; hours: number }
/** 트레일링 청산을 지정한 봉 배열(관리 해상도)에서 굴린다 */
function trailExit(mgmt: Bar[], startIdx: number, ep: number, sl: number, act: number, gap: number, maxBars: number) {
  let peak = ep, tsl = ep * (1 + sl / 100), armed = false;
  for (let j = startIdx; j < mgmt.length && j - startIdx < maxBars; j++) {
    const bar = mgmt[j];
    if (bar.low <= tsl) return { px: tsl, ts: bar.ts, bars: j - startIdx + 1 };
    peak = Math.max(peak, bar.high);
    if (!armed && peak >= ep * (1 + act / 100)) armed = true;
    if (armed) tsl = Math.max(tsl, peak * (1 - gap / 100));
  }
  const last = mgmt[Math.min(startIdx + maxBars - 1, mgmt.length - 1)];
  return last ? { px: last.close, ts: last.ts, bars: maxBars } : null;
}

const sig4 = mkSig(42, 30);
/** 신호=4h, 청산 관리 해상도만 바꿔가며 비교 */
function runMixed(mgmtRes: '4h' | '1h', gap: number): T[] {
  const out: T[] = [];
  for (const d of DATA) {
    for (let i = 43; i < d.h4.length - 1; i++) {
      if (!sig4(d.h4, i)) continue;
      const entryBar = d.h4[i + 1];
      const ep = entryBar.open * (1 + SLIP);
      let r: { px: number; ts: number; bars: number } | null;
      if (mgmtRes === '4h') {
        r = trailExit(d.h4, i + 2, ep, -2, 2, gap, 84);
      } else {
        const s1 = d.idx1.get(entryBar.ts);
        if (s1 === undefined) continue;
        r = trailExit(d.h1, s1 + 4, ep, -2, 2, gap, 84 * 4);   // 1h 336봉 = 동일 14일
      }
      if (!r) continue;
      out.push({ entryTs: entryBar.ts, exitTs: r.ts, ret: FR * (r.px / ep) - 1, hours: (r.ts - entryBar.ts) / H });
    }
  }
  return out;
}
function stats(T: T[]) {
  if (!T.length) return null;
  const w = T.filter(t => t.ret > 0);
  const gw = w.reduce((a, t) => a + t.ret, 0), gl = Math.abs(T.filter(t => t.ret <= 0).reduce((a, t) => a + t.ret, 0));
  const seq = [...T].sort((a, b) => a.exitTs - b.exitTs);
  let eq = 0, pk = 0, mdd = 0;
  for (const t of seq) { eq += t.ret; pk = Math.max(pk, eq); mdd = Math.max(mdd, pk - eq); }
  const hrs = T.reduce((a, t) => a + t.hours, 0) / T.length;
  return { n: T.length, wr: w.length / T.length * 100, pf: gl > 0 ? gw / gl : 99, total: eq * 100, mdd: mdd * 100, hrs };
}
const row = (l: string, s: ReturnType<typeof stats>) => console.log(s
  ? `  ${l.padEnd(26)}| ${String(s.n).padStart(4)} | ${s.wr.toFixed(1).padStart(5)}% | ${s.pf.toFixed(2).padStart(5)} | ${(s.total.toFixed(0)+'%').padStart(7)} | ${(s.mdd.toFixed(0)+'%').padStart(5)} | ${s.hrs.toFixed(0).padStart(5)}h`
  : `  ${l.padEnd(26)}| 표본부족`);

console.log(`=== 1시간 해상도 탐색 (${DATA.length}코인, 2024-06~2026-08) ===\n`);
console.log('◆ ① 청산 관리 해상도 — 신호는 4h 동일, 트레일 스톱 갱신 주기만 변경');
console.log('  변형                        |    n |    WR |    PF |    총익 |   MDD | 평균보유');
const base = runMixed('4h', 2);
row('4h 관리 (현행)', stats(base));
row('1h 관리 (gap 2%)', stats(runMixed('1h', 2)));
row('1h 관리 (gap 3%)', stats(runMixed('1h', 3)));
row('1h 관리 (gap 4%)', stats(runMixed('1h', 4)));
row('1h 관리 (gap 6%)', stats(runMixed('1h', 6)));

console.log('\n◆ ② 진입 시간대별 (KST) — 4h 관리 기준');
const byHour = new Map<number, T[]>();
for (const t of base) {
  const h = new Date(t.entryTs + 9 * H).getUTCHours();
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h)!.push(t);
}
console.log('  KST 진입시각                 |    n |    WR |    PF |    총익 |   MDD | 평균보유');
for (const h of [...byHour.keys()].sort((a, b) => a - b)) row(`${String(h).padStart(2,'0')}시 진입`, stats(byHour.get(h)!));

console.log('\n◆ ③ 요일별 (KST)');
const WD = ['일','월','화','수','목','금','토'];
const byDay = new Map<number, T[]>();
for (const t of base) {
  const d = new Date(t.entryTs + 9 * H).getUTCDay();
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d)!.push(t);
}
console.log('  요일                        |    n |    WR |    PF |    총익 |   MDD | 평균보유');
for (const d of [...byDay.keys()].sort((a, b) => a - b)) row(`${WD[d]}요일 진입`, stats(byDay.get(d)!));

console.log('\n◆ ④ 보유시간 곡선 — 진입 후 N시간 시점의 평균/중앙 수익률 (청산 무시, 순수 가격)');
const marks = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336];
const acc = new Map<number, number[]>(marks.map(m => [m, []]));
for (const d of DATA) {
  for (let i = 43; i < d.h4.length - 1; i++) {
    if (!sig4(d.h4, i)) continue;
    const eb = d.h4[i + 1]; const s1 = d.idx1.get(eb.ts); if (s1 === undefined) continue;
    const ep = eb.open;
    for (const mk of marks) {
      const j = s1 + mk; if (j >= d.h1.length) continue;
      acc.get(mk)!.push(d.h1[j].close / ep - 1);
    }
  }
}
console.log('  경과      |     n | 평균수익 | 중앙수익 | 승률(>0)');
for (const mk of marks) {
  const v = acc.get(mk)!; if (!v.length) continue;
  const mean = v.reduce((a, x) => a + x, 0) / v.length * 100;
  const sorted = [...v].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] * 100;
  const wr = v.filter(x => x > 0).length / v.length * 100;
  const lbl = mk >= 24 ? `${mk / 24}일` : `${mk}시간`;
  console.log(`  ${lbl.padEnd(9)} | ${String(v.length).padStart(5)} | ${(mean.toFixed(2)+'%').padStart(8)} | ${(med.toFixed(2)+'%').padStart(8)} | ${(wr.toFixed(1)+'%').padStart(8)}`);
}

console.log('\n◆ ⑤ 순수 1h 전략 — 신호도 1h로 (lookback 168=7일, volZ 120, MAX 336=14일)');
const sig1 = mkSig(168, 120);
const pure: T[] = [];
for (const d of DATA) {
  for (let i = 169; i < d.h1.length - 1; i++) {
    if (!sig1(d.h1, i)) continue;
    const eb = d.h1[i + 1]; const ep = eb.open * (1 + SLIP);
    const r = trailExit(d.h1, i + 2, ep, -2, 2, 2, 336);
    if (!r) continue;
    pure.push({ entryTs: eb.ts, exitTs: r.ts, ret: FR * (r.px / ep) - 1, hours: (r.ts - eb.ts) / H });
  }
}
console.log('  변형                        |    n |    WR |    PF |    총익 |   MDD | 평균보유');
row('1h 신호 + 1h 관리', stats(pure));
row('4h 신호 + 4h 관리 (대조)', stats(base));
