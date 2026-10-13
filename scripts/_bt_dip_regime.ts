/**
 * 국면 배분 레이어 (2026-10-13, 축 regime) — 2단계: 국면 판정자 × 비중표 × 반증.
 *
 * 질문: 새 신호 없이, 기존 함대(추세 3종·F7 2종·ALT_SWING·USDT_Z·BTC_DIP)를 BTC 국면에 따라 다르게 태우면
 *       횡보·하락장 손실이 줄고 위험조정 수익이 느는가.
 *
 * 포트폴리오 = Σ w_i(t) · r_i(t)  (r_i = 각 전략이 자기 자본 100% 기준으로 낸 일수익, series.json)
 *   - 비중 변경 비용: c × Σ|Δw| (c = 0.10%, 비용×2 에서 0.20%) — 줄이는 쪽 매도 + 늘리는 쪽 매수를 모두 시장가로 본 보수적 근사.
 *   - BTC_DIP/USDT_Z 에 비중을 더 주는 것 = 같은 신호에 더 큰 주문. 일수익 선형 확대 = 지정가 체결량·호가 영향 0 가정(⚠ 한계).
 *   - 비중 변경이 '보유 중 포지션을 즉시 줄이고 늘리는' 것으로 계산됨(실제 운영은 신규 진입 크기만 바꿀 것) → 3일 지연 시험이 이 차이의 근사.
 * 국면 라벨: BTC 일봉(UTC 00:00 = KST 09:00 경계). 판정은 k일 종가까지의 정보, t일 비중에 쓰는 건 k = t−1−L (L = 판정 지연, 기본 1일).
 * 출력: data/research-ext/dip-2026-10/regime/{report.log, results.json}
 */
import fs from 'fs';
import path from 'path';

const DAY = 86400e3, FOUR = 4 * 3600e3;
const DIRO = path.resolve(process.cwd(), 'data/research-ext/dip-2026-10/regime');
const S = JSON.parse(fs.readFileSync(path.join(DIRO, 'series.json'), 'utf8')) as { base: Record<string, [number, number][]>; c2: Record<string, [number, number][]>; expo: Record<string, [number, number][]> };
const OUTL: string[] = []; const log = (...a: unknown[]) => { const s = a.join(' '); OUTL.push(s); console.log(s); };
const P = (x: number, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
const Y = (y: number, m = 0, d = 1) => Date.UTC(y, m, d);
const END = Y(2026, 9, 1);   // 마지막 일 = 2026-09-30 (대부분 데이터 2026-10-02 06시까지, 10-01 은 일부 전략 미완)

// ── BTC 일봉: 일봉 파일(완성봉) + 4h 캐시로 10-12 까지 연장 ──
interface DB { ts: number; open: number; high: number; low: number; close: number }
const bd: DB[] = (JSON.parse(fs.readFileSync('data/research-ext/daily/KRW-BTC.json', 'utf8')) as DB[]).filter(x => x.ts < Y(2026, 9, 2)).sort((a, b) => a.ts - b.ts);
{
  const b4 = (JSON.parse(fs.readFileSync('data/candle-cache/KRW-BTC_240m_2022-06-10_2026-10-13.json', 'utf8')) as DB[]).sort((a, b) => a.ts - b.ts); b4.pop(); // 진행 중 봉 제외
  const agg = new Map<number, DB & { n: number }>();
  for (const x of b4) { const d = Math.floor(x.ts / DAY) * DAY; const g = agg.get(d); if (!g) agg.set(d, { ts: d, open: x.open, high: x.high, low: x.low, close: x.close, n: 1 }); else { g.high = Math.max(g.high, x.high); g.low = Math.min(g.low, x.low); g.close = x.close; g.n++; } }
  const chk = agg.get(Y(2026, 8, 15)); const ref = bd.find(x => x.ts === Y(2026, 8, 15));
  log(`[검산] 2026-09-15 BTC 종가 일봉파일 ${ref?.close} vs 4h합성 ${chk?.close}`);
  for (const [d, g] of [...agg].sort((a, b) => a[0] - b[0])) if (d >= Y(2026, 9, 1) && g.n === 6 && !bd.some(x => x.ts === d && d < Y(2026, 9, 1))) { const i = bd.findIndex(x => x.ts === d); if (i >= 0) bd[i] = g; else bd.push(g); }
  bd.sort((a, b) => a.ts - b.ts);
}
const BI = new Map(bd.map((x, i) => [x.ts, i]));
const N = bd.length; const C = bd.map(x => x.close);
// 특성 (k 일 종가까지)
const F = {
  r: (k: number, n: number) => (k >= n ? C[k] / C[k - n] - 1 : NaN),
  sma: (k: number, n: number) => { if (k < n - 1) return NaN; let s = 0; for (let j = k - n + 1; j <= k; j++) s += C[j]; return s / n; },
};
const sma50 = C.map((_, k) => F.sma(k, 50));
const slope50 = C.map((_, k) => (k >= 60 ? sma50[k] / sma50[k - 10] - 1 : NaN));
const box20 = C.map((_, k) => { if (k < 19) return NaN; let hi = -Infinity, lo = Infinity; for (let j = k - 19; j <= k; j++) { hi = Math.max(hi, bd[j].high); lo = Math.min(lo, bd[j].low); } return (hi - lo) / C[k]; });
const up20 = C.map((_, k) => { if (k < 20) return NaN; let u = 0; for (let j = k - 19; j <= k; j++) if (C[j] > C[j - 1]) u++; return u / 20; });
const rv20 = C.map((_, k) => { if (k < 20) return NaN; let s = 0, s2 = 0; for (let j = k - 19; j <= k; j++) { const r = Math.log(C[j] / C[j - 1]); s += r; s2 += r * r; } const m = s / 20; return Math.sqrt(Math.max(s2 / 20 - m * m, 0) * 365); });
const rvRank = C.map((_, k) => { if (k < 385) return NaN; const w = rv20.slice(k - 364, k + 1).filter(x => !Number.isNaN(x)); return w.filter(x => x < rv20[k]).length / w.length; });   // 직전 1년 중 백분위
// ADX14 (Wilder)
const adx: number[] = new Array(N).fill(NaN), pdi: number[] = new Array(N).fill(NaN), mdi: number[] = new Array(N).fill(NaN);
{ let tr = 0, pd = 0, md = 0, ax = 0; const n = 14;
  for (let k = 1; k < N; k++) {
    const h = bd[k].high, l = bd[k].low, pc = C[k - 1], ph = bd[k - 1].high, pl = bd[k - 1].low;
    const TR = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); const up = h - ph, dn = pl - l;
    const PD = up > dn && up > 0 ? up : 0, MD = dn > up && dn > 0 ? dn : 0;
    if (k <= n) { tr += TR; pd += PD; md += MD; continue; }
    tr = tr - tr / n + TR; pd = pd - pd / n + PD; md = md - md / n + MD;
    const p = 100 * pd / tr, m = 100 * md / tr; const dx = 100 * Math.abs(p - m) / Math.max(p + m, 1e-9);
    ax = k < 2 * n ? ax + dx / n : (ax * (n - 1) + dx) / n; if (k >= 2 * n) { adx[k] = ax; pdi[k] = p; mdi[k] = m; }
  } }

