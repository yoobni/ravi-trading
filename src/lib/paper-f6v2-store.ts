/**
 * F6_v2 (TP_OPT) paper trading store.
 *
 * F6_v1과 동일한 signal (7일 신고가 + 양봉 + vol z 0.5), exit만 다름:
 *   TP +7%  (F6은 +5%)
 *   SL -2.5% (F6은 -2%)
 *   MAX 14d (동일)
 *
 * 별도 state + 별도 tick. F6_v1과 독립 운영.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const F6V2_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v2');
export const F6V2_STATE_FILE = path.join(F6V2_DIR, 'state.json');
export const F6V2_TRADES_FILE = path.join(F6V2_DIR, 'trades.jsonl');
export const F6V2_TICKS_FILE = path.join(F6V2_DIR, 'ticks.jsonl');

export const F6V2_INITIAL_CASH_KRW = 10_000_000;
export const F6V2_FEE = 0.0005;
export const F6V2_SLIPPAGE = 0.0005;
export const F6V2_TP_PCT = 7.0;       // ★ F6_v1 5%에서 7%로
export const F6V2_SL_PCT = -2.5;      // ★ F6_v1 -2%에서 -2.5%로
export const F6V2_MAX_BARS = 84;
export const F6V2_POSITION_PCT = 0.33;
export const F6V2_MAX_CONCURRENT = 3;
export const F6V2_VOL_Z_THRESHOLD = 0.5;
export const F6V2_LOOKBACK_BARS = 42;

export const F6V2_COINS = [
  'KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH',
  'KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO',
  'KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT',
];

export interface F6V2Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}

export interface F6V2ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: 'TP' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}

export interface F6V2State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F6V2Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6V2Dir() {
  if (!fs.existsSync(F6V2_DIR)) fs.mkdirSync(F6V2_DIR, { recursive: true });
}
export function readF6V2State(): F6V2State | null {
  if (!fs.existsSync(F6V2_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V2_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V2State(): F6V2State {
  return {
    startedAt: new Date().toISOString(),
    lastTickTs: null,
    lastTickAt: null,
    cash: F6V2_INITIAL_CASH_KRW,
    positions: [],
    totalTrades: 0,
    totalRealizedPnl: 0,
  };
}
export async function withF6V2State<T>(fn: (state: F6V2State) => Promise<T>): Promise<T> {
  ensureF6V2Dir();
  return withFileLock(F6V2_STATE_FILE, async () => {
    let st = readF6V2State();
    if (!st) { st = emptyF6V2State(); fs.writeFileSync(F6V2_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V2_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V2Trade(trade: F6V2ClosedTrade) {
  ensureF6V2Dir();
  fs.appendFileSync(F6V2_TRADES_FILE, JSON.stringify(trade) + '\n');
}
export function appendF6V2Tick(record: object) {
  ensureF6V2Dir();
  fs.appendFileSync(F6V2_TICKS_FILE, JSON.stringify(record) + '\n');
}
