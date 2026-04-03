/**
 * 판단 로그 시스템 타입 정의
 *
 * 매 판단 사이클마다 기록되는 통합 로그:
 * 분석된 지표값 → AI 판단 원문 → 매매 결정 → 실행 결과
 */

import type { DecisionAction } from './trading-decision';

/** 분석된 기술 지표 스냅샷 */
export interface IndicatorSnapshot {
  rsi: number | null;
  rsiTrend: 'rising' | 'falling' | 'flat';
  macdHistogram: number | null;
  macdCross: 'golden' | 'dead' | 'none';
  bollingerPercentB: number | null;
  bollingerBandwidth: number | null;
  maAlignment: 'bullish' | 'bearish' | 'mixed';
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  volumeRatio: number;
  volumeSurge: boolean;
  obvTrend: 'rising' | 'falling' | 'flat';
}

/** 시장 심리 스냅샷 */
export interface SentimentSnapshot {
  fearGreedScore: number;
  fearGreedLabel: string;
  btcDominance: number;
  btcChangeRate: number;
  surgeCount: number;
  crashCount: number;
}

/** 포트폴리오 스냅샷 */
export interface PortfolioSnapshot {
  isHolding: boolean;
  avgBuyPrice: number | null;
  currentProfitRate: number | null;
  holdingCount: number;
  availableBalance: number;
}

/** AI 판단 원문 */
export interface AIJudgmentRaw {
  engine: 'claude' | 'algorithm' | 'fallback';
  action: DecisionAction;
  confidence: number;
  compositeScore: number;
  reasoning: string;
  keySignals: {
    name: string;
    direction: 'bullish' | 'bearish' | 'neutral';
    importance: number;
    description: string;
  }[];
  suggestedSizeRate: number;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
  latencyMs: number;
  tokenUsage: { input: number; output: number } | null;
}

/** 매매 실행 결과 */
export interface ExecutionResult {
  executed: boolean;
  action: DecisionAction;
  executedPrice: number | null;
  amount: number | null;
  fee: number | null;
  success: boolean;
  skipReason: string | null;
}

/** 리스크 체크 결과 */
export interface RiskCheckResult {
  checked: boolean;
  allowed: boolean;
  adjustedAmount: number | null;
  blockReason: string | null;
}

/** 통합 판단 로그 (1종목 1사이클) */
export interface DecisionLog {
  /** 고유 ID */
  id: string;
  /** 소속 파이프라인(사이클) ID */
  pipelineId: string;
  /** 종목 코드 */
  market: string;
  /** 현재가 */
  currentPrice: number;
  /** 판단 시각 */
  timestamp: string;
  /** 분석된 기술 지표 */
  indicators: IndicatorSnapshot;
  /** 시장 심리 */
  sentiment: SentimentSnapshot;
  /** 포트폴리오 상태 */
  portfolio: PortfolioSnapshot;
  /** AI 판단 원문 */
  aiJudgment: AIJudgmentRaw;
  /** 리스크 체크 */
  riskCheck: RiskCheckResult;
  /** 실행 결과 */
  execution: ExecutionResult;
  /** 파이프라인 스테이지별 소요 시간 (ms) */
  stageDurations: Record<string, number>;
  /** 전체 소요 시간 (ms) */
  totalDurationMs: number;
}

/** 파이프라인(사이클) 단위 판단 로그 */
export interface PipelineDecisionLog {
  /** 파이프라인 ID */
  pipelineId: string;
  /** 사이클 시작 시각 */
  startedAt: string;
  /** 사이클 종료 시각 */
  endedAt: string;
  /** 전체 소요 시간 (ms) */
  durationMs: number;
  /** 분석 종목 수 */
  marketCount: number;
  /** 실행된 매매 수 */
  executedCount: number;
  /** 종목별 판단 로그 */
  decisions: DecisionLog[];
  /** 에러 (전체 실패 시) */
  error: string | null;
}

/** 판단 로그 조회 필터 */
export interface DecisionLogFilter {
  date?: string;
  market?: string;
  action?: DecisionAction;
  engine?: 'claude' | 'algorithm' | 'fallback';
  executedOnly?: boolean;
  limit?: number;
}

/** 판단 로그 날짜별 요약 */
export interface DecisionLogDailySummary {
  date: string;
  totalDecisions: number;
  byAction: Record<string, number>;
  byEngine: Record<string, number>;
  executedCount: number;
  avgConfidence: number;
  avgLatencyMs: number;
}
