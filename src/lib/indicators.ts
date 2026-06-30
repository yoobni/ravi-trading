import type { UpbitCandle } from '@/types/upbit';
import type {
  MAResult,
  RSIResult,
  MACDResult,
  BollingerBandResult,
  VolumeAnalysis,
  TechnicalAnalysis,
} from '@/types/indicator';

// ──────────────────────────────────────────────
// 이동평균선 (Simple Moving Average)
// ──────────────────────────────────────────────

/** SMA 계산 — closes[0]이 가장 최근 */
export function calcSMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += closes[i - j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

/** EMA 계산 — closes[0]이 가장 최근 */
export function calcEMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    if (i === period - 1) {
      // 초기값: SMA
      let sum = 0;
      for (let j = 0; j < period; j++) sum += closes[i - j];
      result.push(sum / period);
      continue;
    }
    const prev = result[i - 1];
    if (prev === null) {
      result.push(null);
      continue;
    }
    result.push(closes[i] * k + prev * (1 - k));
  }
  return result;
}

/** 이동평균선 래퍼 */
export function calcMA(closes: number[], period: number): MAResult {
  return { period, values: calcSMA(closes, period) };
}

/**
 * ATR (Average True Range) — Wilder's smoothing.
 * @param highs/lows/closes — 시간순(과거→최신) 배열
 * @returns 같은 길이 배열, period 이전엔 null
 */
export function calcATR(
  highs: number[], lows: number[], closes: number[], period = 14,
): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return result;

  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) trs.push(highs[i] - lows[i]);
    else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      trs.push(Math.max(hl, hc, lc));
    }
  }

  // 초기 ATR = SMA of first period TRs
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  result[period - 1] = atr;

  // Wilder's smoothing
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result[i] = atr;
  }
  return result;
}

/**
 * 누적 VWAP — 시작 인덱스부터 누적 계산.
 * 백테스트에서 일별 리셋하려면 caller가 일별 split 후 호출.
 * @returns 같은 길이 배열, 각 시점까지의 누적 VWAP
 */
export function calcCumulativeVWAP(
  highs: number[], lows: number[], closes: number[], volumes: number[],
): number[] {
  const n = closes.length;
  const result: number[] = new Array(n).fill(0);
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < n; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV += typical * volumes[i];
    cumV += volumes[i];
    result[i] = cumV > 0 ? cumPV / cumV : typical;
  }
  return result;
}

// ──────────────────────────────────────────────
// RSI (Relative Strength Index)
// ──────────────────────────────────────────────

export function calcRSI(closes: number[], period = 14): RSIResult {
  const result: (number | null)[] = new Array(closes.length).fill(null);

  if (closes.length < period + 1) return { period, values: result };

  // 변화량 계산 (시간순: 과거→최근이므로 reverse 후 사용)
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // 초기 평균 상승/하락 (첫 period 개)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // 첫 RSI
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  // Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }

  return { period, values: result };
}

// ──────────────────────────────────────────────
// MACD (Moving Average Convergence Divergence)
// ──────────────────────────────────────────────

export function calcMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const fastEMA = calcEMA(closes, fastPeriod);
  const slowEMA = calcEMA(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = fastEMA[i];
    const s = slowEMA[i];
    if (f === null || s === null) return null;
    return f - s;
  });

  // Signal line = EMA of MACD line
  // MACD 값이 null이 아닌 것만 추출 후 EMA 계산
  const validMacd: number[] = [];
  const validIndices: number[] = [];
  macdLine.forEach((v, i) => {
    if (v !== null) {
      validMacd.push(v);
      validIndices.push(i);
    }
  });

  const signalValues = calcEMA(validMacd, signalPeriod);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  validIndices.forEach((origIdx, i) => {
    signal[origIdx] = signalValues[i];
  });

  // Histogram = MACD - Signal
  const histogram: (number | null)[] = closes.map((_, i) => {
    const m = macdLine[i];
    const s = signal[i];
    if (m === null || s === null) return null;
    return m - s;
  });

  return { macd: macdLine, signal, histogram };
}

// ──────────────────────────────────────────────
// 볼린저 밴드 (Bollinger Bands)
// ──────────────────────────────────────────────

