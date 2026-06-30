#!/usr/bin/env tsx
/**
 * F6 NEW_HIGH 42 paper trading tick.
 *
 * Cron: 매 4h KST (0,4,8,12,16,20시)
 *
 * 흐름:
 *   1. Upbit 4h candle fetch (28 coin, 최근 50 bars)
 *   2. 모든 open positions에 대해 청산 체크:
 *      - 직전 confirmed 4h bar의 low <= SL → SL close
 *      - 직전 confirmed 4h bar의 high >= TP → TP close
 *      - entryBarsRemaining 0 도달 시 TIME close
 *   3. 모든 28 coin에 대해 F6 신호 평가 (직전 confirmed bar 기준)
 *   4. 신호 시간순 처리 → cash 33%로 진입 (max 3 concurrent)
 *   5. state 저장 + trade/tick 로그
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6_COINS, F6_INITIAL_CASH_KRW, F6_FEE, F6_SLIPPAGE,
  F6_TP_PCT, F6_SL_PCT, F6_MAX_BARS, F6_POSITION_PCT, F6_MAX_CONCURRENT,
  F6_LOOKBACK_BARS,
  evaluateF6, type BarLite,
  withF6State, appendF6Trade, appendF6Tick,
  type F6Position, type F6ClosedTrade,
} from '@/lib/paper-f6-store';

function kstISO(ts: number): string {
  return new Date(ts + 9 * 3600_000).toISOString();
}
function kstDate(ts: number): string {
  return new Date(ts + 9 * 3600_000).toISOString().slice(0, 10);
}

async function fetchBars(market: string, count = 60): Promise<BarLite[]> {
  const client = getUpbitClient();
  const candles = await client.getCandlesMinutes(240, market, count);
  // Upbit returns descending — reverse
  const sorted = candles.slice().reverse();
  return sorted.map(c => ({
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
  console.log(`\n=== F6 paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  // 1. Fetch bars for all coins
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6_COINS) {
    try {
      const bars = await fetchBars(market, 60);
      barsByMarket.set(market, bars);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) {
      console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`);
    }
  }
  console.log(`\n[fetch] ${barsByMarket.size}/${F6_COINS.length} markets`);

  await withF6State(async (state) => {
    // Determine latest confirmed bar ts (across all coins) — 같은 시간대 bar로 align
    // 각 코인 bars의 마지막 bar = 직전 4h close (KST 시간 align)
    // Upbit candle_date_time_utc: 해당 bar의 START time (UTC)
    // 즉 bars[N-1]은 현재 진행 중인 bar일 수 있음 (4h가 다 안 지났을 때)
    // → 마지막 bar의 ts가 (현재 ts - 4h) 이상이면 진행 중이므로 [N-2]까지만 confirmed로 본다
    // 단순화: 마지막 bar.ts + 4h > now면 진행 중. confirmed = [N-2]

    const FOUR_H_MS = 4 * 3600_000;

    // ─── Step 2: Exit check (open positions) ───
    const exitsThisTick: F6ClosedTrade[] = [];
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = barsByMarket.get(pos.market);
      if (!bars || bars.length < 2) continue;

      // Find bars after entry (entry 다음 bar부터의 모든 confirmed bars 검사)
      const entryTs = pos.entryTs;
      // confirmed bars after entry
      const confirmedBars = bars.filter(b => b.ts + FOUR_H_MS <= now && b.ts > entryTs);

      let exit: { reason: F6ClosedTrade['reason']; price: number; ts: number } | null = null;
      const tp = pos.entryPrice * (1 + F6_TP_PCT / 100);
      const sl = pos.entryPrice * (1 + F6_SL_PCT / 100);

      // Iterate bars after entry to check SL/TP
      for (const b of confirmedBars) {
        if (b.low <= sl) { exit = { reason: 'SL', price: sl, ts: b.ts }; break; }
        if (b.high >= tp) { exit = { reason: 'TP', price: tp, ts: b.ts }; break; }
      }

      // MAX: entryBarsRemaining에서 confirmed bars 수 만큼 감소
      const elapsedBars = confirmedBars.length;
      if (!exit && elapsedBars >= F6_MAX_BARS) {
        const lastConfirmed = confirmedBars[F6_MAX_BARS - 1] || confirmedBars[confirmedBars.length - 1];
        exit = { reason: 'TIME', price: lastConfirmed.close, ts: lastConfirmed.ts };
      }

      if (exit) {
        const exitPrice = exit.price * (1 - F6_SLIPPAGE);
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - F6_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained;
        state.totalRealizedPnl += profitKrw;
        state.totalTrades += 1;
        const closed: F6ClosedTrade = {
          market: pos.market,
          entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice,
          profitRate, profitKrw, reason: exit.reason,
          recordedAt: new Date().toISOString(),
        };
        exitsThisTick.push(closed);
        appendF6Trade(closed);
        state.positions.splice(p, 1);
        console.log(`[exit] ${pos.market} ${exit.reason} @${exitPrice.toFixed(2)} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // ─── Step 3: Signal evaluation (현재 진행 중인 bar 이전, 즉 confirmed last bar 기준) ───
    const pending: PendingSignal[] = [];
    for (const market of F6_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6_LOOKBACK_BARS + 3) continue;
      // confirmed last bar = 마지막 bar 중 ts + 4h <= now 인 것
      // Upbit는 보통 새 bar이 시작되면 즉시 partial bar 추가. 진행 중인 bar는 ts + 4h > now
      const confirmedIdx = (() => {
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].ts + FOUR_H_MS <= now) return i;
        }
        return -1;
      })();
      if (confirmedIdx < F6_LOOKBACK_BARS + 1) continue;
      // bars subset for evaluation (up to confirmedIdx)
      const sub = bars.slice(0, confirmedIdx + 1);
      const result = evaluateF6(sub);
      if (result.hit) {
        // 이미 같은 market에 open position이면 skip? 또는 multi-pos OK?
        // backtest에서는 multi-pos per coin OK였음 → 그대로
        pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
      }
    }

    pending.sort((a, b) => a.ts - b.ts);

    // ─── Step 4: Entry (max 3 concurrent) ───
    const newEntries: F6Position[] = [];
    for (const sig of pending) {
      if (state.positions.length >= F6_MAX_CONCURRENT) break;
      const bars = barsByMarket.get(sig.market)!;
      // entry price: 현재 ticker 가격 (다음 bar open 근사) + slippage
      // 단순화: 신호 bar의 close 사용 (실제 운영 시 ticker 호출 가능). 또는 현재 시작된 bar의 open.
      // 가장 정확: signal bar (confirmed) 다음 bar의 open. 그러나 그 bar는 진행 중.
      // Upbit ticker 호출하여 정확한 현재가 사용:
      const client = getUpbitClient();
      let entryRaw = 0;
      try {
        const tickers = await client.getTicker([sig.market]);
        entryRaw = (tickers[0] as any).trade_price;
      } catch {
        // fallback: 진행 중 bar 또는 signal bar close
        entryRaw = bars[bars.length - 1].close;
      }
      const entryPrice = entryRaw * (1 + F6_SLIPPAGE);
      const cashToUse = state.cash * F6_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - F6_FEE);
      const vol = cashAfterFee / entryPrice;
      state.cash -= cashToUse;
      const pos: F6Position = {
        market: sig.market,
        entryTs: now,
        entryDate: kstISO(now),
        entryPrice,
        vol,
        cashUsed: cashToUse,
        entryBarsRemaining: F6_MAX_BARS,
      };
      state.positions.push(pos);
      newEntries.push(pos);
      console.log(`[entry] ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)} volZ=${sig.volZ.toFixed(2)}`);
    }

    // ─── State update ───
    state.lastTickTs = now;
    state.lastTickAt = new Date().toISOString();

    // Log tick
    appendF6Tick({
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
  console.error('[F6 tick FAIL]', e);
  process.exit(1);
});
