/**
 * 종목 선정 알고리즘
 *
 * KRW 마켓 종목 중 매매 대상을 선정합니다.
 *
 * 프로세스:
 *   1. 전체 KRW 마켓 조회 + 현재가 조회
 *   2. 필터링: 최소 거래대금, 과열 변동률, 투자유의 제외
 *   3. 스코어링: 거래대금(30%) + 변동성(30%) + 모멘텀(20%) + 거래량 증가(20%)
 *   4. 상위 N개 선정 + 감시 리스트 자동 갱신
 *
 * 업비트 API 사용: getMarkets(1회) + getTicker(1~2회) = 최대 3회
 */

import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import type { UpbitMarket, UpbitTicker } from '@/types/upbit';
import type {
  MarketSelectorConfig,
  MarketScore,
  WatchlistItem,
  Watchlist,
  SelectionResult,
  SelectionStats,
} from '@/types/market-selector';

// ──────────────────────────────────────────────
// 상수
// ──────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

/** 기본 설정 */
const DEFAULT_CONFIG: MarketSelectorConfig = {
  minTradePrice24h: 1_000_000_000,   // 10억 KRW (일 거래대금)
  maxChangeRate: 25,                  // 25% 이상 변동은 과열로 제외
  excludeCaution: true,               // 투자유의 종목 제외
  selectCount: 5,                     // 최종 5종목 선정
  watchlistMaxSize: 15,               // 감시 리스트 최대 15종목
  watchlistRetainCycles: 12,          // 12사이클(=1시간) 미등재 시 제거
};

/** 스코어링 가중치 */
const SCORE_WEIGHTS = {
  volume: 0.30,       // 거래대금
  volatility: 0.30,   // 변동성 (적정 범위가 최고점)
  momentum: 0.20,     // 모멘텀 (상승/하락 방향)
  volumeSurge: 0.20,  // 거래량 증가세
};

/** 변동성 최적 범위 (%) — 이 범위에서 최고 점수 */
const VOLATILITY_OPTIMAL_MIN = 2;
const VOLATILITY_OPTIMAL_MAX = 8;

// ──────────────────────────────────────────────
// 설정 관리
// ──────────────────────────────────────────────

let currentConfig: MarketSelectorConfig = { ...DEFAULT_CONFIG };

export function getSelectorConfig(): MarketSelectorConfig {
  return { ...currentConfig };
}

export function updateSelectorConfig(
  partial: Partial<MarketSelectorConfig>,
): MarketSelectorConfig {
  currentConfig = { ...currentConfig, ...partial };
  return { ...currentConfig };
}

export function resetSelectorConfig(): MarketSelectorConfig {
  currentConfig = { ...DEFAULT_CONFIG };
  return { ...currentConfig };
}

// ──────────────────────────────────────────────
// 감시 리스트 영속화
// ──────────────────────────────────────────────

function loadWatchlist(): Watchlist {
  if (!fs.existsSync(WATCHLIST_FILE)) {
    return { updatedAt: new Date().toISOString(), cycleNumber: 0, items: [] };
  }
  const raw = fs.readFileSync(WATCHLIST_FILE, 'utf-8');
  return JSON.parse(raw) as Watchlist;
}

function saveWatchlist(watchlist: Watchlist): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2), 'utf-8');
}

export function getWatchlist(): Watchlist {
  return loadWatchlist();
}

// ──────────────────────────────────────────────
// 필터링
// ──────────────────────────────────────────────

function buildNameMap(markets: UpbitMarket[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of markets) {
    map.set(m.market, m.korean_name);
  }
  return map;
}

/** 투자유의/주의 종목 여부 확인 */
function isCautionMarket(market: UpbitMarket): boolean {
  if (!market.market_event) return false;
  if (market.market_event.warning) return true;
  const c = market.market_event.caution;
  return (
    c.PRICE_FLUCTUATIONS ||
    c.TRADING_VOLUME_SOARING ||
    c.DEPOSIT_AMOUNT_SOARING ||
    c.GLOBAL_PRICE_DIFFERENCES ||
    c.CONCENTRATION_OF_SMALL_ACCOUNTS
  );
}

interface FilterResult {
  passed: boolean;
  reason: string | null;
}

