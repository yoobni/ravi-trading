import type { Order } from './order';

// ──────────────────────────────────────────────
// 모의 거래 엔진 설정
// ──────────────────────────────────────────────

/** 수수료/슬리피지 설정 */
export interface FeeConfig {
  /** 수수료율 (0.05% = 0.0005) */
  feeRate: number;
  /** 슬리피지율 (0.05% = 0.0005) — 매수 시 가격 상승, 매도 시 가격 하락 방향 */
  slippageRate: number;
}

/** 모의 거래 엔진 설정 */
export interface PaperTradingConfig {
  /** 초기 가상 자본 (KRW) */
  initialCapital: number;
  /** 수수료/슬리피지 */
  fee: FeeConfig;
}

// ──────────────────────────────────────────────
// 잔고 상태
// ──────────────────────────────────────────────

/** 보유 포지션 */
export interface HoldingPosition {
  /** 원본 매수 주문 ID */
  orderId: string;
  /** 종목 코드 */
  market: string;
  /** 수량 */
  volume: number;
  /** 매수 단가 (수수료 포함 실질 단가) */
  avgPrice: number;
  /** 매수 총 비용 (수수료 포함) */
  totalCost: number;
  /** 매수 시각 */
  boughtAt: string;
}

/** 계좌 잔고 스냅샷 */
export interface AccountBalance {
  /** 현금 잔고 (KRW) */
  cash: number;
  /** 초기 자본 */
  initialCapital: number;
  /** 보유 포지션 목록 */
  holdings: HoldingPosition[];
  /** 총 평가 금액 (현금 + 포지션 평가액, 현재가 미반영 시 매수가 기준) */
  totalEquity: number;
  /** 총 실현 손익 */
  totalRealizedPnl: number;
  /** 총 수수료 지출 */
  totalFeesPaid: number;
  /** 마지막 업데이트 시각 */
  updatedAt: string;
}

// ──────────────────────────────────────────────
// 체결 결과
// ──────────────────────────────────────────────

/** 모의 체결 결과 */
export interface ExecutionResult {
  /** 성공 여부 */
  success: boolean;
  /** 생성된 주문 (성공 시) */
  order: Order | null;
  /** 적용된 체결 가격 (슬리피지 반영) */
  executedPrice: number;
  /** 수수료 금액 */
  feeAmount: number;
  /** 총 결제 금액 (매수: 체결가*수량+수수료, 매도: 체결가*수량-수수료) */
  totalSettlement: number;
  /** 체결 후 현금 잔고 */
  cashAfter: number;
  /** 실패 사유 (실패 시) */
  reason: string | null;
}

/** 포트폴리오 평가 (현재가 반영) */
export interface PortfolioValuation {
  /** 현금 잔고 */
  cash: number;
  /** 보유 포지션별 평가 */
  positions: PositionValuation[];
  /** 총 포지션 평가액 */
  totalPositionValue: number;
  /** 총 평가액 (현금 + 포지션) */
  totalEquity: number;
  /** 총 미실현 손익 */
  unrealizedPnl: number;
  /** 총 실현 손익 */
  realizedPnl: number;
  /** 전체 수익률 (%, 초기 자본 대비) */
  totalReturnRate: number;
  /** 총 수수료 지출 */
  totalFeesPaid: number;
  /** 평가 시각 */
  valuedAt: string;
}

/** 개별 포지션 평가 */
export interface PositionValuation {
  /** 원본 매수 주문 ID */
  orderId: string;
  /** 종목 코드 */
  market: string;
  /** 수량 */
  volume: number;
  /** 매수 단가 */
  avgPrice: number;
  /** 현재가 */
  currentPrice: number;
  /** 평가 금액 */
  currentValue: number;
  /** 매수 총 비용 */
  totalCost: number;
  /** 미실현 손익 (KRW) */
  unrealizedPnl: number;
  /** 미실현 수익률 (%) */
  unrealizedPnlRate: number;
}
