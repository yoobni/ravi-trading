/** 축 L-1c 발표 전 드리프트 반증 강화 + 포트폴리오화 + BTC_TREND 결합 */
import { B, EVENTS, barAt, H, DAY, P, mean, tstat, FEE, SLIP, trendOn } from './_mac_core';
const COST = 2 * (FEE + SLIP);
const L = 4, X = 0;
const ev = (['FOMC', 'CPI', 'NFP'] as const).flatMap(n => EVENTS[n].map(t => ({ n, i: barAt(t) }))).filter((e): e is { n: any; i: number } => e.i !== undefined && e.i >= L).sort((a, b) => a.i - b.i);
const tr = ev.map(e => ({ ...e, r: B[e.i + X].close / B[e.i - L].open - 1 - COST, ts: B[e.i].ts })).filter(x => B[x.i + X].ts - B[x.i - L].ts === (L + X) * H);
const rs = tr.map(x => x.r).sort((a, b) => a - b);
console.log(`n=${rs.length} 평균 ${P(100 * mean(rs))} 중앙 ${P(100 * rs[Math.floor(rs.length / 2)])} 상하위5% 절사평균 ${P(100 * mean(rs.slice(Math.floor(rs.length * .05), Math.ceil(rs.length * .95))))}`);
const desc = tr.slice().sort((a, b) => b.r - a.r);
for (const k of [5, 10, 20]) console.log(`  상위 ${k}건 제거 평균 ${P(100 * mean(desc.slice(k).map(x => x.r)))}`);
// 분해: 발표 전 4h vs 발표 봉
const pre = tr.map(x => B[x.i - 1].close / B[x.i - L].open - 1), at = tr.map(x => B[x.i].close / B[x.i].open - 1);
console.log(`  분해(비용 전): 발표 전 4h ${P(100 * mean(pre))} t${tstat(pre).toFixed(1)} · 발표 봉 ${P(100 * mean(at))} t${tstat(at).toFixed(1)}`);
// 방향 분리: BTC 추세 on/off 일 때
const on = trendOn(50);
const dayOn = (ts: number) => on.get(Math.floor(ts / DAY) * DAY);
const trOn = tr.filter(x => dayOn(x.ts) === true), trOff = tr.filter(x => dayOn(x.ts) === false);
console.log(`  BTC_TREND on 일 ${trOn.length}건 ${P(100 * mean(trOn.map(x => x.r)))} · off 일 ${trOff.length}건 ${P(100 * mean(trOff.map(x => x.r)))}`);

// 포트폴리오: 시간 단위 자산곡선 (2018-03~)
function curve(mode: 'trend' | 'event' | 'union' | 'hold', f = 1) {
  const evWin = new Set<number>();
  for (const x of tr) for (let k = x.i - L; k <= x.i + X; k++) evWin.add(k);   // 보유 봉 인덱스(시가→종가)
  let eq = 1, pk = 1, mdd = 0, prevPos = 0, trades = 0;
  const start = barAt(Date.UTC(2018, 2, 1))!;
  const yr: Record<number, [number, number]> = {};
  for (let k = start; k < B.length; k++) {
    const tOn = dayOn(B[k].ts) === true;
    const pos = mode === 'hold' ? 1 : mode === 'trend' ? (tOn ? 1 : 0) : mode === 'event' ? (evWin.has(k) ? 1 : 0) : (tOn || evWin.has(k) ? 1 : 0);
    let r = 0;
    if (pos !== prevPos) { r -= (FEE + SLIP); trades++; }
    if (pos) r += B[k].close / B[k].open - 1 + (prevPos && k > 0 ? B[k].open / B[k - 1].close - 1 : 0);
    prevPos = pos;
    eq *= 1 + f * r; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk);
    const y = new Date(B[k].ts).getUTCFullYear(); yr[y] ??= [eq / (1 + f * r), eq]; yr[y][1] = eq;
  }
  return { ret: 100 * (eq - 1), mdd: 100 * mdd, trades, yr: Object.fromEntries(Object.entries(yr).map(([y, [a, b]]) => [y, 100 * (b / a - 1)])) };
}
const eqf = (mode: any) => { const s = curve(mode); if (s.mdd <= 17) return { f: 1, ...s }; let lo = 0, hi = 1; for (let i = 0; i < 25; i++) { const m = (lo + hi) / 2; if (curve(mode, m).mdd > 17) hi = m; else lo = m; } return { f: lo, ...curve(mode, lo) }; };
console.log('\n포트폴리오 (2018-03~, 1h 자산곡선, 전환 비용 0.07%/편도)');
console.log('전략'.padEnd(24) + '총익'.padStart(9) + 'MDD'.padStart(6) + '전환'.padStart(6) + ' | MDD17 총익  f   | 연도별(MDD17)');
for (const [lab, m] of [['BTC 보유', 'hold'], ['BTC_TREND', 'trend'], ['발표전 4h 단독', 'event'], ['BTC_TREND ∪ 발표전', 'union']] as const) {
  const s = curve(m as any), e = eqf(m);
  console.log(`${lab.padEnd(24)}${P(s.ret, 0).padStart(9)}${(s.mdd.toFixed(0) + '%').padStart(6)}${String(s.trades).padStart(6)} | ${P(e.ret, 0).padStart(7)} ${e.f.toFixed(2)} | ${Object.entries(e.yr).map(([y, v]) => `${y.slice(2)}:${P(v as number, 0)}`).join(' ')}`);
}