// ── 국면 판정자: true = '비상승(축소)' ──
type Clf = { id: string; desc: string; f: (k: number, p: number) => boolean | null; grid: number[]; p0: number };
const CLF: Clf[] = [
  { id: 'R20', desc: 'BTC 20일 수익 ≤ p%', f: (k, p) => { const v = F.r(k, 20); return Number.isNaN(v) ? null : v <= p / 100; }, grid: [-2, 0, 2, 4, 6], p0: 2 },
  { id: 'R11', desc: 'BTC 11일 수익 ≤ p%', f: (k, p) => { const v = F.r(k, 11); return Number.isNaN(v) ? null : v <= p / 100; }, grid: [-2, 0, 2, 4, 6], p0: 2 },
  { id: 'SMA50', desc: 'BTC 종가 < SMA50×(1+p%)', f: (k, p) => (Number.isNaN(sma50[k]) ? null : C[k] < sma50[k] * (1 + p / 100)), grid: [-2, 0, 2, 4, 6], p0: 0 },
  { id: 'BRIEF', desc: '(a)∪(b): 종가<SMA50 또는 20일 수익 ≤ p%', f: (k, p) => { const v = F.r(k, 20); return Number.isNaN(v) || Number.isNaN(sma50[k]) ? null : C[k] < sma50[k] || v <= p / 100; }, grid: [-2, 0, 2, 4, 6], p0: 2 },
  { id: 'SLOPE', desc: 'SMA50 10일 기울기 ≤ p%', f: (k, p) => (Number.isNaN(slope50[k]) ? null : slope50[k] <= p / 100), grid: [-2, -1, 0, 1, 2], p0: 0 },
  { id: 'ADX', desc: '¬(ADX14 ≥ p 且 +DI>−DI)', f: (k, p) => (Number.isNaN(adx[k]) ? null : !(adx[k] >= p && pdi[k] > mdi[k])), grid: [10, 15, 20, 25, 30], p0: 20 },
  { id: 'BOX', desc: '20일 박스폭 ≤ p%', f: (k, p) => (Number.isNaN(box20[k]) ? null : box20[k] <= p / 100), grid: [8, 10, 12, 15, 20], p0: 12 },
  { id: 'UP', desc: '20일 상승일 비율 < p', f: (k, p) => (Number.isNaN(up20[k]) ? null : up20[k] < p), grid: [0.4, 0.45, 0.5, 0.55, 0.6], p0: 0.5 },
  { id: 'RVHI', desc: '20일 실현변동성 1년 백분위 > p', f: (k, p) => (Number.isNaN(rvRank[k]) ? null : rvRank[k] > p), grid: [0.3, 0.4, 0.5, 0.6, 0.7], p0: 0.5 },
];

