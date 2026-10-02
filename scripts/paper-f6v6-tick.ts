#!/usr/bin/env tsx
/**
 * F6_v6 (TRAIL 12h) paper trading tick.
 * Cron: KST 09시·21시 정각 (+60초 지연, 12h UTC창 마감 직후). 4h fetch → 12h 합성 → F6 신호 + 트레일.
 */
import 'dotenv/config';
import { ensureNoGap } from '@/lib/paper-gap-guard';
import { isWarningBlocked } from '@/lib/paper-warning';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V6_COINS, F6V6_FEE, F6V6_SLIPPAGE, F6V6_MAX_BARS, F6V6_TF_HOURS,
  F6V6_POSITION_PCT, F6V6_MAX_CONCURRENT, F6V6_LOOKBACK_BARS,
  aggregate12h, evaluateF6v6Signal, evalTrailExit, type BarLite,
  withF6V6State, appendF6V6Trade, appendF6V6Tick,
  type F6V6Position, type F6V6ClosedTrade,
  F6V6_STATE_FILE,
} from '@/lib/paper-f6v6-store';

const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();
async function fetch4h(market: string, count = 150): Promise<BarLite[]> {
  const candles = await getUpbitClient().getCandlesMinutes(240, market, count);
  return candles.slice().reverse().map(c => ({
    // 시각 규약: ts 는 UTC ms. data/candle-cache 도 같은 UTC ms 라 섞어 써도 된다.
    //   (캐시는 candle_date_time_kst 를 로컬 TZ=Asia/Seoul 로 파싱해 같은 값이 된다)
    //   화면·기록 표시는 kstISO() 로 +9h 한다 — 계산에 그 값을 쓰지 말 것.
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price, high: (c as any).high_price,
    low: (c as any).low_price, close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
}
interface PendingSignal { market: string; ts: number; volZ: number; }

(async () => {
  const now = Date.now();
  console.log(`\n=== F6_v6 (12h) paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  // 결손 자동 복구: 포인터가 뒤에 있는 지금(= tick 이 쓰기 전)이 되감기 없이 채울 수 있는 유일한 타이밍
  ensureNoGap('F6_v6', F6V6_STATE_FILE, 12 * 3600_000, 'paper-f6v6-backfill.ts');
  const bars12 = new Map<string, BarLite[]>();
  for (const market of F6V6_COINS) {
    try { bars12.set(market, aggregate12h(await fetch4h(market, 150))); process.stdout.write('.'); await new Promise(r => setTimeout(r, 150)); }
    catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n[fetch] ${bars12.size}/${F6V6_COINS.length} markets (12h 합성)`);

  await withF6V6State(async (state) => {
    const WIN = F6V6_TF_HOURS * 3600_000;
    const exitsThisTick: F6V6ClosedTrade[] = [];
    for (let p = state.positions.length - 1; p >= 0; p--) {
      const pos = state.positions[p];
      const bars = bars12.get(pos.market);
      if (!bars || bars.length < 2) continue;
      const confirmedBars = bars.filter(b => b.ts + WIN <= now && b.ts > pos.entryTs);
      const exit = evalTrailExit(confirmedBars, pos.entryPrice);
      if (exit) {
        const exitPrice = exit.price * (1 - F6V6_SLIPPAGE);
        // ── 실행 현실성 기록 (정산에는 쓰지 않는다) ──
        // 페이퍼는 exitPrice(스톱/목표 '가격')로 정산한다. 그 가격에 실제로 팔려면
        // 거래소에 스톱 주문이 걸려 있어야 한다. 크론은 4시간에 한 번 돌기 때문에,
        // 주문을 안 걸어두면 실제 체결은 "지금 이 순간 시장가"에 가깝다.
        // 두 값을 함께 남겨 격차를 계속 측정한다 — 실거래 설계 결정의 근거가 된다.
        let exitPriceMarket: number | null = null;
        try {
          const tkx = await getUpbitClient().getTicker([pos.market]);
          if (tkx[0]) exitPriceMarket = (tkx[0] as any).trade_price * (1 - F6V6_SLIPPAGE);
        } catch { /* 시세 조회 실패 시 null — 정산에는 영향 없다 */ }
        const cashGained = pos.vol * exitPrice * (1 - F6V6_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained; state.totalRealizedPnl += profitKrw; state.totalTrades += 1;
        const closed: F6V6ClosedTrade = { market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts, entryDate: pos.entryDate, exitDate: kstISO(exit.ts), entryPrice: pos.entryPrice, exitPrice, exitPriceMarket, profitRate, profitKrw, reason: exit.reason, recordedAt: new Date().toISOString() };
        exitsThisTick.push(closed); appendF6V6Trade(closed); state.positions.splice(p, 1);
        console.log(`[exit] ${pos.market} ${exit.reason} @${exitPrice.toFixed(2)} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }
    }
    const pending: PendingSignal[] = [];
    for (const market of F6V6_COINS) {
      const bars = bars12.get(market);
      if (!bars || bars.length < F6V6_LOOKBACK_BARS + 3) continue;
      // 마지막 완성 12h봉 = 확정 신호봉
      let ci = -1;
      for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + WIN <= now) { ci = i; break; } }
      if (ci < F6V6_LOOKBACK_BARS + 1) continue;
      const r = evaluateF6v6Signal(bars.slice(0, ci + 1));
      if (r.hit) pending.push({ market, ts: bars[ci].ts, volZ: r.volZ! });
    }
    pending.sort((a, b) => a.ts - b.ts);
    const newEntries: F6V6Position[] = [];
    for (const sig of pending) {
      if (state.positions.length >= F6V6_MAX_CONCURRENT) break;
      if (isWarningBlocked(sig.market)) { console.log(`[warning] ${sig.market} 유의 공지로 진입 차단`); continue; }
      if (state.positions.some(p => p.market === sig.market)) continue;
      const bars = bars12.get(sig.market)!;
      let entryRaw = bars[bars.length - 1].close;
      try { const tk = await getUpbitClient().getTicker([sig.market]); if (tk[0]) entryRaw = (tk[0] as any).trade_price; } catch { /* fallback */ }
      const entryPrice = entryRaw * (1 + F6V6_SLIPPAGE);
      const cashToUse = state.cash * F6V6_POSITION_PCT;
      if (cashToUse < 5000) continue;
      const vol = cashToUse * (1 - F6V6_FEE) / entryPrice;
      state.cash -= cashToUse;
      const pos: F6V6Position = { market: sig.market, entryTs: now, entryDate: kstISO(now), entryPrice, vol, cashUsed: cashToUse, entryBarsRemaining: F6V6_MAX_BARS };
      state.positions.push(pos); newEntries.push(pos);
      console.log(`[entry] ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)} volZ=${sig.volZ.toFixed(2)}`);
    }
    state.lastTickTs = now; state.lastTickAt = new Date().toISOString();
    appendF6V6Tick({ ts: now, tickAt: kstISO(now), signalsCount: pending.length, newEntries: newEntries.length, exits: exitsThisTick.length, openPositions: state.positions.length, cash: state.cash });
    console.log(`\n[summary] signals=${pending.length}, entries=${newEntries.length}, exits=${exitsThisTick.length}, open=${state.positions.length}, cash=${state.cash.toFixed(0)}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[F6_v6 12h tick FAIL]', e); process.exit(1); });
