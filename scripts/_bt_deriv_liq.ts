/**
 * 축 D-5: 청산 캐스케이드 근사(바이낸스 OI 급감 + 업비트 급락) 롱 — 포트폴리오 (리서치 전용)
 * A) 15m 2024-10~: 판단 = 메트릭 정시 t 공개(t+5분), 진입 = t+15분 15m 봉 시가(시장가, 코인별 스프레드½)
 * B) 4h 2022-06~: OI 를 4h 경계에서 봄, 진입 = 다음 4h 봉 시가(최대 4h 지연, 보수적)
 * 청산: TP 지정가 +x% / N시간 시간청산(시장가). 무스톱. 동시 K슬롯, 코인 중복 금지.
 */
import fs from 'fs';
import path from 'path';
import { BARS, IDX, TS, FOUR, DAY, SPLIT, sigF6 } from './_bt_deriv_port';
const H = 3600e3, Q = 15 * 60e3;
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
let CX = 1, EXTRA = 0; const slip = (c: string) => CX * Math.max(0.0005, (SPREAD['KRW-' + c] ?? 20) / 2 / 1e4) + EXTRA; const FEE = () => 0.0005 * CX;
const OI = new Map<string, Map<number, number>>();
for (const c of BARS.keys()) {
  const f = path.resolve('data/research-ext/binance/metrics', c + '.csv'); if (!fs.existsSync(f)) continue;
  const m = new Map<number, number>();
  for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(1)) { const p = l.split(','); const t = Date.parse(p[0].replace(' ', 'T') + 'Z'); const v = +p[1]; if (Number.isFinite(t) && v > 0) m.set(t, v); }
  OI.set(c, m);
}
const M15 = new Map<string, any[]>(), I15 = new Map<string, Map<number, number>>();
for (const c of BARS.keys()) { const f = fs.readdirSync('data/candle-cache').find(x => x.startsWith(`KRW-${c}_15m_`)); if (!f) continue; const b = JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')); M15.set(c, b); I15.set(c, new Map(b.map((x: any, i: number) => [x.ts, i]))); }
interface Cfg { k: number; y: number; win: number; tp: number | null; hold: number; slots: number; oiMin?: number; noOI?: boolean; excl?: Set<number> }
// ── A) 15m
function runA(cfg: Cfg, size: number, from = Date.UTC(2024, 9, 8), to = Infinity, randomize = 0) {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, sumR = 0; const open: any[] = []; const coins = [...M15.keys()];
  const t0 = Math.max(from, Date.UTC(2024, 9, 8)); const tEnd = Math.min(to, Math.min(...coins.map(c => M15.get(c)!.at(-1).ts)));
  const last = new Map<string, number>(); let seed = randomize;
  for (let t = Math.ceil(t0 / Q) * Q; t <= tEnd; t += Q) {
    // 청산
    for (let p = open.length - 1; p >= 0; p--) { const q = open[p]; const i = I15.get(q.c)!.get(t); if (i === undefined) continue; const b = M15.get(q.c)![i]; q.last = b.close;
      let px = 0; if (cfg.tp != null && t > q.t0 && b.high >= q.ep * (1 + cfg.tp / 100)) px = q.ep * (1 + cfg.tp / 100);
      else if (t - q.t0 >= cfg.hold * H) px = b.open * (1 - slip(q.c));
      if (px) { const got = q.vol * px * (1 - FEE()); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); } }
    // 진입: t 가 정시+15분일 때, 정시 t−15분 메트릭 스냅샷(공개 t−10분) 기준
    if (t % H === Q && open.length < cfg.slots) {
      const mt = t - Q;
      for (const c of coins) {
        if (open.length >= cfg.slots) break; if (open.some(q => q.c === c) || (last.get(c) ?? 0) > t - DAY) continue;
        let hit: boolean;
        if (randomize) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; hit = seed / 0x7fffffff < randomize; }
        else {
          if (cfg.excl?.has(Math.floor(t / DAY))) continue;
          const o1 = OI.get(c)?.get(mt), o0 = OI.get(c)?.get(mt - cfg.win * H); if (!o1 || !o0) continue;
          const dOI = o1 / o0 - 1;
          if (cfg.noOI) { if (cfg.oiMin != null && dOI < cfg.oiMin) continue; } else if (dOI > -cfg.k) continue;
          const i1 = I15.get(c)!.get(mt), i0 = I15.get(c)!.get(mt - cfg.win * H); if (i1 === undefined || i0 === undefined) continue;
          hit = M15.get(c)![i1].open / M15.get(c)![i0].open - 1 <= -cfg.y;
        }
        if (!hit) continue;
        const i = I15.get(c)!.get(t); if (i === undefined) continue;
        const used = cash * size; if (used < 5000) continue; const ep = M15.get(c)![i].open * (1 + slip(c));
        cash -= used; open.push({ c, ep, vol: used * (1 - FEE()) / ep, used, t0: t, last: ep }); last.set(c, t);
      }
    }
    if (t % H === 0) { const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
const eqA = (cfg: Cfg, rnd = 0) => { let lo = 0.01, hi = 0.95; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (runA(cfg, m, 0, Infinity, rnd).mdd > 17) hi = m; else lo = m; } return (lo + hi) / 2; };
const P2: Array<[string, number, number]> = [['24Q4', Date.UTC(2024, 9, 1), Date.UTC(2024, 11, 31)], ['25H1', Date.UTC(2025, 0, 1), Date.UTC(2025, 5, 30)], ['25H2', Date.UTC(2025, 6, 1), Date.UTC(2025, 11, 31)], ['26', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)]];
const showA = (lab: string, cfg: Cfg) => {
  const r = runA(cfg, 1 / cfg.slots); const sz = eqA(cfg); const e = runA(cfg, sz);
  const per = P2.map(([, a, b]) => (runA(cfg, sz, a, b).ret.toFixed(0) + '%').padStart(6)).join('');
  console.log(`${lab.padEnd(40)} 1/K ${(r.ret.toFixed(0) + '%').padStart(6)} MDD ${(r.mdd.toFixed(0) + '%').padStart(4)} n=${String(r.n).padStart(4)} 거래당 ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(7)} | MDD17 ${(e.ret.toFixed(0) + '%').padStart(5)} sz${(sz * 100).toFixed(0).padStart(3)}% |${per}`);
};
const mode = process.argv[2] || 'A';
if (mode === 'A') {
  console.log('A) 15m · 2024-10~2026-10 · 비용 현실 (구간 24Q4/25H1/25H2/26)');
  for (const [k, y, win] of [[0.05, 0.03, 4], [0.08, 0.05, 4], [0.04, 0.02, 1]] as Array<[number, number, number]>)
    for (const [tp, hold] of [[null, 24], [null, 72], [6, 72], [4, 48], [10, 120]] as Array<[number | null, number]>)
      showA(`OI${win}h≤−${k * 100}%·가≤−${y * 100}% ${tp ? `TP${tp}` : '보유'}/${hold}h`, { k, y, win, tp, hold, slots: 3 });
}
if (mode === 'Arnd') {
  const cfg = { k: 0.05, y: 0.03, win: 4, tp: null, hold: 72, slots: 3 } as Cfg;
  const real = runA(cfg, eqA(cfg)).ret;
  const res: number[] = []; for (let s = 1; s <= 12; s++) { const rate = 0.0008; const sz = eqA(cfg, rate + s * 1e-9); res.push(runA(cfg, sz, 0, Infinity, rate + s * 1e-9).ret); }
  res.sort((a, b) => a - b); console.log(`플라시보(무작위 진입, 같은 청산) MDD17 12회: 중앙 ${res[6].toFixed(0)}% 최대 ${res[11].toFixed(0)}% · 실제 ${real.toFixed(0)}%`);
  CX = 2; showA('비용 ×2: OI4h≤−5%·가≤−3% 보유/72h', cfg); showA('비용 ×2: OI4h≤−8%·가≤−5% 보유/72h', { ...cfg, k: 0.08, y: 0.05 }); CX = 1;
}
// ── B) 4h 2022-06~
function runB(cfg: Cfg, size: number, from = 0, to = Infinity) {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, sumR = 0; const open: any[] = []; const last = new Map<string, number>();
  const holdBars = Math.round(cfg.hold / 4);
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) { const q = open[p]; const i = IDX.get(q.c)!.get(ts); if (i === undefined) continue; const b = BARS.get(q.c)![i]; q.last = b.close; q.bars++;
      let px = 0; if (cfg.tp != null && b.high >= q.ep * (1 + cfg.tp / 100)) px = q.ep * (1 + cfg.tp / 100); else if (q.bars >= holdBars) px = b.close * (1 - slip(q.c));
      if (px) { const got = q.vol * px * (1 - FEE()); cash += got; n++; sumR += got / q.used - 1; open.splice(p, 1); } }
    // 직전 봉(ts−4h ~ ts) 동안: OI(ts)/OI(ts−4h) 와 그 봉 수익 → 이번 봉(ts) 은 이미 시작됐으니 '다음' 봉 시가 진입 = 보수적으로 1봉 대기열
    for (const c of BARS.keys()) {
      if (open.length >= cfg.slots) break; if (open.some(q => q.c === c) || (last.get(c) ?? 0) > ts - DAY) continue;
      const i = IDX.get(c)!.get(ts); if (i === undefined || i < 3) continue; const b = BARS.get(c)!;
      const tm = ts - FOUR; // 판단 기준 = 봉 i−1 마감(ts−4h)의 OI 와 봉 i−2 → i−1 수익 (공개 후 4h 지난 시점에 진입)
      const o1 = OI.get(c)?.get(tm), o0 = OI.get(c)?.get(tm - FOUR); if (!o1 || !o0 || o1 / o0 - 1 > -cfg.k) continue;
      if (b[i - 1].close / b[i - 1].open - 1 > -cfg.y) continue;
      const used = cash * size; if (used < 5000) continue; const ep = b[i].open * (1 + slip(c));
      cash -= used; open.push({ c, ep, vol: used * (1 - FEE()) / ep, used, bars: 0, last: ep }); last.set(c, ts);
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0 };
}
if (mode === 'B') {
  const SP: Array<[string, number, number]> = [['22H2', Date.UTC(2022, 6, 1), Date.UTC(2022, 11, 31)], ['2023', Date.UTC(2023, 0, 1), Date.UTC(2023, 11, 31)], ['2024', Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31)], ['2025', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31)], ['2026', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)]];
  console.log('B) 4h · 2022-06~2026-08 · 진입 = OI 공개 후 다음 4h 봉 시가 (보수적) · 구간 22H2/23/24/25/26');
  for (const [k, y] of [[0.05, 0.03], [0.08, 0.05], [0.03, 0.02]] as Array<[number, number]>) for (const [tp, hold] of [[null, 24], [null, 72], [6, 72]] as Array<[number | null, number]>) {
    const cfg = { k, y, win: 4, tp, hold, slots: 3 }; const r = runB(cfg, 0.33);
    let lo = 0.01, hi = 0.95; for (let z = 0; z < 14; z++) { const m = (lo + hi) / 2; if (runB(cfg, m).mdd > 17) hi = m; else lo = m; } const sz = (lo + hi) / 2;
    const per = SP.map(([, a, b]) => (runB(cfg, sz, a, b).ret.toFixed(0) + '%').padStart(6)).join('');
    console.log(`OI4h≤−${k * 100}%·봉≤−${y * 100}% ${tp ? `TP${tp}` : '보유'}/${hold}h`.padEnd(32) + ` 33% ${(r.ret.toFixed(0) + '%').padStart(6)} MDD ${(r.mdd.toFixed(0) + '%').padStart(4)} n=${String(r.n).padStart(4)} 거래당 ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(7)} | MDD17 ${(runB(cfg, sz).ret.toFixed(0) + '%').padStart(5)} |${per}`);
  }
}

