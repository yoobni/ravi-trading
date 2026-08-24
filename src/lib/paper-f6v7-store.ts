/**
 * F6_v7 (집중·봉정렬) paper trading store.
 *
 * 신호(7일 신고가 돌파)와 청산(트레일링 A2: 초기 SL −2%, +2% 도달 후 고점−2%)은
 * F6_v5와 완전히 동일하다. 두 가지만 다르다 —
 *
 *   ① 배분: 현금의 50%씩 최대 2종 (v5는 33%×3)
 *      근거: `_bt_portfolio.ts` / `_bt_sizing.ts` — 4년 총익 1,213% vs 563%,
 *      MDD 23.2% vs 17.0%, 수익/MDD 52.3 vs 33.2. 기간 5분할(2022H2·23·24·25·26)에서
 *      5/5 모두 집중 쪽이 우위. 신호가 많고 품질이 고른 데다 어차피 전부 암호화폐
 *      롱이라, 슬롯을 쪼개도 상관 리스크는 안 줄고 수익만 희석되기 때문.
 *
 *   ② 실행 시각: 크론이 Upbit 4h 봉 마감(KST 01/05/09/13/17/21)에 정렬된다.
 *      기존 전략들은 KST 00/04/08/… 에 돌아서 매 틱이 3시간 전에 마감된 봉으로
 *      판단하고 3시간 늦은 가격에 진입한다. `_bt_tickoffset.ts` 기준 그 지연 비용이
 *      A2에서 PF 1.81→1.31, 총익 739%→285% (반기 4구간×3전략 12/12 정렬 우위).
 *      즉 v7은 백테스트와 실행 시각이 일치하는 첫 전략이다.
 *
 * 탈락시킨 후보들(같은 하네스로 검증): 항복반등·추세눌림목 PF<1.1, 종목 선발 규칙
 * 9종 전부 현행 이하, 변동성 타겟 사이징 563%→348%, 절반 익절 563%→249%.
 *
 * ⚠ 백테스트 우위일 뿐 실거래 검증 아님. v5(33%×3·미정렬)와 병행해 라이브로 비교한다.
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
export const F6V7_POSITION_PCT = 0.50;   // ★ 집중: 현금의 50% (v5는 33%)
export const F6V7_MAX_CONCURRENT = 2;    // ★ 집중: 최대 2종 (v5는 3종)
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
