/**
 * 15분봉 시뮬 (2026-10-02) — 4h 봉 내부 순서를 재현한다.
 *   A2  눌림 지정가 매수를 15m 로: 체결 시점·체결 직후 TP 가능 여부를 정확히
 *   B   실시간 돌파 진입: 4h 마감을 기다리지 않고 15m 단위 감시, 7일 고점(직전 42개 4h봉 고가) 돌파 순간 매수
 * 청산은 전부 F7 — TP 지정가 +6%(15m 고가 도달 시 목표가 체결) · 진입 후 72h 시간청산(시장가) · 스톱 없음.
 * 기간: 15m 캐시 2024-10-01 ~ 2026-10-02 (신호는 42개 4h봉 lookback 이후).
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
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000, Q = 15 * 60_000, H4 = 4 * 3600_000;
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
const M15 = new Map<string, Bar[]>(), M4 = new Map<string, Bar[]>();
for (const m of C28) {
  const f = fs.readdirSync(DIR).find(x => x.startsWith(`${m}_15m_2024-10-01_`)); if (!f) continue;
  const b: Bar[] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  M15.set(m, b);
  const agg: Bar[] = [];
  for (const x of b) {
    const w = Math.floor(x.ts / H4) * H4; const l = agg[agg.length - 1];
    if (l && l.ts === w) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume += x.volume; }
    else agg.push({ ts: w, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume });
  }
  M4.set(m, agg);
}
const COINS = [...M15.keys()];
const I15 = new Map(COINS.map(m => [m, new Map(M15.get(m)!.map((x, i) => [x.ts, i]))]));
const I4 = new Map(COINS.map(m => [m, new Map(M4.get(m)!.map((x, i) => [x.ts, i]))]));
const TS = [...new Set(COINS.flatMap(m => M15.get(m)!.map(x => x.ts)))].sort((a, b) => a - b);
const volStats = (b: Bar[], i: number, w = 30) => { let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w; return { mn, sd: Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)) }; };
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) => { if (i < 43) return false; const v = volStats(b, i); return b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && (b[i].volume - v.mn) / v.sd >= 0.5; };

type Mode = { kind: 'F6'; dip: number; W: number; pen: number } | { kind: 'RT'; vol: boolean; dip: number; late?: boolean; look?: number };
interface Pos { m: string; ep: number; vol: number; used: number; t0: number; last: number }
interface Ord { m: string; limit: number; used: number; exp: number }
function run(mode: Mode, size = 0.33, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = []; const pend: Ord[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, inTp = 0;
  const armed = new Map<string, boolean>();   // RT: 직전 15m 종가가 고점 아래였나 (새 돌파만 인정)
  const lateQ: Array<{ m: string; used: number }> = [];   // RT late: 감지 후 다음 15m 시가에 체결
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    const w = Math.floor(ts / H4) * H4;
    // 청산 (15m)
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = I15.get(q.m)!.get(ts); if (i === undefined) continue;
      const x = M15.get(q.m)![i]; q.last = x.close;
      let px = 0;
      if (ts > q.t0 && x.high >= q.ep * 1.06) px = q.ep * 1.06;
      else if (ts + Q - q.t0 >= 72 * 3600_000) px = x.close * (1 - slipOf(q.m));
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); }
    }
    // 대기 지정가
    for (let p = pend.length - 1; p >= 0; p--) {
      const o = pend[p]; const i = I15.get(o.m)!.get(ts); if (i === undefined) continue;
      const x = M15.get(o.m)![i];
      const pen = mode.kind === 'F6' ? mode.pen : 0;
      if (x.low <= o.limit * (1 - pen / 100)) {
        // 체결된 그 15m 봉 안에서 TP 까지 갔는지는 순서를 모르므로 보지 않는다 — 다음 15m 부터
        open.push({ m: o.m, ep: o.limit, vol: o.used * (1 - FEE) / o.limit, used: o.used, t0: ts, last: x.close }); pend.splice(p, 1);
      } else if (ts + Q >= o.exp) { cash += o.used; pend.splice(p, 1); }
    }
    // RT late: 직전 15m 에서 감지한 돌파를 이번 15m 시가로 체결
    while (lateQ.length) {
      const o = lateQ.shift()!; const i = I15.get(o.m)!.get(ts);
      if (i === undefined) { cash += o.used; continue; }
      const ep = M15.get(o.m)![i].open * (1 + slipOf(o.m));
      open.push({ m: o.m, ep, vol: o.used * (1 - FEE) / ep, used: o.used, t0: ts - 1, last: M15.get(o.m)![i].close });
    }
    // 진입
    for (const m of COINS) {
      const b4 = M4.get(m)!; const i4 = I4.get(m)!.get(w); const i15 = I15.get(m)!.get(ts);
      if (i4 === undefined || i15 === undefined || i4 < 90) continue;   // 14일 고점 변형까지 같은 시작점
      const x = M15.get(m)![i15];
      if (mode.kind === 'F6') {
        if (ts !== w) continue;                                // 4h 봉 시작 시점(= 직전 4h 마감 직후)에만 판단
        if (open.length + pend.length >= 3 || !sigF6(b4, i4 - 1)) continue;
        if (open.some(q => q.m === m) || pend.some(o => o.m === m)) continue;
        const used = cash * size; if (used < 5000) continue; cash -= used;
        if (mode.dip === 0) { const ep = x.open * (1 + slipOf(m)); open.push({ m, ep, vol: used * (1 - FEE) / ep, used, t0: ts - 1, last: x.close }); continue; }
        // 지정가는 봉 시작에 걸린다 → 같은 15m 봉부터 체결 가능
        pend.push({ m, limit: x.open * (1 - mode.dip / 100), used, exp: ts + mode.W * H4 });
        const o = pend[pend.length - 1];
        if (x.low <= o.limit * (1 - mode.pen / 100)) { pend.pop(); open.push({ m, ep: o.limit, vol: used * (1 - FEE) / o.limit, used, t0: ts, last: x.close }); }
      } else {
        const H = hiOf(b4, i4 - (mode.look ?? 42), i4);                       // 직전 42개 완성 4h봉 고가
        const wasBelow = armed.get(m) ?? false;
        armed.set(m, x.close < H);
        if (!wasBelow || x.high < H) continue;                 // 새 돌파만
        if (open.length + pend.length >= 3) continue;
        if (open.some(q => q.m === m) || pend.some(o => o.m === m) || lateQ.some(o => o.m === m)) continue;
        if (mode.vol) {                                        // 진행 중 4h봉 누적거래량 ≥ 평균+0.5σ
          let cum = 0; for (let j = i15; j >= 0 && M15.get(m)![j].ts >= w; j--) cum += M15.get(m)![j].volume;
          const v = volStats(b4, i4); if ((cum - v.mn) / v.sd < 0.5) { armed.set(m, true); continue; }   // 거래량 미달이면 다음 15m 에 재시도
        }
        const used = cash * size; if (used < 5000) continue; cash -= used;
        const cross = Math.max(H, x.open);                     // 갭으로 넘어오면 시가
        if (mode.late) { lateQ.push({ m, used }); continue; }
        if (mode.dip === 0) { const ep = cross * (1 + slipOf(m)); open.push({ m, ep, vol: used * (1 - FEE) / ep, used, t0: ts, last: x.close }); }
        else pend.push({ m, limit: cross * (1 - mode.dip / 100), used, exp: ts + Q + 4 * H4 });   // 다음 15m 부터, 4h 유효
      }
    }
    const eq = cash + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + lateQ.reduce((a, o) => a + o.used, 0) + pend.reduce((a, o) => a + o.used, 0) + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
const sizeFor = (mode: Mode) => { let lo = 0.02, hi = 0.95; for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (run(mode, mid).mdd > 17) hi = mid; else lo = mid; } return (lo + hi) / 2; };
const SP: Array<[string, number, number]> = [['24-10~12', Date.UTC(2024,9,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)], ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const f = (x: number) => (x.toFixed(0) + '%').padStart(7);
console.log(`[${REAL ? "현실 슬리피지(+스프레드½)" : "기본 슬리피지 0.05%"}] 15m ${COINS.length}코인 · ${new Date(TS[0]).toISOString().slice(0,10)} ~ ${new Date(TS[TS.length-1]).toISOString().slice(0,10)}`);
console.log('설정'.padEnd(30) + ' 고정총익 고정MDD  거래  거래당  MDD17총익 사이즈' + SP.map(s => s[0].padStart(9)).join('') + '  (구간별=33%고정)');
const ROWS: Array<[string, Mode]> = [
  ['F6 봉마감→시가 (=F7)', { kind: 'F6', dip: 0, W: 0, pen: 0 }],
  ['F6 + 지정가 −1%·1봉', { kind: 'F6', dip: 1, W: 1, pen: 0 }],
  ['F6 + 지정가 −1%·1봉 관통0.2', { kind: 'F6', dip: 1, W: 1, pen: 0.2 }],
  ['F6 + 지정가 −2%·3봉', { kind: 'F6', dip: 2, W: 3, pen: 0 }],
  ['F6 + 지정가 −3%·3봉', { kind: 'F6', dip: 3, W: 3, pen: 0 }],
  ['F6 + 지정가 −3%·3봉 관통0.2', { kind: 'F6', dip: 3, W: 3, pen: 0.2 }],
  ['F6 + 지정가 −4%·3봉', { kind: 'F6', dip: 4, W: 3, pen: 0 }],
  ['F6 + 지정가 −4%·3봉 관통0.2', { kind: 'F6', dip: 4, W: 3, pen: 0.2 }],
  ['RT 돌파 즉시 (가격만)', { kind: 'RT', vol: false, dip: 0 }],
  ['RT 돌파 즉시 + 거래량', { kind: 'RT', vol: true, dip: 0 }],
  ['RT 가격만 · 감지 15분 지연', { kind: 'RT', vol: false, dip: 0, late: true }],
  ['RT 가격만 · 3일 고점', { kind: 'RT', vol: false, dip: 0, look: 18 }],
  ['RT 가격만 · 14일 고점', { kind: 'RT', vol: false, dip: 0, look: 84 }],
  ['RT 돌파 후 −1% 지정가', { kind: 'RT', vol: false, dip: 1 }],
  ['RT 거래량 + −1% 지정가', { kind: 'RT', vol: true, dip: 1 }],
];
for (const [lab, md] of ROWS) {
  const r = run(md); const sz = sizeFor(md); const e = run(md, sz);
  console.log(`${lab.padEnd(30)}${f(r.ret)}${f(r.mdd)}${String(r.n).padStart(6)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(7)} ${f(e.ret)} ${((sz * 100).toFixed(0) + '%').padStart(5)}` + SP.map(([, a, b]) => f(run(md, 0.33, a, b).ret).padStart(9)).join(''));
}
