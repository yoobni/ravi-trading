/**
 * 생존 후보 통합 재검증 (2026-10-02) — 에이전트 보고 수치를 재현하고, 같은 창·같은 지표로 나란히 비교한다.
 *
 * 후보: BTC_TREND · BTC_ENS · ETH_TREND(·BTC+ETH 반반) · ALT_SWING · USDT_Z · BTC_DIP · (참고) F7_sl · F6
 * 공통 산출: 일별 자산곡선(UTC 00:00 = KST 09:00 일 경계) → 총익·CAGR·MDD·샤프·동일위험(MDD17)·연도별·월간승률·
 *   거래/연·최악거래·비용×2·실행지연. 상관행렬과 조합.
 * 동일위험: 엔진이 사이즈 탐색을 지원하면(ALT_SWING) 그 결과, 아니면 일수익 × f (f ≤ 1, 레버리지 없음).
 * 모드: repro | compare (기본 둘 다)
 */
import fs from 'fs';
import path from 'path';
import { run as swingRun, sizeFor as swingSize, btcTrend, TS as DTS, G, setFee as swingFee, setDelay as swingDelay, type Cfg } from './_swing_daily';

const DAY = 86400e3, H = 3600e3, Q = 15 * 60e3;
const OUT = path.resolve(process.cwd(), 'data/research-ext/final');
fs.mkdirSync(OUT, { recursive: true });
const P = (x: number, d = 0) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
const dayOf = (ts: number) => Math.floor(ts / DAY) * DAY;

type Series = Map<number, number>;           // 일 시작 ts → 그날 수익
interface Strat { id: string; note: string; daily: Series; trades: number[]; yearsSpan: number; exposure?: Series }

// ────────────────────────────────── 일봉 추세 엔진 (BTC_TREND·ENS·ETH) ──────────────────────────────────
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
function trendDaily(market: string, smas: number[], opt: { fee?: number; lagDays?: number } = {}): { daily: Series; trades: number[]; expo: Series } {
  const fee = opt.fee ?? 0.0005, slip = Math.max(0.0005, (SPREAD[market] ?? 10) / 2 / 1e4) * (fee / 0.0005), lag = opt.lagDays ?? 0;
  const a = G.get(market)!; const daily: Series = new Map(), expo: Series = new Map(); const trades: number[] = [];
  const maxN = Math.max(...smas);
  const want = (i: number) => { // i 일 종가까지 정보 → 다음 날 비중
    if (i < maxN || !a[i]) return 0;
    let up = 0; for (const n of smas) { let s = 0, c = 0; for (let j = i - n + 1; j <= i; j++) if (a[j]) { s += a[j]!.close; c++; } if (c >= n * 0.9 && a[i]!.close > s / c) up++; }
    return up / smas.length;
  };
  let w = 0, entry = 0, entryW = 0;
  for (let i = maxN + 2 + lag; i < DTS.length; i++) {
    const x = a[i], px = a[i - 1]; if (!x || !px) continue;
    const tgt = want(i - 1 - lag);
    let r = 0;
    if (tgt !== w) {
      r -= Math.abs(tgt - w) * (fee + slip);
      if (w === 0 && tgt > 0) { entry = x.open; entryW = tgt; }
      if (tgt === 0 && w > 0) trades.push(x.open / entry - 1 - 2 * (fee + slip));
      // 비중 변경은 시가 체결: 시가까지는 옛 비중, 이후 새 비중
      r += w * (x.open / px.close - 1) + tgt * (x.close / x.open - 1);
      w = tgt;
    } else r += w * (x.close / px.close - 1);
    daily.set(DTS[i], r); expo.set(DTS[i], w);
  }
  return { daily, trades, expo };
}

// ────────────────────────────────── ALT_SWING (swing 엔진 곡선) ──────────────────────────────────
const SW: Cfg = { sig: 'breakout7', N: 20, K: 3, tp: 6, sl: null, H: 3, btcOn: true };
function swingDaily(size: number, from = 0): { daily: Series; n: number; avg: number } {
  const curve: number[] = new Array(DTS.length).fill(NaN);
  const r = swingRun(SW, size, from, Infinity, curve);
  const daily: Series = new Map(); let prev = 1e7;
  for (let i = 0; i < DTS.length; i++) { if (Number.isNaN(curve[i]) || curve[i] === undefined) continue; daily.set(DTS[i], curve[i] / prev - 1); prev = curve[i]; }
  return { daily, n: r.n, avg: r.avg };
}