export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerBandResult {
  const middle = calcSMA(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const bandwidth: (number | null)[] = [];
  const percentB: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    const mid = middle[i];
    if (mid === null || i < period - 1) {
      upper.push(null);
      lower.push(null);
      bandwidth.push(null);
      percentB.push(null);
      continue;
    }

    // 표준편차
    let sumSq = 0;
    for (let j = 0; j < period; j++) {
      const diff = closes[i - j] - mid;
      sumSq += diff * diff;
    }
    const stdDev = Math.sqrt(sumSq / period);

    const u = mid + stdDevMultiplier * stdDev;
    const l = mid - stdDevMultiplier * stdDev;
    upper.push(u);
    lower.push(l);
    bandwidth.push(mid === 0 ? null : (u - l) / mid);
    percentB.push(u - l === 0 ? null : (closes[i] - l) / (u - l));
  }

  return { upper, middle, lower, bandwidth, percentB };
}

// ──────────────────────────────────────────────
// 거래량 분석
// ──────────────────────────────────────────────

export function calcVolumeAnalysis(
  volumes: number[],
  closes: number[],
  period = 20,
  surgeThreshold = 2.0,
): VolumeAnalysis {
  const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;

  // 평균 거래량
  const recentVolumes = volumes.slice(-period);
  const avgVolume =
    recentVolumes.length > 0
      ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
      : 0;

  const volumeRatio = avgVolume === 0 ? 0 : currentVolume / avgVolume;
  const isSurge = volumeRatio >= surgeThreshold;

  // OBV (On-Balance Volume)
  const obv: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const prev = obv[i - 1];
    if (closes[i] > closes[i - 1]) {
      obv.push(prev + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      obv.push(prev - volumes[i]);
    } else {
      obv.push(prev);
    }
  }

  return { currentVolume, avgVolume, volumeRatio, isSurge, obv };
}

// ──────────────────────────────────────────────
// 캔들 데이터 → 종합 기술 분석
// ──────────────────────────────────────────────

/**
 * 업비트 캔들 배열로 전체 기술 분석 수행.
 * 캔들은 업비트 API 응답 그대로 (최신이 [0]) 넘기면 내부에서 시간순 정렬합니다.
 */
export function analyze(candles: UpbitCandle[]): TechnicalAnalysis {
  if (candles.length === 0) {
    throw new Error('캔들 데이터가 비어있습니다.');
  }

  // 업비트 API는 최신→과거 순 → 시간순(과거→최신)으로 정렬
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  const closes = sorted.map((c) => c.trade_price);
  const volumes = sorted.map((c) => c.candle_acc_trade_volume);
  const market = sorted[0].market;
  const timestamp = sorted[sorted.length - 1].timestamp;

  // ATR 정보 (사이즈 조정용)
  const highs = sorted.map((c) => c.high_price);
  const lows = sorted.map((c) => c.low_price);
  const atrSeries = calcATR(highs, lows, closes, 14);
  const lastAtr = atrSeries[atrSeries.length - 1];
  let atrInfo: TechnicalAnalysis['atrInfo'];
  if (lastAtr !== null) {
    // 최근 100캔들 ATR (또는 lookback 전체)에서 percentile
    const lookback = Math.min(100, atrSeries.length);
    const recent = atrSeries.slice(-lookback).filter((v): v is number => v !== null);
    if (recent.length > 10) {
      const belowCount = recent.filter((v) => v < lastAtr).length;
      const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
      atrInfo = {
        current: lastAtr,
        percentile: (belowCount / recent.length) * 100,
        ratioToAvg: avg > 0 ? lastAtr / avg : 1,
      };
    }
  }

  return {
    market,
    timestamp,
    candles: sorted,
    ma: {
      ma5: calcMA(closes, 5),
      ma20: calcMA(closes, 20),
      ma60: calcMA(closes, 60),
    },
    rsi: calcRSI(closes),
    macd: calcMACD(closes),
    bollingerBand: calcBollingerBands(closes),
    volume: calcVolumeAnalysis(volumes, closes),
    atrInfo,
  };
}
