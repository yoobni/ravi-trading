#!/usr/bin/env tsx
/**
 * F6 계열 rewind — 마지막 "라이브" tick 하나를 취소해서 tick 포인터를 갭 직전으로 되돌린다.
 *
 * 왜 필요한가:
 *   Mac sleep 등으로 cron 이 며칠 밀린 뒤 라이브 tick 이 먼저 돌면 state.lastTickTs 가
 *   현재로 점프한다. backfill 은 항상 state.lastTickTs 부터 시작하므로 그 뒤엔 갭을 못 채운다.
 *   이 스크립트로 마지막 라이브 tick 을 되감은 뒤 backfill 을 돌리면 갭 구간이
 *   4h boundary 에 맞춰 lookahead-safe 하게 재생된다.
 *
 * 되감기 방식 (마지막 tick 1개만):
 *   - 그 tick 에서 신규 진입한 포지션 제거 (entryTs === tick.ts)
 *   - 그 tick 에서 청산된 trade 를 trades.jsonl 에서 제거하고 포지션으로 복원
 *     (cashUsed 는 profitKrw = cashUsed*((1-FEE)^2*exit/entry - 1) 로 역산)
 *   - cash / totalTrades / totalRealizedPnl / lastTickTs 를 직전 tick 기록값으로 복원
 *   - ticks.jsonl 마지막 줄 제거
 *
 * 더 깊게 되감기 (--to): 지정한 KST 시각 이하의 마지막 tick 으로 상태를 재구성한다.
 *   - 그 시각 이후 recordedAt 을 가진 trade 를 제거하고, 그 중 entryTs 가 시각 이전인 건 포지션으로 복원
 *   - 현재 열린 포지션 중 entryTs 가 시각 이전인 것도 유지
 *   - 복원된 포지션 수가 그 tick 기록의 openPositions 와 다르면 해당 전략은 건너뛴다 (안전장치)
 *   ⚠️ 되감은 구간의 "라이브로 기록된" 거래는 backfill 재생본(봉 시가 진입)으로 대체된다.
 *
 * 사용: npx tsx scripts/paper-f6-rewind.ts                          (dry run, 마지막 tick 1개)
 *       npx tsx scripts/paper-f6-rewind.ts --apply                  (적용)
 *       npx tsx scripts/paper-f6-rewind.ts --to "2026-08-04 20:00"  (KST 기준 깊은 되감기, dry run)
 *       ... --only F6,F6_v2,F6_v3,F6_v5                            (대상 전략 제한)
 *
 * ⚠️ 되감기 전 data/paper-f6* 백업 권장. 되감기 직후 반드시 해당 backfill 을 실행할 것.
 */
import 'dotenv/config';
import fs from 'fs';
import { F6_STATE_FILE, F6_TRADES_FILE, F6_TICKS_FILE, F6_FEE, F6_MAX_BARS } from '@/lib/paper-f6-store';
import { F6V2_STATE_FILE, F6V2_TRADES_FILE, F6V2_TICKS_FILE, F6V2_FEE, F6V2_MAX_BARS } from '@/lib/paper-f6v2-store';
import { F6V3_STATE_FILE, F6V3_TRADES_FILE, F6V3_TICKS_FILE, F6V3_FEE, F6V3_MAX_BARS } from '@/lib/paper-f6v3-store';
import { F6V5_STATE_FILE, F6V5_TRADES_FILE, F6V5_TICKS_FILE, F6V5_FEE, F6V5_MAX_BARS } from '@/lib/paper-f6v5-store';
import { F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_TICKS_FILE, F6V6_FEE, F6V6_MAX_BARS } from '@/lib/paper-f6v6-store';
import { F6V7_STATE_FILE, F6V7_TRADES_FILE, F6V7_TICKS_FILE, F6V7_FEE, F6V7_MAX_BARS } from '@/lib/paper-f6v7-store';
import {
  F6V8_STATE_FILE, F6V8_TRADES_FILE, F6V8_TICKS_FILE, F6V8_FEE, F6V8_MAX_BARS,
} from '@/lib/paper-f6v8-store';
import { f6StateAsOf, restorePositionFromTrade, readJsonlFile } from '@/lib/paper-asof';

const APPLY = process.argv.includes('--apply');
/** --only F6,F6_v2 처럼 대상 제한 (미지정 시 전체) */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  const raw = process.argv[i + 1];
  if (!raw) throw new Error('--only 뒤에 전략 목록이 필요함 (예: F6,F6_v2)');
  return new Set(raw.split(',').map((x) => x.trim()));
})();

const TO_ARG = (() => {
  const i = process.argv.indexOf('--to');
  if (i < 0) return null;
  const raw = process.argv[i + 1];
  if (!raw) throw new Error('--to 뒤에 KST 시각을 넣어야 함 (예: "2026-08-04 20:00")');
  const ts = Date.parse(raw.replace(' ', 'T') + (/[+Z]/.test(raw) ? '' : '+09:00'));
  if (!Number.isFinite(ts)) throw new Error(`--to 파싱 실패: ${raw}`);
  return ts;
})();