// ────────────────────────────────── USDT_Z (_usdt2.ts 이식) ──────────────────────────────────
const RAWU: { ts: number; open: number; high: number; low: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDT_15m.json', 'utf8'));
const UB = RAWU.filter(b => b.ts >= Date.UTC(2024, 6, 1)); const UN = UB.length;
const FXR: Record<string, number> = JSON.parse(fs.readFileSync('data/research-ext/fx-usdkrw.json', 'utf8')); const FXD = Object.keys(FXR).sort();
function fxEcb(ts: number) { const lim = new Date(ts - 16 * H).toISOString().slice(0, 10); let lo = 0, hi = FXD.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (FXD[m] <= lim) { a = m; lo = m + 1; } else hi = m - 1; } return FXR[FXD[a]]; }
const YY = JSON.parse(fs.readFileSync('data/research-ext/usdt2/yahoo-krw-1h.json', 'utf8')).chart.result[0];
const YT: number[] = [], YC: number[] = [];
YY.timestamp.forEach((t: number, i: number) => { const c = YY.indicators.quote[0].close[i]; if (c != null && c > 900 && c < 2000) { YT.push(t * 1e3 + H); YC.push(c); } });
function fxHour(ts: number) { let lo = 0, hi = YT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (YT[m] <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? fxEcb(ts) : YC[a]; }
const premH = UB.map(b => b.close / fxHour(b.ts + Q) - 1);
function zSeries(prem: number[], days: number) { const W = days * 96; const z = new Float64Array(prem.length); let s = 0, s2 = 0;
  for (let i = 0; i < prem.length; i++) { s += prem[i]; s2 += prem[i] ** 2; if (i >= W) { s -= prem[i - W]; s2 -= prem[i - W] ** 2; } const w = Math.min(i + 1, W); const mu = s / w, sd = Math.sqrt(Math.max(s2 / w - mu * mu, 1e-10)); z[i] = i < W ? NaN : (prem[i] - mu) / sd; } return z; }
function usdtSim(opt: { k?: number; ex?: number; fee?: number; slip?: number; lag?: number } = {}) {
  const k = opt.k ?? 2, ex = opt.ex ?? 0, FEE = opt.fee ?? 0.0005, SLIP = opt.slip ?? 0.5, lag = opt.lag ?? 0;
  const z = zSeries(premH, 30); let cash = 1, u = 0, cost = 0; const trades: number[] = []; const eqAt: Array<[number, number]> = [];
  for (let i = 0; i < UN - 1; i++) {
    const j = i - lag; const v = j >= 0 ? z[j] : NaN; const nx = UB[i + 1];
    if (u > 0 && !isNaN(v) && v >= ex) { const got = u * (nx.open - SLIP) * (1 - FEE); trades.push(got / cost - 1); cash += got; u = 0; cost = 0; }
    else if (u === 0 && !isNaN(v) && v <= -k) { cost = cash; u = cash * (1 - FEE) / (nx.open + SLIP); cash = 0; }
    eqAt.push([nx.ts + Q, cash + u * nx.close]);
  }
  return { eqAt, trades, total: cash + u * UB[UN - 1].close - 1 };
}

// ────────────────────────────────── BTC_DIP (_btc_k.ts gridTrades 이식, 단일 포지션 전액) ──────────────────────────────────
const RAWB: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
const M15 = RAWB.map(r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
function dipSim(opt: { x?: number; y?: number; T?: number; reset?: number; pen?: number; fee?: number; slip?: number; tpDelay?: number } = {}) {
  const x = opt.x ?? 3, y = opt.y ?? 3, T = opt.T ?? 72, reset = opt.reset ?? 4, pen = opt.pen ?? 0.0005, FEE = opt.fee ?? 0.0005, SLIP = opt.slip ?? 0.0002;
  const T0 = Date.UTC(2021, 3, 1);
  let cash = 1, units = 0, pe = 0, te = 0, order: { lim: number; until: number } | null = null; const trades: number[] = []; const eqAt: Array<[number, number]> = [];
  for (let k = 1; k < M15.length; k++) {
    const b = M15[k]; if (b.ts < T0) continue;
    if (units > 0) {
      const tgt = pe * (1 + y / 100);
      const tpOn = opt.tpDelay ? Math.floor(te / (opt.tpDelay * H)) * (opt.tpDelay * H) + opt.tpDelay * H : te + 1;
      if (b.ts >= tpOn && b.h >= tgt * (1 + pen)) { const got = units * tgt * (1 - FEE); trades.push(got / (units * pe / (1 - FEE)) - 1); cash = got; units = 0; }
      else if (b.ts - te >= T * H) { const got = units * b.o * (1 - SLIP) * (1 - FEE); trades.push(got / (units * pe / (1 - FEE)) - 1); cash = got; units = 0; }
    } else {
      if (b.ts % (reset * H) === 0) order = { lim: M15[k - 1].c * (1 - x / 100), until: b.ts + reset * H };
      if (order && b.ts < order.until && b.l <= order.lim * (1 - pen)) { pe = order.lim; te = b.ts; units = cash * (1 - FEE) / pe; cash = 0; order = null; }
    }
    eqAt.push([b.ts + Q, cash + units * b.c]);
  }
  return { eqAt, trades };
}
/** 장중 자산 샘플 → 일 수익(UTC 일 경계에서 마지막 값) */
function toDaily(eqAt: Array<[number, number]>): Series {
  const last = new Map<number, number>(); for (const [t, e] of eqAt) last.set(dayOf(t - 1), e);
  const days = [...last.keys()].sort((a, b) => a - b); const s: Series = new Map(); let prev = eqAt.length ? eqAt[0][1] : 1;
  for (const d of days) { const e = last.get(d)!; s.set(d, e / prev - 1); prev = e; } return s;
}

// ────────────────────────────────── F7_sl · F6 (배분 포크 일수익: B=보수 15m, A=현실 15m) ──────────────────────────────────
const ALLOC = JSON.parse(fs.readFileSync('data/research-ext/alloc/series.json', 'utf8')) as Array<{ label: string; ser: Record<string, [number, number][]> }>;
const allocSer = (lab: string, id: string): Series => { const x = ALLOC.find(a => a.label.startsWith(lab))!; return new Map(x.ser[id].map(([t, r]) => [dayOf(t), r])); };

// ────────────────────────────────── 공통 지표 ──────────────────────────────────
function window(s: Series, a: number, b: number) { return [...s].filter(([t]) => t >= a && t < b).sort((x, y) => x[0] - y[0]); }
function metrics(rs: Array<[number, number]>, f = 1) {
  let e = 1, pk = 1, mdd = 0; const ys: Record<number, number> = {}; const ms: Record<string, number> = {};
  let s = 0, s2 = 0;
  for (const [t, r0] of rs) { const r = f * r0; e *= 1 + r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); s += r; s2 += r * r;
    const y = new Date(t).getUTCFullYear(); ys[y] = (ys[y] ?? 1) * (1 + r); const m = new Date(t).toISOString().slice(0, 7); ms[m] = (ms[m] ?? 1) * (1 + r); }
  const n = rs.length, yrs = n / 365, mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-12));
  const mvals = Object.values(ms);
  return { tot: 100 * (e - 1), cagr: 100 * (Math.pow(e, 1 / Math.max(yrs, 1e-9)) - 1), mdd: 100 * mdd, sharpe: (mu / sd) * Math.sqrt(365),
    years: Object.fromEntries(Object.entries(ys).map(([y, v]) => [y, 100 * (v - 1)])), mwin: 100 * mvals.filter(v => v > 1).length / Math.max(mvals.length, 1) };
}
function eq17(rs: Array<[number, number]>, fmax = 1) { const m = metrics(rs, fmax); if (m.mdd <= 17) return { f: fmax, ...m }; let lo = 0, hi = fmax; for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (metrics(rs, mid).mdd > 17) hi = mid; else lo = mid; } return { f: lo, ...metrics(rs, lo) }; }
const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };

