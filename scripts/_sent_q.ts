/**
 * 축 Q 파트1 (2026-10-02) — 심리 지표가 BTC_TREND 의 보조(진입·청산·사이징) 또는 단독 전략으로 이득을 주나.
 * 지표: 공포탐욕(alternative.me, 2018-02~), 업비트 원화 총거래대금 z(국내 과열), 김프(BTC, 2022-06~), 바이낸스 BTC 펀딩.
 * 시각 규약: 업비트 일봉 i 는 UTC 00:00 시작(KST 09). 판단 = i 종가(다음날 UTC 00:00) 직후, 체결 = i+1 시가.
 *   공포탐욕 날짜 D 값은 D 00:00 UTC 게시 → i+1 시가 시점에 막 나오므로 **보수적으로 하루 늦춘 값(i 날짜 값)** 을 쓴다.
 * 비용: 전환당 0.10%(수수료 0.05 + 슬리피지 0.05). 사이징 변경 시 변경분 × 0.10%.
 * 실행: npx tsx scripts/_sent_q.ts [main|wf|placebo|alone]
 */
import fs from 'fs';
import path from 'path';
const R = (p: string) => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), p), 'utf8'));
const DAY = 86400e3;
const b: any[] = R('data/research-ext/daily/KRW-BTC.json');
const fngRaw: any[] = R('data/research-ext/sentiment/fng.json').data;
const FNG = new Map<number, number>(fngRaw.map(x => [Number(x.timestamp) * 1000, Number(x.value)]));
// 국내 원화 총거래대금 (스테이블 제외 전 종목)
const STABLE = /USDT|USDC|DAI|TUSD|USDS|USD1|PYUSD|USDE/;
const VAL = new Map<number, number>();
for (const f of fs.readdirSync('data/research-ext/daily')) {
  if (!f.startsWith('KRW-') || STABLE.test(f)) continue;
  for (const x of R('data/research-ext/daily/' + f)) VAL.set(x.ts, (VAL.get(x.ts) || 0) + (x.value || 0));
}
// 김프: 업비트 BTC 일봉 종가(다음날 UTC00 직전) vs 바이낸스 BTC 4h 중 UTC20 봉 종가 × 환율(전일 고시)
const bn: any[] = R('data/research-ext/binance-BTC_240m.json');
const bnClose = new Map<number, number>(); for (const x of bn) if (new Date(x.ts).getUTCHours() === 20) bnClose.set(x.ts - 20 * 3600e3, x.close);
const fxRaw = R('data/research-ext/fx-usdkrw.json'); const fx: [string, number][] = (Array.isArray(fxRaw) ? fxRaw : Object.entries(fxRaw)).sort((a: any, z: any) => a[0] < z[0] ? -1 : 1) as any;
const fxAt = (ts: number) => { let v: number | null = null; const d = new Date(ts - DAY).toISOString().slice(0, 10); for (const [k, x] of fx) { if (k <= d) v = x; else break; } return v; };
// 펀딩: 그 날(UTC) 마지막 정산까지 평균
const fund: [number, number][] = R('data/research-ext/binance/funding/BTC.json');
const FUND = new Map<number, number[]>(); for (const [t, r] of fund) { const d = Math.floor(t / DAY) * DAY; if (!FUND.has(d)) FUND.set(d, []); FUND.get(d)!.push(r); }

