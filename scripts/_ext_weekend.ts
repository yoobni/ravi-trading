/**
 * 축 E-4c 요일 창 매매 — 'KST 금 09시 시가 매수 → 일 09시 시가 매도' 가 비용 후에도 남나 (2026-10-02)
 * 업비트 일봉 2018~, 매주 직전 30일 거래대금 상위 N(상장 60일+) 동일가중. 모든 2일 창(7개)을 같이 보여 데이터 스누핑을 드러낸다.
 * 비용: 수수료 0.05%×2 + 스프레드½×2 (스프레드 미보유 코인 0.3%) · ×2 스트레스. 생존편향 있음.
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const mk: string[] = JSON.parse(fs.readFileSync(path.join(DIR, '_markets.json'), 'utf8')).filter((m: string) => fs.existsSync(path.join(DIR, `${m}.json`)));
const B = new Map<string, Map<number, any>>(); for (const m of mk) B.set(m, new Map(JSON.parse(fs.readFileSync(path.join(DIR, `${m}.json`), 'utf8')).map((x: any) => [x.ts, x])));
const FIRST = new Map([...B].map(([m, mp]) => [m, Math.min(...mp.keys())]));
const DAY = 86400e3, FEE = 0.0005;
const slip = (m: string, c: number) => (SPREAD[m] != null ? Math.max(0.0005, SPREAD[m] / 2 / 1e4) : 0.003) * c;
const NAMES = ['일', '월', '화', '수', '목', '금', '토'];
function run(startDow: number, hold: number, N: number | 'BTC', cost: number) {
  const rows: { ts: number; r: number }[] = [];
  for (let t = Date.UTC(2018, 0, 1); t < Date.UTC(2026, 9, 1); t += DAY) {
    if (new Date(t).getUTCDay() !== startDow) continue;
    let coins: string[];
    if (N === 'BTC') coins = ['KRW-BTC'];
    else {
      const el: { m: string; v: number }[] = [];
      for (const [m, mp] of B) { if (t - FIRST.get(m)! < 60 * DAY) continue; let v = 0, n = 0; for (let j = 1; j <= 30; j++) { const y = mp.get(t - j * DAY); if (y) { v += y.value; n++; } } if (n >= 25 && mp.get(t) && mp.get(t + hold * DAY)) el.push({ m, v: v / n }); }
      coins = el.sort((a, b) => b.v - a.v).slice(0, N).map(x => x.m);
    }
    let s = 0, n = 0;
    for (const m of coins) { const a = B.get(m)!.get(t), b = B.get(m)!.get(t + hold * DAY); if (!a || !b) continue; s += (b.open * (1 - slip(m, cost))) / (a.open * (1 + slip(m, cost))) * (1 - FEE * cost) ** 2 - 1; n++; }
    if (n) rows.push({ ts: t, r: s / n });
  }
  return rows;
}
const mean = (a: { r: number }[]) => a.reduce((s, x) => s + x.r, 0) / Math.max(a.length, 1) * 1e4;
const tval = (a: { r: number }[]) => { const mu = mean(a); const sd = Math.sqrt(a.reduce((s, x) => s + (x.r * 1e4 - mu) ** 2, 0) / a.length); return mu / (sd / Math.sqrt(a.length)); };
const HALF = Date.UTC(2022, 0, 1);
const yrs = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const show = (lab: string, rows: { ts: number; r: number }[]) => {
  let eq = 1, pk = 1, mdd = 0; for (const x of rows) { eq *= 1 + x.r; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); }
  const yr = yrs.map(y => mean(rows.filter(x => new Date(x.ts).getUTCFullYear() === y)).toFixed(0).padStart(5)).join('');
  console.log(`${lab.padEnd(26)} 주당 ${mean(rows).toFixed(1).padStart(6)}bp t ${tval(rows).toFixed(2).padStart(5)} | IS ${mean(rows.filter(x => x.ts < HALF)).toFixed(0).padStart(5)} OOS ${mean(rows.filter(x => x.ts >= HALF)).toFixed(0).padStart(5)} | 누적 ${(100 * (eq - 1)).toFixed(0).padStart(6)}% MDD ${(100 * mdd).toFixed(0)}% |${yr}`);
};
console.log('창'.padEnd(26) + '                         |    IS    OOS  |                       | 연도별 bp ' + yrs.map(y => String(y).slice(2)).join('   '));
for (const N of [10, 30] as const) {
  console.log(`── 상위 ${N} 동일가중 · 2일 보유 · 시작 요일별 (비용 포함) ──`);
  for (let d = 0; d < 7; d++) show(`${NAMES[d]} 09시→+2일 N${N}`, run(d, 2, N, 1));
}
console.log('── 금→일 변형 ──');
show('금→일 N10 비용×2', run(5, 2, 10, 2));
show('금→일 N30 비용×2', run(5, 2, 30, 2));
show('금→토 N10 (1일)', run(5, 1, 10, 1));
show('토→일 N10 (1일)', run(6, 1, 10, 1));
show('금→일 BTC', run(5, 2, 'BTC', 1));
show('금→일 N5', run(5, 2, 5, 1));