interface Target {
  name: string;
  stateFile: string; tradesFile: string; ticksFile: string;
  FEE: number; MAX_BARS: number;
}

const TARGETS: Target[] = [
  { name: 'F6',    stateFile: F6_STATE_FILE,   tradesFile: F6_TRADES_FILE,   ticksFile: F6_TICKS_FILE,   FEE: F6_FEE,   MAX_BARS: F6_MAX_BARS },
  { name: 'F6_v2', stateFile: F6V2_STATE_FILE, tradesFile: F6V2_TRADES_FILE, ticksFile: F6V2_TICKS_FILE, FEE: F6V2_FEE, MAX_BARS: F6V2_MAX_BARS },
  { name: 'F6_v3', stateFile: F6V3_STATE_FILE, tradesFile: F6V3_TRADES_FILE, ticksFile: F6V3_TICKS_FILE, FEE: F6V3_FEE, MAX_BARS: F6V3_MAX_BARS },
  { name: 'F6_v5', stateFile: F6V5_STATE_FILE, tradesFile: F6V5_TRADES_FILE, ticksFile: F6V5_TICKS_FILE, FEE: F6V5_FEE, MAX_BARS: F6V5_MAX_BARS },
  { name: 'F6_v6', stateFile: F6V6_STATE_FILE, tradesFile: F6V6_TRADES_FILE, ticksFile: F6V6_TICKS_FILE, FEE: F6V6_FEE, MAX_BARS: F6V6_MAX_BARS },
  { name: 'F6_v7', stateFile: F6V7_STATE_FILE, tradesFile: F6V7_TRADES_FILE, ticksFile: F6V7_TICKS_FILE, FEE: F6V7_FEE, MAX_BARS: F6V7_MAX_BARS },
  { name: 'F6_v8', stateFile: F6V8_STATE_FILE, tradesFile: F6V8_TRADES_FILE, ticksFile: F6V8_TICKS_FILE, FEE: F6V8_FEE, MAX_BARS: F6V8_MAX_BARS },
];

