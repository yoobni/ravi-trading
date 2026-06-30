/**
 * Paper 전략 공통 지표 계산 — 대시보드 API + 주간 리포트가 공유.
 *
 * 통과 기준(라비): PF≥1.2 && total>0 (분기 walk-forward는 별도 백테스트).
 * MDD는 trades 기반 "실현 MDD" (tick에 포지션 평가액이 없어 마크투마켓 불가 → 정직하게 실현 기준).
 */

export type PassStatus = 'on-track' | 'hold' | 'fail' | 'insufficient';

export interface ClosedTradeLite {
  profitKrw: number;
  exitTs: number;
}

export interface PositionLite {
  cashUsed: number;
  vol: number;
  entryPrice: number;
  market?: string;
}

export interface StrategyMetrics {
  totalReturn: number;   // 현재 자산 기준 (open 포함, currentPrices 있을 때 mark-to-market)
  equity: number;
  realizedPnl: number;
  trades: number;
  wins: number;
  wr: number;            // %
  pf: number;            // profit factor
  realizedMdd: number;   // % (실현 손익 곡선 기준)
  passStatus: PassStatus;
}

/** 통과 기준 판정에 필요한 최소 거래 표본 (이하면 '표본부족' — 노이즈 구간) */
export const MIN_TRADES_FOR_VERDICT = 10;

export function classifyPass(pf: number, totalReturn: number, trades: number): PassStatus {
  if (trades < MIN_TRADES_FOR_VERDICT) return 'insufficient';
  if (pf >= 1.2 && totalReturn > 0) return 'on-track';
  if (pf >= 1.0) return 'hold';
  return 'fail';
}

export const PASS_LABEL: Record<PassStatus, string> = {
  'on-track': '통과 궤도',
  hold: '보류',
  fail: '미달',
  insufficient: '표본부족',
};

/** 실현 손익 곡선의 MDD(%) — exitTs 정렬 후 누적. */
export function realizedMdd(initial: number, trades: ClosedTradeLite[]): number {
  if (!trades.length) return 0;
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  let eq = initial, peak = initial, mdd = 0;
  for (const t of sorted) {
    eq += t.profitKrw;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

export function computeStrategyMetrics(opts: {
  initial: number;
  cash: number;
  positions: PositionLite[];
  trades: ClosedTradeLite[];
  currentPrices?: Map<string, number>;
}): StrategyMetrics {
  const { initial, cash, positions, trades, currentPrices } = opts;

  let positionValue = 0;
  for (const p of positions) {
    const cur = (p.market && currentPrices?.get(p.market)) || p.entryPrice;
    positionValue += p.vol * cur;
  }
  const equity = cash + positionValue;
  const totalReturn = (equity - initial) / initial * 100;

  const wins = trades.filter((t) => t.profitKrw > 0);
  const winSum = wins.reduce((s, t) => s + t.profitKrw, 0);
  const lossSum = Math.abs(trades.filter((t) => t.profitKrw <= 0).reduce((s, t) => s + t.profitKrw, 0));
  const pf = lossSum > 0 ? winSum / lossSum : winSum > 0 ? 99 : 0;
  const realizedPnl = trades.reduce((s, t) => s + t.profitKrw, 0);
  const mdd = realizedMdd(initial, trades);

  return {
    totalReturn,
    equity,
    realizedPnl,
    trades: trades.length,
    wins: wins.length,
    wr: trades.length ? wins.length / trades.length * 100 : 0,
    pf,
    realizedMdd: mdd,
    passStatus: classifyPass(pf, totalReturn, trades.length),
  };
}

export interface PortfolioMetrics {
  initial: number;
  equity: number;
  totalReturn: number;
  realizedMdd: number;   // 전 전략 trade 통합 타임라인 기준
  trades: number;
}

/**
 * 합성 포트폴리오 — 전 전략 통합. 무상관(백테스트 0.08~0.16)이라 합성 MDD가
 * 개별 합보다 낮은 게 정상. 통합 trade 타임라인으로 실현 MDD 계산.
 */
export function computePortfolio(
  strategies: Array<{ initial: number; equity: number; trades: ClosedTradeLite[] }>,
): PortfolioMetrics {
  const initial = strategies.reduce((s, x) => s + x.initial, 0);
  const equity = strategies.reduce((s, x) => s + x.equity, 0);
  const allTrades = strategies.flatMap((x) => x.trades);
  return {
    initial,
    equity,
    totalReturn: initial > 0 ? (equity - initial) / initial * 100 : 0,
    realizedMdd: realizedMdd(initial, allTrades),
    trades: allTrades.length,
  };
}
