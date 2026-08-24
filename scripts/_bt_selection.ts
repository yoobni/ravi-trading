/**
 * 종목 선발 방식 비교 — 신호가 슬롯보다 많을 때 "무엇을 살 것인가".
 *
 * 현행: 신호가 뜬 순서대로 채운다(같은 틱이면 코인 배열 순서) = 사실상 무작위.
 * 대안: 그 틱에 뜬 신호를 점수로 줄 세워 상위만 산다 = 횡단면 경쟁 선발.
 *
 * 신호(F6 돌파)·청산(트레일링 A2)·배분(33%×3)은 전부 고정하고 선발 규칙만 바꾼다.
 * 그래야 차이가 선발 효과라고 말할 수 있다.
 *
 * 실행: npx tsx scripts/_bt_selection.ts
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
const hi = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sma = (b: Bar[], i: number, n: number) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += b[j].close; return s / n; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hi(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

const btc = SERIES.get('KRW-BTC')!, btcIdx = IDX.get('KRW-BTC')!;
function btcRet(ts: number, look: number): number | null {
  const i = btcIdx.get(ts); if (i === undefined || i < look) return null;
  return btc[i].close / btc[i - look].close - 1;
}

/** 선발 점수 — 클수록 먼저 산다 */
type Ranker = { name: string; score: (b: Bar[], i: number, ts: number, m: string) => number };
const RANKERS: Ranker[] = [
  { name: '현행(신호 순서)',        score: () => 0 },
  { name: '거래량 z 높은 순',        score: (b, i) => volZ(b, i, 30) },
  { name: '거래량 z 낮은 순',        score: (b, i) => -volZ(b, i, 30) },
  { name: '돌파 강도 큰 순',         score: (b, i) => b[i].close / b[i - 1].high - 1 },
  { name: '돌파 강도 작은 순',       score: (b, i) => -(b[i].close / b[i - 1].high - 1) },
  { name: '7일 모멘텀 높은 순',      score: (b, i) => (i >= 42 ? b[i].close / b[i - 42].close - 1 : 0) },
  { name: '7일 모멘텀 낮은 순',      score: (b, i) => -(i >= 42 ? b[i].close / b[i - 42].close - 1 : 0) },
  { name: 'BTC 대비 상대강도 높은 순', score: (b, i, ts) => { const r = btcRet(ts, 180); return (i >= 180 && r !== null) ? (b[i].close / b[i - 180].close - 1) - r : 0; } },
  { name: '30일선 이격 작은 순',      score: (b, i) => (i >= 180 ? -(b[i].close / sma(b, i, 180) - 1) : 0) },
  // ── 현행 "신호 순서"의 정체 검증: COINS 배열은 대략 시총 순이라
  //    점수를 안 주면 stable sort 가 대형주를 먼저 채운다. 즉 숨은 규칙 = 대형주 우선.
  { name: '배열 역순(소형주 우선)',     score: (b, i, ts, m) => COINS.indexOf(m) },
  { name: '거래대금 큰 순',           score: (b, i) => medTurnover(b, i) },
  { name: '거래대금 작은 순',          score: (b, i) => -medTurnover(b, i) },
];

/** 최근 180봉(30일) 거래대금 중앙값 — 시점 기준으로만 계산(lookahead 없음) */
function medTurnover(b: Bar[], i: number): number {
  if (i < 180) return 0;
  const v: number[] = [];
  for (let j = i - 180; j < i; j++) v.push(b[j].close * b[j].volume);
  v.sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
}

interface Res { total: number; mdd: number; trades: number; wr: number; pf: number }
function run(rank: Ranker, positionPct = 0.33, maxConcurrent = 3, from?: number, to?: number): Res {
  const SL = -2, ACT = 2, GAP = 2, MAXB = 84;
  let cash = INIT;
  const open: Array<{ market: string; entryPrice: number; vol: number; cashUsed: number; ei: number; peak: number; tsl: number; armed: boolean }> = [];
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0;
  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const t1raw = to ? TS.findIndex(x => x >= to) : TS.length;
  const t1 = t1raw < 0 ? TS.length : t1raw;

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = SERIES.get(pos.market)!; const i = IDX.get(pos.market)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.entryPrice * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const proceeds = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / pos.cashUsed - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        open.splice(p, 1);
      }
    }
    if (open.length < maxConcurrent && t < t1 - 20) {
      // 이 봉에 뜬 신호를 모두 모아 점수로 줄 세운다
      const cands: Array<{ m: string; i: number; s: number }> = [];
      for (const [m, b] of SERIES) {
        if (open.some(p => p.market === m)) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
        if (!sigF6(b, i)) continue;
        cands.push({ m, i, s: rank.score(b, i, ts, m) });
      }
      cands.sort((a, b) => b.s - a.s);
      for (const c of cands) {
        if (open.length >= maxConcurrent) break;
        const b = SERIES.get(c.m)!;
        const use = cash * positionPct; if (use < 5000) continue;
        const ep = b[c.i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ market: c.m, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, ei: c.i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
      }
    }
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) eq += p.vol * SERIES.get(p.market)![i].close; }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  let fin = cash;
  const lastTs = TS[Math.min(t1 - 1, TS.length - 1)];
  for (const p of open) { const i = IDX.get(p.market)!.get(lastTs); if (i !== undefined) fin += p.vol * SERIES.get(p.market)![i].close; }
  return { total: (fin / INIT - 1) * 100, mdd, trades: n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
}

console.log(`=== 종목 선발 규칙 비교 (${SERIES.size}코인 4h, ${new Date(TS[200]).toISOString().slice(0,7)}~${new Date(TS[TS.length-1]).toISOString().slice(0,7)}) ===`);
console.log('  신호=F6 돌파 / 청산=트레일링 A2 / 배분=33%×3 고정, 선발 규칙만 변경\n');
console.log('  선발 규칙                  |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF');
const results = RANKERS.map(r => [r, run(r)] as const);
for (const [r, s] of results) {
  console.log(`  ${r.name.padEnd(24)}| ${(s.total.toFixed(0)+'%').padStart(8)} | ${(s.mdd.toFixed(1)+'%').padStart(6)} | ${(s.mdd>0?s.total/s.mdd:0).toFixed(2).padStart(8)} | ${String(s.trades).padStart(4)} | ${s.wr.toFixed(1).padStart(4)}% | ${s.pf.toFixed(2).padStart(5)}`);
}
