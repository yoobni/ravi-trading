/** 축 L-2·3 — 미국 증시 전일 수익 → 업비트 BTC (미국 장마감 이후), 미국 휴장일 효과, 원/달러 급변 → KRW-BTC */
import { B, barAt, H, DAY, P, mean, tstat, yahoo, etToUtc, FEE, SLIP } from './_mac_core';
const COST = 2 * (FEE + SLIP);
const rank = (a: number[]) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); s.forEach(([, i], k) => (r[i] = k)); return r; };
const ic = (x: number[], y: number[]) => { const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (rx[i] - mx) * (ry[i] - my); b += (rx[i] - mx) ** 2; c += (ry[i] - my) ** 2; } return a / Math.sqrt(b * c); };
const btcRet = (fromTs: number, hours: number) => { const i = barAt(fromTs), j = barAt(fromTs + hours * H); return i !== undefined && j !== undefined ? B[j].open / B[i].open - 1 : NaN; };
for (const idx of ['GSPC', 'IXIC']) {
  const s = yahoo(idx);
  const rows: { d: string; r: number; during: number; after8: number; after24: number }[] = [];
  for (let k = 1; k < s.length; k++) {
    const r = s[k].close / s[k - 1].close - 1;
    const close = etToUtc(s[k].date, 16, 0), open = etToUtc(s[k].date, 9, 30);
    rows.push({ d: s[k].date, r, during: btcRet(Math.floor(open / H) * H, 7), after8: btcRet(close, 8), after24: btcRet(close, 24) });
  }
  const ok = rows.filter(x => Number.isFinite(x.after24) && Number.isFinite(x.during) && x.d >= '2018-01-01');
  const half = Math.floor(ok.length / 2);
  console.log(`\n== ${idx} 일수익 → 장마감 이후 BTC (n=${ok.length}) — 순위상관 IC 전체 / 앞절반 / 뒤절반`);
  for (const k of ['during', 'after8', 'after24'] as const)
    console.log(`  ${k.padEnd(8)} IC ${ic(ok.map(x => x.r), ok.map(x => x[k])).toFixed(3)} / ${ic(ok.slice(0, half).map(x => x.r), ok.slice(0, half).map(x => x[k])).toFixed(3)} / ${ic(ok.slice(half).map(x => x.r), ok.slice(half).map(x => x[k])).toFixed(3)}`);
  const so = ok.slice().sort((a, b) => a.r - b.r); const q = 5;
  console.log('  지수 수익 5분위별 BTC 장마감후 24h 평균: ' + Array.from({ length: q }, (_, j) => P(100 * mean(so.slice(Math.floor(j * so.length / q), Math.floor((j + 1) * so.length / q)).map(x => x.after24)))).join('  '));
  for (const th of [-0.015, -0.025]) { const ev = ok.filter(x => x.r <= th); console.log(`  지수 ≤${(th * 100).toFixed(1)}% (n=${ev.length}): BTC 장마감후 24h ${P(100 * mean(ev.map(x => x.after24)))} t${tstat(ev.map(x => x.after24)).toFixed(1)} · 앞/뒤 ${P(100 * mean(ev.slice(0, ev.length >> 1).map(x => x.after24)))}/${P(100 * mean(ev.slice(ev.length >> 1).map(x => x.after24)))}`); }
  for (const th of [0.015, 0.025]) { const ev = ok.filter(x => x.r >= th); console.log(`  지수 ≥+${(th * 100).toFixed(1)}% (n=${ev.length}): BTC 장마감후 24h ${P(100 * mean(ev.map(x => x.after24)))} t${tstat(ev.map(x => x.after24)).toFixed(1)}`); }
}
// 미국 휴장일(평일인데 지수 없음) BTC 일수익 (UTC 00~24)
const sp = new Set(yahoo('GSPC').map((x: any) => x.date));
const dayRet: { d: string; dow: number; r: number }[] = [];
for (let t = Date.UTC(2018, 0, 2); t < B[B.length - 1].ts - DAY; t += DAY) { const r = btcRet(t, 24); if (Number.isFinite(r)) dayRet.push({ d: new Date(t).toISOString().slice(0, 10), dow: new Date(t).getUTCDay(), r }); }
const hol = dayRet.filter(x => x.dow >= 1 && x.dow <= 5 && !sp.has(x.d)), wk = dayRet.filter(x => x.dow >= 1 && x.dow <= 5 && sp.has(x.d)), we = dayRet.filter(x => x.dow === 0 || x.dow === 6);
console.log(`\n== 미국 휴장 평일 BTC 일수익 (UTC) n=${hol.length}: 평균 ${P(100 * mean(hol.map(x => x.r)))} |r| ${P(100 * mean(hol.map(x => Math.abs(x.r))))} · 개장 평일 ${P(100 * mean(wk.map(x => x.r)))} |r| ${P(100 * mean(wk.map(x => Math.abs(x.r))))} · 주말 ${P(100 * mean(we.map(x => x.r)))} |r| ${P(100 * mean(we.map(x => Math.abs(x.r))))}`);
// 원/달러
const fx = yahoo('KRW=X');
const fr: { d: string; r: number; next: number }[] = [];
for (let k = 1; k < fx.length; k++) {
  const r = fx[k].close / fx[k - 1].close - 1; if (!Number.isFinite(r) || Math.abs(r) > 0.05) continue;
  const t = Date.parse(fx[k].date + 'T00:00:00Z') + DAY;   // 다음날 UTC00(=KST09) 부터
  const nx = btcRet(t, 24); if (Number.isFinite(nx) && fx[k].date >= '2018-01-01') fr.push({ d: fx[k].date, r, next: nx });
}
const h2 = fr.length >> 1;
console.log(`\n== 원/달러 일변화 → 다음날 KRW-BTC (n=${fr.length}) IC ${ic(fr.map(x => x.r), fr.map(x => x.next)).toFixed(3)} / ${ic(fr.slice(0, h2).map(x => x.r), fr.slice(0, h2).map(x => x.next)).toFixed(3)} / ${ic(fr.slice(h2).map(x => x.r), fr.slice(h2).map(x => x.next)).toFixed(3)}`);
const sfx = fr.slice().sort((a, b) => a.r - b.r);
for (const [lab, xs] of [['원화 강세 상위5%', sfx.slice(0, Math.floor(sfx.length * .05))], ['원화 약세 상위5%', sfx.slice(Math.floor(sfx.length * .95))], ['원화 약세 상위1%', sfx.slice(Math.floor(sfx.length * .99))]] as const)
  console.log(`  ${lab} (n=${xs.length}, 환율변화 ${P(100 * mean(xs.map(x => x.r)))}): 다음날 BTC ${P(100 * mean(xs.map(x => x.next)))} t${tstat(xs.map(x => x.next)).toFixed(1)} 비용후 ${P(100 * (mean(xs.map(x => x.next)) - COST))}`);
console.log(`  전체 평균 다음날 BTC ${P(100 * mean(fr.map(x => x.next)))}`);
