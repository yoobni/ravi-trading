import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  Order,
  CreateOrderInput,
  UpdateOrderInput,
  PortfolioSummary,
  OrderSide,
  OrderStatus,
} from '@/types/order';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// ──────────────────────────────────────────────
// 입력값 검증
// ──────────────────────────────────────────────

const MARKET_CODE_REGEX = /^[A-Z]+-[A-Z0-9]+$/; // e.g. "KRW-BTC"

/** 주문 생성 입력값 검증. 실패 시 에러 메시지 반환, 성공 시 null */
function validateCreateInput(input: CreateOrderInput): string | null {
  if (!input.market || !MARKET_CODE_REGEX.test(input.market)) {
    return `잘못된 마켓 코드: "${input.market}" (예: KRW-BTC)`;
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    return `잘못된 주문 방향: "${input.side}"`;
  }
  if (typeof input.volume !== 'number' || input.volume <= 0 || !isFinite(input.volume)) {
    return `수량은 0보다 큰 유한한 숫자여야 합니다: ${input.volume}`;
  }
  if (typeof input.price !== 'number' || input.price <= 0 || !isFinite(input.price)) {
    return `가격은 0보다 큰 유한한 숫자여야 합니다: ${input.price}`;
  }
  if (!input.reasoning || input.reasoning.trim().length === 0) {
    return '판단 근거(reasoning)는 필수입니다';
  }
  if (input.side === 'sell' && !input.linkedOrderId) {
    return '매도 주문에는 연결된 매수 주문 ID(linkedOrderId)가 필수입니다';
  }
  return null;
}

/** JSON 파일에서 주문 목록 로드 */
function loadOrders(): Order[] {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf-8');
    return [];
  }
  const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
  return JSON.parse(raw) as Order[];
}

