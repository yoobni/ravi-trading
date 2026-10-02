/**
 * USDT_Z paper store — 업비트 테더 프리미엄 평균회귀 (2026-10-02, docs/RESEARCH-LOG.md 4라운드 축 O · scripts/_usdt2.ts 'rob h 30 2 0').
 *
 * 프리미엄 = 업비트 KRW-USDT 15분봉 종가 ÷ 장중 원/달러(Yahoo KRW=X 1h, 그 봉이 끝난 값만) − 1.
 * 30일(2,880개 15분 표본) 롤링 z 가 −2 이하면 원화 전액으로 USDT 시장가 매수, 0 이상이면 전량 매도.
 * 체결 = 판단 다음 15분봉 시가 ± 반틱(0.5원). 디페그 가드: 바이낸스 USDCUSDT > 1.005(USDT 글로벌 약세)면 신규 매수 금지.
 * 근거: 2.26년 +48.6%, MDD 3.2%, 28건 승률 89%, 플라시보 0/300, WF OOS +14.2%. 기대 연 8~13%.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const UZ_DIR = path.resolve(process.cwd(), 'data', 'paper-usdtz');
export const UZ_STATE_FILE = path.join(UZ_DIR, 'state.json');
export const UZ_TRADES_FILE = path.join(UZ_DIR, 'trades.jsonl');
export const UZ_TICKS_FILE = path.join(UZ_DIR, 'ticks.jsonl');
export const UZ_PREM_FILE = path.join(UZ_DIR, 'premium.json');     // [{ts, close, fx, prem}] 15분봉 단위, 최근 35일

export const UZ_MARKET = 'KRW-USDT';
export const UZ_INITIAL_CASH_KRW = 10_000_000;
export const UZ_FEE = 0.0005;
export const UZ_HALF_TICK = 0.5;
export const UZ_WINDOW = 30 * 96;
export const UZ_ENTRY_Z = -2;
export const UZ_EXIT_Z = 0;
export const UZ_DEPEG_LIMIT = 1.005;
export const UZ_MAX_BARS = 0;

export interface PremRow { ts: number; close: number; fx: number; prem: number }
export interface UzPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number }
export interface UzState { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; lastBarTs: number | null; cash: number; positions: UzPosition[]; totalTrades: number; totalRealizedPnl: number }

export function readUzState(): UzState | null {
  if (!fs.existsSync(UZ_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(UZ_STATE_FILE, 'utf-8')); } catch { return null; }
}
export async function withUzState<T>(fn: (s: UzState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(UZ_DIR)) fs.mkdirSync(UZ_DIR, { recursive: true });
  return withFileLock(UZ_STATE_FILE, async () => {
    let st = readUzState();
    if (!st) st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, lastBarTs: null, cash: UZ_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    const r = await fn(st);
    fs.writeFileSync(UZ_STATE_FILE, JSON.stringify(st, null, 2));
    return r;
  });
}
/** rows 의 마지막 원소 기준 z (창이 다 안 차면 null) */
export function premZ(rows: PremRow[]): number | null {
  if (rows.length < UZ_WINDOW) return null;
  const w = rows.slice(-UZ_WINDOW);
  const mu = w.reduce((a, r) => a + r.prem, 0) / w.length;
  const sd = Math.sqrt(Math.max(w.reduce((a, r) => a + (r.prem - mu) ** 2, 0) / w.length, 1e-10));
  return (w[w.length - 1].prem - mu) / sd;
}
