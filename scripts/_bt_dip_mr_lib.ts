/**
 * dip-2026-10 / mr 축 — BTC·ETH 과매도 평균회귀 공통 라이브러리.
 *
 * 데이터: data/research-ext/daily/KRW-{BTC,ETH}.json (2017-09-25~, UTC 00:00 = KST 09:00 경계)
 *   + 마지막 날(스냅샷 도중 받은 미완성 봉) 대신 4h 캐시(2022-06~2026-10-13)를 일 단위로 합쳐 2026-10-02~10-12 를 붙인다
 *   (겹치는 1,575일 중 불일치는 그 미완성 1일뿐 — 검증함).
 * 4h: data/candle-cache/KRW-{BTC,ETH}_240m_2022-06-10_2026-10-13.json (마지막 미완성 봉 제외).
 *
 * 체결 규약 (BRIEF 검증기준 1):
 *   - 신호 = 봉 i 종가 확정 후 판단. 시장가 진입 = 봉 i+1+lag 시가 × (1+슬리피지), 슬리피지 = max(0.05%, 스프레드½).
 *   - 지정가 매수 대안 = 봉 i 종가 × (1−k%) 를 봉 i+1 동안 걸어둠, 저가 ≤ 지정가×(1−0.2%) 이면 지정가 체결(슬리피지 0).
 *     지정가 체결 봉에서는 TP 를 인정하지 않는다(일봉 경로 순서 불명 → 보수).
 *   - TP = 진입 직후 지정가 매도. 고가 ≥ 목표×(1+0.2%) 이면 목표가 체결(슬리피지 0, 수수료만). 시가 진입 봉 포함
 *     (시가 이후의 고가이므로 경로 문제 없음). 스톱 없음.
 *   - SMA5 회귀 청산: 종가 > SMA5(종가) 이면 다음 봉 시가 시장가.
 *   - 시간청산: 진입 봉 e 기준 봉 e+N 시가에 시장가 (= N 봉 보유).
 *   - 수수료 0.05%/편도. 비용×2 = 수수료·슬리피지 모두 2배.
 */
import fs from 'fs';
import path from 'path';

export const DAY = 86400e3, H = 3600e3;
export const ROOT = process.cwd();
export const OUT = path.resolve(ROOT, 'data/research-ext/dip-2026-10/mr');
fs.mkdirSync(OUT, { recursive: true });
export interface Bar { ts: number; open: number; high: number; low: number; close: number }
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'data/research-spread-p50.json'), 'utf8'));
export const slipOf = (m: string) => Math.max(0.0005, (SPREAD[m] ?? 10) / 2 / 1e4);

function load4h(m: string): Bar[] {
  const b: Bar[] = JSON.parse(fs.readFileSync(path.resolve(ROOT, `data/candle-cache/${m}_240m_2022-06-10_2026-10-13.json`), 'utf8'));
  return b.filter(x => x.ts + 4 * H <= Date.UTC(2026, 9, 13, 0, 0)).map(x => ({ ts: x.ts, open: x.open, high: x.high, low: x.low, close: x.close }));
}
function loadDaily(m: string): Bar[] {
  const d: Bar[] = JSON.parse(fs.readFileSync(path.resolve(ROOT, `data/research-ext/daily/${m}.json`), 'utf8'));
  const h = load4h(m); const ag = new Map<number, Bar & { n: number }>();
  for (const b of h) { const k = Math.floor(b.ts / DAY) * DAY; const a = ag.get(k); if (!a) ag.set(k, { ts: k, open: b.open, high: b.high, low: b.low, close: b.close, n: 1 }); else { a.high = Math.max(a.high, b.high); a.low = Math.min(a.low, b.low); a.close = b.close; a.n++; } }
  const cut = Date.UTC(2026, 9, 2);
  const out: Bar[] = d.filter(x => x.ts < cut).map(x => ({ ts: x.ts, open: x.open, high: x.high, low: x.low, close: x.close }));
  for (const a of [...ag.values()].sort((x, y) => x.ts - y.ts)) if (a.ts >= cut && a.n === 6) out.push({ ts: a.ts, open: a.open, high: a.high, low: a.low, close: a.close });
  return out;
}
export const DB = loadDaily('KRW-BTC');
const ETHraw = loadDaily('KRW-ETH');
// ETH 를 BTC 날짜축에 맞춤(2017-10-21~23 결측 3일은 직전 종가로 평탄 채움 — 그 날엔 진입·청산 없음)
export const DE: Bar[] = (() => { const m = new Map(ETHraw.map(x => [x.ts, x])); let last: Bar | null = null; return DB.map(b => { const x = m.get(b.ts); if (x) { last = x; return x; } const c = last!.close; return { ts: b.ts, open: c, high: c, low: c, close: c }; }); })();
export const H4B = load4h('KRW-BTC'), H4E = load4h('KRW-ETH');

