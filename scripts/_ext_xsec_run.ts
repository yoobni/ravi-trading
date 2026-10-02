/** 축 E 실행기 — 횡단면 전략 격자 + 반증. 사용: npx tsx scripts/_ext_xsec_run.ts [grid|detail] */
import { simulate, stats, eqRisk, momentum, lowVol, volSurge, residMom, MAT, DAYS, type Cfg } from './_ext_xsec';

const Y = (y: number) => Date.UTC(y, 0, 1);
const SEG: Array<[string, number, number]> = [['2018-19', Y(2018), Y(2020)], ['2020-21', Y(2020), Y(2022)], ['2022-23', Y(2022), Y(2024)], ['2024', Y(2024), Y(2025)], ['2025', Y(2025), Y(2026)], ['2026', Y(2026), Y(2027)]];
const HALF = Y(2022);
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const START = Y(2018);

// 기준선: BTC 보유 · 유니버스 동일가중
const btc = MAT.get('KRW-BTC')!;
const btcSeries = DAYS.map((t, i) => ({ ts: t, r: i && btc[i] && btc[i - 1] ? btc[i]!.close / btc[i - 1]!.close - 1 : 0 })).filter(x => x.ts >= START);

function line(lab: string, c: Cfg) {
  const s = simulate(c, START);
  const full = stats(s), e = eqRisk(s);
  const isS = s.filter(x => x.ts < HALF), oosS = s.filter(x => x.ts >= HALF);
  const ei = eqRisk(isS), eo = eqRisk(oosS);
  const seg = SEG.map(([, a, b]) => P(stats(s.filter(x => x.ts >= a && x.ts < b), e.f).ret).padStart(6)).join('');
  console.log(`${lab.padEnd(30)} ${P(full.ret).padStart(9)} ${full.mdd.toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(7)} f${e.f.toFixed(2)} | IS ${P(ei.ret).padStart(6)} OOS ${P(eo.ret).padStart(6)} |${seg}`);
  return { s, e, eo };
}
const mode = process.argv[2] || 'grid';
console.log(`종목 ${MAT.size} · 기간 2018-01~ · 비용: 수수료 0.05% + 스프레드½(미보유 0.3%) · 생존편향 있음(상폐 제외)`);
console.log('설정'.padEnd(30) + '     총익  MDD |  동일위험17%        |   IS(18-21) OOS(22-26) |' + SEG.map(s => s[0].padStart(6)).join(''));
{
  const e = eqRisk(btcSeries), s = stats(btcSeries);
  const seg = SEG.map(([, a, b]) => P(stats(btcSeries.filter(x => x.ts >= a && x.ts < b), e.f).ret).padStart(6)).join('');
  console.log(`${'BTC 보유'.padEnd(30)} ${P(s.ret).padStart(9)} ${s.mdd.toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(7)} f${e.f.toFixed(2)} | IS ${P(eqRisk(btcSeries.filter(x => x.ts < HALF)).ret).padStart(6)} OOS ${P(eqRisk(btcSeries.filter(x => x.ts >= HALF)).ret).padStart(6)} |${seg}`);
}
if (mode === 'grid') {
  line('동일가중 상위30 (주간)', { score: () => 0, N: 30, U: 30, R: 7, minAge: 90 });
  for (const U of [30, 60]) for (const L of [7, 28, 84]) for (const N of [3, 5, 10]) for (const R of [1, 7])
    line(`MOM L${L} N${N} U${U} R${R}`, { score: momentum(L), N, U, R, minAge: L + 30 });
  for (const L of [7, 28]) for (const N of [5, 10]) line(`RESID L${L} N${N} U60 R7`, { score: residMom(L), N, U: 60, R: 7, minAge: 90 });
  for (const N of [5, 10]) line(`LOWVOL N${N} U60 R7`, { score: lowVol(), N, U: 60, R: 7, minAge: 90 });
  for (const N of [5, 10]) line(`VOLSURGE N${N} U60 R7`, { score: volSurge(), N, U: 60, R: 7, minAge: 90 });
}
if (mode === 'detail') {
  console.log('── 비용 0 (총 알파 확인) ──');
  line('동일가중 상위30 R7 비용0', { score: () => 0, N: 30, U: 30, R: 7, minAge: 90, costMult: 0 });
  for (const [L, N] of [[7, 5], [28, 5], [28, 10], [84, 10]]) line(`MOM L${L} N${N} U60 R7 비용0`, { score: momentum(L), N, U: 60, R: 7, minAge: L + 30, costMult: 0 });
  line('LOWVOL N5 U60 R7 비용0', { score: lowVol(), N: 5, U: 60, R: 7, minAge: 90, costMult: 0 });
  console.log('── 플라시보: 무작위 5종목 U60 R7 비용0 (10시드) ──');
  for (let sd = 1; sd <= 10; sd++) line(`RAND N5 seed${sd} 비용0`, { score: () => 0, N: 5, U: 60, R: 7, minAge: 90, costMult: 0, randSeed: sd * 7919 });
  console.log('── BTC 50일선 게이트 (아래면 현금) ──');
  line('MOM L28 N5 U60 R7 +BTC게이트', { score: momentum(28), N: 5, U: 60, R: 7, minAge: 58, btcGate: true });
  line('LOWVOL N5 U60 R7 +BTC게이트', { score: lowVol(), N: 5, U: 60, R: 7, minAge: 90, btcGate: true });
  line('동일가중 상위10 R7 +BTC게이트', { score: () => 0, N: 10, U: 10, R: 7, minAge: 90, btcGate: true });
  line('BTC만 +BTC게이트', { score: (m) => m === 'KRW-BTC' ? 1 : null, N: 1, U: 300, R: 1, minAge: 60, btcGate: true });
}
