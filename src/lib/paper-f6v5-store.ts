/**
 * F6_v5 (TRAIL A2 / 안정형) paper trading store.
 *
 * F6와 동일한 신고가-돌파 신호·사이징을 쓰되, exit만 "트레일링 스톱"으로 교체:
 *   - 진입 후 초기 SL −2%.
 *   - 가격이 +2%(activation) 도달하면 트레일링 개시 → 고점 대비 2% 아래로 SL 상향.
 *   - 고정 TP 없음 (승자를 태운다). MAX 14d(84 4h bars) 시간청산.
 *
 * 근거: H4 가설 → 파라미터 스윕/walk-forward에서 act2/gap2 채택(안정형).
 *       4년: PF 1.51, 총익 +869%, MDD 84%, 승률 45%, 5년 전부 흑자.
 *       아웃샘플(2025~26) PF 1.47로 검증 통과. F6_v6은 act4/gap2(수익형) 자매전략.
 *       (scripts/_bt_a2a4.ts / _wf_g2.ts) ⚠ 실거래 검증은 페이퍼로 진행 중.
 *
 * 신호/사이징은 F6와 동일(evaluateF6 재사용, 33%×max3). 별도 state + 별도 tick.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';
export { evaluateF6 as evaluateF6v5Signal, F6_COINS as F6V5_COINS, calcVolZ, type BarLite } from './paper-f6-store';

export const F6V5_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v5');
export const F6V5_STATE_FILE = path.join(F6V5_DIR, 'state.json');
export const F6V5_TRADES_FILE = path.join(F6V5_DIR, 'trades.jsonl');
export const F6V5_TICKS_FILE = path.join(F6V5_DIR, 'ticks.jsonl');

export const F6V5_INITIAL_CASH_KRW = 10_000_000;
export const F6V5_FEE = 0.0005;
export const F6V5_SLIPPAGE = 0.0005;
export const F6V5_SL_PCT = -2.0;         // 초기 스톱
export const F6V5_TRAIL_ACT = 2.0;       // A2(안정형): +2% 도달 시 트레일 개시
export const F6V5_TRAIL_GAP = 2.0;       // 고점 대비 2% 아래 트레일
export const F6V5_MAX_BARS = 84;         // 14d
export const F6V5_POSITION_PCT = 0.33;   // F6와 동일
export const F6V5_MAX_CONCURRENT = 3;    // F6와 동일
export const F6V5_VOL_Z_THRESHOLD = 0.5;
export const F6V5_LOOKBACK_BARS = 42;

export interface F6V5Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}
export interface F6V5ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: 'TRAIL' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}
export interface F6V5State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F6V5Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6V5Dir() { if (!fs.existsSync(F6V5_DIR)) fs.mkdirSync(F6V5_DIR, { recursive: true }); }
export function readF6V5State(): F6V5State | null {
  if (!fs.existsSync(F6V5_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V5_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V5State(): F6V5State {
  return { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null,
    cash: F6V5_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
}
export async function withF6V5State<T>(fn: (state: F6V5State) => Promise<T>): Promise<T> {
  ensureF6V5Dir();
  return withFileLock(F6V5_STATE_FILE, async () => {
    let st = readF6V5State();
    if (!st) { st = emptyF6V5State(); fs.writeFileSync(F6V5_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V5_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V5Trade(trade: F6V5ClosedTrade) { ensureF6V5Dir(); fs.appendFileSync(F6V5_TRADES_FILE, JSON.stringify(trade) + '\n'); }
export function appendF6V5Tick(record: object) { ensureF6V5Dir(); fs.appendFileSync(F6V5_TICKS_FILE, JSON.stringify(record) + '\n'); }

/**
 * 트레일링 스톱 청산 판정. 진입 이후 confirmed bars(시간순)를 스캔해 상태를 재구성(무상태·멱등).
 * @returns 청산 시 {reason, price, ts}, 아니면 null.
 */
export function evalTrailExit(
  bars: { ts:number; high:number; low:number; close:number }[],
  entryPrice: number,
): { reason: 'TRAIL' | 'SL' | 'TIME'; price: number; ts: number } | null {
  let peak = entryPrice;
  let sl = entryPrice * (1 + F6V5_SL_PCT / 100);
  let trailOn = false;
  for (const b of bars) {
    if (b.low <= sl) return { reason: trailOn ? 'TRAIL' : 'SL', price: sl, ts: b.ts };
    peak = Math.max(peak, b.high);
    if (!trailOn && peak >= entryPrice * (1 + F6V5_TRAIL_ACT / 100)) trailOn = true;
    if (trailOn) sl = Math.max(sl, peak * (1 - F6V5_TRAIL_GAP / 100));
  }
  if (bars.length >= F6V5_MAX_BARS) {
    const last = bars[F6V5_MAX_BARS - 1] || bars[bars.length - 1];
    return { reason: 'TIME', price: last.close, ts: last.ts };
  }
  return null;
}
