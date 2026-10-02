/**
 * 축 O — 테더 프리미엄 심화 (2026-10-02). 기준선 = _usdt_an.ts 'z N30·k1.5 매수 / z≥0 매도'.
 * 손익은 업비트 KRW-USDT 가격만. 수수료 0.05%/편도, 시장가 = 다음 15m 시가 ± 반틱, 지정가 = 1틱 관통 요구.
 * 모드: fx (장중 환율 정밀화) · cause (저프리미엄 원인 분해) · rules (개선 규칙) · rob (최종 후보 반증) · final
 */
import fs from 'fs';
const H = 3600e3, DAY = 24 * H;
const P = (x: number, d = 2) => (x >= 0 ? '+' : '') + (100 * x).toFixed(d) + '%';
const MODE = process.argv[2] || 'fx';

// ── 데이터
const RAW: { ts: number; open: number; high: number; low: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDT_15m.json', 'utf8'));
const START = Date.UTC(2024, 6, 1);
const bars = RAW.filter(b => b.ts >= START);
const N = bars.length;
// ECB 일별 (공표 16 UTC 이후 사용)
const FXR: Record<string, number> = JSON.parse(fs.readFileSync('data/research-ext/fx-usdkrw.json', 'utf8'));
const FXD = Object.keys(FXR).sort();
function fxEcb(ts: number) { const lim = new Date(ts - 16 * H).toISOString().slice(0, 10); let lo = 0, hi = FXD.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (FXD[m] <= lim) { a = m; lo = m + 1; } else hi = m - 1; } return FXR[FXD[a]]; }
// Yahoo KRW=X 1h — 봉 시작 ts, 그 봉 종가는 ts+1h 이후에만 사용 (미래참조 방지). 주말은 직전 값 유지.
const Y = JSON.parse(fs.readFileSync('data/research-ext/usdt2/yahoo-krw-1h.json', 'utf8')).chart.result[0];
const YT: number[] = [], YC: number[] = [];
Y.timestamp.forEach((t: number, i: number) => { const c = Y.indicators.quote[0].close[i]; if (c != null && c > 900 && c < 2000) { YT.push(t * 1e3 + H); YC.push(c); } });
function fxHour(ts: number) { let lo = 0, hi = YT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (YT[m] <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? fxEcb(ts) : YC[a]; }
const fxE = bars.map(b => fxEcb(b.ts + 15 * 60e3));   // 15m 봉 종가 시점 기준
const fxH = bars.map(b => fxHour(b.ts + 15 * 60e3));
const premE = bars.map((b, i) => b.close / fxE[i] - 1);
const premH = bars.map((b, i) => b.close / fxH[i] - 1);

// BTC (업비트 15m, [ts,o,h,l,c,v]) — 원인 분해·K축 겹침용
const BT: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
const bIdx = new Map(BT.map((r, i) => [r[0], i]));
const btcAt = (ts: number) => { const i = bIdx.get(Math.floor(ts / (15 * 60e3)) * 15 * 60e3); return i === undefined ? null : BT[i][4]; };
// 바이낸스 BTCUSDT 4h → 김프(BTC 기준) = 업비트 BTC / (바이낸스 BTCUSDT × 환율) − 1
const BN: { ts: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/binance-BTC_240m.json', 'utf8'));
const bnMap = new Map(BN.map(r => [r.ts, r.close]));
const kimpAt = (ts: number) => { const k = Math.floor(ts / (4 * H)) * 4 * H - 4 * H; const bn = bnMap.get(k); const ub = btcAt(k + 4 * H - 15 * 60e3); return bn && ub ? ub / (bn * fxHour(k + 4 * H)) - 1 : null; };

// ── 시뮬 공통
let FEE = 0.0005, SLIP = 0.5;
type Sig = (i: number) => { buy: number; sell: boolean };   // buy = 목표 비중(0~1), sell = 전량 청산
interface Tr { i: number; j: number; r: number; w: number }
function zSeries(prem: number[], days: number) {
  const W = days * 96; const z = new Float64Array(N); let s = 0, s2 = 0;
  for (let i = 0; i < N; i++) { s += prem[i]; s2 += prem[i] ** 2; if (i >= W) { s -= prem[i - W]; s2 -= prem[i - W] ** 2; }
    const w = Math.min(i + 1, W); const mu = s / w, sd = Math.sqrt(Math.max(s2 / w - mu * mu, 1e-10)); z[i] = i < W ? NaN : (prem[i] - mu) / sd; }
  return z;
}
function muSd(prem: number[], days: number) {
  const W = days * 96; const mu = new Float64Array(N), sd = new Float64Array(N); let s = 0, s2 = 0;
  for (let i = 0; i < N; i++) { s += prem[i]; s2 += prem[i] ** 2; if (i >= W) { s -= prem[i - W]; s2 -= prem[i - W] ** 2; }
    const w = Math.min(i + 1, W); mu[i] = s / w; sd[i] = Math.sqrt(Math.max(s2 / w - (s / w) ** 2, 1e-10)); }
  return { mu, sd, W };
}
/** 시장가 시뮬 — 비중 단계 진입(분할) 지원. 신호 i 에서 판단, i+1 시가 체결. */
function sim(sig: Sig, from = 0, to = N - 1, maxHoldBars = Infinity) {
  let cash = 1, u = 0, peak = 1, mdd = 0, inBars = 0, w = 0, ei = -1, cost = 0; const trades: Tr[] = [];
  for (let i = from; i < to; i++) {
    const s = sig(i); const nx = bars[i + 1];
    const eq0 = cash + u * bars[i].close;
    const timeout = u > 0 && i + 1 - ei >= maxHoldBars;
    if (u > 0 && (s.sell || timeout)) { const px = nx.open - SLIP; const got = u * px * (1 - FEE); trades.push({ i: ei, j: i + 1, r: got / cost - 1, w }); cash += got; u = 0; w = 0; cost = 0; }
    else if (s.buy > w + 1e-9) { // 비중 증액
      const target = s.buy; const add = Math.min(cash, eq0 * (target - w)); if (add > 1e-9) { const px = nx.open + SLIP; u += add * (1 - FEE) / px; cash -= add; cost += add; if (w === 0) ei = i + 1; w = target; } }
    if (u > 0) inBars++;
    const eq = cash + u * nx.close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  }
  const eq = cash + u * bars[to].close;
  return { ret: eq - 1, mdd, n: trades.length, expo: inBars / Math.max(to - from, 1), trades };
}
const yrs = (a: number, b: number) => (bars[b].ts - bars[a].ts) / (365 * DAY);
const MID = bars.findIndex(b => b.ts >= Date.UTC(2025, 7, 15));
const yIdx = (y: number) => [Math.max(0, bars.findIndex(b => b.ts >= Date.UTC(y, 0, 1))), (() => { const k = bars.findIndex(b => b.ts >= Date.UTC(y + 1, 0, 1)); return k < 0 ? N - 1 : k - 1; })()] as [number, number];
const qIdx = () => { const out: Array<[string, number, number]> = []; for (let y = 2024; y <= 2026; y++) for (let q = 0; q < 4; q++) { const a = bars.findIndex(b => b.ts >= Date.UTC(y, q * 3, 1)); let b = bars.findIndex(b => b.ts >= Date.UTC(y, q * 3 + 3, 1)); if (a < 0) continue; if (b < 0) b = N; if (b - 1 <= a) continue; out.push([`${y}Q${q + 1}`, a, b - 1]); } return out; };
const fmt = (r: ReturnType<typeof sim>, a = 0, b = N - 1) => `${P(r.ret).padStart(8)} 연${P(Math.pow(1 + r.ret, 1 / yrs(a, b)) - 1, 1).padStart(7)} MDD ${P(r.mdd, 1).padStart(6)} 거래${String(r.n).padStart(4)} 노출${(100 * r.expo).toFixed(0).padStart(3)}%`;
const zSig = (z: Float64Array, k: number, ex: number, lag = 0): Sig => i => { const j = i - lag; const v = j >= 0 ? z[j] : NaN; return { buy: !isNaN(v) && v <= -k ? 1 : 0, sell: !isNaN(v) && v >= ex }; };
const comp = (xs: number[]) => xs.reduce((a, r) => a * (1 + r), 1) - 1;

// ═════ 1. 장중 환율 정밀화
if (MODE === 'fx') {
  const d = premE.map((p, i) => p - premH[i]).sort((a, b) => a - b); const q = (f: number) => d[Math.floor(f * (d.length - 1))];
  console.log(`기간 ${new Date(bars[0].ts).toISOString().slice(0, 10)} ~ ${new Date(bars[N - 1].ts).toISOString().slice(0, 10)} · 15m ${N}봉 · Yahoo 1h ${YT.length}점`);
  console.log(`프리미엄 측정차(ECB − 장중): p1 ${P(q(.01))} p10 ${P(q(.1))} p50 ${P(q(.5))} p90 ${P(q(.9))} p99 ${P(q(.99))} · |차|>0.5%p 비율 ${(100 * d.filter(x => Math.abs(x) > .005).length / d.length).toFixed(1)}%`);
  // 상관
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length; const mE = mean(premE), mH = mean(premH);
  let c = 0, vE = 0, vH = 0; for (let i = 0; i < N; i++) { c += (premE[i] - mE) * (premH[i] - mH); vE += (premE[i] - mE) ** 2; vH += (premH[i] - mH) ** 2; }
  console.log(`레벨 상관 ${(c / Math.sqrt(vE * vH)).toFixed(3)} · 평균 ECB ${P(mE)} 장중 ${P(mH)}`);
  console.log('\n격자: N일 × k (exit z≥0) — 전체 / 전반 / 후반   [ECB]  vs  [장중]');
  const rows: Array<[number, number, number, number]> = [];
  for (const Nd of [14, 20, 30, 45, 60]) {
    const zE = zSeries(premE, Nd), zH = zSeries(premH, Nd);
    for (const k of [1, 1.25, 1.5, 2]) {
      const a = sim(zSig(zE, k, 0)), aB = sim(zSig(zE, k, 0), 0, MID), aC = sim(zSig(zE, k, 0), MID);
      const h = sim(zSig(zH, k, 0)), hB = sim(zSig(zH, k, 0), 0, MID), hC = sim(zSig(zH, k, 0), MID);
      rows.push([a.ret, h.ret, aC.ret, hC.ret]);
      console.log(`  N${String(Nd).padStart(2)} k${String(k).padEnd(4)} ECB ${P(a.ret, 1).padStart(7)} (${P(aB.ret, 0)}/${P(aC.ret, 0)}) MDD ${P(a.mdd, 1)} n${a.n}  |  장중 ${P(h.ret, 1).padStart(7)} (${P(hB.ret, 0)}/${P(hC.ret, 0)}) MDD ${P(h.mdd, 1)} n${h.n}`);
    }
  }
  console.log(`→ 장중이 ECB 를 이긴 칸: 전체 ${rows.filter(r => r[1] > r[0]).length}/${rows.length} · 후반 ${rows.filter(r => r[3] > r[2]).length}/${rows.length}`);
  // 장중 지연 강건성 (1h 환율 데이터 지연 가정: +1h, +2h)
  const zH30 = zSeries(premH, 30);
  for (const lag of [4, 8]) console.log(`  장중 N30 k1.5 판단 지연 ${lag * 15}분: ${fmt(sim(zSig(zH30, 1.5, 0, lag)))}`);
}

// ═════ 2. 저프리미엄 원인 분해 (기준선 거래 단위)
if (MODE === 'cause') {
  const z = zSeries(premE, 30); const base = sim(zSig(z, 1.5, 0));
  console.log(`기준선 ECB N30 k1.5: ${fmt(base)}`);
  const kHits: number[] = []; // K축: BTC 가 직전 4h 기준가 대비 −3% 를 찍은 15m 봉
  for (let i = 0; i < BT.length; i++) { const ts = BT[i][0]; const ref = BT[bIdx.get(Math.floor(ts / (4 * H)) * 4 * H - 15 * 60e3 + 0) ?? -1]?.[4]; if (ref && BT[i][3] <= ref * 0.97) kHits.push(ts); }
  const nearK = (ts: number, win: number) => { let lo = 0, hi = kHits.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (kHits[m] < ts - win) lo = m + 1; else hi = m - 1; } return lo < kHits.length && kHits[lo] <= ts + win; };
  type Row = { r: number; cat: string; dP: number; btc: number; fxc: number; dk: number | null; k: boolean; d: string };
  const rows: Row[] = [];
  for (const t of base.trades) {
    const i = t.i - 1; const ts = bars[i].ts; const j = Math.max(0, i - 96);
    const dP = premE[i] - premE[j];
    const b0 = btcAt(bars[j].ts), b1 = btcAt(ts); const btc = b0 && b1 ? b1 / b0 - 1 : 0;
    const fxc = fxH[i] / fxH[j] - 1;                        // 원화 강세 = 음수
    const k0 = kimpAt(bars[j].ts), k1 = kimpAt(ts); const dk = k0 != null && k1 != null ? k1 - k0 : null;
    const cat = btc <= -0.03 ? 'A BTC급락(24h ≤−3%)' : fxc >= 0.005 ? 'B 원화약세(24h 환율 ≥+0.5%)' : (dk != null && dk <= -0.01) ? 'C 김프붕괴(24h ≤−1%p)' : fxc <= -0.005 ? 'D 원화강세(≤−0.5%)' : 'E 기타(국내 USDT 수급)';
    rows.push({ r: t.r, cat, dP, btc, fxc, dk, k: nearK(ts, 12 * H), d: new Date(ts + 9 * H).toISOString().slice(0, 16) });
  }
  const g = new Map<string, Row[]>(); for (const r of rows) { if (!g.has(r.cat)) g.set(r.cat, []); g.get(r.cat)!.push(r); }
  console.log('\n진입 직전 24h 원인별 거래 성과 (우선순위 A>B>C>D>E)');
  for (const [c, v] of [...g].sort()) console.log(`  ${c.padEnd(26)} n${String(v.length).padStart(3)} 평균 ${P(v.reduce((a, r) => a + r.r, 0) / v.length).padStart(7)} 승률 ${(100 * v.filter(r => r.r > 0).length / v.length).toFixed(0).padStart(3)}% 복리 ${P(comp(v.map(r => r.r)))}`);
  const kk = rows.filter(r => r.k);
  console.log(`\nK축(BTC 4h −3% 급락흡수) ±12h 겹침: ${kk.length}/${rows.length}건 · 겹친 거래 평균 ${P(kk.reduce((a, r) => a + r.r, 0) / Math.max(kk.length, 1))} vs 안 겹친 ${P(rows.filter(r => !r.k).reduce((a, r) => a + r.r, 0) / Math.max(rows.length - kk.length, 1))}`);
  // 연속 변수 상관
  const corr = (xs: number[], ys: number[]) => { const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length; let c = 0, vx = 0, vy = 0; xs.forEach((x, i) => { c += (x - mx) * (ys[i] - my); vx += (x - mx) ** 2; vy += (ys[i] - my) ** 2; }); return c / Math.sqrt(vx * vy); };
  console.log(`거래수익과의 상관: 24h 프리미엄변화 ${corr(rows.map(r => r.dP), rows.map(r => r.r)).toFixed(2)} · BTC 24h ${corr(rows.map(r => r.btc), rows.map(r => r.r)).toFixed(2)} · 환율 24h ${corr(rows.map(r => r.fxc), rows.map(r => r.r)).toFixed(2)}`);
  // 모든 15m 시점(신호 무관) 기준: z≤−1.5 상태에서 향후 3일 USDT 수익을 원인별로 — 거래 수 적은 문제 보완
  console.log('\nz≤−1.5 인 모든 4h 시점의 향후 3일 USDT 수익 (원인별, 4h 간격 표본)');
  const g2 = new Map<string, number[]>();
  for (let i = 96; i + 288 < N; i += 16) { if (!(z[i] <= -1.5)) continue; const j = i - 96; const b0 = btcAt(bars[j].ts), b1 = btcAt(bars[i].ts); const btc = b0 && b1 ? b1 / b0 - 1 : 0; const fxc = fxH[i] / fxH[j] - 1; const k0 = kimpAt(bars[j].ts), k1 = kimpAt(bars[i].ts); const dk = k0 != null && k1 != null ? k1 - k0 : null;
    const cat = btc <= -0.03 ? 'A BTC급락' : fxc >= 0.005 ? 'B 원화약세' : (dk != null && dk <= -0.01) ? 'C 김프붕괴' : fxc <= -0.005 ? 'D 원화강세' : 'E 기타';
    const r = (bars[i + 288].open - SLIP) / (bars[i + 1].open + SLIP) * (1 - FEE) ** 2 - 1; if (!g2.has(cat)) g2.set(cat, []); g2.get(cat)!.push(r); }
  for (const [c, v] of [...g2].sort()) console.log(`  ${c.padEnd(12)} n${String(v.length).padStart(4)} 3일 평균 ${P(v.reduce((a, b) => a + b, 0) / v.length).padStart(7)} 양수 ${(100 * v.filter(x => x > 0).length / v.length).toFixed(0)}%`);
}

// ═════ 3. 개선 규칙
if (MODE === 'rules') {
  const prem = process.argv[3] === 'h' ? premH : premE; const tag = process.argv[3] === 'h' ? '장중' : 'ECB';
  const z = zSeries(prem, 30);
  const show = (lab: string, s: Sig, hold = Infinity) => { const a = sim(s, 0, N - 1, hold), b = sim(s, 0, MID, hold), c = sim(s, MID, N - 1, hold); console.log(`  ${lab.padEnd(34)} ${fmt(a)} | 전반 ${P(b.ret, 1).padStart(7)} 후반 ${P(c.ret, 1).padStart(7)}`); };
  console.log(`[프리미엄 기준: ${tag}] N30`);
  console.log('── 기준선 / 청산 z ──');
  for (const ex of [-0.5, 0, 0.5, 1]) show(`k1.5 exit z≥${ex}`, zSig(z, 1.5, ex));
  console.log('── 분할 진입 (1/3 씩), exit z≥0 ──');
  const split = (ks: number[], ex: number): Sig => i => { const v = z[i]; if (isNaN(v)) return { buy: 0, sell: false }; let w = 0; ks.forEach((k, j) => { if (v <= -k) w = (j + 1) / ks.length; }); return { buy: w, sell: v >= ex }; };
  show('분할 −1/−1.5/−2', split([1, 1.5, 2], 0));
  show('분할 −1.25/−1.75/−2.25', split([1.25, 1.75, 2.25], 0));
  show('분할 −1.5/−2/−2.5', split([1.5, 2, 2.5], 0));
  show('분할 −1/−1.5/−2 exit 0.5', split([1, 1.5, 2], 0.5));
  console.log('── 시간 제한 (k1.5 exit 0) ──');
  for (const d of [3, 7, 14]) show(`최대 보유 ${d}일`, zSig(z, 1.5, 0), d * 96);
  console.log('── 지정가 사다리: 매수 지정가 = fx·(1+μ−k·σ) 상시(직전 봉 정보로 갱신), 매도 지정가 = fx·(1+μ+e·σ), 1틱 관통 ──');
  const { mu, sd, W } = muSd(prem, 30); const fxs = prem === premH ? fxH : fxE;
  const lim = (k: number, e: number, from = 0, to = N - 1, pen = 1, fee = FEE) => {
    let cash = 1, u = 0, peak = 1, mdd = 0, n = 0, inB = 0, ei = -1, epx = 0; const tr: number[] = [];
    for (let i = Math.max(from, W + 1); i <= to; i++) { const b = bars[i]; const f = fxs[i - 1];
      if (u === 0) { const L = Math.floor(f * (1 + mu[i - 1] - k * sd[i - 1])); if (b.low <= L - pen) { const px = Math.min(L, b.open); u = cash * (1 - fee) / px; cash = 0; ei = i; epx = px; } }
      else { const Hh = Math.ceil(f * (1 + mu[i - 1] + e * sd[i - 1])); if (i > ei && b.high >= Hh + pen) { const px = Math.max(Hh, b.open); cash = u * px * (1 - fee); tr.push(px / epx * (1 - fee) ** 2 - 1); u = 0; n++; } }
      if (u > 0) inB++; const eq = cash + u * b.close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); }
    return { ret: cash + u * bars[to].close - 1, mdd, n, expo: inB / (to - from + 1), trades: tr as any };
  };
  for (const [k, e] of [[1.5, 0], [1.5, 0.5], [2, 0], [2, 0.5], [1.25, 0.25], [1, 0.5]]) {
    const a = lim(k, e), b = lim(k, e, 0, MID), c = lim(k, e, MID), s = lim(k, e, 0, N - 1, 3);
    console.log(`  지정가 k${k} e${e}`.padEnd(36) + `${P(a.ret).padStart(8)} MDD ${P(a.mdd, 1).padStart(6)} 거래${String(a.n).padStart(4)} 노출${(100 * a.expo).toFixed(0).padStart(3)}% | 전반 ${P(b.ret, 1).padStart(7)} 후반 ${P(c.ret, 1).padStart(7)} | 관통3틱 ${P(s.ret, 1)}`);
  }
}