const MODE = process.argv[2] || 'all';
const Y = (y: number, m = 0, d = 1) => Date.UTC(y, m, d);

// ══════════════════════ 1. 재현 ══════════════════════
if (MODE === 'all' || MODE === 'repro') {
  console.log('══ 1. 보고 수치 재현 ══');
  // BTC_TREND (swing 엔진 btcTrend, 2019~ eq17) 보고 266%
  { let lo = 0.02, hi = 0.99; for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (btcTrend(m, Y(2019)).mdd > 17) hi = m; else lo = m; } console.log(`BTC_TREND (swing 엔진, 2019~ eq17)  재현 ${P(btcTrend((lo + hi) / 2, Y(2019)).ret)}  | 보고 +266%`); }
  // 2018~ 일수익 엔진
  const bt = trendDaily('KRW-BTC', [50]); const en = trendDaily('KRW-BTC', [10, 20, 50, 100, 200]); const et = trendDaily('KRW-ETH', [50]);
  const w18 = (s: Series) => window(s, Y(2018, 2, 1), Y(2026, 9, 2));
  console.log(`BTC_TREND (일수익 엔진, 2018-03~ eq17) 재현 ${P(eq17(w18(bt.daily)).tot)} | 보고 +207~238% (창 차이)`);
  console.log(`BTC_ENS   (2018-03~ eq17)              재현 ${P(eq17(w18(en.daily)).tot)} | 보고 +270%`);
  const half: Series = new Map([...bt.daily].filter(([t]) => et.daily.has(t)).map(([t, r]) => [t, 0.5 * r + 0.5 * et.daily.get(t)!]));
  console.log(`ETH_TREND (2018-03~ eq17)              재현 ${P(eq17(w18(et.daily)).tot)} | 보고 +336%`);
  console.log(`BTC+ETH 반반 (2018-03~ eq17)           재현 ${P(eq17(w18(half)).tot)} | 보고 +322%`);
  // ENS 1일 지연 (보고: 227% vs SMA50 93%)
  console.log(`  1일 지연: BTC_TREND ${P(eq17(w18(trendDaily('KRW-BTC', [50], { lagDays: 1 }).daily)).tot)} | ENS ${P(eq17(w18(trendDaily('KRW-BTC', [10, 20, 50, 100, 200], { lagDays: 1 }).daily)).tot)}   (보고 93% / 227%)`);
  // ALT_SWING (2019~ eq17) 보고 444%
  { const sz = swingSize(SW, Y(2019)); const r = swingRun(SW, sz, Y(2019)); console.log(`ALT_SWING (2019~ eq17)                 재현 ${P(r.ret)} (size ${(sz * 100).toFixed(0)}%, n ${r.n}, 거래당 ${r.avg.toFixed(2)}%) | 보고 +444%`); }
  // USDT_Z (2024-07~) 보고 +48.6% MDD 3.2% 28건
  { const u = usdtSim(); let pk = 1, mdd = 0; for (const [, e] of u.eqAt) { pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); }
    console.log(`USDT_Z    (2024-07~, 전액)              재현 ${P(100 * u.total, 1)} MDD ${(100 * mdd).toFixed(1)}% 거래 ${u.trades.length} 승률 ${(100 * u.trades.filter(r => r > 0).length / u.trades.length).toFixed(0)}% | 보고 +48.6% MDD 3.2% 28건 89%`); }
  // BTC_DIP (2021-04~) 보고 eq17 +155% (pen0.05), +92% (pen0.2)
  for (const pen of [0.0005, 0.002]) { const d = dipSim({ pen }); const s = window(toDaily(d.eqAt), 0, Infinity); const e = eq17(s);
    console.log(`BTC_DIP   (2021-04~, 관통 ${pen * 100}%)       재현 eq17 ${P(e.tot)} (f ${e.f.toFixed(2)}) 전액 ${P(metrics(s).tot)} MDD ${metrics(s).mdd.toFixed(0)}% 거래 ${d.trades.length} | 보고 eq17 ${pen === 0.0005 ? '+155%' : '+92%'}`); }
}

