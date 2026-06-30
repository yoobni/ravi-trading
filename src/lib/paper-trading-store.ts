/**
 * Paper trading 파일 IO.
 *
 * 두 전략을 동일 인프라로 운영:
 *   FUNDING_F1F2_50  — MAIN. 자본 50%. 판정 기준.
 *   FUNDING_F1F2_100 — BENCHMARK. 자본 100%. aggressive 비교용.
 *
 * 두 전략 모두 동일 신호(D7-C3 F1+F2), 자본 비율만 다름. V8/EMA200/stablecoin
 * gate는 폐기 — 메타데이터로만 기록.
 *
 * 모든 mutate 경로는 withFileLock으로 직렬화.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const PAPER_DIR = path.resolve(process.cwd(), 'data', 'paper-trading');
export const THRESHOLDS_FILE = path.join(PAPER_DIR, 'train-thresholds.json');
export const STATE_FILE = path.join(PAPER_DIR, 'state.json');
export const POSITIONS_FILE = path.join(PAPER_DIR, 'positions.jsonl');
export const SIGNALS_FILE = path.join(PAPER_DIR, 'signals.jsonl');
export const SNAPSHOTS_FILE = path.join(PAPER_DIR, 'daily-snapshots.jsonl');
export const FORWARD_RETURNS_FILE = path.join(PAPER_DIR, 'forward-returns.jsonl');

export type StrategyName = 'FUNDING_F1F2_50' | 'FUNDING_F1F2_100';
export const STRATEGIES: StrategyName[] = ['FUNDING_F1F2_50', 'FUNDING_F1F2_100'];

export const INITIAL_CASH_KRW = 10_000_000;
export const FEE = 0.0005;
export const SLIPPAGE = 0.0005;
export const TP_PCT = 8;
export const SL_PCT = -5;
export const MAX_DAYS = 10;

/**
 * 전략별 진입 자본 비율 (= cash × ratio × 0.995).
 *
 * Boost backtest (v2-boost-all.ts) 결과:
 *   자본  50%: PF 1.54, MDD 10.7%, 월 +0.70%, Top5제거 -1.15%, 3/3년
 *   자본 100%: PF 1.51, MDD 21.2%, 월 +1.40%, Top5제거 -5.23%, 3/3년
 *
 * MAIN(_50)으로 판정. _100은 aggressive benchmark 기록용.
 */
export const STRATEGY_SIZE_FRACTION: Record<StrategyName, number> = {
  FUNDING_F1F2_50: 0.5,
  FUNDING_F1F2_100: 1.0,
};

/**
 * Backtest F1F2 자본 50% OOS (2024-01 ~ 2026-06) 기준값.
 * judgeMain에서 "손실 백테스트 대비 과도" 체크에 사용.
 * paper-replay에서 직접 추출 (2026-06-04 기준).
 */
export const BACKTEST_F1F2_50_REFERENCE = {
  n: 34,
  pf: 1.54,
  mdd: 10.7,
  monthly: 0.70,
  top5: -1.15,
  posY: 3,
  winRate: 55.9,
  avgWinPct: 5.81,
  avgLossPct: -4.49,
  worstTradePct: -5.05,
} as const;

export type SignalLabel = 'F1' | 'F2' | 'BOTH_F1' | 'BOTH_F2';

export interface TrainThresholds {
  computedAt: string;
  trainStart: string;
  trainEnd: string;
  fundingSampleSize: number;
  p10_1d: number;
  p90_1d: number;
  p10_3d: number;
  p90_3d: number;
  /** 14일 BTC 일봉 수익률 std percentile (paper에서 vol regime 태그용, 고정) */
  volStdP25: number;
  volStdP75: number;
  volStdP95: number;
}

export interface PaperPosition {
  signal: SignalLabel;
  signalId: string;
  entryDate: string;
  entryPrice: number;
  vol: number;
  buyAmount: number;
  daysHeld: number;
}

export interface StrategyState {
  cash: number;
  position: PaperPosition | null;
  totalTrades: number;
  totalRealizedPnl: number;
}

export interface PaperState {
  startedAt: string;
  lastTickDate: string | null;
  strategies: Record<StrategyName, StrategyState>;
}

export interface ClosedPosition {
  strategy: StrategyName;
  signal: SignalLabel;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: 'TP' | 'SL' | 'TIME' | 'END';
  recordedAt: string;
}

export interface StrategyMetric {
  cumulative_return: number;
  drawdown: number;
  capital_usage_pct: number;
  cash: number;
  equity: number;
  /** 진입가 대비 현재 평가손익. 포지션 없으면 0. */
  unrealized_pnl: number;
}

export interface DailySnapshot {
  timestamp: string;
  date: string;
  upbit_btc_krw_price: number | null;
  binance_btc_usdt_price: number | null;
  funding_rate: number | null;
  /** 신호 강도: |funding| / max(|p10|, |p90|). 1.0 이상이면 임계값 초과. */
  funding_intensity: number | null;
  funding_signal_state: 'NEUTRAL' | 'F1_HOT' | 'F2_COLD';
  strategy_signal: 'none' | 'F1F2';
  position_state: Record<StrategyName, 'IN' | 'OUT'>;
  strategy_metrics: Record<StrategyName, StrategyMetric>;
  volatility_regime: 'LOW' | 'MID' | 'HIGH' | 'EXTREME' | null;
  vol_std_14d: number | null;
  stablecoin_1d_change: number | null;
  stablecoin_3d_change: number | null;
  stablecoin_7d_change: number | null;
  btc_trend_state: 'UP' | 'DOWN' | 'SIDE' | null;
  skipped_reason: string | null;
  data_missing_flag: string[];
}

