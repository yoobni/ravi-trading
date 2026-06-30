/**
 * F6_v3 (CONFIRM) paper trading store.
 *
 * F6 계열과 동일한 신고가-돌파 신호에 "거짓돌파 확정" 필터를 추가하고 exit/사이징을 변경:
 *   - 신호: 7일 신고가 돌파(신고가봉) + 그 "다음 봉(확인봉)"이 종가>신고가봉 고가 & 양봉 → 진입
 *           (= 거짓돌파를 한 박자 걸러 진짜 돌파만 진입)
 *   - Exit: TP +10% / SL -3% / MAX 14d (84 4h bars)
 *   - 자본 10M, position 25% × max 4 concurrent
 *   - Fee 0.05% + slippage 0.05% = round-trip 0.1%
 *
 * 검증: R45a~R45h. 4년 OOS PF1.39~1.45, MDD 12~14%, 약세장(Y2) +5~23% 방어,
 *       Monte Carlo 양수 99%, lookahead 깨끗. (PAPER_F6_V3_DESIGN.md 참조, 변경 금지)
 *
 * 별도 state + 별도 tick. F6/F6_v2와 독립 운영.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const F6V3_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v3');
export const F6V3_STATE_FILE = path.join(F6V3_DIR, 'state.json');
export const F6V3_TRADES_FILE = path.join(F6V3_DIR, 'trades.jsonl');
export const F6V3_TICKS_FILE = path.join(F6V3_DIR, 'ticks.jsonl');

export const F6V3_INITIAL_CASH_KRW = 10_000_000;
export const F6V3_FEE = 0.0005;
export const F6V3_SLIPPAGE = 0.0005;
export const F6V3_TP_PCT = 10.0;      // ★ CONFIRM + 큰 TP
export const F6V3_SL_PCT = -3.0;      // ★
export const F6V3_MAX_BARS = 84;      // 14d
export const F6V3_POSITION_PCT = 0.25; // ★ 25%
export const F6V3_MAX_CONCURRENT = 4;  // ★ max 4
export const F6V3_VOL_Z_THRESHOLD = 0.5;
export const F6V3_LOOKBACK_BARS = 42; // 7일

export const F6V3_COINS = [
  'KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH',
  'KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO',
  'KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT',
];

export interface F6V3Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}

export interface F6V3ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: 'TP' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}

export interface F6V3State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F6V3Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6V3Dir() {
  if (!fs.existsSync(F6V3_DIR)) fs.mkdirSync(F6V3_DIR, { recursive: true });
}
export function readF6V3State(): F6V3State | null {
  if (!fs.existsSync(F6V3_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V3_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V3State(): F6V3State {
  return {
    startedAt: new Date().toISOString(),
    lastTickTs: null,
    lastTickAt: null,
    cash: F6V3_INITIAL_CASH_KRW,
    positions: [],
    totalTrades: 0,
    totalRealizedPnl: 0,
  };
}
export async function withF6V3State<T>(fn: (state: F6V3State) => Promise<T>): Promise<T> {
  ensureF6V3Dir();
  return withFileLock(F6V3_STATE_FILE, async () => {
    let st = readF6V3State();
    if (!st) { st = emptyF6V3State(); fs.writeFileSync(F6V3_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V3_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V3Trade(trade: F6V3ClosedTrade) {
  ensureF6V3Dir();
  fs.appendFileSync(F6V3_TRADES_FILE, JSON.stringify(trade) + '\n');
}
export function appendF6V3Tick(record: object) {
  ensureF6V3Dir();
  fs.appendFileSync(F6V3_TICKS_FILE, JSON.stringify(record) + '\n');
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
 * F6_v3 (CONFIRM) 신호 평가. bars의 마지막 인덱스 L = "확인봉".
 * lookahead-safe: bar L까지의 확정 정보만 사용.
 *
 *   i = L-1 (신고가봉) 에서 F6 조건:
 *     1. prevMax = max(high[i-42 .. i-2])
 *     2. bars[i-1].high > prevMax        ← 직전 bar 신고가
 *     3. bars[i].close > bars[i].open    ← 양봉
 *     4. bars[i].close > bars[i-1].high  ← follow-through
 *     5. vol z(i) ≥ 0.5
 *   확인봉 L:
 *     6. bars[L].close > bars[i].high    ← 신고가봉 고가 위에서 마감 (거짓돌파 아님 확정)
 *     7. bars[L].close > bars[L].open    ← 확인봉도 양봉
 *   → 모두 충족 시 hit (진입은 다음 bar = 현재 tick).
 */
export function evaluateF6v3(bars: BarLite[]): { hit: boolean; volZ: number | null } {
  const L = bars.length - 1;
  const i = L - 1;
  if (i < F6V3_LOOKBACK_BARS + 1) return { hit: false, volZ: null };
  let prevMax = -Infinity;
  for (let j = i - F6V3_LOOKBACK_BARS; j < i - 1; j++) {
    if (bars[j].high > prevMax) prevMax = bars[j].high;
  }
  if (!(bars[i-1].high > prevMax)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i].open)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i-1].high)) return { hit: false, volZ: null };
  const volumes = bars.map(b => b.volume);
  const z = calcVolZ(volumes, i, 30);
  if (z == null || z < F6V3_VOL_Z_THRESHOLD) return { hit: false, volZ: z };
  // 확인봉 조건
  if (!(bars[L].close > bars[i].high)) return { hit: false, volZ: z };
  if (!(bars[L].close > bars[L].open)) return { hit: false, volZ: z };
  return { hit: true, volZ: z };
}
