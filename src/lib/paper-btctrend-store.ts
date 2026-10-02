/**
 * BTC_TREND paper store — BTC 일봉 추세추종 (2026-10-02, docs/RESEARCH-LOG.md 축 E · scripts/_ext_btctrend.ts).
 *
 * 규칙: 매일 KST 09:00 일봉이 바뀐 직후, 직전 확정 일봉 종가가 50일 단순이평(그 봉 포함 50개) 위면 BTC 보유,
 *   아래면 현금. 상태가 바뀔 때만 KRW-BTC 시장가 매매(연 평균 약 17회). 자본 100% (동일위험 비교는 리포트에서).
 *
 * 근거: 2018~ 동일위험(MDD 17%) 209% vs 단순보유 39%, SMA 10~200일 8칸 전부 보유 우세(고원),
 *   워크포워드 OOS 49% vs 25%, 비용 ×4 에서도 159%, 플라시보(블록 셔플) 최대 168%.
 *   F7 과 일별 상관 0.35 — 알트 생존편향·지정가 체결 가정과 무관한 유일한 생존 전략.
 * 약점: 2022 −12%, 2025·26 우위 +3~5% 로 얇다. 판정 1일 지연 시 성과 반감 → 09:00 직후 실행이 중요.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const BT_DIR = path.resolve(process.cwd(), 'data', 'paper-btctrend');
export const BT_STATE_FILE = path.join(BT_DIR, 'state.json');
export const BT_TRADES_FILE = path.join(BT_DIR, 'trades.jsonl');
export const BT_TICKS_FILE = path.join(BT_DIR, 'ticks.jsonl');

export const BT_MARKET = 'KRW-BTC';
export const BT_INITIAL_CASH_KRW = 10_000_000;
export const BT_FEE = 0.0005;
export const BT_SLIPPAGE = 0.0005;
export const BT_SMA_DAYS = 50;
export const BT_POSITION_PCT = 1.0;
export const BT_TICK_MINUTE = 2;           // KST 09:02 — 일봉 경계(09:00) 직후
export const BT_MAX_BARS = 0;              // 시간청산 없음 (paper-asof 호환용)

export interface BtPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number }
export interface BtState { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; cash: number; positions: BtPosition[]; totalTrades: number; totalRealizedPnl: number }

export function readBtState(): BtState | null {
  if (!fs.existsSync(BT_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BT_STATE_FILE, 'utf-8')); } catch { return null; }
}
export async function withBtState<T>(fn: (s: BtState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(BT_DIR)) fs.mkdirSync(BT_DIR, { recursive: true });
  return withFileLock(BT_STATE_FILE, async () => {
    let st = readBtState();
    if (!st) {
      st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, cash: BT_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    }
    const r = await fn(st);
    fs.writeFileSync(BT_STATE_FILE, JSON.stringify(st, null, 2));
    return r;
  });
}

/** closes = 확정 일봉 종가(오래된→최근). 마지막 봉 기준 보유 여부. 데이터 부족이면 null. */
export function btWantLong(closes: number[]): { want: boolean; close: number; sma: number } | null {
  if (closes.length < BT_SMA_DAYS) return null;
  const w = closes.slice(-BT_SMA_DAYS);
  const sma = w.reduce((a, b) => a + b, 0) / BT_SMA_DAYS;
  const close = closes[closes.length - 1];
  return { want: close > sma, close, sma };
}
