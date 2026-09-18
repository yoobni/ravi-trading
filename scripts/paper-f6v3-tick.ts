#!/usr/bin/env tsx
/**
 * F6_v3 (CONFIRM) paper trading tick.
 *
 * Cron: 매 4h KST (0,4,8,12,16,20시) +3분 (F6=+1, F6_v2=+2와 분리)
 *
 * 흐름은 F6와 동일하되 신호만 evaluateF6v3(거짓돌파 확정) 사용.
 * Exit TP+10%/SL-3%/MAX84, position 25%×max 4.
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V3_COINS, F6V3_FEE, F6V3_SLIPPAGE,
  F6V3_TP_PCT, F6V3_SL_PCT, F6V3_MAX_BARS, F6V3_POSITION_PCT, F6V3_MAX_CONCURRENT,
  F6V3_LOOKBACK_BARS,
  evaluateF6v3, type BarLite,
  withF6V3State, appendF6V3Trade, appendF6V3Tick,
  type F6V3Position, type F6V3ClosedTrade,
} from '@/lib/paper-f6v3-store';

function kstISO(ts: number): string { return new Date(ts + 9 * 3600_000).toISOString(); }

// 봉 개수: 신호 lookback 42 + 시간청산 MAX_BARS 84 = 126봉이 필요하다.
// 60봉만 받으면 confirmedBars 가 84에 닿지 못해 14일 시간청산(TIME)이 라이브에서
// 절대 발동하지 않는다 (2026-09-18 발견: v3 KRW-BTC 가 25일 보유 후 SL 로 청산됨).
// Upbit 요청당 상한이 200봉이라 200으로 맞춘다 — 요청 수는 그대로.
async function fetchBars(market: string, count = 200): Promise<BarLite[]> {
  const client = getUpbitClient();
  const candles = await client.getCandlesMinutes(240, market, count);
  const sorted = candles.slice().reverse();
  return sorted.map(c => ({
    // ⚠ 시각 규약: 여기 ts 는 **진짜 UTC** 다(candle_date_time_utc + 'Z').
    //   data/candle-cache 의 ts 는 KST 벽시계를 UTC 인 척 담고 있어 9시간 어긋난다.
    //   두 소스를 한 계산에 섞지 말 것. 표시는 kstISO() 를 쓴다.
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price,
    high: (c as any).high_price,
    low: (c as any).low_price,
    close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
}

interface PendingSignal { market: string; ts: number; volZ: number; }

(async () => {
  const now = Date.now();
  console.log(`\n=== F6_v3 paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V3_COINS) {
    try {
      const bars = await fetchBars(market, 200);
      barsByMarket.set(market, bars);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) {
      console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`);
    }
  }
  console.log(`\n[fetch] ${barsByMarket.size}/${F6V3_COINS.length} markets`);

  await withF6V3State(async (state) => {
    const FOUR_H_MS = 4 * 3600_000;

    // ─── Exit check ───
    const exitsThisTick: F6V3ClosedTrade[] = [];
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars || bars.length < 2) continue;
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= now && b.ts > pos.entryTs);
      let exit: { reason: F6V3ClosedTrade['reason']; price: number; ts: number } | null = null;
      const tp = pos.entryPrice * (1 + F6V3_TP_PCT / 100);
      const sl = pos.entryPrice * (1 + F6V3_SL_PCT / 100);
      for (const b of confirmedBars) {
        if (b.low <= sl) { exit = { reason: 'SL', price: sl, ts: b.ts }; break; }
        if (b.high >= tp) { exit = { reason: 'TP', price: tp, ts: b.ts }; break; }
      }
      const elapsedBars = confirmedBars.length;
      if (!exit && elapsedBars >= F6V3_MAX_BARS) {
        const lastConfirmed = confirmedBars[F6V3_MAX_BARS - 1] || confirmedBars[confirmedBars.length - 1];
        exit = { reason: 'TIME', price: lastConfirmed.close, ts: lastConfirmed.ts };
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
        const closed: F6V3ClosedTrade = {
          market: pos.market,
          entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice,
          profitRate, profitKrw, reason: exit.reason,
          recordedAt: new Date().toISOString(),
        };
        exitsThisTick.push(closed);
        appendF6V3Trade(closed);
        state.positions.splice(p, 1);
        console.log(`[exit] ${pos.market} ${exit.reason} @${exitPrice.toFixed(2)} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // ─── Signal evaluation (CONFIRM: 확인봉 = confirmed last bar) ───
    const pending: PendingSignal[] = [];
    for (const market of F6V3_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6V3_LOOKBACK_BARS + 4) continue;
      const confirmedIdx = (() => {
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].ts + FOUR_H_MS <= now) return i;
        }
        return -1;
      })();
      if (confirmedIdx < F6V3_LOOKBACK_BARS + 2) continue;
      const sub = bars.slice(0, confirmedIdx + 1); // 마지막 = 확인봉
      const result = evaluateF6v3(sub);
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // ─── Entry (max 4 concurrent, 25%) ───
    const newEntries: F6V3Position[] = [];
    for (const sig of pending) {
      if (state.positions.length >= F6V3_MAX_CONCURRENT) break;
      const bars = barsByMarket.get(sig.market)!;
      const client = getUpbitClient();
      let entryRaw = 0;
      try {
        const tickers = await client.getTicker([sig.market]);
        entryRaw = (tickers[0] as any).trade_price;
      } catch {
        entryRaw = bars[bars.length - 1].close;
      }
      const entryPrice = entryRaw * (1 + F6V3_SLIPPAGE);
      const cashToUse = state.cash * F6V3_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - F6V3_FEE);
      const vol = cashAfterFee / entryPrice;
      state.cash -= cashToUse;
      const pos: F6V3Position = {
        market: sig.market,
        entryTs: now,
        entryDate: kstISO(now),
        entryPrice,
        vol,
        cashUsed: cashToUse,
        entryBarsRemaining: F6V3_MAX_BARS,
      };
      state.positions.push(pos);
      newEntries.push(pos);
      console.log(`[entry] ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)} volZ=${sig.volZ.toFixed(2)}`);
    }

    state.lastTickTs = now;
    state.lastTickAt = new Date().toISOString();
    appendF6V3Tick({
      ts: now,
      tickAt: kstISO(now),
      signalsCount: pending.length,
      newEntries: newEntries.length,
      exits: exitsThisTick.length,
      openPositions: state.positions.length,
      cash: state.cash,
    });
    console.log(`\n[summary] signals=${pending.length}, entries=${newEntries.length}, exits=${exitsThisTick.length}, open=${state.positions.length}, cash=${state.cash.toFixed(0)}`);
  });

  process.exit(0);
})().catch((e) => {
  console.error('[F6_v3 tick FAIL]', e);
  process.exit(1);
});
