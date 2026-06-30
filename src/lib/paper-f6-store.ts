/**
 * F6 NEW_HIGH 42 paper trading store.
 *
 * 룰 (PAPER_F6_DESIGN.md 참조, 변경 금지):
 *   - 4h TF, 28 coin pool
 *   - 신호: 7일 신고가 + 양봉 follow-through + vol z ≥ 0.5
 *   - TP+5% / SL-2% / MAX 14d (84 4h bars)
 *   - 자본 10M, position 33% × max 3 concurrent
 *   - Fee 0.05% + slippage 0.05% = round-trip 0.1%
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const F6_DIR = path.resolve(process.cwd(), 'data', 'paper-f6');
export const F6_STATE_FILE = path.join(F6_DIR, 'state.json');
export const F6_TRADES_FILE = path.join(F6_DIR, 'trades.jsonl');
export const F6_TICKS_FILE = path.join(F6_DIR, 'ticks.jsonl');

export const F6_INITIAL_CASH_KRW = 10_000_000;
export const F6_FEE = 0.0005;
export const F6_SLIPPAGE = 0.0005;
export const F6_TP_PCT = 5.0;
export const F6_SL_PCT = -2.0;
export const F6_MAX_BARS = 84; // 14d × 6 bars/day
export const F6_POSITION_PCT = 0.33;
export const F6_MAX_CONCURRENT = 3;
export const F6_VOL_Z_THRESHOLD = 0.5;
export const F6_LOOKBACK_BARS = 42; // 7일

export const F6_COINS = [
  'KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH',
  'KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO',
  'KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT',
];

export interface F6Position {
  market: string;
  entryTs: number;      // ms
  entryDate: string;    // KST ISO
  entryPrice: number;   // slippage 반영
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number; // 진입 시점부터 카운트 (4h bar 단위, 0부터 시작 → MAX 84)
}

export interface F6ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;   // %
  profitKrw: number;
  reason: 'TP' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}

export interface F6State {
  startedAt: string;
  lastTickTs: number | null;     // ms (직전 tick의 KST 시간)
  lastTickAt: string | null;     // ISO
  cash: number;
  positions: F6Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6Dir() {
  if (!fs.existsSync(F6_DIR)) fs.mkdirSync(F6_DIR, { recursive: true });
}

export function readF6State(): F6State | null {
  if (!fs.existsSync(F6_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(F6_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function emptyF6State(): F6State {
  return {
    startedAt: new Date().toISOString(),
    lastTickTs: null,
    lastTickAt: null,
    cash: F6_INITIAL_CASH_KRW,
    positions: [],
    totalTrades: 0,
    totalRealizedPnl: 0,
  };
}

export async function withF6State<T>(fn: (state: F6State) => Promise<T>): Promise<T> {
  ensureF6Dir();
  return withFileLock(F6_STATE_FILE, async () => {
    let st = readF6State();
    if (!st) { st = emptyF6State(); fs.writeFileSync(F6_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}

export function appendF6Trade(trade: F6ClosedTrade) {
  ensureF6Dir();
  fs.appendFileSync(F6_TRADES_FILE, JSON.stringify(trade) + '\n');
}

export function appendF6Tick(record: object) {
  ensureF6Dir();
  fs.appendFileSync(F6_TICKS_FILE, JSON.stringify(record) + '\n');
}

export function listF6Trades(): F6ClosedTrade[] {
  if (!fs.existsSync(F6_TRADES_FILE)) return [];
  const lines = fs.readFileSync(F6_TRADES_FILE, 'utf-8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

// ─── Signal 평가 helper ───

export interface BarLite { ts: number; open: number; high: number; low: number; close: number; volume: number; }

export function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

/**
 * F6 신호 평가: bars 배열의 마지막 인덱스 i에서 신호 발생 여부 판정.
 * lookahead-safe: bar i까지의 정보만 사용.
 *
 * 조건:
 *   1. prevMax = max(high[i-42 .. i-2])  ← bar i-1 직전까지의 7일 신고가 baseline
 *   2. bars[i-1].high > prevMax           ← 직전 bar에서 신고가 발생
 *   3. bars[i].close > bars[i].open      ← 양봉
 *   4. bars[i].close > bars[i-1].high     ← follow-through (신고가 갱신)
 *   5. vol z ≥ 0.5
 */
export function evaluateF6(bars: BarLite[]): { hit: boolean; volZ: number | null } {
  const i = bars.length - 1;
  if (i < F6_LOOKBACK_BARS + 1) return { hit: false, volZ: null };
  let prevMax = -Infinity;
  for (let j = i - F6_LOOKBACK_BARS; j < i - 1; j++) {
    if (bars[j].high > prevMax) prevMax = bars[j].high;
  }
  if (!(bars[i-1].high > prevMax)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i].open)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i-1].high)) return { hit: false, volZ: null };
  const volumes = bars.map(b => b.volume);
  const z = calcVolZ(volumes, i, 30);
  if (z == null || z < F6_VOL_Z_THRESHOLD) return { hit: false, volZ: z };
  return { hit: true, volZ: z };
}
