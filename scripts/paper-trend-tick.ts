#!/usr/bin/env tsx
/**
 * 일봉 추세추종 계열(BTC_TREND · BTC_ENS · ETH_TREND) paper tick — 매일 KST 09:02 (`2 9 * * *`).
 *
 * 스스로 결손을 메운다: 마지막 처리 이후 지나간 일 tick(UTC 00:02 격자)을 차례로 재생한다.
 *   지난 날 = 그날 일봉 시가로 체결(lookahead-safe, ticks 에 backfilled 표시), 오늘 = 현재가로 체결.
 * 규칙은 src/lib/paper-trend-store.ts.
 */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  TREND_VARIANTS, TREND_TICK_MINUTE, trendFiles, withTrendState, trendTarget, rebalanceTrend,
} from '@/lib/paper-trend-store';

const DAY = 86400_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

(async () => {
  const now = Date.now();
  console.log(`\n=== trend family paper tick @ ${kstISO(now).slice(0, 19)} ===`);
  const daysBy = new Map<string, { ts: number; open: number; close: number }[]>();
  for (const m of [...new Set(TREND_VARIANTS.map((v) => v.market))]) {
    const raw = await getUpbitClient().getCandlesDays(m, 200);
    const older = await getUpbitClient().getCandlesDays(m, 100, (raw[raw.length - 1] as any).candle_date_time_utc);
    const seen = new Set<number>();
    daysBy.set(m, [...raw, ...older]
      .map((x: any) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, close: x.trade_price }))
      .filter((d) => (seen.has(d.ts) ? false : (seen.add(d.ts), true)))
      .sort((a, b) => a.ts - b.ts));
    await new Promise((r) => setTimeout(r, 300));
  }
  const tk = await getUpbitClient().getTicker([...daysBy.keys()]);
  const live = new Map((tk as any[]).map((t) => [t.market, t.trade_price as number]));

  for (const v of TREND_VARIANTS) {
    await withTrendState(v, async (st) => {
      const days = daysBy.get(v.market)!;
      const todaySlot = Math.floor(now / DAY) * DAY + TREND_TICK_MINUTE * 60_000;
      // 처리할 슬롯: lastTickTs 이후의 격자 슬롯들 (첫 실행이면 오늘 슬롯만)
      const slots: number[] = [];
      if (st.lastTickTs == null) { if (now >= todaySlot) slots.push(todaySlot); }
      else { let c = Math.floor(st.lastTickTs / DAY) * DAY + TREND_TICK_MINUTE * 60_000; while (c <= st.lastTickTs) c += DAY; while (c <= now) { slots.push(c); c += DAY; } }
      for (const t of slots) {
        const done = days.filter((d) => d.ts + DAY <= t);
        const sig = trendTarget(v, done.map((d) => d.close));
        if (!sig) { console.log(`[${v.id}] 일봉 부족`); continue; }
        const isToday = t === todaySlot && now - t < 6 * 3600_000;
        const dayBar = days.find((d) => d.ts <= t && t < d.ts + DAY);
        const px = isToday ? (live.get(v.market) ?? dayBar?.open) : dayBar?.open;
        if (px == null) continue;
        const { action, trade } = rebalanceTrend(v, st, sig.w, px, isToday ? now : dayBar!.ts, kstISO, new Date(isToday ? now : t).toISOString());
        if (trade) fs.appendFileSync(trendFiles(v).trades, JSON.stringify(trade) + '\n');
        st.lastTickTs = isToday ? now : t; st.lastTickAt = new Date(st.lastTickTs).toISOString();
        fs.appendFileSync(trendFiles(v).ticks, JSON.stringify({
          ts: st.lastTickTs, tickAt: kstISO(st.lastTickTs), close: sig.close, target: sig.w, detail: sig.detail, action,
          newEntries: action.startsWith('BUY') ? 1 : 0, exits: action.startsWith('SELL') ? 1 : 0,
          openPositions: st.positions.length, cash: st.cash, ...(isToday ? {} : { backfilled: true }),
        }) + '\n');
        console.log(`[${v.id}] ${kstISO(t).slice(0, 10)} ${sig.detail} → 목표 ${(100 * sig.w).toFixed(0)}% · ${action}${isToday ? '' : ' (재생)'}`);
      }
    });
  }
  process.exit(0);
})().catch((e) => { console.error('[trend tick FAIL]', e); process.exit(1); });
