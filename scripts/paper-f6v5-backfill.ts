#!/usr/bin/env tsx
/**
 * F6_v5 (TRAIL) backfill — 마지막 tick 이후 ~ 현재까지 cron이 돌았던 것처럼 시뮬.
 * F6 신호 + 트레일링 청산. 진입가는 신호봉 다음 4h bar open (lookahead-safe).
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V5_STATE_FILE, F6V5_TRADES_FILE, F6V5_TICKS_FILE, F6V5_COINS,
  F6V5_FEE, F6V5_SLIPPAGE, F6V5_MAX_BARS,
  F6V5_POSITION_PCT, F6V5_MAX_CONCURRENT, F6V5_LOOKBACK_BARS,
  readF6V5State, evaluateF6v5Signal, evalTrailExit, type BarLite,
} from '@/lib/paper-f6v5-store';
import fs from 'fs';

const FOUR_H_MS = 4 * 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

async function fetchBars(market: string, count = 80): Promise<BarLite[]> {
  const candles = await getUpbitClient().getCandlesMinutes(240, market, count);
  return candles.slice().reverse().map(c => ({
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price, high: (c as any).high_price,
    low: (c as any).low_price, close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
}

(async () => {
  console.log('=== Paper F6_v5 backfill ===');
  const state = readF6V5State();
  if (!state) { console.log('no F6_v5 state'); process.exit(0); }

  console.log('Fetching coins 4h bars...');
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V5_COINS) {
    try { barsByMarket.set(market, await fetchBars(market, 80)); process.stdout.write('.'); await new Promise(r => setTimeout(r, 150)); }
    catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n${barsByMarket.size}/${F6V5_COINS.length} markets`);

  const now = Date.now();
  const startTs = state.lastTickTs || (now - 7 * 86400_000);
  console.log(`\n[F6_v5] backfill from ${kstISO(startTs)} → ${kstISO(now)}`);
  const startKst = startTs + 9 * 3600_000;
  const nextBoundaryHour = Math.ceil((new Date(startKst).getUTCHours() + 1) / 4) * 4;
  const cursorKst = new Date(startKst); cursorKst.setUTCHours(nextBoundaryHour, 1, 0, 0);
  let cursor = cursorKst.getTime() - 9 * 3600_000;
  const tickPoints: number[] = [];
  while (cursor < now) { tickPoints.push(cursor); cursor += FOUR_H_MS; }
  console.log(`  → ${tickPoints.length} ticks to backfill`);
  if (tickPoints.length === 0) { console.log('  → no backfill needed'); process.exit(0); }

  for (const tickTs of tickPoints) {
    const exits: any[] = [];
    const pending: { market: string; ts: number; volZ: number }[] = [];

    // Exit (트레일링)
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars) continue;
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= tickTs && b.ts > pos.entryTs);
      const exit = evalTrailExit(confirmedBars, pos.entryPrice);
      if (exit) {
        const exitPrice = exit.price * (1 - F6V5_SLIPPAGE);
        const cashGained = pos.vol * exitPrice * (1 - F6V5_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained; state.totalRealizedPnl += profitKrw; state.totalTrades += 1;
        const closed = {
          market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice, profitRate, profitKrw,
          reason: exit.reason, recordedAt: new Date(tickTs).toISOString(),
        };
        exits.push(closed);
        fs.appendFileSync(F6V5_TRADES_FILE, JSON.stringify(closed) + '\n');
        state.positions.splice(p, 1);
        console.log(`  [${kstISO(tickTs).slice(11, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // Signal (F6 base)
    for (const market of F6V5_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6V5_LOOKBACK_BARS + 3) continue;
      let confirmedIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + FOUR_H_MS <= tickTs) { confirmedIdx = i; break; } }
      if (confirmedIdx < F6V5_LOOKBACK_BARS + 1) continue;
      const result = evaluateF6v5Signal(bars.slice(0, confirmedIdx + 1));
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // Entry — 다음 4h bar open
    let newEntries = 0;
    for (const sig of pending) {
      if (state.positions.length >= F6V5_MAX_CONCURRENT) break;
      if (state.positions.some(p => p.market === sig.market)) continue;
      const bars = barsByMarket.get(sig.market)!;
      const entryBar = bars[bars.findIndex(b => b.ts === sig.ts) + 1];
      if (!entryBar) continue;
      const entryPrice = entryBar.open * (1 + F6V5_SLIPPAGE);
      const cashToUse = state.cash * F6V5_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - F6V5_FEE) / entryPrice;
      state.cash -= cashToUse;
      state.positions.push({
        market: sig.market, entryTs: entryBar.ts, entryDate: kstISO(entryBar.ts),
        entryPrice, vol, cashUsed: cashToUse, entryBarsRemaining: F6V5_MAX_BARS,
      });
      newEntries++;
      console.log(`  [${kstISO(tickTs).slice(11, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
    }

    state.lastTickTs = tickTs;
    state.lastTickAt = new Date(tickTs).toISOString();
    fs.appendFileSync(F6V5_TICKS_FILE, JSON.stringify({
      ts: tickTs, tickAt: kstISO(tickTs),
      signalsCount: pending.length, newEntries, exits: exits.length,
      openPositions: state.positions.length, cash: state.cash, backfilled: true,
    }) + '\n');
  }

  fs.writeFileSync(F6V5_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[F6_v5] backfill 완료: ${state.positions.length} open, cash ${state.cash.toFixed(0)}, total trades ${state.totalTrades}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
