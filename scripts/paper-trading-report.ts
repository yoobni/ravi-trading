/**
 * Paper trading 주간/월간 리포트.
 *
 * 라비 통과 기준 (3개월 후, MAIN = FUNDING_F1F2_50 기준):
 *   통과: PF≥1.2, 총수익 양수, MDD≤12%, 신호 ≥5~10, 손실 백테스트 대비 과도하지 않음
 *   보류: PF 1.0~1.2, 약보합, 신호 부족 / MDD 안정
 *   폐기: PF<1, MDD≥15%, 손실 백테스트 초과, forward return 지속 음수
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  PAPER_DIR,
  loadState,
  loadThresholds,
  readJsonl,
  POSITIONS_FILE,
  SIGNALS_FILE,
  FORWARD_RETURNS_FILE,
  SNAPSHOTS_FILE,
  STRATEGIES,
  STRATEGY_SIZE_FRACTION,
  INITIAL_CASH_KRW,
  BACKTEST_F1F2_50_REFERENCE,
  type ClosedPosition,
  type SignalRecord,
  type ForwardReturnRecord,
  type DailySnapshot,
  type StrategyName,
} from '@/lib/paper-trading-store';

const REPORTS_DIR = path.join(PAPER_DIR, 'reports');

function kstDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

interface StrategyStats {
  trades: ClosedPosition[];
  totalReturn: number;
  totalReturnPct: number;
  monthlyReturn: number;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  mdd: number;
  maxLosingStreak: number;
  top3RemovedReturn: number;
}

function statsFor(trades: ClosedPosition[], startedAt: string): StrategyStats {
  const wins = trades.filter((t) => t.profitKrw > 0);
  const losses = trades.filter((t) => t.profitKrw <= 0);
  const totalReturn = trades.reduce((s, t) => s + t.profitKrw, 0);
  const totalReturnPct = totalReturn / INITIAL_CASH_KRW * 100;

  const startDate = new Date(startedAt);
  const days = Math.max(1, (Date.now() - startDate.getTime()) / 86400_000);
  const months = days / 30;
  const monthlyReturn = months > 0 ? totalReturnPct / months : 0;

  const wr = trades.length ? wins.length / trades.length * 100 : 0;
  const totalWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;
  const avgWin = wins.length ? totalWin / wins.length : 0;
  const avgLoss = losses.length ? -totalLoss / losses.length : 0;

  let cash = INITIAL_CASH_KRW;
  const curve: number[] = [cash];
  for (const t of trades) {
    cash += t.profitKrw;
    curve.push(cash);
  }
  let peak = INITIAL_CASH_KRW;
  let mdd = 0;
  for (const c of curve) {
    if (c > peak) peak = c;
    if (peak > 0) {
      const dd = (peak - c) / peak * 100;
      if (dd > mdd) mdd = dd;
    }
  }

  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.profitKrw <= 0) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }

  const sortedByPnl = [...trades].sort((a, b) => b.profitKrw - a.profitKrw);
  const top3 = sortedByPnl.slice(0, 3).reduce((s, t) => s + t.profitKrw, 0);
  const top3Removed = (totalReturn - top3) / INITIAL_CASH_KRW * 100;

  return {
    trades,
    totalReturn,
    totalReturnPct,
    monthlyReturn,
    tradeCount: trades.length,
    winRate: wr,
    profitFactor: pf,
    avgWin,
    avgLoss,
    mdd,
    maxLosingStreak: maxStreak,
    top3RemovedReturn: top3Removed,
  };
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function fmtKrw(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString('en-US')}`;
}
function groupBy<T, K>(arr: T[], keyFn: (x: T) => K | null): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = keyFn(x);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}
function meanRet(rets: number[]): number {
  if (rets.length === 0) return 0;
  return rets.reduce((s, v) => s + v, 0) / rets.length;
}

/**
 * MAIN(F1F2_50) 통과 판정.
 *
 * 라비 명세 §7:
 *   통과: PF≥1.2, 양수, MDD≤12, n≥5, 손실 백테스트 대비 과도하지 않음
 *   보류: PF 1.0~1.2, 약보합, 신호 부족, MDD 안정
 *   폐기: PF<1, MDD≥15, 손실 백테스트 초과, forward return 지속 음수
 */
