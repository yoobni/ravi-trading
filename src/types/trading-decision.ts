/**
 * AI 매매 판단 엔진 타입 정의
 * 입력: 기술 지표 + 시장 흐름 + 포트폴리오
 * 출력: 매수/매도/관망 + 판단 근거 + 신뢰도
 */

/** 매매 판단 결과 */
export type DecisionAction = 'buy' | 'sell' | 'hold';

/** 개별 전략 시그널 */
export interface StrategySignal {
  /** 전략 이름 */
  name: string;
  /** 시그널: -1(강한 매도) ~ 0(중립) ~ 1(강한 매수) */
  score: number;
  /** 가중치 (0~1) */
  weight: number;
  /** 판단 근거 */
  reason: string;
}

/** 최종 매매 판단 */
export interface TradingDecision {
  /** 마켓 코드 (예: KRW-BTC) */
  market: string;
  /** 판단 시각 */
  timestamp: string;
  /** 매수/매도/관망 */
  action: DecisionAction;
  /** 신뢰도 0~100 */
  confidence: number;
  /** 종합 점수 -100(강한 매도) ~ 0(관망) ~ 100(강한 매수) */
  compositeScore: number;
  /** 개별 전략 시그널 목록 */
  signals: StrategySignal[];
  /** 판단 근거 요약 (사람이 읽을 수 있는 텍스트) */
  reasoning: string;
  /** 제안 매매 비율 (0~1, 전체 가용 자금 대비) */
  suggestedSizeRate: number;
  /** 현재가 */
  currentPrice: number;
  /** 제안 손절가 */
  suggestedStopLoss: number | null;
  /** 제안 익절가 */
  suggestedTakeProfit: number | null;
}

/** 판단 엔진 설정 */
export interface DecisionEngineConfig {
  /** 매수 임계값 (compositeScore 이상이면 매수) */
  buyThreshold: number;
  /** 매도 임계값 (compositeScore 이하이면 매도) */
  sellThreshold: number;
  /** 최소 신뢰도 (이 이하면 관망) */
  minConfidence: number;
  /** 전략별 가중치 오버라이드 */
  strategyWeights: Record<string, number>;
}

/** 판단 엔진 입력 */
export interface DecisionInput {
  market: string;
  currentPrice: number;
  /** 기술 지표 (indicators.ts analyze 결과) */
  technicalAnalysis: import('./indicator').TechnicalAnalysis;
  /** 시장 흐름 (market-analysis.ts analyzeMarket 결과) */
  marketAnalysis: import('./market-analysis').MarketAnalysis;
  /** 보유 포지션 정보 */
  portfolio: PortfolioContext;
}

/** 포트폴리오 컨텍스트 */
export interface PortfolioContext {
  /** 현재 보유 중인지 */
  isHolding: boolean;
  /** 보유 시 평균 매수가 */
  avgBuyPrice: number | null;
  /** 보유 시 현재 수익률 */
  currentProfitRate: number | null;
  /** 보유 종목 수 */
  holdingCount: number;
  /** 총 보유 금액 */
  totalPositionAmount: number;
  /** 가용 자금 */
  availableBalance: number;
  /** 오늘 거래 횟수 */
  todayTradeCount: number;
  /** 오늘 실현 손익 */
  todayRealizedPnL: number;
}
