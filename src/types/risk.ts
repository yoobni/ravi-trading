import type { Order } from './order';
import type { TechnicalAnalysis } from './indicator';
import type { MarketAnalysis } from './market-analysis';

// ──────────────────────────────────────────────
// 리스크 설정
// ──────────────────────────────────────────────

/** 손절/익절 기준 */
export interface StopLossConfig {
  /** 손절 기준 (%, 음수: -3 = 3% 하락 시 손절) */
  stopLossRate: number;
  /** 익절 기준 (%, 양수: 5 = 5% 상승 시 익절) */
  takeProfitRate: number;
  /** 트레일링 스탑 사용 여부 */
  useTrailingStop: boolean;
  /** 트레일링 스탑 간격 (%, 고점 대비 하락 시 매도) */
  trailingStopRate: number;
}

/** 포지션 크기 제한 */
export interface PositionSizeConfig {
  /** 1건당 최대 투자 금액 (KRW) */
  maxAmountPerTrade: number;
  /** 1건당 최대 투자 비율 (%, 총 자본 대비) */
  maxRatePerTrade: number;
  /** 전체 포지션 최대 금액 (KRW) */
  maxTotalPosition: number;
  /** 전체 포지션 최대 비율 (%, 총 자본 대비) */
  maxTotalPositionRate: number;
}

/** 일일 손실 한도 */
export interface DailyLossConfig {
  /** 일일 최대 손실 금액 (KRW) */
  maxDailyLossAmount: number;
  /** 일일 최대 손실 비율 (%, 총 자본 대비) */
  maxDailyLossRate: number;
  /** 일일 최대 거래 횟수 */
  maxDailyTrades: number;
}

/** 분산 투자 규칙 */
export interface DiversificationConfig {
  /** 동시 보유 최대 종목 수 */
  maxHoldings: number;
  /** 단일 종목 최대 투자 비율 (%, 총 포지션 대비) */
  maxSingleAssetRate: number;
  /** 급등/급락 종목 매수 금지 여부 */
  blockSurgeCoins: boolean;
  /** 거래량 최소 기준 (24h 거래대금, KRW) */
  minTradeVolume24h: number;
}

/** 리스크 관리 전체 설정 */
export interface RiskConfig {
  /** 총 운용 자본 (KRW, 모의 거래 기준) */
  totalCapital: number;
  /** 손절/익절 */
  stopLoss: StopLossConfig;
  /** 포지션 크기 */
  positionSize: PositionSizeConfig;
  /** 일일 손실 한도 */
  dailyLoss: DailyLossConfig;
  /** 분산 투자 */
  diversification: DiversificationConfig;
}

// ──────────────────────────────────────────────
// 리스크 검증 결과
// ──────────────────────────────────────────────

/** 리스크 위반 항목 */
export interface RiskViolation {
  /** 위반 규칙 코드 */
  rule: RiskRule;
  /** 위반 설명 */
  message: string;
  /** 심각도 */
  severity: 'block' | 'warn';
  /** 현재 값 */
  currentValue: number;
  /** 제한 값 */
  limitValue: number;
}

/** 리스크 규칙 코드 */
export type RiskRule =
  | 'STOP_LOSS_HIT'           // 손절선 도달
  | 'TAKE_PROFIT_HIT'         // 익절선 도달
  | 'TRAILING_STOP_HIT'       // 트레일링 스탑 도달
  | 'MAX_AMOUNT_PER_TRADE'    // 1건 최대 금액 초과
  | 'MAX_RATE_PER_TRADE'      // 1건 최대 비율 초과
  | 'MAX_TOTAL_POSITION'      // 전체 포지션 한도 초과
  | 'MAX_DAILY_LOSS'          // 일일 최대 손실 초과
  | 'MAX_DAILY_TRADES'        // 일일 최대 거래 횟수 초과
  | 'MAX_HOLDINGS'            // 동시 보유 종목 수 초과
  | 'MAX_SINGLE_ASSET_RATE'   // 단일 종목 비중 초과
  | 'SURGE_COIN_BLOCKED'      // 급등/급락 종목 매수 차단
  | 'LOW_VOLUME'              // 거래량 부족
  | 'AI_RISK_FILTER';         // AI 리스크 필터 차단

/** 매수 주문 리스크 검증 결과 */
export interface RiskCheckResult {
  /** 주문 허용 여부 */
  allowed: boolean;
  /** 위반 항목 목록 */
  violations: RiskViolation[];
  /** 조정된 주문 금액 (리스크 한도 내 최대값, null이면 주문 불가) */
  adjustedAmount: number | null;
  /** 검증 시각 (ISO 8601) */
  checkedAt: string;
}