function applyFilters(
  ticker: UpbitTicker,
  marketInfo: UpbitMarket | undefined,
  cfg: MarketSelectorConfig,
): FilterResult {
  // 1. 거래대금 필터
  if (ticker.acc_trade_price_24h < cfg.minTradePrice24h) {
    return {
      passed: false,
      reason: `거래대금 미달: ${Math.round(ticker.acc_trade_price_24h / 1e8)}억 < ${Math.round(cfg.minTradePrice24h / 1e8)}억`,
    };
  }

  // 2. 변동성 과열 필터
  const absChangeRate = Math.abs(ticker.signed_change_rate * 100);
  if (absChangeRate > cfg.maxChangeRate) {
    return {
      passed: false,
      reason: `변동률 과열: ${absChangeRate.toFixed(1)}% > ${cfg.maxChangeRate}%`,
    };
  }

  // 3. 투자유의 필터
  if (cfg.excludeCaution && marketInfo && isCautionMarket(marketInfo)) {
    return { passed: false, reason: '투자유의/주의 종목' };
  }

  return { passed: true, reason: null };
}

// ──────────────────────────────────────────────
// 스코어링
// ──────────────────────────────────────────────

/**
 * 거래대금 점수 (0~100).
 * 로그 스케일 적용 — 상위 종목 간 차이를 줄이고 중위권도 의미 있는 점수.
 */
function calcVolumeScore(
  tradePrice24h: number,
  allTradePrices: number[],
): number {
  if (allTradePrices.length === 0) return 0;
  const maxTrade = Math.max(...allTradePrices);
  if (maxTrade === 0) return 0;

  // 로그 스케일 (ln)
  const logVal = Math.log(tradePrice24h + 1);
  const logMax = Math.log(maxTrade + 1);
  return Math.round((logVal / logMax) * 100);
}

/**
 * 변동성 점수 (0~100).
 * 적정 변동성(2~8%)이 최고점, 너무 낮거나 높으면 감점.
 *
 * - 0% 변동 → 20점 (기회 부족)
 * - 2~8% → 100점 (최적 구간)
 * - 15%+ → 30점 (과열 위험)
 */
function calcVolatilityScore(absChangeRate: number): number {
  if (absChangeRate <= VOLATILITY_OPTIMAL_MIN) {
    // 0~2%: 변동성 부족 → 20~100 선형 증가
    return Math.round(20 + (absChangeRate / VOLATILITY_OPTIMAL_MIN) * 80);
  }
  if (absChangeRate <= VOLATILITY_OPTIMAL_MAX) {
    // 2~8%: 최적 구간 → 100점
    return 100;
  }
  // 8%+: 과열 → 100에서 감소 (25%에서 30점까지)
  const excess = absChangeRate - VOLATILITY_OPTIMAL_MAX;
  const maxExcess = 17; // 25% - 8%
  const penalty = Math.min(1, excess / maxExcess) * 70;
  return Math.max(0, Math.round(100 - penalty));
}

/**
 * 모멘텀 점수 (0~100).
 * 상승 종목에 가점, 하락 종목에 약간의 기회 점수.
 *
 * - 강한 상승(5%+) → 90점
 * - 완만한 상승(1~5%) → 70점
 * - 보합 → 50점
 * - 완만한 하락(-1~-5%) → 40점 (반등 기회)
 * - 급락(-5%+) → 55점 (역발상 기회 가점)
 */
function calcMomentumScore(changeRate: number): number {
  if (changeRate >= 5) return 90;
  if (changeRate >= 1) return 60 + Math.round((changeRate - 1) / 4 * 30);
  if (changeRate >= -1) return 50;
  if (changeRate >= -5) return 40;
  // 급락 종목: 역발상 매수 기회 (but 과열 필터에서 극단적인 건 이미 제외)
  return 55;
}

/**
 * 거래량 증가 점수 (0~100).
 * acc_trade_price(당일 누적) vs acc_trade_price_24h(24h) 비율로 추정.
 *
 * - 당일 누적이 24h 대비 높으면 → 거래량 증가 추세
 * - 비율 0.5 이상이면 활발, 0.3 이하면 소강
 */
function calcVolumeSurgeScore(
  accTradePrice: number,
  accTradePrice24h: number,
): number {
  if (accTradePrice24h === 0) return 50;

  // 당일 누적 / 24h 누적 → 시간 보정 (대략 0~1)
  // 하루의 절반이 지났다면 0.5가 정상
  const ratio = accTradePrice / accTradePrice24h;

  // 정상(0.4~0.6) → 50점, 높을수록(거래량 집중) → 최대 100점
  if (ratio >= 0.8) return 100;
  if (ratio >= 0.5) return Math.round(50 + (ratio - 0.5) / 0.3 * 50);
  if (ratio >= 0.3) return Math.round(30 + (ratio - 0.3) / 0.2 * 20);
  return 20;
}