/** 주문 목록을 JSON 파일에 저장 */
function saveOrders(orders: Order[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

/** 주문 생성 결과 */
export type CreateOrderResult =
  | { success: true; order: Order }
  | { success: false; error: string };

/** 주문 생성 */
export function createOrder(input: CreateOrderInput): CreateOrderResult {
  // 1. 입력값 검증
  const validationError = validateCreateInput(input);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const orders = loadOrders();

  // 2. 매도 시 연결된 매수 주문 검증
  if (input.side === 'sell' && input.linkedOrderId) {
    const buyOrder = orders.find((o) => o.id === input.linkedOrderId);
    if (!buyOrder) {
      return { success: false, error: `연결된 매수 주문을 찾을 수 없습니다: ${input.linkedOrderId}` };
    }
    if (buyOrder.side !== 'buy') {
      return { success: false, error: `linkedOrderId가 매수 주문이 아닙니다: ${input.linkedOrderId}` };
    }
    if (buyOrder.status !== 'filled') {
      return { success: false, error: `체결되지 않은 매수 주문에 대해 매도할 수 없습니다` };
    }
    // 이중 매도 방지: 이미 해당 매수에 대한 매도가 존재하는지 확인
    const existingSell = orders.find(
      (o) => o.side === 'sell' && o.linkedOrderId === input.linkedOrderId && o.status === 'filled',
    );
    if (existingSell) {
      return { success: false, error: `이미 매도 완료된 매수 주문입니다: ${input.linkedOrderId} (매도 ID: ${existingSell.id})` };
    }
  }

  const now = new Date().toISOString();
  const totalAmount = input.price * input.volume;
  const fee = input.fee ?? 0;
  const settlement = input.settlement ?? (
    input.side === 'buy' ? totalAmount + fee : totalAmount - fee
  );
  const order: Order = {
    id: crypto.randomUUID(),
    market: input.market,
    side: input.side,
    volume: input.volume,
    price: input.price,
    totalAmount,
    fee,
    settlement,
    createdAt: now,
    filledAt: now, // 모의 거래이므로 즉시 체결
    reasoning: input.reasoning,
    status: 'filled',
    profitRate: null,
    linkedOrderId: input.linkedOrderId ?? null,
  };

  // 매도 주문이면 수익률 자동 계산
  if (order.side === 'sell' && order.linkedOrderId) {
    const buyOrder = orders.find((o) => o.id === order.linkedOrderId)!;
    order.profitRate = calculateProfitRate(buyOrder.price, order.price);
  }

  orders.push(order);
  saveOrders(orders);
  return { success: true, order };
}

// ──────────────────────────────────────────────
// 수익률 계산 유틸
// ──────────────────────────────────────────────

/** 매수가 → 매도가 수익률 계산 (소수점 2자리) */
export function calculateProfitRate(buyPrice: number, sellPrice: number): number {
  if (buyPrice <= 0) return 0;
  return Math.round(((sellPrice - buyPrice) / buyPrice) * 100 * 100) / 100;
}

/** 미실현 수익률 계산 (보유 포지션 + 현재가) */
export function calculateUnrealizedProfitRate(
  position: Order,
  currentPrice: number,
): { profitRate: number; unrealizedPnl: number } {
  const profitRate = calculateProfitRate(position.price, currentPrice);
  const unrealizedPnl = Math.round((currentPrice - position.price) * position.volume);
  return { profitRate, unrealizedPnl };
}

// ──────────────────────────────────────────────
// 조회 / 수정 / 취소
// ──────────────────────────────────────────────

/** ID로 주문 조회 */
export function getOrderById(id: string): Order | null {
  const orders = loadOrders();
  return orders.find((o) => o.id === id) ?? null;
}

/** 주문 업데이트 (내부용 — 상태 변경만 허용) */
export function updateOrder(id: string, input: UpdateOrderInput): Order | null {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;

  orders[idx] = { ...orders[idx], ...input };
  saveOrders(orders);
  return orders[idx];
}

/** 주문 취소 결과 */
export type CancelOrderResult =
  | { success: true; order: Order }
  | { success: false; error: string };

/** 주문 취소 (체결 전 주문만 취소 가능, 모의 거래에서는 filled도 취소 허용) */
export function cancelOrder(id: string, reason?: string): CancelOrderResult {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return { success: false, error: `주문을 찾을 수 없습니다: ${id}` };
  }

  const order = orders[idx];
  if (order.status === 'cancelled') {
    return { success: false, error: '이미 취소된 주문입니다' };
  }

  // 매수 주문 취소 시, 이미 매도가 완료된 경우 취소 불가
  if (order.side === 'buy') {
    const linkedSell = orders.find(
      (o) => o.side === 'sell' && o.linkedOrderId === id && o.status === 'filled',
    );
    if (linkedSell) {
      return { success: false, error: `이미 매도된 매수 주문은 취소할 수 없습니다 (매도 ID: ${linkedSell.id})` };
    }
  }

  orders[idx] = {
    ...order,
    status: 'cancelled',
    reasoning: reason ? `${order.reasoning} [취소 사유: ${reason}]` : order.reasoning,
  };
  saveOrders(orders);
  return { success: true, order: orders[idx] };
}

/** 필터 옵션 */
export interface ListOrdersFilter {
  market?: string;
  side?: OrderSide;
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

/** 주문 목록 조회 (최신순) */
export function listOrders(filter?: ListOrdersFilter): Order[] {
  let orders = loadOrders();

  // 최신순 정렬
  orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (filter?.market) {
    orders = orders.filter((o) => o.market === filter.market);
  }
  if (filter?.side) {
    orders = orders.filter((o) => o.side === filter.side);
  }
  if (filter?.status) {
    orders = orders.filter((o) => o.status === filter.status);
  }

  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? 100;
  return orders.slice(offset, offset + limit);
}

/** 특정 종목의 미매도 매수 포지션 조회 */
export function getOpenPositions(market?: string): Order[] {
  const orders = loadOrders();
  const sellLinkedIds = new Set(
    orders
      .filter((o) => o.side === 'sell' && o.status === 'filled' && o.linkedOrderId)
      .map((o) => o.linkedOrderId!),
  );

  return orders.filter(
    (o) =>
      o.side === 'buy' &&
      o.status === 'filled' &&
      !sellLinkedIds.has(o.id) &&
      (!market || o.market === market),
  );
}

/** 포트폴리오 요약 통계 */
export function getPortfolioSummary(): PortfolioSummary {
  const orders = loadOrders();
  const filledSells = orders.filter(
    (o) => o.side === 'sell' && o.status === 'filled' && o.profitRate !== null,
  );

  const winTrades = filledSells.filter((o) => o.profitRate! > 0);
  const lossTrades = filledSells.filter((o) => o.profitRate! <= 0);

  const totalRealizedPnl = filledSells.reduce((sum, o) => {
    const buyOrder = o.linkedOrderId ? orders.find((b) => b.id === o.linkedOrderId) : null;
    if (!buyOrder) return sum;
    return sum + (o.totalAmount - buyOrder.totalAmount);
  }, 0);

  const avgProfitRate =
    filledSells.length > 0
      ? filledSells.reduce((sum, o) => sum + o.profitRate!, 0) / filledSells.length
      : 0;

  return {
    totalTrades: orders.filter((o) => o.status === 'filled').length,
    buyCount: orders.filter((o) => o.side === 'buy' && o.status === 'filled').length,
    sellCount: filledSells.length,
    winCount: winTrades.length,
    lossCount: lossTrades.length,
    winRate: filledSells.length > 0 ? (winTrades.length / filledSells.length) * 100 : 0,
    avgProfitRate: Math.round(avgProfitRate * 100) / 100,
    totalRealizedPnl: Math.round(totalRealizedPnl),
  };
}

/** 전체 주문 기록 삭제 (테스트용) */
export function clearAllOrders(): void {
  saveOrders([]);
}
