/**
 * 트레일링 스탑을 위한 포지션별 고점 추적기.
 *
 * 보유 포지션별로 매수 이후 최고가를 기록하고,
 * 매 사이클마다 현재가와 비교하여 갱신합니다.
 * 포지션 매도 시 자동으로 기록을 삭제합니다.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HIGH_PRICES_FILE = path.join(DATA_DIR, 'high-prices.json');

/** 포지션별 고점 기록 { orderId: highPrice } */
type HighPriceMap = Record<string, number>;

function load(): HighPriceMap {
  if (!fs.existsSync(HIGH_PRICES_FILE)) return {};
  const raw = fs.readFileSync(HIGH_PRICES_FILE, 'utf-8');
  return JSON.parse(raw) as HighPriceMap;
}

function save(map: HighPriceMap): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HIGH_PRICES_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

/**
 * 현재가로 고점 갱신.
 * 새 포지션이면 등록, 기존보다 높으면 갱신.
 *
 * @param orderId  매수 주문 ID
 * @param currentPrice  현재 시장가
 * @returns 갱신된 고점
 */
export function updateHighPrice(orderId: string, currentPrice: number): number {
  const map = load();
  const prev = map[orderId] ?? 0;
  const newHigh = Math.max(prev, currentPrice);
  map[orderId] = newHigh;
  save(map);
  return newHigh;
}

/**
 * 여러 포지션의 고점을 일괄 갱신.
 *
 * @param prices  { orderId: currentPrice } 맵
 * @returns 갱신된 고점 맵
 */
export function updateHighPrices(prices: Record<string, number>): Record<string, number> {
  const map = load();
  for (const [orderId, currentPrice] of Object.entries(prices)) {
    const prev = map[orderId] ?? 0;
    map[orderId] = Math.max(prev, currentPrice);
  }
  save(map);
  return { ...map };
}

/**
 * 종목별 고점 조회 (checkPositionRisks용).
 * orderId별 고점을 market별 고점으로 변환합니다.
 *
 * @param positionMarketMap  { orderId: market } 맵
 * @returns { market: highPrice } 맵
 */
export function getHighPricesByMarket(
  positionMarketMap: Record<string, string>,
): Record<string, number> {
  const map = load();
  const result: Record<string, number> = {};

  for (const [orderId, market] of Object.entries(positionMarketMap)) {
    const high = map[orderId];
    if (high !== undefined) {
      result[market] = Math.max(result[market] ?? 0, high);
    }
  }

  return result;
}

/** 포지션 매도 시 고점 기록 삭제 */
export function removeHighPrice(orderId: string): void {
  const map = load();
  delete map[orderId];
  save(map);
}

/** 여러 포지션 고점 기록 일괄 삭제 */
export function removeHighPrices(orderIds: string[]): void {
  const map = load();
  for (const id of orderIds) {
    delete map[id];
  }
  save(map);
}

/** 전체 고점 기록 조회 */
export function getAllHighPrices(): HighPriceMap {
  return load();
}

/** 전체 고점 기록 초기화 */
export function clearHighPrices(): void {
  save({});
}
