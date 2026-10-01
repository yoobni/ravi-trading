#!/usr/bin/env tsx
/**
 * 실행 격차 리포트 — "페이퍼 기록"과 "크론이 실제로 낼 수 있는 체결" 사이의 차이.
 *
 * 페이퍼는 exitPrice(스톱/목표 '가격')로 정산한다. 그 가격에 팔려면 거래소에 스톱 주문이
 * 걸려 있어야 한다. 주문 없이 크론이 4시간마다 보고 파는 실제 운영에서는
 * 체결가가 exitPriceMarket(인지 시점 시장가)에 가깝다.
 *
 * 두 값의 차이가 곧 **감시 공백 비용**이고, 실거래 설계(스톱 주문을 걸 것인가)의 근거다.
 * 청산 사유별로 부호가 다르므로 반드시 나눠서 본다 —
 * 손절은 늦게 팔면 반등해 유리하고, 익절·트레일은 늦게 팔면 불리하다.
 *
 * 실행: npx tsx scripts/paper-exec-gap.ts
 */
import fs from 'fs';
import path from 'path';

const STRATS: Array<[string, string, number]> = [
  ['F6', 'paper-f6', 4], ['F6_v2', 'paper-f6v2', 4], ['F6_v3', 'paper-f6v3', 4],
  ['F6_v5', 'paper-f6v5', 4], ['F6_v6', 'paper-f6v6', 12], ['F6_v7', 'paper-f6v7', 4], ['F6_v8', 'paper-f6v8', 4],
];
interface T {
  market: string; entryPrice: number; exitPrice: number; exitPriceMarket?: number | null;
  profitKrw: number; reason: string; exitTs: number; recordedAt: string;
}
const read = (p: string): T[] =>
  fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const rows: Array<{ sid: string; t: T; lagH: number }> = [];
for (const [sid, dir, step] of STRATS) {
  for (const t of read(path.resolve(process.cwd(), 'data', dir, 'trades.jsonl'))) {
    // exitTs 는 청산 봉의 시작(UTC ms) → 봉 마감까지 step 시간
    const barClose = t.exitTs + step * 3600_000;
    const rec = Date.parse(t.recordedAt);
    rows.push({ sid, t, lagH: (rec - barClose) / 3600_000 });
  }
}
if (!rows.length) { console.log('거래 기록 없음'); process.exit(0); }

console.log(`=== 실행 격차 리포트 (전체 ${rows.length}건) ===\n`);

// ── 인지 지연
const lags = rows.map((r) => r.lagH).sort((a, b) => a - b);
const med = lags[Math.floor(lags.length / 2)];
console.log('◆ 봉 마감 → 크론 인지 지연');
console.log(`  중앙 ${med.toFixed(1)}h · 평균 ${(lags.reduce((s, v) => s + v, 0) / lags.length).toFixed(1)}h · 최대 ${lags[lags.length - 1].toFixed(1)}h`);
const late = lags.filter((l) => l > 8).length;
console.log(`  8시간 초과 ${late}건 (${(late / lags.length * 100).toFixed(0)}%) — 대부분 맥 절전으로 크론을 거른 구간\n`);

// ── 실행 격차 (exitPriceMarket 이 기록된 건만)
const withMkt = rows.filter((r) => r.t.exitPriceMarket != null && r.t.exitPriceMarket > 0);
if (!withMkt.length) {
  console.log('◆ 실행 격차: 아직 표본 없음');
  console.log('  exitPriceMarket 기록은 2026-08-27 이후 청산부터 쌓인다.');
  console.log('  그 전 거래는 스톱 가격만 기록돼 있어 사후 비교가 불가능하다.');
} else {
  console.log(`◆ 실행 격차 — (시장가 − 기록가) / 기록가   [표본 ${withMkt.length}건]`);
  console.log('  청산사유 | 건수 |     평균 |     중앙 |     최악 | PnL 영향');
  const by = new Map<string, typeof withMkt>();
  for (const r of withMkt) { const k = r.t.reason; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  let totalDelta = 0;
  for (const [reason, list] of [...by.entries()].sort()) {
    const d = list.map((r) => (r.t.exitPriceMarket! - r.t.exitPrice) / r.t.exitPrice * 100).sort((a, b) => a - b);
    const avg = d.reduce((s, v) => s + v, 0) / d.length;
    // PnL 영향: 체결 수량 × 가격차. 수량은 profitKrw 로 역산한다.
    let delta = 0;
    for (const r of list) {
      const denom = (r.t.exitPrice / r.t.entryPrice) - 1;
      if (Math.abs(denom) < 1e-9) continue;
      const cashUsed = r.t.profitKrw / (((r.t.exitPrice / r.t.entryPrice) * (1 - 0.0005) ** 2) - 1);
      const vol = cashUsed * (1 - 0.0005) / r.t.entryPrice;
      delta += vol * (r.t.exitPriceMarket! - r.t.exitPrice);
    }
    totalDelta += delta;
    console.log(`  ${reason.padEnd(8)} | ${String(list.length).padStart(4)} | ${(avg >= 0 ? '+' : '') + avg.toFixed(2)}%`.padEnd(34) + `| ${(d[Math.floor(d.length / 2)] >= 0 ? '+' : '') + d[Math.floor(d.length / 2)].toFixed(2)}% | ${d[0].toFixed(2)}% | ${delta >= 0 ? '+' : ''}${Math.round(delta).toLocaleString()}원`);
  }
  console.log(`\n  합계: 크론 시점 시장가로 체결했다면 ${totalDelta >= 0 ? '+' : ''}${Math.round(totalDelta).toLocaleString()}원`);
  console.log('  (+ 면 스톱 주문을 안 걸어도 손해가 아니었다는 뜻. 다만 국면에 따라 뒤집힌다 —');
  console.log('   수익은 TP·TRAIL 에서 나오는데 그쪽이 지연에 불리하다.)');
}

// ── 사유별 PnL 비중 (어디서 돈이 나오는지)
console.log('\n◆ 청산 사유별 PnL 비중 — 지연에 불리한 쪽에 수익이 몰려 있는가');
const agg = new Map<string, { n: number; pnl: number }>();
let tot = 0;
for (const { t } of rows) {
  const a = agg.get(t.reason) ?? { n: 0, pnl: 0 };
  a.n++; a.pnl += t.profitKrw; agg.set(t.reason, a); tot += t.profitKrw;
}
console.log('  사유     | 건수 |        PnL | 전체 대비');
for (const [r, a] of [...agg.entries()].sort((x, y) => y[1].pnl - x[1].pnl)) {
  console.log(`  ${r.padEnd(8)} | ${String(a.n).padStart(4)} | ${Math.round(a.pnl).toLocaleString().padStart(10)} | ${(a.pnl / tot * 100).toFixed(0).padStart(5)}%`);
}
console.log(`  ${'합계'.padEnd(8)} | ${String(rows.length).padStart(4)} | ${Math.round(tot).toLocaleString().padStart(10)} |`);
