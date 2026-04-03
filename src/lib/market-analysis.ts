import { getUpbitClient } from '@/lib/upbit-client';
import type { UpbitTicker, UpbitMarket } from '@/types/upbit';
import type {
  MarketAnalysis,
  BtcDominance,
  TopVolumeItem,
  SurgeItem,
  FearGreedApprox,
} from '@/types/market-analysis';

// ──────────────────────────────────────────────
// 설정값
// ──────────────────────────────────────────────

/** 급등/급락 판정 기준 변동률 (%) */
const SURGE_THRESHOLD = 10;
const CRASH_THRESHOLD = -10;

/** 거래대금 상위 종목 수 */
const TOP_VOLUME_COUNT = 20;

/** 급등/급락 최소 거래대금 필터 (KRW) — 너무 소량 종목 제외 */
const MIN_TRADE_PRICE_FOR_SURGE = 100_000_000; // 1억

// ──────────────────────────────────────────────
// 마켓 이름 매핑 헬퍼
// ──────────────────────────────────────────────

function buildNameMap(markets: UpbitMarket[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of markets) {
    map.set(m.market, m.korean_name);
  }
  return map;
}

// ──────────────────────────────────────────────
// BTC 도미넌스
// ──────────────────────────────────────────────

function calcBtcDominance(tickers: UpbitTicker[]): BtcDominance {
  const btc = tickers.find((t) => t.market === 'KRW-BTC');
  const totalTradePrice24h = tickers.reduce((sum, t) => sum + t.acc_trade_price_24h, 0);
  const btcTradePrice24h = btc?.acc_trade_price_24h ?? 0;

  return {
    btcTradePrice24h,
    totalTradePrice24h,
    dominanceRate: totalTradePrice24h > 0
      ? Math.round((btcTradePrice24h / totalTradePrice24h) * 10000) / 100
      : 0,
    btcPrice: btc?.trade_price ?? 0,
    btcChangeRate: btc ? Math.round(btc.signed_change_rate * 10000) / 100 : 0,
  };
}

// ──────────────────────────────────────────────
// 거래대금 상위 종목
// ──────────────────────────────────────────────

function calcTopVolume(
  tickers: UpbitTicker[],
  nameMap: Map<string, string>,
  count: number = TOP_VOLUME_COUNT,
): TopVolumeItem[] {
  return [...tickers]
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, count)
    .map((t) => ({
      market: t.market,
      koreanName: nameMap.get(t.market) ?? t.market,
      tradePrice: t.trade_price,
      accTradePrice24h: t.acc_trade_price_24h,
      changeRate: Math.round(t.signed_change_rate * 10000) / 100,
      change: t.change,
    }));
}

// ──────────────────────────────────────────────
// 급등/급락 감지
// ──────────────────────────────────────────────

function detectSurgesAndCrashes(
  tickers: UpbitTicker[],
  nameMap: Map<string, string>,
): { surges: SurgeItem[]; crashes: SurgeItem[] } {
  const surges: SurgeItem[] = [];
  const crashes: SurgeItem[] = [];

  for (const t of tickers) {
    // 최소 거래대금 필터
    if (t.acc_trade_price_24h < MIN_TRADE_PRICE_FOR_SURGE) continue;

    const pct = t.signed_change_rate * 100;

    if (pct >= SURGE_THRESHOLD) {
      surges.push({
        market: t.market,
        koreanName: nameMap.get(t.market) ?? t.market,
        tradePrice: t.trade_price,
        signedChangeRate: Math.round(pct * 100) / 100,
        accTradePrice24h: t.acc_trade_price_24h,
        type: 'surge',
      });
    } else if (pct <= CRASH_THRESHOLD) {
      crashes.push({
        market: t.market,
        koreanName: nameMap.get(t.market) ?? t.market,
        tradePrice: t.trade_price,
        signedChangeRate: Math.round(pct * 100) / 100,
        accTradePrice24h: t.acc_trade_price_24h,
        type: 'crash',
      });
    }
  }

  // 변동률 절대값 기준 정렬
  surges.sort((a, b) => b.signedChangeRate - a.signedChangeRate);
  crashes.sort((a, b) => a.signedChangeRate - b.signedChangeRate);

  return { surges, crashes };
}