/** 보유 포지션 리스크 점검 결과 (손절/익절 판단) */
export interface PositionRiskCheck {
  /** 주문 ID */
  orderId: string;
  /** 종목 코드 */
  market: string;
  /** 매수가 */
  buyPrice: number;
  /** 현재가 */
  currentPrice: number;
  /** 현재 수익률 (%) */
  profitRate: number;
  /** 조치 필요 여부 */
  action: 'hold' | 'stop_loss' | 'take_profit' | 'trailing_stop';
  /** 위반 항목 (있으면) */
  violations: RiskViolation[];
}

/** AI 리스크 필터 입력 */
export interface AIRiskFilterInput {
  /** 매수 대상 종목 */
  market: string;
  /** 매수 금액 */
  amount: number;
  /** AI 매수 판단 근거 */
  reasoning: string;
  /** 기술적 분석 결과 (있으면) */
  technicalAnalysis: TechnicalAnalysis | null;
  /** 시장 흐름 분석 (있으면) */
  marketAnalysis: MarketAnalysis | null;
}

/** AI 리스크 필터 결과 */
export interface AIRiskFilterResult {
  /** 통과 여부 */
  passed: boolean;
  /** 리스크 점수 (0~100, 높을수록 위험) */
  riskScore: number;
  /** 판단 근거 */
  reasoning: string;
  /** 경고 사항 */
  warnings: string[];
}

/** 일일 거래 통계 (리스크 추적용) */
export interface DailyTradeStats {
  /** 날짜 (YYYY-MM-DD) */
  date: string;
  /** 당일 거래 횟수 */
  tradeCount: number;
  /** 당일 실현 손익 (KRW) */
  realizedPnl: number;
  /** 당일 최대 손실 (KRW, 음수) */
  maxDrawdown: number;
}

// ──────────────────────────────────────────────
// 서킷 브레이커
// ──────────────────────────────────────────────

/** 서킷 브레이커 설정 */
export interface CircuitBreakerConfig {
  /** 총 자산 대비 최대 허용 손실률 (%, 초기 자본 기준) */
  maxDrawdownRate: number;
  /** 연속 손실 횟수 제한 */
  maxConsecutiveLosses: number;
  /** 1시간 내 최대 거래 횟수 */
  maxTradesPerHour: number;
  /** 자동 복구 대기 시간 (ms, 0이면 수동 복구만 가능) */
  cooldownMs: number;
}

/** 서킷 브레이커 상태 */
export interface CircuitBreakerState {
  /** 트립 여부 (true면 거래 중단) */
  tripped: boolean;
  /** 트립 사유 */
  reason: string | null;
  /** 트립 시각 (ISO 8601) */
  trippedAt: string | null;
  /** 연속 손실 카운트 */
  consecutiveLosses: number;
  /** 자동 복구 예정 시각 (ISO 8601, null이면 수동 복구) */
  recoversAt: string | null;
}

// ──────────────────────────────────────────────
// 리스크 이벤트 로그
// ──────────────────────────────────────────────

/** 리스크 이벤트 종류 */
export type RiskEventType =
  | 'violation_warn'       // 경고 위반 (조정 후 허용)
  | 'violation_block'      // 차단 위반 (주문 거부)
  | 'stop_loss'            // 손절 실행
  | 'take_profit'          // 익절 실행
  | 'trailing_stop'        // 트레일링 스탑 실행
  | 'ai_filter_block'      // AI 리스크 필터 차단
  | 'circuit_breaker_trip' // 서킷 브레이커 발동
  | 'circuit_breaker_reset'; // 서킷 브레이커 해제

/** 리스크 이벤트 로그 항목 */
export interface RiskEvent {
  /** 고유 ID */
  id: string;
  /** 이벤트 종류 */
  type: RiskEventType;
  /** 이벤트 시각 (ISO 8601) */
  timestamp: string;
  /** 관련 종목 (없으면 null) */
  market: string | null;
  /** 관련 주문 ID (없으면 null) */
  orderId: string | null;
  /** 이벤트 설명 */
  message: string;
  /** 추가 데이터 (위반 상세 등) */
  details: Record<string, unknown> | null;
}

/** 리스크 현황 요약 (대시보드용) */
export interface RiskStatusSummary {
  /** 현재 리스크 설정 */
  config: RiskConfig;
  /** 서킷 브레이커 상태 */
  circuitBreaker: CircuitBreakerState;
  /** 오늘 거래 통계 */
  todayStats: DailyTradeStats;
  /** 오늘 리스크 이벤트 수 */
  todayEventCount: number;
  /** 최근 리스크 이벤트 (최대 10건) */
  recentEvents: RiskEvent[];
  /** 현재 보유 포지션 수 */
  openPositionCount: number;
  /** 총 포지션 사용률 (%) */
  positionUsageRate: number;
  /** 일일 손실 사용률 (%) */
  dailyLossUsageRate: number;
  /** 조회 시각 */
  checkedAt: string;
}
