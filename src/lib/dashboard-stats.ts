import fs from 'fs';
import path from 'path';
import type { Order } from '@/types/order';
import type {
  PerformanceSummary,
  DailyStats,
  MarketStats,
  DashboardData,
  DashboardQueryOptions,
  DrawdownPeriod,
} from '@/types/dashboard';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const BALANCE_FILE = path.join(DATA_DIR, 'balance.json');

// ──────────────────────────────────────────────
// 내부 유틸
// ──────────────────────────────────────────────

/** 주문 파일 로드 (읽기 전용) */
function loadOrders(): Order[] {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
  return JSON.parse(raw) as Order[];
}

/** 잔고 파일에서 초기 자본 조회 */
function getInitialCapital(): number {
  if (!fs.existsSync(BALANCE_FILE)) return 10_000_000;
  const raw = fs.readFileSync(BALANCE_FILE, 'utf-8');
  const data = JSON.parse(raw) as { initialCapital: number };
  return data.initialCapital;
}

/** 청산 완료된 매도 주문 + 연결된 매수 주문 쌍 추출 */
interface ClosedTrade {
  buyOrder: Order;
  sellOrder: Order;
  pnl: number;       // 실현 손익 (KRW)
  returnRate: number; // 수익률 (%)
  holdingMs: number;  // 보유 기간 (ms)
}

function getClosedTrades(orders: Order[]): ClosedTrade[] {
  const orderMap = new Map<string, Order>();
  for (const o of orders) {
    orderMap.set(o.id, o);
  }

  const trades: ClosedTrade[] = [];

  for (const sell of orders) {
    if (sell.side !== 'sell' || sell.status !== 'filled' || !sell.linkedOrderId) continue;
    const buy = orderMap.get(sell.linkedOrderId);
    if (!buy || buy.side !== 'buy' || buy.status !== 'filled') continue;

    // 수수료 반영 실현 손익: 매도 수령액(settlement) - 매수 지출액(settlement)
    const buyCost = buy.settlement ?? (buy.totalAmount + (buy.fee ?? 0));
    const sellReceipt = sell.settlement ?? (sell.totalAmount - (sell.fee ?? 0));
    const pnl = sellReceipt - buyCost;
    const returnRate = buyCost > 0
      ? Math.round((pnl / buyCost) * 100 * 100) / 100
      : (sell.profitRate ?? 0);

    const buyTime = new Date(buy.filledAt ?? buy.createdAt).getTime();
    const sellTime = new Date(sell.filledAt ?? sell.createdAt).getTime();

    trades.push({
      buyOrder: buy,
      sellOrder: sell,
      pnl: Math.round(pnl),
      returnRate,
      holdingMs: Math.max(sellTime - buyTime, 0),
    });
  }

  // 매도 시각 오름차순 정렬
  trades.sort((a, b) => {
    const tA = new Date(a.sellOrder.filledAt ?? a.sellOrder.createdAt).getTime();
    const tB = new Date(b.sellOrder.filledAt ?? b.sellOrder.createdAt).getTime();
    return tA - tB;
  });

  return trades;
}

/** 날짜 문자열에서 YYYY-MM-DD 추출 */
function toDateStr(isoStr: string): string {
  return isoStr.slice(0, 10);
}

/** 기간 필터 적용 */
function filterByDateRange(
  trades: ClosedTrade[],
  options?: DashboardQueryOptions,
): ClosedTrade[] {
  let filtered = trades;

  if (options?.fromDate) {
    filtered = filtered.filter(
      (t) => toDateStr(t.sellOrder.filledAt ?? t.sellOrder.createdAt) >= options.fromDate!,
    );
  }
  if (options?.toDate) {
    filtered = filtered.filter(
      (t) => toDateStr(t.sellOrder.filledAt ?? t.sellOrder.createdAt) <= options.toDate!,
    );
  }
  if (options?.market) {
    filtered = filtered.filter((t) => t.buyOrder.market === options.market);
  }

  return filtered;
}

// ──────────────────────────────────────────────
// 최대 낙폭 (Max Drawdown) 계산
// ──────────────────────────────────────────────

