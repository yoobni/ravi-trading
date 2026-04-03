/**
 * AI 판단 엔진 (Claude API) 타입 정의
 */

import type { DecisionAction, TradingDecision } from './trading-decision';

/** Claude API 호출 설정 */
export interface AIJudgmentConfig {
  /** 사용할 Claude 모델 ID */
  model: string;
  /** 최대 토큰 수 */
  maxTokens: number;
  /** 온도 (0 = 결정적, 1 = 창의적). 매매 판단은 낮게 설정 */
  temperature: number;
  /** API 호출 최소 간격 (ms). 과도한 호출 방지 */
  minIntervalMs: number;
  /** API 타임아웃 (ms) */
  timeoutMs: number;
  /** API 실패 시 알고리즘 엔진 폴백 사용 여부 */
  fallbackToAlgorithm: boolean;
}

/** Claude에게 전달할 구조화된 시장 요약 */
export interface MarketPromptContext {
  /** 종목 코드 */
  market: string;
  /** 현재가 */
  currentPrice: number;
  /** 기술 지표 요약 */
  technical: {
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
  };
  /** 시장 흐름 요약 */
  marketSentiment: {
    fearGreedScore: number;
    fearGreedLabel: string;
    btcDominance: number;
    btcChangeRate: number;
    surgeCount: number;
    crashCount: number;
    topVolumeMarkets: string[];
  };
  /** 포트폴리오 상태 */
  portfolio: {
    isHolding: boolean;
    avgBuyPrice: number | null;
    currentProfitRate: number | null;
    holdingCount: number;
    availableBalance: number;
    todayTradeCount: number;
    todayRealizedPnL: number;
  };
}

/** Claude가 반환할 판단 구조 (tool_use로 강제) */
export interface AIJudgmentResponse {
  /** 매수/매도/관망 */
  action: DecisionAction;
  /** 신뢰도 0~100 */
  confidence: number;
  /** 종합 점수 -100 ~ 100 */
  compositeScore: number;
  /** 제안 매매 비율 0~1 */
  suggestedSizeRate: number;
  /** 제안 손절가 (매수 시) */
  suggestedStopLoss: number | null;
  /** 제안 익절가 (매수 시) */
  suggestedTakeProfit: number | null;
  /** 판단 근거 (한글, 구조화된 분석) */
  reasoning: string;
  /** 핵심 시그널 목록 */
  keySignals: AIKeySignal[];
}

/** AI가 식별한 핵심 시그널 */
export interface AIKeySignal {
  /** 시그널 이름 (예: "RSI 과매도 반등") */
  name: string;
  /** 방향: bullish/bearish/neutral */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 중요도 1~5 */
  importance: number;
  /** 설명 */
  description: string;
}

/** AI 판단 로그 (저장용) */
export interface AIJudgmentLog {
  /** 고유 ID */
  id: string;
  /** 판단 시각 */
  timestamp: string;
  /** 마켓 코드 */
  market: string;
  /** 입력 컨텍스트 */
  input: MarketPromptContext;
  /** AI 응답 원문 */
  rawResponse: AIJudgmentResponse | null;
  /** 최종 TradingDecision */
  decision: TradingDecision;
  /** 사용한 엔진 */
  engine: 'claude' | 'algorithm' | 'fallback';
  /** API 응답 시간 (ms) */
  latencyMs: number;
  /** 토큰 사용량 */
  tokenUsage: { input: number; output: number } | null;
  /** 에러 (있을 경우) */
  error: string | null;
}
