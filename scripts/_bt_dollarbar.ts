/**
 * 달러바(거래대금 기준 봉) — 지금까지 시험한 모든 것이 "시간봉"이었다는 사각지대.
 *
 * 시간봉은 활동량과 무관하게 시계로 자른다. 새벽 3시의 4시간과 저녁 9시의 4시간이
 * 같은 한 봉이 되고, "7일 신고가"는 죽은 시간과 활발한 시간을 섞어서 잰다.
 * 달러바는 누적 거래대금이 문턱을 넘을 때마다 봉을 닫는다 —
 * 활발하면 빨리, 조용하면 느리게 형성된다. 같은 데이터의 다른 표본화다.
 * (1h/4h 해상도 변경이 실패한 것과는 성격이 다르다. 그건 같은 잣대의 눈금만 바꾼 것.)
 *
 * 기대: F6 의 volZ≥0.5 필터는 "이 봉이 유난히 활발했나"를 묻는 조잡한 대용품인데,
 *       달러바는 그걸 구조적으로 내장한다. 돌파가 "활동량 기준으로" 신고가인지 본다.
 *
 * 비교 공정성:
 *   - 문턱은 직전 30일 1h 거래대금 평균 × 4 (= 평균적으로 4시간에 한 봉). 과거만 사용.
 *   - 룩백 42봉, volZ 30봉, 트레일 A2, MAX 84봉 — 전부 시간봉 F6 와 동일한 숫자.
 *   - 진입은 봉 완성 다음 1h 시가, 포트폴리오는 1h 시계로 돌린다.
 *   - MDD 는 이분탐색으로 고정 후 비교, 기간분할 4구간.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84, LB = 42, VW = 30;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string, unit: number): Bar[] | null {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(`${m}_${unit}m_`));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const H1 = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m, 60); if (b && b.length > 1000) H1.set(m, b); }
const MKTS = [...H1.keys()];
// 1h 공통 시계 (포트폴리오 루프의 기준)
const TS = [...new Set(MKTS.flatMap((m) => H1.get(m)!.map((b) => b.ts)))].sort((a, b) => a - b);
const TIDX = new Map(TS.map((t, i) => [t, i]));

/** 달러바 한 개 — endIdx1h 는 이 봉이 완성된 1h 봉의 인덱스(그 봉 마감 시점에 신호 판정 가능) */
interface DBar extends Bar { endTs: number }
/**
 * 누적 거래대금이 문턱을 넘으면 봉을 닫는다.
 * 문턱 = 직전 W봉 1h 거래대금 평균 × mult (과거만 사용 — 미래참조 없음)
 */
function buildDollarBars(h1: Bar[], mult: number, W = 720): DBar[] {
  const out: DBar[] = [];
  let sum = 0, cnt = 0;            // 롤링 거래대금 합
  let acc = 0;                     // 현재 형성 중인 봉의 누적 거래대금
  let o = 0, hi = -Infinity, lo = Infinity, vol = 0, startTs = 0, open = false;
  for (let i = 0; i < h1.length; i++) {
    const turn = h1[i].close * h1[i].volume;
    if (!open) { o = h1[i].open; hi = -Infinity; lo = Infinity; vol = 0; acc = 0; startTs = h1[i].ts; open = true; }
    hi = Math.max(hi, h1[i].high); lo = Math.min(lo, h1[i].low); vol += h1[i].volume; acc += turn;
    // 문턱은 "이 봉이 시작되기 전까지"의 정보로 정한다
    const thr = cnt >= W ? (sum / cnt) * mult : Infinity;
    if (Number.isFinite(thr) && acc >= thr) {
      out.push({ ts: startTs, endTs: h1[i].ts, open: o, high: hi, low: lo, close: h1[i].close, volume: vol });
      open = false;
    }
    sum += turn; cnt++;
    if (cnt > W) { sum -= h1[i - W].close * h1[i - W].volume; cnt = W; }
  }
  return out;
}

