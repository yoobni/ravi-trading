#!/usr/bin/env tsx
/**
 * BTC_DIP paper tick — 4h 봉마감 +4분 (`4 1,5,9,13,17,21 * * *`). 규칙은 src/lib/paper-btcdip-store.ts.
 * 마지막 처리 이후의 KRW-BTC 15분 확정봉을 차례로 재생한다(스스로 결손을 메움, 최대 ~100시간).
 */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  BD_MARKET, BD_TRADES_FILE, BD_TICKS_FILE, BD_FEE, BD_SLIP, BD_DIP_PCT, BD_TP_PCT, BD_PEN, BD_HOLD_MS, withBdState,
} from '@/lib/paper-btcdip-store';

const Q = 15 * 60_000, FOUR = 4 * 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

(async () => {
  const now = Date.now();
  const raw: any[] = []; let to: string | undefined;
  for (let p = 0; p < 2; p++) { const page = await getUpbitClient().getCandlesMinutes(15, BD_MARKET, 200, to); if (!page.length) break; raw.push(...page); to = (page[page.length - 1] as any).candle_date_time_utc; }
  const seen = new Set<number>();
  const bars = raw.map((x) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price }))
    .filter((b) => b.ts + Q <= now && (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);

  await withBdState(async (st) => {
    let fills = 0, exits = 0;
    // 첫 실행: 지금 시점부터 시작(과거를 재생하지 않음)
    if (st.lastBarTs == null) { const last = bars[bars.length - 1]; st.lastBarTs = last.ts; st.lastClose = last.close; }
    for (const b of bars) {
      if (b.ts <= st.lastBarTs!) continue;
      const pos = st.positions[0];
      if (pos) {
        const tgt = pos.entryPrice * (1 + BD_TP_PCT / 100);
        let px = 0, reason = '';
        if (b.ts > pos.entryTs && b.high >= tgt * (1 + BD_PEN)) { px = tgt; reason = 'TP'; }
        else if (b.ts - pos.entryTs >= BD_HOLD_MS) { px = b.open * (1 - BD_SLIP); reason = 'TIME'; }
        if (px) {
          const got = pos.vol * px * (1 - BD_FEE); const profitKrw = got - pos.cashUsed;
          st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw; st.positions = [];
          fs.appendFileSync(BD_TRADES_FILE, JSON.stringify({
            market: BD_MARKET, entryTs: pos.entryTs, exitTs: b.ts, entryDate: pos.entryDate, exitDate: kstISO(b.ts),
            entryPrice: pos.entryPrice, exitPrice: px, profitRate: (px - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
            reason, recordedAt: new Date().toISOString(),
          }) + '\n');
          exits++; console.log(`[BTC_DIP] ${kstISO(b.ts).slice(5, 16)} ${reason} ${((px / pos.entryPrice - 1) * 100).toFixed(2)}% pnl=${profitKrw.toFixed(0)}`);
        }
      } else {
        if (b.ts % FOUR === 0 && st.lastClose) st.order = { lim: st.lastClose * (1 - BD_DIP_PCT / 100), until: b.ts + FOUR };
        if (st.order && b.ts < st.order.until && b.low <= st.order.lim * (1 - BD_PEN) && st.cash > 5000) {
          const ep = st.order.lim; const used = st.cash;
          st.cash = 0;
          st.positions.push({ market: BD_MARKET, entryTs: b.ts, entryDate: kstISO(b.ts), entryPrice: ep, vol: used * (1 - BD_FEE) / ep, cashUsed: used, entryBarsRemaining: 0 });
          st.order = null; fills++;
          console.log(`[BTC_DIP] ${kstISO(b.ts).slice(5, 16)} 지정가 체결 @${ep.toFixed(0)} (TP ${(ep * (1 + BD_TP_PCT / 100)).toFixed(0)})`);
        }
      }
      st.lastBarTs = b.ts; st.lastClose = b.close;
    }
    if (st.order && st.order.until <= now) st.order = null;
    st.lastTickTs = now; st.lastTickAt = new Date(now).toISOString();
    fs.appendFileSync(BD_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kstISO(now), order: st.order, newEntries: fills, exits, openPositions: st.positions.length, cash: st.cash,
    }) + '\n');
    console.log(`[BTC_DIP] ${kstISO(now).slice(5, 16)} 대기 주문 ${st.order ? st.order.lim.toFixed(0) : '없음'} · 보유 ${st.positions.length}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[BTC_DIP tick FAIL]', e); process.exit(1); });
