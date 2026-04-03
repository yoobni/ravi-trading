import fs from 'fs';
import path from 'path';
import type {
  PaperTradingConfig,
  FeeConfig,
  AccountBalance,
  HoldingPosition,
  ExecutionResult,
  PortfolioValuation,
  PositionValuation,
} from '@/types/paper-trading';
import type { Order } from '@/types/order';
import { createOrder, type CreateOrderResult } from '@/lib/order-store';
import { validateOrder, recordTrade } from '@/lib/risk-manager';

// ──────────────────────────────────────────────
// 상수 및 경로
// ──────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BALANCE_FILE = path.join(DATA_DIR, 'account-balance.json');
const CONFIG_FILE = path.join(DATA_DIR, 'paper-trading-config.json');

const DEFAULT_FEE: FeeConfig = {
  feeRate: 0.0005,      // 0.05%
  slippageRate: 0.0005,  // 0.05%
};

const DEFAULT_CONFIG: PaperTradingConfig = {
  initialCapital: 10_000_000, // 1,000만원
  fee: DEFAULT_FEE,
};

// ──────────────────────────────────────────────
// 설정 관리
// ──────────────────────────────────────────────

/** 엔진 설정 로드 */
export function loadConfig(): PaperTradingConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, fee: { ...DEFAULT_FEE } };
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as PaperTradingConfig;
}

