/**
 * 국면 배분 레이어 (2026-10-13, 축 regime) — 1단계: 구성 전략 일수익 곡선 생성.
 *
 * - BTC_TREND · BTC_ENS · ETH_TREND · ALT_SWING · USDT_Z · BTC_DIP : `_bt_final_compare.ts` 의 엔진을 그대로 이식
 *   (daily-series.json 과 같은 숫자 + 비용×2 판을 같이 만들기 위해). 일 경계 UTC 00:00 = KST 09:00.
 * - F7_sl · F7_btc : `_bt_fleet.ts` 기반 4h 엔진을 라이브 설정에 맞춤 — 33%×3, TP +6% 지정가(고가 ≥ 목표×1.002 일 때만 목표가 체결),
 *   3일(18봉) 시간청산, F7_sl 은 저가가 −2% 닿은 봉의 **종가** 시장가, F7_btc 는 신호봉 BTC 종가 < 4h 300봉 평균이면 신규 진입 안 함.
 *   진입 = 신호 다음 봉 시가 + 코인별 스프레드½(최소 0.05%). 캐시 `*_240m_2022-06-10_2026-10-13.json`, 진행 중인 마지막 봉 제외.
 *   ⚠ 28코인 고정 목록 = 생존편향(이 목록 밖에서 F6/F7 −8~−28% 전례). F7 숫자는 상한으로 읽을 것.
 * 출력: data/research-ext/dip-2026-10/regime/series.json  { base: {id: [[ts,r]...]}, c2: {...}, expoTrend: {...} }
 */
import fs from 'fs';
import path from 'path';
import { run as swingRun, TS as DTS, G, setFee as swingFee, type Cfg } from './_swing_daily';

const DAY = 86400e3, H = 3600e3, Q = 15 * 60e3, FOUR = 4 * H;
const OUT = path.resolve(process.cwd(), 'data/research-ext/dip-2026-10/regime');
fs.mkdirSync(OUT, { recursive: true });
const dayOf = (ts: number) => Math.floor(ts / DAY) * DAY;
type Series = Map<number, number>;
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));

