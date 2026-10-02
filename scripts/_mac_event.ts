/** 축 L-1 이벤트 스터디 — FOMC·CPI·NFP 전후 KRW-BTC 수익·변동성 (1h, 2018~). 대조군 = 같은 요일·같은 시각 비이벤트 주(±7·14일). */
import { B, EVENTS, barAt, H, P, mean, tstat } from './_mac_core';
const ret = (i: number, k: number) => (i + k < B.length && i >= 0 ? B[i + k].close / B[i].close - 1 : NaN);   // i 봉 종가 → i+k 봉 종가
const win: Array<[string, number, number]> = [['−24h→직전', -25, -1], ['−4h→직전', -5, -1], ['발표 봉(1h)', -1, 0], ['+0→+4h', 0, 4], ['+0→+24h', 0, 24], ['+24→+72h', 24, 72]];
for (const [name, ev] of Object.entries(EVENTS)) {
  const idx = ev.map(barAt).filter((i): i is number => i !== undefined && i > 30 && i < B.length - 80);
  const ctl = ev.flatMap(t => [-14, -7, 7, 14].map(d => barAt(t + d * 24 * H))).filter((i): i is number => i !== undefined && i > 30 && i < B.length - 80 && !idx.includes(i));
  console.log(`\n== ${name} (n=${idx.length}, 대조 ${ctl.length}) ==`);
  console.log('창'.padEnd(14) + '평균수익'.padStart(9) + ' t'.padStart(6) + '  |평균|'.padStart(9) + '  대조 평균'.padStart(10) + ' 대조|r|'.padStart(9) + '  |r| 배율'.padStart(9) + '  앞절반/뒤절반 평균');
  for (const [w, a, b] of win) {
    const f = (i: number) => ret(i + a, b - a);
    const r = idx.map(f).filter(Number.isFinite), c = ctl.map(f).filter(Number.isFinite);
    const half = Math.floor(r.length / 2);
    console.log(`${w.padEnd(14)}${P(100 * mean(r)).padStart(9)}${tstat(r).toFixed(1).padStart(6)}${P(100 * mean(r.map(Math.abs))).padStart(9)}${P(100 * mean(c)).padStart(10)}${P(100 * mean(c.map(Math.abs))).padStart(9)}${(mean(r.map(Math.abs)) / mean(c.map(Math.abs))).toFixed(2).padStart(9)}   ${P(100 * mean(r.slice(0, half)))} / ${P(100 * mean(r.slice(half)))}`);
  }
  // 연도별 +0→+24h
  const ys: Record<string, number[]> = {};
  for (const i of idx) { const y = new Date(B[i].ts).getUTCFullYear(); (ys[y] ??= []).push(ret(i - 1, 25)); }
  console.log('  연도별 발표봉 포함 +24h: ' + Object.entries(ys).map(([y, v]) => `${y} ${P(100 * mean(v), 1)}(${v.length})`).join(' · '));
}
