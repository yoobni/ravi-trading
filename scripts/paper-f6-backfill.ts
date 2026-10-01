#!/usr/bin/env tsx
/**
 * F6 backfill (F6_v2 는 2026-10-01 은퇴 — 예전엔 두 전략을 함께 처리했다) — 마지막 tick 이후 ~ 현재까지 자동 cron이 돌았던 것처럼 시뮬.
 *
 * 흐름:
 *   1. 28코인 4h candle (400 bars ≈ 66일, 요청당 200봉 상한이라 페이지네이션) fetch
 *   2. 마지막 tick 이후 매 4h boundary (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 KST) iteration
 *   3. 각 시점:
 *      - 직전 confirmed 4h bar에서 신호 평가 (lookahead-safe)
 *      - 기존 open positions의 청산 check (해당 4h bar 의 high/low)
 *      - 신호 있으면 다음 4h bar open 진입
 *   4. state + trades + ticks 업데이트
 *
 * F6 만 처리한다.
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import { evaluateF6, type BarLite } from '@/lib/paper-f6-store';
import {
  F6_STATE_FILE, F6_TRADES_FILE, F6_TICKS_FILE, F6_COINS,
  F6_FEE, F6_SLIPPAGE, F6_TP_PCT, F6_SL_PCT, F6_MAX_BARS,
  F6_POSITION_PCT, F6_MAX_CONCURRENT, F6_LOOKBACK_BARS,
  readF6State,
  type F6Position, type F6ClosedTrade,
} from '@/lib/paper-f6-store';
import fs from 'fs';

const FOUR_H_MS = 4 * 3600_000;
function kstISO(ts: number): string { return new Date(ts + 9 * 3600_000).toISOString(); }

async function fetchBars(market: string, count = 400): Promise<BarLite[]> {
  // Upbit 는 요청당 200봉이 상한 → 필요한 만큼 to 파라미터로 페이지네이션.
  const client = getUpbitClient();
  const acc: any[] = [];
  let to: string | undefined = undefined;
  while (acc.length < count) {
    const page = await client.getCandlesMinutes(240, market, Math.min(200, count - acc.length), to);
    if (!page.length) break;
    acc.push(...page);
    to = (page[page.length - 1] as any).candle_date_time_utc;
    if (page.length < 200) break;
    await new Promise(r => setTimeout(r, 120));
  }
  const seen = new Set<number>();
  return acc
    .map(c => ({
      // 시각 규약: ts 는 UTC ms. data/candle-cache 도 같은 UTC ms 라 섞어 써도 된다.
    //   (캐시는 candle_date_time_kst 를 로컬 TZ=Asia/Seoul 로 파싱해 같은 값이 된다)
    //   화면·기록 표시는 kstISO() 로 +9h 한다 — 계산에 그 값을 쓰지 말 것.
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
      open: (c as any).opening_price, high: (c as any).high_price,
      low: (c as any).low_price, close: (c as any).trade_price,
      volume: (c as any).candle_acc_trade_volume,
    }))
    .filter(b => (seen.has(b.ts) ? false : (seen.add(b.ts), true)))
    .sort((a, b) => a.ts - b.ts);
}

interface VariantSpec {
  name: string;
  state: any;
  stateFile: string;
  tradesFile: string;
  ticksFile: string;
  TP_PCT: number; SL_PCT: number; MAX_BARS: number;
  POSITION_PCT: number; MAX_CONCURRENT: number;
  FEE: number; SLIPPAGE: number;
  LOOKBACK: number;
}

async function backfillVariant(spec: VariantSpec, barsByMarket: Map<string, BarLite[]>) {
  const now = Date.now();
  const startTs = spec.state.lastTickTs || (now - 7*86400_000);
  console.log(`\n[${spec.name}] backfill from ${kstISO(startTs)} → ${kstISO(now)}`);

  // 4h boundary 시점들 생성 (KST 00:00, 04:00, ... 시점들)
  // tick은 KST 00:01, 04:01 ... 식 (4h 끝나고 1분 후). 시뮬에선 4h boundary로 처리.
  const tickPoints: number[] = [];
  // 가장 가까운 다음 4h boundary 찾기
  // 2026-10-01: 라이브 크론을 봉마감 정렬(KST 01/05/09/13/17/21)로 옮기면서 백필 격자도 맞춘다.
  //   안 맞추면 tick 커버리지 격자에 가짜 결손이 생긴다 (v7 에서 겪은 문제).
  //   4h 는 epoch(UTC 자정)을 정확히 나누므로 floor 만으로 봉마감 경계가 나온다.
  let cursor = Math.floor(startTs / FOUR_H_MS) * FOUR_H_MS + 1 * 60_000;
  while (cursor <= startTs) cursor += FOUR_H_MS;
  while (cursor < now) {
    tickPoints.push(cursor);
    cursor += FOUR_H_MS;
  }
  console.log(`  → ${tickPoints.length} ticks to backfill`);

  if (tickPoints.length === 0) {
    console.log(`  → no backfill needed`);
    return;
  }

  for (const tickTs of tickPoints) {
    // 이 tick 시점에 confirmed last bar = bar.ts + 4h <= tickTs
    const exits: any[] = [];
    const pending: { market: string; ts: number; volZ: number }[] = [];

    // Exit check (모든 open positions)
    for (let p = spec.state.positions.length - 1; p >= 0; p--) {
      const pos = spec.state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars) continue;
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= tickTs && b.ts > pos.entryTs);
      let exit: { reason: any; price: number; ts: number } | null = null;
      const tp = pos.entryPrice * (1 + spec.TP_PCT / 100);
      const sl = pos.entryPrice * (1 + spec.SL_PCT / 100);
      for (const b of confirmedBars) {
        if (b.low <= sl) { exit = { reason: 'SL', price: sl, ts: b.ts }; break; }
        if (b.high >= tp) { exit = { reason: 'TP', price: tp, ts: b.ts }; break; }
      }
      const elapsedBars = confirmedBars.length;
      if (!exit && elapsedBars >= spec.MAX_BARS) {
        const last = confirmedBars[spec.MAX_BARS - 1] || confirmedBars[confirmedBars.length - 1];
        exit = { reason: 'TIME', price: last.close, ts: last.ts };
      }
      if (exit) {
        const exitPrice = exit.price * (1 - spec.SLIPPAGE);
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - spec.FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        spec.state.cash += cashGained;
        spec.state.totalRealizedPnl += profitKrw;
        spec.state.totalTrades += 1;
        const closed = {
          market: pos.market,
          entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice,
          profitRate, profitKrw, reason: exit.reason,
          recordedAt: new Date(tickTs).toISOString(),
        };
        exits.push(closed);
        fs.appendFileSync(spec.tradesFile, JSON.stringify(closed) + '\n');
        spec.state.positions.splice(p, 1);
        console.log(`  [${kstISO(tickTs).slice(11, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // Signal eval
    for (const market of F6_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < spec.LOOKBACK + 3) continue;
      let confirmedIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].ts + FOUR_H_MS <= tickTs) { confirmedIdx = i; break; }
      }
      if (confirmedIdx < spec.LOOKBACK + 1) continue;
      const sub = bars.slice(0, confirmedIdx + 1);
      const result = evaluateF6(sub);
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // Entry — 다음 4h bar open 사용 (signal 직후 첫 가능 가격)
    let newEntries = 0;
    for (const sig of pending) {
      if (spec.state.positions.length >= spec.MAX_CONCURRENT) break;
      const bars = barsByMarket.get(sig.market)!;
      // signal bar 다음 bar (= 진입 bar) 찾기
      const sigIdx = bars.findIndex(b => b.ts === sig.ts);
      const entryBar = bars[sigIdx + 1];
      if (!entryBar) continue;
      const entryRaw = entryBar.open;
      const entryPrice = entryRaw * (1 + spec.SLIPPAGE);
      const cashToUse = spec.state.cash * spec.POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - spec.FEE);
      const vol = cashAfterFee / entryPrice;
      spec.state.cash -= cashToUse;
      const pos = {
        market: sig.market,
        entryTs: entryBar.ts,
        entryDate: kstISO(entryBar.ts),
        entryPrice, vol, cashUsed: cashToUse,
        entryBarsRemaining: spec.MAX_BARS,
      };
      spec.state.positions.push(pos);
      newEntries++;
      console.log(`  [${kstISO(tickTs).slice(11, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
    }

    // Tick log
    spec.state.lastTickTs = tickTs;
    spec.state.lastTickAt = new Date(tickTs).toISOString();
    const tickRecord = {
      ts: tickTs, tickAt: kstISO(tickTs),
      signalsCount: pending.length, newEntries, exits: exits.length,
      openPositions: spec.state.positions.length, cash: spec.state.cash,
      backfilled: true,
    };
    fs.appendFileSync(spec.ticksFile, JSON.stringify(tickRecord) + '\n');
  }

  fs.writeFileSync(spec.stateFile, JSON.stringify(spec.state, null, 2));
  console.log(`[${spec.name}] backfill 완료: ${spec.state.positions.length} open, cash ${spec.state.cash.toFixed(0)}, total trades ${spec.state.totalTrades}`);
}

(async () => {
  console.log('=== Paper F6 backfill ===');

  // Fetch 28 coins bars (400 bars = 66d, 되감기 백필 lookback 42봉 여유 — 요청당 200봉 상한이라 2페이지)
  console.log('Fetching 28 coins 4h bars...');
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6_COINS) {
    try {
      const bars = await fetchBars(market, 400);
      barsByMarket.set(market, bars);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) {
      console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`);
    }
  }
  console.log(`\n${barsByMarket.size}/${F6_COINS.length} markets`);

  // V1 = F6
  const f6State = readF6State();
  if (f6State) {
    await backfillVariant({
      name: 'F6',
      state: f6State,
      stateFile: F6_STATE_FILE, tradesFile: F6_TRADES_FILE, ticksFile: F6_TICKS_FILE,
      TP_PCT: F6_TP_PCT, SL_PCT: F6_SL_PCT, MAX_BARS: F6_MAX_BARS,
      POSITION_PCT: F6_POSITION_PCT, MAX_CONCURRENT: F6_MAX_CONCURRENT,
      FEE: F6_FEE, SLIPPAGE: F6_SLIPPAGE, LOOKBACK: F6_LOOKBACK_BARS,
    }, barsByMarket);
  }

  console.log('\n=== Backfill complete ===');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
