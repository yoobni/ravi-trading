/**
 * 메커니즘 ② 실시간 감시(웹소켓) 손절 (2026-10-02)
 *
 * 업비트엔 스톱 주문이 없다. 4h 폴링 손절은 "봉이 닫힌 뒤 종가 시장가"라 체결 손실이 크다.
 * 상주 프로세스가 웹소켓으로 시세를 보다 스톱가를 건드리는 순간 시장가로 던지면 체결가 ≈ 스톱가 × (1 − WS).
 * WS(실시간 손절 슬리피지) 기본 0.25% = 반 스프레드 평균 0.165% + 지연 중 추가 하락 (_bt_watch_slip.ts, 1분 호가 35일).
 *
 * 데이터: 15분봉 28코인 2024-10-01~. 4h 봉은 15m 을 UTC 4h 경계로 합성(신호 판정용).
 * 진입: F6 신호(4h) 다음 4h 봉 시가 = 그 창의 첫 15m 봉 시가 (+SLIP). 33%×3.
 * 청산 판정은 15m 봉 단위. 진입 15m 봉부터 본다(시가가 봉의 첫 가격이므로 정당).
 *   TP   — 지정가. high ≥ 목표 → 목표가 체결.
 *   RT   — 실시간 스톱. low ≤ 스톱 → min(스톱, 시가) × (1−WS). 같은 15m 봉에서 TP 와 둘 다 닿으면 스톱 우선(보수적).
 *          본전·트레일의 스톱 상향은 그 봉 판정 "후"에 반영(같은 봉 고가로 올린 스톱에 같은 봉 저가가 걸리는 낙관 배제).
 *   BAR  — 4h 봉마감 손절(F7_sl 라이브 모델). TP 지정가는 그 창 안에서 계속 살아 있고,
 *          4h 경계에서 그 창 저가가 스톱을 건드렸으면 그 봉 종가 × (1−SLIP).
 *   TIME — 진입 후 72h(3일) 되는 15m 봉 종가 × (1−SLIP).
 * 평가: 자산은 4h 경계마다 마크(기존 하네스와 같은 해상도의 MDD).
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;
let WS = 0.0025;
const M15 = 15 * 60_000, H4 = 4 * 3600_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
const R15 = new Map<string, Bar[]>(), I15 = new Map<string, Map<number, number>>();
const R4 = new Map<string, Bar[]>(), I4 = new Map<string, Map<number, number>>();
for (const m of COINS) {
  const f = fs.readdirSync(DIR).find(x => x.startsWith(`${m}_15m_2024-10-01_`));
  if (!f) continue;
  const b: Bar[] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  R15.set(m, b); I15.set(m, new Map(b.map((x, i) => [x.ts, i])));
  const agg: Bar[] = [];
  for (const x of b) {
    const k = Math.floor(x.ts / H4) * H4;
    const a = agg[agg.length - 1];
    if (a && a.ts === k) { a.high = Math.max(a.high, x.high); a.low = Math.min(a.low, x.low); a.close = x.close; a.volume += x.volume; }
    else agg.push({ ts: k, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume });
  }
  R4.set(m, agg); I4.set(m, new Map(agg.map((x, i) => [x.ts, i])));
}
const ORDER = COINS.filter(m => R15.has(m));
const TS15 = [...new Set([...R15.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);

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
// 신호 미리 계산: 4h 봉 i 가 신호면 진입창 = R4[i+1].ts
const SIG = new Map<number, string[]>();
for (const m of ORDER) {
  const b = R4.get(m)!;
  for (let i = 45; i < b.length - 1; i++) if (sigF6(b, i)) { const t = b[i + 1].ts; if (!SIG.has(t)) SIG.set(t, []); SIG.get(t)!.push(m); }
}

interface Design {
  tp: number | null;                 // TP 지정가 % (null = 없음)
  stop?: number;                     // 초기 스톱 % (음수)
  mode?: 'RT' | 'BAR';               // 스톱 체결 방식
  poll?: number;                     // BAR 판정 간격(시간) — 기본 4
  be?: number;                       // +be% 도달 시 스톱 → 진입가
  act?: number; gap?: number;        // 트레일: +act% 후 고점−gap%
  hold: number;                      // 시간청산 (시간)
  dip?: number; W?: number;          // 눌림 지정가 매수: 시가×(1−dip%), W개 4h봉 유효
}
interface Pos { m: string; ep: number; vol: number; used: number; t0: number; peak: number; stop: number | null; armed: boolean; touched: boolean; last: number }
interface Pend { m: string; limit: number; used: number; until: number }

function run(d: Design, size = 0.33, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = []; const pend: Pend[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, nStop = 0, sumStopR = 0;
  const POLL = (d.poll ?? 4) * 3600_000;
  const close = (p: number, px: number, isStop = false) => { const q = open[p]; const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; if (isStop) { nStop++; sumStopR += px / q.ep - 1; } open.splice(p, 1); };
  const mkPos = (m: string, ep: number, used: number, t0: number): Pos => ({
    m, ep, vol: used * (1 - FEE) / ep, used, t0, peak: ep, stop: d.stop != null ? ep * (1 + d.stop / 100) : null, armed: false, touched: false, last: ep });
  for (const ts of TS15) {
    if (ts < from || ts > to) continue;
    const boundary = ts % H4 === 0;
    // ── 4h 경계: BAR 손절 판정(직전 창) → 자산 마크 → 신호 진입/주문
    if (d.mode === 'BAR' && ts % POLL === 0) for (let p = open.length - 1; p >= 0; p--) if (open[p].touched) close(p, open[p].last * (1 - SLIP), true);
    if (boundary) {
      const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
      peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
      for (const m of SIG.get(ts) || []) {
        if (open.length + pend.length >= 3) break;
        if (open.some(q => q.m === m) || pend.some(o => o.m === m)) continue;
        const i = I15.get(m)!.get(ts); if (i === undefined) continue;
        const used = cash * size; if (used < 5000) continue;
        cash -= used;
        const ref = R15.get(m)![i].open;
        if (!d.dip) open.push(mkPos(m, ref * (1 + SLIP), used, ts));
        else pend.push({ m, limit: ref * (1 - d.dip / 100), used, until: ts + d.W! * H4 });
      }
    }
    // ── 눌림 매수 주문 체결/만료
    for (let p = pend.length - 1; p >= 0; p--) {
      const o = pend[p];
      if (ts >= o.until) { cash += o.used; pend.splice(p, 1); continue; }
      const i = I15.get(o.m)!.get(ts); if (i === undefined) continue;
      const bar = R15.get(o.m)![i];
      if (bar.low <= o.limit) { open.push(mkPos(o.m, Math.min(o.limit, bar.open), o.used, ts)); pend.splice(p, 1); }
    }
    // ── 청산 (15m)
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = I15.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = R15.get(q.m)![i];
      if (q.t0 === ts && d.dip) { q.last = bar.close; continue; }  // 눌림 체결 봉: 봉 내 순서 불명 → 청산 판정 안 함
      q.last = bar.close;
      const target = d.tp != null ? q.ep * (1 + d.tp / 100) : Infinity;
      if (q.stop != null && d.mode !== 'BAR' && bar.low <= q.stop) { close(p, Math.min(q.stop, bar.open) * (1 - WS), true); continue; }
      if (bar.high >= target) { close(p, Math.max(target, bar.open)); continue; }
      if (q.stop != null && d.mode === 'BAR' && bar.low <= q.stop) q.touched = true;
      if (ts + M15 - q.t0 >= d.hold * 3600_000) { close(p, bar.close * (1 - SLIP)); continue; }
      // 스톱 상향 (다음 봉부터 유효)
      q.peak = Math.max(q.peak, bar.high);
      if (d.be != null && q.peak >= q.ep * (1 + d.be / 100)) q.stop = Math.max(q.stop ?? 0, q.ep);
      if (d.act != null) {
        if (!q.armed && q.peak >= q.ep * (1 + d.act / 100)) q.armed = true;
        if (q.armed) q.stop = Math.max(q.stop ?? 0, q.peak * (1 - d.gap! / 100));
      }
    }
  }
  const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, stopShare: n ? 100 * nStop / n : 0, stopR: nStop ? 100 * sumStopR / nStop : 0 };
}
const sizeFor = (d: Design, target = 17) => {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run(d, mid).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
};
const SP: Array<[string, number, number]> = [['24Q4', Date.UTC(2024, 9, 1), Date.UTC(2024, 11, 31, 23)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31, 23)], ['2026YTD', Date.UTC(2026, 0, 1), Infinity]];
const per = (d: Design, s: number) => SP.map(([, a, b]) => (run(d, s, a, b).ret.toFixed(0) + '%').padStart(7)).join('');
const head = () => console.log('설계'.padEnd(30) + '총익'.padStart(7) + 'MDD'.padStart(6) + '거래'.padStart(5) + '거래당'.padStart(8) + '손절%'.padStart(6) + '손절체결'.padStart(7) + ' |' + SP.map(s => s[0].padStart(7)).join('') + ' ‖ MDD17%:총익 size |' + SP.map(s => s[0].padStart(7)).join(''));
const row = (lab: string, d: Design, eq = true) => {
  const r = run(d);
  let tail = '';
  if (eq) { const s = sizeFor(d); const e = run(d, s); tail = ` ‖ ${(e.ret.toFixed(0) + '%').padStart(7)} ${(s * 100).toFixed(0).padStart(3)}% |${per(d, s)}`; }
  console.log(`${lab.padEnd(30)}${(r.ret.toFixed(0) + '%').padStart(7)}${(r.mdd.toFixed(0) + '%').padStart(6)}${String(r.n).padStart(5)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)}${r.stopShare.toFixed(0).padStart(6)}${(r.stopShare ? r.stopR.toFixed(2) : '').padStart(7)} |${per(d, 0.33)}${tail}`);
  return r;
};

const PART = process.argv[2] || 'all';
console.log(`15m ${R15.size}코인 ${new Date(TS15[0]).toISOString().slice(0, 10)}~${new Date(TS15[TS15.length - 1]).toISOString().slice(0, 10)}, 신호창 ${SIG.size}, WS ${(WS * 100).toFixed(2)}%\n`);
const F7: Design = { tp: 6, hold: 72 };
if (PART === 'all' || PART === 'a') {
  head();
  console.log('── 1·2. 기준선 / 고정 손절: 실시간(RT) vs 4h 봉마감(BAR) ──');
  row('F7 (TP6 · 3일 · 무스톱)', F7);
  for (const s of [-2, -3, -5, -8]) {
    row(`손절 ${s}% RT`, { ...F7, stop: s, mode: 'RT' });
    row(`손절 ${s}% BAR`, { ...F7, stop: s, mode: 'BAR' });
  }
}
if (PART === 'all' || PART === 'b') {
  head();
  console.log('── 3. 본전 스톱 (RT, 초기 스톱 없음 / −5%) ──');
  for (const be of [2, 3, 4]) {
    row(`본전@+${be}% · 무초기스톱`, { ...F7, be, stop: undefined, mode: 'RT' });
    row(`본전@+${be}% · 초기 −5%`, { ...F7, be, stop: -5, mode: 'RT' });
  }
  console.log('── 4. 실시간 트레일 (RT) ──');
  for (const [act, gap] of [[2, 2], [3, 3], [4, 2], [4, 3], [5, 3]]) {
    row(`트레일 +${act}/−${gap} · TP6 · 3일`, { ...F7, act, gap, mode: 'RT' });
    row(`트레일 +${act}/−${gap} · TP없음 · 3일`, { tp: null, hold: 72, act, gap, mode: 'RT' });
  }
  row('트레일 +2/−2 · 초기−2 · TP없음 · 14일 (=A2 RT)', { tp: null, hold: 336, act: 2, gap: 2, stop: -2, mode: 'RT' });
}
if (PART === 'c') {
  // 결합·반증은 a/b 결과를 본 뒤 argv 로 후보를 지정해 돌린다
  const cand = JSON.parse(process.argv[3]) as Array<[string, Design]>;
  for (const ws of (process.env.WS_LIST || "0.0025,0.0075").split(",").map(Number)) {
    WS = ws;
    console.log(`\n── WS ${(ws * 100).toFixed(2)}% ──`); head();
    for (const [lab, d] of cand) row(lab, d);
  }
}
