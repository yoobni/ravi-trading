/** 주문 방향 */
export type OrderSide = 'buy' | 'sell';

/** 주문 상태 */
export type OrderStatus =
  | 'pending'    // 대기
  | 'filled'     // 체결
  | 'cancelled'  // 취소
  | 'failed';    // 실패

/** 주문 기록 */
export interface Order {
  /** 고유 주문 ID (UUID v4) */
  id: string;
  /** 종목 코드 (e.g. "KRW-BTC") */
  market: string;
  /** 매수/매도 */
  side: OrderSide;
  /** 수량 */
  volume: number;
  /** 주문 가격 (KRW, 슬리피지 반영) */
  price: number;
  /** 총 금액 (price * volume, 수수료 미포함) */
  totalAmount: number;
  /** 수수료 (KRW) */
  fee: number;
  /** 실제 결제 금액 (totalAmount + fee for buy, totalAmount - fee for sell) */
  settlement: number;
  /** 주문 생성 시각 (ISO 8601) */
  createdAt: string;
  /** 체결 시각 (ISO 8601, 미체결 시 null) */
  filledAt: string | null;
  /** AI 판단 근거 — 왜 이 시점에 매수/매도했는지 */
  reasoning: string;
  /** 주문 상태 */
  status: OrderStatus;
  /** 수익률 (%, 매도 체결 시 계산, 그 외 null) */
  profitRate: number | null;
  /** 연결된 매수 주문 ID (매도 시 어떤 매수에 대한 매도인지) */
  linkedOrderId: string | null;
}

/** 주문 생성 시 필요한 필드 (id, createdAt, totalAmount, status는 자동 생성) */
export type CreateOrderInput = Pick<
  Order,
  'market' | 'side' | 'volume' | 'price' | 'reasoning'
> & {
  linkedOrderId?: string;
  fee?: number;
  settlement?: number;
};

/** 주문 업데이트 가능 필드 */
export type UpdateOrderInput = Partial<
  Pick<Order, 'status' | 'filledAt' | 'profitRate'>
>;

/** 포트폴리오 요약 */
export interface PortfolioSummary {
  /** 총 거래 수 */
  totalTrades: number;
  /** 매수 건수 */
  buyCount: number;
  /** 매도 건수 */
  sellCount: number;
  /** 승리 (수익 > 0) 건수 */
  winCount: number;
  /** 패배 (수익 <= 0) 건수 */
  lossCount: number;
  /** 승률 (%) */
  winRate: number;
  /** 평균 수익률 (%) */
  avgProfitRate: number;
  /** 총 실현 손익 (KRW) */
  totalRealizedPnl: number;
}
