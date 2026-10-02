/** 축 D-3: 펀딩 기반 포트폴리오 · F7 보조 필터 (리서치 전용) */
import fs from 'fs';
import path from 'path';
import { BARS, IDX, TS, DAY, FOUR, SPLIT, run, report, HEAD, sigF6, setCost, eqRisk } from './_bt_deriv_port';
const FD = path.resolve('data/research-ext/binance/funding');
const FUND = new Map<string, Array<[number, number]>>();
for (const c of BARS.keys()) {
  const raw: Array<[number, number]> = JSON.parse(fs.readFileSync(path.join(FD, c + '.json'), 'utf8'));
  const m = new Map<number, number[]>();
  for (const [t, r] of raw) { const k = Math.round(t / 3600e3) * 3600e3; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  const ser = [...m].map(([t, a]) => [t, a.reduce((s, x) => s + x, 0) / a.length] as [number, number]).sort((a, b) => a[0] - b[0]);
  FUND.set(c, ser.map(([t, r], i) => [t, r * 8 / (i ? Math.min(8, Math.max(1, (t - ser[i - 1][0]) / 3600e3)) : 8)] as [number, number]));
}
// 봉 i 마감 시각(ts+4h) 기준 확정된 펀딩의 24h 가중평균
const cacheF = new Map<string, number | null>();
function f24(c: string, t: number): number | null {
  const key = c + t; if (cacheF.has(key)) return cacheF.get(key)!;
  const s = FUND.get(c)!; let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  let v: number | null = null;
  if (k >= 0 && t - s[k][0] <= DAY) { let a = 0, n = 0; for (let j = k; j >= 0 && s[j][0] > t - DAY; j--) { a += s[j][1]; n++; } v = a / n; }
  cacheF.set(key, v); return v;
}
// 자기 90일(=270 정산) 백분위 — 봉 마감 시각 기준
function pctOwn(c: string, t: number): number | null {
  const s = FUND.get(c)!; let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 270) return null; const cur = f24(c, t); if (cur == null) return null;
  let le = 0; for (let j = k - 269; j <= k; j++) if (s[j][1] <= cur) le++;
  return le / 270;
}
// 시장 펀딩: 코인 f24 중앙값, 그리고 그 값의 직전 90일 백분위
const MKT = new Map<number, number>();
for (const t of TS) { const v = [...BARS.keys()].map(c => f24(c, t + FOUR)).filter((x): x is number => x != null).sort((a, b) => a - b); if (v.length >= 10) MKT.set(t, v[Math.floor(v.length / 2)]); }
const mktTs = [...MKT.keys()].sort((a, b) => a - b);
const MKTP = new Map<number, number>();
for (let i = 540; i < mktTs.length; i++) { const cur = MKT.get(mktTs[i])!; let le = 0; for (let j = i - 540; j < i; j++) if (MKT.get(mktTs[j])! <= cur) le++; MKTP.set(mktTs[i], le / 540); }
const bt = (c: string, i: number) => BARS.get(c)![i].ts;
const F7 = { tp: 6, maxb: 18 };
if (process.argv[2] === 'hot2') {
  const pf = (c: string, i: number) => pctOwn(c, bt(c, i) + FOUR);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
  // 시장 3일 수익(동일가중) at 진입 시각
  const mk = new Map<number, number>();
  for (const t of TS) { const r: number[] = []; for (const c of BARS.keys()) { const i = IDX.get(c)!.get(t); const b = BARS.get(c)!; if (i !== undefined && i + 17 < b.length) r.push(b[i + 17].close / b[i].open - 1); } if (r.length >= 10) mk.set(t, mean(r)); }
  console.log('F6 신호 3일 수익 − 시장 3일 수익 (시장조정), 자기 펀딩 백분위 구간별');
  for (const [lab, lo, hi] of [['p<0.5', -1, 0.5], ['0.5~0.8', 0.5, 0.8], ['0.8~0.95', 0.8, 0.95], ['>0.95', 0.95, 2]] as Array<[string, number, number]>) {
    const is: number[] = [], oos: number[] = [], isr: number[] = [], oosr: number[] = [];
    for (const c of BARS.keys()) { const b = BARS.get(c)!; for (let i = 50; i < b.length - 19; i++) if (sigF6(c, i)) {
      const p = pf(c, i); if (p == null || !(p > lo && p <= hi)) continue; const m = mk.get(b[i + 1].ts); if (m == null) continue;
      const r = b[i + 18].close / b[i + 1].open - 1; (b[i].ts < SPLIT ? is : oos).push(r - m); (b[i].ts < SPLIT ? isr : oosr).push(m); } }
    console.log(`  ${lab.padEnd(9)} IS 조정 ${(100 * mean(is)).toFixed(2).padStart(6)}% (시장 ${(100 * mean(isr)).toFixed(2)}%)   OOS 조정 ${(100 * mean(oos)).toFixed(2).padStart(6)}% (시장 ${(100 * mean(oosr)).toFixed(2)}%)`);
  }
  console.log(HEAD);
  const byFund = (cs: string[], t: number) => cs.slice().sort((a, b) => { const ia = IDX.get(a)!.get(t), ib = IDX.get(b)!.get(t); const pa = ia ? pctOwn(a, t) ?? 0 : 0, pb = ib ? pctOwn(b, t) ?? 0 : 0; return pb - pa; });
  const rnd = (seed: number) => (cs: string[], t: number) => cs.slice().sort((a, b) => ((a.charCodeAt(0) * 31 + t / FOUR * seed) % 97) - ((b.charCodeAt(0) * 31 + t / FOUR * seed) % 97));
  for (const [lab, ord] of [['기본 순서', undefined], ['펀딩 백분위 높은 순 우선', byFund]] as Array<[string, any]>) {
    const r = run(sigF6, F7, 0.33, 0, Infinity, 3, 0, ord), o = run(sigF6, F7, 0.33, SPLIT, Infinity, 3, 0, ord), is = run(sigF6, F7, 0.33, 0, SPLIT, 3, 0, ord);
    console.log(`  ${lab.padEnd(24)} 전체 ${r.ret.toFixed(0)}%/${r.mdd.toFixed(0)}% 거래당 ${r.avg.toFixed(2)}%   IS ${is.ret.toFixed(0)}%/${is.mdd.toFixed(0)}%   OOS ${o.ret.toFixed(0)}%/${o.mdd.toFixed(0)}%`);
  }
  const rr: number[] = [], ro: number[] = [];
  for (let sd = 1; sd <= 20; sd++) { rr.push(run(sigF6, F7, 0.33, 0, Infinity, 3, 0, rnd(sd)).ret); ro.push(run(sigF6, F7, 0.33, SPLIT, Infinity, 3, 0, rnd(sd)).ret); }
  rr.sort((a, b) => a - b); ro.sort((a, b) => a - b);
  console.log(`  무작위 순서 20회: 전체 중앙 ${rr[10].toFixed(0)}% (90분위 ${rr[18].toFixed(0)}%) · OOS 중앙 ${ro[10].toFixed(0)}% (90분위 ${ro[18].toFixed(0)}%)`);
  process.exit(0);
}
if (process.argv[2] === 'hot') {
  const pf = (c: string, i: number) => pctOwn(c, bt(c, i) + FOUR);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
  console.log('F6 신호 단위 3일 수익 — 자기 펀딩 백분위 구간별 (IS / OOS)');
  const bins: Array<[string, number, number]> = [['p<0.5', -1, 0.5], ['0.5~0.8', 0.5, 0.8], ['0.8~0.95', 0.8, 0.95], ['>0.95', 0.95, 2], ['없음', NaN, NaN]];
  for (const [lab, lo, hi] of bins) {
    const is: number[] = [], oos: number[] = [];
    for (const c of BARS.keys()) { const b = BARS.get(c)!; for (let i = 50; i < b.length - 19; i++) if (sigF6(c, i)) {
      const p = pf(c, i); const inb = Number.isNaN(lo) ? p == null : p != null && p > lo && p <= hi; if (!inb) continue;
      const r = b[i + 18].close / b[i + 1].open - 1; (b[i].ts < SPLIT ? is : oos).push(r); } }
    console.log(`  ${lab.padEnd(9)} IS n=${String(is.length).padStart(4)} ${(100 * mean(is)).toFixed(2).padStart(6)}%   OOS n=${String(oos.length).padStart(4)} ${(100 * mean(oos)).toFixed(2).padStart(6)}%`);
  }
  console.log(HEAD);
  report('F7 기준', sigF6, F7);
  report('F7 · 자기백분위 > 0.8 만', (c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p != null && p > 0.8; }, F7);
  report('F7 · 자기백분위 > 0.95 만', (c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p != null && p > 0.95; }, F7);
  process.exit(0);
}
if (process.argv[2] === 'robust2') {
  const pf = (c: string, i: number) => pctOwn(c, bt(c, i) + FOUR);
  const th = 0.95;
  let tot = 0, skip = 0;
  for (const c of BARS.keys()) { const b = BARS.get(c)!; for (let i = 50; i < b.length; i++) if (sigF6(c, i)) { tot++; const p = pf(c, i); if (p != null && p > th) skip++; } }
  const rate = skip / tot; console.log(`th=0.95 스킵 ${(100 * rate).toFixed(1)}%`);
  const filt = (c: string, i: number) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p == null || p <= th; };
  const res: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const h = (c: string, i: number) => { let x = (seed * 2654435761 ^ (i * 40503) ^ (c.charCodeAt(0) * 9973 + c.length * 31 + c.charCodeAt(c.length - 1) * 7)) >>> 0; x = (x * 1103515245 + 12345) >>> 0; return (x % 10000) / 10000; };
    const g = (c: string, i: number) => sigF6(c, i) && h(c, i) >= rate;
    res.push(run(g, F7, eqRisk(g, F7)).ret);
  }
  res.sort((a, b) => a - b);
  console.log(`플라시보 MDD17 40회: 중앙 ${res[20].toFixed(0)}%, 90분위 ${res[36].toFixed(0)}%, 최대 ${res[39].toFixed(0)}% · 실제 ${run(filt, F7, eqRisk(filt, F7)).ret.toFixed(0)}%`);
  // 코인 순서 민감도 — 동시 신호 선택 운
  const base = [...BARS.keys()];
  const orders: Array<[string, string[]]> = [['기본', base], ['역순', [...base].reverse()], ['알파벳', [...base].sort()], ['셔플7', base.map((c, i) => [c, (i * 7) % base.length] as [string, number]).sort((a, b) => a[1] - b[1]).map(x => x[0])], ['셔플11', base.map((c, i) => [c, (i * 11) % base.length] as [string, number]).sort((a, b) => a[1] - b[1]).map(x => x[0])]];
  for (const [lab, o] of orders) {
    const ord = () => o;
    const a = run(sigF6, F7, 0.33, 0, Infinity, 3, 0, ord), b = run(filt, F7, 0.33, 0, Infinity, 3, 0, ord);
    const ao = run(sigF6, F7, 0.33, SPLIT, Infinity, 3, 0, ord), bo = run(filt, F7, 0.33, SPLIT, Infinity, 3, 0, ord);
    console.log(`  순서 ${lab.padEnd(6)} F7 ${a.ret.toFixed(0)}%/${a.mdd.toFixed(0)}%  필터 ${b.ret.toFixed(0)}%/${b.mdd.toFixed(0)}%   OOS F7 ${ao.ret.toFixed(0)}%/${ao.mdd.toFixed(0)}% 필터 ${bo.ret.toFixed(0)}%/${bo.mdd.toFixed(0)}%`);
  }
  // 신호 단위(포트폴리오 무관) 3일 수익: 스킵된 신호 vs 남은 신호
  const kept: number[] = [], skipped: number[] = [];
  for (const c of BARS.keys()) { const b = BARS.get(c)!; for (let i = 50; i < b.length - 19; i++) if (sigF6(c, i)) { const r = b[i + 18].close / b[i + 1].open - 1; const p = pf(c, i); (p != null && p > th ? skipped : kept).push(r); } }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`  신호 단위 3일 수익: 남김 ${kept.length}건 ${(100 * mean(kept)).toFixed(2)}% / 스킵 ${skipped.length}건 ${(100 * mean(skipped)).toFixed(2)}%`);
  process.exit(0);
}
if (process.argv[2] === 'robust') {
  console.log(HEAD);
  report('F7 기준', sigF6, F7);
  const pf = (c: string, i: number) => pctOwn(c, bt(c, i) + FOUR);
  for (const th of [0.7, 0.8, 0.85, 0.9, 0.95]) report(`F7 · 자기백분위 ≤ ${th}`, (c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p == null || p <= th; }, F7);
  // 스킵 비율 측정 → 같은 비율 무작위 스킵 플라시보
  let tot = 0, skip = 0;
  for (const c of BARS.keys()) { const b = BARS.get(c)!; for (let i = 50; i < b.length; i++) if (sigF6(c, i)) { tot++; const p = pf(c, i); if (p != null && p > 0.9) skip++; } }
  const rate = skip / tot; console.log(`F6 신호 ${tot}건 중 자기백분위>0.9 스킵 ${(100 * rate).toFixed(1)}%`);
  const res: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const h = (c: string, i: number) => { let x = (seed * 2654435761 ^ (i * 40503) ^ (c.charCodeAt(0) * 9973 + c.length * 31 + c.charCodeAt(c.length - 1) * 7)) >>> 0; x = (x * 1103515245 + 12345) >>> 0; return (x % 10000) / 10000; };
    const sz = eqRisk((c, i) => sigF6(c, i) && h(c, i) >= rate, F7); res.push(run((c, i) => sigF6(c, i) && h(c, i) >= rate, F7, sz).ret);
  }
  res.sort((a, b) => a - b);
  console.log(`플라시보(같은 비율 무작위 스킵) MDD17 30회: 중앙 ${res[15].toFixed(0)}%, 90분위 ${res[26].toFixed(0)}%, 최대 ${res[29].toFixed(0)}%`);
  setCost(2); console.log('── 비용 ×2'); report('F7 기준 (비용×2)', sigF6, F7); report('F7 · 자기백분위 ≤ 0.9 (비용×2)', (c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p == null || p <= 0.9; }, F7); setCost(1);
  console.log('── 워크포워드: IS(~2024-07) 에서 임계값 고르고 OOS 적용 (33%×3)');
  let best = { th: 1, v: -1e9 };
  for (const th of [0.7, 0.8, 0.85, 0.9, 0.95, 1.0]) { const v = run((c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p == null || p <= th; }, F7, 0.33, 0, SPLIT).ret; console.log(`  IS th=${th} ${v.toFixed(0)}%`); if (v > best.v) best = { th, v }; }
  const oos = run((c, i) => { if (!sigF6(c, i)) return false; const p = pf(c, i); return p == null || p <= best.th; }, F7, 0.33, SPLIT).ret;
  console.log(`  IS 최적 th=${best.th} → OOS ${oos.toFixed(0)}% vs F7 OOS ${run(sigF6, F7, 0.33, SPLIT).ret.toFixed(0)}%`);
  process.exit(0);
}
console.log(HEAD);
console.log('── 기준선');
report('F7 (F6 신호 · TP6 · 3일)', sigF6, F7);
report('매일 무작위 진입 1.2% (플라시보)', (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff < 0.012; }; })(), F7);
console.log('── (a) 코인 펀딩 극단 (숏 과밀) 롱');
for (const thr of [-0.0003, -0.0005]) for (const d of [F7, { tp: null, maxb: 42 }]) report(`f24 ≤ ${(thr * 100).toFixed(2)}% · ${d.tp ? 'TP6/3일' : '7일 보유'}`, (c, i) => { const v = f24(c, bt(c, i) + FOUR); return v != null && v <= thr; }, d);
report('자기 백분위 ≤ 3% · TP6/3일', (c, i) => { const p = pctOwn(c, bt(c, i) + FOUR); return p != null && p <= 0.03; }, F7);
console.log('── 모멘텀형: 자기 백분위 ≥ 97% (레버리지 롱 쏠림 = 추세 확인?)');
report('자기 백분위 ≥ 97% · TP6/3일', (c, i) => { const p = pctOwn(c, bt(c, i) + FOUR); return p != null && p >= 0.97; }, F7);
report('자기 백분위 ≥ 97% · 7일 보유', (c, i) => { const p = pctOwn(c, bt(c, i) + FOUR); return p != null && p >= 0.97; }, { tp: null, maxb: 42 });
console.log('── (d) F7 + 시장 펀딩 국면 필터');
for (const [lab, ok] of [['시장펀딩 백분위 ≥ 33%', (p: number) => p >= 0.33], ['시장펀딩 백분위 ≥ 50%', (p: number) => p >= 0.5], ['시장펀딩 백분위 ≤ 67%', (p: number) => p <= 0.67], ['시장펀딩 백분위 ≤ 90%', (p: number) => p <= 0.9]] as Array<[string, (p: number) => boolean]>)
  report(`F7 · ${lab}`, (c, i) => { if (!sigF6(c, i)) return false; const p = MKTP.get(bt(c, i)); return p == null || ok(p); }, F7);
report('F7 · 코인 f24 ≤ 0.03% (과열 회피)', (c, i) => sigF6(c, i) && (f24(c, bt(c, i) + FOUR) ?? 0) <= 0.0003, F7);
report('F7 · 코인 자기백분위 ≤ 90% (과열 회피)', (c, i) => { if (!sigF6(c, i)) return false; const p = pctOwn(c, bt(c, i) + FOUR); return p == null || p <= 0.9; }, F7);
