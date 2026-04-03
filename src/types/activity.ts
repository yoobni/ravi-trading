/**
 * 활동 타임라인 타입 정의
 *
 * 사이클 실행, AI 판단, 매매 기록을 통합된 타임라인으로 제공.
 */

/** 활동 유형 */
export type ActivityType =
  | 'cycle_start'      // 사이클 시작
  | 'cycle_end'        // 사이클 완료
  | 'cycle_error'      // 사이클 에러
  | 'ai_judgment'      // AI 판단 (매수/매도/관망)
  | 'order_buy'        // 매수 체결
  | 'order_sell'       // 매도 체결
  | 'risk_stop_loss'   // 자동 손절
  | 'risk_take_profit' // 자동 익절
  | 'risk_trailing'    // 트레일링 스탑
  | 'circuit_breaker'; // 서킷 브레이커 발동

/** 활동 심각도 */
export type ActivitySeverity = 'info' | 'success' | 'warning' | 'error';

/** 통합 활동 로그 항목 */
export interface ActivityItem {
  /** 고유 ID */
  id: string;
  /** 활동 시각 (ISO 8601) */
  timestamp: string;
  /** 활동 유형 */
  type: ActivityType;
  /** 심각도 */
  severity: ActivitySeverity;
  /** 요약 메시지 (한글) */
  message: string;
  /** 관련 종목 코드 (없으면 null) */
  market: string | null;
  /** 상세 데이터 (타입별 다름) */
  detail: ActivityDetail;
}

/** 활동 상세 — 유니온 타입 */
export type ActivityDetail =
  | CycleDetail
  | AIJudgmentDetail
  | OrderDetail
  | RiskDetail
  | CircuitBreakerDetail;

/** 사이클 상세 */
export interface CycleDetail {
  kind: 'cycle';
  cycleId: string;
  durationMs: number;
  executedCount: number;
  marketSummary: string;
  error: string | null;
}

/** AI 판단 상세 */
export interface AIJudgmentDetail {
  kind: 'ai_judgment';
  judgmentId: string;
  engine: 'claude' | 'algorithm' | 'fallback';
  action: string;
  confidence: number;
  compositeScore: number;
  reasoning: string;
  latencyMs: number;
}

/** 주문 상세 */
export interface OrderDetail {
  kind: 'order';
  orderId: string;
  side: 'buy' | 'sell';
  price: number;
  volume: number;
  totalAmount: number;
  profitRate: number | null;
  reasoning: string;
}

/** 리스크 이벤트 상세 */
export interface RiskDetail {
  kind: 'risk';
  orderId: string;
  action: 'stop_loss' | 'take_profit' | 'trailing_stop';
  buyPrice: number;
  currentPrice: number;
  profitRate: number;
  reasoning: string;
}

/** 서킷 브레이커 상세 */
export interface CircuitBreakerDetail {
  kind: 'circuit_breaker';
  reason: string;
}

/** 활동 조회 필터 */
export interface ActivityFilter {
  /** 조회 날짜 (YYYY-MM-DD, 미지정 시 오늘) */
  date?: string;
  /** 활동 유형 필터 (미지정 시 전체) */
  types?: ActivityType[];
  /** 종목 필터 */
  market?: string;
  /** 최대 개수 (기본 100) */
  limit?: number;
}

/** 활동 요약 통계 */
export interface ActivitySummary {
  /** 조회 날짜 */
  date: string;
  /** 총 사이클 수 */
  totalCycles: number;
  /** 에러 사이클 수 */
  errorCycles: number;
  /** AI 판단 수 */
  totalJudgments: number;
  /** 매수 체결 수 */
  buyCount: number;
  /** 매도 체결 수 */
  sellCount: number;
  /** 리스크 이벤트 수 */
  riskEventCount: number;
}
