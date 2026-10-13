/**
 * 저점 흡수(BTC_DIP) 계열 확장 — 공통 엔진 (2026-10-13, dip 리서치 '사다리' 축)
 *
 * 단일 자산·단일 계좌 지정가 흡수 시뮬. 봉 경로(15m 기본, 1h/4h/1d 근사 가능)로 체결 판정.
 *  - 트리거: TF 경계(UTC 기준 = KST 9시 정렬)마다, 포지션이 없으면 기준가 대비 −x1..−xk 지정가 매수 다단(사다리) 주문.
 *      기준가 = 직전 봉 종가('close') 또는 최근 N 개 TF 구간 고가('high').
 *    미체결 주문은 다음 TF 경계에서 새 기준가로 갱신. 첫 체결 후엔 남은 단이 청산 때까지 유지(기준가 고정).
 *  - 체결: 봉 저가 ≤ 지정가 × (1 − 관통) 이면 지정가 체결(슬리피지 0). 15m 기본 관통 0.2%, 1h/4h/1d 근사는 0.5%.
 *  - 청산: 평균단가 × (1+y) 지정가 매도(봉 고가 ≥ 목표 × (1+관통)) · 첫 체결 후 T 시간 경과 시 그 봉 시가 시장가(슬리피지).
 *  - 같은 봉 순서(보수): 그 봉에 새 체결이 있으면 TP 판정 안 함(아래 먼저 → 위는 다음 봉부터). 체결 봉에서 TP 금지.
 *    시간청산은 봉 시가라 체결보다 먼저 처리.
 *  - 국면: BTC 일봉 종가 vs SMA50 (직전 확정 일봉 기준, 미래 정보 없음). regime='below'|'above'|'all'.
 *    하락국면 변형: downMul(사다리 깊이 배수), downT(시간청산 단축), downY.
 *  - 쿨다운: 청산 후 cool 시간 동안 신규 주문 없음.
 *  - 지연: delay 분 — 주문이 경계 + delay 분부터 유효(크론 지연). tpDelay — TP 는 체결 후 다음 TF 경계(크론)부터 유효.
 *  - 슬롯: slots>1 이면 같은 규칙의 독립 포지션 최대 slots 개(각 자산의 1/slots), 보유 중에도 다음 경계에 새 사다리.
 */
import fs from 'fs';
import path from 'path';

export const Q = 15 * 60e3, H = 3600e3, DAY = 86400e3;
export interface Bar { ts: number; o: number; h: number; l: number; c: number; v?: number; val?: number }

// ───────────── 데이터 ─────────────
const CC = path.resolve(process.cwd(), 'data/candle-cache');
export const OUTDIR = path.resolve(process.cwd(), 'data/research-ext/dip-2026-10/ladder');
fs.mkdirSync(OUTDIR, { recursive: true });

