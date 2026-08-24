/**
 * GET /api/paper-trading/history
 *
 * 전략별 과거 기록:
 *   - trades:      청산된 거래 전체 (KST 기준 epoch ms 로 내려줌)
 *   - equityCurve: 실현 손익 누적 곡선 (tick 에 평가액이 없어 실현 기준 — paper-metrics 와 동일 기준)
 *   - coverage:    기대 tick 슬롯 대비 실제 tick 유무 (live / backfill / missing) — cron 결손 확인용
 *
 * 시간은 전부 epoch ms(UTC) 로 내려주고 표시 시점에 KST 로 포맷한다.
 * (주의: F6 계열 파일의 entryDate/exitDate 문자열은 KST 를 'Z' 로 라벨한 값이라 그대로 파싱하면 9시간 밀린다.
 *  그래서 여기서는 문자열이 아니라 entryTs/exitTs epoch 만 쓴다.)
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import {
  STATE_FILE as F1F2_STATE_FILE,
  POSITIONS_FILE as F1F2_POSITIONS_FILE,
  SNAPSHOTS_FILE as F1F2_SNAPSHOTS_FILE,
  INITIAL_CASH_KRW as F1F2_INITIAL_CASH,
} from '@/lib/paper-trading-store';
import { F6_STATE_FILE, F6_TRADES_FILE, F6_TICKS_FILE, F6_INITIAL_CASH_KRW } from '@/lib/paper-f6-store';
import { F6V2_STATE_FILE, F6V2_TRADES_FILE, F6V2_TICKS_FILE, F6V2_INITIAL_CASH_KRW } from '@/lib/paper-f6v2-store';
import { F6V3_STATE_FILE, F6V3_TRADES_FILE, F6V3_TICKS_FILE, F6V3_INITIAL_CASH_KRW } from '@/lib/paper-f6v3-store';
import { F6V5_STATE_FILE, F6V5_TRADES_FILE, F6V5_TICKS_FILE, F6V5_INITIAL_CASH_KRW } from '@/lib/paper-f6v5-store';
import { F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_TICKS_FILE, F6V6_INITIAL_CASH_KRW } from '@/lib/paper-f6v6-store';
import { F6V7_STATE_FILE, F6V7_TRADES_FILE, F6V7_TICKS_FILE, F6V7_INITIAL_CASH_KRW } from '@/lib/paper-f6v7-store';
import { strategyDescription } from '@/lib/paper-strategy-meta';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** coverage 표시 구간 (일) */
const COVERAGE_DAYS = 21;

export type SlotMode = 'live' | 'backfill' | 'missing';

export interface HistoryTrade {
  market: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: string;
}

export interface HistoryStrategy {
  id: string;
  name: string;
  /** 이 전략이 뭘 하는지 한 줄 설명 (paper-strategy-meta) */
  description: string;
  initial: number;
  stepMs: number;
  /** 하루에 기대되는 tick 수 (coverage 그리드 열 개수) */
  slotsPerDay: number;
  trades: HistoryTrade[];
  equityCurve: Array<{ ts: number; equity: number }>;
  coverage: {
    from: number;
    to: number;
    expected: number;
    live: number;
    backfilled: number;
    missing: number;
    slots: Array<{ ts: number; mode: SlotMode }>;
  };
}

function readJsonl<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function safeReadJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
}

/**
 * tick 기록을 기대 슬롯 격자에 매핑한다.
 * tick 시각은 cron 지연 때문에 정확히 boundary 가 아니라 몇 초~몇 분 흔들리므로,
 * 마지막 tick 을 anchor 로 잡고 step 배수로 반올림해 슬롯 index 를 만든다.
 */
function buildCoverage(
  ticks: Array<{ ts: number; backfilled?: boolean }>,
  stepMs: number,
  startedAt: number | null,
  now: number,
) {
  const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
  const empty = { from: now, to: now, expected: 0, live: 0, backfilled: 0, missing: 0, slots: [] };
  if (!sorted.length) return empty;

  const anchor = sorted[sorted.length - 1].ts;
  const idxOf = (ts: number) => Math.round((ts - anchor) / stepMs);

  const windowStart = Math.max(now - COVERAGE_DAYS * DAY, startedAt ?? sorted[0].ts, sorted[0].ts);
  const firstIdx = Math.ceil((windowStart - anchor) / stepMs);
  // 마지막 tick 이 아니라 "지금"까지 그린다 — cron 이 멈춰 있으면 그 구간이 missing 으로 보여야 한다.
  // (floor 이므로 아직 예정 시각이 지나지 않은 슬롯은 세지 않음)
  const lastIdx = Math.max(idxOf(anchor), Math.floor((now - anchor) / stepMs));

  const modeByIdx = new Map<number, SlotMode>();
  for (const t of sorted) {
    const i = idxOf(t.ts);
    // 같은 슬롯에 live 와 backfill 이 겹치면 live 우선
    const mode: SlotMode = t.backfilled ? 'backfill' : 'live';
    if (mode === 'live' || !modeByIdx.has(i)) modeByIdx.set(i, mode);
  }

  const slots: Array<{ ts: number; mode: SlotMode }> = [];
  let live = 0, backfilled = 0, missing = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const mode = modeByIdx.get(i) ?? 'missing';
    if (mode === 'live') live++;
    else if (mode === 'backfill') backfilled++;
    else missing++;
    slots.push({ ts: anchor + i * stepMs, mode });
  }

  return {
    from: slots.length ? slots[0].ts : now,
    to: slots.length ? slots[slots.length - 1].ts : anchor,
    expected: slots.length,
    live,
    backfilled,
    missing,
    slots,
  };
}

