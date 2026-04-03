import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import { getOpenPositions } from '@/lib/order-store';
import { executeSell, loadBalance } from '@/lib/paper-trading-engine';
import type {
  EmergencyReason,
  EmergencyLiquidationResult,
} from '@/types/error';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EMERGENCY_LOG_FILE = path.join(DATA_DIR, 'emergency-logs.json');

// ──────────────────────────────────────────────
// 긴급 청산 실행
// ──────────────────────────────────────────────

/**
 * 모든 보유 포지션을 긴급 청산합니다.
 *
 * 1. 보유 포지션 목록 조회
 * 2. 현재가 조회 시도 (실패 시 마지막 알려진 가격 또는 매수가 사용)
 * 3. 전체 포지션 매도 실행
 * 4. 결과를 파일에 기록
 *
 * @param reason 청산 사유
 * @param fallbackPrices 현재가 조회 실패 시 사용할 가격 맵 (선택)
 */
export async function emergencyLiquidateAll(
  reason: EmergencyReason,
  fallbackPrices?: Record<string, number>,
): Promise<EmergencyLiquidationResult> {
  const triggeredAt = new Date().toISOString();
  const openPositions = getOpenPositions();

  console.error(`\n[긴급 청산] ========== 시작 (사유: ${reason}) ==========`);
  console.error(`[긴급 청산] 대상 포지션: ${openPositions.length}건`);

  if (openPositions.length === 0) {
    const result: EmergencyLiquidationResult = {
      reason,
      triggeredAt,
      totalPositions: 0,
      liquidatedCount: 0,
      failures: [],
      cashAfter: loadBalance().cash,
    };
    appendEmergencyLog(result);
    console.error('[긴급 청산] 보유 포지션 없음 — 청산 불필요');
    return result;
  }

  // 현재가 조회 시도
  const currentPrices: Record<string, number> = {};
  const markets = [...new Set(openPositions.map((p) => p.market))];

  try {
    const client = getUpbitClient();
    const tickers = await client.getTicker(markets);
    for (const t of tickers) {
      currentPrices[t.market] = t.trade_price;
    }
    console.error(`[긴급 청산] 현재가 조회 성공: ${Object.keys(currentPrices).length}종목`);
  } catch (err) {
    console.error(`[긴급 청산] 현재가 조회 실패 — 대체 가격 사용`);
    // fallbackPrices 또는 매수가를 사용
    if (fallbackPrices) {
      Object.assign(currentPrices, fallbackPrices);
    }
  }

  // 포지션별 매도 실행
  const failures: EmergencyLiquidationResult['failures'] = [];
  let liquidatedCount = 0;

  for (const position of openPositions) {
    // 현재가: API 조회 > fallback > 매수가 (최후 수단)
    const price = currentPrices[position.market] ?? position.price;
    const reasoning = `[긴급 청산] 사유: ${reason} — 안전 처리를 위한 전량 매도`;

    try {
      const result = executeSell(position.id, price, reasoning);

      if (result.success) {
        liquidatedCount++;
        console.error(
          `[긴급 청산] ${position.market} 매도 성공 — ` +
          `${result.executedPrice.toLocaleString()}원 × ${result.totalSettlement.toLocaleString()}원`,
        );
      } else {
        failures.push({
          market: position.market,
          orderId: position.id,
          error: result.reason ?? '알 수 없는 오류',
        });
        console.error(
          `[긴급 청산] ${position.market} 매도 실패: ${result.reason}`,
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push({
        market: position.market,
        orderId: position.id,
        error: errorMsg,
      });
      console.error(`[긴급 청산] ${position.market} 매도 예외: ${errorMsg}`);
    }
  }

  // 결과 기록
  let cashAfter: number | null = null;
  try {
    cashAfter = loadBalance().cash;
  } catch {
    // 잔고 조회 실패 — null 유지
  }

  const result: EmergencyLiquidationResult = {
    reason,
    triggeredAt,
    totalPositions: openPositions.length,
    liquidatedCount,
    failures,
    cashAfter,
  };

  appendEmergencyLog(result);

  console.error(
    `[긴급 청산] ========== 완료 ` +
    `(${liquidatedCount}/${openPositions.length}건 성공, ${failures.length}건 실패) ==========`,
  );

  return result;
}

// ──────────────────────────────────────────────
// 긴급 청산 로그 저장
// ──────────────────────────────────────────────

function appendEmergencyLog(result: EmergencyLiquidationResult): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let logs: EmergencyLiquidationResult[] = [];
    if (fs.existsSync(EMERGENCY_LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(EMERGENCY_LOG_FILE, 'utf-8'));
    }
    logs.push(result);
    // 최근 100건만 유지
    if (logs.length > 100) {
      logs = logs.slice(-100);
    }
    fs.writeFileSync(EMERGENCY_LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[긴급 청산] 로그 저장 실패:', err);
  }
}

/** 긴급 청산 로그 조회 */
export function getEmergencyLogs(): EmergencyLiquidationResult[] {
  if (!fs.existsSync(EMERGENCY_LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(EMERGENCY_LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}
