/**
 * 활동 타임라인 통합 서비스
 *
 * 기존 데이터 소스(사이클 로그, AI 판단, 주문, 리스크 이벤트)를
 * 시간순 통합 피드로 변환.
 */

import { getCycleLogs, getAvailableLogDates } from '@/lib/cycle-logger';
import { getLogsByDate as getJudgmentsByDate } from '@/lib/ai-judgment-store';
import { listOrders } from '@/lib/order-store';
import { getTodayRiskEvents } from '@/lib/risk-manager';
import type { CycleLog } from '@/types/scheduler';
import type { AIJudgmentLog } from '@/types/ai-judgment';
import type { Order } from '@/types/order';
import type { RiskEvent } from '@/types/risk';
import type {
  ActivityItem,
  ActivityFilter,
  ActivitySummary,
  ActivitySeverity,
} from '@/types/activity';

// ──────────────────────────────────────────────
// 변환 함수
// ──────────────────────────────────────────────

function cycleToActivities(log: CycleLog): ActivityItem[] {
  const items: ActivityItem[] = [];

  if (log.error) {
    items.push({
      id: `cycle-err-${log.cycleId}`,
      timestamp: log.endedAt,
      type: 'cycle_error',
      severity: 'error',
      message: `사이클 #${log.cycleId} 에러: ${log.error}`,
      market: null,
      detail: {
        kind: 'cycle',
        cycleId: log.cycleId,
        durationMs: log.durationMs,
        executedCount: 0,
        marketSummary: log.marketSummary,
        error: log.error,
      },
    });
  } else {
    // 사이클 완료
    const execCount = log.results.filter(
      (r) => r.execution && r.execution.success,
    ).length;

    items.push({
      id: `cycle-end-${log.cycleId}`,
      timestamp: log.endedAt,
      type: 'cycle_end',
      severity: execCount > 0 ? 'success' : 'info',
      message: `사이클 #${log.cycleId} 완료 — ${log.durationMs}ms, 실행 ${execCount}건`,
      market: null,
      detail: {
        kind: 'cycle',
        cycleId: log.cycleId,
        durationMs: log.durationMs,
        executedCount: execCount,
        marketSummary: log.marketSummary,
        error: null,
      },
    });
  }

  return items;
}

function judgmentToActivity(log: AIJudgmentLog): ActivityItem {
  const actionLabel =
    log.decision.action === 'buy' ? '매수' :
    log.decision.action === 'sell' ? '매도' : '관망';

  const severity: ActivitySeverity =
    log.error ? 'error' :
    log.decision.action === 'hold' ? 'info' : 'warning';

  return {
    id: `judge-${log.id}`,
    timestamp: log.timestamp,
    type: 'ai_judgment',
    severity,
    message: `${log.market} AI 판단: ${actionLabel} (신뢰도 ${log.decision.confidence}%, ${log.engine})`,
    market: log.market,
    detail: {
      kind: 'ai_judgment',
      judgmentId: log.id,
      engine: log.engine,
      action: log.decision.action,
      confidence: log.decision.confidence,
      compositeScore: log.decision.compositeScore,
      reasoning: log.decision.reasoning,
      latencyMs: log.latencyMs,
    },
  };
}

function orderToActivity(order: Order): ActivityItem {
  const isBuy = order.side === 'buy';
  const severity: ActivitySeverity = isBuy ? 'info' : (
    order.profitRate !== null && order.profitRate > 0 ? 'success' : 'warning'
  );

  const pctStr = order.profitRate !== null
    ? ` (${order.profitRate > 0 ? '+' : ''}${order.profitRate.toFixed(2)}%)`
    : '';

  return {
    id: `order-${order.id}`,
    timestamp: order.filledAt ?? order.createdAt,
    type: isBuy ? 'order_buy' : 'order_sell',
    severity,
    message: `${order.market} ${isBuy ? '매수' : '매도'} ${order.totalAmount.toLocaleString('ko-KR')} KRW${pctStr}`,
    market: order.market,
    detail: {
      kind: 'order',
      orderId: order.id,
      side: order.side,
      price: order.price,
      volume: order.volume,
      totalAmount: order.totalAmount,
      profitRate: order.profitRate,
      reasoning: order.reasoning,
    },
  };
}

