/**
 * 축 P — 블라인드 판단 평가. decisions.csv(봉인 해시 decisions.sha256) 와 outcomes.SEALED.json 결합.
 * 7일 비중첩 구간을 시간순으로 이어 붙인 주간 수익열. 비용: 비중 변화 × (0.05% 수수료 + 0.02% 슬리피지).
 */
import fs from 'fs';
const D = 'data/research-ext/ai-blind';
const dec = new Map(fs.readFileSync(`${D}/decisions.csv`, 'utf8').trim().split('\n').map(l => { const [id, w, leak, ...r] = l.split(','); return [id, { w: +w / 100, leak: +leak, why: r.join(',') }]; }));
const outs = (JSON.parse(fs.readFileSync(`${D}/outcomes.SEALED.json`, 'utf8')) as any[]).sort((a, b) => a.t - b.t);
const rows = outs.map(o => ({ ...o, ai: dec.get(o.id)!.w, leak: dec.get(o.id)!.leak }));
const COST = 0.0007;
type R = typeof rows[number];
const series = (ws: number[], rs: R[]) => { let prev = 0; return rs.map((r, i) => { const w = ws[i]; const x = w * r.fwd7 - COST * Math.abs(w - prev); prev = w; return x; }); };
const stats = (x: number[], k = 1) => { let eq = 1, pk = 1, mdd = 0; for (const v of x) { eq *= 1 + k * v; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); } return { ret: 100 * (eq - 1), mdd: 100 * mdd }; };
const eq17 = (x: number[]) => { let lo = 0.01, hi = 3; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (stats(x, m).mdd > 17) hi = m; else lo = m; } return { k: lo, ...stats(x, lo) }; };
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
const sharpe = (x: number[]) => { const m = mean(x), s = Math.sqrt(mean(x.map(v => (v - m) ** 2))); return s ? m / s * Math.sqrt(52) : 0; };
const strat = (name: string, f: (r: R) => number, rs: R[] = rows) => {
  const ws = rs.map(f), x = series(ws, rs), s = stats(x), e = eq17(x);
  const worst = rs.map((r, i) => [r.fwd7, ws[i]] as [number, number]).sort((a, b) => a[0] - b[0]).slice(0, Math.floor(rs.length * 0.2));
  const best = rs.map((r, i) => [r.fwd7, ws[i]] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, Math.floor(rs.length * 0.2));
  return { name, ret: s.ret, mdd: s.mdd, eq17: e.ret, sh: sharpe(x), expo: 100 * mean(ws), avoid: 100 * mean(worst.map(([, w]) => 1 - w)), catch: 100 * mean(best.map(([, w]) => w)), wk: 100 * mean(x) };
};
const fmt = (o: any) => `${o.name.padEnd(26)}${(o.ret.toFixed(0) + '%').padStart(8)}${(o.mdd.toFixed(0) + '%').padStart(6)}${(o.eq17.toFixed(0) + '%').padStart(8)}${o.sh.toFixed(2).padStart(7)}${(o.expo.toFixed(0) + '%').padStart(6)}${(o.avoid.toFixed(0) + '%').padStart(7)}${(o.catch.toFixed(0) + '%').padStart(7)}${(o.wk.toFixed(3) + '%').padStart(9)}`;
const HDR = '전략'.padEnd(26) + '총익'.padStart(8) + 'MDD'.padStart(6) + 'MDD17'.padStart(8) + 'Shrp'.padStart(7) + '노출'.padStart(6) + '하락회피'.padStart(7) + '상승포착'.padStart(7) + '주평균'.padStart(9);
console.log(`표본 ${rows.length}주 · ${rows[0].date} ~ ${rows[rows.length - 1].date} · 누출의심 ${rows.filter(r => r.leak).length}건\n`);
console.log(HDR);
const S: Array<[string, (r: R) => number]> = [
  ['BTC 보유', () => 1], ['BTC_TREND (SMA50)', r => r.trend], ['AI 판단', r => r.ai],
  ['AI ∧ TREND (둘 다 동의)', r => Math.min(r.ai, r.trend)], ['AI·TREND 평균', r => (r.ai + r.trend) / 2],
  ['AI 이진화 (≥50→100)', r => r.ai >= 0.5 ? 1 : 0],
];
for (const [n, f] of S) console.log(fmt(strat(n, f)));
// 플라시보: AI 비중을 시점 간 무작위 재배치(노출 동일)
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const aiW = rows.map(r => r.ai), pl: number[] = [];
for (let k = 0; k < 500; k++) { const p = aiW.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } pl.push(eq17(series(p, rows)).ret); }
pl.sort((a, b) => a - b);
const aiE = eq17(series(aiW, rows)).ret;
console.log(`\n플라시보(AI 비중 무작위 재배치 500회) MDD17: 중앙 ${pl[250].toFixed(0)}% · 95분위 ${pl[475].toFixed(0)}% · 최대 ${pl[499].toFixed(0)}% → AI ${aiE.toFixed(0)}% 초과 ${pl.filter(v => v >= aiE).length}/500`);
// 판단 일치도
const agree = rows.filter(r => (r.ai >= 0.5 ? 1 : 0) === r.trend).length;
console.log(`AI(≥50=보유)와 TREND 일치 ${agree}/${rows.length} (${(100 * agree / rows.length).toFixed(0)}%) · AI 50% 판단 ${rows.filter(r => r.ai === 0.5).length}건`);
// 불일치 구간 성과
const dis = (name: string, f: (r: R) => boolean) => { const s = rows.filter(f); console.log(`  ${name.padEnd(30)} n=${String(s.length).padStart(3)} 평균 7일수익 ${(100 * mean(s.map(r => r.fwd7))).toFixed(2)}%`); };
console.log('불일치 구간 — 누가 맞았나 (BTC 7일 수익):');
dis('TREND 보유 · AI 0', r => r.trend === 1 && r.ai === 0);
dis('TREND 보유 · AI 50', r => r.trend === 1 && r.ai === 0.5);
dis('TREND 현금 · AI 50', r => r.trend === 0 && r.ai === 0.5);
dis('TREND 현금 · AI 100', r => r.trend === 0 && r.ai === 1);
dis('둘 다 보유(AI 100)', r => r.trend === 1 && r.ai === 1);
dis('둘 다 현금', r => r.trend === 0 && r.ai === 0);
// 연도별
console.log('\n연도별 총익 (비중 그대로, 비용 반영):');
const yrs = [...new Set(rows.map(r => r.date.slice(0, 4)))];
console.log('       ' + yrs.map(y => y.padStart(7)).join(''));
for (const [n, f] of S.slice(0, 4)) console.log(n.slice(0, 6).padEnd(7) + yrs.map(y => { const rs = rows.filter(r => r.date.startsWith(y)); return (stats(series(rs.map(f), rs)).ret.toFixed(0) + '%').padStart(7); }).join(''));
// 앞/뒤 절반
const half = Math.floor(rows.length / 2);
console.log('\n앞/뒤 절반 MDD17:');
for (const [n, f] of S.slice(1, 4)) { const a = rows.slice(0, half), b = rows.slice(half); console.log(`  ${n.padEnd(26)} 앞 ${eq17(series(a.map(f), a)).ret.toFixed(0)}% · 뒤 ${eq17(series(b.map(f), b)).ret.toFixed(0)}%`); }
// 누출 제외: 주평균 비교(연쇄가 끊기므로 평균 수익으로)
const nl = rows.filter(r => !r.leak);
console.log(`\n누출 의심 ${rows.length - nl.length}건 제외(n=${nl.length}) 주평균 수익(비용 무시): BTC ${(100 * mean(nl.map(r => r.fwd7))).toFixed(3)}% · TREND ${(100 * mean(nl.map(r => r.trend * r.fwd7))).toFixed(3)}% · AI ${(100 * mean(nl.map(r => r.ai * r.fwd7))).toFixed(3)}% · AI∧TREND ${(100 * mean(nl.map(r => Math.min(r.ai, r.trend) * r.fwd7))).toFixed(3)}%`);
const lk = rows.filter(r => r.leak);
console.log(`누출 의심 ${lk.length}건만: TREND ${(100 * mean(lk.map(r => r.trend * r.fwd7))).toFixed(2)}% · AI ${(100 * mean(lk.map(r => r.ai * r.fwd7))).toFixed(2)}% · 날짜 ${lk.map(r => r.date).join(' ')}`);
// 비용 ×3
const x3 = (f: (r: R) => number) => { let prev = 0; return rows.map(r => { const w = f(r); const v = w * r.fwd7 - 3 * COST * Math.abs(w - prev); prev = w; return v; }); };
console.log(`\n비용×3 MDD17: TREND ${eq17(x3(r => r.trend)).ret.toFixed(0)}% · AI ${eq17(x3(r => r.ai)).ret.toFixed(0)}% · AI∧TREND ${eq17(x3(r => Math.min(r.ai, r.trend))).ret.toFixed(0)}%`);

