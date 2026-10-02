/**
 * 축 J — 업비트 KRW-USDT 자체 매매(테더 프리미엄 평균회귀) 리서치 (2026-10-02).
 * 프리미엄 p = 업비트 USDT 가격 / 원달러(ECB, 미래참조 방지 위해 '이미 공표된' 직전 영업일) − 1.
 * 손익은 순수하게 업비트 KRW-USDT 가격으로 계산(롱 온리, 업비트 안 KRW↔USDT 만). 15m 해상도.
 * 비용: 수수료 0.05%/편도, 시장가 = 다음 15m 시가 ± 반틱(스프레드 1틱≈7bp → 반틱 ≈3.7bp),
 *       지정가 = 1틱 관통 요구(저가 ≤ 지정가−1원 / 고가 ≥ 지정가+1원), 슬리피지 0.
 */
import fs from 'fs';
const B: { ts: number; open: number; high: number; low: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDT_15m.json', 'utf8'));
const FXR: Record<string, number> = JSON.parse(fs.readFileSync('data/research-ext/fx-usdkrw.json', 'utf8'));
const FXD = Object.keys(FXR).sort();
const H = 3600e3, DAY = 24 * H;
let FEE = 0.0005, TICK_SLIP = 0.5;   // 시장가 체결 = 반틱 불리
// ECB 기준율은 해당일 16:00 CET(≈14~15 UTC) 공표 → 그 날짜 16 UTC 이후에만 사용
function fxAt(ts: number): number {
  const lim = new Date(ts - 16 * H).toISOString().slice(0, 10);
  let lo = 0, hi = FXD.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (FXD[m] <= lim) { ans = m; lo = m + 1; } else hi = m - 1; }
  return FXR[FXD[Math.max(ans, 0)]];
}
const START = Date.UTC(2024, 6, 1);   // 상장 직후 펌프(06-07~06-30) 제외
const bars = B.filter(b => b.ts >= START);
const fx = bars.map(b => fxAt(b.ts));
const prem = bars.map((b, i) => b.close / fx[i] - 1);
const P = (x: number, d = 2) => (x >= 0 ? '+' : '') + (100 * x).toFixed(d) + '%';
const MODE = process.argv[2] || 'all';