// ── 전략 묶음 ──
const TREND = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND'], F7 = ['F7_sl', 'F7_btc'], SWING = ['ALT_SWING'];
const toMap = (a: [number, number][]) => new Map(a.map(([t, r]) => [t, r]));
const BASE = Object.fromEntries(Object.entries(S.base).map(([k, v]) => [k, toMap(v)]));
const C2 = Object.fromEntries(Object.entries(S.c2).map(([k, v]) => [k, toMap(v)]));
// 검산: daily-series.json 과 비교
{ const ds = JSON.parse(fs.readFileSync('data/research-ext/final/daily-series.json', 'utf8')) as Record<string, [number, number][]>;
  for (const id of ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP']) { let mx = 0, n = 0; for (const [t, r] of ds[id]) { if (t >= END) continue; const v = BASE[id].get(t); if (v == null) continue; mx = Math.max(mx, Math.abs(v - r)); n++; } log(`[검산] ${id} daily-series.json 대비 최대 차 ${mx.toExponential(1)} (${n}일)`); }
  const f7old = toMap(ds['F7_sl*']); const a: number[] = [], b: number[] = []; for (const [t, r] of f7old) if (BASE.F7_sl.has(t) && t < END) { a.push(r); b.push(BASE.F7_sl.get(t)!); }
  log(`[검산] 새 F7_sl(33%×3·관통0.2%·스프레드) vs 기존 F7_sl*(MDD17·배분포크) 일수익 상관 ${corr(a, b).toFixed(2)} (${a.length}일)`); }

function corr(a: number[], b: number[]) { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); }
function metrics(rs: number[], f = 1) {
  let e = 1, pk = 1, mdd = 0, s = 0, s2 = 0;
  for (const r0 of rs) { const r = f * r0; e *= 1 + r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); s += r; s2 += r * r; }
  const n = rs.length, mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-14));
  return { tot: 100 * (e - 1), cagr: 100 * (Math.pow(e, 365 / n) - 1), mdd: 100 * mdd, sh: (mu / sd) * Math.sqrt(365) };
}
const scaleTo = (rs: number[], tgt: number) => { if (metrics(rs).mdd <= tgt) return 1; let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (metrics(rs, m).mdd > tgt) hi = m; else lo = m; } return lo; };

// ── 창 ──
interface Win { id: string; a: number; b: number; ids: string[]; neutral: string[] }
const WINS: Win[] = [
  { id: 'LONG 2022-07~ (USDT_Z 없음, 7전략)', a: Y(2022, 6, 1), b: END, ids: ['BTC_DIP', 'ALT_SWING', ...TREND, ...F7], neutral: ['BTC_DIP'] },
  { id: 'MID 2024-08~ (함대 8전략 전부)', a: Y(2024, 7, 1), b: END, ids: ['USDT_Z', 'BTC_DIP', 'ALT_SWING', ...TREND, ...F7], neutral: ['USDT_Z', 'BTC_DIP'] },
];
const daysOf = (w: Win) => { const out: number[] = []; for (let t = w.a; t < w.b; t += DAY) if (w.ids.every(id => BASE[id].has(t)) && BI.has(t - DAY)) out.push(t); return out; };

// ── 규칙 ──
type Rule = 'BASE' | 'CASH' | 'NEUT' | 'F7NEUT' | 'F7CASH';
const RULES: Rule[] = ['CASH', 'NEUT', 'F7NEUT'];
const RLAB: Record<Rule, string> = { BASE: '균등(현행)', CASH: '비상승→추세·F7 ×k, 나머지 현금', NEUT: '비상승→추세·F7 ×k, 그 자본을 DIP/USDT 증액', F7NEUT: '비상승→F7 만 ×k, 그 자본을 DIP/USDT 증액', F7CASH: '비상승→F7 만 ×k, 현금' };
function weights(w: Win, rule: Rule, shrink: boolean, k: number): Record<string, number> {
  const n = w.ids.length; const W: Record<string, number> = Object.fromEntries(w.ids.map(id => [id, 1 / n]));
  if (rule === 'BASE' || !shrink) return W;
  const cut = rule === 'F7NEUT' || rule === 'F7CASH' ? F7 : [...TREND, ...F7];
  let freed = 0; for (const id of cut) { freed += W[id] * (1 - k); W[id] *= k; }
  if (rule === 'NEUT' || rule === 'F7NEUT') for (const id of w.neutral) W[id] += freed / w.neutral.length;
  return W;
}
interface Opt { clf: Clf; p: number; rule: Rule; k: number; lag: number; cost: number; c2?: boolean; flagOverride?: (t: number) => boolean; staticW?: Record<string, number> }
function flagAt(clf: Clf, p: number, t: number, lag: number): boolean { const k = BI.get(t - DAY * (1 + lag)); if (k === undefined) return false; return clf.f(k, p) ?? false; }
function sim(w: Win, days: number[], o: Opt) {
  const src = o.c2 ? C2 : BASE; const rs: number[] = []; let prev: Record<string, number> | null = null, turn = 0, sw = 0, shrDays = 0; const wsum: Record<string, number> = {};
  let lastFlag: boolean | null = null;
  for (const t of days) {
    const fl = o.flagOverride ? o.flagOverride(t) : flagAt(o.clf, o.p, t, o.lag);
    if (lastFlag !== null && fl !== lastFlag) sw++; lastFlag = fl; if (fl) shrDays++;
    const W = o.staticW ?? weights(w, o.rule, fl, o.k);
    let r = 0; for (const id of w.ids) r += W[id] * src[id].get(t)!;
    if (prev) { let d = 0; for (const id of w.ids) d += Math.abs(W[id] - prev[id]); r -= d * o.cost; turn += d; }
    prev = W; rs.push(r); for (const id of w.ids) wsum[id] = (wsum[id] ?? 0) + W[id] / days.length;
  }
  return { rs, sw: sw / (days.length / 365), shr: shrDays / days.length, wavg: wsum, turn };
}
const lab3 = (t: number) => { const k = BI.get(t)!; if (C[k] < sma50[k]) return 'a'; return F.r(k, 20) <= 0.02 ? 'b' : 'c'; };   // 그날 자기 종가 기준 (보고용)
function regimeSplit(days: number[], rs: number[]) { const o: Record<string, { n: number; s: number; e: number }> = { a: { n: 0, s: 0, e: 1 }, b: { n: 0, s: 0, e: 1 }, c: { n: 0, s: 0, e: 1 } };
  days.forEach((t, i) => { const g = o[lab3(t)]; g.n++; g.s += rs[i]; g.e *= 1 + rs[i]; }); return o; }