export interface SignalRecord {
  signalId: string;
  signalTime: string;
  signalDate: string;
  strategyName: StrategyName;
  signalLabel: SignalLabel;
  dailyFunding: number;
  cum3Funding: number;
  entryAllowed: boolean;
  entryExecuted: boolean;
  entryDate: string | null;
  entryPrice: number | null;
  priceAtSignal: number;
  volatilityRegimeAtSignal: 'LOW' | 'MID' | 'HIGH' | 'EXTREME' | null;
  stablecoinStateAtSignal: {
    c1d: number | null;
    c3d: number | null;
    c7d: number | null;
  };
  skippedReason: string | null;
}

export interface ForwardReturnRecord {
  signalId: string;
  signalTime: string;
  signalDate: string;
  strategyName: StrategyName;
  signalLabel: SignalLabel;
  priceAtSignal: number;
  return_1h: number | null;
  return_4h: number | null;
  return_1d: number | null;
  return_3d: number | null;
  return_5d: number | null;
  return_until_exit_rule: number | null;
  exitRuleTriggered: 'TP' | 'SL' | 'TIME' | null;
  volatilityRegimeAtSignal: 'LOW' | 'MID' | 'HIGH' | 'EXTREME' | null;
  stablecoinStateAtSignal: {
    c1d: number | null;
    c3d: number | null;
    c7d: number | null;
  };
  lastUpdated: string;
  finalized: boolean;
}

function ensureDir() {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
}

export function loadThresholds(): TrainThresholds {
  if (!fs.existsSync(THRESHOLDS_FILE)) {
    throw new Error(
      `train-thresholds.json not found. Run scripts/paper-trading-init.ts first.`,
    );
  }
  return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf-8'));
}

export function saveThresholds(t: TrainThresholds): void {
  ensureDir();
  fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(t, null, 2));
}

function emptyStrategyState(): StrategyState {
  return {
    cash: INITIAL_CASH_KRW,
    position: null,
    totalTrades: 0,
    totalRealizedPnl: 0,
  };
}

export function freshState(now: string): PaperState {
  return {
    startedAt: now,
    lastTickDate: null,
    strategies: {
      FUNDING_F1F2_50: emptyStrategyState(),
      FUNDING_F1F2_100: emptyStrategyState(),
    },
  };
}

/** 매 tick에 strategy_metrics 계산용 — 누적 high water mark 추적 */
export interface EquityPeakTracker {
  /** strategy별 peak equity */
  peaks: Partial<Record<StrategyName, number>>;
}
export const PEAK_FILE = path.join(PAPER_DIR, 'equity-peaks.json');

export function loadPeaks(): EquityPeakTracker {
  if (!fs.existsSync(PEAK_FILE)) return { peaks: {} };
  return JSON.parse(fs.readFileSync(PEAK_FILE, 'utf-8'));
}
export function savePeaks(t: EquityPeakTracker): void {
  ensureDir();
  fs.writeFileSync(PEAK_FILE, JSON.stringify(t, null, 2));
}

export function loadState(): PaperState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function saveStateSync(s: PaperState): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export async function withState<T>(fn: (s: PaperState) => Promise<T> | T): Promise<T> {
  return withFileLock(STATE_FILE, async () => {
    let s = loadState();
    if (!s) {
      s = freshState(new Date().toISOString());
      saveStateSync(s);
    }
    const result = await fn(s);
    saveStateSync(s);
    return result;
  });
}

function appendJsonl(file: string, obj: unknown): void {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export async function appendPosition(p: ClosedPosition): Promise<void> {
  await withFileLock(POSITIONS_FILE, () => appendJsonl(POSITIONS_FILE, p));
}

export async function appendSnapshot(s: DailySnapshot): Promise<void> {
  await withFileLock(SNAPSHOTS_FILE, () => appendJsonl(SNAPSHOTS_FILE, s));
}

export async function appendSignal(s: SignalRecord): Promise<void> {
  await withFileLock(SIGNALS_FILE, () => appendJsonl(SIGNALS_FILE, s));
}

export async function appendForwardReturn(r: ForwardReturnRecord): Promise<void> {
  await withFileLock(FORWARD_RETURNS_FILE, () => appendJsonl(FORWARD_RETURNS_FILE, r));
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function rewriteJsonl<T>(file: string, rows: T[]): void {
  ensureDir();
  const content = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, content + (rows.length ? '\n' : ''));
}

export async function updateForwardReturn(
  signalId: string,
  update: (r: ForwardReturnRecord) => void,
): Promise<boolean> {
  return withFileLock(FORWARD_RETURNS_FILE, () => {
    const rows = readJsonl<ForwardReturnRecord>(FORWARD_RETURNS_FILE);
    const idx = rows.findIndex((r) => r.signalId === signalId);
    if (idx < 0) return false;
    update(rows[idx]);
    rows[idx].lastUpdated = new Date().toISOString();
    rewriteJsonl(FORWARD_RETURNS_FILE, rows);
    return true;
  });
}
