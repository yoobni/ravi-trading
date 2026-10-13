/**
 * 저점매수 리서치(2026-10) 축 ALT — 공통 일봉 엔진 (리서치 전용, 라이브 무관)
 *
 * 데이터: data/research-ext/daily (업비트 KRW 전 종목 일봉, 2017~2026-10-02, 상폐 종목 없음 → 저점매수엔 상한)
 * 유니버스: 날짜 i 종가 시점 직전 30일 거래대금 합 상위 N (스테이블 제외, 이력 ≥30일, BTC 는 별도 플래그)
 * 타이밍: 신호 = i일 종가 확정 직후 → i+1 시가 시장가 진입 (+ 슬리피지 = 스프레드½)
 *   스프레드: 28코인은 실측 p50, 그 밖은 log(스프레드)~log(30일 평균 거래대금) 적합값 ×1.3, 틱/가격, 10bp 중 최대
 * 청산: TP 지정가(진입 직후 걸어둠, 고가 ≥ 목표×(1+0.2%) 일 때만 목표가 체결, 슬리피지 0)
 *       / exitSig(i 종가 판단 → i+1 시가 시장가) / H일째 종가 시장가. 무스톱.
 * 튐 서명 검사: 같은 신호·같은 청산경로에서 '신호일 종가 진입(무슬리피지)' 수익과 '다음날 시가 진입(+슬리피지)' 수익 비교.
 */
import fs from 'fs';
import path from 'path';

