/**
 * ALT_SWING paper store — 알트 일봉 2~3일 스윙, 생존편향 차단 버전 (2026-10-02, docs/RESEARCH-LOG.md 4라운드 축 N,
 * scripts/_swing_daily.ts 의 breakout7 · N20 · BTC 필터 · TP6 · H3 · 무스톱 · K3 를 그대로 옮긴 것).
 *
 * 매일 KST 09:00 일봉 확정 직후:
 *   1. 유니버스 = 직전 30일(어제 포함) 업비트 거래대금 합 상위 20, 스테이블·BTC 제외, 이력 30일 이상 — 매일 재구성
 *   2. BTC 어제 종가 > 직전 50일 평균 일 때만 진입
 *   3. 신호 = 어제 양봉 · 종가 > 직전 7일 고가 · 거래대금 z(직전 30일) ≥ 0.5 — z 큰 순
 *   4. 시장가 매수(현금 33% × 최대 3종목), +6% 지정가 매도. 체결 판정은 일봉 고가 ≥ 목표 × (1+0.2%) (관통 요구)
 *   5. 진입일 포함 확정 일봉 4개(진입일 + 3일)가 지나도 안 팔리면 시장가 정리. 손절 없음(손절을 넣으면 백테스트가 붕괴).
 * 진입 지연에 민감 — 09:00 에서 1시간 넘게 늦은 tick 은 신규 진입을 건너뛴다(청산은 처리).
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const AS_DIR = path.resolve(process.cwd(), 'data', 'paper-altswing');
export const AS_STATE_FILE = path.join(AS_DIR, 'state.json');
export const AS_TRADES_FILE = path.join(AS_DIR, 'trades.jsonl');
export const AS_TICKS_FILE = path.join(AS_DIR, 'ticks.jsonl');
export const AS_CACHE_DIR = path.join(AS_DIR, 'daily-cache');

export const AS_INITIAL_CASH_KRW = 10_000_000;
export const AS_FEE = 0.0005;
export const AS_TOP_N = 20;
export const AS_SLOTS = 3;
export const AS_POSITION_PCT = 0.33;
export const AS_TP_PCT = 6;
export const AS_TP_PEN = 0.002;
export const AS_HOLD_DAYS = 3;           // 진입일 이후 3일 → 진입일 포함 4개 확정봉
export const AS_MAX_LATE_MS = 3600_000;  // 09:00 대비 1시간 넘게 늦으면 신규 진입 skip
export const AS_TICK_MINUTE = 3;         // KST 09:03
export const AS_MAX_BARS = 0;
export const AS_STABLE = new Set(['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'TUSD', 'PYUSD', 'FDUSD', 'USDE', 'RLUSD', 'EURC', 'USD0']);

export interface DayBar { ts: number; open: number; high: number; low: number; close: number; value: number }
export interface AsPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number; entryDayTs: number }
export interface AsState { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; lastDayTs: number | null; cash: number; positions: AsPosition[]; totalTrades: number; totalRealizedPnl: number }

export function readAsState(): AsState | null {
  if (!fs.existsSync(AS_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AS_STATE_FILE, 'utf-8')); } catch { return null; }
}
export async function withAsState<T>(fn: (s: AsState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(AS_DIR)) fs.mkdirSync(AS_DIR, { recursive: true });
  return withFileLock(AS_STATE_FILE, async () => {
    let st = readAsState();
    if (!st) st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, lastDayTs: null, cash: AS_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    const r = await fn(st);
    fs.writeFileSync(AS_STATE_FILE, JSON.stringify(st, null, 2));
    return r;
  });
}

const slipCache: Record<string, number> | null = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data', 'research-spread-p50.json'), 'utf8')); } catch { return null; }
})();
/** 시장가 슬리피지 = 스프레드 p50 절반(최소 0.05%), 모르는 코인 0.3% — 백테스트와 같은 가정 */
export const asSlip = (m: string) => (slipCache?.[m] != null ? Math.max(0.0005, slipCache[m] / 2 / 1e4) : 0.003);

/** i = 판정일(확정봉) 인덱스. 백테스트 valZ 와 동일: 직전 30일(결측 제외, 20개 이상) 대비 그날 거래대금 z */
export function valZ(b: DayBar[], i: number, w = 30): number | null {
  let s = 0, s2 = 0, n = 0;
  for (let j = Math.max(0, i - w); j < i; j++) { s += b[j].value; s2 += b[j].value ** 2; n++; }
  if (n < 20) return null;
  const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-9));
  return (b[i].value - mu) / sd;
}
/** breakout7: 양봉 · 종가 > 직전 7일 고가 · z ≥ 0.5 → z, 아니면 null. b 는 판정일까지(포함) 연속 일봉 */
export function breakout7(b: DayBar[], i: number): number | null {
  const x = b[i]; if (!x || i < 7 || x.close <= x.open) return null;
  let hi = -Infinity; for (let j = i - 7; j < i; j++) hi = Math.max(hi, b[j].high);
  const z = valZ(b, i);
  return x.close > hi && z != null && z >= 0.5 ? z : null;
}
