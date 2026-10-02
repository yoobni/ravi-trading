#!/usr/bin/env tsx
/**
 * BTC_TREND paper tick — 하루 1회. Cron: KST 09:02 (2 9 * * *). 규칙은 src/lib/paper-btctrend-store.ts.
 */
import 'dotenv/config';
import fs from 'fs';
import { ensureNoGap } from '@/lib/paper-gap-guard';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  BT_STATE_FILE, BT_TRADES_FILE, BT_TICKS_FILE, BT_MARKET, BT_FEE, BT_SLIPPAGE, BT_POSITION_PCT, BT_SMA_DAYS,
  withBtState, btWantLong,
} from '@/lib/paper-btctrend-store';

const DAY = 86400_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

(async () => {
  const now = Date.now();
  console.log(`\n=== BTC_TREND paper tick @ ${kstISO(now).slice(0, 19)} ===`);
  ensureNoGap('BTC_TREND', BT_STATE_FILE, DAY, 'paper-btctrend-backfill.ts');

  const days = (await getUpbitClient().getCandlesDays(BT_MARKET, BT_SMA_DAYS + 20)).slice().reverse();
  // 확정 일봉만: 시작(UTC) + 24h 가 지난 봉
  const done = days.filter((c: any) => new Date(c.candle_date_time_utc + 'Z').getTime() + DAY <= now);
  const sig = btWantLong(done.map((c: any) => c.trade_price));
  if (!sig) { console.log('일봉 부족 — skip'); process.exit(0); }
  const tk = await getUpbitClient().getTicker([BT_MARKET]);
  const px = (tk[0] as any)?.trade_price ?? sig.close;

  await withBtState(async (st) => {
    let action = 'HOLD';
    const pos = st.positions[0];
    if (sig.want && !pos) {
      const used = st.cash * BT_POSITION_PCT;
      const ep = px * (1 + BT_SLIPPAGE);
      st.cash -= used;
      st.positions.push({ market: BT_MARKET, entryTs: now, entryDate: kstISO(now), entryPrice: ep, vol: used * (1 - BT_FEE) / ep, cashUsed: used, entryBarsRemaining: 0 });
      action = 'BUY';
    } else if (!sig.want && pos) {
      const xp = px * (1 - BT_SLIPPAGE);
      const got = pos.vol * xp * (1 - BT_FEE);
      const profitKrw = got - pos.cashUsed;
      st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw; st.positions = [];
      fs.appendFileSync(BT_TRADES_FILE, JSON.stringify({
        market: BT_MARKET, entryTs: pos.entryTs, exitTs: now, entryDate: pos.entryDate, exitDate: kstISO(now),
        entryPrice: pos.entryPrice, exitPrice: xp, profitRate: (xp - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
        reason: 'TREND_OFF', recordedAt: new Date().toISOString(),
      }) + '\n');
      action = 'SELL';
    }
    st.lastTickTs = now; st.lastTickAt = new Date().toISOString();
    fs.appendFileSync(BT_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kstISO(now), close: sig.close, sma: sig.sma, want: sig.want, action,
      newEntries: action === 'BUY' ? 1 : 0, exits: action === 'SELL' ? 1 : 0, openPositions: st.positions.length, cash: st.cash,
    }) + '\n');
    console.log(`[BTC_TREND] close ${sig.close} vs SMA${BT_SMA_DAYS} ${sig.sma.toFixed(0)} → ${sig.want ? '보유' : '현금'} · ${action}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[BTC_TREND tick FAIL]', e); process.exit(1); });
