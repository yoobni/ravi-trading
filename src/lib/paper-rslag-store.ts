/**
 * RS_LAG paper store — BTC 급락 주간에 BTC 보다 크게 뒤처진 대형 알트를 산다 (2026-10-13, 저점매수 리서치 축 ALT,
 * scripts/_bt_dip_alt_rs*.ts · data/research-ext/dip-2026-10/alt/ — lag · dn7 · L14 · thr 0.15 · N20 · TP10 · H7 · K3 를 옮긴 것).
 *
 * 매일 KST 09:00 일봉 확정 직후 (어제 = 판정일 D):
 *   1. 국면: BTC 7일 수익(D 종가 / D−7 종가 − 1) ≤ −5% 일 때만 신규 진입
 *   2. 유니버스 = 직전 30일(D 포함) 업비트 거래대금 합 상위 20 알트, 스테이블·BTC 제외, 이력 30일 이상 — ALT_SWING 과 같은 규칙
 *   3. 점수 = 알트 14일 수익 − BTC 14일 수익 ≤ −15% 인 코인, 가장 많이 뒤처진 순
 *   4. 시장가 매수(평가액 × 10% × 최대 3종목), +10% 지정가 매도. 체결 판정은 일봉 고가 ≥ 목표 × (1+0.2%)
 *   5. 진입일 포함 확정 일봉 7개째 종가에서 안 팔렸으면 시장가 정리. 손절 없음.
 * 사이즈 10% 는 MDD 17% 동일위험 사이즈다. **백테스트는 상폐 코인이 빠져 있어 과대평가** — 2022-05 LUNA 를 1순위로
 * 샀을 것(−99%)이 확인됐다. 그래서 슬롯을 작게 둔다. 유의종목 공지 코인은 진입 차단(paper-warning).
 * 1일 지연에도 엣지가 상당 부분 남아서(+277% → +172%) 늦은 tick 도 12시간까지는 진입한다.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';
import { asSlip, type DayBar } from './paper-altswing-store';

export const RL_DIR = path.resolve(process.cwd(), 'data', 'paper-rslag');
export const RL_STATE_FILE = path.join(RL_DIR, 'state.json');
export const RL_TRADES_FILE = path.join(RL_DIR, 'trades.jsonl');
export const RL_TICKS_FILE = path.join(RL_DIR, 'ticks.jsonl');

export const RL_INITIAL_CASH_KRW = 10_000_000;
export const RL_FEE = 0.0005;
export const RL_TOP_N = 20;
export const RL_SLOTS = 3;
export const RL_POSITION_PCT = 0.10;     // 평가액 대비
export const RL_BTC7_MAX = -0.05;
export const RL_LOOKBACK = 14;
export const RL_LAG_THR = 0.15;
export const RL_TP_PCT = 10;
export const RL_TP_PEN = 0.002;
export const RL_HOLD_BARS = 7;           // 진입일 포함 확정 일봉 수
export const RL_MAX_LATE_MS = 12 * 3600_000;

export interface RlPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number; entryDayTs: number; score: number }
export interface RlState { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; lastDayTs: number | null; cash: number; positions: RlPosition[]; totalTrades: number; totalRealizedPnl: number }

export function readRlState(): RlState | null {
  if (!fs.existsSync(RL_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(RL_STATE_FILE, 'utf-8')); } catch { return null; }
}
export async function withRlState<T>(fn: (s: RlState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(RL_DIR)) fs.mkdirSync(RL_DIR, { recursive: true });
  return withFileLock(RL_STATE_FILE, async () => {
    let st = readRlState();
    if (!st) st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, lastDayTs: null, cash: RL_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    const r = await fn(st);
    fs.writeFileSync(RL_STATE_FILE, JSON.stringify(st, null, 2));
    return r;
  });
}

/** 시장가 슬리피지 — ALT_SWING 가정에 백테스트의 최소 스프레드 15bp(½ = 0.075%)를 바닥으로 */
export const rlSlip = (m: string) => Math.max(asSlip(m), 0.00075);

/** 판정일 인덱스 i 기준 k일 수익 (연속 일봉 가정 — 캐시는 일봉 연속) */
export function retK(b: DayBar[], i: number, k: number): number | null {
  return i - k >= 0 && b[i] && b[i - k] ? b[i].close / b[i - k].close - 1 : null;
}
