/**
 * F6_v7 (봉마감 정렬) paper trading store.
 *
 * 신호·청산·사이징이 F6_v5와 **완전히 동일하다**. 다른 것은 하나뿐 —
 * 크론이 Upbit 4h 봉 마감(KST 01/05/09/13/17/21)에 정렬돼 있다.
 *
 * 기존 전략들은 KST 00/04/08/12/16/20 에 돌아서, 매 틱이 3시간 전에 마감된 봉으로
 * 판단하고 3시간 늦은 가격에 진입한다. `_bt_tickoffset.ts` 기준 그 지연 비용이
 * A2에서 PF 1.81→1.31, 총익 739%→285% (반기 4구간 × 3전략, 12/12 정렬 우위).
 * 즉 v7은 백테스트와 실행 시각이 일치하는 첫 전략이고, v5 대비 차이는 곧 지연 비용이다.
 *
 * ⚠ 원래 v7은 "집중 배분(50%×2) + 봉 정렬"을 같이 바꿨는데, 그러면 두 효과를 못 가른다.
 *   거래 0건 상태에서 정렬 하나만 남기도록 재정의했다(2026-08-24). 집중 배분 검증은
 *   `_bt_portfolio.ts`에 남아 있고, 필요하면 별도 전략으로 다시 붙인다.
 *
 * 대조군 구조 — 셋 다 신호·청산이 같고 변수 하나씩만 다르다:
 *   v5 = 기준선 (33%×3, 크론 미정렬)
 *   v7 = 봉 마감 정렬만 다름          ← 이 파일
 *   v8 = 같은 코인 재신호 시 증액만 다름
 */import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';
export { evaluateF6 as evaluateF6v5Signal, F6_COINS as F6V7_COINS, calcVolZ, type BarLite } from './paper-f6-store';

export const F6V7_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v7');
export const F6V7_STATE_FILE = path.join(F6V7_DIR, 'state.json');
export const F6V7_TRADES_FILE = path.join(F6V7_DIR, 'trades.jsonl');
export const F6V7_TICKS_FILE = path.join(F6V7_DIR, 'ticks.jsonl');

export const F6V7_INITIAL_CASH_KRW = 10_000_000;
export const F6V7_FEE = 0.0005;
export const F6V7_SLIPPAGE = 0.0005;
export const F6V7_SL_PCT = -2.0;         // 초기 스톱
export const F6V7_TRAIL_ACT = 2.0;       // A2(안정형): +2% 도달 시 트레일 개시
export const F6V7_TRAIL_GAP = 2.0;       // 고점 대비 2% 아래 트레일
export const F6V7_MAX_BARS = 84;         // 14d
export const F6V7_POSITION_PCT = 0.33;   // v5와 동일 — 변수는 크론 시각 하나뿐
export const F6V7_MAX_CONCURRENT = 3;    // v5와 동일
export const F6V7_VOL_Z_THRESHOLD = 0.5;
export const F6V7_LOOKBACK_BARS = 42;

export interface F6V7Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}
export interface F6V7ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  profitRate: number;
  profitKrw: number;
  /**
   * 크론이 청산을 인지한 그 시점의 시장가(슬리피지 반영). 정산에는 쓰지 않는다.
   * exitPrice 는 스톱/목표 '가격'이라 거래소에 스톱 주문이 걸려 있어야 달성 가능하고,
   * 주문 없이 크론이 보고 파는 실제 운영에서는 이 값에 가깝게 체결된다.
   * 둘의 차이가 곧 "감시 공백 비용"이다. 시세 조회 실패 시 null.
   */
  exitPriceMarket?: number | null;
  reason: 'TRAIL' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}
export interface F6V7State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F6V7Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function ensureF6V7Dir() { if (!fs.existsSync(F6V7_DIR)) fs.mkdirSync(F6V7_DIR, { recursive: true }); }
export function readF6V7State(): F6V7State | null {
  if (!fs.existsSync(F6V7_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V7_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V7State(): F6V7State {
  return { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null,
    cash: F6V7_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
}
export async function withF6V7State<T>(fn: (state: F6V7State) => Promise<T>): Promise<T> {
  ensureF6V7Dir();
  return withFileLock(F6V7_STATE_FILE, async () => {
    let st = readF6V7State();
    if (!st) { st = emptyF6V7State(); fs.writeFileSync(F6V7_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V7_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V7Trade(trade: F6V7ClosedTrade) { ensureF6V7Dir(); fs.appendFileSync(F6V7_TRADES_FILE, JSON.stringify(trade) + '\n'); }
export function appendF6V7Tick(record: object) { ensureF6V7Dir(); fs.appendFileSync(F6V7_TICKS_FILE, JSON.stringify(record) + '\n'); }

/**
 * 트레일링 스톱 청산 판정. 진입 이후 confirmed bars(시간순)를 스캔해 상태를 재구성(무상태·멱등).
 * @returns 청산 시 {reason, price, ts}, 아니면 null.
 */
export function evalTrailExit(
  bars: { ts:number; high:number; low:number; close:number }[],
  entryPrice: number,
): { reason: 'TRAIL' | 'SL' | 'TIME'; price: number; ts: number } | null {
  let peak = entryPrice;
  let sl = entryPrice * (1 + F6V7_SL_PCT / 100);
  let trailOn = false;
  for (const b of bars) {
    if (b.low <= sl) return { reason: trailOn ? 'TRAIL' : 'SL', price: sl, ts: b.ts };
    peak = Math.max(peak, b.high);
    if (!trailOn && peak >= entryPrice * (1 + F6V7_TRAIL_ACT / 100)) trailOn = true;
    if (trailOn) sl = Math.max(sl, peak * (1 - F6V7_TRAIL_GAP / 100));
  }
  if (bars.length >= F6V7_MAX_BARS) {
    const last = bars[F6V7_MAX_BARS - 1] || bars[bars.length - 1];
    return { reason: 'TIME', price: last.close, ts: last.ts };
  }
  return null;
}