export const DAY = 86400e3;
const D = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
export const STABLE = new Set(['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'TUSD', 'PYUSD', 'FDUSD', 'USDE', 'RLUSD', 'EURC', 'USD0']);
export interface Bar { ts: number; open: number; high: number; low: number; close: number; value: number }

const RAW = new Map<string, Bar[]>();
for (const f of fs.readdirSync(D).filter(f => f.startsWith('KRW-'))) {
  const m = f.replace('.json', '');
  if (STABLE.has(m.slice(4))) continue;
  const b: Bar[] = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  const done = b.filter(x => x.ts + DAY <= Date.UTC(2026, 9, 2, 0, 0) + DAY && x.close > 0).sort((a, c) => a.ts - c.ts);
  if (done.length >= 60) RAW.set(m, done);
}
export const MK = [...RAW.keys()];
export const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
export const TI = new Map(TS.map((t, i) => [t, i]));
export const G = new Map<string, (Bar | null)[]>();
for (const [m, b] of RAW) { const a: (Bar | null)[] = new Array(TS.length).fill(null); for (const x of b) a[TI.get(x.ts)!] = x; G.set(m, a); }

// 30일 거래대금
export const VAL30 = new Map<string, Float64Array>();
const HIST = new Map<string, Int32Array>();
for (const m of MK) {
  const a = G.get(m)!; const v = new Float64Array(TS.length); const h = new Int32Array(TS.length);
  let s = 0, cnt = 0; const q: number[] = [];
  for (let i = 0; i < TS.length; i++) { const x = a[i]; const val = x ? x.value : 0; q.push(val); s += val; if (q.length > 30) s -= q.shift()!; if (x) cnt++; v[i] = s; h[i] = cnt; }
  VAL30.set(m, v); HIST.set(m, h);
}
/** RANK[i]: 알트(BTC 포함) 순위 맵, 0 = 최상위 */
export const RANK: Map<string, number>[] = TS.map((_, i) => {
  const arr = MK.filter(m => G.get(m)![i] && HIST.get(m)![i] >= 30).map(m => [m, VAL30.get(m)![i]] as [string, number]).sort((a, b) => b[1] - a[1]);
  return new Map(arr.map(([m], r) => [m, r]));
});
/** 알트 순위(BTC 제외) */
export const ARANK: Map<string, number>[] = RANK.map(r => { const o = new Map<string, number>(); let k = 0; for (const [m] of [...r.entries()].sort((a, b) => a[1] - b[1])) { if (m === 'KRW-BTC') continue; o.set(m, k++); } return o; });

// 스프레드 모델
// 2023 이전 업비트 KRW 호가단위는 저가 코인에서 더 굵었다(보수적으로 구 테이블 사용)
const tickOld = (p: number) => p >= 2e6 ? 1000 : p >= 1e6 ? 500 : p >= 5e5 ? 100 : p >= 1e5 ? 50 : p >= 1e4 ? 10 : p >= 1e3 ? 5 : p >= 100 ? 1 : p >= 10 ? 0.1 : p >= 1 ? 0.01 : 0.001;
const tick = (p: number) => p >= 2e6 ? 1000 : p >= 1e6 ? 500 : p >= 5e5 ? 100 : p >= 1e5 ? 50 : p >= 1e4 ? 10 : p >= 1e3 ? 1 : p >= 100 ? 0.1 : p >= 10 ? 0.01 : p >= 1 ? 0.001 : p >= 0.1 ? 0.0001 : 0.00001;
let SLIPMUL = 1, FEE0 = 0.0005;
export let FEE = FEE0;
export const setCost = (k: number) => { SLIPMUL = k; FEE = FEE0 * k; };
/** 편도 슬리피지(비율). i = 진입/청산 판단 시점 인덱스 */
export function slip(m: string, i: number, px?: number): number {
  let spBps: number;
  if (SPREAD[m] != null) spBps = SPREAD[m];
  else {
    const v = VAL30.get(m)![i] / 30; const fit = Math.exp(12.885 - 0.437 * Math.log(Math.max(v, 1e7))) * 1.3;
    const p = px ?? G.get(m)![i]?.close ?? 1; spBps = Math.max(fit, ((TS[i] < Date.UTC(2023, 0, 1) ? tickOld(p) : tick(p)) / p) * 1e4, 15); spBps = Math.min(spBps, 150);   // 리디노미네이션 수정가(BTT 등)로 틱 추정이 폭주하는 것 방지
  }
  return SLIPMUL * Math.max(0.0005, spBps / 2 / 1e4);
}
export const spreadBps = (m: string, i: number) => slip(m, i) * 2e4 / SLIPMUL;

// BTC 국면
const btc = G.get('KRW-BTC')!;
export const BTC = btc;
export const BTC_SMA50 = new Float64Array(TS.length).fill(NaN);
for (let i = 49; i < TS.length; i++) { let s = 0, n = 0; for (let j = i - 49; j <= i; j++) if (btc[j]) { s += btc[j]!.close; n++; } if (n >= 45) BTC_SMA50[i] = s / n; }
/** i일 종가 기준 국면: a = BTC < SMA50, b = (아니고) 20일 수익 ≤ +2%, c = 그 외 */
export const REGIME: ('a' | 'b' | 'c' | null)[] = TS.map((_, i) => {
  const x = btc[i]; if (!x || Number.isNaN(BTC_SMA50[i]) || !btc[i - 20]) return null;
  if (x.close < BTC_SMA50[i]) return 'a';
  if (x.close / btc[i - 20]!.close - 1 <= 0.02) return 'b';
  return 'c';
});
export const btcRet = (i: number, k: number) => (btc[i] && btc[i - k] ? btc[i]!.close / btc[i - k]!.close - 1 : null);

export const ret = (m: string, i: number, k: number) => { const a = G.get(m)![i], b = G.get(m)![i - k]; return a && b ? a.close / b.close - 1 : null; };
export function valZ(m: string, i: number, w = 30) {
  const a = G.get(m)!; let s = 0, s2 = 0, n = 0;
  for (let j = i - w; j < i; j++) { const x = a[j]; if (!x) continue; s += x.value; s2 += x.value ** 2; n++; }
  if (n < 20 || !a[i]) return null; const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-9));
  return (a[i]!.value - mu) / sd;
}

// ── 공통 청산 경로 ──
export type Sig = (m: string, i: number) => number | null;            // i 종가 판단, 강도(클수록 우선)
export interface Exit { tp: number | null; H: number; pen?: number; exitSig?: (m: string, i: number, entryI: number) => boolean }
/** 진입가 ep, 진입일 e(시가 진입이면 e 의 고가부터 TP 인정). 반환: 청산가(슬리피지 반영), 청산일 */
export function walk(m: string, e: number, ep: number, x: Exit, sigI: number): { px: number; k: number; kind: string } | null {
  const a = G.get(m)!; const pen = x.pen ?? 0.002; const tgt = x.tp != null ? ep * (1 + x.tp / 100) : Infinity;
  let held = 0, lastI = e;
  for (let k = e; k < TS.length; k++) {
    const b = a[k]; if (!b) continue; lastI = k;
    if (b.high >= tgt * (1 + pen)) return { px: tgt, k, kind: 'tp' };
    held++;
    if (held >= x.H) return { px: b.close * (1 - slip(m, k)), k, kind: 'time' };
    if (x.exitSig && x.exitSig(m, k, sigI)) {
      for (let k2 = k + 1; k2 < TS.length; k2++) { const nb = a[k2]; if (nb) return { px: nb.open * (1 - slip(m, k2)), k: k2, kind: 'sig' }; }
    }
  }
  const lb = a[lastI]; return lb ? { px: lb.close, k: lastI, kind: 'eod' } : null;   // 데이터 끝(상폐 누락 포함) → 마지막 종가
}

