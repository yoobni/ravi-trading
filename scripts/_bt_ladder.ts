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
 * 메커니즘 ④ 미리 걸어두는 분할 사다리 (2026-10-02)
 * 근거(_an_paths.ts): F6 신호 후 MAE 평균 −5.7%, 최저점 21% 가 첫 봉, 승자 고점 74% 가 7봉 이후.
 * 업비트는 매수 지정가(현재가 아래)·매도 지정가(현재가 위)를 미리 걸 수 있다 → 둘 다 사다리로.
 *
 * 체결 모델 (_bt_limitentry.ts 와 동일 원칙):
 *   매수 rung dip=0 → 신호 다음 봉 시가 시장가(슬리피지). dip>0 → 지정가 = 시가×(1−dip), 그 봉부터 W봉 유효,
 *     봉 저가 ≤ 지정가×(1−PEN) 이면 지정가 체결(슬리피지 0). 주문 중 현금 잠김, 미체결분은 만료/익절 시 반환.
 *   매도 rung → 평단 기준 +tp% 지정가, 봉 고가 ≥ 목표×(1+PEN) 이면 목표가 체결. 각 rung 은 "최초 계획 수량" 의 w 만큼.
 *   봉 내 순서: 매도 먼저(직전까지 보유분, 이 봉에 새로 체결된 매수가 없을 때만) → 매수 체결.
 *     이번 봉에 매수가 체결되면 그 봉에선 매도를 안 본다(보수적). 첫 매도가 나면 남은 매수 사다리는 취소.
 *   시간청산: 첫 체결 후 maxb 봉 → 잔량 종가 시장가. runner>maxb 면 maxb 에서 "마지막 매도 rung 몫"만 남기고 정리,
 *     남은 러너는 자기 TP 또는 runner 봉에 시장가.
 */
let PEN = 0;
let FEEX = FEE, SLIPX = SLIP;
interface Cfg { buy: Array<[number, number]>; W: number; sell: Array<[number, number]>; maxb: number; runner?: number }
interface Slot { m: string; budget: number; reserved: number; vol: number; cost: number; buys: Array<{ px: number; krw: number }>; left: number;
  bars: number; started: boolean; sold: boolean[]; planVol: number; last: number; runnerOnly: boolean }
