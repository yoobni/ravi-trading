/**
 * F6_v8 (TRAIL A2 + 증액) paper trading store.
 *
 * F6_v5 와 신호·청산·사이징이 전부 동일하다. 단 하나만 다르다:
 *   이미 보유 중인 코인에 F6 신호가 다시 뜨면 **한 번 더 진입한다**(코인당 최대 2트란치).
 *   v5 는 `positions.some(p => p.market === m)` 로 이를 막고 신규 코인만 받는다.
 *
 * 근거(`scripts/_bt_pyramid.ts`, 28코인 4h 4년): 드롭인 563%→775%(MDD 17.0→18.0%),
 *   기간 4분할 4/4 우세. MDD 를 이분탐색으로 17.0% 에 고정해도 698%→853%(+22%).
 *   반증 5종 통과 — 플라시보(신호 없이 3봉 뒤 증액) 509% 대비 +68%, 마찰 ×3 에서도 +49%,
 *   추가되는 2번 트란치 자체 PF 2.22(1번 트란치 1.65), 코인 배열 순서 5종 전부 양수,
 *   워크포워드 OOS 452%→527%. 트란치 상한은 2 가 최적(3·4 는 후퇴).
 *
 * 해석: 보유 중인 코인이 신고가를 다시 찍는 것은 추세 확증이라, 무작위 신규 코인의
 *   첫 돌파보다 나은 진입이다. v5 규칙은 그걸 막고 신규 분산을 강제하고 있었다.
 *
 * ⚠ v5 가 대조군이다. 증액 효과만 분리해서 보려면 v8 의 다른 파라미터는 건드리지 말 것.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';
export { evaluateF6 as evaluateF6v8Signal, F6_COINS as F6V8_COINS, calcVolZ, type BarLite } from './paper-f6-store';

export const F6V8_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v8');
export const F6V8_STATE_FILE = path.join(F6V8_DIR, 'state.json');
export const F6V8_TRADES_FILE = path.join(F6V8_DIR, 'trades.jsonl');
export const F6V8_TICKS_FILE = path.join(F6V8_DIR, 'ticks.jsonl');

export const F6V8_INITIAL_CASH_KRW = 10_000_000;
export const F6V8_FEE = 0.0005;
export const F6V8_SLIPPAGE = 0.0005;
export const F6V8_SL_PCT = -2.0;         // 초기 스톱
export const F6V8_TRAIL_ACT = 2.0;       // A2(안정형): +2% 도달 시 트레일 개시
export const F6V8_TRAIL_GAP = 2.0;       // 고점 대비 2% 아래 트레일
export const F6V8_MAX_BARS = 84;         // 14d
export const F6V8_POSITION_PCT = 0.33;   // F6와 동일
export const F6V8_MAX_CONCURRENT = 3;    // F6와 동일
export const F6V8_MAX_PER_COIN = 2;      // ★ v5와의 유일한 차이 — 같은 코인 재신호 시 증액 허용
export const F6V8_VOL_Z_THRESHOLD = 0.5;
export const F6V8_LOOKBACK_BARS = 42;

export interface F6V8Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}
export interface F6V8ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: 'TRAIL' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}
export interface F6V8State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F6V8Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6V8Dir() { if (!fs.existsSync(F6V8_DIR)) fs.mkdirSync(F6V8_DIR, { recursive: true }); }
export function readF6V8State(): F6V8State | null {
  if (!fs.existsSync(F6V8_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V8_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V8State(): F6V8State {
  return { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null,
    cash: F6V8_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
}
export async function withF6V8State<T>(fn: (state: F6V8State) => Promise<T>): Promise<T> {
  ensureF6V8Dir();
  return withFileLock(F6V8_STATE_FILE, async () => {
    let st = readF6V8State();
    if (!st) { st = emptyF6V8State(); fs.writeFileSync(F6V8_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V8_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V8Trade(trade: F6V8ClosedTrade) { ensureF6V8Dir(); fs.appendFileSync(F6V8_TRADES_FILE, JSON.stringify(trade) + '\n'); }
export function appendF6V8Tick(record: object) { ensureF6V8Dir(); fs.appendFileSync(F6V8_TICKS_FILE, JSON.stringify(record) + '\n'); }

/**
 * 트레일링 스톱 청산 판정. 진입 이후 confirmed bars(시간순)를 스캔해 상태를 재구성(무상태·멱등).
 * @returns 청산 시 {reason, price, ts}, 아니면 null.
 */
export function evalTrailExit(
  bars: { ts:number; high:number; low:number; close:number }[],
  entryPrice: number,
): { reason: 'TRAIL' | 'SL' | 'TIME'; price: number; ts: number } | null {
  let peak = entryPrice;
  let sl = entryPrice * (1 + F6V8_SL_PCT / 100);
  let trailOn = false;
  for (const b of bars) {
    if (b.low <= sl) return { reason: trailOn ? 'TRAIL' : 'SL', price: sl, ts: b.ts };
    peak = Math.max(peak, b.high);
    if (!trailOn && peak >= entryPrice * (1 + F6V8_TRAIL_ACT / 100)) trailOn = true;
    if (trailOn) sl = Math.max(sl, peak * (1 - F6V8_TRAIL_GAP / 100));
  }
  if (bars.length >= F6V8_MAX_BARS) {
    const last = bars[F6V8_MAX_BARS - 1] || bars[bars.length - 1];
    return { reason: 'TIME', price: last.close, ts: last.ts };
  }
  return null;
}