function calculateMaxDrawdown(
  trades: ClosedTrade[],
  initialCapital: number,
): { maxDrawdown: number; period: DrawdownPeriod | null } {
  if (trades.length === 0) return { maxDrawdown: 0, period: null };

  // 거래 순서대로 누적 자산 추적
  let cumulative = initialCapital;
  let peak = initialCapital;
  let peakAt = trades[0].sellOrder.filledAt ?? trades[0].sellOrder.createdAt;

  let maxDd = 0;
  let ddPeriod: DrawdownPeriod | null = null;

  for (const trade of trades) {
    cumulative += trade.pnl;
    const sellTime = trade.sellOrder.filledAt ?? trade.sellOrder.createdAt;

    if (cumulative > peak) {
      peak = cumulative;
      peakAt = sellTime;
    }

    if (peak > 0) {
      const dd = ((cumulative - peak) / peak) * 100;
      if (dd < maxDd) {
        maxDd = dd;
        ddPeriod = {
          peakAt,
          troughAt: sellTime,
          peakValue: Math.round(peak),
          troughValue: Math.round(cumulative),
          drawdownRate: Math.round(dd * 100) / 100,
        };
      }
    }
  }

  return {
    maxDrawdown: Math.round(maxDd * 100) / 100,
    period: ddPeriod,
  };
}

// ──────────────────────────────────────────────
// 샤프 비율 계산
// ──────────────────────────────────────────────

/**
 * 일별 수익률 기반 샤프 비율 (연환산).
 * 무위험수익률: 한국 3년물 국채 수준 약 3.5% → 일별 ≈ 0.00958%
 */
const ANNUAL_RISK_FREE_RATE = 0.035;
const TRADING_DAYS_PER_YEAR = 365; // 암호화폐는 365일 거래

