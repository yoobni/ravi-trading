#!/usr/bin/env tsx
/**
 * F6 / F6_v2 backfill — 마지막 tick 이후 ~ 현재까지 자동 cron이 돌았던 것처럼 시뮬.
 *
 * 흐름:
 *   1. 28코인 4h candle (최근 ~50 bars) fetch
 *   2. 마지막 tick 이후 매 4h boundary (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 KST) iteration
 *   3. 각 시점:
 *      - 직전 confirmed 4h bar에서 신호 평가 (lookahead-safe)
 *      - 기존 open positions의 청산 check (해당 4h bar 의 high/low)
 *      - 신호 있으면 다음 4h bar open 진입
 *   4. state + trades + ticks 업데이트
 *
 * V1 = F6, V2 = F6_v2. 둘 다 처리.
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
import {
  F6V2_STATE_FILE, F6V2_TRADES_FILE, F6V2_TICKS_FILE,
  F6V2_FEE, F6V2_SLIPPAGE, F6V2_TP_PCT, F6V2_SL_PCT, F6V2_MAX_BARS,
  F6V2_POSITION_PCT, F6V2_MAX_CONCURRENT, F6V2_LOOKBACK_BARS,
  readF6V2State,
  type F6V2Position, type F6V2ClosedTrade,
} from '@/lib/paper-f6v2-store';
import fs from 'fs';

const FOUR_H_MS = 4 * 3600_000;
function kstISO(ts: number): string { return new Date(ts + 9 * 3600_000).toISOString(); }

async function fetchBars(market: string, count = 80): Promise<BarLite[]> {
  const client = getUpbitClient();
  const candles = await client.getCandlesMinutes(240, market, count);
  const sorted = candles.slice().reverse();
  return sorted.map(c => ({
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price, high: (c as any).high_price,
    low: (c as any).low_price, close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
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
  const startKst = startTs + 9*3600_000;
  const startHour = new Date(startKst).getUTCHours();
  const nextBoundaryHour = Math.ceil((startHour + 1) / 4) * 4;
  let cursorKst = new Date(startKst);
  cursorKst.setUTCHours(nextBoundaryHour, 1, 0, 0); // 4h + 1분
  let cursor = cursorKst.getTime() - 9*3600_000;
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
  console.log('=== Paper F6 / F6_v2 backfill ===');

  // Fetch 28 coins bars (80 bars = 13d, 충분)
  console.log('Fetching 28 coins 4h bars...');
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6_COINS) {
    try {
      const bars = await fetchBars(market, 80);
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

  // V2 = F6_v2
  const f6v2State = readF6V2State();
  if (f6v2State) {
    await backfillVariant({
      name: 'F6_v2',
      state: f6v2State,
      stateFile: F6V2_STATE_FILE, tradesFile: F6V2_TRADES_FILE, ticksFile: F6V2_TICKS_FILE,
      TP_PCT: F6V2_TP_PCT, SL_PCT: F6V2_SL_PCT, MAX_BARS: F6V2_MAX_BARS,
      POSITION_PCT: F6V2_POSITION_PCT, MAX_CONCURRENT: F6V2_MAX_CONCURRENT,
      FEE: F6V2_FEE, SLIPPAGE: F6V2_SLIPPAGE, LOOKBACK: F6V2_LOOKBACK_BARS,
    }, barsByMarket);
  }

  console.log('\n=== Backfill complete ===');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
