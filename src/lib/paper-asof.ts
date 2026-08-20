/**
 * 특정 시점(as-of)의 F6 계열 상태 재구성.
 *
 * state.json 은 "현재"만 담고 있어서 과거 시점 지표를 뽑으려면
 * ticks.jsonl(틱별 cash) + trades.jsonl(청산 기록) + 현재 열린 포지션으로 되짚어야 한다.
 * paper-f6-rewind.ts(되감기)와 paper-trading-report.ts(--asof 리포트)가 같이 쓴다.
 */
import fs from 'fs';

export interface TickRow {
  ts: number;
  cash: number;
  openPositions: number;
  backfilled?: boolean;
}

export interface ClosedTradeRow {
  market: string;
  entryTs: number;
  exitTs: number;
  entryDate: string;
  entryPrice: number;
  exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: string;
  recordedAt: string;
}

export interface PositionRow {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}

export interface AsOfSource {
  stateFile: string;
  ticksFile: string;
  tradesFile: string;
  fee: number;
  maxBars: number;
}

export interface AsOfState {
  /** 기준 시점 이하의 마지막 tick (없으면 null) */
  anchor: TickRow | null;
  cash: number;
  positions: PositionRow[];
  /** 기준 시점까지 청산이 기록된 거래 */
  closedTrades: ClosedTradeRow[];
  realizedPnl: number;
}

export function readJsonlFile<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

/**
 * 청산 기록만 남은 포지션 복원.
 * profitKrw = cashUsed × ((1-fee)² × exit/entry − 1) 를 cashUsed 에 대해 역산한다.
 */
export function restorePositionFromTrade(t: ClosedTradeRow, fee: number, maxBars: number): PositionRow {
  const ratio = (t.exitPrice / t.entryPrice) * (1 - fee) ** 2;
  const cashUsed = t.profitKrw / (ratio - 1);
  // ratio 가 정확히 1 이면(수수료를 상쇄하는 exit) 0 으로 나눠 NaN/Infinity 가 된다.
  // 그 값이 state.json 에 들어가면 cash·equity 가 영구히 NaN 이 되므로 여기서 끊는다.
  if (!Number.isFinite(cashUsed)) {
    throw new Error(
      `포지션 복원 실패 (cashUsed=${cashUsed}): ${t.market} ${t.entryDate} entry=${t.entryPrice} exit=${t.exitPrice} pnl=${t.profitKrw}`,
    );
  }
  return {
    market: t.market,
    entryTs: t.entryTs,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    vol: (cashUsed * (1 - fee)) / t.entryPrice,
    cashUsed,
    entryBarsRemaining: maxBars,
  };
}

/**
 * cutoffTs 시점의 상태.
 *
 * 라이브 tick 은 tick 시각보다 몇 초 뒤에 trade 를 기록하므로, anchor tick 이 남긴 청산까지
 * 포함하도록 "anchor tick 과 다음 tick 의 중간점"을 recordedAt 경계로 쓴다.
 */
export function f6StateAsOf(src: AsOfSource, cutoffTs: number): AsOfState {
  const ticks = readJsonlFile<TickRow>(src.ticksFile).sort((a, b) => a.ts - b.ts);
  const trades = readJsonlFile<ClosedTradeRow>(src.tradesFile);
  const state = fs.existsSync(src.stateFile)
    ? (JSON.parse(fs.readFileSync(src.stateFile, 'utf-8')) as { cash?: number; positions?: PositionRow[] })
    : {};

  const anchor = [...ticks].reverse().find((t) => t.ts <= cutoffTs) ?? null;
  if (!anchor) {
    return { anchor: null, cash: 0, positions: [], closedTrades: [], realizedPnl: 0 };
  }

  const nextTick = ticks.find((t) => t.ts > anchor.ts);
  const boundary = nextTick ? new Date((anchor.ts + nextTick.ts) / 2).toISOString() : new Date(cutoffTs).toISOString();

  const closedTrades = trades.filter((t) => t.recordedAt < boundary);
  const later = trades.filter((t) => t.recordedAt >= boundary);

  // entryTs <= anchor.ts — 12h(v6) 은 진입봉 시각이 tick 시각과 정확히 같아서 < 로 두면 누락된다.
  const stillOpen = (state.positions ?? []).filter((p) => p.entryTs <= anchor.ts);
  const reopened = later
    .filter((t) => t.entryTs <= anchor.ts)
    .map((t) => restorePositionFromTrade(t, src.fee, src.maxBars));

  return {
    anchor,
    cash: anchor.cash,
    positions: [...stillOpen, ...reopened],
    closedTrades,
    realizedPnl: closedTrades.reduce((s, t) => s + t.profitKrw, 0),
  };
}