/** --to 모드: 지정 시각 이하 마지막 tick 상태로 재구성 */
function rewindTo(t: Target, toTs: number) {
  if (!fs.existsSync(t.stateFile)) { console.log(`[${t.name}] state.json 없음 — skip`); return; }
  // ts 로 정렬 — 파일 줄 순서에 기대지 않는다 (되감기+백필을 섞으면 줄 순서가 어긋날 수 있음)
  const ticks = readJsonl<any>(t.ticksFile).sort((a, b) => a.ts - b.ts);
  const state = JSON.parse(fs.readFileSync(t.stateFile, 'utf-8'));
  const asof = f6StateAsOf(
    { stateFile: t.stateFile, ticksFile: t.ticksFile, tradesFile: t.tradesFile, fee: t.FEE, maxBars: t.MAX_BARS },
    toTs,
  );
  const anchor = asof.anchor;
  if (!anchor) { console.log(`[${t.name}] ${kst(toTs)} 이전 tick 없음 — skip`); return; }
  if (anchor.ts === ticks[ticks.length - 1].ts) { console.log(`[${t.name}] 이미 ${kst(anchor.ts)} 가 마지막 tick — 되감을 것 없음`); return; }

  const kept = asof.closedTrades;
  const removedCount = readJsonl<any>(t.tradesFile).length - kept.length;

  if (asof.positions.length !== anchor.openPositions) {
    console.log(`[${t.name}] ⚠️ 재구성 포지션 ${asof.positions.length} ≠ tick 기록 openPositions ${anchor.openPositions} — skip`);
    return;
  }

  const next = {
    ...state,
    cash: asof.cash,
    positions: asof.positions,
    totalTrades: state.totalTrades - removedCount,
    totalRealizedPnl: asof.realizedPnl,
    lastTickTs: anchor.ts,
    lastTickAt: new Date(anchor.ts).toISOString(),
  };

  const restoredCount = asof.positions.filter((p) => !(state.positions ?? []).some((q: any) => q.entryTs === p.entryTs && q.market === p.market)).length;
  console.log(`\n[${t.name}] → ${kst(anchor.ts)} 로 되감기`);
  console.log(`  cash    ${Math.round(state.cash).toLocaleString()} → ${Math.round(next.cash).toLocaleString()}`);
  console.log(`  trades  ${state.totalTrades} → ${next.totalTrades} (제거 ${removedCount}건, 그중 ${restoredCount}건은 포지션으로 복원)`);
  console.log(`  tick    ${ticks.length} → ${ticks.filter((x) => x.ts <= anchor.ts).length}줄`);
  console.log(`  포지션  ${asof.positions.map((p) => `${p.market}@${kst(p.entryTs)}`).join(', ') || '없음'}`);

  if (APPLY) {
    fs.writeFileSync(t.stateFile, JSON.stringify(next, null, 2));
    fs.writeFileSync(t.tradesFile, kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
    fs.writeFileSync(t.ticksFile, ticks.filter((x) => x.ts <= anchor.ts).map((x) => JSON.stringify(x)).join('\n') + '\n');
    console.log('  → 적용 완료');
  }
}

const readJsonl = readJsonlFile;

function kst(ts: number): string {
  return new Date(ts + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
}

if (TO_ARG !== null) {
  console.log(`=== rewind --to ${kst(TO_ARG)} ===`);
  for (const t of TARGETS) {
    if (ONLY && !ONLY.has(t.name)) { console.log(`[${t.name}] --only 대상 아님 — skip`); continue; }
    rewindTo(t, TO_ARG);
  }
  console.log(APPLY ? '\n=== rewind 완료 — 이어서 backfill 실행할 것 ===' : '\n=== DRY RUN (적용: --apply) ===');
  process.exit(0);
}

for (const t of TARGETS) {
  if (ONLY && !ONLY.has(t.name)) continue;
  if (t.name === 'F6_v6') continue; // v6 는 마지막 tick 이 backfill — 단일 tick 되감기 대상 아님
  if (!fs.existsSync(t.stateFile)) { console.log(`[${t.name}] state.json 없음 — skip`); continue; }
  const ticks = readJsonl<any>(t.ticksFile).sort((a, b) => a.ts - b.ts);
  const state = JSON.parse(fs.readFileSync(t.stateFile, 'utf-8'));
  if (ticks.length < 2) { console.log(`[${t.name}] tick 기록 부족 — skip`); continue; }

  const live = ticks[ticks.length - 1];
  const prev = ticks[ticks.length - 2];
  if (live.backfilled) { console.log(`[${t.name}] 마지막 tick 이 이미 backfill — 되감을 것 없음`); continue; }

  const allTrades = readJsonl<any>(t.tradesFile);
  // 라이브 tick 이 기록한 trade = recordedAt 이 두 tick 의 중간점 이후
  // (tick 시각 자체를 쓰면 직전 tick 이 몇 초 늦게 기록한 청산까지 잘못 지운다)
  const cutoff = new Date((prev.ts + live.ts) / 2).toISOString();
  const removed = allTrades.filter(x => x.recordedAt >= cutoff);
  const kept = allTrades.filter(x => x.recordedAt < cutoff);
  if (removed.length !== (live.exits || 0)) {
    console.log(`[${t.name}] ⚠️ 제거 대상 trade ${removed.length}건 ≠ tick 기록 exits ${live.exits}건 — skip`);
    continue;
  }

  // 청산된 포지션 복원 (cashUsed 역산)
  const restored = removed.map(x => restorePositionFromTrade(x, t.FEE, t.MAX_BARS));

  const dropped = (state.positions || []).filter((p: any) => p.entryTs === live.ts);
  const keptPos = (state.positions || []).filter((p: any) => p.entryTs !== live.ts);
  if (dropped.length !== (live.newEntries || 0)) {
    console.log(`[${t.name}] ⚠️ 제거 대상 진입 ${dropped.length}건 ≠ tick 기록 newEntries ${live.newEntries}건 — skip`);
    continue;
  }

  const next = {
    ...state,
    cash: prev.cash,
    positions: [...keptPos, ...restored],
    totalTrades: state.totalTrades - removed.length,
    totalRealizedPnl: state.totalRealizedPnl - removed.reduce((s, x) => s + x.profitKrw, 0),
    lastTickTs: prev.ts,
    lastTickAt: new Date(prev.ts).toISOString(),
  };
  if (next.positions.length !== prev.openPositions) {
    console.log(`[${t.name}] ⚠️ 복원 후 open ${next.positions.length} ≠ 직전 tick openPositions ${prev.openPositions} — skip`);
    continue;
  }

  console.log(`\n[${t.name}] ${kst(live.ts)} tick 되감기 → ${kst(prev.ts)}`);
  console.log(`  cash    ${Math.round(state.cash).toLocaleString()} → ${Math.round(next.cash).toLocaleString()}`);
  console.log(`  trades  ${state.totalTrades} → ${next.totalTrades} (제거: ${removed.map(x => `${x.market}/${x.reason}`).join(', ') || '없음'})`);
  console.log(`  진입취소 ${dropped.map((p: any) => p.market).join(', ') || '없음'}`);
  console.log(`  복원포지션 ${restored.map(p => `${p.market}@${kst(p.entryTs)}`).join(', ') || '없음'} → open ${next.positions.length}`);

  if (APPLY) {
    fs.writeFileSync(t.stateFile, JSON.stringify(next, null, 2));
    fs.writeFileSync(t.tradesFile, kept.map(x => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
    fs.writeFileSync(t.ticksFile, ticks.slice(0, -1).map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log('  → 적용 완료');
  }
}

console.log(APPLY ? '\n=== rewind 완료 — 이어서 backfill 실행할 것 ===' : '\n=== DRY RUN (적용: --apply) ===');