function equityCurve(initial: number, trades: HistoryTrade[]) {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  let eq = initial;
  const pts = [{ ts: sorted.length ? sorted[0].exitTs - DAY : Date.now(), equity: initial }];
  for (const t of sorted) {
    eq += t.profitKrw;
    pts.push({ ts: t.exitTs, equity: eq });
  }
  return pts;
}

/** F6 계열 (4h / 12h) 공통 로더 */
function f6Family(
  id: string,
  name: string,
  tradesFile: string,
  ticksFile: string,
  initial: number,
  stepMs: number,
  startedAt: number | null,
  now: number,
): HistoryStrategy {
  const trades: HistoryTrade[] = readJsonl<any>(tradesFile).map((t) => ({
    market: t.market,
    entryTs: t.entryTs,
    exitTs: t.exitTs,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    profitRate: t.profitRate,
    profitKrw: t.profitKrw,
    reason: t.reason,
  }));
  const ticks = readJsonl<any>(ticksFile).map((t) => ({ ts: t.ts, backfilled: !!t.backfilled }));
  return {
    id,
    name,
    description: strategyDescription(id),
    initial,
    stepMs,
    slotsPerDay: Math.round(DAY / stepMs),
    trades,
    equityCurve: equityCurve(initial, trades),
    coverage: buildCoverage(ticks, stepMs, startedAt, now),
  };
}

export async function GET() {
  const now = Date.now();
  const out: HistoryStrategy[] = [];

  // ── F1F2 (daily) — tick 기록이 없으므로 daily-snapshots 의 날짜를 tick 으로 본다.
  const f1f2State = safeReadJson<any>(F1F2_STATE_FILE);
  const snapshots = readJsonl<any>(F1F2_SNAPSHOTS_FILE);
  const f1f2Ticks = snapshots.map((s) => {
    const ts = Date.parse(s.timestamp);
    // 백필 tick 은 정각(초·ms = 0)으로 기록된다 — 라이브 cron 은 실행 지연 때문에 항상 ms 가 붙는다.
    return { ts, backfilled: ts % 60_000 === 0 };
  }).filter((t) => Number.isFinite(t.ts));
  const f1f2Positions = readJsonl<any>(F1F2_POSITIONS_FILE);
  const f1f2Started = f1f2State?.startedAt ? Date.parse(f1f2State.startedAt) : null;

  for (const [id, name] of [
    ['F1F2_50', 'FUNDING_F1F2_50 (MAIN)'],
    ['F1F2_100', 'FUNDING_F1F2_100 (BENCHMARK)'],
  ] as const) {
    const key = id === 'F1F2_50' ? 'FUNDING_F1F2_50' : 'FUNDING_F1F2_100';
    const trades: HistoryTrade[] = f1f2Positions
      .filter((t) => t.strategy === key)
      .map((t) => ({
        market: 'KRW-BTC',
        entryTs: Date.parse(t.entryDate + 'T02:00:00Z'),
        exitTs: Date.parse(t.exitDate + 'T02:00:00Z'),
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        profitRate: t.profitRate,
        profitKrw: t.profitKrw,
        reason: t.reason,
      }));
    out.push({
      id,
      name,
      description: strategyDescription(id),
      initial: F1F2_INITIAL_CASH,
      stepMs: DAY,
      slotsPerDay: 1,
      trades,
      equityCurve: equityCurve(F1F2_INITIAL_CASH, trades),
      coverage: buildCoverage(f1f2Ticks, DAY, f1f2Started, now),
    });
  }

  // ── F6 계열
  const started = (p: string) => {
    const st = safeReadJson<any>(p);
    return st?.startedAt ? Date.parse(st.startedAt) : null;
  };
  const f6Defs: Array<{ id: string; name: string; trades: string; ticks: string; state: string; initial: number; stepMs: number }> = [
    { id: 'F6', name: 'F6 NEW_HIGH 42', trades: F6_TRADES_FILE, ticks: F6_TICKS_FILE, state: F6_STATE_FILE, initial: F6_INITIAL_CASH_KRW, stepMs: 4 * HOUR },
    { id: 'F6_v2', name: 'F6_v2 NEW_HIGH 42 (TP_OPT)', trades: F6V2_TRADES_FILE, ticks: F6V2_TICKS_FILE, state: F6V2_STATE_FILE, initial: F6V2_INITIAL_CASH_KRW, stepMs: 4 * HOUR },
    { id: 'F6_v3', name: 'F6_v3 NEW_HIGH 42 (CONFIRM)', trades: F6V3_TRADES_FILE, ticks: F6V3_TICKS_FILE, state: F6V3_STATE_FILE, initial: F6V3_INITIAL_CASH_KRW, stepMs: 4 * HOUR },
    { id: 'F6_v5', name: 'F6_v5 NEW_HIGH 42 (TRAIL A2·안정)', trades: F6V5_TRADES_FILE, ticks: F6V5_TICKS_FILE, state: F6V5_STATE_FILE, initial: F6V5_INITIAL_CASH_KRW, stepMs: 4 * HOUR },
    { id: 'F6_v6', name: 'F6_v6 NEW_HIGH (TRAIL 12h·A2)', trades: F6V6_TRADES_FILE, ticks: F6V6_TICKS_FILE, state: F6V6_STATE_FILE, initial: F6V6_INITIAL_CASH_KRW, stepMs: 12 * HOUR },
    { id: 'F6_v7', name: 'F6_v7', trades: F6V7_TRADES_FILE, ticks: F6V7_TICKS_FILE, state: F6V7_STATE_FILE, initial: F6V7_INITIAL_CASH_KRW, stepMs: 4 * HOUR },
  ];
  for (const d of f6Defs) {
    out.push(f6Family(d.id, d.name, d.trades, d.ticks, d.initial, d.stepMs, started(d.state), now));
  }

  return NextResponse.json({ strategies: out, now: new Date().toISOString() });
}
