#!/usr/bin/env tsx
/**
 * F6_v7 (봉마감 정렬) backfill — 마지막 tick 이후 ~ 현재까지 cron이 돌았던 것처럼 시뮬.
 *
 * ⚠ 백필은 진입가로 신호봉 다음 4h bar open 을 쓴다. 이는 정렬된 크론(v7)의 라이브
 *   동작과는 거의 같지만, 미정렬 전략(v5 등)의 라이브와는 3시간 차이가 난다.
 *   즉 v5 와 v7 을 비교할 때 백필 구간이 섞이면 정렬 효과가 희석된다 — 라이브 구간만 비교할 것.
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V7_STATE_FILE, F6V7_TRADES_FILE, F6V7_TICKS_FILE, F6V7_COINS,
  F6V7_FEE, F6V7_SLIPPAGE, F6V7_MAX_BARS,
  F6V7_POSITION_PCT, F6V7_MAX_CONCURRENT, F6V7_LOOKBACK_BARS,
  readF6V7State, evaluateF6v5Signal, evalTrailExit, type BarLite,
} from '@/lib/paper-f6v7-store';
import fs from 'fs';

const FOUR_H_MS = 4 * 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

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

(async () => {
  console.log('=== Paper F6_v7 backfill ===');
  const state = readF6V7State();
  if (!state) { console.log('no F6_v7 state'); process.exit(0); }

  console.log('Fetching coins 4h bars...');
  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V7_COINS) {
    try { barsByMarket.set(market, await fetchBars(market, 400)); process.stdout.write('.'); await new Promise(r => setTimeout(r, 150)); }
    catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n${barsByMarket.size}/${F6V7_COINS.length} markets`);

  const now = Date.now();
  const startTs = state.lastTickTs || (now - 7 * 86400_000);
  console.log(`\n[F6_v7] backfill from ${kstISO(startTs)} → ${kstISO(now)}`);
  // v7 은 "봉마감 정렬" 전략 — tick 격자도 라이브 크론과 같은 봉마감(UTC 00/04/08/12/16/20)
  // +2분 위에 놓는다. (F6 계열 backfill 은 미정렬 크론 격자를 쓰지만, v7 은 그 정렬 자체가
  // 검증 대상이라 격자가 어긋나면 tick 커버리지 격자에서 결손으로 잘못 보인다.)
  // 4h 는 epoch(UTC 자정 기준)를 정확히 나누므로 floor 만으로 봉마감 경계가 나온다.
  let cursor = Math.floor(startTs / FOUR_H_MS) * FOUR_H_MS + 2 * 60_000;
  while (cursor <= startTs) cursor += FOUR_H_MS;
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
        const exitPrice = exit.price * (1 - F6V7_SLIPPAGE);
        const cashGained = pos.vol * exitPrice * (1 - F6V7_FEE);
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
        fs.appendFileSync(F6V7_TRADES_FILE, JSON.stringify(closed) + '\n');
        state.positions.splice(p, 1);
        console.log(`  [${kstISO(tickTs).slice(11, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }

    // Signal (F6 base)
    for (const market of F6V7_COINS) {
      const bars = barsByMarket.get(market);
      if (!bars || bars.length < F6V7_LOOKBACK_BARS + 3) continue;
      let confirmedIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + FOUR_H_MS <= tickTs) { confirmedIdx = i; break; } }
      if (confirmedIdx < F6V7_LOOKBACK_BARS + 1) continue;
      const result = evaluateF6v5Signal(bars.slice(0, confirmedIdx + 1));
      if (result.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: result.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);

    // Entry — 다음 4h bar open
    let newEntries = 0;
    for (const sig of pending) {
      if (state.positions.length >= F6V7_MAX_CONCURRENT) break;
      if (state.positions.some(p => p.market === sig.market)) continue;
      const bars = barsByMarket.get(sig.market)!;
      const entryBar = bars[bars.findIndex(b => b.ts === sig.ts) + 1];
      if (!entryBar) continue;
      const entryPrice = entryBar.open * (1 + F6V7_SLIPPAGE);
      const cashToUse = state.cash * F6V7_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - F6V7_FEE) / entryPrice;
      state.cash -= cashToUse;
      state.positions.push({
        market: sig.market, entryTs: entryBar.ts, entryDate: kstISO(entryBar.ts),
        entryPrice, vol, cashUsed: cashToUse, entryBarsRemaining: F6V7_MAX_BARS,
      });
      newEntries++;
      console.log(`  [${kstISO(tickTs).slice(11, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
    }

    state.lastTickTs = tickTs;
    state.lastTickAt = new Date(tickTs).toISOString();
    fs.appendFileSync(F6V7_TICKS_FILE, JSON.stringify({
      ts: tickTs, tickAt: kstISO(tickTs),
      signalsCount: pending.length, newEntries, exits: exits.length,
      openPositions: state.positions.length, cash: state.cash, backfilled: true,
    }) + '\n');
  }

  fs.writeFileSync(F6V7_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[F6_v7] backfill 완료: ${state.positions.length} open, cash ${state.cash.toFixed(0)}, total trades ${state.totalTrades}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
