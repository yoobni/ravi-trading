#!/usr/bin/env tsx
/**
 * BTC_TREND backfill — lastTickTs 이후 놓친 일 tick(KST 09:02)을 재생. 체결가 = 그날 일봉 시가(lookahead-safe).
 */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  BT_STATE_FILE, BT_TRADES_FILE, BT_TICKS_FILE, BT_MARKET, BT_FEE, BT_SLIPPAGE, BT_POSITION_PCT, BT_SMA_DAYS, BT_TICK_MINUTE,
  readBtState, btWantLong,
} from '@/lib/paper-btctrend-store';

const DAY = 86400_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

(async () => {
  const st = readBtState();
  if (!st?.lastTickTs) { console.log('  → no backfill needed'); process.exit(0); }
  const now = Date.now();
  // 격자: UTC 00:02 (= KST 09:02)
  let c = Math.floor(st.lastTickTs / DAY) * DAY + BT_TICK_MINUTE * 60_000;
  while (c <= st.lastTickTs) c += DAY;
  const pts: number[] = [];
  while (c < now) { pts.push(c); c += DAY; }
  console.log(`[BTC_TREND] ${pts.length} ticks to backfill`);
  if (!pts.length) { console.log('  → no backfill needed'); process.exit(0); }

  const days = (await getUpbitClient().getCandlesDays(BT_MARKET, 200)).slice().reverse()
    .map((x: any) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, close: x.trade_price }));
  for (const t of pts) {
    const done = days.filter((d) => d.ts + DAY <= t);
    const today = days.find((d) => d.ts <= t && t < d.ts + DAY);
    const sig = btWantLong(done.map((d) => d.close));
    if (!sig || !today) continue;
    const pos = st.positions[0];
    let action = 'HOLD';
    if (sig.want && !pos) {
      const used = st.cash * BT_POSITION_PCT; const ep = today.open * (1 + BT_SLIPPAGE);
      st.cash -= used;
      st.positions.push({ market: BT_MARKET, entryTs: today.ts, entryDate: kstISO(today.ts), entryPrice: ep, vol: used * (1 - BT_FEE) / ep, cashUsed: used, entryBarsRemaining: 0 });
      action = 'BUY';
    } else if (!sig.want && pos) {
      const xp = today.open * (1 - BT_SLIPPAGE); const got = pos.vol * xp * (1 - BT_FEE); const profitKrw = got - pos.cashUsed;
      st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw; st.positions = [];
      fs.appendFileSync(BT_TRADES_FILE, JSON.stringify({
        market: BT_MARKET, entryTs: pos.entryTs, exitTs: today.ts, entryDate: pos.entryDate, exitDate: kstISO(today.ts),
        entryPrice: pos.entryPrice, exitPrice: xp, profitRate: (xp - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
        reason: 'TREND_OFF', recordedAt: new Date(t).toISOString(),
      }) + '\n');
      action = 'SELL';
    }
    st.lastTickTs = t; st.lastTickAt = new Date(t).toISOString();
    fs.appendFileSync(BT_TICKS_FILE, JSON.stringify({ ts: t, tickAt: kstISO(t), close: sig.close, sma: sig.sma, want: sig.want, action,
      newEntries: action === 'BUY' ? 1 : 0, exits: action === 'SELL' ? 1 : 0, openPositions: st.positions.length, cash: st.cash, backfilled: true }) + '\n');
    console.log(`  [${kstISO(t).slice(0, 10)}] ${sig.want ? '보유' : '현금'} ${action}`);
  }
  fs.writeFileSync(BT_STATE_FILE, JSON.stringify(st, null, 2));
  console.log(`[BTC_TREND] backfill 완료: ${st.positions.length} open, cash ${st.cash.toFixed(0)}, total trades ${st.totalTrades}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
