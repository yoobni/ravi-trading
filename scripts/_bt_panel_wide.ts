/**
 * 횡단면 반전 — 넓은 유니버스에서 유동성-성과 관계 판정.
 *
 * `_bt_panel.ts` 는 28코인에서 rev1 IC +0.049 를 찾았지만, 거래대금 상위로 좁힐수록
 * 성과가 단조 감소했다(128% → 105 → 83 → 48 → 38). 두 해석이 가능하다:
 *   (A) 진짜 edge 가 소형주에 더 크다 (유동성 프리미엄) → 비용만 감당하면 거래 가능
 *   (B) 호가 튐(bid-ask bounce) 이다 → 종가 기준으로만 보이고 실제로는 체결 불가
 *
 * 28종은 전부 대형주라 이 둘을 못 가른다. 거래대금 상위 90종으로 넓히면
 * 유동성 스펙트럼이 훨씬 길어져서 관계의 모양을 볼 수 있다:
 *   - 단조 증가(유동성 낮을수록 좋음)가 끝까지 이어지면 (B) 쪽이 강하게 의심된다.
 *   - 중간 구간에서 꺾이면 (A) 쪽, 즉 실행 가능한 구간이 존재한다.
 *
 * 판정 보조: 반전 수익이 "다음 봉 시가→종가"가 아니라 "종가→종가"에서만 크게 나오면
 * 그건 정의상 호가 튐이다. 두 가지를 나란히 잰다.
 *
 * 실행: npx tsx scripts/_bt_panel_wide.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const INIT = 10_000_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
/** 캐시에 있는 모든 60m 시계열을 코인별로 가장 긴 파일로 로드 */
function loadAll60m(): Map<string, Bar[]> {
  const byMarket = new Map<string, Bar[]>();
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^(KRW-[A-Z0-9]+)_60m_/);
    if (!m) continue;
    const bars = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    const cur = byMarket.get(m[1]);
    if (!cur || bars.length > cur.length) byMarket.set(m[1], bars);
  }
  return byMarket;
}
const RAW = loadAll60m();
const MIN_BARS = 4000;
for (const [m, b] of [...RAW]) if (b.length < MIN_BARS) RAW.delete(m);

// 공통 타임라인: 최소 60% 코인이 존재하는 시각만 (신규 상장 코인 때문에 전부 교집합은 너무 짧다)
const counts = new Map<number, number>();
for (const b of RAW.values()) for (const x of b) counts.set(x.ts, (counts.get(x.ts) ?? 0) + 1);
const NEED = Math.floor(RAW.size * 0.6);
const TS = [...counts.entries()].filter(([, c]) => c >= NEED).map(([t]) => t).sort((a, b) => a - b);
const TIDX = new Map(TS.map((t, i) => [t, i]));

const MKTS = [...RAW.keys()];
// 코인별 배열 — 해당 시각에 없으면 NaN
const C: number[][] = [], O: number[][] = [], V: number[][] = [];
for (const m of MKTS) {
  const map = new Map(RAW.get(m)!.map((b) => [b.ts, b]));
  const c = new Array(TS.length).fill(NaN), o = new Array(TS.length).fill(NaN), v = new Array(TS.length).fill(NaN);
  for (let i = 0; i < TS.length; i++) { const b = map.get(TS[i]); if (b) { c[i] = b.close; o[i] = b.open; v[i] = b.volume; } }
  C.push(c); O.push(o); V.push(v);
}
const ret1 = (ci: number, i: number) => (i < 1 ? NaN : C[ci][i] / C[ci][i - 1] - 1);
/**
 * 직전 W봉 평균 거래대금(원) — 롤링 합을 미리 계산해 둔다.
 * 매 시점마다 168봉을 다시 더하면 코인×시점 조합이 수억 번이라 끝나지 않는다.
 */
const TW = 168;
const TURN: number[][] = [];
for (let ci = 0; ci < MKTS.length; ci++) {
  const arr = new Array(TS.length).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < TS.length; i++) {
    const v = C[ci][i] * V[ci][i];
    if (Number.isFinite(v)) { sum += v; cnt++; }
    if (i >= TW) {
      const old = C[ci][i - TW] * V[ci][i - TW];
      if (Number.isFinite(old)) { sum -= old; cnt--; }
    }
    if (i >= TW && cnt > TW * 0.5) arr[i] = sum / cnt;
  }
  TURN.push(arr);
}
const turnover = (ci: number, i: number) => TURN[ci][i];