// ── 이벤트 스터디 (포트폴리오 제약 없음, 같은 코인 보유기간 중복 제거) ──
export interface Ev { m: string; i: number; rank: number; rExec: number; rCC: number; rOO: number; exitK: number; kind: string; ts: number; regime: string | null; spread: number }
export function events(sig: Sig, N: number, x: Exit, opt: { from?: number; to?: number; delay?: number; btcOk?: (i: number) => boolean; inclBTC?: boolean } = {}): Ev[] {
  const out: Ev[] = []; const busy = new Map<string, number>(); const dl = opt.delay ?? 0;
  for (let i = 60; i < TS.length - 1 - dl; i++) {
    if (TS[i] < (opt.from ?? 0) || TS[i] > (opt.to ?? Infinity)) continue;
    if (opt.btcOk && !opt.btcOk(i)) continue;
    const R = opt.inclBTC ? RANK[i] : ARANK[i];
    for (const [m, r] of R) {
      if (r >= N) continue; if (m === 'KRW-BTC' && !opt.inclBTC) continue;
      if ((busy.get(m) ?? -1) >= i) continue;
      const s = sig(m, i); if (s == null) continue;
      const e = i + 1 + dl; const a = G.get(m)!; const eb = a[e]; if (!eb) continue;
      const sp = slip(m, i);
      const epX = eb.open * (1 + sp);
      const w = walk(m, e, epX, x, i); if (!w) continue;
      const rExec = (w.px * (1 - FEE)) / (epX / (1 - FEE)) - 1;
      // 튐 포함 기준: 신호일(i) 종가 진입·무슬리피지, 같은 청산 규칙(목표가도 그 가격 기준)
      const epC = a[i]!.close; const wc = walk(m, e, epC, x, i)!;
      const rCC = (wc.px * (1 - FEE)) / (epC / (1 - FEE)) - 1;
      // 시가 무슬리피지(슬리피지 성분 분리용)
      const epO = eb.open; const wo = walk(m, e, epO, x, i)!;
      const rOO = (wo.px * (1 - FEE)) / (epO / (1 - FEE)) - 1;
      out.push({ m, i, rank: r, rExec, rCC, rOO, exitK: w.k, kind: w.kind, ts: TS[i], regime: REGIME[i], spread: sp * 2e4 });
      busy.set(m, w.k);
    }
  }
  return out;
}
export function evStats(ev: Ev[]) {
  const n = ev.length; if (!n) return { n: 0, mean: 0, med: 0, win: 0, cc: 0, oo: 0, t: 0, pf: 0 };
  const r = ev.map(e => e.rExec); const mean = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const s = [...r].sort((a, b) => a - b); const g = r.filter(x => x > 0).reduce((a, b) => a + b, 0), l = -r.filter(x => x < 0).reduce((a, b) => a + b, 0);
  return { n, mean: 100 * mean, med: 100 * s[Math.floor(n / 2)], win: 100 * r.filter(x => x > 0).length / n, cc: 100 * ev.reduce((a, e) => a + e.rCC, 0) / n, oo: 100 * ev.reduce((a, e) => a + e.rOO, 0) / n, t: mean / (sd / Math.sqrt(n)), pf: l > 0 ? g / l : 99 };
}
/** 유동성 분위(신호 시점 순위 구간) 별 시가 vs 종가 진입 */
export function liqTable(ev: Ev[], bins: [number, number][]) {
  return bins.map(([lo, hi]) => { const e = ev.filter(x => x.rank >= lo && x.rank < hi); const s = evStats(e); return { bin: `${lo + 1}-${hi}`, ...s, bounce: s.cc - s.oo, spread: e.length ? e.reduce((a, x) => a + x.spread, 0) / e.length : 0 }; });
}

