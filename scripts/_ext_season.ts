/**
 * 축 E-4 계절성 (2026-10-02) — 진입 타이밍 조정 재료로서 시간대·요일·월초/월말 효과.
 * 1h 28코인 2024-06~2026-08 (시간대), 4h 28코인 2022-06~2026-08 (4h 슬롯·요일), 일봉 전 종목 2018~ (요일·월초말, 동일가중 상위30).
 * 각 칸: 동일가중 평균 수익(bp), t값, IS/OOS 부호 일치 여부. 비용(왕복 ≥10bp + 스프레드)과 비교해서 읽을 것.
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const load = (m: string, tag: string) => { const fs2 = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_${tag}_`)); let best: any[] = []; for (const f of fs2) { const b = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (b.length > best.length) best = b; } return best.sort((a, b) => a.ts - b.ts); };
const kH = (ts: number) => new Date(ts + 9 * 3600e3).getUTCHours();
const kDow = (ts: number) => new Date(ts + 9 * 3600e3 - 9 * 3600e3).getUTCDay(); // 일봉 기준 요일(업비트 일봉 = KST 09시 시작 = UTC 00시)
function table(title: string, rows: { key: string; ts: number; r: number }[], split: number) {
  console.log(`\n── ${title} ──`);
  const keys = [...new Set(rows.map(x => x.key))].sort();
  for (const k of keys) {
    const xs = rows.filter(x => x.key === k);
    const f = (a: typeof xs) => { const n = a.length, mu = a.reduce((s, x) => s + x.r, 0) / n; const sd = Math.sqrt(a.reduce((s, x) => s + (x.r - mu) ** 2, 0) / n); return { n, mu: mu * 1e4, t: mu / (sd / Math.sqrt(n)) }; };
    const all = f(xs), is = f(xs.filter(x => x.ts < split)), oos = f(xs.filter(x => x.ts >= split));
    const same = Math.sign(is.mu) === Math.sign(oos.mu) ? '일치' : '반대';
    console.log(`  ${k.padEnd(10)} n${String(all.n).padStart(6)}  평균 ${all.mu.toFixed(1).padStart(6)}bp  t ${all.t.toFixed(2).padStart(6)} | IS ${is.mu.toFixed(1).padStart(6)} OOS ${oos.mu.toFixed(1).padStart(6)} ${same}`);
  }
}
// 1) 1h — KST 시간대별 1시간 수익 (코인 동일가중 → 시간당 평균)
{
  const rows: { key: string; ts: number; r: number }[] = [];
  const byTs = new Map<number, number[]>();
  for (const m of Object.keys(COINS)) { const b = load(m, '60m'); for (let i = 1; i < b.length; i++) { const r = b[i].close / b[i - 1].close - 1; if (!byTs.has(b[i].ts)) byTs.set(b[i].ts, []); byTs.get(b[i].ts)!.push(r); } }
  for (const [ts, a] of byTs) rows.push({ key: String(kH(ts)).padStart(2, '0') + '시봉', ts, r: a.reduce((s, x) => s + x, 0) / a.length });
  table('1h · KST 시간대별 (해당 시각에 시작하는 1시간봉 수익, 28코인 동일가중) 2024-06~2026-08', rows, Date.UTC(2025, 6, 15));
}
// 2) 4h 슬롯 · 요일
{
  const rows: { key: string; ts: number; r: number }[] = [], rowsD: typeof rows = [];
  const byTs = new Map<number, number[]>();
  for (const m of Object.keys(COINS)) { const b = load(m, '240m'); for (let i = 1; i < b.length; i++) { const r = b[i].close / b[i - 1].close - 1; if (!byTs.has(b[i].ts)) byTs.set(b[i].ts, []); byTs.get(b[i].ts)!.push(r); } }
  for (const [ts, a] of byTs) { const r = a.reduce((s, x) => s + x, 0) / a.length; rows.push({ key: String(kH(ts)).padStart(2, '0') + '시봉', ts, r }); }
  table('4h · KST 슬롯별 (28코인 동일가중) 2022-06~2026-08', rows, Date.UTC(2024, 6, 15));
  void rowsD;
}
// 3) 일봉 전 종목 — 요일·월초/월말 (직전 30일 거래대금 상위 30 동일가중)
if (process.argv[2] === 'daily') {
  const D = path.resolve(process.cwd(), 'data/research-ext/daily');
  const mk: string[] = JSON.parse(fs.readFileSync(path.join(D, '_markets.json'), 'utf8')).filter((m: string) => fs.existsSync(path.join(D, `${m}.json`)));
  const all = new Map<string, Map<number, any>>();
  for (const m of mk) { const b = JSON.parse(fs.readFileSync(path.join(D, `${m}.json`), 'utf8')); all.set(m, new Map(b.map((x: any) => [x.ts, x]))); }
  const days = [...new Set([...all.values()].flatMap(x => [...x.keys()]))].sort((a, b) => a - b).filter(t => t >= Date.UTC(2018, 0, 1));
  const DAY = 86400e3;
  const rowsW: { key: string; ts: number; r: number }[] = [], rowsM: typeof rowsW = [], rowsB: typeof rowsW = [];
  const NAMES = ['일', '월', '화', '수', '목', '금', '토'];
  for (const t of days) {
    const elig: { r: number; v: number }[] = [];
    for (const [, mp] of all) {
      const x = mp.get(t), p = mp.get(t - DAY); if (!x || !p) continue;
      let v = 0, n = 0; for (let j = 1; j <= 30; j++) { const y = mp.get(t - j * DAY); if (y) { v += y.value; n++; } }
      if (n >= 25) elig.push({ r: x.close / p.close - 1, v: v / n });
    }
    if (elig.length < 10) continue;
    elig.sort((a, b) => b.v - a.v); const top = elig.slice(0, 30);
    const r = top.reduce((s, x) => s + x.r, 0) / top.length;
    const d = new Date(t);
    rowsW.push({ key: `${d.getUTCDay()}${NAMES[d.getUTCDay()]}`, ts: t, r });
    const dom = d.getUTCDate(), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    rowsM.push({ key: dom <= 3 ? 'a 월초1~3' : dom > last - 3 ? 'c 월말3일' : 'b 중간', ts: t, r });
    const b = all.get('KRW-BTC')!.get(t), bp = all.get('KRW-BTC')!.get(t - DAY);
    if (b && bp) rowsB.push({ key: `${d.getUTCDay()}${NAMES[d.getUTCDay()]}`, ts: t, r: b.close / bp.close - 1 });
  }
  table('일봉 · 요일별 (상위30 동일가중, 업비트 일봉=KST09시 시작일 기준) 2018~2026', rowsW, Date.UTC(2022, 0, 1));
  table('일봉 · 요일별 BTC 단독 2018~2026', rowsB, Date.UTC(2022, 0, 1));
  table('일봉 · 월초/월말 (상위30 동일가중) 2018~2026', rowsM, Date.UTC(2022, 0, 1));
}
void kDow;