// ───────── 지표 ─────────
export function rsi(c: number[], n: number): Float64Array {
  const r = new Float64Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return r;
}
export function sma(c: number[], n: number): Float64Array { const r = new Float64Array(c.length).fill(NaN); let s = 0; for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) r[i] = s / n; } return r; }
export function sd(c: number[], n: number): Float64Array { const r = new Float64Array(c.length).fill(NaN); for (let i = n - 1; i < c.length; i++) { let s = 0, s2 = 0; for (let j = i - n + 1; j <= i; j++) { s += c[j]; s2 += c[j] * c[j]; } const m = s / n; r[i] = Math.sqrt(Math.max(s2 / n - m * m, 0)); } return r; }
/** 확장창 분위(0~1): i 시점 값이 i 이전(포함) 이력 중 몇 분위인지. minHist 미만이면 NaN */
export function expandingPct(x: Float64Array, minHist = 180): Float64Array {
  const r = new Float64Array(x.length).fill(NaN); const hist: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) continue;
    // 이진 삽입
    let lo = 0, hi = hist.length; while (lo < hi) { const m = (lo + hi) >> 1; if (hist[m] < x[i]) lo = m + 1; else hi = m; }
    hist.splice(lo, 0, x[i]);
    if (hist.length >= minHist) r[i] = lo / (hist.length - 1);
  }
  return r;
}

/** 자산별 신호 재료 */
export function feats(b: Bar[]) {
  const c = b.map(x => x.close), hi = b.map(x => x.high), lo = b.map(x => x.low);
  const n = b.length;
  const dnRun = new Int32Array(n); for (let i = 1; i < n; i++) dnRun[i] = c[i] < c[i - 1] ? dnRun[i - 1] + 1 : 0;
  const lowestN = (N: number) => { const r = new Uint8Array(n); for (let i = N - 1; i < n; i++) { let ok = true; for (let j = i - N + 1; j < i; j++) if (c[j] <= c[i]) { ok = false; break; } r[i] = ok ? 1 : 0; } return r; };
  const ddFromHigh = (N: number) => { const r = new Float64Array(n).fill(NaN); for (let i = N - 1; i < n; i++) { let m = -Infinity; for (let j = i - N + 1; j <= i; j++) m = Math.max(m, hi[j]); r[i] = c[i] / m - 1; } return r; };
  const lr = new Float64Array(n); for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1]);
  const vol20 = new Float64Array(n).fill(NaN); for (let i = 20; i < n; i++) { let s = 0, s2 = 0; for (let j = i - 19; j <= i; j++) { s += lr[j]; s2 += lr[j] ** 2; } vol20[i] = Math.sqrt(Math.max(s2 / 20 - (s / 20) ** 2, 0)); }
  const box20 = new Float64Array(n).fill(NaN); for (let i = 19; i < n; i++) { let mh = -Infinity, ml = Infinity; for (let j = i - 19; j <= i; j++) { mh = Math.max(mh, hi[j]); ml = Math.min(ml, lo[j]); } box20[i] = mh / ml - 1; }
  return { c, rsi2: rsi(c, 2), rsi3: rsi(c, 3), sma5: sma(c, 5), sma20: sma(c, 20), sd20: sd(c, 20), sma50: sma(c, 50), dnRun, lowestN, ddFromHigh, vol20, box20, volPct: expandingPct(vol20), boxPct: expandingPct(box20) };
}
export const FB = feats(DB), FE = feats(DE);