// ── AND 결합의 플라시보: TREND 보유 주 안에서만 AI 비중(100/50/0)을 무작위 재배치 → 'AI 가 고른 주에 반 사이즈'가 무작위보다 나은가
{
  const on = rows.map((r, i) => r.trend === 1 ? i : -1).filter(i => i >= 0);
  const wOn = on.map(i => rows[i].ai);
  const real = eq17(series(rows.map(r => Math.min(r.ai, r.trend)), rows)).ret;
  const pl2: number[] = [];
  for (let k = 0; k < 1000; k++) {
    const p = wOn.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    const ws = rows.map(() => 0); on.forEach((idx, j) => { ws[idx] = p[j]; });
    pl2.push(eq17(series(ws, rows)).ret);
  }
  pl2.sort((a, b) => a - b);
  console.log(`\nAND 플라시보(TREND 보유 주 안에서 AI 비중 무작위 1000회) MDD17: 중앙 ${pl2[500].toFixed(0)}% · 95분위 ${pl2[950].toFixed(0)}% · 최대 ${pl2[999].toFixed(0)}% → 실제 ${real.toFixed(0)}% 초과 ${pl2.filter(v => v >= real).length}/1000`);
  // 같은 플라시보를 주평균 수익(MDD 무관)으로
  const realMean = mean(on.map(i => Math.min(rows[i].ai, 1) * rows[i].fwd7));
  const pm: number[] = [];
  for (let k = 0; k < 1000; k++) { const p = wOn.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } pm.push(mean(on.map((idx, j) => p[j] * rows[idx].fwd7))); }
  pm.sort((a, b) => a - b);
  console.log(`  주평균 수익: 실제 ${(100 * realMean).toFixed(3)}% vs 플라시보 중앙 ${(100 * pm[500]).toFixed(3)}% · 95분위 ${(100 * pm[950]).toFixed(3)}% → 초과 ${pm.filter(v => v >= realMean).length}/1000`);
  // TREND 보유 주에서 AI 100 vs 50 의 7일 수익 차이 (t)
  const a = on.filter(i => rows[i].ai === 1).map(i => rows[i].fwd7), b = on.filter(i => rows[i].ai === 0.5).map(i => rows[i].fwd7);
  const va = mean(a.map(v => (v - mean(a)) ** 2)), vb = mean(b.map(v => (v - mean(b)) ** 2));
  console.log(`  TREND 보유 주: AI 100 n=${a.length} 평균 ${(100 * mean(a)).toFixed(2)}% · AI 50 n=${b.length} 평균 ${(100 * mean(b)).toFixed(2)}% · 차이 t=${((mean(a) - mean(b)) / Math.sqrt(va / a.length + vb / b.length)).toFixed(2)}`);
  const sdA = Math.sqrt(va), sdB = Math.sqrt(vb);
  console.log(`  주간 수익 표준편차: AI 100 ${(100 * sdA).toFixed(2)}% · AI 50 ${(100 * sdB).toFixed(2)}% (50 판단이 고변동 주를 골랐나)`);
}