// ═════ 4. 반증 (후보 규칙: prem 기준 tag, N, k, ex)
if (MODE === 'rob') {
  const prem = process.argv[3] === 'h' ? premH : premE; const Nd = +(process.argv[4] || 30), k = +(process.argv[5] || 1.5), ex = +(process.argv[6] || 0);
  const z = zSeries(prem, Nd); const s = zSig(z, k, ex);
  console.log(`후보: ${process.argv[3] === 'h' ? '장중' : 'ECB'} N${Nd} k${k} exit z≥${ex}`);
  console.log(`  기본          ${fmt(sim(s))}`);
  FEE = 0.001; console.log(`  비용×2        ${fmt(sim(s))}`); FEE = 0.0005;
  SLIP = 1.5; console.log(`  슬리피지1.5틱 ${fmt(sim(s))}`); SLIP = 0.5;
  for (const lag of [4, 16]) console.log(`  지연 ${lag * 15}분     ${fmt(sim(zSig(z, k, ex, lag)))}`);
  for (const y of [2024, 2025, 2026]) { const [a, b] = yIdx(y); console.log(`  ${y}          ${fmt(sim(s, a, b), a, b)}`); }
  console.log('  분기별: ' + qIdx().map(([l, a, b]) => `${l} ${P(sim(s, a, b).ret, 1)}`).join(' · '));
  const tr = sim(s).trades; const rs = tr.map(t => t.r).sort((a, b) => b - a);
  console.log(`  거래 ${tr.length} 승률 ${(100 * tr.filter(t => t.r > 0).length / tr.length).toFixed(0)}% 평균 ${P(tr.reduce((a, t) => a + t.r, 0) / tr.length)} 최악 ${P(rs[rs.length - 1])} · 잭나이프 상위3 제외 ${P(comp(rs.slice(3)))} 상위5 ${P(comp(rs.slice(5)))} 상위10 ${P(comp(rs.slice(10)))}`);
  // 플라시보: 같은 보유기간 분포, 무작위 시점
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const holds = tr.map(t => t.j - t.i); const res: number[] = [];
  for (let q = 0; q < 300; q++) { let acc = 1; for (const h of holds) { const i = Math.floor(rnd() * (N - h - 2)) + 1; acc *= (bars[i + h].open - SLIP) / (bars[i].open + SLIP) * (1 - FEE) ** 2; } res.push(acc - 1); }
  res.sort((a, b) => a - b); const real = comp(tr.map(t => t.r));
  console.log(`  플라시보 300회 중앙 ${P(res[150])} 95분위 ${P(res[285])} 최대 ${P(res[299])} · 실제 ${P(real)} 초과 ${res.filter(x => x >= real).length}/300`);
  // 워크포워드: 전반에서 (N,k,ex) 선택 → 후반
  let best = { N: 0, k: 0, ex: 0, v: -9 }; const oos: number[] = [];
  for (const n of [14, 20, 30, 45, 60]) { const zz = zSeries(prem, n); for (const kk of [1, 1.25, 1.5, 2, 2.5]) for (const e of [-0.5, 0, 0.5, 1]) { const v = sim(zSig(zz, kk, e), 0, MID).ret; oos.push(sim(zSig(zz, kk, e), MID).ret); if (v > best.v) best = { N: n, k: kk, ex: e, v }; } }
  const o = sim(zSig(zSeries(prem, best.N), best.k, best.ex), MID); oos.sort((a, b) => a - b);
  console.log(`  WF: IS 최적 N${best.N} k${best.k} e${best.ex} (IS ${P(best.v)}) → OOS ${P(o.ret)} MDD ${P(o.mdd, 1)} · OOS 격자 ${oos.length}칸 중앙 ${P(oos[oos.length >> 1])} 양수 ${oos.filter(x => x > 0).length}`);
}

