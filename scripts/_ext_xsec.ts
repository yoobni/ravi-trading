/**
 * 축 E — 업비트 KRW 전 종목 횡단면 전략 (2026-10-02)
 * 데이터: data/research-ext/daily/*.json (현재 상장 종목만 — 상폐 종목 없음 → 생존편향, 결과는 상한으로 읽을 것)
 * 체결: 리밸런스일 KST 09시 일봉 시가(= 전일 종가 직후)에 시장가. 비용 = 수수료 0.05% + 슬리피지(스프레드 p50 ½, 없는 코인 0.3%) × costMult.
 * 유니버스: 매 시점 직전 30일 평균 거래대금 상위 U (미래참조 없음), 상장 후 lookback+30일 이상.
 * 롱온리. 동일위험 = 노출비율 f(≤1)로 MDD 17% 맞춤 (나머지 현금).
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const FEE = 0.0005, DAY = 86400e3;
interface Bar { ts: number; open: number; high: number; low: number; close: number; value: number }
const mk: string[] = JSON.parse(fs.readFileSync(path.join(DIR, '_markets.json'), 'utf8'));
const RAW = new Map<string, Bar[]>();
for (const m of mk) { const f = path.join(DIR, `${m}.json`); if (fs.existsSync(f)) { const b = JSON.parse(fs.readFileSync(f, 'utf8')); if (b.length > 120) RAW.set(m, b); } }
const DAYS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const DI = new Map(DAYS.map((t, i) => [t, i]));
// 날짜 인덱스 정렬 배열 (없는 날 = null)
const MAT = new Map<string, (Bar | null)[]>();
for (const [m, b] of RAW) { const a: (Bar | null)[] = new Array(DAYS.length).fill(null); for (const x of b) a[DI.get(x.ts)!] = x; MAT.set(m, a); }
const MK = [...RAW.keys()];
const FIRST = new Map(MK.map(m => [m, MAT.get(m)!.findIndex(x => x != null)]));
const slip = (m: string) => (SPREAD[m] != null ? Math.max(0.0005, SPREAD[m] / 2 / 1e4) : 0.003);
const ret = (m: string, i: number) => { const a = MAT.get(m)!; const x = a[i], p = a[i - 1]; return x && p ? x.close / p.close - 1 : null; };

export type Score = (m: string, i: number) => number | null;   // i = 판단일(그 날 종가까지 사용), 클수록 매수
export interface Cfg { score: Score; N: number; U: number; R: number; minAge: number; costMult?: number; btcGate?: boolean; randSeed?: number }

/** 일별 포트폴리오 수익 시계열 (노출 100%) */
export function simulate(c: Cfg, from = 0, to = Infinity) {
  const out: { ts: number; r: number }[] = [];
  let hold = new Map<string, number>();   // 비중
  let seed = c.randSeed ?? 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const btc = MAT.get('KRW-BTC')!;
  for (let i = 61; i < DAYS.length - 1; i++) {
    if (DAYS[i] < from || DAYS[i] > to) continue;
    // i 일 종가 기준 판단 → i+1 일 시가에 리밸런스 → i+1 일 수익은 시가→종가 + 이후 종가→종가
    // 단순화: 보유 수익 = 다음날 종가/오늘 종가 (리밸런스 체결가는 다음날 시가 ≈ 오늘 종가, 갭은 비용에 흡수되지 않음 → 아래 open 보정)
    let r = 0;
    if ((i - 61) % c.R === 0) {
      // 유니버스
      const elig: { m: string; v: number }[] = [];
      for (const m of MK) {
        const a = MAT.get(m)!; if (!a[i] || !a[i + 1]) continue;
        if (i - FIRST.get(m)! < c.minAge) continue;
        let v = 0, n = 0; for (let j = i - 29; j <= i; j++) if (a[j]) { v += a[j]!.value; n++; }
        if (n >= 25) elig.push({ m, v: v / n });
      }
      elig.sort((x, y) => y.v - x.v);
      const uni = elig.slice(0, c.U).map(x => x.m);
      let pick: string[];
      const gateOff = c.btcGate && (() => { let s = 0; for (let j = i - 49; j <= i; j++) s += btc[j]?.close ?? 0; return (btc[i]?.close ?? 0) < s / 50; })();
      if (gateOff) pick = [];
      else if (c.randSeed != null) pick = uni.slice().sort(() => rnd() - 0.5).slice(0, c.N);
      else pick = uni.map(m => ({ m, s: c.score(m, i) })).filter(x => x.s != null && Number.isFinite(x.s)).sort((a, b) => b.s! - a.s!).slice(0, c.N).map(x => x.m);
      const next = new Map(pick.map(m => [m, 1 / c.N]));
      // 회전 비용
      const all = new Set([...hold.keys(), ...next.keys()]);
      let cost = 0;
      for (const m of all) { const d = Math.abs((next.get(m) ?? 0) - (hold.get(m) ?? 0)); cost += d * (FEE + slip(m)) * (c.costMult ?? 1); }
      r -= cost;
      hold = next;
    }
    // 보유 수익: i 종가 → i+1 종가
    for (const [m, w] of hold) { const x = ret(m, i + 1); r += w * (x ?? 0); }
    // 비중 드리프트 무시(리밸런스 주기 내 동일가중 근사)
    out.push({ ts: DAYS[i + 1], r });
  }
  return out;
}
export function stats(rs: { ts: number; r: number }[], f = 1) {
  let eq = 1, pk = 1, mdd = 0;
  for (const x of rs) { eq *= 1 + f * x.r; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); }
  return { ret: 100 * (eq - 1), mdd: 100 * mdd };
}
export function eqRisk(rs: { ts: number; r: number }[], target = 17) {
  const full = stats(rs, 1); if (full.mdd <= target) return { f: 1, ...full };
  let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (stats(rs, mid).mdd > target) hi = mid; else lo = mid; }
  return { f: lo, ...stats(rs, lo) };
}
export { MAT, MK, DAYS, ret };

