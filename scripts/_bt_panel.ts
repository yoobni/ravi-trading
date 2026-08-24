/**
 * 패널(코인 간) 예측력 진단 — 지금까지의 사각지대.
 *
 * 문제의식: 이 프로젝트에서 시험한 모든 신호(F6 돌파, 항복반등, 눌림목, 변동성수축, 세션…)는
 *   전부 **단변량**이다. 코인 하나의 자기 과거만 본다. 28개 코인이 같이 움직이고
 *   그중 일부가 다른 코인을 선행한다는 패널 구조는 한 번도 쓴 적이 없다.
 *   크립토 stat-arb 문헌의 주류(횡단면 랭킹, lead-lag 네트워크)가 정확히 그 영역이다.
 *
 * 전략을 짜기 전에 "예측력이 존재하긴 하는가"부터 잰다. IC(정보계수) =
 *   매 시점 코인들을 피처로 줄 세운 순위와 다음 구간 수익률 순위의 상관(Spearman).
 *   |IC| 가 0.02~0.03 이상이고 부호가 전·후반에서 유지돼야 거래를 논할 가치가 있다.
 *
 * 피처(전부 확정봉까지만 사용 — 미래참조 없음):
 *   rev1   : 직전 1봉 수익률 (음수 부호면 단기 반전)
 *   mom6   : 직전 6봉 수익률 (단기 모멘텀)
 *   mom24  : 직전 24봉 수익률
 *   resid1 : BTC 베타 제거 후 잔차 수익률 (시장 공통요인을 뺀 개별 움직임)
 *   btcLag : 직전 봉 BTC 수익률 × 해당 코인의 베타 (BTC 선행 → 알트 추종 가설)
 *   volz   : 거래량 z (기존 F6 가 쓰던 축, 비교군)
 *
 * 대상 구간: 1h 캐시(28코인, 2024-06~2026-08). 예측 구간 h = 1, 4, 24봉.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string, unit: number): Bar[] | null {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(`${m}_${unit}m_`));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const UNIT = Number(process.argv[2]) || 60;
const SERIES = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m, UNIT); if (b && b.length > 500) SERIES.set(m, b); }
const MKTS = [...SERIES.keys()];
// 전 코인이 공통으로 갖는 타임스탬프만 사용 — 결측으로 인한 랭킹 왜곡 방지
const counts = new Map<number, number>();
for (const b of SERIES.values()) for (const x of b) counts.set(x.ts, (counts.get(x.ts) ?? 0) + 1);
const TS = [...counts.entries()].filter(([, c]) => c === MKTS.length).map(([t]) => t).sort((a, b) => a - b);
const PX = new Map<string, Map<number, Bar>>();
for (const [m, b] of SERIES) PX.set(m, new Map(b.map((x) => [x.ts, x])));

console.log(`=== 패널 예측력 진단 (${MKTS.length}코인 ${UNIT}m, ${new Date(TS[0]).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}, 공통 ${TS.length}봉) ===\n`);

/** close 배열 (공통 타임라인) */
const C: number[][] = MKTS.map((m) => TS.map((t) => PX.get(m)!.get(t)!.close));
const V: number[][] = MKTS.map((m) => TS.map((t) => PX.get(m)!.get(t)!.volume));
const O: number[][] = MKTS.map((m) => TS.map((t) => PX.get(m)!.get(t)!.open));
const ret = (ci: number, i: number, k: number) => (i - k < 0 ? NaN : C[ci][i] / C[ci][i - k] - 1);
const BTC = MKTS.indexOf('KRW-BTC');