// ══════════════════════ 2. 공통 창 비교 ══════════════════════
if (MODE === 'all' || MODE === 'compare') {
  const A0 = Y(2024, 10, 22), A1 = Y(2026, 9, 1);   // F 일수익(배분 포크) 시작이 2024-11-22 → 모든 후보 공통
  const L0 = Y(2019), L1 = Y(2026, 9, 1);
  const bt = trendDaily('KRW-BTC', [50]), en = trendDaily('KRW-BTC', [10, 20, 50, 100, 200]), et = trendDaily('KRW-ETH', [50]);
  const half: Series = new Map([...bt.daily].filter(([t]) => et.daily.has(t)).map(([t, r]) => [t, 0.5 * r + 0.5 * et.daily.get(t)!]));
  const swSz = 0.33; const sw = swingDaily(swSz);
  const us = usdtSim(); const usD = toDaily(us.eqAt);
  const dp = dipSim({ pen: 0.002 }); const dpD = toDaily(dp.eqAt);   // 보수 관통 0.2% 를 기본으로
  const f7B = allocSer('B ', 'F7_sl'), f6B = allocSer('B ', 'F6'), f7A = allocSer('A ', 'F7_sl');
  // 스트레스 버전
  const btC2 = trendDaily('KRW-BTC', [50], { fee: 0.001 }), btL = trendDaily('KRW-BTC', [50], { lagDays: 1 });
  const enC2 = trendDaily('KRW-BTC', [10, 20, 50, 100, 200], { fee: 0.001 }), enL = trendDaily('KRW-BTC', [10, 20, 50, 100, 200], { lagDays: 1 });
  const etC2 = trendDaily('KRW-ETH', [50], { fee: 0.001 }), etL = trendDaily('KRW-ETH', [50], { lagDays: 1 });
  swingFee(2); const swC2 = swingDaily(swSz); swingFee(1); swingDelay(0.0035); const swL = swingDaily(swSz); swingDelay(0);
  const usC2 = toDaily(usdtSim({ fee: 0.001 }).eqAt), usL = toDaily(usdtSim({ lag: 4 }).eqAt);
  const dpC2 = toDaily(dipSim({ pen: 0.002, fee: 0.001, slip: 0.0004 }).eqAt), dpL = toDaily(dipSim({ pen: 0.002, tpDelay: 4 }).eqAt);

  const S: Array<{ id: string; d: Series; c2?: Series; lag?: Series; lagLab: string; trades: number[]; tradesPerYr: number; warn?: string }> = [];
  const tpy = (n: number, a: number, b: number) => n / ((b - a) / (365 * DAY));
  const cntIn = (tr: number[]) => tr.length;
  S.push({ id: 'BTC_TREND', d: bt.daily, c2: btC2.daily, lag: btL.daily, lagLab: '1일', trades: bt.trades, tradesPerYr: tpy(bt.trades.length, Y(2018, 2), L1) });
  S.push({ id: 'BTC_ENS', d: en.daily, c2: enC2.daily, lag: enL.daily, lagLab: '1일', trades: en.trades, tradesPerYr: NaN });
  S.push({ id: 'ETH_TREND', d: et.daily, c2: etC2.daily, lag: etL.daily, lagLab: '1일', trades: et.trades, tradesPerYr: tpy(et.trades.length, Y(2018, 2), L1) });
  S.push({ id: 'BTC+ETH반반', d: half, lagLab: '-', trades: [], tradesPerYr: NaN });
  S.push({ id: 'ALT_SWING', d: sw.daily, c2: swC2.daily, lag: swL.daily, lagLab: '1h(+0.35%)', trades: [], tradesPerYr: tpy(swingRun(SW, swSz, L0).n, L0, L1), warn: '상폐코인 누락(상한)' });
  S.push({ id: 'USDT_Z', d: usD, c2: usC2, lag: usL, lagLab: '1h', trades: us.trades, tradesPerYr: tpy(us.trades.length, Y(2024, 6), Y(2026, 9, 2)) });
  S.push({ id: 'BTC_DIP', d: dpD, c2: dpC2, lag: dpL, lagLab: 'TP 4h', trades: dp.trades, tradesPerYr: tpy(dp.trades.length, Y(2021, 3), Y(2026, 9, 2)) });
  S.push({ id: 'F7_sl*', d: f7B, lagLab: '-', trades: [], tradesPerYr: NaN, warn: '28코인 생존편향' });
  S.push({ id: 'F6*', d: f6B, lagLab: '-', trades: [], tradesPerYr: NaN, warn: '28코인 생존편향' });
  // ENS 거래 수: 비중 변화 횟수
  { let n = 0, prev = -1; for (const [t, w] of [...en.expo].filter(([t]) => t >= Y(2018, 2))) { if (prev >= 0 && w !== prev) n++; prev = w; } S[1].tradesPerYr = n / ((L1 - Y(2018, 2)) / (365 * DAY)); }

  const row = (id: string, rs: Array<[number, number]>, extra = '') => { const m = metrics(rs), e = eq17(rs);
    return `${id.padEnd(12)}${P(m.tot).padStart(7)}${P(m.cagr).padStart(6)}${(m.mdd.toFixed(0) + '%').padStart(5)}${m.sharpe.toFixed(2).padStart(6)}${P(e.tot).padStart(7)}(f${e.f.toFixed(2)})${(m.mwin.toFixed(0) + '%').padStart(5)}  ${extra}`; };
  const yrsCols = (rs: Array<[number, number]>, ys: number[]) => { const m = metrics(rs); return ys.map(y => (m.years[y] != null ? P(m.years[y]) : '-').padStart(6)).join(''); };

  console.log(`\n══ 2a. 공통 창 ${new Date(A0).toISOString().slice(0, 10)} ~ ${new Date(A1 - DAY).toISOString().slice(0, 10)} (각 전략 '기본 사이징' = 전액 / ALT_SWING 33%×3) ══`);
  console.log('전략'.padEnd(12) + '  총익  CAGR  MDD 샤프  MDD17(f)  월승률 | 비용×2  지연          | 2024  2025  2026');
  for (const s of S) {
    const rs = window(s.d, A0, A1);
    const c2 = s.c2 ? P(metrics(window(s.c2, A0, A1)).tot) : '-';
    const lg = s.lag ? `${P(metrics(window(s.lag, A0, A1)).tot)}(${s.lagLab})` : '-';
    console.log(row(s.id, rs, `| ${c2.padStart(6)}  ${lg.padEnd(14)}|${yrsCols(rs, [2024, 2025, 2026])}${s.warn ? '  ⚠ ' + s.warn : ''}`));
  }
  console.log(`\n══ 2b. 장기 창 2019-01-01 ~ ${new Date(L1 - DAY).toISOString().slice(0, 10)} (데이터 있는 후보만, BTC_DIP 은 2021-04~) ══`);
  console.log('전략'.padEnd(12) + '  총익  CAGR  MDD 샤프  MDD17(f)  월승률 | 비용×2  지연          | 2019  2020  2021  2022  2023  2024  2025  2026');
  for (const s of S.filter(s => ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'BTC+ETH반반', 'ALT_SWING', 'BTC_DIP'].includes(s.id))) {
    const rs = window(s.d, L0, L1);
    const c2 = s.c2 ? P(metrics(window(s.c2, L0, L1)).tot) : '-';
    const lg = s.lag ? `${P(metrics(window(s.lag, L0, L1)).tot)}(${s.lagLab})` : '-';
    console.log(row(s.id, rs, `| ${c2.padStart(7)} ${lg.padEnd(15)}|${yrsCols(rs, [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])}`));
  }
  // ALT_SWING 동일위험은 엔진 사이즈 탐색으로 (일수익 스케일은 레버리지 불가)
  { const sz = swingSize(SW, L0); const r = swingRun(SW, sz, L0); const szA = swingSize(SW, A0); const rA = swingRun(SW, szA, A0, A1);
    console.log(`  ALT_SWING 엔진 동일위험: 2019~ ${P(r.ret)} (size ${(sz * 100).toFixed(0)}%) · 공통창 ${P(rA.ret)} (size ${(szA * 100).toFixed(0)}%)`); }
  // BTC 보유 참고
  { const a = G.get('KRW-BTC')!; const hold: Series = new Map(); for (let i = 1; i < DTS.length; i++) if (a[i] && a[i - 1]) hold.set(DTS[i], a[i]!.close / a[i - 1]!.close - 1);
    console.log(row('(BTC 보유)', window(hold, A0, A1), '| 공통창') + '\n' + row('(BTC 보유)', window(hold, L0, L1), '| 2019~')); }

  // 거래 통계 + 페이퍼 판정 가능성
  console.log('\n══ 3. 거래 빈도 · 최악 거래 · 페이퍼 예상 거래 수 ══');
  console.log('전략'.padEnd(12) + ' 거래/연  최악거래   3주 예상  3개월 예상');
  for (const s of S.filter(s => !Number.isNaN(s.tradesPerYr))) {
    const worst = s.trades.length ? P(100 * Math.min(...s.trades), 1) : '-';
    console.log(`${s.id.padEnd(12)}${s.tradesPerYr.toFixed(0).padStart(7)}  ${worst.padStart(8)}  ${(s.tradesPerYr * 21 / 365).toFixed(1).padStart(8)}  ${(s.tradesPerYr * 91 / 365).toFixed(1).padStart(9)}`);
  }
  // ALT_SWING 최악 거래는 엔진 내부라 별도 산출 생략 → 일수익 최악일로 대체
  { const rs = window(sw.daily, L0, L1).map(x => x[1]); console.log(`  (ALT_SWING 최악 일수익(33%×3 기준) ${P(100 * Math.min(...rs), 1)})`); }

  // 상관 + 조합 (공통창)
  console.log('\n══ 4. 공통창 일수익 상관 ══');
  const ids = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP', 'F7_sl*'];
  const days = [...window(bt.daily, A0, A1)].map(x => x[0]).filter(t => ids.every(id => S.find(s => s.id === id)!.d.has(t)));
  const vec = (id: string) => days.map(t => S.find(s => s.id === id)!.d.get(t)!);
  console.log(''.padEnd(11) + ids.map(i => i.slice(0, 9).padStart(10)).join(''));
  for (const a of ids) console.log(a.padEnd(11) + ids.map(b => corr(vec(a), vec(b)).toFixed(2).padStart(10)).join(''));
  console.log(`(공통 일수 ${days.length})`);

  console.log('\n══ 5. 조합 (공통창, 일수익 가중합 → 동일위험) ══');
  const expoBT = bt.expo;
  const combo = (lab: string, fn: (t: number) => number) => { const rs: Array<[number, number]> = days.map(t => [t, fn(t)]); const m = metrics(rs), e = eq17(rs);
    console.log(`${lab.padEnd(40)} 총익 ${P(m.tot).padStart(6)} MDD ${m.mdd.toFixed(0).padStart(3)}% 샤프 ${m.sharpe.toFixed(2)} | MDD17 ${P(e.tot)} (f${e.f.toFixed(2)}) | ${[2024, 2025, 2026].map(y => `${y} ${m.years[y] != null ? P(m.years[y]) : '-'}`).join(' ')}`); };
  const d = (id: string) => (t: number) => S.find(s => s.id === id)!.d.get(t)!;
  combo('BTC_TREND 단독', d('BTC_TREND'));
  combo('ALT_SWING 단독 (33%×3)', d('ALT_SWING'));
  combo('USDT_Z 단독', d('USDT_Z'));
  combo('BTC_TREND 50 + ALT_SWING 50', t => 0.5 * d('BTC_TREND')(t) + 0.5 * d('ALT_SWING')(t));
  combo('BTC_TREND (현금일 때 USDT_Z)', t => d('BTC_TREND')(t) + ((expoBT.get(t) ?? 0) === 0 ? d('USDT_Z')(t) : 0));
  combo('BTC_TREND 50 + ALT_SWING 50 + 현금→USDT_Z', t => 0.5 * d('BTC_TREND')(t) + 0.5 * d('ALT_SWING')(t) + ((expoBT.get(t) ?? 0) === 0 ? 0.5 * d('USDT_Z')(t) : 0));
  combo('균등 (TREND·SWING·USDT·DIP 각 25)', t => 0.25 * (d('BTC_TREND')(t) + d('ALT_SWING')(t) + d('USDT_Z')(t) + d('BTC_DIP')(t)));
  combo('BTC_TREND 70 + F7_sl 30 (배분 포크 권고형)*', t => 0.7 * d('BTC_TREND')(t) + 0.3 * d('F7_sl*')(t));

  // 저장
  const dump: Record<string, Array<[number, number]>> = {}; for (const s of S) dump[s.id] = [...s.d].sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(OUT, 'daily-series.json'), JSON.stringify(dump));
  console.log(`\n저장: ${path.join(OUT, 'daily-series.json')}`);
}
