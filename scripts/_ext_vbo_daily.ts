/**
 * 축 E-3b 변동성 돌파 장기판 — 업비트 전 종목 일봉 2018~2026 (2026-10-02). 15m 정밀판(_ext_vbo.ts)의 장기·광역 확인.
 * 일봉만으론 돌파 후 경로를 모르므로 체결 = 목표가 × (1 + 관통 pen + 슬리피지) [감시 후 시장가 근사], 청산 = 다음날 시가 × (1 − 슬리피지).
 * 유니버스 = 매일 직전 30일 평균 거래대금 상위 U (상장 60일 이상). 코인당 자본 1/U. 생존편향 있음(상폐 제외).
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const mk: string[] = JSON.parse(fs.readFileSync(path.join(DIR, '_markets.json'), 'utf8')).filter((m: string) => fs.existsSync(path.join(DIR, `${m}.json`)));
const B = new Map<string, any[]>(); for (const m of mk) B.set(m, JSON.parse(fs.readFileSync(path.join(DIR, `${m}.json`), 'utf8')));
const IDX = new Map([...B].map(([m, b]) => [m, new Map(b.map((x: any, i: number) => [x.ts, i]))]));
const DAYS = [...new Set([...B.values()].flatMap(b => b.map((x: any) => x.ts)))].sort((a, b) => a - b).filter(t => t >= Date.UTC(2018, 0, 1));
const FEE = 0.0005;
const slip = (m: string) => (SPREAD[m] != null ? Math.max(0.0005, SPREAD[m] / 2 / 1e4) : 0.003);
function run(U: number, k: number | 'noise', ma: boolean, pen: number, costMult = 1) {
  const series: { ts: number; r: number }[] = []; let nT = 0, sumT = 0;
  for (const t of DAYS) {
    const elig: { m: string; v: number; i: number }[] = [];
    for (const [m, b] of B) {
      const i = IDX.get(m)!.get(t); if (i === undefined || i < 60 || i + 1 >= b.length) continue;
      let v = 0; for (let j = i - 30; j < i; j++) v += b[j].value;
      elig.push({ m, v, i });
    }
    elig.sort((a, b) => b.v - a.v);
    let r = 0;
    for (const { m, i } of elig.slice(0, U)) {
      const b = B.get(m)!; const d = b[i], p = b[i - 1];
      let kk: number;
      if (k === 'noise') { let s = 0; for (let j = i - 20; j < i; j++) { const rg = b[j].high - b[j].low; s += rg > 0 ? 1 - Math.abs(b[j].close - b[j].open) / rg : 1; } kk = s / 20; } else kk = k;
      if (ma) { let s = 0; for (let j = i - 5; j < i; j++) s += b[j].close; if (d.open <= s / 5) continue; }
      const tgt = d.open + kk * (p.high - p.low);
      if (d.high < tgt) continue;
      const sl = slip(m) * costMult;
      const entry = tgt * (1 + pen * costMult + sl), exit = b[i + 1].open * (1 - sl);
      const tr = exit / entry * (1 - FEE * costMult) ** 2 - 1;
      r += tr / U; nT++; sumT += tr;
    }
    series.push({ ts: t, r });
  }
  return { series, nT, avg: nT ? 100 * sumT / nT : 0 };
}
const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[]) => { const s = st(rs); if (s.mdd <= 17) return { f: 1, ...s }; let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > 17) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const Y = (y: number) => Date.UTC(y, 0, 1);
const SEG: Array<[string, number, number]> = [['2018', Y(2018), Y(2019)], ['2019', Y(2019), Y(2020)], ['2020', Y(2020), Y(2021)], ['2021', Y(2021), Y(2022)], ['2022', Y(2022), Y(2023)], ['2023', Y(2023), Y(2024)], ['2024', Y(2024), Y(2025)], ['2025', Y(2025), Y(2026)], ['2026', Y(2026), Y(2027)]];
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
console.log(`종목 ${B.size} · 2018~ · 체결 = 목표가×(1+관통+스프레드½) · 생존편향 있음`);
console.log('설정'.padEnd(30) + '  거래  거래당   eq17   f   |' + SEG.map(s => s[0].padStart(6)).join(''));
for (const U of [10, 30]) for (const k of [0.5, 'noise'] as const) for (const pen of [0, 0.0042]) {
  const { series, nT, avg } = run(U, k, true, pen); const e = eq(series);
  const seg = SEG.map(([, a, b]) => P(st(series.filter(x => x.ts >= a && x.ts < b), e.f).ret).padStart(6)).join('');
  console.log(`U${U} k=${k} +MA5 관통${(pen * 100).toFixed(2)}%`.padEnd(30) + `${String(nT).padStart(6)} ${((avg >= 0 ? '+' : '') + avg.toFixed(2) + '%').padStart(7)} ${P(e.ret).padStart(6)} ${e.f.toFixed(2)} |${seg}`);
}
