/**
 * 종목 선정 알고리즘 타입 정의
 *
 * KRW 마켓 종목 중 매매 대상을 선정하기 위한 타입들.
 * 거래대금 필터링 → 변동성 스코어링 → 감시 리스트 자동 관리.
 */

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────

/** 종목 선정 필터 설정 */
export interface MarketSelectorConfig {
  /** 최소 24h 거래대금 (KRW) — 이 이하 종목 제외 */
  minTradePrice24h: number;
  /** 최대 24h 변동률 절대값 (%) — 이 이상이면 과열로 제외 */
  maxChangeRate: number;
  /** 업비트 투자유의/주의 종목 제외 여부 */
  excludeCaution: boolean;
  /** 최종 선정 종목 수 */
  selectCount: number;
  /** 감시 리스트 최대 크기 (선정 종목 + 후보 종목) */
  watchlistMaxSize: number;
  /** 감시 리스트 유지 기간 (사이클 수) — 이후 자동 제거 */
  watchlistRetainCycles: number;
}

// ──────────────────────────────────────────────
// 스코어링
// ──────────────────────────────────────────────

/** 개별 종목 스코어 */
export interface MarketScore {
  /** 마켓 코드 (e.g. "KRW-BTC") */
  market: string;
  /** 한글 이름 */
  koreanName: string;
  /** 현재가 */
  tradePrice: number;
  /** 24h 거래대금 (KRW) */
  accTradePrice24h: number;
  /** 24h 변동률 (%, 부호 포함) */
  changeRate: number;
  /** 등락 방향 */
  change: 'RISE' | 'EVEN' | 'FALL';

  /** 거래대금 점수 (0~100) */
  volumeScore: number;
  /** 변동성 점수 (0~100, 적정 변동성이 최고점) */
  volatilityScore: number;
  /** 모멘텀 점수 (0~100) */
  momentumScore: number;
  /** 거래량 증가 점수 (0~100) — 전일 대비 거래대금 증가율 */
  volumeSurgeScore: number;
  /** 종합 점수 (가중 합산, 0~100) */
  totalScore: number;

  /** 필터 통과 여부 */
  passed: boolean;
  /** 필터 미통과 사유 (passed=false일 때) */
  filterReason: string | null;
}

// ──────────────────────────────────────────────
// 감시 리스트
// ──────────────────────────────────────────────

/** 감시 리스트 항목 */
export interface WatchlistItem {
  /** 마켓 코드 */
  market: string;
  /** 한글 이름 */
  koreanName: string;
  /** 최초 등록 시각 */
  addedAt: string;
  /** 마지막 갱신 시각 */
  updatedAt: string;
  /** 연속 등재 사이클 수 */
  consecutiveCycles: number;
  /** 최근 종합 점수 */
  lastScore: number;
  /** 등록 시 가격 */
  priceAtAdd: number;
  /** 현재 가격 (마지막 갱신 기준) */
  lastPrice: number;
  /** 등록 이후 가격 변동률 (%) */
  priceChangeFromAdd: number;
}

/** 감시 리스트 전체 */
export interface Watchlist {
  /** 갱신 시각 */
  updatedAt: string;
  /** 갱신 사이클 번호 */
  cycleNumber: number;
  /** 감시 항목 목록 */
  items: WatchlistItem[];
}

// ──────────────────────────────────────────────
// 선정 결과
// ──────────────────────────────────────────────

/** 종목 선정 결과 */
export interface SelectionResult {
  /** 선정 시각 */
  selectedAt: string;
  /** 선정된 종목 코드 목록 (매매 대상) */
  selectedMarkets: string[];
  /** 전체 스코어 목록 (필터 통과 여부 포함) */
  scores: MarketScore[];
  /** 갱신된 감시 리스트 */
  watchlist: Watchlist;
  /** 필터링 통계 */
  stats: SelectionStats;
}

/** 필터링 통계 */
export interface SelectionStats {
  /** 전체 KRW 마켓 수 */
  totalKrwMarkets: number;
  /** 거래대금 필터 통과 수 */
  passedVolumeFilter: number;
  /** 변동성 필터 통과 수 */
  passedVolatilityFilter: number;
  /** 투자유의 제외 수 */
  excludedCaution: number;
  /** 최종 후보 수 */
  candidateCount: number;
  /** 최종 선정 수 */
  selectedCount: number;
}