if (mode === 'strong') {
  const base: Cfg = { k: 0.08, y: 0.05, win: 4, tp: null, hold: 72, slots: 3 };
  showA('본건 OI4h≤−8%·가≤−5% 보유72h', base);
  showA('대조: 가≤−5% (OI 무관) 보유72h', { ...base, noOI: true });
  showA('대조: 가≤−5% & OI≥−1% 보유72h', { ...base, noOI: true, oiMin: -0.01 });
  showA('대조: 가≤−8% (OI 무관) 보유72h', { ...base, y: 0.08, noOI: true });
  // 이벤트 일 집계 → 상위 손익일 제외 재실행
  const days = new Map<number, number>();
  for (const c of M15.keys()) { const m = OI.get(c)!; for (const [mt, o1] of m) { if (mt < Date.UTC(2024, 9, 8)) continue; const o0 = m.get(mt - 4 * H); if (!o0 || o1 / o0 - 1 > -0.08) continue; const i1 = I15.get(c)!.get(mt), i0 = I15.get(c)!.get(mt - 4 * H); if (i1 === undefined || i0 === undefined) continue; if (M15.get(c)![i1].open / M15.get(c)![i0].open - 1 > -0.05) continue; const d = Math.floor(mt / DAY); days.set(d, (days.get(d) ?? 0) + 1); } }
  const ranked = [...days].sort((a, b) => b[1] - a[1]);
  console.log('이벤트 많은 날 상위:', ranked.slice(0, 8).map(([d, n]) => new Date(d * DAY).toISOString().slice(0, 10) + '×' + n).join(' '));
  for (const k of [3, 5, 10]) showA(`잭나이프: 상위 ${k}일 제외`, { ...base, excl: new Set(ranked.slice(0, k).map(x => x[0])) });
  for (const [k, y] of [[0.06, 0.04], [0.07, 0.05], [0.08, 0.04], [0.08, 0.06], [0.10, 0.05]] as Array<[number, number]>) showA(`이웃: OI≤−${k * 100}%·가≤−${y * 100}% 보유72h`, { ...base, k, y });
  for (const h of [48, 96]) showA(`이웃: 보유 ${h}h`, { ...base, hold: h });
}

if (mode === 'panic') {
  const base: Cfg = { k: 0.08, y: 0.05, win: 4, tp: null, hold: 72, slots: 3 };
  for (const x of [0.005, 0.01, 0.02]) { EXTRA = x; showA(`패닉 슬리피지 +${x * 100}%/편도`, base); }
  EXTRA = 0;
  // 진입 지연 민감도: 15분 → 1h → 4h (정시 기준 진입 시각 이동)
}