const SPL: Array<[string, number, number]> = [['22H2', Y(2022, 6), Y(2023)], ['2023', Y(2023), Y(2024)], ['24H1', Y(2024), Y(2024, 6)], ['24H2', Y(2024, 6), Y(2025)], ['2025', Y(2025), Y(2026)], ['26YTD', Y(2026), END]];
const splitTot = (days: number[], rs: number[]) => SPL.map(([, a, b]) => { const x = rs.filter((_, i) => days[i] >= a && days[i] < b); return x.length > 20 ? metrics(x).tot : NaN; });
const R: Record<string, unknown> = {};

for (const w of WINS) {
  const days = daysOf(w);
  log(`\n════════════════ ${w.id}: ${new Date(days[0]).toISOString().slice(0, 10)} ~ ${new Date(days[days.length - 1]).toISOString().slice(0, 10)} (${days.length}일) ════════════════`);
  const base = sim(w, days, { clf: CLF[0], p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.001 });
  const bm = metrics(base.rs);
  // ── 0. 진단: 판정자 상태별 전략 일수익 평균 (lag 1, 기본 임계) ──
  log(`\n── 0. 진단: 판정자(기본 임계, 판정지연 1일) '비상승' 날 vs '상승' 날의 전략별 일평균(bp) ──`);
  log('판정자'.padEnd(8) + '비상승%'.padStart(7) + ' │ ' + w.ids.map(i => i.slice(0, 9).padStart(10)).join('') + ' │ 함대균등');
  for (const clf of CLF) {
    const fl = days.map(t => flagAt(clf, clf.p0, t, 1)); const on = fl.filter(x => x).length / days.length;
    const m = (id: string | null, v: boolean) => { let s = 0, n = 0; days.forEach((t, i) => { if (fl[i] !== v) return; s += id ? BASE[id].get(t)! : base.rs[i]; n++; }); return n ? 1e4 * s / n : NaN; };
    log(`${clf.id.padEnd(8)}${(100 * on).toFixed(0).padStart(6)}% │ ` + w.ids.map(id => `${m(id, true).toFixed(0)}/${m(id, false).toFixed(0)}`.padStart(10)).join('') + ` │ ${m(null, true).toFixed(1)}/${m(null, false).toFixed(1)}`);
  }
  log('  (각 칸 = 비상승일 평균 / 상승일 평균, bp/일)');
  // 중립 전략 가동: 일수익 ≠ 0 인 날 비율
  for (const id of w.neutral) { const act = days.filter(t => Math.abs(BASE[id].get(t)!) > 1e-9).length / days.length; log(`  ${id} 일수익≠0 인 날(≈포지션 보유) ${(100 * act).toFixed(0)}%`); }

  // ── 1. 기본 규칙 (기본 임계, k=0.5, lag 1) ──
  log(`\n── 1. 규칙 × 판정자 (기본 임계, k=0.5, 판정지연 1일, 전환비용 0.10%/Σ|Δw|) ──`);
  log(`기준 균등: 총익 ${P(bm.tot)} CAGR ${P(bm.cagr)} MDD ${bm.mdd.toFixed(1)}% 샤프 ${bm.sh.toFixed(2)}`);
  log('규칙'.padEnd(8) + '판정자'.padEnd(7) + '   총익   CAGR   MDD  샤프 │ 동일MDD Δ총익 │ 정적통제 샤프 │ 축소일 전환/연 │ 국면 a/b/c 일평균(bp) Δ vs 균등');
  const bReg = regimeSplit(days, base.rs);
  const rows: Array<Record<string, unknown>> = [];
  for (const rule of RULES) for (const clf of CLF) {
    const v = sim(w, days, { clf, p: clf.p0, rule, k: 0.5, lag: 1, cost: 0.001 }); const m = metrics(v.rs);
    const tgt = Math.min(m.mdd, bm.mdd); const fv = scaleTo(v.rs, tgt), fb = scaleTo(base.rs, tgt);
    const dEq = metrics(v.rs, fv).tot - metrics(base.rs, fb).tot;
    const st = sim(w, days, { clf, p: clf.p0, rule: 'BASE', k: 1, lag: 1, cost: 0.001, staticW: v.wavg }); const sm = metrics(st.rs);
    const rg = regimeSplit(days, v.rs);
    const regS = (['a', 'b', 'c'] as const).map(x => (1e4 * (rg[x].s / Math.max(rg[x].n, 1) - bReg[x].s / Math.max(bReg[x].n, 1))).toFixed(1)).join('/');
    log(`${rule.padEnd(8)}${clf.id.padEnd(7)}${P(m.tot).padStart(7)}${P(m.cagr).padStart(7)}${(m.mdd.toFixed(1) + '%').padStart(6)}${m.sh.toFixed(2).padStart(6)} │ ${P(dEq).padStart(8)}     │ ${sm.sh.toFixed(2).padStart(6)}       │ ${(100 * v.shr).toFixed(0).padStart(4)}% ${v.sw.toFixed(1).padStart(5)}  │ ${regS}`);
    rows.push({ rule, clf: clf.id, ...m, dEq, staticSh: sm.sh, shr: v.shr, sw: v.sw });
  }
  log(`  기준 균등 국면 일평균(bp) a/b/c = ${(['a', 'b', 'c'] as const).map(x => (1e4 * bReg[x].s / bReg[x].n).toFixed(1) + `(n${bReg[x].n})`).join(' / ')}`);
  log(`  정적통제 = 규칙의 기간평균 비중을 고정으로 쓴 것(타이밍 없이 '중립 비중만 키운' 효과). 규칙 샤프 − 정적통제 샤프 = 순수 국면 타이밍 기여.`);
  R[w.id + ':rows'] = rows;

  // ── 2. 고원: 임계 × k (규칙 NEUT·CASH·F7NEUT, 판정자별) — 기본칸과 이웃칸 중앙값 ──
  log(`\n── 2. 고원 (Δ샤프 vs 균등, 판정지연 1일) — 행=임계, 열=k {0,0.25,0.5,0.75} ──`);
  const med = (a: number[]) => { const s = a.filter(x => !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const plateau: Record<string, unknown> = {};
  for (const rule of RULES) {
    const line: string[] = [];
    for (const clf of CLF) {
      const ks = [0, 0.25, 0.5, 0.75]; const grid = clf.grid.map(p => ks.map(k => metrics(sim(w, days, { clf, p, rule, k, lag: 1, cost: 0.001 }).rs).sh - bm.sh));
      const pi = clf.grid.indexOf(clf.p0); const nb: number[] = [];
      for (let a = Math.max(0, pi - 1); a <= Math.min(clf.grid.length - 1, pi + 1); a++) for (let b = 1; b <= 3; b++) nb.push(grid[a][b]);   // 이웃: 임계 ±1칸 × k 0.25~0.75
      const all = grid.flat(); const pos = all.filter(x => x > 0).length;
      line.push(`${clf.id}: 기본 ${grid[pi][2].toFixed(2)} · 이웃중앙 ${med(nb).toFixed(2)} · 전칸 양수 ${pos}/${all.length} · 최고 ${Math.max(...all).toFixed(2)}`);
      plateau[`${rule}:${clf.id}`] = { grid, nbMed: med(nb), pos, n: all.length };
    }
    log(`[${rule}] ${RLAB[rule]}`); for (const l of line) log('   ' + l);
  }
  R[w.id + ':plateau'] = plateau;

  // ── 3. 반증 묶음: 대표 3조합 ──
  const REP: Array<[Rule, string]> = [['NEUT', 'BRIEF'], ['NEUT', 'R20'], ['CASH', 'BRIEF'], ['F7NEUT', 'R11'], ['NEUT', 'SMA50'], ['NEUT', 'SLOPE'], ['NEUT', 'RVHI'], ['F7NEUT', 'RVHI'], ['CASH', 'RVHI']];
  log(`\n── 3. 반증 (k=0.5): 지연 0/1/3일 · 비용×2 · 기간분할 Δ총익 · 플라시보(라벨 원형 이동 200회) · 함대 손실일 ──`);
  log('조합'.padEnd(15) + ' Δ샤프 L0    L1    L3 │ 비용×2 Δ샤프 │ 기간분할 Δ총익 ' + SPL.map(s => s[0]).join('/') + ' │ 플라시보 Δ샤프 순위·p95 │ 손실일 평균 균등→규칙(bp) │ 상관');
  const bc2 = metrics(sim(w, days, { clf: CLF[0], p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.002, c2: true }).rs);
  const bSpl = splitTot(days, base.rs);
  const lossIdx = base.rs.map((r, i) => (r < 0 ? i : -1)).filter(i => i >= 0);
  const rep: Record<string, unknown> = {};
  for (const [rule, cid] of REP) {
    const clf = CLF.find(c => c.id === cid)!;
    const dsh = (lag: number) => metrics(sim(w, days, { clf, p: clf.p0, rule, k: 0.5, lag, cost: 0.001 }).rs).sh - bm.sh;
    const v1 = sim(w, days, { clf, p: clf.p0, rule, k: 0.5, lag: 1, cost: 0.001 });
    const c2 = metrics(sim(w, days, { clf, p: clf.p0, rule, k: 0.5, lag: 1, cost: 0.002, c2: true }).rs).sh - bc2.sh;
    const sp = splitTot(days, v1.rs).map((x, i) => (Number.isNaN(x) ? '-' : (x - bSpl[i] >= 0 ? '+' : '') + (x - bSpl[i]).toFixed(1))).join('/');
    // 플라시보: 판정 라벨 시계열을 원형 이동 (빈도·지속성 보존, 시점 정보만 파괴)
    const fl = days.map(t => flagAt(clf, clf.p0, t, 1)); const act = metrics(v1.rs).sh - bm.sh; const pl: number[] = [];
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let s = 0; s < 200; s++) { const off = 60 + Math.floor(rnd() * (days.length - 120)); const idx = new Map(days.map((t, i) => [t, i]));
      pl.push(metrics(sim(w, days, { clf, p: clf.p0, rule, k: 0.5, lag: 1, cost: 0.001, flagOverride: t => fl[(idx.get(t)! + off) % days.length] }).rs).sh - bm.sh); }
    pl.sort((a, b) => a - b); const rank = pl.filter(x => x >= act).length; const p95 = pl[Math.floor(0.95 * pl.length)];
    const lb = 1e4 * lossIdx.reduce((a, i) => a + base.rs[i], 0) / lossIdx.length, lv = 1e4 * lossIdx.reduce((a, i) => a + v1.rs[i], 0) / lossIdx.length;
    log(`${(rule + '·' + cid).padEnd(15)} ${dsh(0).toFixed(2).padStart(5)} ${dsh(1).toFixed(2).padStart(5)} ${dsh(3).toFixed(2).padStart(5)} │ ${c2.toFixed(2).padStart(6)}       │ ${sp} │ ${act.toFixed(2)} 위 ${rank}/200 · p95 ${p95.toFixed(2)} · 중앙 ${pl[100].toFixed(2)} │ ${lb.toFixed(1)}→${lv.toFixed(1)} │ ${corr(base.rs, v1.rs).toFixed(2)}`);
    rep[`${rule}:${cid}`] = { dsh0: dsh(0), dsh1: dsh(1), dsh3: dsh(3), c2, split: sp, placeboRank: rank, p95, lossDayBase: lb, lossDayRule: lv };
  }
  log(`  기준 균등 기간분할 총익: ${SPL.map((s, i) => s[0] + ' ' + (Number.isNaN(bSpl[i]) ? '-' : P(bSpl[i]))).join(' · ')} · 비용×2 샤프 ${bc2.sh.toFixed(2)}`);
  R[w.id + ':robust'] = rep;

  // ── 3b. 정적 통제(타이밍 없이 중립 비중만 키움) 자체의 견고성 ──
  { const clf = CLF.find(c => c.id === 'BRIEF')!; const v = sim(w, days, { clf, p: clf.p0, rule: 'NEUT', k: 0.5, lag: 1, cost: 0.001 });
    const st = sim(w, days, { clf, p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.001, staticW: v.wavg }); const sc2 = sim(w, days, { clf, p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.002, c2: true, staticW: v.wavg });
    const m = metrics(st.rs); const tgt = Math.min(m.mdd, bm.mdd); const dEq = metrics(st.rs, scaleTo(st.rs, tgt)).tot - metrics(base.rs, scaleTo(base.rs, tgt)).tot;
    const sp = splitTot(days, st.rs).map((x, i) => (Number.isNaN(x) ? '-' : (x - bSpl[i] >= 0 ? '+' : '') + (x - bSpl[i]).toFixed(1))).join('/');
    log(`\n── 3b. 정적 통제 = NEUT·BRIEF 의 평균 비중 고정(${w.ids.map(id => id + ' ' + (100 * v.wavg[id]).toFixed(1)).join(' · ')}) ──`);
    log(`  총익 ${P(m.tot)} MDD ${m.mdd.toFixed(1)}% 샤프 ${m.sh.toFixed(2)} (균등 ${bm.sh.toFixed(2)}) · 동일MDD Δ총익 ${P(dEq)} · 비용×2 샤프 ${metrics(sc2.rs).sh.toFixed(2)} (균등 ${bc2.sh.toFixed(2)}) · 기간분할 Δ총익 ${sp}`);
    const rg = regimeSplit(days, st.rs); log(`  국면 a/b/c 일평균(bp) ${(['a', 'b', 'c'] as const).map(x => (1e4 * rg[x].s / rg[x].n).toFixed(1)).join('/')} (균등 ${(['a', 'b', 'c'] as const).map(x => (1e4 * bReg[x].s / bReg[x].n).toFixed(1)).join('/')})`);
    const lv = 1e4 * lossIdx.reduce((a, i) => a + st.rs[i], 0) / lossIdx.length; log(`  함대 손실일 평균 ${(1e4 * lossIdx.reduce((a, i) => a + base.rs[i], 0) / lossIdx.length).toFixed(1)} → ${lv.toFixed(1)}bp`);
    const splitSh = (rs: number[]) => SPL.map(([, a, b]) => { const x = rs.filter((_, i) => days[i] >= a && days[i] < b); return x.length > 20 ? metrics(x).sh : NaN; });
    const bS = splitSh(base.rs); const show = (lab: string, rs: number[]) => log(`  기간별 샤프 ${lab.padEnd(12)} ` + splitSh(rs).map((x, i) => SPL[i][0] + ' ' + (Number.isNaN(x) ? '-' : x.toFixed(2) + '(' + (x - bS[i] >= 0 ? '+' : '') + (x - bS[i]).toFixed(2) + ')')).join(' · '));
    log(`  기간별 샤프 균등         ` + bS.map((x, i) => SPL[i][0] + ' ' + (Number.isNaN(x) ? '-' : x.toFixed(2))).join(' · '));
    show('정적통제', st.rs);
    const rv = CLF.find(c => c.id === 'RVHI')!;
    show('NEUT·RVHI', sim(w, days, { clf: rv, p: rv.p0, rule: 'NEUT', k: 0.5, lag: 1, cost: 0.001 }).rs);
    show('F7NEUT·RVHI', sim(w, days, { clf: rv, p: rv.p0, rule: 'F7NEUT', k: 0.5, lag: 1, cost: 0.001 }).rs);
    show('NEUT·BRIEF', v.rs);
    R[w.id + ':static'] = { ...m, dEq, w: v.wavg }; }

  // ── 3c. 'F7 은 BTC 11일 +2% 초과에서만 번다' — 동시점 라벨 vs 실행가능(지연) 라벨 ──
  { log(`\n── 3c. F7 의 BTC 11일 수익 조건부 일평균(bp): 라벨 시점별 (>+2% / ≤+2%) ──`);
    const lb = (t: number, shift: number) => { const k = BI.get(t + shift * DAY); return k === undefined ? null : F.r(k, 11) > 0.02; };
    for (const [nm, sh] of [['미래창(t+10 종가까지, 사후)', 10], ['동시점(t 종가, 당일 포함)', 0], ['실행가능 L0(t−1 종가)', -1], ['실행가능 L1(t−2 종가)', -2]] as const) {
      const cell = (id: string) => { let a = 0, na = 0, b = 0, nb = 0; for (const t of days) { const v = lb(t, sh); if (v === null) continue; const r = BASE[id].get(t)!; if (v) { a += r; na++; } else { b += r; nb++; } } return `${(1e4 * a / na).toFixed(1)}/${(1e4 * b / nb).toFixed(1)}`; };
      log(`  ${nm.padEnd(26)} F7_sl ${cell('F7_sl').padEnd(11)} F7_btc ${cell('F7_btc').padEnd(11)} BTC_TREND ${cell('BTC_TREND')}`);
    } }

  // ── 4. 2026-08 교훈 재현 점검: CASH 와 NEUT 분해 ──
  log(`\n── 4. '거르면 현금이 논다' 점검 (BRIEF 판정자, lag 1): 축소일에 잘려나간 자본이 원래 벌었을 것 vs 옮겨간 곳이 번 것 ──`);
  { const clf = CLF.find(c => c.id === 'BRIEF')!; const fl = days.map(t => flagAt(clf, clf.p0, t, 1));
    const grp = (ids: string[], v: boolean) => { let s = 0, n = 0; days.forEach((t, i) => { if (fl[i] !== v) return; s += ids.reduce((a, id) => a + BASE[id].get(t)!, 0) / ids.length; n++; }); return { bp: 1e4 * s / n, n }; };
    for (const [g, ids] of [['추세3', TREND], ['F7 2종', F7], ['ALT_SWING', SWING], ['중립', w.neutral]] as const) { const a = grp(ids as string[], true), b = grp(ids as string[], false); log(`  ${g.padEnd(9)} 축소일 ${a.bp.toFixed(1).padStart(6)}bp (n${a.n}) · 상승일 ${b.bp.toFixed(1).padStart(6)}bp (n${b.n})`); }
    for (const id of w.neutral) { const a = days.filter((t, i) => fl[i] && Math.abs(BASE[id].get(t)!) > 1e-9).length / Math.max(fl.filter(x => x).length, 1); log(`  ${id} 축소일 중 포지션 보유(일수익≠0) ${(100 * a).toFixed(0)}% — 나머지 날 증액분은 그냥 현금`); }
    // 추세 3종이 이미 현금인 날 비율 (축소일 중)
    const ex = toMap(S.expo.BTC_TREND); const cashDays = days.filter((t, i) => fl[i] && (ex.get(t) ?? 0) === 0).length / Math.max(fl.filter(x => x).length, 1);
    log(`  축소일 중 BTC_TREND 가 이미 현금인 날 ${(100 * cashDays).toFixed(0)}% — 이 날 '추세 축소'는 아무것도 안 바꾼다(NEUT 에선 놀던 돈을 옮기는 효과만)`);
  }

  // ── 5. 워크포워드: IS 에서 (규칙·판정자·임계·k) 최고 Δ샤프 칸 → OOS ──
  if (days[0] < Y(2023, 6)) {
    const cut = Y(2024, 6, 1); const isD = days.filter(t => t < cut), osD = days.filter(t => t >= cut);
    const bIS = metrics(sim(w, isD, { clf: CLF[0], p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.001 }).rs).sh, bOS = metrics(sim(w, osD, { clf: CLF[0], p: 0, rule: 'BASE', k: 1, lag: 1, cost: 0.001 }).rs).sh;
    const cells: Array<{ lab: string; is: number; os: number }> = [];
    for (const rule of RULES) for (const clf of CLF) for (const p of clf.grid) for (const k of [0, 0.25, 0.5, 0.75]) {
      cells.push({ lab: `${rule}·${clf.id}·${p}·k${k}`, is: metrics(sim(w, isD, { clf, p, rule, k, lag: 1, cost: 0.001 }).rs).sh - bIS, os: metrics(sim(w, osD, { clf, p, rule, k, lag: 1, cost: 0.001 }).rs).sh - bOS });
    }
    cells.sort((a, b) => b.is - a.is); const top = cells.slice(0, 5); const osAll = cells.map(c => c.os).sort((a, b) => a - b);
    log(`\n── 5. 워크포워드 IS 2022-07~2024-06 → OOS 2024-07~2026-09 (${cells.length}칸, Δ샤프 vs 균등) ──`);
    for (const c of top) log(`  IS 상위 ${c.lab.padEnd(26)} IS ${c.is.toFixed(2)} → OOS ${c.os.toFixed(2)}`);
    log(`  전칸 OOS Δ샤프 중앙 ${osAll[Math.floor(osAll.length / 2)].toFixed(2)} · OOS 양수 ${osAll.filter(x => x > 0).length}/${cells.length} · IS·OOS 상관 ${corr(cells.map(c => c.is), cells.map(c => c.os)).toFixed(2)}`);
    R[w.id + ':wf'] = { top, osMed: osAll[Math.floor(osAll.length / 2)] };
  }
}

// ── 6. 현재 국면 ──
{
  const k = N - 1; log(`\n════════ 6. 현재 국면 (BTC 일봉 ${new Date(bd[k].ts).toISOString().slice(0, 10)} 종가 기준, 4h 캐시 합성) ════════`);
  log(`  종가 ${C[k].toFixed(0)} · SMA50 대비 ${P(100 * (C[k] / sma50[k] - 1), 2)} · 20일 ${P(100 * F.r(k, 20), 2)} · 11일 ${P(100 * F.r(k, 11), 2)} · 박스폭20 ${(100 * box20[k]).toFixed(1)}% · SMA50 10일기울기 ${P(100 * slope50[k], 2)} · ADX ${adx[k].toFixed(1)} (+DI ${pdi[k].toFixed(1)} −DI ${mdi[k].toFixed(1)}) · 상승일비율 ${up20[k].toFixed(2)} · RV20 ${(100 * rv20[k]).toFixed(0)}% (1y 백분위 ${rvRank[k].toFixed(2)})`);
  for (const clf of CLF) log(`  ${clf.id.padEnd(6)} ${clf.desc.replace('p', String(clf.p0))} → ${clf.f(k, clf.p0) ? '비상승(축소)' : '상승(현행)'}`);
  const w = WINS[1];
  for (const rule of RULES) { const W = weights(w, rule, true, 0.5); log(`  비상승일 때 [${rule}] 비중: ` + w.ids.map(id => `${id} ${(100 * W[id]).toFixed(1)}%`).join(' · ') + ` · 현금 ${(100 * (1 - Object.values(W).reduce((a, b) => a + b, 0))).toFixed(1)}%`); }
  // 최근 30일 판정 이력
  const hist: string[] = []; for (let j = k - 20; j <= k; j++) hist.push(`${new Date(bd[j].ts).toISOString().slice(5, 10)} ${CLF.filter(c => ['R20', 'BRIEF', 'SMA50', 'R11', 'BOX'].includes(c.id)).map(c => (c.f(j, c.p0) ? c.id[0] + '↓' : c.id[0] + '·')).join('')}`);
  log('  최근 21일 (R20·R11·SMA50·BRIEF·BOX; ↓=축소): ' + hist.join(' | '));
}
fs.writeFileSync(path.join(DIRO, 'results.json'), JSON.stringify(R, null, 1));
fs.writeFileSync(path.join(DIRO, 'report.log'), OUTL.join('\n'));