// ── 포트폴리오 ──
export interface PCfg { sig: Sig; N: number; K: number; x: Exit; btcOk?: (i: number) => boolean; delay?: number; rand?: number; seed?: number; inclBTC?: boolean; maxPerDay?: number }
export interface PRes { ret: number; mdd: number; n: number; win: number; avg: number; sharpe: number; cagr: number; daily: Float64Array; first: number; last: number; expo: number }
export function port(c: PCfg, size: number, from = Date.UTC(2019, 0, 1), to = Infinity): PRes {
  let cash = 1e7, peak = 1e7, mdd = 0, n = 0, wins = 0, sumR = 0, expoSum = 0, days = 0;
  const open: { m: string; ep: number; vol: number; used: number; tgt: number; held: number; sigI: number; exitNext: boolean; last: number }[] = [];
  const daily = new Float64Array(TS.length).fill(NaN);
  let seed = c.seed ?? 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pen = c.x.pen ?? 0.002; const dl = c.delay ?? 0;
  let prevEq = 1e7, first = -1, last = -1;
  const pendings: { m: string; s: number; j: number }[][] = TS.map(() => []);
  for (let i = 60; i < TS.length; i++) {
    if (TS[i] < from || TS[i] > to) continue;
    if (first < 0) first = i; last = i;
    // 1) 보유분
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const b = G.get(q.m)![i]; if (!b) continue;
      let px = 0;
      if (q.exitNext) px = b.open * (1 - slip(q.m, i));
      else if (b.high >= q.tgt * (1 + pen)) px = q.tgt;
      else {
        q.held++;
        if (q.held >= c.x.H) px = b.close * (1 - slip(q.m, i));
        else if (c.x.exitSig && c.x.exitSig(q.m, i, q.sigI)) q.exitNext = true;
      }
      if (px) { const got = q.vol * px * (1 - FEE); cash += got; n++; const r = got / q.used - 1; sumR += r; if (r > 0) wins++; open.splice(p, 1); }
      else q.last = b.close;
    }
    // 2) 신호(j = i−1−delay 종가) → 오늘 시가 진입
    const j = i - 1 - dl;
    if (j >= 60 && (!c.btcOk || c.btcOk(j))) {
      const R = c.inclBTC ? RANK[j] : ARANK[j];
      const cands: [string, number][] = [];
      for (const [m, r] of R) {
        if (r >= c.N) continue; if (m === 'KRW-BTC' && !c.inclBTC) continue;
        if (!G.get(m)![i]) continue;
        if (c.rand != null) { if (rnd() < c.rand) cands.push([m, rnd()]); continue; }
        const s = c.sig(m, j); if (s != null) cands.push([m, s]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      const eqNow = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
      let taken = 0;
      for (const [m] of cands) {
        if (open.length >= c.K || (c.maxPerDay && taken >= c.maxPerDay)) break;
        if (open.some(q => q.m === m)) continue;
        const b = G.get(m)![i]!; const ep = b.open * (1 + slip(m, j));
        const used = Math.min(cash, eqNow * size); if (used < 5000) continue;
        cash -= used; taken++;
        const tgt = c.x.tp != null ? ep * (1 + c.x.tp / 100) : Infinity;
        const q = { m, ep, vol: used * (1 - FEE) / ep, used, tgt, held: 0, sigI: j, exitNext: false, last: b.close };
        if (b.high >= tgt * (1 + pen)) { const got = q.vol * tgt * (1 - FEE); cash += got; n++; const r = got / used - 1; sumR += r; if (r > 0) wins++; continue; }
        q.held = 1;
        if (q.held >= c.x.H) { const got = q.vol * b.close * (1 - slip(m, i)) * (1 - FEE); cash += got; n++; const r = got / used - 1; sumR += r; if (r > 0) wins++; continue; }
        if (c.x.exitSig && c.x.exitSig(m, i, j)) q.exitNext = true;
        open.push(q);
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    expoSum += 1 - cash / eq; days++;
    daily[i] = eq / prevEq - 1; prevEq = eq;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const eq = prevEq;
  const dr = [...daily].filter(x => !Number.isNaN(x)); const mu = dr.reduce((a, b) => a + b, 0) / dr.length;
  const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mu) ** 2, 0) / dr.length);
  const yrs = dr.length / 365;
  return { ret: 100 * (eq / 1e7 - 1), mdd: 100 * mdd, n, win: n ? 100 * wins / n : 0, avg: n ? 100 * sumR / n : 0, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(365) : 0, cagr: 100 * (Math.pow(eq / 1e7, 1 / Math.max(yrs, 0.01)) - 1), daily, first, last, expo: 100 * expoSum / Math.max(1, days) };
}
export function sizeFor(c: PCfg, target = 17, from?: number, to?: number) {
  let lo = 0.01, hi = 1;
  if (port(c, hi, from, to).mdd <= target) return hi;
  for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (port(c, mid, from, to).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
/** 일수익 배열에서 구간 수익 */
export function periodRet(daily: Float64Array, from: number, to: number) {
  let e = 1; for (let i = 0; i < TS.length; i++) if (TS[i] >= from && TS[i] < to && !Number.isNaN(daily[i])) e *= 1 + daily[i]; return 100 * (e - 1);
}
export const PERIODS: [string, number, number][] = [
  ['2019-21', Date.UTC(2019, 0, 1), Date.UTC(2022, 0, 1)],
  ['2022H1', Date.UTC(2022, 0, 1), Date.UTC(2022, 6, 1)],
  ['2022H2', Date.UTC(2022, 6, 1), Date.UTC(2023, 0, 1)],
  ['2023', Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)],
  ['2024H1', Date.UTC(2024, 0, 1), Date.UTC(2024, 6, 1)],
  ['2024H2', Date.UTC(2024, 6, 1), Date.UTC(2025, 0, 1)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)],
  ['2026YTD', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)],
];
/** 국면별(전일 종가 라벨) 일수익 평균·누적 */
export function regimeStats(daily: Float64Array) {
  const o: Record<string, { n: number; mean: number; cum: number }> = {};
  for (const g of ['a', 'b', 'c']) {
    let n = 0, s = 0, e = 1;
    for (let i = 1; i < TS.length; i++) { if (Number.isNaN(daily[i]) || REGIME[i - 1] !== g) continue; n++; s += daily[i]; e *= 1 + daily[i]; }
    o[g] = { n, mean: n ? 100 * s / n * 100 : 0 /* bp */, cum: 100 * (e - 1) };
  }
  return o;
}
// 함대 보완성
const FLEET: Record<string, [number, number][]> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/final/daily-series.json'), 'utf8'));
export const FLEET_KEYS = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP', 'F7_sl*'];
export function fleetCompare(daily: Float64Array) {
  const mine = new Map<number, number>(); TS.forEach((t, i) => { if (!Number.isNaN(daily[i])) mine.set(t, daily[i]); });
  const corr: Record<string, number> = {};
  const corrf = (a: number[], b: number[]) => { const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0; for (let k = 0; k < n; k++) { c += (a[k] - ma) * (b[k] - mb); va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; } return c / Math.sqrt(va * vb); };
  for (const k of FLEET_KEYS) { const a: number[] = [], b: number[] = []; for (const [t, r] of FLEET[k]) if (mine.has(t)) { a.push(mine.get(t)!); b.push(r); } corr[k] = a.length > 30 ? +corrf(a, b).toFixed(2) : NaN; }
  // 함대 균등합(공통창 2024-11-22~2026-09-30)
  const maps = FLEET_KEYS.map(k => new Map(FLEET[k])); const t0 = Date.UTC(2024, 10, 22), t1 = Date.UTC(2026, 8, 30);
  let nl = 0, sl = 0, nAll = 0, a: number[] = [], b: number[] = [];
  for (let t = t0; t <= t1; t += DAY) {
    if (!maps.every(mp => mp.has(t)) || !mine.has(t)) continue;
    const f = maps.reduce((s, mp) => s + mp.get(t)!, 0) / maps.length; a.push(f); b.push(mine.get(t)!); nAll++;
    if (f < 0) { nl++; sl += mine.get(t)!; }
  }
  return { corr, corrFleet: a.length > 30 ? +corrf(a, b).toFixed(2) : NaN, fleetLossDays: nl, avgOnFleetLoss_bp: nl ? +(1e4 * sl / nl).toFixed(1) : NaN, nCommon: nAll };
}
export const f1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);
export const f0 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0);
/** 전 항목 요약 줄 */
export function summary(name: string, r: PRes) {
  return `${name.padEnd(34)} ret ${f0(r.ret).padStart(6)}% CAGR ${f1(r.cagr).padStart(6)}% MDD ${r.mdd.toFixed(1).padStart(5)}% Sh ${r.sharpe.toFixed(2).padStart(5)} n ${String(r.n).padStart(4)} (${(r.n / ((r.last - r.first + 1) / 365)).toFixed(0)}/y) win ${r.win.toFixed(0)}% avg ${r.avg.toFixed(2)}% expo ${r.expo.toFixed(0)}%`;
}
export function placebo(c: PCfg, size: number, seeds = 30, from?: number, to?: number) {
  // 같은 빈도: 실제 신호 수 / 유니버스 코인-일 수
  let sig = 0, cd = 0;
  for (let j = 60; j < TS.length - 1; j++) {
    if (TS[j] < (from ?? Date.UTC(2019, 0, 1)) || TS[j] > (to ?? Infinity)) continue;
    if (c.btcOk && !c.btcOk(j)) continue;
    const R = c.inclBTC ? RANK[j] : ARANK[j];
    for (const [m, r] of R) { if (r >= c.N || (m === 'KRW-BTC' && !c.inclBTC)) continue; cd++; if (c.sig(m, j) != null) sig++; }
  }
  const p = sig / Math.max(cd, 1); const rs: number[] = [];
  for (let s = 1; s <= seeds; s++) rs.push(port({ ...c, rand: p, seed: s * 7919 }, size, from, to).ret);
  rs.sort((a, b) => a - b);
  return { p, med: rs[Math.floor(rs.length / 2)], max: rs[rs.length - 1], min: rs[0], all: rs };
}