/** 종합 점수 계산 (가중 합산) */
function calcTotalScore(
  volumeScore: number,
  volatilityScore: number,
  momentumScore: number,
  volumeSurgeScore: number,
): number {
  return Math.round(
    volumeScore * SCORE_WEIGHTS.volume +
    volatilityScore * SCORE_WEIGHTS.volatility +
    momentumScore * SCORE_WEIGHTS.momentum +
    volumeSurgeScore * SCORE_WEIGHTS.volumeSurge,
  );
}

// ──────────────────────────────────────────────
// 감시 리스트 갱신
// ──────────────────────────────────────────────

function updateWatchlist(
  prevWatchlist: Watchlist,
  selectedScores: MarketScore[],
  cfg: MarketSelectorConfig,
): Watchlist {
  const now = new Date().toISOString();
  const nextCycle = prevWatchlist.cycleNumber + 1;

  // 기존 항목 맵 (market → item)
  const prevMap = new Map<string, WatchlistItem>();
  for (const item of prevWatchlist.items) {
    prevMap.set(item.market, item);
  }

  // 새 항목 빌드: 선정된 종목들
  const newItems: WatchlistItem[] = [];
  const selectedMarkets = new Set<string>();

  for (const score of selectedScores) {
    selectedMarkets.add(score.market);
    const prev = prevMap.get(score.market);

    if (prev) {
      // 기존 항목 갱신
      newItems.push({
        ...prev,
        updatedAt: now,
        consecutiveCycles: prev.consecutiveCycles + 1,
        lastScore: score.totalScore,
        lastPrice: score.tradePrice,
        priceChangeFromAdd:
          prev.priceAtAdd > 0
            ? Math.round(((score.tradePrice - prev.priceAtAdd) / prev.priceAtAdd) * 10000) / 100
            : 0,
      });
    } else {
      // 신규 등록
      newItems.push({
        market: score.market,
        koreanName: score.koreanName,
        addedAt: now,
        updatedAt: now,
        consecutiveCycles: 1,
        lastScore: score.totalScore,
        priceAtAdd: score.tradePrice,
        lastPrice: score.tradePrice,
        priceChangeFromAdd: 0,
      });
    }
  }

  // 기존 항목 중 이번에 선정되지 않았지만 유지 기간 내인 것 보존
  for (const prev of prevWatchlist.items) {
    if (selectedMarkets.has(prev.market)) continue;

    const cyclesSinceUpdate = nextCycle - prevWatchlist.cycleNumber;
    const totalInactive = cyclesSinceUpdate; // 이번 사이클에서 선정 안 됨

    if (prev.consecutiveCycles > 0 && totalInactive <= cfg.watchlistRetainCycles) {
      newItems.push({
        ...prev,
        updatedAt: now,
        consecutiveCycles: 0, // 연속 등재 리셋
      });
    }
    // watchlistRetainCycles 초과 시 자동 제거 (아무것도 하지 않음)
  }

  // 최대 크기 제한 (점수순 정렬 후 잘라냄)
  newItems.sort((a, b) => b.lastScore - a.lastScore);
  const trimmed = newItems.slice(0, cfg.watchlistMaxSize);

  return {
    updatedAt: now,
    cycleNumber: nextCycle,
    items: trimmed,
  };
}

// ──────────────────────────────────────────────
// 메인 선정 함수
// ──────────────────────────────────────────────

/**
 * KRW 마켓 종목 선정.
 *
 * 1. 전체 KRW 마켓 + 현재가 조회
 * 2. 필터링 (거래대금 / 변동률 / 투자유의)
 * 3. 스코어링 (거래대금 + 변동성 + 모멘텀 + 거래량 증가)
 * 4. 상위 N개 선정 + 감시 리스트 갱신
 *
 * API 호출: getMarkets(1) + getTicker(1~2) = 최대 3회
 *
 * @param holdingMarkets 보유 종목 코드 목록 — 보유 종목은 선정 대상에서 제외
 */