interface Day { ts: number; open: number; close: number; sma50: number; fng: number | null; valZ: number | null; kimp: number | null; fund: number | null }
const days: Day[] = [];
for (let i = 0; i < b.length; i++) {
  let sma50 = NaN; if (i >= 49) { let s = 0; for (let j = i - 49; j <= i; j++) s += b[j].close; sma50 = s / 50; }
  let valZ: number | null = null;
  if (i >= 60) { const v = (k: number) => VAL.get(b[k].ts) || 0; const w: number[] = []; for (let j = i - 60; j < i; j++) w.push(Math.log(v(j) + 1)); const m = w.reduce((a, x) => a + x, 0) / w.length; const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / w.length); valZ = sd > 0 ? (Math.log(v(i) + 1) - m) / sd : null; }
  const bc = bnClose.get(b[i].ts), fxv = fxAt(b[i].ts + DAY);
  const kimp = bc && fxv ? b[i].close / (bc * fxv) - 1 : null;
  const fr = FUND.get(b[i].ts); const fundv = fr ? fr.reduce((a, x) => a + x, 0) / fr.length : null;
  days.push({ ts: b[i].ts, open: b[i].open, close: b[i].close, sma50, fng: FNG.get(b[i].ts) ?? null, valZ, kimp, fund: fundv });
}
const COST = 0.001;
/** policy(i) → 목표 노출(0~1). i 종가에서 판단, i+1 시가~종가 + 지속 시 갭 수익. */
type Pol = (i: number) => number;
function run(pol: Pol, from = Date.UTC(2018, 2, 1), to = Infinity, cm = 1) {
  const out: { ts: number; r: number; x: number }[] = []; let x = 0;
  for (let i = 60; i < days.length - 1; i++) {
    if (days[i + 1].ts < from || days[i + 1].ts > to) { x = pol(i); continue; }
    const want = Math.max(0, Math.min(1, pol(i)));
    let r = -Math.abs(want - x) * COST * cm;
    const prev = x; x = want;
    r += x * (days[i + 1].close / days[i + 1].open - 1) + Math.min(prev, x) * (days[i + 1].open / days[i].close - 1);
    out.push({ ts: days[i + 1].ts, r, x });
  }
  return out;
}
const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[], T = 17) => { const s = st(rs); if (s.mdd <= T) { let lo = 1, hi = 1; return { f: 1, ...s }; } let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > T) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const P = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const YRS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const show = (lab: string, rs: { ts: number; r: number; x: number }[]) => {
  const s = st(rs), e = eq(rs);
  const yr = YRS.map(y => P(st(rs.filter(z => new Date(z.ts).getUTCFullYear() === y), e.f).ret).padStart(6)).join('');
  const exp = rs.reduce((a, z) => a + z.x, 0) / rs.length;
  console.log(`${lab.padEnd(34)} ${P(s.ret).padStart(8)} MDD${s.mdd.toFixed(0).padStart(3)}% 노출${(exp * 100).toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(6)} |${yr}`);
  return e.ret;
};
const trend: Pol = i => days[i].close > days[i].sma50 ? 1 : 0;
const F = (i: number) => days[i - 1]?.fng ?? days[i].fng;   // 하루 늦춘 공포탐욕(보수)
const pols: Record<string, Pol> = {
  'BTC 보유': () => 1,
  'BTC_TREND (기준)': trend,
  '추세 + 탐욕≥80 이면 현금': i => trend(i) && !((F(i) ?? 50) >= 80) ? 1 : 0,
  '추세 + 탐욕≥75 이면 절반': i => trend(i) * ((F(i) ?? 50) >= 75 ? 0.5 : 1),
  '추세 + 공포≤20 이면 추세OFF여도 보유': i => trend(i) || (F(i) ?? 50) <= 20 ? 1 : 0,
  '추세 + 공포≤25 이면 추세OFF여도 절반': i => trend(i) ? 1 : (F(i) ?? 50) <= 25 ? 0.5 : 0,
  '추세 + 국내과열 valZ≥2 이면 현금': i => trend(i) && !((days[i].valZ ?? 0) >= 2) ? 1 : 0,
  '추세 + 국내과열 valZ≥2.5 이면 현금': i => trend(i) && !((days[i].valZ ?? 0) >= 2.5) ? 1 : 0,
  '추세 + 김프≥3% 이면 현금': i => trend(i) && !((days[i].kimp ?? 0) >= 0.03) ? 1 : 0,
  '추세 + 펀딩≥0.03%/8h 이면 현금': i => trend(i) && !((days[i].fund ?? 0) >= 0.0003) ? 1 : 0,
};
const alone: Record<string, Pol> = {};
for (const th of [10, 15, 20, 25]) for (const ex of [50, 60]) {
  // 극단 공포 진입 → 공포탐욕이 ex 이상 회복 시 청산 (상태 보존)
  let hold = false, lastI = -1;
  alone[`단독: 공포≤${th} 매수 → ≥${ex} 매도`] = (i: number) => { if (i <= lastI) hold = false; lastI = i; const f = F(i) ?? 50; if (!hold && f <= th) hold = true; else if (hold && f >= ex) hold = false; return hold ? 1 : 0; };
}
const mode = process.argv[2] || 'main';
console.log(`데이터: 업비트 BTC 일봉 ${days.length}개, 공포탐욕 ${FNG.size}일, 김프 ${days.filter(d => d.kimp != null).length}일, 펀딩 ${days.filter(d => d.fund != null).length}일`);
console.log('설정'.padEnd(34) + '     총익   MDD    노출  | 동일위험17% |' + YRS.map(y => String(y).padStart(6)).join(''));
if (mode === 'main') {
  for (const [k, p] of Object.entries(pols)) show(k, run(p));
  console.log('── 단독 공포 매수 ──');
  for (const [k, p] of Object.entries(alone)) show(k, run(p));
  console.log('── 김프·펀딩 가능 기간(2022-07~)만 ──');
  for (const k of ['BTC_TREND (기준)', '추세 + 김프≥3% 이면 현금', '추세 + 펀딩≥0.03%/8h 이면 현금', '추세 + 탐욕≥80 이면 현금']) show(k, run(pols[k], Date.UTC(2022, 6, 1)));
}
if (mode === 'wf') {
  const MID = Date.UTC(2022, 5, 1);
  const grid: Array<[string, (t: number) => Pol]> = [
    ['탐욕≥t 현금', t => i => trend(i) && !((F(i) ?? 50) >= t) ? 1 : 0],
    ['공포≤t 추세OFF여도 보유', t => i => trend(i) || (F(i) ?? 50) <= t ? 1 : 0],
  ];
  for (const [lab, mk] of grid) {
    const ths = lab.startsWith('탐욕') ? [70, 75, 80, 85, 90] : [10, 15, 20, 25, 30];
    const base = { is: eq(run(trend, Date.UTC(2018, 2, 1), MID)).ret, oos: eq(run(trend, MID)).ret };
    console.log(`\n${lab}: 기준 IS ${P(base.is)} / OOS ${P(base.oos)}`);
    for (const t of ths) console.log(`  t=${t}  IS ${P(eq(run(mk(t), Date.UTC(2018, 2, 1), MID)).ret).padStart(6)}  OOS ${P(eq(run(mk(t), MID)).ret).padStart(6)}  비용×2 ${P(eq(run(mk(t), Date.UTC(2018, 2, 1), Infinity, 2)).ret).padStart(6)}`);
  }
}
if (mode === 'placebo') {
  // 같은 비율의 날을 '덮어쓰기' — 실제 필터가 걸린 날 수와 같은 개수의 무작위 블록(실제 런 길이 분포 유지)
  const which: Array<[string, (i: number) => boolean, 'off' | 'on']> = [
    ['탐욕≥80 현금', i => (F(i) ?? 50) >= 80, 'off'],
    ['공포≤20 보유', i => (F(i) ?? 50) <= 20, 'on'],
    ['국내과열 valZ≥2 현금', i => (days[i].valZ ?? 0) >= 2, 'off'],
  ];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const [lab, cond, kind] of which) {
    const mask = days.map((_, i) => i >= 1 && cond(i));
    const runs: number[] = []; let c = 0; for (const m of mask) { if (m) c++; else if (c) { runs.push(c); c = 0; } } if (c) runs.push(c);
    const real = eq(run(i => kind === 'off' ? (trend(i) && !mask[i] ? 1 : 0) : (trend(i) || mask[i] ? 1 : 0))).ret;
    const sims: number[] = [];
    for (let s = 0; s < 40; s++) {
      const m2 = new Array(days.length).fill(false);
      for (const L of runs) { const st0 = 60 + Math.floor(rnd() * (days.length - 61 - L)); for (let k = 0; k < L; k++) m2[st0 + k] = true; }
      sims.push(eq(run(i => kind === 'off' ? (trend(i) && !m2[i] ? 1 : 0) : (trend(i) || m2[i] ? 1 : 0))).ret);
    }
    sims.sort((a, z) => a - z);
    console.log(`${lab}: 실제 ${P(real)} · 플라시보 중앙 ${P(sims[20])} 최대 ${P(sims[39])} · 넘은 수 ${sims.filter(v => v >= real).length}/40 (필터일 ${mask.filter(Boolean).length}일, 런 ${runs.length}개)`);
  }
}
if (mode === 'kimp') {
  const K0 = Date.UTC(2022, 6, 1), MID = Date.UTC(2024, 7, 1);
  const pk = (t: number): Pol => i => trend(i) && !((days[i].kimp ?? 0) >= t) ? 1 : 0;
  const kd = days.filter(d => d.kimp != null).map(d => d.kimp!).sort((a, z) => a - z);
  console.log(`김프 분포(2022-07~): p10 ${(kd[Math.floor(kd.length * .1)] * 100).toFixed(2)}% p50 ${(kd[Math.floor(kd.length * .5)] * 100).toFixed(2)}% p90 ${(kd[Math.floor(kd.length * .9)] * 100).toFixed(2)}% max ${(kd[kd.length - 1] * 100).toFixed(2)}%`);
  const base = (a: number, z = Infinity, cm = 1) => eq(run(trend, a, z, cm)).ret;
  console.log(`기준 BTC_TREND: 전체 ${P(base(K0))} · 앞(~2024-07) ${P(base(K0, MID))} · 뒤 ${P(base(MID))} · 비용×2 ${P(base(K0, Infinity, 2))}`);
  for (const t of [0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05]) {
    const days0 = days.filter(d => d.ts >= K0 && (d.kimp ?? 0) >= t).length;
    console.log(`  김프≥${(t * 100).toFixed(1)}% 현금  전체 ${P(eq(run(pk(t), K0)).ret).padStart(6)}  앞 ${P(eq(run(pk(t), K0, MID)).ret).padStart(6)}  뒤 ${P(eq(run(pk(t), MID)).ret).padStart(6)}  비용×2 ${P(eq(run(pk(t), K0, Infinity, 2)).ret).padStart(6)}  지연1일 ${P(eq(run(i => pk(t)(i - 1) && trend(i) ? 1 : 0, K0)).ret).padStart(6)}  걸린날 ${days0}`);
  }
  // 플라시보: 김프≥3% 날과 같은 런 길이 분포로 무작위 블록
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const i0 = days.findIndex(d => d.ts >= K0);
  const mask = days.map(d => (d.kimp ?? 0) >= 0.03);
  const runs: number[] = []; let c = 0; for (let i = i0; i < days.length; i++) { if (mask[i]) c++; else if (c) { runs.push(c); c = 0; } } if (c) runs.push(c);
  const real = eq(run(pk(0.03), K0)).ret; const sims: number[] = [];
  for (let s = 0; s < 40; s++) { const m2 = new Array(days.length).fill(false); for (const L of runs) { const a = i0 + Math.floor(rnd() * (days.length - i0 - L - 1)); for (let k = 0; k < L; k++) m2[a + k] = true; } sims.push(eq(run(i => trend(i) && !m2[i] ? 1 : 0, K0)).ret); }
  sims.sort((a, z) => a - z);
  console.log(`플라시보(김프≥3%와 같은 런 ${runs.length}개·${mask.slice(i0).filter(Boolean).length}일): 실제 ${P(real)} · 중앙 ${P(sims[20])} · 최대 ${P(sims[39])} · 넘은 수 ${sims.filter(v => v >= real).length}/40`);
  // 걸린 날의 다음 N일 BTC 수익(추세 ON 중) — 메커니즘
  const fw = (n: number, sel: (i: number) => boolean) => { const xs: number[] = []; for (let i = i0; i < days.length - n; i++) if (trend(i) && sel(i)) xs.push(days[i + n].close / days[i].close - 1); return xs.length ? `${(100 * xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(2)}% (n=${xs.length})` : '-'; };
  console.log(`추세 ON 중 다음 7일 BTC 수익: 김프≥3% ${fw(7, i => (days[i].kimp ?? 0) >= 0.03)} · 그 외 ${fw(7, i => (days[i].kimp ?? 0) < 0.03)}`);
}