// ── 표준 보고 블록 ──
export const START = Date.UTC(2019, 0, 1), SPLIT = Date.UTC(2023, 0, 1);
export function fullReport(name: string, c: PCfg, opt: { seeds?: number; liqBins?: [number, number][]; from?: number } = {}) {
  const from = opt.from ?? START; const L: string[] = [];
  const sz = sizeFor(c, 17, from); const r = port(c, sz, from); const fx = port(c, 1 / c.K, from);
  L.push(`### ${name}  (eq17 size ${(sz * 100).toFixed(0)}%/slot, K=${c.K}, N=${c.N})`);
  L.push(summary('eq17', r)); L.push(summary(`fixed ${(100 / c.K).toFixed(0)}%×${c.K}`, fx));
  L.push('periods(eq17): ' + PERIODS.map(([p, a, b]) => `${p} ${f1(periodRet(r.daily, a, b))}%`).join(' | '));
  const rg = regimeStats(r.daily); L.push('regime(eq17, prev-close label) ' + Object.entries(rg).map(([g, v]) => `${g}: days ${v.n} mean ${v.mean.toFixed(1)}bp cum ${f1(v.cum)}%`).join(' | '));
  setCost(2); const c2 = port(c, sz, from); setCost(1);
  const d1 = port({ ...c, delay: 1 }, sz, from);
  L.push(`cost×2 ${f0(c2.ret)}% (MDD ${c2.mdd.toFixed(0)}) | delay1d ${f0(d1.ret)}% (MDD ${d1.mdd.toFixed(0)}) | IS(<2023) ${f1(port(c, sz, from, SPLIT).ret)}% OOS(2023~) ${f1(port(c, sz, SPLIT).ret)}%`);
  const pl = placebo(c, sz, opt.seeds ?? 30, from); const beat = pl.all.filter(x => x >= r.ret).length;
  L.push(`placebo(p=${(pl.p * 100).toFixed(2)}%/coin-day, ${pl.all.length} seeds, same size) med ${f0(pl.med)}% max ${f0(pl.max)}% min ${f0(pl.min)}% → ${beat}/${pl.all.length} ≥ strategy`);
  const fc = fleetCompare(r.daily);
  L.push(`fleet corr ${JSON.stringify(fc.corr)} fleetEq corr ${fc.corrFleet} | fleet-loss days ${fc.fleetLossDays}/${fc.nCommon}: mean ${fc.avgOnFleetLoss_bp}bp/day`);
  const ev = events(c.sig, Math.max(c.N, 50), c.x, { from, btcOk: c.btcOk, inclBTC: c.inclBTC });
  const bins = opt.liqBins ?? [[0, 10], [10, 20], [20, 30], [30, 50]];
  L.push(`events(top${Math.max(c.N, 50)}, no slots): ` + JSON.stringify(Object.fromEntries(Object.entries(evStats(ev.filter(e => e.rank < c.N))).map(([k, v]) => [k, +v.toFixed(2)]))));
  L.push('liq-bin  n   exec%  open0slip%  close→% bounce(cc−oo)%p  spread(bp)  t');
  for (const b of liqTable(ev, bins)) L.push(`${b.bin.padEnd(7)} ${String(b.n).padStart(4)} ${b.mean.toFixed(2).padStart(6)} ${b.oo.toFixed(2).padStart(8)} ${b.cc.toFixed(2).padStart(8)} ${b.bounce.toFixed(2).padStart(8)} ${b.spread.toFixed(0).padStart(8)} ${b.t.toFixed(1).padStart(6)}`);
  return { L, r, sz, fx, c2, d1, pl, fc, ev };
}