const volZ = (b: Bar[], i: number, w = VW) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= LB + 1 && b[i - 1].high > hiOf(b, i - LB, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;

/** 코인별: 각 1h 인덱스에서 "그 시점까지 완성된 달러바 개수" */
function buildSeries(mult: number) {
  const bars = new Map<string, DBar[]>();
  const doneAt = new Map<string, Map<number, number>>();   // 1h ts → 완성된 달러바 개수
  for (const m of MKTS) {
    const db = buildDollarBars(H1.get(m)!, mult);
    bars.set(m, db);
    const mp = new Map<number, number>();
    for (let k = 0; k < db.length; k++) mp.set(db[k].endTs, k + 1);
    doneAt.set(m, mp);
  }
  return { bars, doneAt };
}

interface Pos { m: string; ep: number; vol: number; used: number; entryBar: number; peak: number; sl: number; armed: boolean; lastPx: number }
/** @param mode 'dollar' = 달러바 신호/청산, 'time4h' = 4시간봉(대조군) */
function run(mode: 'dollar' | 'time4h', mult: number, pct: number, maxCon: number, from: number, to?: number) {
  const SER = mode === 'dollar' ? buildSeries(mult) : TIME4H;
  const { bars, doneAt } = SER;
  let cash = INIT;
  const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0, deploySum = 0, nBars = 0;
  const h1idx = new Map(MKTS.map((m) => [m, new Map(H1.get(m)!.map((b, i) => [b.ts, i]))]));
  const t0 = Math.max(TS.findIndex((t) => t >= from), 800);
  const t1 = to ? (TS.findIndex((t) => t >= to) < 0 ? TS.length : TS.findIndex((t) => t >= to)) : TS.length;

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    // 청산 — 해당 코인의 새 봉이 완성된 시점에만 판정
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p];
      const k = doneAt.get(pos.m)!.get(ts);
      if (k === undefined) continue;
      const db = bars.get(pos.m)!; const bar = db[k - 1];
      if (k - 1 <= pos.entryBar) continue;
      let px = 0, done = false;
      if (bar.low <= pos.sl) { px = pos.sl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.sl = Math.max(pos.sl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (k - 1 - pos.entryBar) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const pr = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += pr;
        const r = pr / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        open.splice(p, 1);
      }
    }
    let eqNow = cash;
    for (const p of open) { const i = h1idx.get(p.m)!.get(ts); eqNow += p.vol * (i !== undefined ? H1.get(p.m)![i].close : p.lastPx); }
    // 진입 — 이 1h 시점에 완성된 봉에서 신호가 났으면 다음 1h 시가에 산다
    if (open.length < maxCon && t < t1 - 30) {
      for (const m of MKTS) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.m === m)) continue;
        const k = doneAt.get(m)!.get(ts);
        if (k === undefined) continue;
        const db = bars.get(m)!;
        if (!sigF6(db, k - 1)) continue;
        const i = h1idx.get(m)!.get(ts);
        if (i === undefined || i + 1 >= H1.get(m)!.length) continue;
        const use = Math.min(cash, eqNow * pct);
        if (use < 5000) continue;
        const ep = H1.get(m)![i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, entryBar: k - 1, peak: ep, sl: ep * (1 + SL / 100), armed: false, lastPx: ep });
      }
    }
    let posVal = 0;
    for (const p of open) { const i = h1idx.get(p.m)!.get(ts); if (i !== undefined) p.lastPx = H1.get(p.m)![i].close; posVal += p.vol * p.lastPx; }
    const eq = cash + posVal;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    nBars++; deploySum += eq > 0 ? posVal / eq : 0;
  }
  let fin = cash;
  for (const p of open) fin += p.vol * p.lastPx;
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, deploy: nBars ? deploySum / nBars * 100 : 0 };
}

