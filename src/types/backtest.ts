import type { UpbitCandle, CandleMinuteUnit } from './upbit';
import type { TradingDecision, DecisionEngineConfig } from './trading-decision';
import type { RiskConfig } from './risk';
import type { FeeConfig } from './paper-trading';

// ──────────────────────────────────────────────
// 백테스트 설정
// ──────────────────────────────────────────────

/** 백테스트 실행 설정 */
export interface BacktestConfig {
  /** 대상 마켓 (예: "KRW-BTC") */
  market: string;
  /** 캔들 단위 (분) */
  candleUnit: CandleMinuteUnit;
  /** 분석에 필요한 캔들 수 (MA60 등 계산용) */
  lookbackCandles: number;
  /** 초기 자본금 (KRW) */
  initialCapital: number;
  /** 수수료/슬리피지 설정 */
  fee: FeeConfig;
  /** 판단 엔진 설정 (null이면 기본값) */
  engineConfig: DecisionEngineConfig | null;
  /** 리스크 설정 (null이면 기본값) */
  riskConfig: Partial<RiskConfig> | null;
  /** 백테스트 기간 시작 (ISO 8601, 예: "2026-03-01T00:00:00") */
  startDate: string;
  /** 백테스트 기간 종료 (ISO 8601, 예: "2026-04-01T00:00:00") */
  endDate: string;
}

/** 백테스트 기본 설정값 */
export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, 'market' | 'startDate' | 'endDate'> = {
  candleUnit: 5,
  lookbackCandles: 200,
  initialCapital: 10_000_000,
  fee: { feeRate: 0.0005, slippageRate: 0.0005 },
  engineConfig: null,
  riskConfig: null,
};

// ──────────────────────────────────────────────
// 백테스트 내부 상태
// ──────────────────────────────────────────────

/** 백테스트 내 가상 포지션 */
export interface BacktestPosition {
  /** 진입 시점 캔들 인덱스 */
  entryIndex: number;
  /** 진입 시각 */
  entryTime: string;
  /** 마켓 */
  market: string;
  /** 진입가 (슬리피지 반영) */
  entryPrice: number;
  /** 수량 */
  volume: number;
  /** 투입 금액 (수수료 포함) */
  totalCost: number;
  /** 진입 수수료 */
  entryFee: number;
}

/** 완결된 거래 */
export interface BacktestTrade {
  /** 마켓 */
  market: string;
  /** 진입 시각 */
  entryTime: string;
  /** 청산 시각 */
  exitTime: string;
  /** 진입가 (슬리피지 반영) */
  entryPrice: number;
  /** 청산가 (슬리피지 반영) */
  exitPrice: number;
  /** 수량 */
  volume: number;
  /** 투입 금액 */
  totalCost: number;
  /** 청산 수령 금액 */
  totalProceeds: number;
  /** 수익 (KRW) */
  profit: number;
  /** 수익률 (%) */
  profitRate: number;
  /** 총 수수료 (진입 + 청산) */
  totalFee: number;
  /** 보유 기간 (캔들 수) */
  holdingPeriod: number;
  /** 진입 판단 근거 */
  entryReasoning: string;
  /** 청산 판단 근거 */
  exitReasoning: string;
  /** 진입 시 판단 결과 */
  entryDecision: TradingDecision;
  /** 청산 시 판단 결과 */
  exitDecision: TradingDecision;
}

// ──────────────────────────────────────────────
// 백테스트 결과
// ──────────────────────────────────────────────

/** 기간별 통계 */
export interface PeriodStats {
  /** 기간 라벨 (예: "2026-03-01", "2026-W10") */
  period: string;
  /** 기간 내 거래 수 */
  tradeCount: number;
  /** 승리 수 */
  winCount: number;
  /** 패배 수 */
  lossCount: number;
  /** 승률 (%) */
  winRate: number;
  /** 기간 수익 (KRW) */
  profit: number;
  /** 기간 수익률 (%) */
  profitRate: number;
  /** 기간 종료 시 자산 */
  equity: number;
}

/** 에퀴티 커브 포인트 */
export interface EquityPoint {
  /** 시각 */
  time: string;
  /** 캔들 인덱스 */
  index: number;
  /** 총 평가 자산 (현금 + 포지션 평가) */
  equity: number;
  /** 현금 */
  cash: number;
  /** 포지션 평가액 */
  positionValue: number;
  /** 누적 수익률 (%) */
  returnRate: number;
}

/** 백테스트 종합 결과 */
export interface BacktestResult {
  /** 백테스트 설정 */
  config: BacktestConfig;
  /** 실행 시각 */
  executedAt: string;
  /** 실행 소요시간 (ms) */
  durationMs: number;
  /** 사용된 캔들 수 */
  totalCandles: number;
  /** 평가 시점 수 (lookback 제외) */
  evaluatedSteps: number;

  // ── 성과 요약 ──
  /** 초기 자본 */
  initialCapital: number;
  /** 최종 자산 */
  finalEquity: number;
  /** 총 수익률 (%) */
  totalReturnRate: number;
  /** 연환산 수익률 (%) */
  annualizedReturn: number;
  /** 총 실현 손익 (KRW) */
  totalProfit: number;
  /** 총 수수료 */
  totalFees: number;

  // ── 거래 통계 ──
  /** 총 거래 수 */
  tradeCount: number;
  /** 승리 수 */
  winCount: number;
  /** 패배 수 */
  lossCount: number;
  /** 승률 (%) */
  winRate: number;
  /** 평균 수익률 (%) */
  avgProfitRate: number;
  /** 평균 보유 기간 (캔들 수) */
  avgHoldingPeriod: number;
  /** 최대 수익 거래 (%) */
  bestTradeRate: number;
  /** 최대 손실 거래 (%) */
  worstTradeRate: number;
  /** 평균 수익 거래 수익률 (%) */
  avgWinRate: number;
  /** 평균 손실 거래 손실률 (%) */
  avgLossRate: number;
  /** 손익비 (평균 수익 / 평균 손실) */
  profitFactor: number;

  // ── 리스크 지표 ──
  /** 최대 낙폭 (%, Max Drawdown) */
  maxDrawdown: number;
  /** 최대 낙폭 기간 (캔들 수) */
  maxDrawdownDuration: number;
  /** 샤프 비율 (무위험 수익률 0 가정) */
  sharpeRatio: number;

  // ── 상세 데이터 ──
  /** 개별 거래 내역 */
  trades: BacktestTrade[];
  /** 에퀴티 커브 (일정 간격 샘플링) */
  equityCurve: EquityPoint[];
  /** 일별 통계 */
  dailyStats: PeriodStats[];
  /** 주별 통계 */
  weeklyStats: PeriodStats[];
}
