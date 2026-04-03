// ──────────────────────────────────────────────
// 대시보드 통계 타입
// ──────────────────────────────────────────────

/** 전체 성과 요약 */
export interface PerformanceSummary {
  /** 초기 자본 (KRW) */
  initialCapital: number;
  /** 현재 총 자산 (KRW) */
  currentAssets: number;
  /** 총 수익률 (%) */
  totalReturnRate: number;
  /** 총 실현 손익 (KRW) */
  totalRealizedPnl: number;
  /** 총 미실현 손익 (KRW) */
  totalUnrealizedPnl: number;
  /** 승률 (%, 이익 거래 / 전체 청산 거래) */
  winRate: number;
  /** 이익 거래 수 */
  winCount: number;
  /** 손실 거래 수 */
  lossCount: number;
  /** 평균 수익률 (%, 청산 거래 기준) */
  avgReturnRate: number;
  /** 평균 이익 수익률 (%) */
  avgWinRate: number;
  /** 평균 손실 수익률 (%) */
  avgLossRate: number;
  /** 손익비 (평균 이익 / 평균 손실 절대값, 손실 0이면 null) */
  profitLossRatio: number | null;
  /** 최대 낙폭 (%, 음수) */
  maxDrawdown: number;
  /** 최대 낙폭 기간 */
  maxDrawdownPeriod: DrawdownPeriod | null;
  /** 샤프 비율 (연환산, 무위험수익률 기반) */
  sharpeRatio: number | null;
  /** 총 거래 횟수 (매수+매도) */
  totalTradeCount: number;
  /** 청산 완료 거래 수 (매도 체결 건) */
  closedTradeCount: number;
  /** 총 수수료 지출 (KRW) */
  totalFeesPaid: number;
  /** 집계 시각 */
  calculatedAt: string;
}

/** 낙폭 구간 정보 */
export interface DrawdownPeriod {
  /** 고점 도달 시각 */
  peakAt: string;
  /** 저점 도달 시각 */
  troughAt: string;
  /** 고점 자산 (KRW) */
  peakValue: number;
  /** 저점 자산 (KRW) */
  troughValue: number;
  /** 낙폭률 (%, 음수) */
  drawdownRate: number;
}

/** 일별 통계 */
export interface DailyStats {
  /** 날짜 (YYYY-MM-DD) */
  date: string;
  /** 당일 청산 거래 수 */
  tradeCount: number;
  /** 당일 실현 손익 (KRW) */
  realizedPnl: number;
  /** 당일 수익률 (%) */
  returnRate: number;
  /** 당일 승률 (%) */
  winRate: number;
  /** 당일 승리 수 */
  winCount: number;
  /** 당일 패배 수 */
  lossCount: number;
  /** 당일 누적 자산 (KRW, 해당 일 마지막 기준) */
  cumulativeAssets: number;
}

/** 종목별 통계 */
export interface MarketStats {
  /** 종목 코드 */
  market: string;
  /** 청산 거래 수 */
  tradeCount: number;
  /** 총 실현 손익 (KRW) */
  totalPnl: number;
  /** 평균 수익률 (%) */
  avgReturnRate: number;
  /** 승률 (%) */
  winRate: number;
  /** 승리 수 */
  winCount: number;
  /** 패배 수 */
  lossCount: number;
  /** 최고 수익률 (%) */
  bestReturn: number;
  /** 최저 수익률 (%) */
  worstReturn: number;
  /** 평균 보유 시간 (시간, hours) */
  avgHoldingHours: number;
}

/** 대시보드 전체 데이터 */
export interface DashboardData {
  /** 전체 성과 요약 */
  summary: PerformanceSummary;
  /** 일별 통계 (최신순) */
  dailyStats: DailyStats[];
  /** 종목별 통계 (수익순) */
  marketStats: MarketStats[];
}

/** 대시보드 조회 옵션 */
export interface DashboardQueryOptions {
  /** 조회 시작일 (YYYY-MM-DD, 미지정 시 전체) */
  fromDate?: string;
  /** 조회 종료일 (YYYY-MM-DD, 미지정 시 오늘) */
  toDate?: string;
  /** 특정 종목만 필터 */
  market?: string;
  /** 일별 통계 최대 일수 (기본 30) */
  dailyLimit?: number;
}
