/**
 * Paper trading 메타데이터 수집 — 진입 필터로 사용하지 않음. 기록 전용.
 *
 * 라비 명세 §3:
 *   - volatility_regime
 *   - stablecoin_1d/3d/7d_change
 *   - btc_trend_state
 *
 * 데이터 소스:
 *   - daily-metrics-collector가 매일 누적하는 data/daily-metrics/cg_usdt.json,
 *     cg_usdc.json
 *   - BTC 일봉은 호출자가 전달 (Upbit KRW-BTC)
 */
import fs from 'fs';
import path from 'path';

const METRICS_DIR = path.resolve(process.cwd(), 'data', 'daily-metrics');

interface MetricRow {
  date: string;
  ts: number;
  value: number;
}

function loadMetric(file: string): MetricRow[] {
  const fp = path.join(METRICS_DIR, file);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

/**
 * USDT + USDC 시총 합산. 일자별 map 반환.
 */
function loadStablecoinTotal(): Map<string, number> {
  const usdt = loadMetric('cg_usdt.json');
  const usdc = loadMetric('cg_usdc.json');
  const map = new Map<string, number>();
  for (const r of usdt) map.set(r.date, (map.get(r.date) ?? 0) + r.value);
  for (const r of usdc) map.set(r.date, (map.get(r.date) ?? 0) + r.value);
  return map;
}

export interface StablecoinChange {
  c1d: number | null;
  c3d: number | null;
  c7d: number | null;
  asOfDate: string | null;
}

/**
 * `asOfDate` 기준 1d/3d/7d 변화율 (%) 반환.
 * 데이터 없으면 null.
 */
export function getStablecoinChange(asOfDate: string): StablecoinChange {
  const map = loadStablecoinTotal();
  const today = map.get(asOfDate);
  if (today == null) {
    return { c1d: null, c3d: null, c7d: null, asOfDate: null };
  }
  function pctChange(daysBack: number): number | null {
    const d = new Date(asOfDate + 'T00:00:00Z');
    const prevDate = new Date(d.getTime() - daysBack * 86400_000).toISOString().slice(0, 10);
    const prev = map.get(prevDate);
    if (prev == null || prev === 0) return null;
    return (today! - prev) / prev * 100;
  }
  return {
    c1d: pctChange(1),
    c3d: pctChange(3),
    c7d: pctChange(7),
    asOfDate,
  };
}

/**
 * BTC trend state — 단순 정의 (진입 필터로 사용 X, 태그용).
 *   close > EMA20 × 1.02  → UP
 *   close < EMA20 × 0.98  → DOWN
 *   else                  → SIDE
 */
export function classifyBtcTrend(closes: number[]): 'UP' | 'DOWN' | 'SIDE' | null {
  if (closes.length < 20) return null;
  const recent = closes.slice(-20);
  // 간단 EMA20
  let ema = recent[0];
  const alpha = 2 / (20 + 1);
  for (let i = 1; i < recent.length; i++) {
    ema = recent[i] * alpha + ema * (1 - alpha);
  }
  const close = recent[recent.length - 1];
  if (close > ema * 1.02) return 'UP';
  if (close < ema * 0.98) return 'DOWN';
  return 'SIDE';
}