export {};

// ═════ 5. USDC 구조 · USDT−USDC 괴리 · 디페그 구간
if (MODE === 'usdc') {
  const C: { ts: number; open: number; high: number; low: number; close: number; volume: number }[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDC_15m.json', 'utf8'));
  const cMap = new Map(C.map(b => [b.ts, b]));
  console.log(`USDC 15m ${C.length}봉 ${new Date(C[0].ts).toISOString().slice(0, 10)} ~ ${new Date(C[C.length - 1].ts).toISOString().slice(0, 10)} · 봉당 평균 거래대금 ${Math.round(C.reduce((a, b) => a + b.volume * b.close, 0) / C.length / 1e4)}만원 · 거래 없는 봉(고=저) ${(100 * C.filter(b => b.high === b.low).length / C.length).toFixed(0)}%`);
  const idx: number[] = []; for (let i = 0; i < N; i++) if (cMap.has(bars[i].ts)) idx.push(i);
  const pc = idx.map(i => cMap.get(bars[i].ts)!.close / fxH[i] - 1), pt = idx.map(i => premH[i]);
  const sp = idx.map((_, k) => pt[k] - pc[k]).sort((a, b) => a - b); const q = (f: number) => sp[Math.floor(f * (sp.length - 1))];
  const mx = pc.reduce((a, b) => a + b, 0) / pc.length, my = pt.reduce((a, b) => a + b, 0) / pt.length; let c = 0, vx = 0, vy = 0; pc.forEach((x, k) => { c += (x - mx) * (pt[k] - my); vx += (x - mx) ** 2; vy += (pt[k] - my) ** 2; });
  console.log(`공통 ${idx.length}봉 · 프리미엄 상관(USDT, USDC) ${(c / Math.sqrt(vx * vy)).toFixed(3)} · 평균 USDT ${P(my)} USDC ${P(mx)}`);
  console.log(`USDT−USDC 괴리: p1 ${P(q(.01))} p10 ${P(q(.1))} p50 ${P(q(.5))} p90 ${P(q(.9))} p99 ${P(q(.99))}`);
  // USDC 에 같은 z 규칙 (USDC 가격 기준, 장중 환율) — 별도 시뮬(시장가 = 다음 봉 시가 ± 반틱(1원), 거래 없는 봉 체결 불가)
  const cb = idx.map(i => cMap.get(bars[i].ts)!); const Wc = 30 * 96;
  for (const k of [1.5, 2]) {
    let cash = 1, u = 0, n = 0, peak = 1, mdd = 0, s = 0, s2 = 0; const rs: number[] = []; let epx = 0;
    for (let t = 0; t < cb.length - 1; t++) { s += pc[t]; s2 += pc[t] ** 2; if (t >= Wc) { s -= pc[t - Wc]; s2 -= pc[t - Wc] ** 2; } if (t < Wc) continue;
      const mu = s / Wc, sd = Math.sqrt(Math.max(s2 / Wc - mu * mu, 1e-10)); const z = (pc[t] - mu) / sd; const nx = cb[t + 1];
      if (u === 0 && z <= -k) { epx = nx.open + 0.5; u = cash * (1 - FEE) / epx; cash = 0; }
      else if (u > 0 && z >= 0) { const px = nx.open - 0.5; cash = u * px * (1 - FEE); rs.push(px / epx * (1 - FEE) ** 2 - 1); u = 0; n++; }
      const eq = cash + u * nx.close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); }
    console.log(`  USDC z N30 k${k}: ${P(cash + u * cb[cb.length - 1].close - 1)} MDD ${P(mdd, 1)} 거래 ${n} 승률 ${(100 * rs.filter(r => r > 0).length / Math.max(n, 1)).toFixed(0)}%`);
  }
  // 같은 기간 USDT 장중 N30 k2 성과(비교)
  const i0 = idx[0]; const zH = zSeries(premH, 30); console.log(`  (비교) USDT 장중 N30 k2 같은 기간: ${fmt(sim(zSig(zH, 2, 0), i0), i0)}`);
  // 괴리 평균회귀: 괴리 z 가 크면(USDT 상대적으로 쌈) USDT 보유, 아니면 USDC… 는 둘 다 KRW 로 사고팔아야 하므로 왕복 비용 0.1%+α. 괴리 크기 분포만으로 판단
  const big = sp.filter(x => Math.abs(x) > 0.003).length; console.log(`  |괴리|>0.3%p 비율 ${(100 * big / sp.length).toFixed(1)}% (왕복 수수료 0.2% + 반틱×4 ≈ 0.35% 를 넘어야 스위칭 의미)`);
}
// ═════ 6. 디페그 가드 시뮬: Binance USDCUSDT 일봉 고가가 1.005 초과(=USDT 약세)인 날·다음날 신규 매수 금지
if (MODE === 'guard') {
  const a: any[] = [...JSON.parse(fs.readFileSync('data/research-ext/usdt2/binance-usdcusdt-1d.json', 'utf8')), ...JSON.parse(fs.readFileSync('data/research-ext/usdt2/binance-usdcusdt-1d-b.json', 'utf8'))];
  const bad = new Set<string>(); for (const r of a) { if (+r[2] > 1.005) { const d = new Date(r[0]); bad.add(d.toISOString().slice(0, 10)); bad.add(new Date(r[0] + DAY).toISOString().slice(0, 10)); } }
  const zH = zSeries(premH, 30);
  for (const [lab, extra] of [['가드 없음', (_: number) => true], ['USDT 약세일 매수 금지', (i: number) => !bad.has(new Date(bars[i].ts - DAY).toISOString().slice(0, 10))], ['프리미엄 < −5% 매수 금지', (i: number) => premH[i] > -0.05]] as Array<[string, (i: number) => boolean]>) {
    const s: Sig = i => { const z = zH[i]; return { buy: !isNaN(z) && z <= -2 && extra(i) ? 1 : 0, sell: !isNaN(z) && z >= 0 }; };
    console.log(`  ${lab.padEnd(22)} ${fmt(sim(s))}`);
  }
  const inSample = [...bad].filter(d => d >= '2024-07-01').sort(); console.log(`  표본 기간 내 USDT 약세 표시일: ${inSample.join(', ')}`);
  console.log(`  표본 내 프리미엄(장중) 최저 ${P(Math.min(...premH))} · 최고 ${P(Math.max(...premH))}`);
}