/** 롤링 베타 (직전 W봉 1기 수익률로 회귀) — 매 시점 과거만 사용 */
const W = 168;
function beta(ci: number, i: number): number {
  if (i < W + 1) return 1;
  let sxy = 0, sxx = 0, mx = 0, my = 0, n = 0;
  for (let j = i - W + 1; j <= i; j++) {
    const x = ret(BTC, j, 1), y = ret(ci, j, 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    mx += x; my += y; n++;
  }
  if (n < 30) return 1;
  mx /= n; my /= n;
  for (let j = i - W + 1; j <= i; j++) {
    const x = ret(BTC, j, 1), y = ret(ci, j, 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 1;
}
function volZ(ci: number, i: number, w = 30): number {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += V[ci][j]; s2 += V[ci][j] ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (V[ci][i] - mn) / sd : 0;
}
/** Spearman: 값 배열 → 순위 상관 */
function spearman(a: number[], b: number[]): number {
  const n = a.length; if (n < 5) return NaN;
  // 동점은 평균 순위로 — 안 그러면 값이 모두 같을 때 배열 순서가 순위가 되어 가짜 상관이 생긴다
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n).fill(0);
    let k = 0;
    while (k < n) {
      let j = k;
      while (j + 1 < n && idx[j + 1][0] === idx[k][0]) j++;
      const avg = (k + j) / 2;
      for (let q = k; q <= j; q++) r[idx[q][1]] = avg;
      k = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const m = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - m) * (rb[i] - m); da += (ra[i] - m) ** 2; db += (rb[i] - m) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

const FEATURES: Array<[string, (ci: number, i: number, bt: number) => number]> = [
  ['rev1  (직전1봉 수익, 반전)', (ci, i) => -ret(ci, i, 1)],
  ['mom6  (직전6봉 수익)',       (ci, i) => ret(ci, i, 6)],
  ['mom24 (직전24봉 수익)',      (ci, i) => ret(ci, i, 24)],
  ['resid1(BTC베타 제거 잔차)',  (ci, i, bt) => -(ret(ci, i, 1) - bt * ret(BTC, i, 1))],
  ['btcLag(BTC직전수익×베타)',   (ci, i, bt) => bt * ret(BTC, i, 1)],
  ['volz  (거래량 z, 비교군)',   (ci, i) => volZ(ci, i)],
];
const HORIZONS = [1, 4, 24];

const START = Math.max(W + 30, 200);
const HALF = Math.floor((TS.length + START) / 2);

console.log('  피처                        | 예측구간 |    전체 IC |    전반 IC |    후반 IC | 부호일치');
console.log('  ' + '-'.repeat(96));
for (const [fname, fn] of FEATURES) {
  for (const h of HORIZONS) {
    const icAll: number[] = [], icA: number[] = [], icB: number[] = [];
    for (let i = START; i < TS.length - h - 1; i++) {
      const xs: number[] = [], ys: number[] = [];
      for (let ci = 0; ci < MKTS.length; ci++) {
        const bt = fname.startsWith('resid') || fname.startsWith('btcLag') ? beta(ci, i) : 1;
        const x = fn(ci, i, bt);
        // 진입은 다음 봉 **시가**, 청산은 i+h 봉 종가 — 미래참조 없음.
        // (진입가를 close[i+1] 로 두면 h=1 일 때 수익률이 항상 0 이 된다 — 실제로 그 버그가 있었다)
        const o = O[ci][i + 1], c2 = C[ci][i + h];
        const y = Number.isFinite(o) && o > 0 && Number.isFinite(c2) ? c2 / o - 1 : NaN;
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      }
      const ic = spearman(xs, ys);
      if (Number.isFinite(ic)) { icAll.push(ic); (i < HALF ? icA : icB).push(ic); }
    }
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
    const mAll = mean(icAll), mA = mean(icA), mB = mean(icB);
    const agree = Math.sign(mA) === Math.sign(mB) && Math.abs(mAll) >= 0.02;
    console.log(`  ${fname.padEnd(28)}| ${String(h).padStart(6)}봉 | ${mAll.toFixed(4).padStart(10)} | ${mA.toFixed(4).padStart(10)} | ${mB.toFixed(4).padStart(10)} | ${agree ? '✔ 유효' : (Math.sign(mA) === Math.sign(mB) ? '부호만' : '✘')}`);
  }
}
console.log('\n  판정 기준: |전체 IC| ≥ 0.02 이고 전·후반 부호가 같아야 "유효".');
console.log('  (IC 0.02 는 약하지만 횡단면 전략에서는 거래 가능 수준으로 본다. 비용은 별도.)');

// ─────────────────────────────────────────────────────────────
// 2부: 횡단면 반전 전략의 실제 수익성 (롱온리, 비용 반영)
// IC 가 있어도 비용을 못 이기면 소용없다. 특히 1봉 보유는 회전율이 극단적이다.
// ─────────────────────────────────────────────────────────────
const FEE = 0.0005, SLIP = 0.0005;
const INIT = 10_000_000;

/** 거래대금 근사 = 종가 × 거래량. 유동성 필터·비용 현실성 판단에 쓴다. */
function turnover(ci: number, i: number, w = 168): number {
  if (i < w) return 0;
  let s = 0;
  for (let j = i - w; j < i; j++) s += C[ci][j] * V[ci][j];
  return s / w;
}

interface Sim { total: number; mdd: number; rebals: number; turnPct: number; monthly: Map<string, number>; }
/**
 * K종목 균등보유, H봉마다 리밸런스. 점수 상위 K를 산다.
 * 비용은 실제 교체분에만 부과한다(유지되는 종목은 팔았다 다시 사지 않는다).
 * liqTop>0 이면 매 시점 거래대금 상위 liqTop 종목만 후보로 둔다.
 */
function simCS(score: (ci: number, i: number) => number, K: number, H: number, liqTop = 0): Sim {
  let eq = INIT;
  let held = new Map<string, number>();   // market → 비중(균등이므로 1/K)
  let peak = INIT, mdd = 0, rebals = 0, turnSum = 0;
  const monthly = new Map<string, number>();
  const start = Math.max(W + 30, 200);

  for (let i = start; i < TS.length - H - 1; i += H) {
    // 이번 리밸런스에서 보유할 종목 선정 (확정봉 i 까지의 정보만 사용)
    let cands = MKTS.map((m, ci) => ci);
    if (liqTop > 0) {
      cands = cands.map((ci) => [ci, turnover(ci, i)] as [number, number])
                   .sort((a, b) => b[1] - a[1]).slice(0, liqTop).map(([ci]) => ci);
    }
    const ranked = cands.map((ci) => [ci, score(ci, i)] as [number, number])
                        .filter(([, s]) => Number.isFinite(s))
                        .sort((a, b) => b[1] - a[1]).slice(0, K);
    const target = new Map(ranked.map(([ci]) => [MKTS[ci], 1 / K]));

    // 교체 비용: 목표와 현재 비중 차이의 절반(= 편도 회전율)에 왕복 마찰을 적용
    let turn = 0;
    const all = new Set([...held.keys(), ...target.keys()]);
    for (const m of all) turn += Math.abs((target.get(m) ?? 0) - (held.get(m) ?? 0));
    turn /= 2;
    turnSum += turn; rebals++;
    eq *= 1 - turn * (FEE + SLIP) * 2;

    // 보유 구간 수익: 다음 봉 시가 진입 → i+H 봉 종가
    let r = 0;
    for (const [ci] of ranked) {
      const o = O[ci][i + 1], c2 = C[ci][i + H];
      if (Number.isFinite(o) && o > 0 && Number.isFinite(c2)) r += (c2 / o - 1) / K;
    }
    const before = eq;
    eq *= 1 + r;
    held = target;

    const k = new Date(TS[i]).toISOString().slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + (eq - before) / INIT);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  return { total: (eq / INIT - 1) * 100, mdd, rebals, turnPct: rebals ? turnSum / rebals * 100 : 0, monthly };
}

const SC = {
  rev1: (ci: number, i: number) => -ret(ci, i, 1),
  resid1: (ci: number, i: number) => -(ret(ci, i, 1) - beta(ci, i) * ret(BTC, i, 1)),
  mom24: (ci: number, i: number) => ret(ci, i, 24),
};

console.log('\n\n=== 2부: 횡단면 반전 전략 (롱온리, 비용 0.1% 왕복 반영) ===\n');
console.log('  점수     | 보유K | 리밸런스 | 회전율 |     총익 |    MDD | 수익/MDD | 리밸런스수');
console.log('  ' + '-'.repeat(88));
for (const [name, fn] of [['rev1', SC.rev1], ['resid1', SC.resid1]] as Array<[string, (a: number, b: number) => number]>) {
  for (const H of [1, 2, 4, 6, 12, 24]) {
    for (const K of [5]) {
      const s = simCS(fn, K, H);
      console.log(`  ${name.padEnd(9)}| ${String(K).padStart(5)} | ${String(H).padStart(6)}봉 | ${(s.turnPct.toFixed(0) + '%').padStart(6)} | ${(s.total.toFixed(0) + '%').padStart(8)} | ${(s.mdd.toFixed(1) + '%').padStart(6)} | ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(8)} | ${String(s.rebals).padStart(9)}`);
    }
  }
}
console.log('\n  ◆ 보유 종목 수 스윕 (rev1, 4봉 보유)');
console.log('  점수     | 보유K | 리밸런스 | 회전율 |     총익 |    MDD | 수익/MDD');
for (const K of [3, 5, 8, 12]) {
  const s = simCS(SC.rev1, K, 4);
  console.log(`  ${'rev1'.padEnd(9)}| ${String(K).padStart(5)} | ${String(4).padStart(6)}봉 | ${(s.turnPct.toFixed(0) + '%').padStart(6)} | ${(s.total.toFixed(0) + '%').padStart(8)} | ${(s.mdd.toFixed(1) + '%').padStart(6)} | ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(8)}`);
}
console.log('\n  ◆ 유동성 필터 — 반전이 소형주 호가 튐(bid-ask bounce)이 아닌지 (rev1, K=5, 4봉)');
console.log('  후보군            |     총익 |    MDD | 수익/MDD');
for (const L of [0, 20, 14, 10, 6]) {
  const s = simCS(SC.rev1, 5, 4, L);
  console.log(`  ${(L === 0 ? '전체 28종' : `거래대금 상위 ${L}종`).padEnd(18)}| ${(s.total.toFixed(0) + '%').padStart(8)} | ${(s.mdd.toFixed(1) + '%').padStart(6)} | ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(8)}`);
}

// ── 비용이 전부 먹었다. 그럼 gross 는 얼마고, 손익분기 마찰은 얼마인가?
//    (edge 가 마찰보다 크면 실행 방식을 바꿔 살릴 여지가 있고, 작으면 이 축은 끝이다)
function simCostArg(score: (ci: number, i: number) => number, K: number, H: number, cost: number, liqTop = 0) {
  let eq = INIT, held = new Map<string, number>();
  let peak = INIT, mdd = 0, n = 0, turnSum = 0;
  const start = Math.max(W + 30, 200);
  for (let i = start; i < TS.length - H - 1; i += H) {
    let cands = MKTS.map((_, ci) => ci);
    if (liqTop > 0) cands = cands.map((ci) => [ci, turnover(ci, i)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, liqTop).map(([ci]) => ci);
    const ranked = cands.map((ci) => [ci, score(ci, i)] as [number, number]).filter(([, s]) => Number.isFinite(s)).sort((a, b) => b[1] - a[1]).slice(0, K);
    const target = new Map(ranked.map(([ci]) => [MKTS[ci], 1 / K]));
    let turn = 0;
    for (const m of new Set([...held.keys(), ...target.keys()])) turn += Math.abs((target.get(m) ?? 0) - (held.get(m) ?? 0));
    turn /= 2; turnSum += turn; n++;
    eq *= 1 - turn * cost;
    let r = 0;
    for (const [ci] of ranked) { const o = O[ci][i + 1], c2 = C[ci][i + H]; if (Number.isFinite(o) && o > 0 && Number.isFinite(c2)) r += (c2 / o - 1) / K; }
    eq *= 1 + r; held = target;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  return { total: (eq / INIT - 1) * 100, mdd, turn: n ? turnSum / n : 0, n };
}
/** 균등보유(시장) 벤치마크 — 리밸런스 없이 28종 매수 후 보유 */
function ewHold() {
  const start = Math.max(W + 30, 200), end = TS.length - 2;
  let r = 0;
  for (let ci = 0; ci < MKTS.length; ci++) r += (C[ci][end] / O[ci][start + 1] - 1) / MKTS.length;
  return r * 100;
}
console.log('\n\n=== 3부: edge 의 크기 — 비용이 없다면 얼마나 버는가 ===\n');
console.log('  구성                    | 무비용 총익 | 실비용 총익 | 손익분기 왕복비용 | 리밸런스 | 평균회전');
console.log('  ' + '-'.repeat(100));
for (const [name, fn] of [['rev1', SC.rev1], ['resid1', SC.resid1]] as Array<[string, (a: number, b: number) => number]>) {
  for (const H of [1, 4, 24]) {
    const g = simCostArg(fn, 5, H, 0);
    const net = simCostArg(fn, 5, H, (FEE + SLIP) * 2);
    // 손익분기: 무비용 총익을 0으로 만드는 회전당 비용 — 로그수익 기준 근사
    const gross = Math.log(1 + g.total / 100);
    const be = g.n > 0 && g.turn > 0 ? gross / (g.n * g.turn) : 0;
    console.log(`  ${(name + ' K=5 ' + H + '봉').padEnd(24)}| ${(g.total.toFixed(0) + '%').padStart(11)} | ${(net.total.toFixed(0) + '%').padStart(11)} | ${((be * 100).toFixed(4) + '%').padStart(17)} | ${String(g.n).padStart(8)} | ${(g.turn * 100).toFixed(0).padStart(7)}%`);
  }
}
console.log(`\n  현재 가정 왕복비용: ${((FEE + SLIP) * 2 * 100).toFixed(2)}%  (수수료 0.05% + 슬리피지 0.05%, 양방향)`);
console.log(`  28종 균등 매수후보유(시장) 총익: ${ewHold().toFixed(0)}%`);

// ── 구제 시도: 상시 리밸런스 대신 "급락 이벤트"에만 진입해 회전율을 죽인다.
//    edge 는 1봉에만 있으므로 보유기간은 못 늘린다 → 대신 거래 횟수를 줄이는 수밖에 없다.
//    현금·동시보유 제약을 둔 진짜 포트폴리오 시뮬.
function simEvent(dropPct: number, H: number, maxCon: number, cost: number, liqTop = 0) {
  let cash = INIT;
  const open: Array<{ ci: number; exitAt: number; vol: number; used: number }> = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const start = Math.max(W + 30, 200);
  for (let i = start; i < TS.length - H - 2; i++) {
    // 청산
    for (let p = open.length - 1; p >= 0; p--) {
      if (open[p].exitAt > i) continue;
      const pos = open[p];
      const proceeds = pos.vol * C[pos.ci][i] * (1 - cost / 2);
      cash += proceeds;
      const r = proceeds / pos.used - 1;
      n++; if (r > 0) { wins++; gw += r; } else gl += -r;
      open.splice(p, 1);
    }
    // 진입: 직전 1봉 수익률이 -dropPct% 이하 → 다음 봉 시가 매수
    if (open.length < maxCon) {
      let cands = MKTS.map((_, ci) => ci);
      if (liqTop > 0) cands = cands.map((ci) => [ci, turnover(ci, i)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, liqTop).map(([ci]) => ci);
      const hits = cands.filter((ci) => ret(ci, i, 1) <= -dropPct / 100)
                        .sort((a, b) => ret(a, i, 1) - ret(b, i, 1));   // 더 많이 빠진 순
      for (const ci of hits) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.ci === ci)) continue;
        const use = cash / (maxCon - open.length);
        if (use < 5000) continue;
        const ep = O[ci][i + 1] * (1 + cost / 2);
        if (!Number.isFinite(ep) || ep <= 0) continue;
        cash -= use;
        open.push({ ci, exitAt: i + H, vol: use / ep, used: use });
      }
    }
    let eq = cash;
    for (const p of open) eq += p.vol * C[p.ci][i];
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * C[p.ci][TS.length - 2];
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
}

console.log('\n\n=== 4부: 구제 시도 — 급락 이벤트에만 진입해 회전율을 죽이면? ===');
console.log('  (edge 는 1봉에만 있으므로 보유는 못 늘린다. 거래 횟수를 줄이는 것이 유일한 레버)\n');
console.log('  진입조건        | 보유 |     총익 |    MDD | 거래 |    WR |    PF');
console.log('  ' + '-'.repeat(72));
for (const drop of [1.5, 2, 3, 4, 5]) {
  for (const H of [1, 2]) {
    const s = simEvent(drop, H, 3, (FEE + SLIP) * 2);
    console.log(`  ${('1h 하락 ≥ ' + drop + '%').padEnd(16)}| ${String(H).padStart(3)}봉 | ${(s.total.toFixed(0) + '%').padStart(8)} | ${(s.mdd.toFixed(1) + '%').padStart(6)} | ${String(s.n).padStart(4)} | ${s.wr.toFixed(1).padStart(4)}% | ${s.pf.toFixed(2).padStart(5)}`);
  }
}
console.log('\n  ◆ 무비용이면? (edge 자체가 이벤트 조건에서도 살아있는지 확인)');
console.log('  진입조건        | 보유 |  무비용 총익 |  실비용 총익 | 거래');
for (const drop of [2, 3, 5]) {
  const g = simEvent(drop, 1, 3, 0), net = simEvent(drop, 1, 3, (FEE + SLIP) * 2);
  console.log(`  ${('1h 하락 ≥ ' + drop + '%').padEnd(16)}| ${String(1).padStart(3)}봉 | ${(g.total.toFixed(0) + '%').padStart(12)} | ${(net.total.toFixed(0) + '%').padStart(12)} | ${String(g.n).padStart(4)}`);
}

// ── 5부: 살아남은 후보의 검증. 파라미터 고원 / 기간분할 / 유동성 / F6 상관.
function simEvent2(dropPct: number, H: number, maxCon: number, cost: number, liqTop: number, from?: number, to?: number) {
  let cash = INIT;
  const open: Array<{ ci: number; exitAt: number; vol: number; used: number }> = [];
  let peak = INIT, mdd = 0, n = 0, wins = 0, gw = 0, gl = 0;
  const monthly = new Map<string, number>();
  const s0 = Math.max(W + 30, 200);
  const start = from ? Math.max(s0, TS.findIndex((t) => t >= from)) : s0;
  const eRaw = to ? TS.findIndex((t) => t >= to) : -1;
  const end = (eRaw < 0 ? TS.length : eRaw) - H - 2;
  for (let i = start; i < end; i++) {
    for (let p = open.length - 1; p >= 0; p--) {
      if (open[p].exitAt > i) continue;
      const pos = open[p];
      const proceeds = pos.vol * C[pos.ci][i] * (1 - cost / 2);
      cash += proceeds;
      const r = proceeds / pos.used - 1;
      n++; if (r > 0) { wins++; gw += r; } else gl += -r;
      const k = new Date(TS[i]).toISOString().slice(0, 7);
      monthly.set(k, (monthly.get(k) ?? 0) + (proceeds - pos.used) / INIT);
      open.splice(p, 1);
    }
    if (open.length < maxCon) {
      let cands = MKTS.map((_, ci) => ci);
      if (liqTop > 0) cands = cands.map((ci) => [ci, turnover(ci, i)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, liqTop).map(([ci]) => ci);
      for (const ci of cands.filter((ci) => ret(ci, i, 1) <= -dropPct / 100).sort((a, b) => ret(a, i, 1) - ret(b, i, 1))) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.ci === ci)) continue;
        const use = cash / (maxCon - open.length);
        if (use < 5000) continue;
        const ep = O[ci][i + 1] * (1 + cost / 2);
        if (!Number.isFinite(ep) || ep <= 0) continue;
        cash -= use; open.push({ ci, exitAt: i + H, vol: use / ep, used: use });
      }
    }
    let eq = cash;
    for (const p of open) eq += p.vol * C[p.ci][i];
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * C[p.ci][Math.min(end, TS.length - 2)];
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, monthly };
}
const COST = (FEE + SLIP) * 2;
console.log('\n\n=== 5부: 후보 검증 — 1h 급락 반전 ===\n');
console.log('◆ 파라미터 고원 (총익% / MDD% / 거래) — 한 칸만 좋으면 과최적화다');
let hdr = '  하락\\보유 |';
for (const H of [1, 2, 3, 4]) hdr += `${(H + '봉').padStart(19)} |`;
console.log(hdr);
for (const d of [3, 3.5, 4, 4.5, 5, 6]) {
  let line = `  ${(d + '%').padStart(9)} |`;
  for (const H of [1, 2, 3, 4]) {
    const s = simEvent2(d, H, 3, COST, 0);
    line += `${`${s.total.toFixed(0)}% / ${s.mdd.toFixed(0)}% / ${s.n}`.padStart(19)} |`;
  }
  console.log(line);
}
console.log('\n◆ 기간분할 (4% · 2봉 · 최대3종)');
const D = (s: string) => Date.parse(s + 'T00:00:00Z');
for (const [lbl, f, t] of [['2024H2', undefined, D('2025-01-01')], ['2025H1', D('2025-01-01'), D('2025-07-01')],
                            ['2025H2', D('2025-07-01'), D('2026-01-01')], ['2026 YTD', D('2026-01-01'), undefined]] as Array<[string, number|undefined, number|undefined]>) {
  const s = simEvent2(4, 2, 3, COST, 0, f, t);
  console.log(`  ${lbl.padEnd(10)} 총익 ${(s.total.toFixed(0) + '%').padStart(7)} · MDD ${(s.mdd.toFixed(1) + '%').padStart(6)} · 거래 ${String(s.n).padStart(4)} · PF ${s.pf.toFixed(2)}`);
}
console.log('\n◆ 유동성 필터 — 급락 4%가 소형주 호가 튐이면 체결이 안 된다');
for (const L of [0, 20, 14, 10, 6]) {
  const s = simEvent2(4, 2, 3, COST, L);
  console.log(`  ${(L === 0 ? '전체 28종' : `거래대금 상위 ${L}종`).padEnd(18)} 총익 ${(s.total.toFixed(0) + '%').padStart(7)} · MDD ${(s.mdd.toFixed(1) + '%').padStart(6)} · 거래 ${String(s.n).padStart(4)} · PF ${s.pf.toFixed(2)}`);
}
console.log('\n◆ 비용 스트레스');
for (const mult of [1, 1.5, 2, 3]) {
  const s = simEvent2(4, 2, 3, COST * mult, 0);
  console.log(`  왕복 ${(COST * mult * 100).toFixed(2)}%  총익 ${(s.total.toFixed(0) + '%').padStart(7)} · PF ${s.pf.toFixed(2)}`);
}
