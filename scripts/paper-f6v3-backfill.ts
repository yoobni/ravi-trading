#!/usr/bin/env tsx
/**
 * F6_v3 (CONFIRM) backfill — 마지막 tick 이후 ~ 현재까지 cron이 돌았던 것처럼 시뮬.
 *
 * paper-f6-backfill.ts 와 동일 흐름. 신호만 evaluateF6v3(거짓돌파 확인봉 확정) 사용.
 * Exit TP+10%/SL-3%/MAX84, position 25%×max 4.
 *
 * 진입가: live tick 은 진입 시점 ticker(≈ 진입 4h bar open)를 쓰지만,
 *         backfill 에선 신호봉 다음 4h bar 의 open 으로 replay (lookahead-safe).
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V3_STATE_FILE, F6V3_TRADES_FILE, F6V3_TICKS_FILE, F6V3_COINS,
  F6V3_FEE, F6V3_SLIPPAGE, F6V3_TP_PCT, F6V3_SL_PCT, F6V3_MAX_BARS,
  F6V3_POSITION_PCT, F6V3_MAX_CONCURRENT, F6V3_LOOKBACK_BARS,
  readF6V3State, evaluateF6v3, type BarLite,
} from '@/lib/paper-f6v3-store';
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

(async () => {
  console.log('=== Paper F6_v3 backfill ===');
  const state = readF6V3State();
  if (!state) { console.log('no F6_v3 state'); process.exit(0); }

  console.log('Fetching coins 4h bars...');
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V3_COINS) {
    try {
      const bars = await fetchBars(market, 80);
      barsByMarket.set(market, bars);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) {
      console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`);
    }
  }
  console.log(`\n${barsByMarket.size}/${F6V3_COINS.length} markets`);

  const now = Date.now();
  const startTs = state.lastTickTs || (now - 7 * 86400_000);
  console.log(`\n[F6_v3] backfill from ${kstISO(startTs)} → ${kstISO(now)}`);

  // 4h boundary tick 시점 생성 (KST 00:01, 04:01, ...)
  const startKst = startTs + 9 * 3600_000;
  const startHour = new Date(startKst).getUTCHours();
  const nextBoundaryHour = Math.ceil((startHour + 1) / 4) * 4;
  const cursorKst = new Date(startKst);
  cursorKst.setUTCHours(nextBoundaryHour, 1, 0, 0);
  let cursor = cursorKst.getTime() - 9 * 3600_000;
  const tickPoints: number[] = [];
  while (cursor < now) { tickPoints.push(cursor); cursor += FOUR_H_MS; }
  console.log(`  → ${tickPoints.length} ticks to backfill`);
  if (tickPoints.length === 0) { console.log('  → no backfill needed'); process.exit(0); }

  for (const tickTs of tickPoints) {
    const exits: any[] = [];
    const pending: { market: string; ts: number; volZ: number }[] = [];

    // Exit check
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars) continue;
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= tickTs && b.ts > pos.entryTs);
      let exit: { reason: any; price: number; ts: number } | null = null;
      const tp = pos.entryPrice * (1 + F6V3_TP_PCT / 100);
      const sl = pos.entryPrice * (1 + F6V3_SL_PCT / 100);
      for (const b of confirmedBars) {
        if (b.low <= sl) { exit = { reason: 'SL', price: sl, ts: b.ts }; break; }
        if (b.high >= tp) { exit = { reason: 'TP', price: tp, ts: b.ts }; break; }
      }
      const elapsedBars = confirmedBars.length;
      if (!exit && elapsedBars >= F6V3_MAX_BARS) {
        const last = confirmedBars[F6V3_MAX_BARS - 1] || confirmedBars[confirmedBars.length - 1];
        exit = { reason: 'TIME', price: last.close, ts: last.ts };
      }
      if (exit) {
        const exitPrice = exit.price * (1 - F6V3_SLIPPAGE);
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - F6V3_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained;
        state.totalRealizedPnl += profitKrw;
        state.totalTrades += 1;
        const closed = {
          market: pos.market,
          entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice,
          profitRate, profitKrw, reason: exit.reason,
          recordedAt: new Date(tickTs).toISOString(),
        };
        exits.push(closed);
        fs.appendFileSync(F6V3_TRADES_FILE, JSON.stringify(closed) + '\n');
        state.positions.splice(p, 1);
        console.log(`  [${kstISO(tickTs).slice(11, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // Signal eval (CONFIRM)
    for (const market of F6V3_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6V3_LOOKBACK_BARS + 4) continue;
      let confirmedIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].ts + FOUR_H_MS <= tickTs) { confirmedIdx = i; break; }
      }
      if (confirmedIdx < F6V3_LOOKBACK_BARS + 2) continue;
      const sub = bars.slice(0, confirmedIdx + 1);
      const result = evaluateF6v3(sub);
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // Entry — 다음 4h bar open
    let newEntries = 0;
    for (const sig of pending) {
      if (state.positions.length >= F6V3_MAX_CONCURRENT) break;
      const bars = barsByMarket.get(sig.market)!;
      const sigIdx = bars.findIndex(b => b.ts === sig.ts);
      const entryBar = bars[sigIdx + 1];
      if (!entryBar) continue;
      const entryPrice = entryBar.open * (1 + F6V3_SLIPPAGE);
      const cashToUse = state.cash * F6V3_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - F6V3_FEE);
      const vol = cashAfterFee / entryPrice;
      state.cash -= cashToUse;
      state.positions.push({
        market: sig.market,
        entryTs: entryBar.ts,
        entryDate: kstISO(entryBar.ts),
        entryPrice, vol, cashUsed: cashToUse,
        entryBarsRemaining: F6V3_MAX_BARS,
      });
      newEntries++;
      console.log(`  [${kstISO(tickTs).slice(11, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
    }

    state.lastTickTs = tickTs;
    state.lastTickAt = new Date(tickTs).toISOString();
    fs.appendFileSync(F6V3_TICKS_FILE, JSON.stringify({
      ts: tickTs, tickAt: kstISO(tickTs),
      signalsCount: pending.length, newEntries, exits: exits.length,
      openPositions: state.positions.length, cash: state.cash,
      backfilled: true,
    }) + '\n');
  }

  fs.writeFileSync(F6V3_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[F6_v3] backfill 완료: ${state.positions.length} open, cash ${state.cash.toFixed(0)}, total trades ${state.totalTrades}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
