import type { TradingDecision } from './trading-decision';
import type { MarketAnalysis } from './market-analysis';

// ──────────────────────────────────────────────
// 스케줄러 설정
// ──────────────────────────────────────────────

/** 스케줄러 설정 */
export interface SchedulerConfig {
  /** 실행 간격 (ms) — 기본 5분 */
  intervalMs: number;
  /** 분석 대상 종목 수 (거래대금 기준 상위 N개) */
  targetMarketCount: number;
  /** 캔들 분봉 단위 (5분, 15분 등) */
  candleUnit: 5 | 15 | 30 | 60;
  /** 캔들 조회 개수 */
  candleCount: number;
  /** 자동 실행 여부 */
  enabled: boolean;
}

// ──────────────────────────────────────────────
// 사이클 로그
// ──────────────────────────────────────────────

/** 개별 종목 분석 결과 */
export interface MarketCycleResult {
  /** 종목 코드 */
  market: string;
  /** AI 판단 결과 */
  decision: TradingDecision;
  /** 실행 결과 */
  execution: CycleExecution | null;
  /** 에러 (분석/실행 중 발생 시) */
  error: string | null;
}

/** 매매 실행 결과 요약 */
export interface CycleExecution {
  /** 실행된 행동 */
  action: 'buy' | 'sell';
  /** 종목 코드 */
  market: string;
  /** 체결가 */
  executedPrice: number;
  /** 체결 금액 */
  amount: number;
  /** 수수료 */
  fee: number;
  /** 성공 여부 */
  success: boolean;
  /** 실패 사유 */
  reason: string | null;
}

/** 사이클 로그 (1회 실행 기록) */
export interface CycleLog {
  /** 사이클 고유 ID */
  cycleId: string;
  /** 사이클 시작 시각 */
  startedAt: string;
  /** 사이클 종료 시각 */
  endedAt: string;
  /** 소요 시간 (ms) */
  durationMs: number;
  /** 시장 분석 요약 */
  marketSummary: string;
  /** 종목별 분석 결과 */
  results: MarketCycleResult[];
  /** 실행된 매매 수 */
  executedCount: number;
  /** 사이클 레벨 에러 (전체 실패 시) */
  error: string | null;
  /** 사이클 후 포트폴리오 요약 */
  portfolioSummary: string;
}

// ──────────────────────────────────────────────
// 스케줄러 상태
// ──────────────────────────────────────────────

/** 스케줄러 런타임 상태 */
export interface SchedulerStatus {
  /** 실행 중 여부 */
  running: boolean;
  /** 총 실행 사이클 수 */
  totalCycles: number;
  /** 연속 에러 수 */
  consecutiveErrors: number;
  /** 마지막 사이클 시각 */
  lastCycleAt: string | null;
  /** 다음 사이클 예정 시각 */
  nextCycleAt: string | null;
  /** 시작 시각 */
  startedAt: string | null;
}