// ───────── BTC 국면 (일 단위, 그날 종가 기준) ─────────
export const RG = (() => {
  const c = FB.c, n = c.length; const below = new Uint8Array(n), side = new Uint8Array(n), ret20 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { if (i >= 49) below[i] = c[i] < FB.sma50[i] ? 1 : 0; if (i >= 20) { ret20[i] = c[i] / c[i - 20] - 1; side[i] = ret20[i] <= 0.02 ? 1 : 0; } }
  return { below, side, ret20 };
})();
export const TI = new Map(DB.map((b, i) => [b.ts, i]));
/** 그날 라벨: a=BTC<SMA50, b=20일수익≤+2%(a 와 겹칠 수 있음), c=둘 다 아님 */
export function regimeOfDay(ts: number, prior = false): { a: boolean; b: boolean; c: boolean } | null {
  let i = TI.get(ts); if (i === undefined) return null; if (prior) i--; if (i < 50) return null;
  const a = !!RG.below[i], b = !!RG.side[i]; return { a, b, c: !a && !b };
}

// ───────── 시뮬 엔진 (단일 자산 단일 슬리브) ─────────
export interface Cfg { entry: 'open' | number /* 지정가 k% */; tp: number | null; sma5x: boolean; N: number; lag?: number; pen?: number; feeMul?: number; f?: number; disallowTpEntryBar?: boolean }
export interface Trade { si: number; e: number; x: number; r: number; why: string }
export function simulate(b: Bar[], sma5: Float64Array, sig: Uint8Array, cfg: Cfg, market: string, i0 = 0, i1 = b.length - 1) {
  const fee = 0.0005 * (cfg.feeMul ?? 1), slip = slipOf(market) * (cfg.feeMul ?? 1), pen = cfg.pen ?? 0.002, lag = cfg.lag ?? 0, f = cfg.f ?? 1;
  const ret = new Float64Array(b.length); const trades: Trade[] = []; const inPos = new Uint8Array(b.length);
  let cash = 1, units = 0, pe = 0, e = -1, si = -1, sigBar = -1, smaFlag = false, limitEntry = false;
  let eqPrev = 1;
  for (let i = i0; i <= i1; i++) {
    const x = b[i];
    // 1) 시가: 시간청산 / SMA5 청산
    if (units > 0 && (i - e >= cfg.N || smaFlag)) {
      const got = units * x.open * (1 - slip) * (1 - fee); trades.push({ si, e, x: i, r: got / (units * pe / (1 - fee)) - 1, why: smaFlag && i - e < cfg.N ? 'SMA5' : 'TIME' }); cash += got; units = 0; smaFlag = false;
    }
    // 2) 진입
    let enteredLimit = false;
    if (units === 0 && sigBar >= 0 && i === sigBar + 1 + lag) {
      const stake = cash * f;
      if (cfg.entry === 'open') { pe = x.open * (1 + slip); units = stake * (1 - fee) / pe; cash -= stake; e = i; si = sigBar; limitEntry = false; }
      else { const lim = b[sigBar].close * (1 - cfg.entry / 100); if (x.low <= lim * (1 - pen) && x.open > lim) { pe = lim; units = stake * (1 - fee) / pe; cash -= stake; e = i; si = sigBar; limitEntry = true; enteredLimit = true; } }
      sigBar = -1;
    }
    // 3) 장중 TP
    if (units > 0 && cfg.tp != null && !(enteredLimit && (cfg.disallowTpEntryBar ?? true))) {
      const tgt = pe * (1 + cfg.tp / 100);
      if (x.high >= tgt * (1 + pen)) { const got = units * tgt * (1 - fee); trades.push({ si, e, x: i, r: got / (units * pe / (1 - fee)) - 1, why: 'TP' }); cash += got; units = 0; smaFlag = false; }
    }
    // 4) 종가: 평가·SMA5 플래그·신호
    const eq = cash + units * x.close; ret[i] = eq / eqPrev - 1; eqPrev = eq; inPos[i] = units > 0 ? 1 : 0;
    if (units > 0 && cfg.sma5x && x.close > sma5[i]) smaFlag = true;
    if (units === 0 && sig[i] && sigBar < 0) sigBar = i;
  }
  return { ret, trades, inPos };
}

