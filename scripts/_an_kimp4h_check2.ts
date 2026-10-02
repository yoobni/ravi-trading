/** 축 A ⑥ — (1) 월말 UTC16 '바이낸스 튐' 이벤트의 독립 사건 수·날짜 (2) '업비트 혼자 빠짐' vs 같이 빠진 대조군 */
import fs from 'fs';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
const FOUR = 4 * 3600e3, SPLIT = Date.UTC(2024, 7, 1);
const ev: any[] = JSON.parse(fs.readFileSync('data/research-ext/leadlag-4h-events.json', 'utf8'));   // 마지막 실행(X=3%) 결과 — 다시 1.5% 로 만든다
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const P = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const upOf = (c: string) => { const f = fs.readdirSync('data/candle-cache').filter(x => x.startsWith(`KRW-${c}_240m_2022`)).sort().pop(); return f ? JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')) as any[] : []; };
const rows: any[] = [];
for (const c of COINS) {
  const U = upOf(c); const B: any[] = JSON.parse(fs.readFileSync(`data/research-ext/binance-${c}_240m.json`, 'utf8'));
  const bi = new Map(B.map((x: any, i: number) => [x.ts, i]));
  for (let i = 1; i + 1 < U.length; i++) {
    const j = bi.get(U[i].ts); if (j === undefined || j < 1 || j + 1 >= B.length || U[i + 1].ts !== U[i].ts + FOUR) continue;
    rows.push({ c, t: U[i].ts, rB: B[j].close / B[j - 1].close - 1, rU: U[i].close / U[i - 1].close - 1, uOC: U[i + 1].close / U[i + 1].open - 1, bCC: B[j + 1].close / B[j].close - 1, cost: (10 + (SPREAD['KRW-' + c] ?? 20)) / 1e4 });
  }
}
// (1) 월말 UTC16 바이낸스 튐
const me = (t: number) => new Date(t + 86400e3).getUTCDate() === 1 && new Date(t).getUTCHours() === 16;
const meEv = rows.filter(x => me(x.t) && x.rB - x.rU >= 0.015 && x.rB >= 0.0075);
const byDate = new Map<string, any[]>(); for (const x of meEv) { const d = new Date(x.t).toISOString().slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d)!.push(x); }
console.log(`(1) 월말 UTC16 봉 '바이낸스 튐'(괴리≥1.5%) ${meEv.length}건 = 독립 날짜 ${byDate.size}개`);
for (const [d, xs] of byDate) console.log(`   ${d}  ${xs.length}코인  바이낸스봉 ${P(mean(xs.map(x => x.rB)))} 업비트봉 ${P(mean(xs.map(x => x.rU)))} → 업비트 다음봉 시가→종가 ${P(mean(xs.map(x => x.uOC)))} 바이낸스 다음봉 ${P(mean(xs.map(x => x.bCC)))}`);
// 월말 UTC16 봉 전체(이벤트 아닌 것 포함) — 계절성인지
const allMe = rows.filter(x => me(x.t));
console.log(`   참고: 월말 UTC16 봉 전체 ${allMe.length}건 업비트 다음봉 ${P(mean(allMe.map(x => x.uOC)))} · 바이낸스 그 봉 ${P(mean(allMe.map(x => x.rB)))} · 업비트 그 봉 ${P(mean(allMe.map(x => x.rU)))}`);
// (2) 업비트 혼자 빠짐 vs 같이 빠짐
console.log(`\n(2) 업비트 4h 하락 크기별 — 바이낸스 대비 괴리 유무로 나눠 다음봉 시가→종가 (비용차감 전/후)`);
for (const [lo, hi] of [[-0.02, -0.01], [-0.04, -0.02], [-1, -0.04]]) {
  const inBin = rows.filter(x => x.rU <= hi && x.rU > lo);
  for (const [lab, f] of [['업비트만 빠짐(rB−rU≥1.5%)', (x: any) => x.rB - x.rU >= 0.015], ['같이 빠짐(|rB−rU|<0.5%)', (x: any) => Math.abs(x.rB - x.rU) < 0.005]] as Array<[string, (x: any) => boolean]>) {
    const e = inBin.filter(f);
    console.log(`   업비트 ${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}% ${lab.padEnd(24)} n=${String(e.length).padStart(5)}  ${P(mean(e.map(x => x.uOC)))} (IS ${P(mean(e.filter(x => x.t < SPLIT).map(x => x.uOC)))} / OOS ${P(mean(e.filter(x => x.t >= SPLIT).map(x => x.uOC)))})  비용후 ${P(mean(e.map(x => x.uOC - x.cost)))}  바이낸스 다음봉 ${P(mean(e.map(x => x.bCC)))}`);
  }
}
// 독립성: '업비트만 빠짐' 이벤트가 며칠에 몰리나
const ue = rows.filter(x => x.rB - x.rU >= 0.015 && x.rU <= -0.0075);
const days = new Map<string, number>(); for (const x of ue) { const d = new Date(x.t).toISOString().slice(0, 13); days.set(d, (days.get(d) || 0) + 1); }
const top = [...days].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n   '업비트만 빠짐' ${ue.length}건 = 독립 봉 ${days.size}개 · 상위 봉: ${top.map(([d, n]) => `${d}h×${n}`).join(' ')}`);
const perBar = [...days.keys()].map(k => mean(ue.filter(x => new Date(x.t).toISOString().slice(0, 13) === k).map(x => x.uOC - x.cost)));
console.log(`   봉 단위 평균(동시 이벤트를 1건으로) 비용후 ${P(mean(perBar))} · 양수 봉 비율 ${(100 * perBar.filter(x => x > 0).length / perBar.length).toFixed(0)}%`);
