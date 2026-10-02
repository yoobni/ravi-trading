/**
 * Paper trading 주간/월간 리포트.
 *
 * `--asof YYYY-MM-DD` 를 주면 그 시점 기준으로 소급 재구성한다 (미생성 주간 리포트 백필용).
 *   - 거래/신호/스냅샷은 그 날짜 이하만 사용
 *   - F1F2 현금·평가액은 그 날 daily-snapshot 의 strategy_metrics 사용
 *   - F6 계열은 ticks.jsonl + trades.jsonl 로 그 시점 상태 재구성 (paper-asof.ts)
 *   - 보유 포지션은 리포트 기존 관례대로 entryPrice 기준 평가(보수적)
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
import { F6_STATE_FILE, F6_TRADES_FILE, F6_TICKS_FILE, F6_INITIAL_CASH_KRW, F6_FEE, F6_MAX_BARS } from '@/lib/paper-f6-store';
import { F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_TICKS_FILE, F6V6_INITIAL_CASH_KRW, F6V6_FEE, F6V6_MAX_BARS } from '@/lib/paper-f6v6-store';
import { SIMPLE_STRATEGIES } from '@/lib/paper-registry';
import { F7_VARIANTS, F7_INITIAL_CASH_KRW, F7_FEE, f7Files } from '@/lib/paper-f7-store';
import { f6StateAsOf } from '@/lib/paper-asof';
import {
  computeStrategyMetrics, computePortfolio, PASS_LABEL,
  type ClosedTradeLite,
} from '@/lib/paper-metrics';

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

  const asofArg = (() => {
    const i = process.argv.indexOf('--asof');
    if (i < 0) return null;
    const d = process.argv[i + 1];
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('--asof 뒤에 YYYY-MM-DD 가 필요함');
    return d;
  })();
  const today = asofArg ?? kstDate();
  const cutoffTs = asofArg ? Date.parse(`${asofArg}T23:59:59+09:00`) : Date.now();
  const reportPath = path.join(REPORTS_DIR, `weekly-${today}.md`);

  const state = loadState();
  if (!state) {
    console.log(`state.json 없음. paper-trading-tick.ts를 먼저 실행하세요.`);
    process.exit(1);
  }
  const thresholds = loadThresholds();

  const upto = <T>(rows: T[], date: (r: T) => string | undefined) =>
    asofArg ? rows.filter((r) => (date(r) ?? '9999') <= asofArg) : rows;

  const positions = upto(readJsonl<ClosedPosition>(POSITIONS_FILE), (p) => p.exitDate);
  const signals = upto(readJsonl<SignalRecord>(SIGNALS_FILE), (s) => s.signalDate);
  const snapshots = upto(readJsonl<DailySnapshot>(SNAPSHOTS_FILE), (s) => s.date);

  // forward return 은 신호 며칠 뒤에 채워지므로 signalDate 만으로 자르면 미래 정보가 섞인다.
  // as-of 모드에선 관측 구간(신호시각 + 지평)이 cutoff 를 넘는 값은 null 로 지운다.
  const clipForward = (f: ForwardReturnRecord): ForwardReturnRecord => {
    if (!asofArg) return f;
    const t0 = Date.parse(f.signalTime);
    const known = <T>(v: T, horizonMs: number): T | null => (t0 + horizonMs <= cutoffTs ? v : null);
    const exitKnown = Date.parse(f.lastUpdated) <= cutoffTs;
    return {
      ...f,
      return_1h: known(f.return_1h, 3600_000),
      return_4h: known(f.return_4h, 4 * 3600_000),
      return_1d: known(f.return_1d, 86400_000),
      return_3d: known(f.return_3d, 3 * 86400_000),
      return_5d: known(f.return_5d, 5 * 86400_000),
      return_until_exit_rule: exitKnown ? f.return_until_exit_rule : null,
      exitRuleTriggered: exitKnown ? f.exitRuleTriggered : null,
    };
  };
  const forwards = upto(readJsonl<ForwardReturnRecord>(FORWARD_RETURNS_FILE), (f) => f.signalDate).map(clipForward);

  /**
   * F1F2 의 기준 시점 현금/보유 평가액.
   *   - 라이브: 기존과 동일하게 state + entryPrice(buyAmount) 기준 (보수적)
   *   - as-of: 그 날 daily-snapshot 의 strategy_metrics (cash / equity−cash = 그 날 종가 평가)
   *            스냅샷이 없으면 started=false — 그 시점 상태를 알 수 없으므로 리포트에서 제외
   */
  const asofSnap = asofArg ? snapshots[snapshots.length - 1] : null;
  const f1f2AsOf = (sn: StrategyName): { started: boolean; cash: number; positionValue: number; marked: boolean } => {
    if (!asofArg) {
      const pos = state.strategies[sn].position;
      return { started: true, cash: state.strategies[sn].cash, positionValue: pos ? pos.buyAmount : 0, marked: false };
    }
    const m = asofSnap?.strategy_metrics?.[sn];
    if (!m) return { started: false, cash: 0, positionValue: 0, marked: true };
    return { started: true, cash: m.cash, positionValue: Math.max(0, m.equity - m.cash), marked: true };
  };
  /** as-of 모드에서 그 시점 열려 있던 F1F2 포지션 (청산기록 or 현재 보유에서 찾음) */
  const f1f2OpenAsOf = (sn: StrategyName) => {
    if (!asofArg) return state.strategies[sn].position;
    const held = readJsonl<ClosedPosition>(POSITIONS_FILE)
      .find((p) => p.strategy === sn && p.entryDate <= asofArg && p.exitDate > asofArg);
    if (held) return { signal: held.signal, entryDate: held.entryDate, entryPrice: held.entryPrice, vol: 0, buyAmount: 0, daysHeld: 0 } as any;
    const cur = state.strategies[sn].position;
    return cur && cur.entryDate <= asofArg ? cur : null;
  };

  const L: string[] = [];
  L.push(`# Paper Trading Weekly Report — ${today}`);
  L.push('');
  L.push(`- 시작: ${state.startedAt}`);
  L.push(`- 마지막 tick: ${asofArg ?? state.lastTickDate ?? 'N/A'}`);
  if (asofArg) L.push(`- ⚠️ 소급 재구성 리포트 (${asofArg} 기준, ${kstDate()} 생성) — forward return 은 그날까지 관측 가능한 값만 사용`);
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
    const stAsOf = f1f2AsOf(sn);
    const posAsOf = f1f2OpenAsOf(sn);
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
    L.push(`| Current Cash | ${stAsOf.started ? `${fmtKrw(stAsOf.cash)} KRW` : '해당 시점 기록 없음'} |`);
    L.push(`| Current Position | ${posAsOf ? `${posAsOf.signal} entry=${posAsOf.entryDate}@${posAsOf.entryPrice.toFixed(0)}` : 'none'} |`);
    L.push(`| Last Signal | ${lastSignal ? `${lastSignal.signalLabel} on ${lastSignal.signalDate} (executed=${lastSignal.entryExecuted})` : 'none yet'} |`);
    L.push(`| Next Expected Action | ${posAsOf ? `청산 조건 모니터` : '신호 대기'} |`);
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

  // ─── 전 전략 + 합성 포트폴리오 통과기준 현황 ───
  // (open 포지션은 entryPrice 기준 = 보수적. 실현 지표 PF/WR/MDD는 trades 기반 정확)
  const f1f2TradesOf = (sn: StrategyName): ClosedTradeLite[] => positions
    .filter((t) => t.strategy === sn)
    .map((t) => ({ profitKrw: t.profitKrw, exitTs: Date.parse(t.exitDate) }));
  const f1f2Trades = f1f2TradesOf('FUNDING_F1F2_50');
  const f1f2Trades100 = f1f2TradesOf('FUNDING_F1F2_100');
  const f6AsOf = (stateFile: string, ticksFile: string, tradesFile: string, fee: number, maxBars: number) =>
    f6StateAsOf({ stateFile, ticksFile, tradesFile, fee, maxBars }, cutoffTs);
  const f6A   = f6AsOf(F6_STATE_FILE,   F6_TICKS_FILE,   F6_TRADES_FILE,   F6_FEE,   F6_MAX_BARS);
  const f6v6A = f6AsOf(F6V6_STATE_FILE, F6V6_TICKS_FILE, F6V6_TRADES_FILE, F6V6_FEE, F6V6_MAX_BARS);
  const f6Trades = (a: typeof f6A): ClosedTradeLite[] => a.closedTrades.map((t) => ({ profitKrw: t.profitKrw, exitTs: t.exitTs }));

  /** F1F2: as-of 평가액은 스냅샷의 equity−cash 로 (entryPrice 기준 평가와 동일 효과) */
  const f1f2Row = (sn: StrategyName, trades: ClosedTradeLite[]) => {
    const { started, cash, positionValue } = f1f2AsOf(sn);
    return {
      id: sn === 'FUNDING_F1F2_50' ? 'F1F2_50' : 'F1F2_100',
      // F1F2_100 은 F1F2_50 과 동일 신호의 사이징 비교군(상관 ≈ 1) → 표에는 두고 합성에서는 제외
      benchmark: sn === 'FUNDING_F1F2_100',
      started,
      initial: INITIAL_CASH_KRW,
      cash,
      positions: positionValue > 0 ? [{ cashUsed: positionValue, vol: 1, entryPrice: positionValue }] : [],
      trades,
    };
  };

  const rows = [
    f1f2Row('FUNDING_F1F2_50', f1f2Trades),
    f1f2Row('FUNDING_F1F2_100', f1f2Trades100),
    { id: 'F6',    benchmark: false, started: !!f6A.anchor,   initial: F6_INITIAL_CASH_KRW,   cash: f6A.cash,   positions: f6A.positions,   trades: f6Trades(f6A) },
    { id: 'F6_v6', benchmark: false, started: !!f6v6A.anchor, initial: F6V6_INITIAL_CASH_KRW, cash: f6v6A.cash, positions: f6v6A.positions, trades: f6Trades(f6v6A) },
    ...F7_VARIANTS.map((v) => {
      const f = f7Files(v);
      const a = f6AsOf(f.state, f.ticks, f.trades, F7_FEE, v.maxBars);
      return { id: v.id, benchmark: false, started: !!a.anchor, initial: F7_INITIAL_CASH_KRW, cash: a.cash, positions: a.positions, trades: f6Trades(a) };
    }),
    ...SIMPLE_STRATEGIES.map((d) => {
      const a = f6AsOf(d.state, d.ticks, d.trades, d.fee, 0);
      return { id: d.id, benchmark: false, started: !!a.anchor, initial: d.initial, cash: a.cash, positions: a.positions, trades: f6Trades(a) };
    }),
  ];
  const skipped = rows.filter((r) => !r.started).map((r) => r.id);
  const activeRows = rows.filter((r) => r.started);   // 그 시점에 tick/스냅샷이 없는 전략은 제외

  L.push(`## 전 전략 통과기준 현황 (PF≥1.2 & total>0)`);
  L.push('');
  L.push(`| 전략 | total | PF | WR | 실현MDD | 거래 | 판정 |`);
  L.push(`|------|-------|----|----|---------|------|------|`);
  const portfolioInputs: Array<{ initial: number; equity: number; trades: ClosedTradeLite[] }> = [];
  for (const r of activeRows) {
    const m = computeStrategyMetrics({ initial: r.initial, cash: r.cash, positions: r.positions, trades: r.trades });
    if (!r.benchmark) portfolioInputs.push({ initial: r.initial, equity: m.equity, trades: r.trades });
    L.push(`| ${r.id}${r.benchmark ? ' (벤치마크)' : ''} | ${fmtPct(m.totalReturn)} | ${m.pf.toFixed(2)} | ${m.wr.toFixed(0)}% | ${m.realizedMdd.toFixed(1)}% | ${m.trades} | ${PASS_LABEL[m.passStatus]} |`);
  }
  const pf = computePortfolio(portfolioInputs);
  L.push('');
  const benchIds = activeRows.filter((r) => r.benchmark).map((r) => r.id);
  L.push(`**합성 포트폴리오** (운영 ${activeRows.length - benchIds.length}전략 · 자본 ${(pf.initial / 1e4).toLocaleString()}만원): total ${fmtPct(pf.totalReturn)} · 실현MDD ${pf.realizedMdd.toFixed(1)}% · 누적 ${pf.trades}건`);
  if (benchIds.length) L.push(`> ${benchIds.join(', ')} 는 F1F2_50 과 동일 신호의 사이징 비교군(상관 ≈ 1) → 표에만 표시하고 합성에서는 제외.`);
  L.push(`> F1F2↔F6 무상관(백테스트 0.08~0.16) → 합성 MDD가 개별 합보다 낮은 게 정상.`);
  L.push(`> open 포지션 평가: ${asofArg ? 'F1F2 는 해당일 스냅샷 종가 평가, F6 계열은 entryPrice 기준' : 'entryPrice 기준(보수적)'}.`);
  if (skipped.length) L.push(`> ⚠️ ${skipped.join(', ')} — 해당 시점 기록(tick/스냅샷) 없어 표·합성에서 제외.`);
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
