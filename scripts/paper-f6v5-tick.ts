#!/usr/bin/env tsx
/**
 * F6_v5 (TRAIL) paper trading tick.
 *
 * Cron: 매 4h KST (0,4,8,12,16,20시) +5분 (F6=+1, v2=+2, v3=+3와 분리; v4 제거로 +5 사용).
 *
 * F6 동일 신호(evaluateF6v5Signal)·사이징(33%×3). exit만 트레일링(evalTrailExit).
 */
import 'dotenv/config';
import { ensureNoGap } from '@/lib/paper-gap-guard';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F6V5_COINS, F6V5_FEE, F6V5_SLIPPAGE, F6V5_MAX_BARS,
  F6V5_POSITION_PCT, F6V5_MAX_CONCURRENT, F6V5_LOOKBACK_BARS,
  evaluateF6v5Signal, evalTrailExit, type BarLite,
  withF6V5State, appendF6V5Trade, appendF6V5Tick,
  type F6V5Position, type F6V5ClosedTrade,
  F6V5_STATE_FILE,
} from '@/lib/paper-f6v5-store';

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
  console.log(`\n=== F6_v5 paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  // 결손 자동 복구: 포인터가 뒤에 있는 지금(= tick 이 쓰기 전)이 되감기 없이 채울 수 있는 유일한 타이밍
  ensureNoGap('F6_v5', F6V5_STATE_FILE, 4 * 3600_000, 'paper-f6v5-backfill.ts');

  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F6V5_COINS) {
    try {
      barsByMarket.set(market, await fetchBars(market, 200));
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
        // ── 실행 현실성 기록 (정산에는 쓰지 않는다) ──
        // 페이퍼는 exitPrice(스톱/목표 '가격')로 정산한다. 그 가격에 실제로 팔려면
        // 거래소에 스톱 주문이 걸려 있어야 한다. 크론은 4시간에 한 번 돌기 때문에,
        // 주문을 안 걸어두면 실제 체결은 "지금 이 순간 시장가"에 가깝다.
        // 두 값을 함께 남겨 격차를 계속 측정한다 — 실거래 설계 결정의 근거가 된다.
        let exitPriceMarket: number | null = null;
        try {
          const tkx = await getUpbitClient().getTicker([pos.market]);
          if (tkx[0]) exitPriceMarket = (tkx[0] as any).trade_price * (1 - F6V5_SLIPPAGE);
        } catch { /* 시세 조회 실패 시 null — 정산에는 영향 없다 */ }
        const cashGained = pos.vol * exitPrice * (1 - F6V5_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained;
        state.totalRealizedPnl += profitKrw;
        state.totalTrades += 1;
        const closed: F6V5ClosedTrade = {
          market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice, exitPriceMarket, profitRate, profitKrw,
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
