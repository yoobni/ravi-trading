#!/usr/bin/env tsx
/**
 * F6_v5 (TRAIL) paper trading tick.
 *
 * Cron: 매 4h KST (0,4,8,12,16,20시) +5분 (F6=+1, v2=+2, v3=+3와 분리; v4 제거로 +5 사용).
 *
 * F6 동일 신호(evaluateF6v5Signal)·사이징(33%×3). exit만 트레일링(evalTrailExit).
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V5_COINS, F6V5_FEE, F6V5_SLIPPAGE, F6V5_MAX_BARS,
  F6V5_POSITION_PCT, F6V5_MAX_CONCURRENT, F6V5_LOOKBACK_BARS,
  evaluateF6v5Signal, evalTrailExit, type BarLite,
  withF6V5State, appendF6V5Trade, appendF6V5Tick,
  type F6V5Position, type F6V5ClosedTrade,
} from '@/lib/paper-f6v5-store';

function kstISO(ts: number): string { return new Date(ts + 9 * 3600_000).toISOString(); }

async function fetchBars(market: string, count = 60): Promise<BarLite[]> {
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

interface PendingSignal { market: string; ts: number; volZ: number; }

(async () => {
  const now = Date.now();
  console.log(`\n=== F6_v5 paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V5_COINS) {
    try {
      barsByMarket.set(market, await fetchBars(market, 60));
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n[fetch] ${barsByMarket.size}/${F6V5_COINS.length} markets`);

  await withF6V5State(async (state) => {
    const FOUR_H_MS = 4 * 3600_000;

    // ─── Exit check (트레일링) ───
    const exitsThisTick: F6V5ClosedTrade[] = [];
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars || bars.length < 2) continue;
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= now && b.ts > pos.entryTs);
      const exit = evalTrailExit(confirmedBars, pos.entryPrice);
      if (exit) {
        const exitPrice = exit.price * (1 - F6V5_SLIPPAGE);
        const cashGained = pos.vol * exitPrice * (1 - F6V5_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained;
        state.totalRealizedPnl += profitKrw;
        state.totalTrades += 1;
        const closed: F6V5ClosedTrade = {
          market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice, profitRate, profitKrw,
          reason: exit.reason, recordedAt: new Date().toISOString(),
        };
        exitsThisTick.push(closed);
        appendF6V5Trade(closed);
        state.positions.splice(p, 1);
        console.log(`[exit] ${pos.market} ${exit.reason} @${exitPrice.toFixed(2)} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // ─── Signal (F6 base) ───
    const pending: PendingSignal[] = [];
    for (const market of F6V5_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6V5_LOOKBACK_BARS + 3) continue;
      let confirmedIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + FOUR_H_MS <= now) { confirmedIdx = i; break; } }
      if (confirmedIdx < F6V5_LOOKBACK_BARS + 1) continue;
      const result = evaluateF6v5Signal(bars.slice(0, confirmedIdx + 1));
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // ─── Entry (33% × max 3) ───
    const newEntries: F6V5Position[] = [];
    for (const sig of pending) {
      if (state.positions.length >= F6V5_MAX_CONCURRENT) break;
      if (state.positions.some(p => p.market === sig.market)) continue;
      const bars = barsByMarket.get(sig.market)!;
      const client = getUpbitClient();
      let entryRaw = bars[bars.length - 1].close;
      try { const tk = await client.getTicker([sig.market]); if (tk[0]) entryRaw = (tk[0] as any).trade_price; }
      catch { /* fallback: 마지막 close */ }
      const entryPrice = entryRaw * (1 + F6V5_SLIPPAGE);
      const cashToUse = state.cash * F6V5_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - F6V5_FEE) / entryPrice;
      state.cash -= cashToUse;
      const pos: F6V5Position = {
        market: sig.market, entryTs: now, entryDate: kstISO(now),
        entryPrice, vol, cashUsed: cashToUse, entryBarsRemaining: F6V5_MAX_BARS,
      };
      state.positions.push(pos);
      newEntries.push(pos);
      console.log(`[entry] ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)} volZ=${sig.volZ.toFixed(2)}`);
    }

    state.lastTickTs = now;
    state.lastTickAt = new Date().toISOString();
    appendF6V5Tick({
      ts: now, tickAt: kstISO(now),
      signalsCount: pending.length, newEntries: newEntries.length, exits: exitsThisTick.length,
      openPositions: state.positions.length, cash: state.cash,
    });
    console.log(`\n[summary] signals=${pending.length}, entries=${newEntries.length}, exits=${exitsThisTick.length}, open=${state.positions.length}, cash=${state.cash.toFixed(0)}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[F6_v5 tick FAIL]', e); process.exit(1); });