/** 엔진 설정 저장 */
export function saveConfig(config: PaperTradingConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** 엔진 설정 업데이트 */
export function updateConfig(partial: Partial<PaperTradingConfig>): PaperTradingConfig {
  const current = loadConfig();
  const updated: PaperTradingConfig = {
    ...current,
    ...partial,
    fee: { ...current.fee, ...(partial.fee ?? {}) },
  };
  saveConfig(updated);
  return updated;
}

// ──────────────────────────────────────────────
// 잔고 관리
// ──────────────────────────────────────────────

/** 잔고 초기화 (최초 또는 리셋) */
export function initializeBalance(capital?: number): AccountBalance {
  const config = loadConfig();
  const initialCapital = capital ?? config.initialCapital;

  const balance: AccountBalance = {
    cash: initialCapital,
    initialCapital,
    holdings: [],
    totalEquity: initialCapital,
    totalRealizedPnl: 0,
    totalFeesPaid: 0,
    updatedAt: new Date().toISOString(),
  };

  saveBalance(balance);
  return balance;
}

/** 잔고 로드 (없으면 초기화) */
export function loadBalance(): AccountBalance {
  if (!fs.existsSync(BALANCE_FILE)) {
    return initializeBalance();
  }
  const raw = fs.readFileSync(BALANCE_FILE, 'utf-8');
  return JSON.parse(raw) as AccountBalance;
}

/** 잔고 저장 */
function saveBalance(balance: AccountBalance): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BALANCE_FILE, JSON.stringify(balance, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// 가격 계산 (슬리피지 반영)
// ──────────────────────────────────────────────

/**
 * 슬리피지 반영 체결가 계산.
 * - 매수: 현재가보다 약간 높게 체결 (불리한 방향)
 * - 매도: 현재가보다 약간 낮게 체결 (불리한 방향)
 */
function applySlippage(
  price: number,
  side: 'buy' | 'sell',
  slippageRate: number,
): number {
  if (side === 'buy') {
    return Math.round(price * (1 + slippageRate));
  }
  return Math.round(price * (1 - slippageRate));
}

/** 수수료 계산 */
function calculateFee(amount: number, feeRate: number): number {
  return Math.round(amount * feeRate);
}

// ──────────────────────────────────────────────
// 모의 매수
// ──────────────────────────────────────────────

/**
 * 모의 매수 실행.
 *
 * 1. 현재가에 슬리피지 적용 → 체결가
 * 2. 체결가 × 수량 + 수수료 = 총 결제 금액
 * 3. 잔고 차감, 포지션 추가, 주문 기록
 *
 * @param market    종목 코드 (e.g. "KRW-BTC")
 * @param currentPrice  현재 시장가 (KRW)
 * @param amount    매수 금액 (KRW) — 수량은 자동 계산
 * @param reasoning AI 판단 근거
 * @param ticker    리스크 체크용 시세 정보 (선택)
 */
export function executeBuy(
  market: string,
  currentPrice: number,
  amount: number,
  reasoning: string,
  ticker?: { accTradePrice24h: number; signedChangeRate: number },
): ExecutionResult {
  const config = loadConfig();
  const balance = loadBalance();

  // ── 기본 검증 ──
  if (amount <= 0) {
    return failResult('매수 금액은 0보다 커야 합니다.', currentPrice, balance.cash);
  }

  if (currentPrice <= 0) {
    return failResult('현재가가 유효하지 않습니다.', currentPrice, balance.cash);
  }

  // ── 리스크 검증 (규칙 기반 + AI 리스크 필터) ──
  const riskCheck = validateOrder(
    market,
    amount,
    reasoning,
    ticker,
  );
  if (!riskCheck.allowed) {
    const reasons = riskCheck.violations
      .filter((v) => v.severity === 'block')
      .map((v) => v.message)
      .join('; ');
    return failResult(`리스크 차단: ${reasons}`, currentPrice, balance.cash);
  }

  // 리스크 매니저가 조정한 금액 사용
  const adjustedAmount = riskCheck.adjustedAmount ?? amount;

  // ── 슬리피지 반영 체결가 ──
  const executedPrice = applySlippage(currentPrice, 'buy', config.fee.slippageRate);

  // ── 수량 계산 (금액 기반) ──
  const volume = adjustedAmount / executedPrice;
  if (volume <= 0) {
    return failResult('계산된 수량이 0 이하입니다.', executedPrice, balance.cash);
  }

  // ── 수수료 계산 ──
  const grossAmount = executedPrice * volume;
  const feeAmount = calculateFee(grossAmount, config.fee.feeRate);
  const totalSettlement = grossAmount + feeAmount;

  // ── 잔고 확인 ──
  if (totalSettlement > balance.cash) {
    return failResult(
      `잔고 부족: 필요 ${totalSettlement.toLocaleString()}원, 보유 ${balance.cash.toLocaleString()}원`,
      executedPrice,
      balance.cash,
    );
  }

  // ── 주문 기록 생성 ──
  const result = createOrder({
    market,
    side: 'buy',
    volume,
    price: executedPrice,
    reasoning,
    fee: feeAmount,
    settlement: totalSettlement,
  });

  if (!result.success) {
    return failResult(`주문 기록 실패: ${result.error}`, executedPrice, balance.cash);
  }

  const order = result.order;

  // ── 잔고 차감 ──
  balance.cash -= totalSettlement;
  balance.totalFeesPaid += feeAmount;

  // ── 포지션 추가 ──
  balance.holdings.push({
    orderId: order.id,
    market,
    volume,
    avgPrice: executedPrice,
    totalCost: totalSettlement,
    boughtAt: order.createdAt,
  });

  // ── 총 평가 갱신 (매수가 기준) ──
  balance.totalEquity = balance.cash + balance.holdings.reduce(
    (sum, h) => sum + h.avgPrice * h.volume,
    0,
  );
  balance.updatedAt = new Date().toISOString();
  saveBalance(balance);

  // ── 일일 통계 기록 ──
  recordTrade(0); // 매수 시에는 실현 손익 없음

  return {
    success: true,
    order,
    executedPrice,
    feeAmount,
    totalSettlement,
    cashAfter: balance.cash,
    reason: null,
  };
}

// ──────────────────────────────────────────────
// 모의 매도
// ──────────────────────────────────────────────

/**
 * 모의 매도 실행.
 *
 * 1. 보유 포지션 확인
 * 2. 현재가에 슬리피지 적용 → 체결가
 * 3. 체결가 × 수량 - 수수료 = 수령 금액
 * 4. 잔고 증가, 포지션 제거, 주문 기록
 *
 * @param orderId       매도할 매수 주문 ID
 * @param currentPrice  현재 시장가 (KRW)
 * @param reasoning     AI 판단 근거
 * @param volumeToSell  부분 매도 수량 (미지정 시 전량 매도)
 */
export function executeSell(
  orderId: string,
  currentPrice: number,
  reasoning: string,
  volumeToSell?: number,
): ExecutionResult {
  const config = loadConfig();
  const balance = loadBalance();

  // ── 포지션 확인 ──
  const holdingIdx = balance.holdings.findIndex((h) => h.orderId === orderId);
  if (holdingIdx === -1) {
    return failResult(
      `보유 포지션을 찾을 수 없습니다: ${orderId}`,
      currentPrice,
      balance.cash,
    );
  }

  const holding = balance.holdings[holdingIdx];

  if (currentPrice <= 0) {
    return failResult('현재가가 유효하지 않습니다.', currentPrice, balance.cash);
  }

  // ── 매도 수량 결정 ──
  const sellVolume = volumeToSell ?? holding.volume;
  if (sellVolume <= 0 || sellVolume > holding.volume) {
    return failResult(
      `매도 수량 오류: 요청 ${sellVolume}, 보유 ${holding.volume}`,
      currentPrice,
      balance.cash,
    );
  }

  // ── 슬리피지 반영 체결가 ──
  const executedPrice = applySlippage(currentPrice, 'sell', config.fee.slippageRate);

  // ── 수수료 계산 ──
  const grossAmount = executedPrice * sellVolume;
  const feeAmount = calculateFee(grossAmount, config.fee.feeRate);
  const totalSettlement = grossAmount - feeAmount;

  // ── 수익률 계산 ──
  const costBasis = holding.avgPrice * sellVolume;
  const costFee = calculateFee(costBasis, config.fee.feeRate); // 매수 시 지불한 수수료 비례분
  const realizedPnl = totalSettlement - (costBasis + costFee);

  // ── 주문 기록 생성 ──
  const result = createOrder({
    market: holding.market,
    side: 'sell',
    volume: sellVolume,
    price: executedPrice,
    reasoning,
    linkedOrderId: orderId,
    fee: feeAmount,
    settlement: totalSettlement,
  });

  if (!result.success) {
    return failResult(`주문 기록 실패: ${result.error}`, executedPrice, balance.cash);
  }

  const order = result.order;

  // ── 잔고 증가 ──
  balance.cash += totalSettlement;
  balance.totalFeesPaid += feeAmount;
  balance.totalRealizedPnl += realizedPnl;

  // ── 포지션 업데이트 ──
  if (sellVolume >= holding.volume) {
    // 전량 매도 → 포지션 제거
    balance.holdings.splice(holdingIdx, 1);
  } else {
    // 부분 매도 → 수량/비용 차감
    const ratio = sellVolume / holding.volume;
    holding.volume -= sellVolume;
    holding.totalCost -= holding.totalCost * ratio;
  }

  // ── 총 평가 갱신 ──
  balance.totalEquity = balance.cash + balance.holdings.reduce(
    (sum, h) => sum + h.avgPrice * h.volume,
    0,
  );
  balance.updatedAt = new Date().toISOString();
  saveBalance(balance);

  // ── 일일 통계 기록 ──
  recordTrade(realizedPnl);

  return {
    success: true,
    order,
    executedPrice,
    feeAmount,
    totalSettlement,
    cashAfter: balance.cash,
    reason: null,
  };
}

// ──────────────────────────────────────────────
// 포트폴리오 평가
// ──────────────────────────────────────────────

/**
 * 현재가 기반 포트폴리오 전체 평가.
 *
 * @param currentPrices  종목별 현재가 맵 { "KRW-BTC": 95000000 }
 */
export function evaluatePortfolio(
  currentPrices: Record<string, number>,
): PortfolioValuation {
  const balance = loadBalance();

  const positions: PositionValuation[] = balance.holdings.map((h) => {
    const currentPrice = currentPrices[h.market] ?? h.avgPrice;
    const currentValue = currentPrice * h.volume;
    const unrealizedPnl = currentValue - h.totalCost;
    const unrealizedPnlRate = h.totalCost > 0
      ? (unrealizedPnl / h.totalCost) * 100
      : 0;

    return {
      orderId: h.orderId,
      market: h.market,
      volume: h.volume,
      avgPrice: h.avgPrice,
      currentPrice,
      currentValue: Math.round(currentValue),
      totalCost: h.totalCost,
      unrealizedPnl: Math.round(unrealizedPnl),
      unrealizedPnlRate: Math.round(unrealizedPnlRate * 100) / 100,
    };
  });

  const totalPositionValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalEquity = balance.cash + totalPositionValue;
  const totalReturnRate = balance.initialCapital > 0
    ? ((totalEquity - balance.initialCapital) / balance.initialCapital) * 100
    : 0;

  return {
    cash: balance.cash,
    positions,
    totalPositionValue,
    totalEquity: Math.round(totalEquity),
    unrealizedPnl,
    realizedPnl: balance.totalRealizedPnl,
    totalReturnRate: Math.round(totalReturnRate * 100) / 100,
    totalFeesPaid: balance.totalFeesPaid,
    valuedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// 특정 종목 전량 매도 헬퍼
// ──────────────────────────────────────────────

/**
 * 특정 종목의 모든 보유 포지션을 전량 매도.
 *
 * @param market        종목 코드
 * @param currentPrice  현재가
 * @param reasoning     매도 사유
 */
export function sellAllByMarket(
  market: string,
  currentPrice: number,
  reasoning: string,
): ExecutionResult[] {
  const balance = loadBalance();
  const marketHoldings = balance.holdings.filter((h) => h.market === market);

  if (marketHoldings.length === 0) {
    return [{
      success: false,
      order: null,
      executedPrice: currentPrice,
      feeAmount: 0,
      totalSettlement: 0,
      cashAfter: balance.cash,
      reason: `${market} 보유 포지션 없음`,
    }];
  }

  return marketHoldings.map((h) =>
    executeSell(h.orderId, currentPrice, reasoning),
  );
}

// ──────────────────────────────────────────────
// 계좌 리셋
// ──────────────────────────────────────────────

/**
 * 모의 거래 계좌 초기화.
 * 모든 포지션 청산, 잔고를 초기 자본으로 복원.
 */
export function resetAccount(newCapital?: number): AccountBalance {
  return initializeBalance(newCapital);
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

/** 실패 결과 생성 헬퍼 */
function failResult(
  reason: string,
  executedPrice: number,
  cashAfter: number,
): ExecutionResult {
  return {
    success: false,
    order: null,
    executedPrice,
    feeAmount: 0,
    totalSettlement: 0,
    cashAfter,
    reason,
  };
}

/** 현재 잔고 요약 (로깅용) */
export function getBalanceSummary(): string {
  const balance = loadBalance();
  const holdingCount = balance.holdings.length;
  const holdingValue = balance.holdings.reduce(
    (sum, h) => sum + h.avgPrice * h.volume,
    0,
  );

  return [
    `현금: ${balance.cash.toLocaleString()}원`,
    `보유: ${holdingCount}건 (${Math.round(holdingValue).toLocaleString()}원)`,
    `총 평가: ${Math.round(balance.totalEquity).toLocaleString()}원`,
    `실현 손익: ${balance.totalRealizedPnl.toLocaleString()}원`,
    `총 수수료: ${balance.totalFeesPaid.toLocaleString()}원`,
  ].join(' | ');
}