// ── 1. 시계열 특성
if (MODE === 'all' || MODE === 'stats') {
  const daily: { d: string; p: number; fx: number; px: number }[] = [];
  for (let i = 0; i < bars.length; i++) { const d = new Date(bars[i].ts + 9 * H).toISOString().slice(0, 10); if (!daily.length || daily[daily.length - 1].d !== d) daily.push({ d, p: prem[i], fx: fx[i], px: bars[i].close }); else { const x = daily[daily.length - 1]; x.p = prem[i]; x.fx = fx[i]; x.px = bars[i].close; } }
  const ps = daily.map(x => x.p).sort((a, b) => a - b), q = (f: number) => ps[Math.floor(f * (ps.length - 1))];
  console.log(`기간 ${daily[0].d} ~ ${daily[daily.length - 1].d} (${daily.length}일)`);
  console.log(`프리미엄 분포(일말): min ${P(ps[0])} p5 ${P(q(.05))} p25 ${P(q(.25))} p50 ${P(q(.5))} p75 ${P(q(.75))} p95 ${P(q(.95))} max ${P(ps[ps.length - 1])}`);
  for (const y of ['2024', '2025', '2026']) { const v = daily.filter(x => x.d.startsWith(y)).map(x => x.p); const s = v.slice().sort((a, b) => a - b); console.log(`  ${y} 평균 ${P(v.reduce((a, b) => a + b, 0) / v.length)} 범위 ${P(s[0])}~${P(s[s.length - 1])} p10/p90 ${P(s[Math.floor(.1 * s.length)])}/${P(s[Math.floor(.9 * s.length)])}`); }
  // AR(1) 일간
  const x = daily.map(d => d.p); const m = x.reduce((a, b) => a + b, 0) / x.length;
  let num = 0, den = 0; for (let i = 1; i < x.length; i++) { num += (x[i] - m) * (x[i - 1] - m); den += (x[i - 1] - m) ** 2; }
  const phi = num / den; console.log(`AR(1) 일간 φ=${phi.toFixed(3)} → 반감기 ${(Math.log(.5) / Math.log(phi)).toFixed(1)}일`);
  // 롤링 평균 대비 편차의 반감기 (레벨 드리프트 제거)
  for (const N of [7, 30]) { const dev: number[] = []; for (let i = N; i < x.length; i++) { const mm = x.slice(i - N, i).reduce((a, b) => a + b, 0) / N; dev.push(x[i] - mm); } let a = 0, b = 0; for (let i = 1; i < dev.length; i++) { a += dev[i] * dev[i - 1]; b += dev[i - 1] ** 2; } const ph = a / b; console.log(`  ${N}일 평균 대비 편차 AR(1) φ=${ph.toFixed(3)} 반감기 ${(Math.log(.5) / Math.log(ph)).toFixed(1)}일`); }
  // 분해: 기간 전체 USDT 수익 = 환율 × 프리미엄
  const f = daily[daily.length - 1], s = daily[0];
  console.log(`USDT 보유 ${P(f.px / s.px - 1)} = 환율 ${P(f.fx / s.fx - 1)} × 프리미엄 ${P((1 + f.p) / (1 + s.p) - 1)}`);
  // 향후 수익 예측: 프리미엄 5분위 → 향후 1/7/30일 USDT 수익, 환율, 프리미엄 변화
  for (const hz of [1, 7, 30]) {
    const rows = []; for (let i = 0; i + hz < daily.length; i++) rows.push({ p: daily[i].p, r: daily[i + hz].px / daily[i].px - 1, rf: daily[i + hz].fx / daily[i].fx - 1, half: daily[i].d < '2025-08-15' ? 0 : 1 });
    for (const h of [0, 1]) { const rr = rows.filter(r => r.half === h).sort((a, b) => a.p - b.p); const k = 5; const qs = Array.from({ length: k }, (_, j) => rr.slice(Math.floor(j * rr.length / k), Math.floor((j + 1) * rr.length / k)));
      console.log(`  ${hz}일 ${h ? '후반' : '전반'} USDT수익 by 프리미엄5분위: ` + qs.map(g => P(g.reduce((a, b) => a + b.r, 0) / g.length)).join(' ') + '  | 환율: ' + qs.map(g => P(g.reduce((a, b) => a + b.rf, 0) / g.length)).join(' ')); }
  }
}

// ── 2. 매매 시뮬
interface R { ret: number; mdd: number; n: number; fxC: number; prC: number; expo: number; avgHoldD: number }
type Sig = (i: number) => { buy: boolean; sell: boolean };
function simMarket(sig: Sig, from = 0, to = bars.length - 1, fee = FEE): R {
  let cash = 1, u = 0, peak = 1, mdd = 0, n = 0, fxC = 0, prC = 0, inBars = 0, ei = -1, hold = 0;
  for (let i = from; i < to; i++) {
    const s = sig(i); const nx = bars[i + 1];
    if (u === 0 && s.buy) { const px = nx.open + TICK_SLIP; u = cash * (1 - fee) / px; cash = 0; ei = i + 1; }
    else if (u > 0 && s.sell) { const px = nx.open - TICK_SLIP; cash = u * px * (1 - fee); u = 0; n++;
      fxC += Math.log(fx[i + 1] / fx[ei]); prC += Math.log((1 + (px / fx[i + 1] - 1)) / (1 + ((bars[ei].open) / fx[ei] - 1))); hold += bars[i + 1].ts - bars[ei].ts; }
    if (u > 0) inBars++;
    const eq = cash + u * bars[i].close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  }
  const eq = cash + u * bars[to].close;
  return { ret: eq - 1, mdd, n, fxC, prC, expo: inBars / (to - from), avgHoldD: n ? hold / n / DAY : 0 };
}
/** 지정가 사다리: 매수 지정가 = floor(fx·(1+L)), 매도 지정가 = ceil(fx·(1+Hh)). 1틱 관통 요구. */
function simLimit(L: number, Hh: number, from = 0, to = bars.length - 1, fee = FEE, pen = 1): R {
  let cash = 1, u = 0, peak = 1, mdd = 0, n = 0, fxC = 0, prC = 0, inBars = 0, ei = -1, epx = 0, hold = 0;
  for (let i = from; i <= to; i++) {
    const b = bars[i]; const f = fx[i];
    if (u === 0) { const lim = Math.floor(f * (1 + L)); if (b.low <= lim - pen) { const px = Math.min(lim, b.open); u = cash * (1 - fee) / px; cash = 0; ei = i; epx = px; } }
    else { const lim = Math.ceil(f * (1 + Hh)); if (i > ei && b.high >= lim + pen) { const px = Math.max(lim, b.open); cash = u * px * (1 - fee); u = 0; n++; fxC += Math.log(f / fx[ei]); prC += Math.log((px / f) / (epx / fx[ei])); hold += b.ts - bars[ei].ts; } }
    if (u > 0) inBars++;
    const eq = cash + u * b.close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  }
  const eq = cash + u * bars[to].close;
  return { ret: eq - 1, mdd, n, fxC, prC, expo: inBars / (to - from + 1), avgHoldD: n ? hold / n / DAY : 0 };
}
const yrs = (from: number, to: number) => (bars[to].ts - bars[from].ts) / (365 * DAY);
const fmt = (r: R, from = 0, to = bars.length - 1) => `${P(r.ret).padStart(8)} 연${P(Math.pow(1 + r.ret, 1 / yrs(from, to)) - 1, 1).padStart(7)} MDD ${P(r.mdd, 1).padStart(6)} 거래 ${String(r.n).padStart(3)} 노출 ${(100 * r.expo).toFixed(0).padStart(3)}% 보유 ${r.avgHoldD.toFixed(1).padStart(5)}일 | 환율기여 ${P(r.fxC, 1)} 프리미엄기여 ${P(r.prC, 1)}`;
const MID = bars.findIndex(b => b.ts >= Date.UTC(2025, 7, 15));
const YR = (y: number) => [bars.findIndex(b => b.ts >= Date.UTC(y, 0, 1)), (() => { const k = bars.findIndex(b => b.ts >= Date.UTC(y + 1, 0, 1)); return k < 0 ? bars.length - 1 : k - 1; })()] as [number, number];

