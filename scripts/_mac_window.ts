/**
 * 축 L-1b 발표 전 드리프트 매매화 — 발표 시각 L시간 전 봉 시가에 시장가 매수, 발표 봉 종가(+X봉)에 시장가 매도.
 * 대조(플라시보): 같은 요일·같은 시각, 이벤트 없는 날(±7·14·21일). 비용 = (수수료 0.05% + 슬리피지 0.02%) × 2.
 */
import { B, EVENTS, barAt, H, P, mean, tstat, FEE, SLIP } from './_mac_core';
const COST = 2 * (FEE + SLIP);
const all = Object.values(EVENTS).flat();
const evSet = new Set(all.map(t => Math.floor(t / H) * H));
function trade(i: number, L: number, X: number, cost = COST) {   // i = 발표 봉 인덱스
  const a = i - L, b = i + X; if (a < 0 || b >= B.length) return NaN;
  if (B[b].ts - B[a].ts !== (L + X) * H) return NaN;              // 결손 봉 있으면 제외
  return B[b].close / B[a].open - 1 - cost;
}
const evIdx = (name: string) => EVENTS[name].map(barAt).filter((i): i is number => i !== undefined);
const ctlIdx = (name: string) => EVENTS[name].flatMap(t => [-21, -14, -7, 7, 14, 21].map(d => barAt(t + d * 24 * H)))
  .filter((i): i is number => i !== undefined && !evSet.has(B[i].ts));
console.log('비용 왕복 ' + (100 * COST).toFixed(2) + '%\n');
for (const name of ['FOMC', 'CPI', 'NFP', 'ALL']) {
  const ei = name === 'ALL' ? ['FOMC', 'CPI', 'NFP'].flatMap(evIdx) : evIdx(name);
  const ci = name === 'ALL' ? ['FOMC', 'CPI', 'NFP'].flatMap(ctlIdx) : ctlIdx(name);
  console.log(`== ${name} — 거래당 순수익 (행 L=매수 선행시간, 열 X=발표봉 이후 보유봉) · [대조 같은 요일·시각]`);
  console.log('   L\\X ' + [0, 1, 2, 4].map(x => String(x).padStart(16)).join(''));
  for (const L of [1, 2, 4, 8, 12, 24]) {
    const row = [0, 1, 2, 4].map(X => {
      const e = ei.map(i => trade(i, L, X)).filter(Number.isFinite), c = ci.map(i => trade(i, L, X)).filter(Number.isFinite);
      return `${P(100 * mean(e))}[${P(100 * mean(c), 2)}]`.padStart(16);
    }).join('');
    console.log(`   ${String(L).padStart(3)} ${row}`);
  }
}
// 대표 설정 L=4, X=0 반증
console.log('\n== 대표 L=4h · X=0 (발표 봉 종가 매도) 반증 ==');
const ei = ['FOMC', 'CPI', 'NFP'].flatMap(evIdx).sort((a, b) => a - b);
const r = ei.map(i => ({ i, r: trade(i, 4, 0) })).filter(x => Number.isFinite(x.r));
const half = Math.floor(r.length / 2);
console.log(`  n=${r.length} 평균 ${P(100 * mean(r.map(x => x.r)))} t ${tstat(r.map(x => x.r)).toFixed(2)} 승률 ${(100 * r.filter(x => x.r > 0).length / r.length).toFixed(0)}%`);
console.log(`  앞절반 ${P(100 * mean(r.slice(0, half).map(x => x.r)))} / 뒤절반 ${P(100 * mean(r.slice(half).map(x => x.r)))}`);
console.log(`  비용×2 ${P(100 * mean(ei.map(i => trade(i, 4, 0, 2 * COST)).filter(Number.isFinite)))}`);
const ys: Record<string, number[]> = {};
for (const x of r) (ys[new Date(B[x.i].ts).getUTCFullYear()] ??= []).push(x.r);
console.log('  연도별 ' + Object.entries(ys).map(([y, v]) => `${y} ${P(100 * mean(v), 2)}(${v.length})`).join(' · '));
// 무작위 플라시보: 같은 UTC 시각 분포에서 무작위 날짜 1000회
const hours = ei.map(i => new Date(B[i].ts).getUTCHours());
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const sims: number[] = [];
for (let k = 0; k < 1000; k++) {
  const xs: number[] = [];
  for (const h of hours) {
    let i: number | undefined;
    for (let tries = 0; tries < 20 && i === undefined; tries++) {
      const d = Math.floor(rnd() * (B[B.length - 1].ts - B[200].ts) / 86400e3);
      const ts = Math.floor((B[200].ts + d * 86400e3) / 86400e3) * 86400e3 + h * H;
      const j = barAt(ts); if (j !== undefined && !evSet.has(B[j].ts)) i = j;
    }
    if (i !== undefined) { const v = trade(i, 4, 0); if (Number.isFinite(v)) xs.push(v); }
  }
  sims.push(mean(xs));
}
sims.sort((a, b) => a - b);
const obs = mean(r.map(x => x.r));
console.log(`  플라시보(같은 시각·무작위 날짜 1000회): 중앙 ${P(100 * sims[500])} 95분위 ${P(100 * sims[950])} 99분위 ${P(100 * sims[990])} → 실제 ${P(100 * obs)} 초과 비율 ${(100 * sims.filter(s => s >= obs).length / 1000).toFixed(1)}%`);
