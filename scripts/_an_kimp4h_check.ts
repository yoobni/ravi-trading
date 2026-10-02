/**
 * 축 A ⑤ — 김프 포크 단서 검증: 4h 에서 '바이낸스가 먼저 튄' 봉 뒤 업비트가 따라가나.
 * 봉 t(UTC 4h 시작) 동안: rB = 바이낸스 close/open−1... 여기선 close(t)/close(t−1)−1, rU 동일(업비트 KRW 4h).
 * 이벤트: rB − rU ≥ X (바이낸스가 업비트보다 X 이상 더 오름). 분해: rB ≥ X/2 (바이낸스가 튐) vs rU ≤ −X/2 (업비트 혼자 빠짐).
 * 업비트 향후: (a) 다음 봉 시가 → 종가 (체결 가능, 봉마감 직후 시장가) (b) 종가 → 다음 종가 (호가 튐 포함 — 참고용)
 * 바이낸스 향후: 종가 → 다음 종가 (바이낸스 쪽이 되돌리나 = 종가 왜곡 여부)
 */
import fs from 'fs';
import path from 'path';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));
const FOUR = 4 * 3600e3;
const upOf = (c: string) => { const f = fs.readdirSync('data/candle-cache').filter(x => x.startsWith(`KRW-${c}_240m_2022`)).sort().pop(); return f ? JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')) as any[] : []; };
const X = +(process.argv[2] || 2) / 100;
interface Ev { c: string; t: number; rB: number; rU: number; uOC: number; uCC: number; bCC: number; kind: string; cost: number }
const ev: Ev[] = [];
for (const c of COINS) {
  const U = upOf(c); const B: any[] = JSON.parse(fs.readFileSync(`data/research-ext/binance-${c}_240m.json`, 'utf8'));
  const ui = new Map(U.map((x, i) => [x.ts, i])); const bi = new Map(B.map((x: any, i: number) => [x.ts, i]));
  for (const [ts, i] of ui) {
    const j = bi.get(ts); if (j === undefined || i < 1 || j < 1 || i + 1 >= U.length || j + 1 >= B.length) continue;
    if (U[i + 1].ts !== ts + FOUR || B[j + 1].ts !== ts + FOUR) continue;
    const rB = B[j].close / B[j - 1].close - 1, rU = U[i].close / U[i - 1].close - 1;
    if (rB - rU < X) continue;
    ev.push({ c, t: ts, rB, rU, uOC: U[i + 1].close / U[i + 1].open - 1, uCC: U[i + 1].close / U[i].close - 1, bCC: B[j + 1].close / B[j].close - 1,
      kind: rB >= X / 2 && rU > -X / 2 ? 'B튐' : rU <= -X / 2 && rB < X / 2 ? 'U빠짐' : '둘다', cost: (10 + (SPREAD['KRW-' + c] ?? 20)) / 1e4 });
  }
}
const SPLIT = Date.UTC(2024, 7, 1);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const P = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
console.log(`괴리 기준 rB − rU ≥ ${(X * 100).toFixed(1)}% · 이벤트 ${ev.length}건 (2022-06~2026-08)`);
for (const k of ['B튐', 'U빠짐', '둘다']) {
  const e = ev.filter(x => x.kind === k); if (!e.length) continue;
  const net = e.map(x => x.uOC - x.cost);
  console.log(`\n[${k}] n=${e.length}  업비트 다음봉 시가→종가 ${P(mean(e.map(x => x.uOC)))} (IS ${P(mean(e.filter(x => x.t < SPLIT).map(x => x.uOC)))} / OOS ${P(mean(e.filter(x => x.t >= SPLIT).map(x => x.uOC)))})  비용차감 ${P(mean(net))}  승률 ${(100 * net.filter(x => x > 0).length / e.length).toFixed(0)}%`);
  console.log(`      업비트 종가→종가 ${P(mean(e.map(x => x.uCC)))}  · 바이낸스 다음봉 종가→종가 ${P(mean(e.map(x => x.bCC)))}`);
  const hourKey = (t: number) => new Date(t).getUTCHours();
  const me = (t: number) => { const d = new Date(t); const n = new Date(t + 86400e3); return n.getUTCDate() === 1; };
  const meH16 = e.filter(x => me(x.t) && hourKey(x.t) === 16);
  console.log(`      월말 UTC16시 봉 ${meH16.length}건 (${(100 * meH16.length / e.length).toFixed(0)}%) → 시가→종가 ${P(mean(meH16.map(x => x.uOC)))} · 그 외 ${P(mean(e.filter(x => !(me(x.t) && hourKey(x.t) === 16)).map(x => x.uOC)))}`);
  const byH: Record<number, number> = {}; for (const x of e) byH[hourKey(x.t)] = (byH[hourKey(x.t)] || 0) + 1;
  console.log(`      봉 시작 UTC 시각 분포 ${JSON.stringify(byH)}`);
}
fs.writeFileSync('data/research-ext/leadlag-4h-events.json', JSON.stringify(ev));