/** 신호 메모이즈 */
export function memo(f: Sig): Sig {
  const c = new Map<string, Float64Array>();
  return (m, i) => { let a = c.get(m); if (!a) { a = new Float64Array(TS.length).fill(NaN); for (let k = 40; k < TS.length; k++) { const v = f(m, k); if (v != null) a[k] = v; } c.set(m, a); } const v = a[i]; return Number.isNaN(v) ? null : v; };
}
export const btcFilters: Record<string, ((i: number) => boolean) | undefined> = {
  none: undefined,
  a: (i) => REGIME[i] === 'a',
  ab: (i) => REGIME[i] === 'a' || REGIME[i] === 'b',
  c: (i) => REGIME[i] === 'c',
};
export interface Cell { key: string; c: PCfg; params: Record<string, any> }
/** 격자: 고정 1/K 비중으로 전기간·IS·OOS, 이벤트 평균 */
export function runGrid(cells: Cell[]) {
  const rows: any[] = [];
  for (const cell of cells) {
    const sz = 1 / cell.c.K;
    const all = port(cell.c, sz, START), is = port(cell.c, sz, START, SPLIT), oos = port(cell.c, sz, SPLIT);
    rows.push({ key: cell.key, ...cell.params, ret: +all.ret.toFixed(1), mdd: +all.mdd.toFixed(1), sh: +all.sharpe.toFixed(2), n: all.n, avg: +all.avg.toFixed(2), isSh: +is.sharpe.toFixed(2), isRet: +is.ret.toFixed(1), oosSh: +oos.sharpe.toFixed(2), oosRet: +oos.ret.toFixed(1), y22h2: +periodRet(all.daily, PERIODS[2][1], PERIODS[2][2]).toFixed(1), y23: +periodRet(all.daily, PERIODS[3][1], PERIODS[3][2]).toFixed(1), y24: +periodRet(all.daily, PERIODS[4][1], PERIODS[5][2]).toFixed(1), y25: +periodRet(all.daily, PERIODS[6][1], PERIODS[6][2]).toFixed(1), y26: +periodRet(all.daily, PERIODS[7][1], PERIODS[7][2]).toFixed(1) });
  }
  return rows;
}
export function gridText(rows: any[], keys: string[]) {
  const cols = [...keys, 'ret', 'mdd', 'sh', 'n', 'avg', 'isRet', 'oosRet', 'isSh', 'oosSh', 'y22h2', 'y23', 'y24', 'y25', 'y26'];
  return [cols.join('\t'), ...rows.map(r => cols.map(k => r[k]).join('\t'))].join('\n');
}
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
/** 워크포워드: IS 샤프 최고 칸 → OOS. 그리고 전체 격자 OOS 양수 비율/중앙값 */
export function wf(rows: any[]) {
  const best = [...rows].sort((a, b) => b.isSh - a.isSh)[0];
  return { bestKey: best.key, bestIsSh: best.isSh, bestOosRet: best.oosRet, bestOosSh: best.oosSh, oosPosFrac: rows.filter(r => r.oosRet > 0).length / rows.length, oosMed: median(rows.map(r => r.oosRet)), allMed: median(rows.map(r => r.ret)), shMed: median(rows.map(r => r.sh)) };
}
