#!/usr/bin/env tsx
/**
 * F7 계열 backfill — 각 변형의 lastTickTs 이후 ~ 현재까지 크론이 돌았던 것처럼 시뮬.
 * 진입가는 신호봉 다음 4h 봉 시가(lookahead-safe). TP 는 목표가, SL·TIME 은 그 봉 종가(슬리피지 적용).
 * 격자는 라이브 크론과 같은 4h 봉마감 정각(KST 01/05/09/13/17/21시).
 */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F7_VARIANTS, F7_COINS, F7_FEE, F7_SLIPPAGE, F7_POSITION_PCT, F7_MAX_CONCURRENT, F7_LOOKBACK_BARS,
  evaluateF7Signal, evalF7Exit, btcBelowSma, f7FillPrice, f7Files, readF7State, type BarLite,
} from '@/lib/paper-f7-store';

const FOUR_H_MS = 4 * 3600_000;
// 라이브 크론과 같은 격자: 4h 봉마감 정각(KST 01/05/09/13/17/21). 봉마감 직후 판단이 핵심이다(_bt_synth.ts lag).
const GRID_OFFSET = 0;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

async function fetchBars(market: string, count = 400): Promise<BarLite[]> {
  // Upbit 요청당 200봉 상한 → to 파라미터로 페이지네이션.
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
      ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
      open: (c as any).opening_price, high: (c as any).high_price,
      low: (c as any).low_price, close: (c as any).trade_price,
      volume: (c as any).candle_acc_trade_volume,
    }))
    .filter(b => (seen.has(b.ts) ? false : (seen.add(b.ts), true)))
    .sort((a, b) => a.ts - b.ts);
}

(async () => {
  console.log('=== Paper F7 family backfill ===');
  const now = Date.now();
  const work = F7_VARIANTS
    .map(v => ({ v, state: readF7State(v) }))
    .filter((x): x is { v: typeof x.v; state: NonNullable<typeof x.state> } => !!x.state && !!x.state.lastTickTs);
  // 마지막 tick 이후 지나간 격자 슬롯이 하나라도 있으면 대상 — 간격(4h)이 아니라 격자로 판단한다
  //   (크론 시각을 옮긴 직후처럼 4h 가 안 지났어도 봉마감 슬롯을 건너뛴 경우가 있다).
  const slotsAfter = (from: number) => {
    let c = Math.floor((from - GRID_OFFSET) / FOUR_H_MS) * FOUR_H_MS + GRID_OFFSET;
    while (c <= from) c += FOUR_H_MS;
    const out: number[] = [];
    while (c < now) { out.push(c); c += FOUR_H_MS; }
    return out;
  };
  const due = work.filter(x => slotsAfter(x.state.lastTickTs!).length > 0);
  if (!due.length) { console.log('  → no backfill needed'); process.exit(0); }

  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F7_COINS) {
    try { barsByMarket.set(market, await fetchBars(market, market === 'KRW-BTC' ? 800 : 400)); process.stdout.write('.'); await new Promise(r => setTimeout(r, 150)); }
    catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n${barsByMarket.size}/${F7_COINS.length} markets`);

  for (const { v, state } of due) {
    const files = f7Files(v);
    const startTs = state.lastTickTs!;
    const tickPoints = slotsAfter(startTs);
    console.log(`\n[${v.id}] ${kstISO(startTs)} → ${kstISO(now)}: ${tickPoints.length} ticks to backfill`);

    for (const tickTs of tickPoints) {
      let exits = 0;
      for (let p = state.positions.length - 1; p >= 0; p--) {
        const pos = state.positions[p];
        const bars = barsByMarket.get(pos.market);
        if (!bars) continue;
        const confirmed = bars.filter(b => b.ts + FOUR_H_MS <= tickTs && b.ts > pos.entryTs);
        const exit = evalF7Exit(v, confirmed, pos.entryPrice);
        if (!exit) continue;
        const exitPrice = f7FillPrice(exit.reason, exit.price);
        const cashGained = pos.vol * exitPrice * (1 - F7_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained; state.totalRealizedPnl += profitKrw; state.totalTrades += 1;
        fs.appendFileSync(files.trades, JSON.stringify({
          market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice, profitRate, profitKrw,
          reason: exit.reason, recordedAt: new Date(tickTs).toISOString(),
        }) + '\n');
        state.positions.splice(p, 1);
        exits++;
        console.log(`  [${kstISO(tickTs).slice(5, 16)}] exit ${pos.market} ${exit.reason} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }

      const pending: { market: string; ts: number }[] = [];
      for (const market of F7_COINS) {
        const bars = barsByMarket.get(market);
        if (!bars || bars.length < F7_LOOKBACK_BARS + 3) continue;
        let confirmedIdx = -1;
        for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + FOUR_H_MS <= tickTs) { confirmedIdx = i; break; } }
        if (confirmedIdx < F7_LOOKBACK_BARS + 1) continue;
        if (evaluateF7Signal(bars.slice(0, confirmedIdx + 1)).hit) pending.push({ market, ts: bars[confirmedIdx].ts });
      }
      pending.sort((a, b) => a.ts - b.ts);

      // F7_btc: 이 tick 에서 확정된 마지막 BTC 봉이 50일선 아래면 신규 진입 중단
      const btc = barsByMarket.get('KRW-BTC') || [];
      let bi = -1;
      for (let i = btc.length - 1; i >= 0; i--) { if (btc[i].ts + FOUR_H_MS <= tickTs) { bi = i; break; } }
      const btcOff = bi >= 0 && btcBelowSma(btc, bi);

      let entries = 0;
      for (const sig of (v.btc50 && btcOff ? [] : pending)) {
        if (state.positions.length >= F7_MAX_CONCURRENT) break;
        if (state.positions.some(p => p.market === sig.market)) continue;
        const bars = barsByMarket.get(sig.market)!;
        const entryBar = bars[bars.findIndex(b => b.ts === sig.ts) + 1];
        if (!entryBar) continue;
        const entryPrice = entryBar.open * (1 + F7_SLIPPAGE);
        const cashToUse = state.cash * F7_POSITION_PCT;
        if (cashToUse < 5000) continue;
        state.cash -= cashToUse;
        state.positions.push({
          market: sig.market, entryTs: entryBar.ts, entryDate: kstISO(entryBar.ts), entryPrice,
          vol: cashToUse * (1 - F7_FEE) / entryPrice, cashUsed: cashToUse, entryBarsRemaining: v.maxBars,
        });
        entries++;
        console.log(`  [${kstISO(tickTs).slice(5, 16)}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)}`);
      }

      state.lastTickTs = tickTs;
      state.lastTickAt = new Date(tickTs).toISOString();
      fs.appendFileSync(files.ticks, JSON.stringify({
        ts: tickTs, tickAt: kstISO(tickTs),
        signalsCount: pending.length, newEntries: entries, exits, ...(v.btc50 ? { btcOff } : {}),
        openPositions: state.positions.length, cash: state.cash, backfilled: true,
      }) + '\n');
    }
    fs.writeFileSync(files.state, JSON.stringify(state, null, 2));
    console.log(`[${v.id}] backfill 완료: ${state.positions.length} open, cash ${state.cash.toFixed(0)}, total trades ${state.totalTrades}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