export function loadBtc15(): Bar[] {
  const raw: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
  return raw.map(r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}
/** candle-cache 의 같은 코인·같은 분봉 파일을 전부 합침(ts 중복 제거). 진행 중 봉 제외. */
export function loadCache(market: string, min: number): Bar[] {
  const fs0 = fs.readdirSync(CC).filter(f => f.startsWith(market + '_' + min + 'm_'));
  const m = new Map<number, Bar>();
  for (const f of fs0) {
    const a: any[] = JSON.parse(fs.readFileSync(path.join(CC, f), 'utf8'));
    for (const x of a) if (x.ts + min * 60e3 <= Date.now()) m.set(x.ts, { ts: x.ts, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume, val: x.value ?? (x.volume * x.close) });
  }
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}
export function listCache(min: number): string[] {
  return [...new Set(fs.readdirSync(CC).filter(f => f.includes('_' + min + 'm_')).map(f => f.split('_')[0]))].sort();
}
export function loadDaily(market: string): Bar[] {
  const p = path.resolve(process.cwd(), 'data/research-ext/daily', market + '.json');
  if (!fs.existsSync(p)) return [];
  const a: any[] = JSON.parse(fs.readFileSync(p, 'utf8'));
  return a.filter(x => x.ts + DAY <= Date.now()).map(x => ({ ts: x.ts, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume, val: x.value })).sort((a, b) => a.ts - b.ts);
}
export function agg(bars: Bar[], step: number): Bar[] {
  const out: Bar[] = [];
  for (const x of bars) {
    const k = Math.floor(x.ts / step) * step; const l = out[out.length - 1];
    if (!l || l.ts !== k) out.push({ ts: k, o: x.o, h: x.h, l: x.l, c: x.c });
    else { l.h = Math.max(l.h, x.h); l.l = Math.min(l.l, x.l); l.c = x.c; }
  }
  return out;
}
export const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
/** 시장가 슬리피지 = 스프레드½ (최소 0.05%), 표에 없는 코인은 0.3% */
export const slipOf = (m: string) => (SPREAD[m] != null ? Math.max(0.0005, SPREAD[m] / 2 / 1e4) : 0.003);

// ───────────── BTC 국면 ─────────────
const BTCD = loadDaily('KRW-BTC');
const BTCDI = new Map(BTCD.map((b, i) => [b.ts, i]));
/** 일 d(시작 ts)의 종가 기준: below SMA50 / 20일 수익 */
export const BELOW = new Map<number, boolean>(), RET20 = new Map<number, number>();
for (let i = 50; i < BTCD.length; i++) {
  let s = 0; for (let j = i - 49; j <= i; j++) s += BTCD[j].c;
  BELOW.set(BTCD[i].ts, BTCD[i].c < s / 50);
  RET20.set(BTCD[i].ts, BTCD[i].c / BTCD[i - 20].c - 1);
}
const BELOWN = new Map<number, Map<number, boolean>>();
function belowMap(n: number) { let m = BELOWN.get(n); if (m) return m; m = new Map(); for (let i = n; i < BTCD.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += BTCD[j].c; m.set(BTCD[i].ts, BTCD[i].c < s / n); } BELOWN.set(n, m); return m; }
/** 시각 t 에 알 수 있는 국면(직전 확정 일봉), 기본 SMA50 */
export const belowAt = (t: number, n = 50) => (n === 50 ? BELOW : belowMap(n)).get(Math.floor(t / DAY) * DAY - DAY) ?? false;
/** 보고용 국면 라벨(그날 종가 기준, 배타적): a = SMA50 아래, b = a 아니고 20일 수익 ≤ +2%, c = 그 외 */
export const regimeLabel = (d: number): 'a' | 'b' | 'c' | null => { const bl = BELOW.get(d); if (bl == null) return null; if (bl) return 'a'; return (RET20.get(d)! <= 0.02) ? 'b' : 'c'; };

// ───────────── 엔진 ─────────────
export interface Cfg {
  tf: number;                 // 트리거 경계 간격(ms)
  ref?: 'close' | 'high'; nHigh?: number;
  rungs: number[];            // 하락 % (예 [3] 또는 [2,4,6])
  wts?: number[];             // 단별 비중(합 1), 기본 균등
  y: number;                  // TP % (평균단가 대비)
  T: number;                  // 시간청산(시간, 첫 체결 기준)
  pen?: number;               // 관통(지정가 매수·매도 공통)
  regime?: 'all' | 'below' | 'above';
  downMul?: number; downT?: number; downY?: number; downSize?: number; sma?: number;   // sma: 국면 판정 SMA 길이(기본 50)
  cool?: number;              // 청산 후 쿨다운(시간)
  delay?: number;             // 주문 유효 시작 지연(분)
  tpDelay?: boolean;          // TP 는 체결 후 다음 TF 경계부터
  fee?: number; slip?: number;
  slots?: number;
  from?: number; to?: number;
  volK?: boolean;             // true 면 rungs 를 'σ 배수'로 해석: σ = 최근 30일 TF 수익 표준편차(%)
  chase?: boolean;            // 고점 기준에서 이미 지정가 아래면 시장가 진입(기본: 그 단 포기)
  placebo?: { p: number; seed: number };   // 무작위 진입(첫 단 시장가, 같은 빈도), 나머지 동일
}
export interface Trade { te: number; tx: number; ret: number; slotRet: number; reason: string; fills: number; used: number }
export interface Res { eqAt: Array<[number, number]>; trades: Trade[]; expo: number; ladders: number; eligible: number }

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

interface Pos { cap: number; units: number; cost: number; te: number; T: number; y: number; lims: number[]; w: number[]; filled: boolean[]; tpOn: number; nf: number }

export function sim(bars: Bar[], barMs: number, c: Cfg): Res {
  const pen = c.pen ?? 0.002, FEE = c.fee ?? 0.0005, SLIP = c.slip ?? 0.0002, K = c.slots ?? 1;
  const from = c.from ?? -Infinity, to = c.to ?? Infinity;
  const nR = c.rungs.length, W0 = c.wts ?? c.rungs.map(() => 1 / nR);
  const nHighBars = c.ref === 'high' ? Math.round((c.nHigh ?? 6) * c.tf / barMs) : 0;
  const R = c.placebo ? rng(c.placebo.seed) : null;
  let cash = 1; const pos: Pos[] = [];
  let pend: { lims: number[]; w: number[]; T: number; y: number; until: number; active: number; cap: number; fresh: boolean } | null = null;
  let coolUntil = -Infinity; const trades: Trade[] = []; const eqAt: Array<[number, number]> = [];
  let expoSum = 0, expoN = 0, ladders = 0, eligible = 0;
  let k0 = bars.findIndex(b => b.ts >= from); if (k0 < 1) k0 = 1;
  for (let k = k0; k < bars.length; k++) {
    const b = bars[k]; if (b.ts >= to) break;
    const pb = bars[k - 1];
    const boundary = b.ts % c.tf === 0;   // 라이브와 동일: 경계 봉이 없으면(데이터 결손) 그 구간 주문 없음
    const bStart = Math.floor(b.ts / c.tf) * c.tf;
    // 1) 시간청산(봉 시가)
    const nTr0 = trades.length;
    for (let i = pos.length - 1; i >= 0; i--) {
      const p = pos[i];
      if (b.ts - p.te >= p.T * H) {
        const got = p.units * b.o * (1 - SLIP) * (1 - FEE); cash += got;
        trades.push({ te: p.te, tx: b.ts, ret: got / p.cost - 1, slotRet: (got - p.cost) / p.cap, reason: 'TIME', fills: p.nf, used: p.cost / p.cap });
        pos.splice(i, 1); coolUntil = b.ts + (c.cool ?? 0) * H;
      }
    }
    // 2) TP (이 봉에 새 체결이 없는 포지션만 — 아래에서 체결 생기면 그 포지션은 이번 봉 TP 무효: TP 를 먼저 판정하되 같은 봉 체결 가능성 있으면 보류)
    for (let i = pos.length - 1; i >= 0; i--) {
      const p = pos[i]; if (b.ts < p.tpOn) continue;
      // 이 봉에서 남은 단이 체결될 수 있으면(저가가 닿음) 순서 불명 → TP 보류(보수)
      let wouldFill = false; for (let j = 0; j < nR; j++) if (!p.filled[j] && b.l <= p.lims[j] * (1 - pen)) wouldFill = true;
      if (wouldFill) continue;
      const avg = p.cost / p.units * (1 - FEE);   // 수수료 전 평균 체결가
      const tgt = avg * (1 + p.y / 100);
      if (b.h >= tgt * (1 + pen)) {
        const got = p.units * tgt * (1 - FEE); cash += got;
        trades.push({ te: p.te, tx: b.ts, ret: got / p.cost - 1, slotRet: (got - p.cost) / p.cap, reason: 'TP', fills: p.nf, used: p.cost / p.cap });
        pos.splice(i, 1); coolUntil = b.ts + (c.cool ?? 0) * H;
      }
    }
    // 3) 보유 포지션의 남은 단 체결
    for (const p of pos) for (let j = 0; j < nR; j++) if (!p.filled[j] && b.l <= p.lims[j] * (1 - pen)) {
      const amt = Math.min(p.cap * p.w[j], cash); if (amt <= 1e-9) continue;
      cash -= amt; p.units += amt * (1 - FEE) / p.lims[j]; p.cost += amt; p.filled[j] = true; p.nf++;
      p.tpOn = Math.max(p.tpOn, c.tpDelay ? bStart + c.tf : b.ts + barMs);
    }
    // 4) 경계: 새 사다리 주문
    if (boundary) {
      pend = null;
      const eq = cash + pos.reduce((s, p) => s + p.units * pb.c, 0);
      const sm = c.sma ?? 50; const okRegime = c.regime === 'below' ? belowAt(b.ts, sm) : c.regime === 'above' ? !belowAt(b.ts, sm) : true;
      // 라이브와 동일: 청산이 일어난 봉에서는 새 주문을 내지 않음(그 TF 구간 건너뜀)
      if (trades.length === nTr0 && pos.length < K && b.ts >= coolUntil && okRegime && cash > 1e-6) {
        eligible++;
        const down = belowAt(b.ts, sm);
        const mul = down && c.downMul ? c.downMul : 1;
        let ref = pb.c;
        let unit = 1;   // rungs 단위(%), volK 면 σ(%)
        if (c.volK) { const step = Math.round(c.tf / barMs), N = Math.round(30 * DAY / c.tf); let s1 = 0, s2 = 0, n = 0;
          for (let q = 0; q < N; q++) { const i1 = k - 1 - q * step, i0 = i1 - step; if (i0 < 0) break; const r = Math.log(bars[i1].c / bars[i0].c); s1 += r; s2 += r * r; n++; }
          unit = n > 20 ? 100 * Math.sqrt(Math.max(s2 / n - (s1 / n) ** 2, 0)) : NaN; }
        if (c.ref === 'high') { ref = -Infinity; for (let j = Math.max(0, k - nHighBars); j < k; j++) ref = Math.max(ref, bars[j].h); }
        const T = down && c.downT ? c.downT : c.T, y = down && c.downY ? c.downY : c.y;
        const cap = Math.min(eq / K * (down && c.downSize ? c.downSize : 1), cash);
        if (R) {
          if (R() < c.placebo!.p) { // 무작위: 첫 단을 지금 시가에 시장가, 나머지는 그 가격 대비 같은 간격
            const e0 = b.o * (1 + SLIP);
            const lims = c.rungs.map(x => e0 * (1 - (x - c.rungs[0]) * mul / 100));
            const p: Pos = { cap, units: 0, cost: 0, te: b.ts, T, y, lims, w: W0, filled: lims.map(() => false), tpOn: b.ts + barMs, nf: 0 };
            const amt = cap * W0[0]; cash -= amt; p.units = amt * (1 - FEE) / e0; p.cost = amt; p.filled[0] = true; p.nf = 1; pos.push(p); ladders++;
          }
        } else {
          if (!Number.isNaN(unit)) pend = { lims: c.rungs.map(x => ref * (1 - x * unit * mul / 100)), w: W0, T, y, until: bStart + c.tf, active: bStart + (c.delay ?? 0) * 60e3, cap, fresh: true };
        }
      }
    }
    // 5) 대기 사다리 체결 → 포지션 생성
    if (pend && b.ts < pend.until && b.ts + barMs > pend.active) {
      let p: Pos | null = null;
      // 첫 유효 봉: 시가가 이미 지정가 이하면 '시장성 주문' — 시가 + 슬리피지 체결(chase) 또는 그 단 포기(고점 기준 기본)
      const fresh = pend.fresh; pend.fresh = false;
      if (fresh) { pend.lims = [...pend.lims]; }
      for (let j = 0; j < nR; j++) {
        let px = 0;
        if (fresh && b.o <= pend.lims[j]) { if (c.ref === 'high' && !c.chase) { pend.lims[j] = -Infinity; continue; } px = b.o * (1 + SLIP); }
        else if (b.l <= pend.lims[j] * (1 - pen)) px = pend.lims[j];
        if (!px) continue;
        if (!p) { p = { cap: pend.cap, units: 0, cost: 0, te: b.ts, T: pend.T, y: pend.y, lims: pend.lims, w: pend.w, filled: pend.lims.map(() => false), tpOn: c.tpDelay ? bStart + c.tf : b.ts + barMs, nf: 0 }; }
        const amt = Math.min(pend.cap * pend.w[j], cash); if (amt <= 1e-9) continue;
        cash -= amt; p.units += amt * (1 - FEE) / px; p.cost += amt; p.filled[j] = true; p.nf++;
      }
      if (p && p.nf > 0) { pos.push(p); pend = null; ladders++; }
    }
    const inv = pos.reduce((s, p) => s + p.units * b.c, 0); const eq = cash + inv;
    expoSum += inv / eq; expoN++;
    eqAt.push([b.ts + barMs, eq]);
  }
  return { eqAt, trades, expo: expoSum / Math.max(expoN, 1), ladders, eligible };
}

// ───────────── 지표 ─────────────
export type Series = Map<number, number>;
export function toDaily(eqAt: Array<[number, number]>): Series {
  const last = new Map<number, number>(); for (const [t, e] of eqAt) last.set(Math.floor((t - 1) / DAY) * DAY, e);
  const days = [...last.keys()].sort((a, b) => a - b); const s: Series = new Map(); let prev = eqAt.length ? 1 : 1;
  for (const d of days) { const e = last.get(d)!; s.set(d, e / prev - 1); prev = e; } return s;
}
export function win(s: Series, a: number, b: number): Array<[number, number]> { return [...s].filter(([t]) => t >= a && t < b).sort((x, y) => x[0] - y[0]); }
export function metrics(rs: Array<[number, number]>, f = 1) {
  let e = 1, pk = 1, mdd = 0, s = 0, s2 = 0;
  for (const [, r0] of rs) { const r = f * r0; e *= 1 + r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); s += r; s2 += r * r; }
  const n = Math.max(rs.length, 1), yrs = n / 365, mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-14));
  return { tot: 100 * (e - 1), cagr: 100 * (Math.pow(Math.max(e, 1e-9), 1 / Math.max(yrs, 1e-9)) - 1), mdd: 100 * mdd, sharpe: (mu / sd) * Math.sqrt(365), n: rs.length };
}
export function eqMdd(rs: Array<[number, number]>, target = 17, fmax = 1) {
  const m = metrics(rs, fmax); if (m.mdd <= target) return { f: fmax, ...m };
  let lo = 0, hi = fmax; for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (metrics(rs, mid).mdd > target) hi = mid; else lo = mid; }
  return { f: lo, ...metrics(rs, lo) };
}
export function tradeStats(tr: Trade[], a = -Infinity, b = Infinity) {
  const t = tr.filter(x => x.te >= a && x.te < b); const n = t.length;
  const yrs = (Math.min(b, Date.now()) - a) / (365 * DAY);
  const wr = n ? t.filter(x => x.ret > 0).length / n : 0, avg = n ? t.reduce((s, x) => s + x.ret, 0) / n : 0;
  const worst = n ? Math.min(...t.map(x => x.ret)) : 0;
  const tp = n ? t.filter(x => x.reason === 'TP').length / n : 0;
  return { n, perYr: n / Math.max(yrs, 1e-9), wr: 100 * wr, avg: 100 * avg, worst: 100 * worst, tpShare: 100 * tp, avgUsed: n ? 100 * t.reduce((s, x) => s + x.used, 0) / n : 0 };
}
/** 국면별(배타 a/b/c) 일수익 평균(bp)·누적(%)·일수 */
export function byRegime(rs: Array<[number, number]>, f = 1) {
  const o: Record<string, { n: number; mean: number; cum: number }> = {};
  for (const L of ['a', 'b', 'c']) { const xs = rs.filter(([t]) => regimeLabel(t) === L).map(([, r]) => f * r); let e = 1; for (const r of xs) e *= 1 + r; o[L] = { n: xs.length, mean: xs.length ? 1e4 * xs.reduce((s, r) => s + r, 0) / xs.length : 0, cum: 100 * (e - 1) }; }
  return o;
}
export const PERIODS: Array<[string, number, number]> = [
  ['2021-04~12', Date.UTC(2021, 3, 1), Date.UTC(2022, 0, 1)], ['2022H1', Date.UTC(2022, 0, 1), Date.UTC(2022, 6, 1)], ['2022H2', Date.UTC(2022, 6, 1), Date.UTC(2023, 0, 1)],
  ['2023', Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)], ['2024H1', Date.UTC(2024, 0, 1), Date.UTC(2024, 6, 1)], ['2024H2', Date.UTC(2024, 6, 1), Date.UTC(2025, 0, 1)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)], ['2026YTD', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)],
];
export const byPeriod = (s: Series, f = 1) => PERIODS.map(([lab, a, b]) => [lab, metrics(win(s, a, b), f).tot] as [string, number]);
export const P = (x: number, d = 0) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
export const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };

/** 함대(daily-series.json) 보완성: 상관(vs 각 전략·균등합), 균등합 손실일 평균 */
export function fleetCheck(s: Series) {
  const F = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8')) as Record<string, [number, number][]>;
  const ids = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP', 'F7_sl*'];
  const M: Record<string, Map<number, number>> = {}; for (const id of ids) M[id] = new Map(F[id].map(([t, r]) => [Math.floor(t / DAY) * DAY, r]));
  const days = [...s.keys()].filter(d => ids.every(id => M[id].has(d))).sort((a, b) => a - b);
  const me = days.map(d => s.get(d)!); const fl = days.map(d => ids.reduce((x, id) => x + M[id].get(d)!, 0) / ids.length);
  const flNoDip = days.map(d => ids.filter(i => i !== 'BTC_DIP').reduce((x, id) => x + M[id].get(d)!, 0) / (ids.length - 1));
  const out: Record<string, number> = {};
  for (const id of ids) out['corr_' + id] = corr(me, days.map(d => M[id].get(d)!));
  out.corr_fleet = corr(me, fl);
  const lossIdx = fl.map((r, i) => r < 0 ? i : -1).filter(i => i >= 0);
  out.lossDays = lossIdx.length; out.meOnLoss_bp = 1e4 * lossIdx.reduce((x, i) => x + me[i], 0) / lossIdx.length;
  out.dipOnLoss_bp = 1e4 * lossIdx.reduce((x, i) => x + M.BTC_DIP.get(days[i])!, 0) / lossIdx.length;
  out.fleetOnLoss_bp = 1e4 * lossIdx.reduce((x, i) => x + fl[i], 0) / lossIdx.length;
  out.days = days.length; out.from = days[0]; out.to = days[days.length - 1];
  // 함대(BTC_DIP 제외) + 후보 1/7 로 교체했을 때 샤프 변화
  const mk = (arr: number[]) => metrics(arr.map((r, i) => [days[i], r] as [number, number]));
  out.fleetSharpe = mk(fl).sharpe; out.fleetMdd = mk(fl).mdd;
  const swap = days.map((_, i) => (flNoDip[i] * (ids.length - 1) + me[i]) / ids.length);
  out.swapSharpe = mk(swap).sharpe; out.swapMdd = mk(swap).mdd;
  const add = days.map((_, i) => (fl[i] * ids.length + me[i]) / (ids.length + 1));
  out.addSharpe = mk(add).sharpe; out.addMdd = mk(add).mdd;
  return out;
}