function calculateSharpeRatio(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2) return null;

  const dailyRfr = ANNUAL_RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;

  // 초과 수익률
  const excessReturns = dailyReturns.map((r) => r / 100 - dailyRfr);

  const mean = excessReturns.reduce((s, v) => s + v, 0) / excessReturns.length;

  const variance =
    excessReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (excessReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return null;

  const sharpe = (mean / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return Math.round(sharpe * 100) / 100;
}

// ──────────────────────────────────────────────
// 전체 성과 요약
// ──────────────────────────────────────────────

export function getPerformanceSummary(options?: DashboardQueryOptions): PerformanceSummary {
  const orders = loadOrders();
  const initialCapital = getInitialCapital();
  const allTrades = getClosedTrades(orders);
  const trades = filterByDateRange(allTrades, options);

  const winTrades = trades.filter((t) => t.returnRate > 0);
  const lossTrades = trades.filter((t) => t.returnRate <= 0);

  const totalRealizedPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // 미실현 손익: 미매도 매수 포지션 (현재가 미반영이므로 0)
  // 실제 운영 시 현재가를 받아서 계산해야 함
  const totalUnrealizedPnl = 0;

  const currentAssets = initialCapital + totalRealizedPnl + totalUnrealizedPnl;
  const totalReturnRate =
    initialCapital > 0
      ? Math.round(((currentAssets - initialCapital) / initialCapital) * 100 * 100) / 100
      : 0;

  const avgReturnRate =
    trades.length > 0
      ? Math.round((trades.reduce((s, t) => s + t.returnRate, 0) / trades.length) * 100) / 100
      : 0;

  const avgWinRate =
    winTrades.length > 0
      ? Math.round((winTrades.reduce((s, t) => s + t.returnRate, 0) / winTrades.length) * 100) / 100
      : 0;

  const avgLossRate =
    lossTrades.length > 0
      ? Math.round((lossTrades.reduce((s, t) => s + t.returnRate, 0) / lossTrades.length) * 100) / 100
      : 0;

  const profitLossRatio =
    avgLossRate !== 0
      ? Math.round((Math.abs(avgWinRate) / Math.abs(avgLossRate)) * 100) / 100
      : null;

  const winRate =
    trades.length > 0
      ? Math.round((winTrades.length / trades.length) * 100 * 100) / 100
      : 0;

  // 최대 낙폭
  const { maxDrawdown, period: maxDrawdownPeriod } = calculateMaxDrawdown(trades, initialCapital);

  // 샤프 비율: 일별 수익률 계산
  const dailyMap = new Map<string, number>();
  for (const t of trades) {
    const dateKey = toDateStr(t.sellOrder.filledAt ?? t.sellOrder.createdAt);
    dailyMap.set(dateKey, (dailyMap.get(dateKey) ?? 0) + t.pnl);
  }
  const dailyReturns = Array.from(dailyMap.values()).map(
    (pnl) => (pnl / initialCapital) * 100,
  );
  const sharpeRatio = calculateSharpeRatio(dailyReturns);

  // 총 거래 횟수 (매수+매도 쌍 기준 일관 적용)
  const totalTradeCount = trades.length;

  // 총 수수료 (매수+매도 fee 합산)
  const totalFeesPaid = allTrades.reduce((sum, t) => {
    return sum + (t.buyOrder.fee ?? 0) + (t.sellOrder.fee ?? 0);
  }, 0);

  return {
    initialCapital,
    currentAssets: Math.round(currentAssets),
    totalReturnRate,
    totalRealizedPnl: Math.round(totalRealizedPnl),
    totalUnrealizedPnl: Math.round(totalUnrealizedPnl),
    winRate,
    winCount: winTrades.length,
    lossCount: lossTrades.length,
    avgReturnRate,
    avgWinRate,
    avgLossRate,
    profitLossRatio,
    maxDrawdown,
    maxDrawdownPeriod,
    sharpeRatio,
    totalTradeCount,
    closedTradeCount: trades.length,
    totalFeesPaid: Math.round(totalFeesPaid),
    calculatedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// 일별 통계
// ──────────────────────────────────────────────

export function getDailyStats(options?: DashboardQueryOptions): DailyStats[] {
  const orders = loadOrders();
  const initialCapital = getInitialCapital();
  const allTrades = getClosedTrades(orders);
  const trades = filterByDateRange(allTrades, options);

  // 일별 그룹핑
  const dailyGrouped = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const dateKey = toDateStr(t.sellOrder.filledAt ?? t.sellOrder.createdAt);
    const arr = dailyGrouped.get(dateKey) ?? [];
    arr.push(t);
    dailyGrouped.set(dateKey, arr);
  }

  // 날짜순 정렬된 키
  const sortedDates = Array.from(dailyGrouped.keys()).sort();

  let cumulativePnl = 0;
  const result: DailyStats[] = [];

  for (const date of sortedDates) {
    const dayTrades = dailyGrouped.get(date)!;
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter((t) => t.returnRate > 0);
    const dayReturnRate =
      initialCapital > 0
        ? Math.round((dayPnl / initialCapital) * 100 * 100) / 100
        : 0;

    cumulativePnl += dayPnl;

    result.push({
      date,
      tradeCount: dayTrades.length,
      realizedPnl: Math.round(dayPnl),
      returnRate: dayReturnRate,
      winRate:
        dayTrades.length > 0
          ? Math.round((dayWins.length / dayTrades.length) * 100 * 100) / 100
          : 0,
      winCount: dayWins.length,
      lossCount: dayTrades.length - dayWins.length,
      cumulativeAssets: Math.round(initialCapital + cumulativePnl),
    });
  }

  // 최신순 정렬
  result.reverse();

  const limit = options?.dailyLimit ?? 30;
  return result.slice(0, limit);
}

// ──────────────────────────────────────────────
// 종목별 통계
// ──────────────────────────────────────────────

export function getMarketStats(options?: DashboardQueryOptions): MarketStats[] {
  const orders = loadOrders();
  const allTrades = getClosedTrades(orders);
  const trades = filterByDateRange(allTrades, options);

  // 종목별 그룹핑
  const marketGrouped = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const market = t.buyOrder.market;
    const arr = marketGrouped.get(market) ?? [];
    arr.push(t);
    marketGrouped.set(market, arr);
  }

  const result: MarketStats[] = [];

  for (const [market, mTrades] of marketGrouped) {
    const wins = mTrades.filter((t) => t.returnRate > 0);
    const totalPnl = mTrades.reduce((s, t) => s + t.pnl, 0);
    const avgReturn =
      mTrades.length > 0
        ? mTrades.reduce((s, t) => s + t.returnRate, 0) / mTrades.length
        : 0;

    const returns = mTrades.map((t) => t.returnRate);
    const avgHoldingHours =
      mTrades.length > 0
        ? mTrades.reduce((s, t) => s + t.holdingMs, 0) / mTrades.length / (1000 * 60 * 60)
        : 0;

    result.push({
      market,
      tradeCount: mTrades.length,
      totalPnl: Math.round(totalPnl),
      avgReturnRate: Math.round(avgReturn * 100) / 100,
      winRate:
        mTrades.length > 0
          ? Math.round((wins.length / mTrades.length) * 100 * 100) / 100
          : 0,
      winCount: wins.length,
      lossCount: mTrades.length - wins.length,
      bestReturn: returns.length > 0 ? Math.max(...returns) : 0,
      worstReturn: returns.length > 0 ? Math.min(...returns) : 0,
      avgHoldingHours: Math.round(avgHoldingHours * 100) / 100,
    });
  }

  // 수익순 정렬
  result.sort((a, b) => b.totalPnl - a.totalPnl);
  return result;
}

// ──────────────────────────────────────────────
// 대시보드 전체 데이터 (통합 조회)
// ──────────────────────────────────────────────

export function getDashboardData(options?: DashboardQueryOptions): DashboardData {
  return {
    summary: getPerformanceSummary(options),
    dailyStats: getDailyStats(options),
    marketStats: getMarketStats(options),
  };
}