// ───────── 지표 ─────────
export function metrics(ret: Float64Array | number[], ts: number[], i0: number, i1: number, barsPerYear = 365) {
  let e = 1, pk = 1, mdd = 0, s = 0, s2 = 0, n = 0;
  for (let i = i0; i <= i1; i++) { const r = ret[i]; e *= 1 + r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); s += r; s2 += r * r; n++; }
  const yrs = (ts[i1] - ts[i0]) / (365.25 * DAY) || 1e-9; const mu = s / n, sdv = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-18));
  return { tot: 100 * (e - 1), cagr: 100 * (Math.pow(e, 1 / yrs) - 1), mdd: 100 * mdd, sharpe: (mu / sdv) * Math.sqrt(barsPerYear), yrs };
}
export function tradeStats(tr: Trade[], yrs: number) {
  const n = tr.length; const w = tr.filter(t => t.r > 0).length; const avg = n ? tr.reduce((a, t) => a + t.r, 0) / n : 0;
  const worst = n ? Math.min(...tr.map(t => t.r)) : 0;
  return { n, perYr: n / yrs, win: n ? 100 * w / n : 0, avg: 100 * avg, worst: 100 * worst };
}
/** f 이분탐색으로 MDD 목표 맞춤(f ≤ 1) */
export function scaleTo(ret: Float64Array, ts: number[], i0: number, i1: number, target = 17) {
  const m1 = metrics(ret, ts, i0, i1); if (m1.mdd <= target) return { f: 1, ...m1 };
  let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; const r = Float64Array.from(ret, v => v * mid); if (metrics(r, ts, i0, i1).mdd > target) hi = mid; else lo = mid; }
  return { f: lo, ...metrics(Float64Array.from(ret, v => v * lo), ts, i0, i1) };
}
export const P = (x: number, d = 0) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
export const idxAtOrAfter = (ts: number[], t: number) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
/** 시드 고정 난수 */
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** 4h 봉 수익 → UTC 일 수익 */
export function toDailyFromBars(b: Bar[], ret: Float64Array): Map<number, number> {
  const m = new Map<number, number>(); for (let i = 0; i < b.length; i++) { const d = Math.floor(b[i].ts / DAY) * DAY; m.set(d, (1 + (m.get(d) ?? 0)) * (1 + ret[i]) - 1); } return m;
}
/** 국면별 일수익 평균·누적 */
export function regimeReport(daily: Map<number, number>, from: number, to: number, prior = false) {
  const acc: Record<string, { n: number; s: number; cum: number }> = { a: { n: 0, s: 0, cum: 1 }, b: { n: 0, s: 0, cum: 1 }, c: { n: 0, s: 0, cum: 1 } };
  for (const [t, r] of daily) { if (t < from || t >= to) continue; const g = regimeOfDay(t, prior); if (!g) continue; for (const k of ['a', 'b', 'c'] as const) if (g[k]) { acc[k].n++; acc[k].s += r; acc[k].cum *= 1 + r; } }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { days: v.n, avgBp: v.n ? 1e4 * v.s / v.n : 0, cum: 100 * (v.cum - 1) }]));
}

/** 롤링창 분위(0~1): 직전 win 개(포함) 중 순위. 이력 부족 시 NaN */
export function rollingPct(x: Float64Array, win = 365, minHist = 180): Float64Array {
  const r = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) { if (Number.isNaN(x[i])) continue; let lt = 0, n = 0; for (let j = Math.max(0, i - win + 1); j <= i; j++) { if (Number.isNaN(x[j])) continue; n++; if (x[j] < x[i]) lt++; } if (n >= minHist) r[i] = lt / (n - 1); }
  return r;
}
