/**
 * 매매 전략 통합 파이프라인 타입
 *
 * 5단계 파이프라인: 스크리닝 → 분석 → AI판단 → 리스크 → 실행
 * 각 단계의 입출력이 명시적 타입으로 정의되어 추적/디버깅 용이
 */

import type { TradingDecision, DecisionInput, PortfolioContext } from './trading-decision';
import type { MarketAnalysis } from './market-analysis';
import type { TechnicalAnalysis } from './indicator';
import type { SelectionResult } from './market-selector';
import type { RiskCheckResult } from './risk';
import type { CycleExecution } from './scheduler';

// ──────────────────────────────────────────────
// 파이프라인 설정
// ──────────────────────────────────────────────

export interface PipelineConfig {
  /** 캔들 분봉 단위 */
  candleUnit: 5 | 15 | 30 | 60;
  /** 캔들 조회 개수 */
  candleCount: number;
  /** AI 엔진 사용 여부 (false면 알고리즘만) */
  useAI: boolean;
  /** API 호출 간 딜레이 (ms, 업비트 rate limit 대응) */
  apiDelayMs: number;
  /** 최소 캔들 개수 (이하면 분석 스킵) */
  minCandleCount: number;
  /** 최소 매수 금액 (KRW) */
  minBuyAmount: number;
}

// ──────────────────────────────────────────────
// 스테이지별 결과 타입
// ──────────────────────────────────────────────

/** 스테이지 실행 추적 */
export interface StageTrace {
  /** 스테이지 이름 */
  stage: PipelineStage;
  /** 시작 시각 */
  startedAt: string;
  /** 종료 시각 */
  endedAt: string;
  /** 소요 시간 (ms) */
  durationMs: number;
  /** 성공 여부 */
  success: boolean;
  /** 에러 메시지 (실패 시) */
  error: string | null;
}

export type PipelineStage =
  | 'screening'
  | 'analysis'
  | 'judgment'
  | 'risk_check'
  | 'execution';

/** 1단계: 종목 스크리닝 결과 */
export interface ScreeningStageResult {
  /** 선정된 종목 */
  selectedMarkets: string[];
  /** 시장 분석 */
  marketAnalysis: MarketAnalysis;
  /** 종목 선정 상세 (있으면) */
  selectionResult: SelectionResult | null;
}

/** 2단계: 분석 결과 (종목별) */
export interface AnalysisStageResult {
  market: string;
  /** 기술 분석 */
  technicalAnalysis: TechnicalAnalysis;
  /** 현재가 */
  currentPrice: number;
  /** 포트폴리오 컨텍스트 */
  portfolio: PortfolioContext;
}

/** 3단계: AI/알고리즘 판단 결과 (종목별) */
export interface JudgmentStageResult {
  market: string;
  /** 최종 판단 */
  decision: TradingDecision;
  /** 판단 소스 (ai | algorithm) */
  source: 'ai' | 'algorithm';
}

/** 4단계: 리스크 체크 결과 (종목별) */
export interface RiskStageResult {
  market: string;
  /** 원래 판단 */
  originalDecision: TradingDecision;
  /** 리스크 체크 (매수일 때만, 매도/관망은 null) */
  riskCheck: RiskCheckResult | null;
  /** 리스크 체크 후 최종 허용 여부 */
  allowed: boolean;
  /** 조정된 매수 금액 (리스크로 축소된 경우) */
  adjustedAmount: number | null;
  /** 리스크로 차단된 사유 */
  blockReason: string | null;
}

/** 5단계: 실행 결과 (종목별) */
export interface ExecutionStageResult {
  market: string;
  /** 실행 결과 */
  execution: CycleExecution | null;
  /** 미실행 사유 (hold이거나 리스크 차단 시) */
  skipReason: string | null;
}

// ──────────────────────────────────────────────
// 종목별 파이프라인 전체 결과
// ──────────────────────────────────────────────

/** 종목 1개에 대한 파이프라인 전체 결과 */
export interface MarketPipelineResult {
  market: string;
  /** 각 스테이지 결과 */
  analysis: AnalysisStageResult | null;
  judgment: JudgmentStageResult | null;
  riskCheck: RiskStageResult | null;
  execution: ExecutionStageResult | null;
  /** 스테이지별 추적 */
  traces: StageTrace[];
  /** 종합 에러 (스테이지 중 하나라도 실패 시) */
  error: string | null;
}

// ──────────────────────────────────────────────
// 파이프라인 전체 결과
// ──────────────────────────────────────────────

/** 파이프라인 1회 실행 결과 */
export interface PipelineResult {
  /** 실행 ID */
  pipelineId: string;
  /** 시작 시각 */
  startedAt: string;
  /** 종료 시각 */
  endedAt: string;
  /** 총 소요 시간 (ms) */
  durationMs: number;
  /** 스크리닝 결과 */
  screening: ScreeningStageResult;
  /** 종목별 결과 */
  markets: MarketPipelineResult[];
  /** 실행된 매매 수 */
  executedCount: number;
  /** 매수 건수 */
  buyCount: number;
  /** 매도 건수 */
  sellCount: number;
  /** 전체 파이프라인 에러 (스크리닝 단계 실패 등) */
  error: string | null;
  /** 설정 스냅샷 */
  config: PipelineConfig;
}

/** 단일 종목 분석 요청 */
export interface SingleMarketPipelineInput {
  /** 대상 종목 코드 */
  market: string;
  /** 시장 분석 (캐시 재사용 가능) */
  marketAnalysis?: MarketAnalysis;
}

/** 단일 종목 분석 결과 */
export interface SingleMarketPipelineResult {
  pipelineId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  marketAnalysis: MarketAnalysis;
  result: MarketPipelineResult;
  config: PipelineConfig;
}