// ── 점수 함수들 (i 일 종가까지만 사용) ──
const px = (m: string, i: number) => MAT.get(m)![i]?.close ?? null;
export const momentum = (L: number, skip = 1): Score => (m, i) => { const a = px(m, i - skip), b = px(m, i - skip - L); return a && b ? a / b - 1 : null; };
export const lowVol = (W = 30): Score => (m, i) => { const xs: number[] = []; for (let j = i - W + 1; j <= i; j++) { const r = ret(m, j); if (r != null) xs.push(r); } if (xs.length < W * 0.8) return null; const mu = xs.reduce((s, x) => s + x, 0) / xs.length; return -Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length); };
export const volSurge = (S = 7, Lg = 60): Score => (m, i) => { const a = MAT.get(m)!; let s = 0, l = 0, ns = 0, nl = 0; for (let j = i - Lg + 1; j <= i; j++) { if (!a[j]) continue; l += a[j]!.value; nl++; if (j > i - S) { s += a[j]!.value; ns++; } } return ns && nl ? (s / ns) / (l / nl) : null; };
export const residMom = (L: number, W = 60, skip = 1): Score => (m, i) => {
  // BTC 베타를 W일 창에서 추정, 최근 L일 잔차 합
  const xs: number[] = [], ys: number[] = [];
  for (let j = i - W + 1; j <= i; j++) { const y = ret(m, j), x = ret('KRW-BTC', j); if (y != null && x != null) { xs.push(x); ys.push(y); } }
  if (xs.length < W * 0.8) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let cov = 0, vx = 0; for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; }
  const beta = vx > 0 ? cov / vx : 1;
  let s = 0; for (let j = i - skip - L + 1; j <= i - skip; j++) { const y = ret(m, j), x = ret('KRW-BTC', j); if (y != null && x != null) s += y - beta * x; }
  return s;
};
