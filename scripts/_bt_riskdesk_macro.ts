/**
 * AI 리스크 데스크 리서치(2026-10) — D: 거시 발표 후 급락 시 축소 규칙 (리서치 전용, API 호출 없음)
 * 데이터: _mac_core (업비트 KRW-BTC 1h 2018~2026-10-02, FOMC 14:00ET·CPI 8:30ET·고용 8:30ET → UTC).
 * 규칙: 발표가 든 1h 봉 b0 의 시가 p0 → b0+3 봉 종가 p4 ("발표 후 ~4h"). r4 = p4/p0−1 ≤ −2% 이면 트리거.
 * 측정: 트리거 후 24h·48h 드리프트(p4 기준) vs (i) 발표 후 r4 > −2% 인 이벤트, (ii) 발표 아닌 임의 시각의 4h ≤ −2% (겹침 제거), (iii) 무조건.
 * 오버레이: BTC_TREND(일봉 SMA50, KST09 판단) 보유 중 트리거 → 다음 24h 비중 50%, 이후 복귀. 비용 0.05%+0.02% 편도, 50% 명목 ×2회.
 * 플라시보: 같은 횟수의 무작위 24h 반감(×200), 발표 아닌 4h −2% 반감.
 */
import fs from 'fs';
import { B, IDX, EVENTS, barAt, trendOn, H, DAY, mean, tstat, P } from './_mac_core';
const OUT = 'data/research-ext/riskdesk-2026-10';
const Lo: string[] = [];
interface E { kind: string; t: number; b0: number; r4: number; d24: number; d48: number; max24dd: number }
const evs: E[] = [];
for (const [kind, ts] of Object.entries(EVENTS)) for (const t of ts) { const b0 = barAt(t); if (b0 == null || b0 + 3 + 48 >= B.length) continue; const p0 = B[b0].open, p4 = B[b0 + 3].close; let lo = Infinity; for (let k = b0 + 4; k <= b0 + 27; k++) lo = Math.min(lo, B[k].low); evs.push({ kind, t, b0, r4: p4 / p0 - 1, d24: B[b0 + 27].close / p4 - 1, d48: B[b0 + 51].close / p4 - 1, max24dd: lo / p4 - 1 }); }
const stat = (xs: E[]) => `n ${String(xs.length).padStart(4)} | d24 mean ${P(100 * mean(xs.map(x => x.d24)))} med ${P(100 * [...xs.map(x => x.d24)].sort((a, b) => a - b)[Math.floor(xs.length / 2)] || 0)} t ${tstat(xs.map(x => x.d24)).toFixed(2)} %>0 ${xs.length ? (100 * xs.filter(x => x.d24 > 0).length / xs.length).toFixed(0) : '-'}% | d48 mean ${P(100 * mean(xs.map(x => x.d48)))} t ${tstat(xs.map(x => x.d48)).toFixed(2)} | min-low24 mean ${P(100 * mean(xs.map(x => x.max24dd)))}`;
Lo.push(`macro events with 1h data: ${evs.length} (${Object.entries(EVENTS).map(([k, v]) => `${k} ${v.filter(t => barAt(t) != null).length}`).join(', ')}), ${new Date(B[0].ts).toISOString().slice(0, 10)}~${new Date(B.at(-1)!.ts).toISOString().slice(0, 10)}`);
Lo.push('\n### 발표 후 4h 수익 조건별 이후 드리프트 (p4 기준)');
Lo.push('all events              ' + stat(evs));
Lo.push('r4 ≤ −2%                ' + stat(evs.filter(e => e.r4 <= -0.02)));
Lo.push('r4 ≤ −3%                ' + stat(evs.filter(e => e.r4 <= -0.03)));
Lo.push('−2% < r4 < +2%          ' + stat(evs.filter(e => e.r4 > -0.02 && e.r4 < 0.02)));
Lo.push('r4 ≥ +2%                ' + stat(evs.filter(e => e.r4 >= 0.02)));
for (const k of ['FOMC', 'CPI', 'NFP']) { Lo.push(`${k.padEnd(5)} r4 ≤ −2%          ` + stat(evs.filter(e => e.kind === k && e.r4 <= -0.02))); }
for (const [a, b, nm] of [[2018, 2022, '2018-21'], [2022, 2024, '2022-23'], [2024, 2027, '2024-26']] as [number, number, string][]) Lo.push(`${nm} r4 ≤ −2%          ` + stat(evs.filter(e => e.r4 <= -0.02 && e.t >= Date.UTC(a, 0, 1) && e.t < Date.UTC(b, 0, 1))));
Lo.push('trigger list: ' + evs.filter(e => e.r4 <= -0.02).map(e => `${new Date(e.t).toISOString().slice(0, 13)} ${e.kind} r4 ${(100 * e.r4).toFixed(1)} d24 ${(100 * e.d24).toFixed(1)}`).join(' | '));
// (ii) 발표 아닌 시각의 4h ≤ −2% (1h 간격 스캔, 발표 ±24h 제외, 겹침 제거)
{ const evT = new Set(evs.map(e => e.b0)); const near = (i: number) => { for (let k = -24; k <= 27; k++) if (evT.has(i - k)) return true; return false; };
  const xs: E[] = []; let last = -100;
  for (let i = 3; i + 51 < B.length; i++) { if (i - last < 28) continue; const r4 = B[i].close / B[i - 3].open - 1; if (r4 > -0.02 || near(i - 3)) continue; let lo = Infinity; for (let k = i + 1; k <= i + 24; k++) lo = Math.min(lo, B[k].low); xs.push({ kind: 'any', t: B[i].ts, b0: i - 3, r4, d24: B[i + 24].close / B[i].close - 1, d48: B[i + 48].close / B[i].close - 1, max24dd: lo / B[i].close - 1 }); last = i; }
  Lo.push('non-event 4h ≤ −2%      ' + stat(xs));
  for (const [a, b, nm] of [[2018, 2022, '2018-21'], [2022, 2024, '2022-23'], [2024, 2027, '2024-26']] as [number, number, string][]) Lo.push(`  ${nm}              ` + stat(xs.filter(e => e.t >= Date.UTC(a, 0, 1) && e.t < Date.UTC(b, 0, 1))));
  // 무조건 24h 드리프트
  const all: number[] = []; for (let i = 0; i + 24 < B.length; i += 24) all.push(B[i + 24].close / B[i].close - 1);
  Lo.push(`unconditional 24h: n ${all.length} mean ${P(100 * mean(all))} t ${tstat(all).toFixed(2)}`);
}
// ── BTC_TREND 오버레이 ──
const ON = trendOn(50);
const FEE = 0.0005, SLIP = 0.0002;
function equity(halfAt: Set<number>, label: string) {
  // halfAt: 트리거 봉 인덱스(b0+3) → 그 다음 24봉 비중 0.5
  let eq = 1, peak = 1, mdd = 0, w = 0, trig = 0; const yearly: Record<string, number> = {}; let yEq = 1, yKey = '';
  const half = new Int8Array(B.length); for (const i of halfAt) for (let k = i + 1; k <= Math.min(i + 24, B.length - 1); k++) half[k] = 1;
  for (let i = 1; i < B.length; i++) {
    const day = Math.floor(B[i - 1].ts / DAY) * DAY; const on = ON.get(day) ?? false;
    const target = on ? (half[i] ? 0.5 : 1) : 0;
    const cost = Math.abs(target - w) * (FEE + SLIP); if (target !== w && on && (half[i] !== half[i - 1])) trig++;
    w = target; eq *= (1 + w * (B[i].close / B[i - 1].close - 1)) * (1 - cost);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
    const y = new Date(B[i].ts).toISOString().slice(0, 4); if (y !== yKey) { yKey = y; yEq = eq; } yearly[y] = eq / yEq;
  }
  return { label, ret: eq - 1, mdd, trig, yearly };
}
const base = equity(new Set(), 'BTC_TREND base');
const trigSet = new Set(evs.filter(e => e.r4 <= -0.02).map(e => e.b0 + 3));
const ov = equity(trigSet, 'overlay: macro r4≤−2% → 24h 50%');
const trig3 = equity(new Set(evs.filter(e => e.r4 <= -0.03).map(e => e.b0 + 3)), 'overlay: r4≤−3%');
const trigAll = equity(new Set(evs.map(e => e.b0 + 3)), 'overlay: every macro event 24h 50% (unconditional)');
const trigUp = equity(new Set(evs.filter(e => e.r4 >= 0.02).map(e => e.b0 + 3)), 'overlay: r4≥+2% (mirror control)');
Lo.push('\n### BTC_TREND 오버레이 (1h 경로, 2018~)');
const fmtY = (r: ReturnType<typeof equity>) => Object.entries(r.yearly).map(([y, v]) => `${y} ${P(100 * (v - 1), 0)}`).join(' ');
for (const r of [base, ov, trig3, trigAll, trigUp]) Lo.push(`${r.label.padEnd(52)} ret ${P(100 * r.ret, 0).padStart(7)} MDD ${(100 * r.mdd).toFixed(1)}% Δret ${P(100 * (r.ret - base.ret), 1)}p ΔMDD ${P(100 * (r.mdd - base.mdd), 1)}p | ${fmtY(r)}`);
// 플라시보: 같은 횟수 무작위 시각 반감
{ const n = trigSet.size; const rs: number[] = []; let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let s = 0; s < 200; s++) { const set = new Set<number>(); while (set.size < n) set.add(3 + Math.floor(rnd() * (B.length - 60))); rs.push(equity(set, 'p').ret); }
  rs.sort((a, b) => a - b); Lo.push(`placebo (random ${n} half-days ×200): Δret med ${P(100 * (rs[100] - base.ret), 1)}p p5 ${P(100 * (rs[10] - base.ret), 1)}p p95 ${P(100 * (rs[190] - base.ret), 1)}p | overlay Δ ${P(100 * (ov.ret - base.ret), 1)}p → ${rs.filter(x => x >= ov.ret).length}/200 placebos ≥ overlay`);
}
// 트리거가 TREND 보유 중이었던 횟수와 그때의 24h BTC 수익
{ const onTrig = evs.filter(e => e.r4 <= -0.02 && (ON.get(Math.floor(B[e.b0 + 3].ts / DAY) * DAY) ?? false)); Lo.push(`triggers while TREND holding: ${onTrig.length}/${trigSet.size}, their d24 mean ${P(100 * mean(onTrig.map(x => x.d24)))} (t ${tstat(onTrig.map(x => x.d24)).toFixed(2)}), d48 ${P(100 * mean(onTrig.map(x => x.d48)))}`); }
fs.writeFileSync(`${OUT}/macro-report.txt`, Lo.join('\n'));
console.log('done');
