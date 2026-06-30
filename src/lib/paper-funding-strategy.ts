/**
 * Paper trading 신호 평가 — F1F2 (D7-C3) + V8 (E2-V8).
 *
 * 룰 출처:
 *   FUNDING_F1F2_MAIN  ← scripts/v2-phase-d7-combined-final.ts (C3_F1F2)
 *   FUNDING_V8_OBSERVE ← scripts/v2-phase-e2-funding-variants.ts (V8_1D_3D_BOTH)
 *
 * 룰 변경 금지.
 */
import axios from 'axios';
import type { SignalLabel, TrainThresholds } from './paper-trading-store';

export interface FundingFetchPoint {
  ts: number;
  date: string; // KST YYYY-MM-DD
  rate: number;
}

/**
 * Binance 최근 펀딩 fetch (8h마다, limit 30개 = 약 10일).
 * paper-trading-tick에서 매일 호출. 최근 4일(D, D-1, D-2, D-3)만 있으면 충분.
 */
export async function fetchRecentFunding(limit = 30): Promise<FundingFetchPoint[]> {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${limit}`;
  const { data } = await axios.get<Array<{ fundingTime: number; fundingRate: string }>>(url);
  return data.map((d) => ({
    ts: d.fundingTime,
    date: new Date(d.fundingTime + 9 * 3600 * 1000).toISOString().slice(0, 10),
    rate: parseFloat(d.fundingRate) * 100, // %
  }));
}

/**
 * 일자별 합산 (KST 기준 3건 합).
 * 마지막 일자는 8h × 3건 모두 close 되어야 confirmed.
 */
export function aggregateDaily(points: FundingFetchPoint[]): Map<string, { sum: number; count: number; lastTs: number }> {
  const m = new Map<string, { sum: number; count: number; lastTs: number }>();
  for (const p of points) {
    const cur = m.get(p.date);
    if (cur) {
      cur.sum += p.rate;
      cur.count += 1;
      cur.lastTs = Math.max(cur.lastTs, p.ts);
    } else {
      m.set(p.date, { sum: p.rate, count: 1, lastTs: p.ts });
    }
  }
  return m;
}

export interface SignalEvalContext {
  /** 신호 평가 기준일 (KST YYYY-MM-DD). 보통 D-1 (어제). 이 날의 daily sum이 confirmed 되어 있어야 한다. */
  evalDate: string;
  dailyMap: Map<string, { sum: number; count: number; lastTs: number }>;
  thresholds: TrainThresholds;
}

export interface StrategySignal {
  label: SignalLabel | null;
  /** evalDate 의 daily funding sum (confirmed) */
  dailyFunding: number;
  /** evalDate 기준 3일 누적 (D-2 + D-1 + D) */
  cum3Funding: number;
  notes: string[];
}

function get3dCum(
  dailyMap: SignalEvalContext['dailyMap'],
  evalDate: string,
): { cum3: number; missing: string[] } {
  const d = new Date(evalDate + 'T00:00:00Z');
  const dates: string[] = [];
  for (let i = 2; i >= 0; i--) {
    const dd = new Date(d.getTime() - i * 86400_000);
    dates.push(dd.toISOString().slice(0, 10));
  }
  let sum = 0;
  const missing: string[] = [];
  for (const date of dates) {
    const v = dailyMap.get(date);
    if (!v) {
      missing.push(date);
      continue;
    }
    sum += v.sum;
  }
  return { cum3: sum, missing };
}

/**
 * FUNDING_F1F2_MAIN — daily funding sum이 train P10/P90 극단인지.
 */
export function evalF1F2(ctx: SignalEvalContext): StrategySignal {
  const today = ctx.dailyMap.get(ctx.evalDate);
  const notes: string[] = [];
  if (!today) {
    notes.push(`evalDate ${ctx.evalDate} funding missing`);
    return { label: null, dailyFunding: NaN, cum3Funding: NaN, notes };
  }
  const cum3 = get3dCum(ctx.dailyMap, ctx.evalDate);
  const r = today.sum;
  let label: SignalLabel | null = null;
  if (r >= ctx.thresholds.p90_1d) label = 'F1';
  else if (r <= ctx.thresholds.p10_1d) label = 'F2';
  if (today.count < 3) notes.push(`funding sample count=${today.count} (<3)`);
  return { label, dailyFunding: r, cum3Funding: cum3.cum3, notes };
}

/**
 * FUNDING_V8_OBSERVE — 1d & 3d 누적 둘 다 같은 방향 극단.
 */
export function evalV8(ctx: SignalEvalContext): StrategySignal {
  const today = ctx.dailyMap.get(ctx.evalDate);
  const notes: string[] = [];
  if (!today) {
    notes.push(`evalDate ${ctx.evalDate} funding missing`);
    return { label: null, dailyFunding: NaN, cum3Funding: NaN, notes };
  }
  const { cum3, missing } = get3dCum(ctx.dailyMap, ctx.evalDate);
  if (missing.length > 0) {
    notes.push(`cum3 missing dates: ${missing.join(',')}`);
    return {
      label: null,
      dailyFunding: today.sum,
      cum3Funding: cum3,
      notes,
    };
  }
  const r = today.sum;
  let label: SignalLabel | null = null;
  const t = ctx.thresholds;
  if (r >= t.p90_1d && cum3 >= t.p90_3d) label = 'BOTH_F1';
  else if (r <= t.p10_1d && cum3 <= t.p10_3d) label = 'BOTH_F2';
  if (today.count < 3) notes.push(`funding sample count=${today.count} (<3)`);
  return { label, dailyFunding: r, cum3Funding: cum3, notes };
}

/** vol regime 분류 — train P25/P75/P95 기준 (paper 전 기간 고정) */
export function classifyVolRegime(
  vol14Pct: number,
  thresholds: TrainThresholds,
): 'LOW' | 'MID' | 'HIGH' | 'EXTREME' {
  if (vol14Pct < thresholds.volStdP25) return 'LOW';
  if (vol14Pct < thresholds.volStdP75) return 'MID';
  if (vol14Pct < thresholds.volStdP95) return 'HIGH';
  return 'EXTREME';
}

/** 14일 일봉 수익률 std (%) */
export function calcVol14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const recent = closes.slice(-15);
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    rets.push((recent[i] - recent[i - 1]) / recent[i - 1] * 100);
  }
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}
