import type { UpbitCandle } from './upbit';

/** 이동평균선 결과 */
export interface MAResult {
  period: number;
  values: (number | null)[];
}

/** RSI 결과 */
export interface RSIResult {
  period: number;
  values: (number | null)[];
}

/** MACD 결과 */
export interface MACDResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/** 볼린저 밴드 결과 */
export interface BollingerBandResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
  bandwidth: (number | null)[];
  percentB: (number | null)[];
}

/** 거래량 분석 결과 */
export interface VolumeAnalysis {
  /** 현재 거래량 */
  currentVolume: number;
  /** 평균 거래량 (period 기간) */
  avgVolume: number;
  /** 거래량 비율 (현재 / 평균) */
  volumeRatio: number;
  /** 거래량 급증 여부 (ratio > threshold) */
  isSurge: boolean;
  /** OBV (On-Balance Volume) */
  obv: number[];
}

/** 전체 기술 분석 결과 */
export interface TechnicalAnalysis {
  market: string;
  timestamp: number;
  candles: UpbitCandle[];
  ma: {
    ma5: MAResult;
    ma20: MAResult;
    ma60: MAResult;
  };
  rsi: RSIResult;
  macd: MACDResult;
  bollingerBand: BollingerBandResult;
  volume: VolumeAnalysis;
}