if (MODE === 'all' || MODE === 'base') {
  console.log('\n── 기준선 (2024-07~) ──');
  const n = bars.length - 1;
  console.log(`  현금 0% · USDT 보유 ${P(bars[n].close / bars[0].open - 1)} · 환율 보유 ${P(fx[n] / fx[0] - 1)} · 기간 ${yrs(0, n).toFixed(2)}년`);
  let pk = 0, md = 0; for (const b of bars) { pk = Math.max(pk, b.close); md = Math.max(md, 1 - b.close / pk); } console.log(`  USDT 보유 MDD ${P(md, 1)}`);
}
if (MODE === 'all' || MODE === 'grid') {
  console.log('\n── 지정가 사다리 격자 (L=매수 프리미엄, H=매도 프리미엄) · 전체 / 전반 / 후반 ──');
  const Ls = [-0.01, -0.005, 0, 0.005, 0.01, 0.015], Hs = [0.01, 0.015, 0.02, 0.025, 0.03, 0.04];
  for (const L of Ls) for (const Hh of Hs) { if (Hh <= L + 0.004) continue;
    const a = simLimit(L, Hh), b = simLimit(L, Hh, 0, MID), c = simLimit(L, Hh, MID);
    console.log(`  L${P(L, 1).padStart(6)} H${P(Hh, 1).padStart(6)}  ${fmt(a)}  | 전반 ${P(b.ret).padStart(7)} 후반 ${P(c.ret).padStart(7)}`); }
}
if (MODE === 'all' || MODE === 'z') {
  console.log('\n── z-score (4h 표본 기준 롤링 N일 평균·표준편차) 시장가 · 매수 z≤−k, 매도 z≥exitZ ──');
  for (const N of [7, 30, 90]) {
    const W = N * 96; const mu: number[] = [], sd: number[] = [];
    let s = 0, s2 = 0; for (let i = 0; i < bars.length; i++) { s += prem[i]; s2 += prem[i] ** 2; if (i >= W) { s -= prem[i - W]; s2 -= prem[i - W] ** 2; } const w = Math.min(i + 1, W); mu.push(s / w); sd.push(Math.sqrt(Math.max(s2 / w - (s / w) ** 2, 1e-10))); }
    for (const k of [1, 1.5, 2]) for (const ex of [0, 1]) {
      const sig: Sig = i => { const z = i < W ? 0 : (prem[i] - mu[i]) / sd[i]; return { buy: i >= W && z <= -k, sell: z >= ex }; };
      const a = simMarket(sig), b = simMarket(sig, 0, MID), c = simMarket(sig, MID);
      console.log(`  N${String(N).padStart(3)}일 k${k} exit z≥${ex}  ${fmt(a)}  | 전반 ${P(b.ret).padStart(7)} 후반 ${P(c.ret).padStart(7)}`);
    }
  }
}
export { bars, fx, prem, simLimit, simMarket, fmt, MID, YR, yrs, P };
if (MODE === 'stress') {
  const cfg = JSON.parse(process.argv[3] || '[[0,0.02]]') as Array<[number, number]>;
  for (const [L, Hh] of cfg) {
    console.log(`\n── 스트레스 L${P(L, 1)} H${P(Hh, 1)} ──`);
    console.log(`  기본          ${fmt(simLimit(L, Hh))}`);
    console.log(`  비용×2        ${fmt(simLimit(L, Hh, 0, bars.length - 1, 0.001))}`);
    console.log(`  관통 3틱      ${fmt(simLimit(L, Hh, 0, bars.length - 1, FEE, 3))}`);
    for (const y of [2024, 2025, 2026]) { const [a, b] = YR(y); console.log(`  ${y}          ${fmt(simLimit(L, Hh, a, b), a, b)}`); }
  }
}