console.log(`=== 넓은 유니버스 횡단면 반전 (${MKTS.length}코인 1h, ${new Date(TS[0]).toISOString().slice(0,10)}~${new Date(TS[TS.length-1]).toISOString().slice(0,10)}, ${TS.length}봉) ===\n`);

// ── 1) 유동성 5분위별 반전 수익: "시가→종가"(실행 가능) vs "종가→종가"(호가 튐 포함)
const START = 200;
const Q = 5;
const openStats = Array.from({ length: Q }, () => ({ s: 0, n: 0 }));
const closeStats = Array.from({ length: Q }, () => ({ s: 0, n: 0 }));
const dropStats = Array.from({ length: Q }, () => ({ s: 0, n: 0, w: 0 }));
const liqLabel: number[][] = Array.from({ length: Q }, () => []);

for (let i = START; i < TS.length - 3; i++) {
  // 이 시점에 유효한 코인들을 거래대금으로 5분위 분할
  const alive = MKTS.map((_, ci) => ci).filter((ci) => Number.isFinite(turnover(ci, i)) && Number.isFinite(ret1(ci, i)) && Number.isFinite(O[ci][i + 1]) && Number.isFinite(C[ci][i + 1]));
  if (alive.length < 20) continue;
  const sorted = alive.map((ci) => [ci, turnover(ci, i)] as [number, number]).sort((a, b) => b[1] - a[1]);
  const per = Math.floor(sorted.length / Q);
  for (let q = 0; q < Q; q++) {
    const slice = sorted.slice(q * per, q === Q - 1 ? sorted.length : (q + 1) * per);
    liqLabel[q].push(slice.reduce((s, [, t]) => s + t, 0) / slice.length);
    // 그 분위 안에서 가장 많이 빠진 1종을 산다 (반전 신호)
    const worst = slice.reduce((a, b) => (ret1(a[0], i) < ret1(b[0], i) ? a : b));
    const ci = worst[0];
    // 실행 가능: 다음 봉 시가 매수 → 다음 봉 종가 매도
    openStats[q].s += C[ci][i + 1] / O[ci][i + 1] - 1; openStats[q].n++;
    // 호가 튐 포함: 이번 봉 종가 매수 → 다음 봉 종가 매도
    closeStats[q].s += C[ci][i + 1] / C[ci][i] - 1; closeStats[q].n++;
    // 급락 이벤트(≥4%)만
    if (ret1(ci, i) <= -0.04) {
      const r = C[ci][i + 2] !== undefined && Number.isFinite(C[ci][i + 2]) ? C[ci][i + 2] / O[ci][i + 1] - 1 : NaN;
      if (Number.isFinite(r)) { dropStats[q].s += r; dropStats[q].n++; if (r > 0) dropStats[q].w++; }
    }
  }
}
console.log('◆ 유동성 5분위별 1봉 반전 수익 (분위 내 최대 하락 1종 매수)');
console.log('  분위        | 평균 거래대금 | 시가→종가(실행가능) | 종가→종가(튐포함) | 차이(=튐 성분)');
console.log('  ' + '-'.repeat(92));
for (let q = 0; q < Q; q++) {
  const avgLiq = liqLabel[q].reduce((s, x) => s + x, 0) / (liqLabel[q].length || 1);
  const op = openStats[q].s / openStats[q].n * 100, cl = closeStats[q].s / closeStats[q].n * 100;
  console.log(`  ${('Q' + (q + 1) + (q === 0 ? ' (최상위)' : q === Q - 1 ? ' (최하위)' : '')).padEnd(12)}| ${((avgLiq / 1e8).toFixed(1) + '억').padStart(13)} | ${(op.toFixed(4) + '%').padStart(19)} | ${(cl.toFixed(4) + '%').padStart(18)} | ${((cl - op).toFixed(4) + '%p').padStart(14)}`);
}
console.log(`\n  왕복 비용 ${(COST * 100).toFixed(2)}% — "시가→종가"가 이보다 커야 실제로 남는다.`);

console.log('\n◆ 급락 이벤트(1h −4% 이상) 후 2시간 수익, 유동성 분위별');
console.log('  분위        | 표본 |  평균수익 |   승률 | 비용차감후');
for (let q = 0; q < Q; q++) {
  const d = dropStats[q];
  if (!d.n) { console.log(`  Q${q + 1} 표본없음`); continue; }
  const avg = d.s / d.n * 100;
  console.log(`  ${('Q' + (q + 1)).padEnd(12)}| ${String(d.n).padStart(4)} | ${(avg.toFixed(3) + '%').padStart(9)} | ${(d.w / d.n * 100).toFixed(1).padStart(5)}% | ${((avg - COST * 100).toFixed(3) + '%').padStart(10)}`);
}