function riskEventToActivity(event: RiskEvent): ActivityItem {
  const typeMap: Record<string, { type: ActivityItem['type']; label: string }> = {
    stop_loss: { type: 'risk_stop_loss', label: '손절' },
    take_profit: { type: 'risk_take_profit', label: '익절' },
    trailing_stop: { type: 'risk_trailing', label: '트레일링 스탑' },
    circuit_breaker_trip: { type: 'circuit_breaker', label: '서킷 브레이커 발동' },
    circuit_breaker_reset: { type: 'circuit_breaker', label: '서킷 브레이커 해제' },
  };

  const mapped = typeMap[event.type] ?? { type: 'risk_stop_loss' as const, label: event.type };

  const severity: ActivitySeverity =
    event.type === 'circuit_breaker_trip' ? 'error' :
    event.type === 'stop_loss' ? 'warning' :
    event.type === 'take_profit' ? 'success' : 'warning';

  if (event.type === 'circuit_breaker_trip' || event.type === 'circuit_breaker_reset') {
    return {
      id: `risk-${event.id}`,
      timestamp: event.timestamp,
      type: 'circuit_breaker',
      severity,
      message: `${mapped.label}: ${event.message}`,
      market: event.market,
      detail: {
        kind: 'circuit_breaker',
        reason: event.message,
      },
    };
  }

  const details = (event.details ?? {}) as Record<string, number>;

  return {
    id: `risk-${event.id}`,
    timestamp: event.timestamp,
    type: mapped.type,
    severity,
    message: `${event.market ?? '?'} ${mapped.label}: ${event.message}`,
    market: event.market,
    detail: {
      kind: 'risk',
      orderId: event.orderId ?? '',
      action: event.type as 'stop_loss' | 'take_profit' | 'trailing_stop',
      buyPrice: details.buyPrice ?? 0,
      currentPrice: details.currentPrice ?? 0,
      profitRate: details.profitRate ?? 0,
      reasoning: event.message,
    },
  };
}

// ──────────────────────────────────────────────
// 공개 API
// ──────────────────────────────────────────────

/** 날짜별 통합 활동 피드 조회 (최신순) */
export function getActivityFeed(filter?: ActivityFilter): ActivityItem[] {
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const limit = filter?.limit ?? 100;

  const items: ActivityItem[] = [];

  // 1. 사이클 로그
  const cycleLogs = getCycleLogs(date);
  for (const log of cycleLogs) {
    items.push(...cycleToActivities(log));
  }

  // 2. AI 판단 로그
  const judgmentLogs = getJudgmentsByDate(date);
  for (const log of judgmentLogs) {
    items.push(judgmentToActivity(log));
  }

  // 3. 주문 기록 (해당 날짜)
  const allOrders = listOrders({ limit: 500 });
  for (const order of allOrders) {
    const orderDate = (order.filledAt ?? order.createdAt).slice(0, 10);
    if (orderDate === date && order.status === 'filled') {
      items.push(orderToActivity(order));
    }
  }

  // 4. 리스크 이벤트 (오늘만 — 파일 기반이므로 전체 로드 후 날짜 필터)
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) {
    const riskEvents = getTodayRiskEvents();
    for (const event of riskEvents) {
      items.push(riskEventToActivity(event));
    }
  }

  // 필터 적용
  let filtered = items;

  if (filter?.types && filter.types.length > 0) {
    const typeSet = new Set(filter.types);
    filtered = filtered.filter((item) => typeSet.has(item.type));
  }

  if (filter?.market) {
    filtered = filtered.filter((item) => item.market === filter.market);
  }

  // 시간순 정렬 (최신순)
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return filtered.slice(0, limit);
}

/** 날짜별 활동 요약 통계 */
export function getActivitySummary(date?: string): ActivitySummary {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const items = getActivityFeed({ date: targetDate, limit: 1000 });

  let totalCycles = 0;
  let errorCycles = 0;
  let totalJudgments = 0;
  let buyCount = 0;
  let sellCount = 0;
  let riskEventCount = 0;

  for (const item of items) {
    switch (item.type) {
      case 'cycle_end':
        totalCycles++;
        break;
      case 'cycle_error':
        totalCycles++;
        errorCycles++;
        break;
      case 'ai_judgment':
        totalJudgments++;
        break;
      case 'order_buy':
        buyCount++;
        break;
      case 'order_sell':
        sellCount++;
        break;
      case 'risk_stop_loss':
      case 'risk_take_profit':
      case 'risk_trailing':
      case 'circuit_breaker':
        riskEventCount++;
        break;
    }
  }

  return {
    date: targetDate,
    totalCycles,
    errorCycles,
    totalJudgments,
    buyCount,
    sellCount,
    riskEventCount,
  };
}

/** 로그가 존재하는 날짜 목록 */
export function getAvailableActivityDates(): string[] {
  return getAvailableLogDates();
}
