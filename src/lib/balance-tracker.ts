import fs from 'fs';
import path from 'path';
import { getOpenPositions, listOrders, calculateUnrealizedProfitRate } from '@/lib/order-store';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BALANCE_FILE = path.join(DATA_DIR, 'balance.json');

// ──────────────────────────────────────────────
// 잔고 타입
// ──────────────────────────────────────────────

/** KRW 잔고 상태 */
export interface BalanceState {
  /** 초기 자본금 (KRW) */
  initialCapital: number;
  /** 현재 가용 KRW 잔고 */
  availableKrw: number;
  /** 마지막 갱신 시각 (ISO 8601) */
  updatedAt: string;
}

/** 포트폴리오 전체 현황 */
export interface PortfolioSnapshot {
  /** KRW 가용 잔고 */
  availableKrw: number;
  /** 보유 포지션 총 평가액 */
  totalPositionValue: number;
  /** 총 자산 (KRW + 포지션 평가액) */
  totalAssets: number;
  /** 총 수익률 (%, 초기 자본 대비) */
  totalReturnRate: number;
  /** 총 미실현 손익 (KRW) */
  unrealizedPnl: number;
  /** 종목별 보유 현황 */
  holdings: HoldingInfo[];
  /** 스냅샷 시각 */
  snapshotAt: string;
}

/** 개별 종목 보유 현황 */
export interface HoldingInfo {
  /** 종목 코드 */
  market: string;
  /** 매수 주문 ID */
  orderId: string;
  /** 매수 수량 */
  volume: number;
  /** 매수 단가 */
  buyPrice: number;
  /** 매수 총액 */
  buyAmount: number;
  /** 현재가 (전달된 경우) */
  currentPrice: number | null;
  /** 미실현 수익률 (%) */
  profitRate: number | null;
  /** 미실현 손익 (KRW) */
  unrealizedPnl: number | null;
}

// ──────────────────────────────────────────────
// 잔고 로드 / 저장
// ──────────────────────────────────────────────

const DEFAULT_INITIAL_CAPITAL = 10_000_000; // 1,000만원

function loadBalance(): BalanceState {
  if (!fs.existsSync(BALANCE_FILE)) {
    const initial: BalanceState = {
      initialCapital: DEFAULT_INITIAL_CAPITAL,
      availableKrw: DEFAULT_INITIAL_CAPITAL,
      updatedAt: new Date().toISOString(),
    };
    saveBalance(initial);
    return initial;
  }
  const raw = fs.readFileSync(BALANCE_FILE, 'utf-8');
  return JSON.parse(raw) as BalanceState;
}

function saveBalance(state: BalanceState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BALANCE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// 잔고 관리
// ──────────────────────────────────────────────

/** 현재 가용 잔고 조회 */
export function getAvailableBalance(): number {
  return loadBalance().availableKrw;
}

/** 잔고 상태 전체 조회 */
export function getBalanceState(): BalanceState {
  return loadBalance();
}

/** 초기 자본금 설정 (처음 세팅 또는 리셋 시) */
export function initializeBalance(capital: number): BalanceState {
  if (capital <= 0 || !isFinite(capital)) {
    throw new Error(`자본금은 0보다 큰 유한한 숫자여야 합니다: ${capital}`);
  }
  const state: BalanceState = {
    initialCapital: capital,
    availableKrw: capital,
    updatedAt: new Date().toISOString(),
  };
  saveBalance(state);
  return state;
}

/** 매수 시 잔고 차감 — 잔고 부족 시 false 반환 */
export function deductBalance(amount: number): boolean {
  if (amount <= 0) return false;
  const state = loadBalance();
  if (state.availableKrw < amount) return false;

  state.availableKrw = Math.round(state.availableKrw - amount);
  state.updatedAt = new Date().toISOString();
  saveBalance(state);
  return true;
}

/** 매도 시 잔고 복구 */
export function addBalance(amount: number): void {
  if (amount <= 0) return;
  const state = loadBalance();
  state.availableKrw = Math.round(state.availableKrw + amount);
  state.updatedAt = new Date().toISOString();
  saveBalance(state);
}

// ──────────────────────────────────────────────
// 포트폴리오 스냅샷
// ──────────────────────────────────────────────

/**
 * 포트폴리오 전체 현황 스냅샷.
 * @param currentPrices 종목별 현재가 맵 { "KRW-BTC": 50000000 }
 */
export function getPortfolioSnapshot(
  currentPrices?: Record<string, number>,
): PortfolioSnapshot {
  const balanceState = loadBalance();
  const positions = getOpenPositions();

  const holdings: HoldingInfo[] = positions.map((pos) => {
    const currentPrice = currentPrices?.[pos.market] ?? null;
    let profitRate: number | null = null;
    let unrealizedPnl: number | null = null;

    if (currentPrice !== null) {
      const calc = calculateUnrealizedProfitRate(pos, currentPrice);
      profitRate = calc.profitRate;
      unrealizedPnl = calc.unrealizedPnl;
    }

    return {
      market: pos.market,
      orderId: pos.id,
      volume: pos.volume,
      buyPrice: pos.price,
      buyAmount: pos.totalAmount,
      currentPrice,
      profitRate,
      unrealizedPnl,
    };
  });

  const totalPositionValue = holdings.reduce((sum, h) => {
    if (h.currentPrice !== null) {
      return sum + h.currentPrice * h.volume;
    }
    // 현재가 없으면 매수가로 평가
    return sum + h.buyAmount;
  }, 0);

  const totalAssets = Math.round(balanceState.availableKrw + totalPositionValue);
  const totalReturnRate =
    balanceState.initialCapital > 0
      ? Math.round(((totalAssets - balanceState.initialCapital) / balanceState.initialCapital) * 100 * 100) / 100
      : 0;

  const unrealizedPnl = holdings.reduce((sum, h) => sum + (h.unrealizedPnl ?? 0), 0);

  return {
    availableKrw: balanceState.availableKrw,
    totalPositionValue: Math.round(totalPositionValue),
    totalAssets,
    totalReturnRate,
    unrealizedPnl: Math.round(unrealizedPnl),
    holdings,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * 주문 기록 기반 잔고 재계산 (정합성 복구용).
 * orders.json에서 전체 거래 내역을 역추적하여 잔고를 복원합니다.
 */
export function recalculateBalance(): BalanceState {
  const state = loadBalance();
  const orders = listOrders({ limit: 10000 });

  // 오래된 순서로 처리
  const sorted = [...orders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  let balance = state.initialCapital;

  for (const order of sorted) {
    if (order.status !== 'filled') continue;
    if (order.side === 'buy') {
      balance -= order.totalAmount;
    } else if (order.side === 'sell') {
      balance += order.totalAmount;
    }
  }

  state.availableKrw = Math.round(balance);
  state.updatedAt = new Date().toISOString();
  saveBalance(state);
  return state;
}