// ───────────── 공유 현금 다중 레그(가동률) ─────────────
export interface Leg { name: string; bars: Bar[]; barMs: number; cfg: Cfg; size: number }   // size: 진입 시 총자산 대비 비중(현금 한도)
/** 레그마다 독립 규칙(단일 포지션·사다리), 현금은 하나. 같은 봉에서 여러 레그가 체결되면 레그 순서대로 현금 배정. */
export function simLegs(legs: Leg[], from: number, to: number) {
  const tsSet = new Set<number>(); const maps = legs.map(L => { const m = new Map<number, number>(); L.bars.forEach((b, i) => { if (b.ts >= from - 2 * L.cfg.tf && b.ts < to) { m.set(b.ts, i); tsSet.add(b.ts); } }); return m; });
  const TL = [...tsSet].sort((a, b) => a - b);
  let cash = 1; const trades: Array<Trade & { leg: string }> = []; const eqAt: Array<[number, number]> = [];
  type St = { pos: Pos | null; pend: { lims: number[]; w: number[]; T: number; y: number; until: number; cap: number; fresh: boolean } | null; last: number };
  const st: St[] = legs.map(() => ({ pos: null, pend: null, last: NaN }));
  let expoS = 0, expoN = 0;
  const equity = () => cash + st.reduce((s, x) => s + (x.pos ? x.pos.units * x.last : 0), 0);
  for (const t of TL) {
    for (let li = 0; li < legs.length; li++) {
      const L = legs[li], c = L.cfg, S = st[li]; const k = maps[li].get(t); if (k === undefined || k < 1) continue;
      const b = L.bars[k], pb = L.bars[k - 1]; if (t < from) { S.last = b.c; continue; }
      const pen = c.pen ?? 0.002, FEE = c.fee ?? 0.0005, SLIP = c.slip ?? 0.0002, nR = c.rungs.length, W0 = c.wts ?? c.rungs.map(() => 1 / nR);
      const bStart = Math.floor(t / c.tf) * c.tf; let exited = false;
      const p = S.pos;
      if (p) {
        if (t - p.te >= p.T * H) { const got = p.units * b.o * (1 - SLIP) * (1 - FEE); cash += got; trades.push({ leg: L.name, te: p.te, tx: t, ret: got / p.cost - 1, slotRet: (got - p.cost) / p.cap, reason: 'TIME', fills: p.nf, used: p.cost / p.cap }); S.pos = null; exited = true; }
        else if (t >= p.tpOn) {
          let wf = false; for (let j = 0; j < nR; j++) if (!p.filled[j] && b.l <= p.lims[j] * (1 - pen)) wf = true;
          const tgt = p.cost / p.units * (1 - FEE) * (1 + p.y / 100);
          if (!wf && b.h >= tgt * (1 + pen)) { const got = p.units * tgt * (1 - FEE); cash += got; trades.push({ leg: L.name, te: p.te, tx: t, ret: got / p.cost - 1, slotRet: (got - p.cost) / p.cap, reason: 'TP', fills: p.nf, used: p.cost / p.cap }); S.pos = null; exited = true; }
        }
        if (S.pos) for (let j = 0; j < nR; j++) if (!p.filled[j] && b.l <= p.lims[j] * (1 - pen)) { const amt = Math.min(p.cap * p.w[j], cash); if (amt <= 1e-9) continue; cash -= amt; p.units += amt * (1 - FEE) / p.lims[j]; p.cost += amt; p.filled[j] = true; p.nf++; p.tpOn = Math.max(p.tpOn, t + L.barMs); }
      }
      if (t % c.tf === 0) {
        S.pend = null;
        if (!S.pos && !exited) {
          const down = belowAt(t, c.sma ?? 50); const ok = c.regime === 'below' ? down : c.regime === 'above' ? !down : true;
          if (ok) { const mul = down && c.downMul ? c.downMul : 1; S.pend = { lims: c.rungs.map(x => pb.c * (1 - x * mul / 100)), w: W0, T: down && c.downT ? c.downT : c.T, y: c.y, until: bStart + c.tf, cap: 0, fresh: true }; }
        }
      }
      if (S.pend && t < S.pend.until) {
        const pd = S.pend; let np: Pos | null = null;
        for (let j = 0; j < nR; j++) {
          let px = 0; if (pd.fresh && b.o <= pd.lims[j]) px = b.o * (1 + SLIP); else if (b.l <= pd.lims[j] * (1 - pen)) px = pd.lims[j]; if (!px) continue;
          if (!np) { const cap = Math.min(equity() * L.size, cash + 0); if (cap < 1e-6) break; np = { cap, units: 0, cost: 0, te: t, T: pd.T, y: pd.y, lims: pd.lims, w: pd.w, filled: pd.lims.map(() => false), tpOn: t + L.barMs, nf: 0 }; }
          const amt = Math.min(np.cap * pd.w[j], cash); if (amt <= 1e-9) continue; cash -= amt; np.units += amt * (1 - FEE) / px; np.cost += amt; np.filled[j] = true; np.nf++;
        }
        pd.fresh = false;
        if (np && np.nf > 0) { S.pos = np; S.pend = null; }
      }
      S.last = b.c;
    }
    if (t < from) continue;
    const eq = equity(); expoS += (eq - cash) / eq; expoN++; eqAt.push([t + Q, eq]);
  }
  return { eqAt, trades, expo: expoS / Math.max(expoN, 1) };
}