function run(c: Cfg, size = 0.33, from = 0, to = Infinity) {
  let cash = INIT; const slots: Slot[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, nPos = 0, fillW = 0;
  const closeSlot = (s: Slot, k: number) => { cash += s.reserved; s.reserved = 0; const r = s.cost > 0 ? s.realized / s.cost - 1 : 0; if (s.cost > 0) { n++; sumR += r; fillW += s.cost / s.budget; } slots.splice(k, 1); };
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let k = slots.length - 1; k >= 0; k--) {
      const s = slots[k] as Slot & { realized: number };
      const i = IDX.get(s.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(s.m)![i]; s.last = bar.close;
      let filledNow = false;
      // 매도 (보유분이 있고, 이번 봉에 새 매수 체결 전)
      if (s.vol > 1e-12 && s.started) {
        s.bars++;
        const avg = s.cost * (1 - FEEX) / s.planVolCost;   // 평단 = 체결가 가중평균 (수수료 제외)
        for (let r = 0; r < c.sell.length; r++) {
          if (s.sold[r] || s.vol <= 1e-12) continue;
          if (s.runnerOnly && r !== c.sell.length - 1) continue;
          const tgt = avg * (1 + c.sell[r][0] / 100);
          if (bar.high >= tgt * (1 + PEN)) {
            const q = Math.min(s.vol, s.planVol * c.sell[r][1]);
            const got = q * tgt * (1 - FEEX); cash += got; s.realized += got; s.vol -= q; s.sold[r] = true;
            if (s.reserved > 0) { cash += s.reserved; s.reserved = 0; s.buys = []; }   // 첫 매도 → 남은 매수 사다리 취소
          }
        }
        if (s.vol > 1e-12) {
          const lastFrac = c.sell[c.sell.length - 1][1];
          if (c.runner && c.runner > c.maxb) {
            if (!s.runnerOnly && s.bars >= c.maxb) {
              const keep = s.sold[c.sell.length - 1] ? 0 : Math.min(s.vol, s.planVol * lastFrac);
              const q = s.vol - keep; const got = q * bar.close * (1 - SLIPX) * (1 - FEEX); cash += got; s.realized += got; s.vol = keep; s.runnerOnly = true;
              if (s.reserved > 0) { cash += s.reserved; s.reserved = 0; s.buys = []; }
            }
            if (s.vol > 1e-12 && s.bars >= c.runner) { const got = s.vol * bar.close * (1 - SLIPX) * (1 - FEEX); cash += got; s.realized += got; s.vol = 0; }
          } else if (s.bars >= c.maxb) {
            const got = s.vol * bar.close * (1 - SLIPX) * (1 - FEEX); cash += got; s.realized += got; s.vol = 0;
          }
        }
        if (s.vol <= 1e-12) { closeSlot(s, k); continue; }
      }
      // 매수 사다리 체결
      if (s.buys.length && s.sold.every(x => !x)) {
        for (let b = s.buys.length - 1; b >= 0; b--) {
          const o = s.buys[b];
          if (bar.low <= o.px * (1 - PEN)) {
            const v = o.krw * (1 - FEEX) / o.px; s.vol += v; s.planVol += v; s.cost += o.krw; s.planVolCost += v; s.reserved -= o.krw;
            s.buys.splice(b, 1); filledNow = true;
          }
        }
        if (filledNow && !s.started) { s.started = true; }
      }
      if (--s.left <= 0 && s.buys.length) { cash += s.reserved; s.reserved = 0; s.buys = []; }
      if (!s.started && s.buys.length === 0) closeSlot(s, k);   // 하나도 안 채워지고 만료
    }
    // 신호 → 새 슬롯
    for (const m of ORDER) {
      if (slots.length >= 3) break;
      const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
      if (i === undefined || i < 45 || !sigF6(bb, i - 1)) continue;
      if (slots.some(s => s.m === m)) continue;
      const budget = cash * size; if (budget < 5000) continue;
      cash -= budget; nPos++;
      const s: any = { m, budget, reserved: budget, vol: 0, cost: 0, buys: [], left: c.W - 1, bars: 0, started: false, sold: c.sell.map(() => false),
        planVol: 0, planVolCost: 0, last: bb[i].close, runnerOnly: false, realized: 0 };
      const ref = bb[i].open;
      for (const [dip, w] of c.buy) {
        const krw = budget * w;
        if (dip === 0) { const ep = ref * (1 + SLIPX); const v = krw * (1 - FEEX) / ep; s.vol += v; s.planVol += v; s.cost += krw; s.planVolCost += v; s.reserved -= krw; s.started = true; }
        else {
          const px = ref * (1 - dip / 100);
          if (bb[i].low <= px * (1 - PEN)) { const v = krw * (1 - FEEX) / px; s.vol += v; s.planVol += v; s.cost += krw; s.planVolCost += v; s.reserved -= krw; s.started = true; }
          else s.buys.push({ px, krw });
        }
      }
      if (s.left <= 0 && s.buys.length) { s.reserved -= s.buys.reduce((a: number, o: any) => a + o.krw, 0); cash += s.buys.reduce((a: number, o: any) => a + o.krw, 0); s.buys = []; }   // W=1: 신호봉 한 개만 유효
      if (!s.started && s.buys.length === 0) { cash += s.reserved; continue; }
      slots.push(s);
    }
    const eq = cash + slots.reduce((a, s) => a + s.reserved + s.vol * s.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + slots.reduce((a, s) => a + s.reserved + s.vol * s.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0, fillW: n ? 100 * fillW / n : 0, nPos };
}
const sizeFor = (c: Cfg, target = 17) => { let lo = 0.02, hi = 0.95; for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (run(c, mid).mdd > target) hi = mid; else lo = mid; } return (lo + hi) / 2; };
const SP: Array<[string, number, number]> = [['22H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)], ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)],
  ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)], ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const t3 = 1 / 3;
const C: Record<string, Cfg> = {
  'F7 기준(시가·TP6·3일)':          { buy: [[0, 1]], W: 1, sell: [[6, 1]], maxb: 18 },
  '지정가 −3%·3봉 단일':            { buy: [[3, 1]], W: 3, sell: [[6, 1]], maxb: 18 },
  // 1. 분할 매수 사다리 (익절 평단+6 · 3일)
  'B 0/−3/−6 ·W3':                 { buy: [[0, t3], [3, t3], [6, t3]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B 0/−3/−6 ·W6':                 { buy: [[0, t3], [3, t3], [6, t3]], W: 6, sell: [[6, 1]], maxb: 18 },
  'B 0/−2/−4 ·W3':                 { buy: [[0, t3], [2, t3], [4, t3]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B −1/−3/−5 ·W3':                { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B −2/−4/−6 ·W3':                { buy: [[2, t3], [4, t3], [6, t3]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B 0/−3 반반 ·W3':                { buy: [[0, .5], [3, .5]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B 0/−4 반반 ·W3':                { buy: [[0, .5], [4, .5]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B −2/−4 반반 ·W3':               { buy: [[2, .5], [4, .5]], W: 3, sell: [[6, 1]], maxb: 18 },
  'B −1/−3/−5 TP4':                { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[4, 1]], maxb: 18 },
  'B −1/−3/−5 TP8':                { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[8, 1]], maxb: 18 },
  'B −1/−3/−5 TP6 5일':            { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[6, 1]], maxb: 30 },
  // 2. 분할 익절 사다리 (시가 진입)
  'S 4/8/12 ·3일':                 { buy: [[0, 1]], W: 1, sell: [[4, t3], [8, t3], [12, t3]], maxb: 18 },
  'S 4/8/12 ·5일':                 { buy: [[0, 1]], W: 1, sell: [[4, t3], [8, t3], [12, t3]], maxb: 30 },
  'S 4/8/12 ·7일':                 { buy: [[0, 1]], W: 1, sell: [[4, t3], [8, t3], [12, t3]], maxb: 42 },
  'S 4/8/12 ·3일+러너7일':          { buy: [[0, 1]], W: 1, sell: [[4, t3], [8, t3], [12, t3]], maxb: 18, runner: 42 },
  'S 3/6 반반 ·3일':                { buy: [[0, 1]], W: 1, sell: [[3, .5], [6, .5]], maxb: 18 },
  'S 5/10 반반 ·3일':               { buy: [[0, 1]], W: 1, sell: [[5, .5], [10, .5]], maxb: 18 },
  'S 6/12 반반 ·3일+러너7일':        { buy: [[0, 1]], W: 1, sell: [[6, .5], [12, .5]], maxb: 18, runner: 42 },
  // 3. 결합
  'BS −1/−3/−5 × 4/8/12 ·3일':      { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[4, t3], [8, t3], [12, t3]], maxb: 18 },
  'BS −1/−3/−5 × 4/8/12 ·5일':      { buy: [[1, t3], [3, t3], [5, t3]], W: 3, sell: [[4, t3], [8, t3], [12, t3]], maxb: 30 },
  'BS 0/−3/−6 × 4/8/12 ·3일+러너':   { buy: [[0, t3], [3, t3], [6, t3]], W: 3, sell: [[4, t3], [8, t3], [12, t3]], maxb: 18, runner: 42 },
  'BS 0/−3 × 3/6 ·3일':             { buy: [[0, .5], [3, .5]], W: 3, sell: [[3, .5], [6, .5]], maxb: 18 },
};
const MODE = process.argv[2] || 'grid';
const per = (c: Cfg, sz: number) => SP.map(([, a, b]) => (run(c, sz, a, b).ret.toFixed(0) + '%').padStart(7)).join('');
const head = () => console.log('설정'.padEnd(30) + '총익'.padStart(7) + 'MDD'.padStart(6) + '거래'.padStart(6) + '거래당'.padStart(8) + '투입률'.padStart(6) + ' |' + SP.map(s => s[0].padStart(7)).join('') + ' ‖ MDD17:' + '총익'.padStart(6) + '사이즈'.padStart(6) + ' |' + SP.map(s => s[0].padStart(7)).join(''));
const line = (lab: string, c: Cfg) => {
  const r = run(c); const sz = sizeFor(c); const e = run(c, sz);
  console.log(`${lab.padEnd(30)}${(r.ret.toFixed(0) + '%').padStart(7)}${(r.mdd.toFixed(0) + '%').padStart(6)}${String(r.n).padStart(6)}${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)}${(r.fillW.toFixed(0) + '%').padStart(6)} |${per(c, 0.33)} ‖      ${(e.ret.toFixed(0) + '%').padStart(6)}${((sz * 100).toFixed(0) + '%').padStart(6)} |${per(c, sz)}`);
};
if (MODE === 'grid') { head(); for (const [k, c] of Object.entries(C)) line(k, c); }
if (MODE === 'stress') {
  const keys = (process.argv[3] || '').split(',').filter(Boolean);
  for (const [lab, pen, fx] of [['기본', 0, 1], ['관통 0.3%', 0.003, 1], ['마찰×2', 0, 2], ['관통0.3%+마찰×2', 0.003, 2]] as Array<[string, number, number]>) {
    PEN = pen; FEEX = FEE * fx; SLIPX = SLIP * fx;
    console.log(`\n── ${lab} ──`); head();
    for (const k of keys) line(k, C[k]);
  }
}
if (MODE === 'family') {
  // 고원 검사 — 개별 칸이 아니라 '가족' 전체의 분포를 비교한다 (MDD 17% 동일위험).
  const fam: Record<string, Array<[string, Cfg]>> = { '단일 지정가': [], '매수 사다리(3단)': [], '매수 사다리(2단)': [], '매수3단×익절사다리': [], '시가×익절사다리': [], '시가×단일TP': [] };
  for (const dip of [1, 2, 3, 4]) for (const W of [1, 2, 3]) for (const tp of [5, 6, 7, 8]) fam['단일 지정가'].push([`L −${dip} W${W} TP${tp}`, { buy: [[dip, 1]], W, sell: [[tp, 1]], maxb: 18 }]);
  for (const a of [0, 1, 2]) for (const d of [2, 3]) for (const W of [2, 3, 4]) for (const tp of [5, 6, 7, 8])
    fam['매수 사다리(3단)'].push([`B3 ${a}/${a + d}/${a + 2 * d} W${W} TP${tp}`, { buy: [[a, t3], [a + d, t3], [a + 2 * d, t3]], W, sell: [[tp, 1]], maxb: 18 }]);
  for (const a of [0, 1, 2]) for (const d of [2, 3, 4]) for (const W of [2, 3]) for (const tp of [5, 6, 7, 8])
    fam['매수 사다리(2단)'].push([`B2 ${a}/${a + d} W${W} TP${tp}`, { buy: [[a, .5], [a + d, .5]], W, sell: [[tp, 1]], maxb: 18 }]);
  const SL: Array<[string, Array<[number, number]>]> = [['3/6/9', [[3, t3], [6, t3], [9, t3]]], ['4/8/12', [[4, t3], [8, t3], [12, t3]]], ['5/10/15', [[5, t3], [10, t3], [15, t3]]]];
  for (const a of [0, 1, 2]) for (const d of [2, 3]) for (const [sl, sr] of SL) for (const mb of [18, 30])
    fam['매수3단×익절사다리'].push([`BS ${a}/${a + d}/${a + 2 * d} × ${sl} ${mb / 6}일`, { buy: [[a, t3], [a + d, t3], [a + 2 * d, t3]], W: 3, sell: sr, maxb: mb }]);
  for (const [sl, sr] of SL) for (const mb of [12, 18, 24, 30, 42]) fam['시가×익절사다리'].push([`S ${sl} ${mb / 6}일`, { buy: [[0, 1]], W: 1, sell: sr, maxb: mb }]);
  for (const tp of [4, 5, 6, 7, 8, 10]) for (const mb of [12, 18, 24, 30]) fam['시가×단일TP'].push([`TP${tp} ${mb / 6}일`, { buy: [[0, 1]], W: 1, sell: [[tp, 1]], maxb: mb }]);
  const q = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const rows: string[] = [];
  for (const [name, list] of Object.entries(fam)) {
    const tot: number[] = [], y25: number[] = [], allPos: number[] = []; let best = { k: '', v: -1e9 };
    for (const [k, c] of list) {
      const sz = sizeFor(c); const r = run(c, sz).ret; tot.push(r);
      const ps = SP.map(([, a, b]) => run(c, sz, a, b).ret); y25.push(ps[2]); allPos.push(ps.every(x => x > 0) ? 1 : 0);
      if (r > best.v) best = { k, v: r };
    }
    rows.push(`${name.padEnd(18)} ${String(list.length).padStart(3)}칸  총익 p25 ${q(tot, .25).toFixed(0).padStart(4)}% · 중앙 ${q(tot, .5).toFixed(0).padStart(4)}% · p75 ${q(tot, .75).toFixed(0).padStart(4)}%  | 2025 중앙 ${q(y25, .5).toFixed(0).padStart(4)}% · 4구간 전부 양수 ${(100 * allPos.reduce((a, b) => a + b, 0) / list.length).toFixed(0).padStart(3)}%  | 최고 ${best.k} ${best.v.toFixed(0)}%`);
    console.log(rows[rows.length - 1]);
  }
}
