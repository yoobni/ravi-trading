/** BTC 도미넌스 정보 */
export interface BtcDominance {
  /** BTC 24h 거래대금 (KRW) */
  btcTradePrice24h: number;
  /** 전체 KRW 마켓 24h 거래대금 합계 */
  totalTradePrice24h: number;
  /** BTC 도미넌스 비율 (%) */
  dominanceRate: number;
  /** BTC 현재가 */
  btcPrice: number;
  /** BTC 24h 변동률 (%) */
  btcChangeRate: number;
}

/** 거래대금 상위 종목 */
export interface TopVolumeItem {
  /** 마켓 코드 (e.g. "KRW-BTC") */
  market: string;
  /** 한글 이름 */
  koreanName: string;
  /** 현재가 */
  tradePrice: number;
  /** 24h 거래대금 (KRW) */
  accTradePrice24h: number;
  /** 24h 변동률 (%) */
  changeRate: number;
  /** 등락 방향 */
  change: 'RISE' | 'EVEN' | 'FALL';
}

/** 급등/급락 종목 */
export interface SurgeItem {
  market: string;
  koreanName: string;
  tradePrice: number;
  /** 24h 변동률 (%, 부호 포함) */
  signedChangeRate: number;
  /** 24h 거래대금 (KRW) */
  accTradePrice24h: number;
  /** 'surge' = 급등, 'crash' = 급락 */
  type: 'surge' | 'crash';
}

/** 시장 공포/탐욕 지수 근사치 */
export interface FearGreedApprox {
  /** 0 ~ 100 (0 = 극도의 공포, 100 = 극도의 탐욕) */
  score: number;
  /** 등급 라벨 */
  label: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  /** 각 구성 요소 점수 */
  components: {
    /** 변동성 점수 (0~100, 높을수록 탐욕) */
    volatility: number;
    /** 거래량 모멘텀 (0~100) */
    volumeMomentum: number;
    /** 시장 강도 — 상승 종목 비율 기반 (0~100) */
    marketStrength: number;
    /** BTC 도미넌스 역수 기반 (0~100) */
    dominanceFactor: number;
  };
}

/** 시장 전체 흐름 분석 결과 */
export interface MarketAnalysis {
  /** 분석 시각 (ISO 8601) */
  analyzedAt: string;
  /** BTC 도미넌스 */
  btcDominance: BtcDominance;
  /** 거래대금 상위 종목 (기본 20개) */
  topVolume: TopVolumeItem[];
  /** 급등 종목 */
  surges: SurgeItem[];
  /** 급락 종목 */
  crashes: SurgeItem[];
  /** 공포/탐욕 지수 근사치 */
  fearGreed: FearGreedApprox;
  /** 시장 요약 (AI 판단 참고용 텍스트) */
  summary: string;
}