function judgeMain(
  s: StrategyStats,
  trades: ClosedPosition[],
  forwards: ForwardReturnRecord[],
): { tier: 'PASS' | 'HOLD' | 'DROP'; reasons: string[] } {
  const r: string[] = [];

  // 거래 5건 미만 — 판단 불가, HOLD
  if (s.tradeCount < 5) {
    r.push(`신호 부족 (${s.tradeCount} < 5) — 통계적 판단 불가`);
    return { tier: 'HOLD', reasons: r };
  }

  // 백테스트 손실 대비 과도 체크
  const lossTrades = trades.filter((t) => t.profitKrw <= 0);
  const liveAvgLoss = lossTrades.length
    ? lossTrades.reduce((sum, t) => sum + t.profitRate, 0) / lossTrades.length
    : 0;
  // avgLossPct는 0이 될 수 없는 백테스트 기준 상수
  const lossExcess = liveAvgLoss / BACKTEST_F1F2_50_REFERENCE.avgLossPct;
  // lossExcess > 1.5 means live avg loss is 50%+ worse than backtest
  const lossOverflow = lossExcess > 1.5;

  // forward return 지속 음수 체크 (return_5d 5개 이상 finalized, 평균 음수)
  const fwd5dList = forwards
    .filter((f) => f.return_5d != null)
    .map((f) => f.return_5d as number);
  const fwd5dMean = fwd5dList.length
    ? fwd5dList.reduce((sum, v) => sum + v, 0) / fwd5dList.length
    : 0;
  const fwdNegative = fwd5dList.length >= 5 && fwd5dMean < 0;

  // 폐기
  if (
    s.profitFactor < 1.0 ||
    s.mdd >= 15 ||
    s.totalReturn < -INITIAL_CASH_KRW * 0.1 ||
    lossOverflow ||
    fwdNegative
  ) {
    if (s.profitFactor < 1.0) r.push(`PF<1.0 (${s.profitFactor.toFixed(2)})`);
    if (s.mdd >= 15) r.push(`MDD≥15% (${s.mdd.toFixed(1)}%)`);
    if (lossOverflow) {
      r.push(
        `손실 백테스트 초과 (live avg ${liveAvgLoss.toFixed(2)}% vs ref ${BACKTEST_F1F2_50_REFERENCE.avgLossPct}%, ${lossExcess.toFixed(2)}×)`,
      );
    }
    if (fwdNegative) {
      r.push(`forward 5d 평균 음수 (${fwd5dMean.toFixed(2)}%, n=${fwd5dList.length})`);
    }
    return { tier: 'DROP', reasons: r };
  }

  // 통과
  if (s.profitFactor >= 1.2 && s.totalReturn > 0 && s.mdd <= 12) {
    r.push(
      `PF=${s.profitFactor.toFixed(2)}, MDD=${s.mdd.toFixed(1)}%, n=${s.tradeCount}, avgLoss=${liveAvgLoss.toFixed(2)}% (ref ${BACKTEST_F1F2_50_REFERENCE.avgLossPct}%)`,
    );
    return { tier: 'PASS', reasons: r };
  }

  // 보류
  if (s.profitFactor >= 1.0 && s.profitFactor < 1.2) {
    r.push(`PF 보류구간 (${s.profitFactor.toFixed(2)})`);
  }
  if (s.mdd > 12 && s.mdd < 15) r.push(`MDD 보류구간 (${s.mdd.toFixed(1)}%)`);
  return { tier: 'HOLD', reasons: r };
}

