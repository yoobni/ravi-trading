/**
 * BTC_DIP paper store — BTC 4h 급락 흡수 (2026-10-02, docs/RESEARCH-LOG.md 3라운드 축 K · scripts/_btc_k.ts gridTrades 기준값).
 *
 * 4h 경계(KST 01/05/09/13/17/21)마다 직전 15분봉 종가 × 0.97 에 매수 지정가를 다음 경계까지 걸어둔다.
 * 15분봉 저가가 지정가 × (1−0.05%) 이하면 지정가 체결(관통 요구 — BTC 는 호가가 두꺼워 0.05% 가 근거 있는 기준).
 * 체결되면 +3% 매도 지정가(다음 15분봉부터 유효), 72시간 지나면 시장가 정리. 손절 없음. 한 번에 한 포지션, 자본 100%.
 * 근거: 2021-04~ 동일위험 155%(관통 0.2% 92%), 플라시보 0/20, 비용 ×4 88%. 이웃칸 기대 ~50%, 우위는 2024~ 집중, 최악 −20.5%.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const BD_DIR = path.resolve(process.cwd(), 'data', 'paper-btcdip');
export const BD_STATE_FILE = path.join(BD_DIR, 'state.json');
export const BD_TRADES_FILE = path.join(BD_DIR, 'trades.jsonl');
export const BD_TICKS_FILE = path.join(BD_DIR, 'ticks.jsonl');
export const BD_MARKET = 'KRW-BTC';
export const BD_INITIAL_CASH_KRW = 10_000_000;
export const BD_FEE = 0.0005;
export const BD_SLIP = 0.0002;
export const BD_DIP_PCT = 3;
export const BD_TP_PCT = 3;
export const BD_PEN = 0.0005;
export const BD_HOLD_MS = 72 * 3600_000;
export const BD_MAX_BARS = 0;

export interface BdPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number }
export interface BdState {
  startedAt: string; lastTickTs: number | null; lastTickAt: string | null;
  lastBarTs: number | null; lastClose: number | null; order: { lim: number; until: number } | null;
  cash: number; positions: BdPosition[]; totalTrades: number; totalRealizedPnl: number;
}
export function readBdState(): BdState | null {
  if (!fs.existsSync(BD_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BD_STATE_FILE, 'utf-8')); } catch { return null; }
}
export async function withBdState<T>(fn: (s: BdState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(BD_DIR)) fs.mkdirSync(BD_DIR, { recursive: true });
  return withFileLock(BD_STATE_FILE, async () => {
    let st = readBdState();
    if (!st) st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, lastBarTs: null, lastClose: null, order: null, cash: BD_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    const r = await fn(st);
    fs.writeFileSync(BD_STATE_FILE, JSON.stringify(st, null, 2));
    return r;
  });
}