// ──────────────────────────────────────────────
// 공포/탐욕 지수 근사치
// ──────────────────────────────────────────────

/**
 * 업비트 KRW 마켓 데이터만으로 공포/탐욕 지수를 근사 계산.
 *
 * 구성 요소 (각 0~100, 가중 평균):
 * 1. 변동성 (25%) — 전체 종목 평균 절대 변동률의 역수 (변동성 높으면 공포)
 * 2. 거래량 모멘텀 (25%) — 상위 10종목 거래대금 집중도
 * 3. 시장 강도 (30%) — 상승 종목 비율
 * 4. BTC 도미넌스 역수 (20%) — 도미넌스 낮을수록 알트 시즌(탐욕)
 */
function calcFearGreed(
  tickers: UpbitTicker[],
  dominance: BtcDominance,
): FearGreedApprox {
  if (tickers.length === 0) {
    return {
      score: 50,
      label: 'neutral',
      components: { volatility: 50, volumeMomentum: 50, marketStrength: 50, dominanceFactor: 50 },
    };
  }

  // 1. 변동성 — 평균 절대 변동률 → 0~100 변환
  //    변동률 0% → 100(탐욕), 10%+ → 0(공포)
  const avgAbsChange =
    tickers.reduce((sum, t) => sum + Math.abs(t.signed_change_rate), 0) / tickers.length;
  const volatility = Math.max(0, Math.min(100, 100 - avgAbsChange * 100 * 10));

  // 2. 거래량 모멘텀 — 상위 10종목 거래대금 비중
  //    비중 낮으면(분산) → 탐욕, 비중 높으면(집중) → 공포
  const sorted = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
  const top10Price = sorted.slice(0, 10).reduce((s, t) => s + t.acc_trade_price_24h, 0);
  const totalPrice = tickers.reduce((s, t) => s + t.acc_trade_price_24h, 0);
  const top10Ratio = totalPrice > 0 ? top10Price / totalPrice : 1;
  // top10 비중 50% → 중립, 30% → 탐욕(100), 80% → 공포(0)
  const volumeMomentum = Math.max(0, Math.min(100, (1 - (top10Ratio - 0.3) / 0.5) * 100));

  // 3. 시장 강도 — 상승 종목 비율
  const riseCount = tickers.filter((t) => t.change === 'RISE').length;
  const marketStrength = Math.round((riseCount / tickers.length) * 100);

  // 4. BTC 도미넌스 역수 — 도미넌스 높으면 공포, 낮으면 탐욕
  //    도미넌스 30% → 중립(50), 10% → 탐욕(100), 50%+ → 공포(0)
  const dom = dominance.dominanceRate;
  const dominanceFactor = Math.max(0, Math.min(100, (1 - (dom - 10) / 40) * 100));

  // 가중 평균
  const score = Math.round(
    volatility * 0.25 +
    volumeMomentum * 0.25 +
    marketStrength * 0.30 +
    dominanceFactor * 0.20,
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  return {
    score: clampedScore,
    label: getLabel(clampedScore),
    components: {
      volatility: Math.round(volatility),
      volumeMomentum: Math.round(volumeMomentum),
      marketStrength,
      dominanceFactor: Math.round(dominanceFactor),
    },
  };
}

function getLabel(score: number): FearGreedApprox['label'] {
  if (score <= 20) return 'extreme_fear';
  if (score <= 40) return 'fear';
  if (score <= 60) return 'neutral';
  if (score <= 80) return 'greed';
  return 'extreme_greed';
}

// ──────────────────────────────────────────────
// 시장 요약 텍스트 생성
// ──────────────────────────────────────────────

function buildSummary(
  dominance: BtcDominance,
  fearGreed: FearGreedApprox,
  surges: SurgeItem[],
  crashes: SurgeItem[],
  topVolume: TopVolumeItem[],
): string {
  const labelKo: Record<FearGreedApprox['label'], string> = {
    extreme_fear: '극도의 공포',
    fear: '공포',
    neutral: '중립',
    greed: '탐욕',
    extreme_greed: '극도의 탐욕',
  };

  const lines: string[] = [];

  lines.push(
    `[시장 심리] ${labelKo[fearGreed.label]} (${fearGreed.score}/100)`,
  );
  lines.push(
    `[BTC] ${dominance.btcPrice.toLocaleString()}원 (${dominance.btcChangeRate > 0 ? '+' : ''}${dominance.btcChangeRate}%), 도미넌스 ${dominance.dominanceRate}%`,
  );

  if (surges.length > 0) {
    const top3 = surges.slice(0, 3).map((s) => `${s.koreanName}(+${s.signedChangeRate}%)`);
    lines.push(`[급등] ${top3.join(', ')}`);
  }
  if (crashes.length > 0) {
    const top3 = crashes.slice(0, 3).map((s) => `${s.koreanName}(${s.signedChangeRate}%)`);
    lines.push(`[급락] ${top3.join(', ')}`);
  }

  const top3Vol = topVolume.slice(0, 3).map((v) => v.koreanName);
  lines.push(`[거래대금 TOP3] ${top3Vol.join(', ')}`);

  return lines.join(' | ');
}

// ──────────────────────────────────────────────
// 메인 분석 함수
// ──────────────────────────────────────────────

/**
 * 업비트 KRW 마켓 전체 시장 흐름 분석.
 *
 * 1회 호출 시 API 2회 (getMarkets, getTicker) 사용.
 * 업비트 API 제한: 초당 10회 / 분당 600회이므로 5분 간격 호출에 안전.
 */
export async function analyzeMarket(): Promise<MarketAnalysis> {
  const client = getUpbitClient();

  // 1. KRW 마켓 목록 조회
  const allMarkets = await client.getMarkets();
  const krwMarkets = allMarkets.filter((m) => m.market.startsWith('KRW-'));
  const nameMap = buildNameMap(krwMarkets);
  const marketCodes = krwMarkets.map((m) => m.market);

  // 2. 전 종목 현재가 조회 (최대 100개씩 분할)
  const tickers: UpbitTicker[] = [];
  for (let i = 0; i < marketCodes.length; i += 100) {
    const chunk = marketCodes.slice(i, i + 100);
    const result = await client.getTicker(chunk);
    tickers.push(...result);
  }

  // 3. 각 지표 계산
  const btcDominance = calcBtcDominance(tickers);
  const topVolume = calcTopVolume(tickers, nameMap);
  const { surges, crashes } = detectSurgesAndCrashes(tickers, nameMap);
  const fearGreed = calcFearGreed(tickers, btcDominance);
  const summary = buildSummary(btcDominance, fearGreed, surges, crashes, topVolume);

  return {
    analyzedAt: new Date().toISOString(),
    btcDominance,
    topVolume,
    surges,
    crashes,
    fearGreed,
    summary,
  };
}

/**
 * 특정 종목들만 대상으로 급등/급락 감지.
 * 이미 보유 중인 종목 감시 등에 활용.
 */
export async function detectSurgesForMarkets(
  markets: string[],
): Promise<{ surges: SurgeItem[]; crashes: SurgeItem[] }> {
  if (markets.length === 0) return { surges: [], crashes: [] };

  const client = getUpbitClient();
  const allMarkets = await client.getMarkets();
  const nameMap = buildNameMap(allMarkets);
  const tickers = await client.getTicker(markets);

  return detectSurgesAndCrashes(tickers, nameMap);
}
