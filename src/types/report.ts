/**
 * 거래 내역 리포트 타입 정의
 */

/** 리포트 기간 단위 */
export type ReportPeriod = 'daily' | 'weekly';

/** 내보내기 형식 */
export type ExportFormat = 'json' | 'csv';

/** 리포트 생성 옵션 */
export interface ReportOptions {
  /** 기간 단위 */
  period: ReportPeriod;
  /** 조회 시작일 (YYYY-MM-DD) */
  fromDate?: string;
  /** 조회 종료일 (YYYY-MM-DD) */
  toDate?: string;
  /** 특정 종목 필터 */
  market?: string;
  /** 내보내기 형식 */
  format: ExportFormat;
}

/** 개별 거래 리포트 항목 */
export interface TradeReportEntry {
  /** 거래 번호 (1부터 시작) */
  no: number;
  /** 종목 코드 */
  market: string;
  /** 매수 주문 ID */
  buyOrderId: string;
  /** 매도 주문 ID */
  sellOrderId: string;
  /** 진입(매수) 가격 (KRW) */
  entryPrice: number;
  /** 청산(매도) 가격 (KRW) */
  exitPrice: number;
  /** 수량 */
  volume: number;
  /** 투자 금액 (KRW) */
  investedAmount: number;
  /** 청산 금액 (KRW) */
  exitAmount: number;
  /** 실현 손익 (KRW) */
  realizedPnl: number;
  /** 수익률 (%) */
  profitRate: number;
  /** 결과 */
  result: 'win' | 'loss' | 'even';
  /** 매수 시각 (ISO 8601) */
  entryTime: string;
  /** 매도 시각 (ISO 8601) */
  exitTime: string;
  /** 보유 시간 (분) */
  holdingMinutes: number;
  /** AI 판단 근거 요약 (매수 시) */
  entryReasoning: string;
  /** AI 판단 근거 요약 (매도 시) */
  exitReasoning: string;
}

/** 기간별 집계 */
export interface PeriodSummary {
  /** 기간 라벨 (YYYY-MM-DD 또는 YYYY-Www) */
  periodLabel: string;
  /** 기간 시작일 */
  startDate: string;
  /** 기간 종료일 */
  endDate: string;
  /** 청산 거래 수 */
  tradeCount: number;
  /** 승리 수 */
  winCount: number;
  /** 패배 수 */
  lossCount: number;
  /** 승률 (%) */
  winRate: number;
  /** 총 실현 손익 (KRW) */
  totalPnl: number;
  /** 평균 수익률 (%) */
  avgProfitRate: number;
  /** 최고 수익 거래 수익률 (%) */
  bestProfitRate: number;
  /** 최악 손실 거래 수익률 (%) */
  worstProfitRate: number;
}

/** 전체 리포트 */
export interface TradeReport {
  /** 리포트 생성 시각 */
  generatedAt: string;
  /** 기간 단위 */
  period: ReportPeriod;
  /** 조회 범위 시작일 */
  fromDate: string;
  /** 조회 범위 종료일 */
  toDate: string;
  /** 종목 필터 (null이면 전체) */
  marketFilter: string | null;
  /** 기간별 집계 */
  periodSummaries: PeriodSummary[];
  /** 개별 거래 목록 (최신순) */
  trades: TradeReportEntry[];
  /** 전체 요약 */
  totalSummary: {
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    totalPnl: number;
    avgProfitRate: number;
    avgHoldingMinutes: number;
  };
}