// ── 추세 (final_compare 이식) ──
function trendDaily(market: string, smas: number[], opt: { fee?: number } = {}) {
  const fee = opt.fee ?? 0.0005, slip = Math.max(0.0005, (SPREAD[market] ?? 10) / 2 / 1e4) * (fee / 0.0005);
  const a = G.get(market)!; const daily: Series = new Map(), expo: Series = new Map();
  const maxN = Math.max(...smas);
  const want = (i: number) => {
    if (i < maxN || !a[i]) return 0;
    let up = 0; for (const n of smas) { let s = 0, c = 0; for (let j = i - n + 1; j <= i; j++) if (a[j]) { s += a[j]!.close; c++; } if (c >= n * 0.9 && a[i]!.close > s / c) up++; }
    return up / smas.length;
  };
  let w = 0;
  for (let i = maxN + 2; i < DTS.length; i++) {
    const x = a[i], px = a[i - 1]; if (!x || !px) continue;
    const tgt = want(i - 1); let r = 0;
    if (tgt !== w) { r -= Math.abs(tgt - w) * (fee + slip); r += w * (x.open / px.close - 1) + tgt * (x.close / x.open - 1); w = tgt; }
    else r += w * (x.close / px.close - 1);
    daily.set(DTS[i], r); expo.set(DTS[i], w);
  }
  return { daily, expo };
}
// ── ALT_SWING ──
const SW: Cfg = { sig: 'breakout7', N: 20, K: 3, tp: 6, sl: null, H: 3, btcOn: true };
function swingDaily(size: number): Series {
  const curve: number[] = new Array(DTS.length).fill(NaN); swingRun(SW, size, 0, Infinity, curve);
  const daily: Series = new Map(); let prev = 1e7;
  for (let i = 0; i < DTS.length; i++) { if (Number.isNaN(curve[i]) || curve[i] === undefined) continue; daily.set(DTS[i], curve[i] / prev - 1); prev = curve[i]; }
  return daily;
}
// ── USDT_Z (final_compare 이식) ──
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
function usdtSim(opt: { fee?: number; slip?: number } = {}) {
  const k = 2, ex = 0, FEE = opt.fee ?? 0.0005, SLIP = opt.slip ?? 0.5;
  const z = zSeries(premH, 30); let cash = 1, u = 0; const eqAt: Array<[number, number]> = []; let n = 0;
  for (let i = 0; i < UN - 1; i++) {
    const v = z[i]; const nx = UB[i + 1];
    if (u > 0 && !isNaN(v) && v >= ex) { cash += u * (nx.open - SLIP) * (1 - FEE); u = 0; n++; }
    else if (u === 0 && !isNaN(v) && v <= -k) { u = cash * (1 - FEE) / (nx.open + SLIP); cash = 0; }
    eqAt.push([nx.ts + Q, cash + u * nx.close]);
  }
  return { eqAt, n };
}
// ── BTC_DIP (final_compare 이식, 관통 0.2%) ──
const RAWB: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
const M15 = RAWB.map(r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
function dipSim(opt: { fee?: number; slip?: number } = {}) {
  const x = 3, y = 3, T = 72, reset = 4, pen = 0.002, FEE = opt.fee ?? 0.0005, SLIP = opt.slip ?? 0.0002;
  const T0 = Date.UTC(2021, 3, 1);
  let cash = 1, units = 0, pe = 0, te = 0, order: { lim: number; until: number } | null = null; const eqAt: Array<[number, number]> = []; let n = 0;
  for (let k = 1; k < M15.length; k++) {
    const b = M15[k]; if (b.ts < T0) continue;
    if (units > 0) {
      const tgt = pe * (1 + y / 100);
      if (b.ts >= te + 1 && b.h >= tgt * (1 + pen)) { cash = units * tgt * (1 - FEE); units = 0; n++; }
      else if (b.ts - te >= T * H) { cash = units * b.o * (1 - SLIP) * (1 - FEE); units = 0; n++; }
    } else {
      if (b.ts % (reset * H) === 0) order = { lim: M15[k - 1].c * (1 - x / 100), until: b.ts + reset * H };
      if (order && b.ts < order.until && b.l <= order.lim * (1 - pen)) { pe = order.lim; te = b.ts; units = cash * (1 - FEE) / pe; cash = 0; order = null; }
    }
    eqAt.push([b.ts + Q, cash + units * b.c]);
  }
  return { eqAt, n };
}
function toDaily(eqAt: Array<[number, number]>): Series {
  const last = new Map<number, number>(); for (const [t, e] of eqAt) last.set(dayOf(t - 1), e);
  const days = [...last.keys()].sort((a, b) => a - b); const s: Series = new Map(); let prev = eqAt.length ? eqAt[0][1] : 1;
  for (const d of days) { const e = last.get(d)!; s.set(d, e / prev - 1); prev = e; } return s;
}

// ── F7 (4h, 28코인) ──
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
const RAW4 = new Map<string, Bar[]>();
const NOW = Date.now();
for (const m of COINS) {
  const f = `${m}_240m_2022-06-10_2026-10-13.json`; if (!fs.existsSync(path.join(DIR, f))) continue;
  const b = (JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]).slice().sort((a, c) => a.ts - c.ts);
  const done = b.filter(x => x.ts + FOUR <= NOW); done.pop();            // 진행 중이었을 수 있는 마지막 봉 제외(캐시 시각 불명 → 보수적으로 1봉 더 버림)
  RAW4.set(m, done);
}
const I4 = new Map([...RAW4].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS4 = [...new Set([...RAW4.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const T4END = Math.min(...[...RAW4.values()].map(b => b[b.length - 1].ts));
const volZ = (b: Bar[], i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) => i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
const btc4 = RAW4.get('KRW-BTC')!;
const btcBelow = (barTs: number) => { const i = I4.get('KRW-BTC')!.get(barTs); if (i === undefined || i < 300) return false; let s = 0; for (let j = i - 299; j <= i; j++) s += btc4[j].close; return btc4[i].close < s / 300; };
function f7Sim(o: { sl: number | null; btc50: boolean; fric?: number }) {
  const fric = o.fric ?? 1, FEE = 0.0005 * fric, PEN = 0.002;
  const slipOf = (m: string) => Math.max(0.0005, (SPREAD[m] ?? 10) / 2 / 1e4) * fric;
  let cash = 1e7; const open: Array<{ m: string; ep: number; vol: number; used: number; bars: number; last: number }> = [];
  const eqAt: Array<[number, number]> = []; let n = 0;
  for (const ts of TS4) {
    if (ts > T4END) break;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = I4.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW4.get(q.m)![i]; q.last = bar.close; q.bars++;
      const tgt = q.ep * (1 + 6 / 100); let px = 0;
      if (bar.high >= tgt * (1 + PEN)) px = tgt;                                            // 지정가 TP (슬리피지 0)
      else if (o.sl != null && bar.low <= q.ep * (1 + o.sl / 100)) px = bar.close * (1 - slipOf(q.m));  // 봉 종가 시장가
      else if (q.bars >= 18) px = bar.close * (1 - slipOf(q.m));
      if (px) { cash += q.vol * px * (1 - FEE); n++; open.splice(p, 1); }
    }
    if (open.length < 3) {
      for (const m of COINS) {
        if (open.length >= 3) break;
        const bb = RAW4.get(m); if (!bb) continue; const i = I4.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        if (!sigF6(bb, i - 1)) continue;
        if (o.btc50 && btcBelow(bb[i - 1].ts)) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + slipOf(m)); const used = cash * 0.33; if (used < 5000) continue;
        cash -= used; open.push({ m, ep, vol: used * (1 - FEE) / ep, used, bars: 0, last: bb[i].close });
      }
    }
    eqAt.push([ts + FOUR, cash + open.reduce((a, q) => a + q.vol * q.last, 0)]);
  }
  return { eqAt, n };
}

// ── 생성 ──
const ser = (s: Series) => [...s].sort((a, b) => a[0] - b[0]);
const base: Record<string, Array<[number, number]>> = {}, c2: Record<string, Array<[number, number]>> = {}, expo: Record<string, Array<[number, number]>> = {};
const tr = (id: string, m: string, smas: number[]) => { const b = trendDaily(m, smas), c = trendDaily(m, smas, { fee: 0.001 }); base[id] = ser(b.daily); c2[id] = ser(c.daily); expo[id] = ser(b.expo); };
tr('BTC_TREND', 'KRW-BTC', [50]); tr('BTC_ENS', 'KRW-BTC', [10, 20, 50, 100, 200]); tr('ETH_TREND', 'KRW-ETH', [50]);
base.ALT_SWING = ser(swingDaily(0.33)); swingFee(2); c2.ALT_SWING = ser(swingDaily(0.33)); swingFee(1);
const u = usdtSim(), uc = usdtSim({ fee: 0.001, slip: 1.0 }); base.USDT_Z = ser(toDaily(u.eqAt)); c2.USDT_Z = ser(toDaily(uc.eqAt));
const d = dipSim(), dc = dipSim({ fee: 0.001, slip: 0.0004 }); base.BTC_DIP = ser(toDaily(d.eqAt)); c2.BTC_DIP = ser(toDaily(dc.eqAt));
const stats: Record<string, unknown> = { usdtTrades: u.n, dipTrades: d.n, f7End: new Date(T4END + FOUR).toISOString() };
for (const [id, o] of [['F7_sl', { sl: -2, btc50: false }], ['F7_btc', { sl: null, btc50: true }], ['F7', { sl: null, btc50: false }]] as const) {
  const r = f7Sim(o), rc = f7Sim({ ...o, fric: 2 }); base[id] = ser(toDaily(r.eqAt)); c2[id] = ser(toDaily(rc.eqAt)); stats[id + 'Trades'] = r.n;
  const e = r.eqAt[r.eqAt.length - 1][1]; stats[id + 'Total'] = +(100 * (e / 1e7 - 1)).toFixed(1);
}
fs.writeFileSync(path.join(OUT, 'series.json'), JSON.stringify({ base, c2, expo, stats }));
console.log(JSON.stringify(stats));
for (const k of Object.keys(base)) console.log(k, base[k].length, new Date(base[k][0][0]).toISOString().slice(0, 10), new Date(base[k][base[k].length - 1][0]).toISOString().slice(0, 10));