// ── z-score 견고성
function zSeries(N: number) {
  const W = N * 96; const mu: number[] = [], sd: number[] = [];
  let s = 0, s2 = 0; for (let i = 0; i < bars.length; i++) { s += prem[i]; s2 += prem[i] ** 2; if (i >= W) { s -= prem[i - W]; s2 -= prem[i - W] ** 2; } const w = Math.min(i + 1, W); mu.push(s / w); sd.push(Math.sqrt(Math.max(s2 / w - (s / w) ** 2, 1e-10))); }
  return (i: number) => i < W ? 0 : (prem[i] - mu[i]) / sd[i];
}
function zSig(N: number, k: number, ex: number, lag = 0): Sig { const z = zSeries(N); return i => { const j = i - lag; if (j < N * 96) return { buy: false, sell: false }; const v = z(j); return { buy: v <= -k, sell: v >= ex }; }; }
/** 거래 목록 (손익 분포·상위 제외용) */
function trades(sig: Sig, fee = FEE) {
  const out: { i: number; j: number; r: number }[] = []; let ei = -1, epx = 0;
  for (let i = 0; i < bars.length - 1; i++) { const s = sig(i); const nx = bars[i + 1];
    if (ei < 0 && s.buy) { ei = i + 1; epx = nx.open + TICK_SLIP; }
    else if (ei >= 0 && s.sell) { const px = nx.open - TICK_SLIP; out.push({ i: ei, j: i + 1, r: (px / epx) * (1 - fee) ** 2 - 1 }); ei = -1; } }
  return out;
}
if (MODE === 'zrob') {
  console.log('── 고원: N(일) × k, exit z≥0 · 전체 / 전반 / 후반 / MDD ──');
  for (const N of [14, 20, 30, 45, 60]) console.log(`  N${String(N).padStart(3)} ` + [1, 1.25, 1.5, 1.75, 2, 2.5].map(k => { const a = simMarket(zSig(N, k, 0)), b = simMarket(zSig(N, k, 0), 0, MID), c = simMarket(zSig(N, k, 0), MID); return `k${k}:${P(a.ret, 0)}(${P(b.ret, 0)}/${P(c.ret, 0)})`.padEnd(24); }).join(''));
  console.log('\n── 워크포워드: 전반에서 (N,k,exit) 최적 선택 → 후반 ──');
  let best = { N: 0, k: 0, ex: 0, v: -9 }; const oosAll: number[] = [];
  for (const N of [7, 14, 20, 30, 45, 60, 90]) for (const k of [1, 1.5, 2, 2.5]) for (const ex of [-0.5, 0, 0.5, 1]) { const v = simMarket(zSig(N, k, ex), 0, MID).ret; oosAll.push(simMarket(zSig(N, k, ex), MID).ret); if (v > best.v) best = { N, k, ex, v }; }
  const o = simMarket(zSig(best.N, best.k, best.ex), MID); oosAll.sort((a, b) => a - b);
  console.log(`  IS 최적 N${best.N} k${best.k} exit${best.ex} IS ${P(best.v)} → OOS ${P(o.ret)} (MDD ${P(o.mdd, 1)}) · OOS 격자 ${oosAll.length}칸 중앙 ${P(oosAll[oosAll.length >> 1])} 양수 ${oosAll.filter(x => x > 0).length}칸`);
  const C = (N: number, k: number) => {
    console.log(`\n── 스트레스 N${N} k${k} exit 0 ──`);
    console.log(`  기본             ${fmt(simMarket(zSig(N, k, 0)))}`);
    console.log(`  비용×2           ${fmt(simMarket(zSig(N, k, 0), 0, bars.length - 1, 0.001))}`);
    TICK_SLIP = 1.5; console.log(`  슬리피지 1.5틱   ${fmt(simMarket(zSig(N, k, 0)))}`); TICK_SLIP = 0.5;
    for (const lag of [1, 4, 16]) console.log(`  판단 지연 ${String(lag * 15).padStart(3)}분  ${fmt(simMarket(zSig(N, k, 0, lag)))}`);
    for (const y of [2024, 2025, 2026]) { const [a, b] = YR(y); console.log(`  ${y}             ${fmt(simMarket(zSig(N, k, 0), a, b), a, b)}`); }
    const tr = trades(zSig(N, k, 0)); const rs = tr.map(t => t.r).sort((a, b) => b - a);
    const comp = (xs: number[]) => xs.reduce((a, r) => a * (1 + r), 1) - 1;
    console.log(`  거래 ${tr.length}건 · 승률 ${(100 * tr.filter(t => t.r > 0).length / tr.length).toFixed(0)}% · 평균 ${P(tr.reduce((a, t) => a + t.r, 0) / tr.length)} · 상위5 ${rs.slice(0, 5).map(r => P(r, 1)).join(' ')}`);
    console.log(`  복리 전체 ${P(comp(rs))} · 상위3 제외 ${P(comp(rs.slice(3)))} · 상위5 제외 ${P(comp(rs.slice(5)))} · 상위10 제외 ${P(comp(rs.slice(10)))}`);
    for (const t of tr.filter(t => t.r >= rs[Math.min(4, rs.length - 1)])) console.log(`    대박 ${new Date(bars[t.i].ts + 9 * H).toISOString().slice(0, 16)} → ${new Date(bars[t.j].ts + 9 * H).toISOString().slice(0, 16)} ${P(t.r)}`);
    // 플라시보: 같은 거래 수·같은 보유기간 분포로 무작위 시점
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const holds = tr.map(t => t.j - t.i); const res: number[] = [];
    for (let s = 0; s < 200; s++) { let acc = 1; for (const h of holds) { const i = Math.floor(rnd() * (bars.length - h - 2)) + 1; acc *= (bars[i + h].open - TICK_SLIP) / (bars[i].open + TICK_SLIP) * (1 - FEE) ** 2; } res.push(acc - 1); }
    res.sort((a, b) => a - b); console.log(`  플라시보 200회: 중앙 ${P(res[100])} 95분위 ${P(res[190])} 최대 ${P(res[199])} · 실제 ${P(comp(rs))} 초과 ${res.filter(x => x >= comp(rs)).length}/200`);
  };
  C(30, 1.5); C(30, 2); C(7, 2);
}