(async () => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const today = kstDate();
  const reportPath = path.join(REPORTS_DIR, `weekly-${today}.md`);

  const state = loadState();
  if (!state) {
    console.log(`state.json 없음. paper-trading-tick.ts를 먼저 실행하세요.`);
    process.exit(1);
  }
  const thresholds = loadThresholds();

  const positions = readJsonl<ClosedPosition>(POSITIONS_FILE);
  const signals = readJsonl<SignalRecord>(SIGNALS_FILE);
  const forwards = readJsonl<ForwardReturnRecord>(FORWARD_RETURNS_FILE);
  const snapshots = readJsonl<DailySnapshot>(SNAPSHOTS_FILE);

  const L: string[] = [];
  L.push(`# Paper Trading Weekly Report — ${today}`);
  L.push('');
  L.push(`- 시작: ${state.startedAt}`);
  L.push(`- 마지막 tick: ${state.lastTickDate ?? 'N/A'}`);
  L.push(`- 자본 비율: F1F2_50=${STRATEGY_SIZE_FRACTION.FUNDING_F1F2_50 * 100}%  F1F2_100=${STRATEGY_SIZE_FRACTION.FUNDING_F1F2_100 * 100}%`);
  L.push(`- Train thresholds (frozen ${thresholds.computedAt.slice(0, 10)}):`);
  L.push(`  - p10_1d=${thresholds.p10_1d.toFixed(4)}  p90_1d=${thresholds.p90_1d.toFixed(4)}`);
  L.push(`  - p10_3d=${thresholds.p10_3d.toFixed(4)}  p90_3d=${thresholds.p90_3d.toFixed(4)}`);
  L.push('');

  // 라비 통과 기준
  L.push(`## 라비 통과 기준 (3개월 후, MAIN=F1F2_50 기준)`);
  L.push('');
  L.push(`| 판정 | 조건 |`);
  L.push(`|------|------|`);
  L.push(`| **통과** | PF≥1.2, 총수익 양수, MDD≤12%, 신호 ≥5, 손실 백테스트 대비 과도하지 않음 |`);
  L.push(`| **보류** | PF 1.0~1.2, 약보합, 신호 부족 / MDD 안정 |`);
  L.push(`| **폐기** | PF<1, MDD≥15%, 손실 백테스트 초과, forward return 지속 음수 |`);
  L.push('');

  // 전략별 성과
  L.push(`## 전략별 성과`);
  L.push('');

  const allStats: Record<StrategyName, StrategyStats> = {} as any;

  for (const sn of STRATEGIES) {
    const trades = positions.filter((p) => p.strategy === sn);
    const s = statsFor(trades, state.startedAt);
    allStats[sn] = s;
    const st = state.strategies[sn];
    const lastSignal = signals.filter((sig) => sig.strategyName === sn).slice(-1)[0];

    L.push(`### ${sn} ${sn === 'FUNDING_F1F2_50' ? '(MAIN 판정용)' : '(BENCHMARK)'}`);
    L.push('');
    if (sn === 'FUNDING_F1F2_50') {
      const j = judgeMain(s, trades, forwards.filter((f) => f.strategyName === sn));
      const emoji = j.tier === 'PASS' ? '✓' : j.tier === 'DROP' ? '✗' : '⚠';
      L.push(`**현재 판정: ${emoji} ${j.tier}**${j.reasons.length ? ` — ${j.reasons.join(', ')}` : ''}`);
      L.push('');
    }
    L.push(`| 지표 | 값 |`);
    L.push(`|------|----|`);
    L.push(`| Total Return | ${fmtPct(s.totalReturnPct)} (${fmtKrw(s.totalReturn)} KRW) |`);
    L.push(`| Monthly Return | ${fmtPct(s.monthlyReturn)} |`);
    L.push(`| Trade Count | ${s.tradeCount} |`);
    L.push(`| Win Rate | ${s.winRate.toFixed(0)}% |`);
    L.push(`| Profit Factor | ${s.profitFactor.toFixed(2)} |`);
    L.push(`| Avg Win | ${fmtKrw(s.avgWin)} |`);
    L.push(`| Avg Loss | ${fmtKrw(s.avgLoss)} |`);
    L.push(`| Max Drawdown | ${s.mdd.toFixed(1)}% |`);
    L.push(`| Max Losing Streak | ${s.maxLosingStreak} |`);
    L.push(`| Top3 Removed Return | ${fmtPct(s.top3RemovedReturn)} |`);
    L.push(`| Current Cash | ${fmtKrw(st.cash)} KRW |`);
    L.push(`| Current Position | ${st.position ? `${st.position.signal} entry=${st.position.entryDate}@${st.position.entryPrice.toFixed(0)} d${st.position.daysHeld}` : 'none'} |`);
    L.push(`| Last Signal | ${lastSignal ? `${lastSignal.signalLabel} on ${lastSignal.signalDate} (executed=${lastSignal.entryExecuted})` : 'none yet'} |`);
    L.push(`| Next Expected Action | ${st.position ? `청산 조건 모니터` : '신호 대기'} |`);
    L.push('');
  }

  // 50 vs 100 비교
  L.push(`## FUNDING_F1F2_50 vs FUNDING_F1F2_100 비교`);
  L.push('');
  L.push(`| 지표 | F1F2_50 | F1F2_100 | 차이 |`);
  L.push(`|------|---------|----------|------|`);
  const s50 = allStats.FUNDING_F1F2_50;
  const s100 = allStats.FUNDING_F1F2_100;
  const diff = (a: number, b: number) => fmtPct(a - b);
  L.push(`| Total Return | ${fmtPct(s50.totalReturnPct)} | ${fmtPct(s100.totalReturnPct)} | ${diff(s50.totalReturnPct, s100.totalReturnPct)} |`);
  L.push(`| PF | ${s50.profitFactor.toFixed(2)} | ${s100.profitFactor.toFixed(2)} | ${(s50.profitFactor - s100.profitFactor).toFixed(2)} |`);
  L.push(`| MDD | ${s50.mdd.toFixed(1)}% | ${s100.mdd.toFixed(1)}% | ${(s50.mdd - s100.mdd).toFixed(1)}%p |`);
  L.push(`| Top3 Removed | ${fmtPct(s50.top3RemovedReturn)} | ${fmtPct(s100.top3RemovedReturn)} | ${diff(s50.top3RemovedReturn, s100.top3RemovedReturn)} |`);
  L.push(`| Trade Count | ${s50.tradeCount} | ${s100.tradeCount} | ${s50.tradeCount - s100.tradeCount} |`);
  L.push('');

  // 메타 분석
  L.push(`## 메타 분석 (필터 사용 X, 기록만)`);
  L.push('');

  L.push(`### Volatility regime별 forward return (1d/3d/5d)`);
  L.push('');
  L.push(`| Regime | n | 1d 평균 | 3d 평균 | 5d 평균 |`);
  L.push(`|--------|---|---------|---------|---------|`);
  const byVol = groupBy(forwards, (f) => f.volatilityRegimeAtSignal);
  for (const regime of ['LOW', 'MID', 'HIGH', 'EXTREME']) {
    const items = byVol.get(regime as any) ?? [];
    const r1 = items.map((i) => i.return_1d).filter((v): v is number => v != null);
    const r3 = items.map((i) => i.return_3d).filter((v): v is number => v != null);
    const r5 = items.map((i) => i.return_5d).filter((v): v is number => v != null);
    L.push(`| ${regime} | ${items.length} | ${r1.length ? fmtPct(meanRet(r1)) : '-'} | ${r3.length ? fmtPct(meanRet(r3)) : '-'} | ${r5.length ? fmtPct(meanRet(r5)) : '-'} |`);
  }
  L.push('');

  L.push(`### Stablecoin 1d 부호별 forward 5d return`);
  L.push('');
  L.push(`| state | n | 5d 평균 |`);
  L.push(`|-------|---|---------|`);
  const byStable = groupBy(forwards, (f) => {
    const c1d = f.stablecoinStateAtSignal.c1d;
    if (c1d == null) return null;
    if (c1d > 0.1) return 'EXPAND';
    if (c1d < -0.1) return 'CONTRACT';
    return 'FLAT';
  });
  for (const state of ['EXPAND', 'FLAT', 'CONTRACT']) {
    const items = byStable.get(state) ?? [];
    const r5 = items.map((i) => i.return_5d).filter((v): v is number => v != null);
    L.push(`| ${state} | ${items.length} | ${r5.length ? fmtPct(meanRet(r5)) : '-'} |`);
  }
  L.push('');

  // 최근 snapshot
  L.push(`## 최근 snapshot (10일)`);
  L.push('');
  L.push(`| date | funding | intensity | signal | F1F2_50 | F1F2_100 | vol | btc | stable c1d |`);
  L.push(`|------|---------|-----------|--------|---------|----------|-----|-----|------------|`);
  for (const snap of snapshots.slice(-10)) {
    const f = snap.funding_rate != null ? snap.funding_rate.toFixed(3) + '%' : '-';
    const fi = snap.funding_intensity != null ? snap.funding_intensity.toFixed(2) : '-';
    L.push(`| ${snap.date} | ${f} | ${fi} | ${snap.strategy_signal} | ${snap.position_state.FUNDING_F1F2_50} | ${snap.position_state.FUNDING_F1F2_100} | ${snap.volatility_regime ?? '-'} | ${snap.btc_trend_state ?? '-'} | ${snap.stablecoin_1d_change?.toFixed(2) ?? '-'}% |`);
  }
  L.push('');

  L.push(`---`);
  L.push(`*Generated ${new Date().toISOString()}*`);

  fs.writeFileSync(reportPath, L.join('\n'));
  console.log(`Report saved: ${reportPath}`);
  console.log(`\n--- Preview ---\n`);
  console.log(L.slice(0, 40).join('\n'));
  console.log(`...`);
  process.exit(0);
})();
