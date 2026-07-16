#!/usr/bin/env tsx
/** F6_v6 (TRAIL 12h) backfill — 4h fetch → 12h 합성, 12h창 경계마다 replay. 진입=다음 12h봉 open. */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_TICKS_FILE, F6V6_COINS, F6V6_TF_HOURS,
  F6V6_FEE, F6V6_SLIPPAGE, F6V6_MAX_BARS, F6V6_POSITION_PCT, F6V6_MAX_CONCURRENT, F6V6_LOOKBACK_BARS,
  readF6V6State, aggregate12h, evaluateF6v6Signal, evalTrailExit, type BarLite,
} from '@/lib/paper-f6v6-store';
import fs from 'fs';

const WIN = F6V6_TF_HOURS * 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();
async function fetch4h(market: string, count = 200): Promise<BarLite[]> {
  const candles = await getUpbitClient().getCandlesMinutes(240, market, count);
  return candles.slice().reverse().map(c => ({
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price, high: (c as any).high_price,
    low: (c as any).low_price, close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
}

(async () => {
  console.log('=== Paper F6_v6 (12h) backfill ===');
  const state = readF6V6State();
  if (!state) { console.log('no F6_v6 state'); process.exit(0); }
  const bars12 = new Map<string, BarLite[]>();
  for (const market of F6V6_COINS) {
    try { bars12.set(market, aggregate12h(await fetch4h(market, 200))); process.stdout.write('.'); await new Promise(r => setTimeout(r, 150)); }
    catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n${bars12.size}/${F6V6_COINS.length} markets`);

  const now = Date.now();
  const startTs = state.lastTickTs || (now - 21 * 86400_000);
  console.log(`\n[F6_v6] backfill from ${kstISO(startTs)} → ${kstISO(now)}`);
  let cursor = (Math.floor(startTs / WIN) + 1) * WIN; // 첫 12h창 마감시각
  const tickPoints: number[] = [];
  while (cursor <= now) { tickPoints.push(cursor); cursor += WIN; }
  console.log(`  → ${tickPoints.length} ticks(12h) to backfill`);
  if (tickPoints.length === 0) { console.log('  → no backfill needed'); process.exit(0); }

  for (const tickTs of tickPoints) {
    const exits: any[] = [];
    const pending: { market: string; ts: number; volZ: number }[] = [];
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = bars12.get(pos.market); if (!bars) continue;
      const confirmedBars = bars.filter(b => b.ts + WIN <= tickTs && b.ts > pos.entryTs);
      const exit = evalTrailExit(confirmedBars, pos.entryPrice);
      if (exit) {
        const exitPrice = exit.price * (1 - F6V6_SLIPPAGE);
        const cashGained = pos.vol * exitPrice * (1 - F6V6_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained; state.totalRealizedPnl += profitKrw; state.totalTrades += 1;
        const closed = { market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts, entryDate: pos.entryDate, exitDate: kstISO(exit.ts), entryPrice: pos.entryPrice, exitPrice, profitRate, profitKrw, reason: exit.reason, recordedAt: new Date(tickTs).toISOString() };
        exits.push(closed); fs.appendFileSync(F6V6_TRADES_FILE, JSON.stringify(closed) + '\n'); state.positions.splice(p, 1);
        console.log(`  [${kstISO(tickTs).slice(5, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }
    for (const market of F6V6_COINS) {
      const bars = bars12.get(market); if (!bars) continue;
      let ci = -1; for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + WIN <= tickTs) { ci = i; break; } }
      if (ci < F6V6_LOOKBACK_BARS + 1) continue;
      const r = evaluateF6v6Signal(bars.slice(0, ci + 1));
      if (r.hit) pending.push({ market, ts: bars[ci].ts, volZ: r.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);
    let newEntries = 0;
    for (const sig of pending) {
      if (state.positions.length >= F6V6_MAX_CONCURRENT) break;
      if (state.positions.some(p => p.market === sig.market)) continue;
      const bars = bars12.get(sig.market)!;
      const entryBar = bars[bars.findIndex(b => b.ts === sig.ts) + 1];
      if (!entryBar) continue;
      const entryPrice = entryBar.open * (1 + F6V6_SLIPPAGE);
      const cashToUse = state.cash * F6V6_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - F6V6_FEE) / entryPrice;
      state.cash -= cashToUse;
      state.positions.push({ market: sig.market, entryTs: entryBar.ts, entryDate: kstISO(entryBar.ts), entryPrice, vol, cashUsed: cashToUse, entryBarsRemaining: F6V6_MAX_BARS });
      newEntries++;
      console.log(`  [${kstISO(tickTs).slice(5, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
    }
    state.lastTickTs = tickTs; state.lastTickAt = new Date(tickTs).toISOString();
    fs.appendFileSync(F6V6_TICKS_FILE, JSON.stringify({ ts: tickTs, tickAt: kstISO(tickTs), signalsCount: pending.length, newEntries, exits: exits.length, openPositions: state.positions.length, cash: state.cash, backfilled: true }) + '\n');
  }
  fs.writeFileSync(F6V6_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[F6_v6] backfill 완료: ${state.positions.length} open, cash ${state.cash.toFixed(0)}, total trades ${state.totalTrades}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
