/**
 * Paper trading 초기화 — train threshold 사전 계산 (1회 실행).
 *
 * D7-C3 / E2-V8 백테스트와 동일한 train period (2021-06-01 ~ 2024-01-01)에서:
 *   - daily funding sum p10 / p90
 *   - 3일 누적 funding sum p10 / p90
 *   - 14일 BTC 수익률 std p25 / p75 / p95 (vol regime 태그용)
 *
 * 결과: data/paper-trading/train-thresholds.json
 *
 * paper-trading-tick.ts는 매일 이 값을 읽어 신호 평가.
 * 한 번 결정된 임계값은 paper 운영 중 변경 금지 (룰 변경 금지).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchDailyCached } from './_daily-cache';
import {
  PAPER_DIR,
  saveThresholds,
  loadThresholds,
  type TrainThresholds,
} from '@/lib/paper-trading-store';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
// Funding threshold: backtest D7-C3와 동일하게 SPLIT_DATE 이전 전체 사용 (2019-09 ~ 2024-01-01)
const FUNDING_TRAIN_START = '2019-09-08';
// Vol regime: backtest E-3과 동일하게 1800일 fetch 범위 사용 (2021-06 ~ 2024-01-01)
const VOL_TRAIN_START = '2021-06-01';
const TRAIN_END = '2024-01-01';

interface FundingPoint {
  ts: number;
  date: string;
  rate: number;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

(async () => {
  fs.mkdirSync(PAPER_DIR, { recursive: true });

  // 기존 thresholds 있으면 보존 (룰 변경 금지)
  try {
    const existing = loadThresholds();
    console.log(`이미 train-thresholds.json 존재 (computedAt=${existing.computedAt}).`);
    console.log(`룰 변경 금지 원칙에 따라 덮어쓰지 않음.`);
    console.log(`강제 재계산하려면 파일 삭제 후 재실행.\n`);
    console.log(JSON.stringify(existing, null, 2));
    process.exit(0);
  } catch {
    // 없으면 계산
  }

  console.log(`\n=== Paper Trading 초기화 ===`);
  console.log(`Funding train: ${FUNDING_TRAIN_START} ~ ${TRAIN_END} (backtest D7-C3와 동일)`);
  console.log(`Vol train: ${VOL_TRAIN_START} ~ ${TRAIN_END} (backtest E-3과 동일)\n`);

  // 1. Funding 데이터 — train 구간만
  const fundingFile = path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json');
  if (!fs.existsSync(fundingFile)) {
    console.error(`✗ funding cache not found: ${fundingFile}`);
    process.exit(1);
  }
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(fundingFile, 'utf-8'));

  // 일자별 합산
  const dailySumMap = new Map<string, number>();
  for (const f of funding) {
    if (f.date < FUNDING_TRAIN_START || f.date >= TRAIN_END) continue;
    dailySumMap.set(f.date, (dailySumMap.get(f.date) ?? 0) + f.rate);
  }
  const trainDays = [...dailySumMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const trainRates = trainDays.map(([, r]) => r);

  // 3일 누적
  const trainCum3: number[] = [];
  for (let i = 0; i < trainRates.length; i++) {
    if (i < 2) continue;
    trainCum3.push(trainRates[i - 2] + trainRates[i - 1] + trainRates[i]);
  }

  const p10_1d = percentile(trainRates, 0.10);
  const p90_1d = percentile(trainRates, 0.90);
  const p10_3d = percentile(trainCum3, 0.10);
  const p90_3d = percentile(trainCum3, 0.90);

  console.log(`[Funding] ${trainRates.length} train days`);
  console.log(`  1d  p10=${p10_1d.toFixed(4)}  p90=${p90_1d.toFixed(4)}`);
  console.log(`  3d  p10=${p10_3d.toFixed(4)}  p90=${p90_3d.toFixed(4)}\n`);

  // 2. Vol regime용 BTC 일봉 — train 구간만
  console.log(`[BTC daily] fetching for vol regime calc ...`);
  const bars = await fetchDailyCached('KRW-BTC', 1800);
  const trainBars = bars.filter((b) => b.date >= VOL_TRAIN_START && b.date < TRAIN_END);
  console.log(`  ${trainBars.length} train bars`);

  const dailyRets = trainBars.map((b, i) =>
    i > 0 ? (b.close - trainBars[i - 1].close) / trainBars[i - 1].close * 100 : 0,
  );
  const vol14: number[] = [];
  for (let i = 14; i < trainBars.length; i++) {
    const win = dailyRets.slice(i - 13, i + 1);
    const m = win.reduce((s, v) => s + v, 0) / win.length;
    const v = win.reduce((s, r) => s + (r - m) ** 2, 0) / win.length;
    vol14.push(Math.sqrt(v));
  }
  const volStdP25 = percentile(vol14, 0.25);
  const volStdP75 = percentile(vol14, 0.75);
  const volStdP95 = percentile(vol14, 0.95);
  console.log(`  vol14 p25=${volStdP25.toFixed(2)}%  p75=${volStdP75.toFixed(2)}%  p95=${volStdP95.toFixed(2)}%\n`);

  // 3. 저장
  const t: TrainThresholds = {
    computedAt: new Date().toISOString(),
    trainStart: FUNDING_TRAIN_START,
    trainEnd: TRAIN_END,
    fundingSampleSize: trainRates.length,
    p10_1d,
    p90_1d,
    p10_3d,
    p90_3d,
    volStdP25,
    volStdP75,
    volStdP95,
  };
  saveThresholds(t);
  console.log(`저장: ${path.join(PAPER_DIR, 'train-thresholds.json')}`);
  console.log(`\n=== 완료 ===`);
  process.exit(0);
})();