// ── 환율 없는 대조: USDT 로그가격 자체의 z (프리미엄이 아니라 가격 평균회귀인가)
function zPriceSig(N: number, k: number, ex: number): Sig {
  const W = N * 96; const lp = bars.map(b => Math.log(b.close)); const mu: number[] = [], sd: number[] = [];
  let s = 0, s2 = 0; for (let i = 0; i < bars.length; i++) { s += lp[i]; s2 += lp[i] ** 2; if (i >= W) { s -= lp[i - W]; s2 -= lp[i - W] ** 2; } const w = Math.min(i + 1, W); mu.push(s / w); sd.push(Math.sqrt(Math.max(s2 / w - (s / w) ** 2, 1e-12))); }
  return i => { if (i < W) return { buy: false, sell: false }; const z = (lp[i] - mu[i]) / sd[i]; return { buy: z <= -k, sell: z >= ex }; };
}
if (MODE === 'ctrl') {
  console.log('── 대조: 환율 없이 USDT 가격 z (N일, k, exit 0) ──');
  for (const N of [14, 30, 60]) console.log(`  N${N} ` + [1.5, 2].map(k => { const a = simMarket(zPriceSig(N, k, 0)), b = simMarket(zPriceSig(N, k, 0), 0, MID), c = simMarket(zPriceSig(N, k, 0), MID); return `k${k}: ${P(a.ret)} (${P(b.ret)}/${P(c.ret)}) MDD ${P(a.mdd, 1)}`; }).join(' · '));
  console.log('  vs 프리미엄 z N30 k1.5: ' + (() => { const a = simMarket(zSig(30, 1.5, 0)); return `${P(a.ret)} MDD ${P(a.mdd, 1)}`; })());

  // ── BTC_TREND 합성 (2024-10-01~, 15m): BTC 일봉>SMA50 이면 BTC 100%, 아니면 현금 → 현금일 때 USDT z 전략에 사용
  const bf = fs.readdirSync('data/candle-cache').find(f => f.startsWith('KRW-BTC_15m'))!;
  const btc: { ts: number; open: number; close: number }[] = JSON.parse(fs.readFileSync('data/candle-cache/' + bf, 'utf8'));
  const bIdx = new Map(btc.map((b, i) => [b.ts, i]));
  const daily: { ts: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/daily/KRW-BTC.json', 'utf8'));
  const btcOn = (ts: number) => { // ts 시점에 '이미 확정된' 일봉 기준 (09:02 KST 판정 → UTC 00:02 이후 반영)
    const dayStart = Math.floor((ts - 2 * 60e3) / DAY) * DAY; const done = daily.filter(d => d.ts + DAY <= dayStart + 1);
    if (done.length < 50) return false; const w = done.slice(-50); return done[done.length - 1].close > w.reduce((a, d) => a + d.close, 0) / 50; };
  const onCache = new Map<number, boolean>();
  const on = (ts: number) => { const k = Math.floor((ts - 2 * 60e3) / DAY); if (!onCache.has(k)) onCache.set(k, btcOn(ts)); return onCache.get(k)!; };
  const zs = zSig(30, 1.5, 0);
  const i0 = bars.findIndex(b => b.ts >= Date.UTC(2024, 9, 2));
  const run = (useUsdt: boolean, useBtc = true) => {
    let cash = 1, ub = 0, uu = 0, peak = 1, mdd = 0, lastB = 0;
    for (let i = i0; i < bars.length - 1; i++) {
      const t = bars[i + 1].ts; const bi = bIdx.get(t); if (bi !== undefined) lastB = btc[bi].open;
      if (!lastB) continue;
      const wantB = useBtc && on(t);
      if (wantB && ub === 0) { if (uu > 0) { cash = uu * (bars[i + 1].open - TICK_SLIP) * (1 - FEE); uu = 0; } ub = cash * (1 - FEE) / (lastB * 1.0005); cash = 0; }
      else if (!wantB && ub > 0) { cash = ub * lastB * 0.9995 * (1 - FEE); ub = 0; }
      if (!wantB && useUsdt) { const s = zs(i);
        if (uu === 0 && s.buy) { uu = cash * (1 - FEE) / (bars[i + 1].open + TICK_SLIP); cash = 0; }
        else if (uu > 0 && s.sell) { cash = uu * (bars[i + 1].open - TICK_SLIP) * (1 - FEE); uu = 0; } }
      const eq = cash + ub * lastB + uu * bars[i + 1].close; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
    }
    const eq = cash + ub * lastB + uu * bars[bars.length - 1].close; return { ret: eq - 1, mdd };
  };
  console.log('\n── BTC_TREND 합성 (2024-10-02 ~ 2026-10-02, 자본 100%) ──');
  const a = run(false), b = run(true), c = run(true, false);
  console.log(`  BTC_TREND 단독        ${P(a.ret)} MDD ${P(a.mdd, 1)}`);
  console.log(`  USDT z 단독           ${P(c.ret)} MDD ${P(c.mdd, 1)}`);
  console.log(`  BTC_TREND + 현금→USDT ${P(b.ret)} MDD ${P(b.mdd, 1)}  (증분 ${P((1 + b.ret) / (1 + a.ret) - 1)})`);
}