export async function selectMarkets(
  holdingMarkets: string[] = [],
): Promise<SelectionResult> {
  const cfg = currentConfig;
  const client = getUpbitClient();

  // 1. 마켓 목록 조회
  const allMarkets = await client.getMarkets();
  const krwMarkets = allMarkets.filter((m) => m.market.startsWith('KRW-'));
  const nameMap = buildNameMap(krwMarkets);
  const marketInfoMap = new Map<string, UpbitMarket>();
  for (const m of krwMarkets) {
    marketInfoMap.set(m.market, m);
  }

  // 2. 전 종목 현재가 조회
  const marketCodes = krwMarkets.map((m) => m.market);
  const tickers: UpbitTicker[] = [];
  for (let i = 0; i < marketCodes.length; i += 100) {
    const chunk = marketCodes.slice(i, i + 100);
    const result = await client.getTicker(chunk);
    tickers.push(...result);
  }

  // 거래대금 목록 (볼륨 스코어 정규화용)
  const allTradePrices = tickers.map((t) => t.acc_trade_price_24h);

  // 보유 종목 세트
  const holdingSet = new Set(holdingMarkets);

  // 3. 필터링 + 스코어링
  const stats: SelectionStats = {
    totalKrwMarkets: krwMarkets.length,
    passedVolumeFilter: 0,
    passedVolatilityFilter: 0,
    excludedCaution: 0,
    candidateCount: 0,
    selectedCount: 0,
  };

  const scores: MarketScore[] = [];

  for (const ticker of tickers) {
    const marketInfo = marketInfoMap.get(ticker.market);
    const changeRate = ticker.signed_change_rate * 100;
    const absChangeRate = Math.abs(changeRate);

    // 필터 적용
    const filter = applyFilters(ticker, marketInfo, cfg);

    // 통계 수집
    if (ticker.acc_trade_price_24h >= cfg.minTradePrice24h) {
      stats.passedVolumeFilter++;
    }
    if (absChangeRate <= cfg.maxChangeRate) {
      stats.passedVolatilityFilter++;
    }
    if (cfg.excludeCaution && marketInfo && isCautionMarket(marketInfo)) {
      stats.excludedCaution++;
    }

    // 스코어 계산 (필터 미통과도 기록)
    const volumeScore = calcVolumeScore(ticker.acc_trade_price_24h, allTradePrices);
    const volatilityScore = calcVolatilityScore(absChangeRate);
    const momentumScore = calcMomentumScore(changeRate);
    const volumeSurgeScore = calcVolumeSurgeScore(
      ticker.acc_trade_price,
      ticker.acc_trade_price_24h,
    );
    const totalScore = calcTotalScore(volumeScore, volatilityScore, momentumScore, volumeSurgeScore);

    scores.push({
      market: ticker.market,
      koreanName: nameMap.get(ticker.market) ?? ticker.market,
      tradePrice: ticker.trade_price,
      accTradePrice24h: ticker.acc_trade_price_24h,
      changeRate: Math.round(changeRate * 100) / 100,
      change: ticker.change,
      volumeScore,
      volatilityScore,
      momentumScore,
      volumeSurgeScore,
      totalScore,
      passed: filter.passed,
      filterReason: filter.reason,
    });
  }

  // 4. 후보 정렬 (필터 통과 + 보유 종목 제외)
  const candidates = scores
    .filter((s) => s.passed && !holdingSet.has(s.market))
    .sort((a, b) => b.totalScore - a.totalScore);

  stats.candidateCount = candidates.length;

  // 5. 상위 N개 선정
  const selected = candidates.slice(0, cfg.selectCount);
  stats.selectedCount = selected.length;

  // 6. 감시 리스트 갱신
  // 감시 대상 = 선정 종목 + 차점자 (watchlistMaxSize까지)
  const watchlistCandidates = candidates.slice(0, cfg.watchlistMaxSize);
  const prevWatchlist = loadWatchlist();
  const newWatchlist = updateWatchlist(prevWatchlist, watchlistCandidates, cfg);
  saveWatchlist(newWatchlist);

  const selectedMarkets = selected.map((s) => s.market);

  console.log(
    `[종목선정] ${stats.totalKrwMarkets}개 중 ${stats.candidateCount}개 후보 → ${stats.selectedCount}개 선정: ${selectedMarkets.join(', ')}`,
  );

  return {
    selectedAt: new Date().toISOString(),
    selectedMarkets,
    scores,
    watchlist: newWatchlist,
    stats,
  };
}

/**
 * 감시 리스트에 있는 종목 코드만 반환.
 * 스케줄러에서 보유 종목 + 감시 종목을 합쳐서 분석 대상으로 사용.
 */
export function getWatchlistMarkets(): string[] {
  const watchlist = loadWatchlist();
  return watchlist.items.map((item) => item.market);
}

/**
 * 특정 종목이 감시 리스트에 있는지 확인.
 */
export function isOnWatchlist(market: string): boolean {
  const watchlist = loadWatchlist();
  return watchlist.items.some((item) => item.market === market);
}