/** 대조군: 1h 를 4개씩 묶은 시간봉(같은 코드 경로로 비교하기 위해 같은 형식으로 만든다) */
const TIME4H = (() => {
  const bars = new Map<string, DBar[]>(); const doneAt = new Map<string, Map<number, number>>();
  const FOUR = 4 * 3600_000;
  for (const m of MKTS) {
    const h = H1.get(m)!;
    // ⚠ 인덱스가 아니라 **시각**으로 묶는다. 1h 봉이 중간에 빠지면 고정 간격 묶기는
    //   그 뒤로 계속 어긋나 대조군이 실제 F6 와 달라진다.
    //   캐시 ts 는 UTC ms 이고 Upbit 4h 봉은 UTC 00/04/08/12/16/20 시작 → ts 를 4h 로 내림한다.
    const groups = new Map<number, Bar[]>();
    for (const b of h) {
      const key = Math.floor(b.ts / FOUR) * FOUR;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }
    const out: DBar[] = []; const mp = new Map<number, number>();
    for (const key of [...groups.keys()].sort((a, b) => a - b)) {
      const seg = groups.get(key)!.sort((a, b) => a.ts - b.ts);
      if (seg.length < 4) continue;   // 불완전한 봉은 버린다
      out.push({
        ts: key, endTs: seg[seg.length - 1].ts,
        open: seg[0].open, high: Math.max(...seg.map((x) => x.high)), low: Math.min(...seg.map((x) => x.low)),
        close: seg[seg.length - 1].close, volume: seg.reduce((s, x) => s + x.volume, 0),
      });
      mp.set(seg[seg.length - 1].ts, out.length);
    }
    bars.set(m, out); doneAt.set(m, mp);
  }
  return { bars, doneAt };
})();

const D = (s: string) => Date.parse(s + 'T00:00:00Z');
function matchMdd(make: (pct: number) => ReturnType<typeof run>, target: number) {
  let lo = 0.02, hi = 1.2;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (make(mid).mdd > target) hi = mid; else lo = mid; }
  return { pct: (lo + hi) / 2, res: make((lo + hi) / 2) };
}
const FROM = TS[800], TARGET = 17.0;
console.log(`=== 달러바 vs 시간봉 (${MKTS.length}코인, ${new Date(FROM).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}) ===\n`);
// 달러바 개수 감각
{
  const s = buildSeries(4);
  const cnts = MKTS.map((m) => s.bars.get(m)!.length);
  const t4 = MKTS.map((m) => TIME4H.bars.get(m)!.length);
  console.log(`  봉 개수 — 달러바(×4) 평균 ${Math.round(cnts.reduce((a, b) => a + b, 0) / cnts.length)} vs 4시간봉 평균 ${Math.round(t4.reduce((a, b) => a + b, 0) / t4.length)}`);
}
console.log(`\n◆ 동일 MDD(${TARGET}%) 고정`);
console.log('  구성                    | 그때pct |    총익 | 대조군대비 | 거래 |    WR |    PF | 가동률');
console.log('  ' + '-'.repeat(92));
const ctrl = matchMdd((pct) => run('time4h', 0, pct, 3, FROM), TARGET);
const row = (l: string, m: { pct: number; res: ReturnType<typeof run> }) => console.log(
  `  ${l.padEnd(24)}| ${((m.pct * 100).toFixed(1) + '%').padStart(7)} | ${(m.res.total.toFixed(0) + '%').padStart(7)} | ${(((m.res.total / ctrl.res.total - 1) * 100).toFixed(0) + '%').padStart(8)} | ${String(m.res.n).padStart(4)} | ${m.res.wr.toFixed(1).padStart(4)}% | ${m.res.pf.toFixed(2).padStart(5)} | ${(m.res.deploy.toFixed(0) + '%').padStart(6)}`);
row('4시간봉 (대조군)', ctrl);
for (const mult of [2, 3, 4, 6, 8]) row(`달러바 ×${mult}`, matchMdd((pct) => run('dollar', mult, pct, 3, FROM), TARGET));
