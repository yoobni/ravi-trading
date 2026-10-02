#!/usr/bin/env tsx
/**
 * F7 계열(F7 · F7_sl · F7_p) paper trading tick — 세 변형을 한 번의 시세 조회로 함께 처리한다.
 *
 * Cron: 4h 봉마감 정각 KST 01/05/09/13/17/21시 (+30초 지연 — F6 와 시세 API 호출이 겹치지 않게). 규칙은 src/lib/paper-f7-store.ts 참고.
 *
 * 라이브 체결:
 *   TP   — 목표가(지정가가 걸려 있었다고 본다)
 *   SL·TIME — 지금 이 순간 시장가(슬리피지 적용). 시세 조회 실패 시 봉 종가.
 */
import 'dotenv/config';
import { ensureNoGap } from '@/lib/paper-gap-guard';
import { isWarningBlocked } from '@/lib/paper-warning';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  F7_VARIANTS, F7_COINS, F7_FEE, F7_SLIPPAGE, F7_POSITION_PCT, F7_MAX_CONCURRENT, F7_LOOKBACK_BARS,
  evaluateF7Signal, evalF7Exit, btcBelowSma, F7_BTC_SMA_BARS, f7FillPrice, f7Files, withF7State, appendF7Trade, appendF7Tick,
  type BarLite, type F7Position, type F7ClosedTrade,
} from '@/lib/paper-f7-store';

const FOUR_H_MS = 4 * 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

// 신호 lookback 42 + 시간청산 최대 18봉 → 200봉이면 넉넉하다 (요청당 상한 200).
async function fetchBars(market: string, count = 200): Promise<BarLite[]> {
  // 요청당 200봉 상한 — BTC 50일선(300봉)용으로 더 필요하면 to 로 이어 받는다.
  const candles: any[] = [];
  let to: string | undefined;
  while (candles.length < count) {
    const page = await getUpbitClient().getCandlesMinutes(240, market, Math.min(200, count - candles.length), to);
    if (!page.length) break;
    candles.push(...page);
    to = (page[page.length - 1] as any).candle_date_time_utc;
    if (page.length < 200) break;
  }
  return candles.slice().reverse().map(c => ({
    // 시각 규약: ts 는 UTC ms. 표시는 kstISO() 로 +9h.
    ts: new Date((c as any).candle_date_time_utc + 'Z').getTime(),
    open: (c as any).opening_price, high: (c as any).high_price,
    low: (c as any).low_price, close: (c as any).trade_price,
    volume: (c as any).candle_acc_trade_volume,
  }));
}

async function tickerPrice(market: string): Promise<number | null> {
  try { const tk = await getUpbitClient().getTicker([market]); return tk[0] ? (tk[0] as any).trade_price : null; }
  catch { return null; }
}

(async () => {
  const now = Date.now();
  console.log(`\n=== F7 family paper tick @ ${kstISO(now).slice(0, 19)} ===\n`);

  // 결손 자동 복구 — 백필 스크립트가 세 변형을 각자의 lastTickTs 부터 채운다. 첫 호출이 다 메우면 나머지는 통과.
  for (const v of F7_VARIANTS) ensureNoGap(v.id, f7Files(v).state, FOUR_H_MS, 'paper-f7-backfill.ts');

  const barsByMarket = new Map<string, BarLite[]>();
  for (const market of F7_COINS) {
    try {
      barsByMarket.set(market, await fetchBars(market, market === 'KRW-BTC' ? F7_BTC_SMA_BARS + 50 : 200));
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) { console.log(`\n[fetch FAIL] ${market}: ${e?.message || e}`); }
  }
  console.log(`\n[fetch] ${barsByMarket.size}/${F7_COINS.length} markets`);

  // 신호는 세 변형이 같다 — 한 번만 계산
  const pending: { market: string; ts: number; volZ: number }[] = [];
  for (const market of F7_COINS) {
    const bars = barsByMarket.get(market);
    if (!bars || bars.length < F7_LOOKBACK_BARS + 3) continue;
    let confirmedIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts + FOUR_H_MS <= now) { confirmedIdx = i; break; } }
    if (confirmedIdx < F7_LOOKBACK_BARS + 1) continue;
    const r = evaluateF7Signal(bars.slice(0, confirmedIdx + 1));
    if (r.hit) pending.push({ market, ts: bars[confirmedIdx].ts, volZ: r.volZ! });
  }
  pending.sort((a, b) => a.ts - b.ts);

  // F7_btc 국면 판정 — 방금 확정된 BTC 4h 봉이 50일선(300봉 평균) 아래면 그 변형은 신규 진입을 쉰다
  const btc = barsByMarket.get('KRW-BTC') || [];
  let btcIdx = -1;
  for (let i = btc.length - 1; i >= 0; i--) { if (btc[i].ts + FOUR_H_MS <= now) { btcIdx = i; break; } }
  const btcOff = btcIdx >= 0 && btcBelowSma(btc, btcIdx);
  console.log(`[regime] BTC ${btcOff ? '50일선 아래 → F7_btc 신규진입 중단' : '50일선 위'} (봉 ${btc.length}개)`);

  for (const v of F7_VARIANTS) {
    await withF7State(v, async (state) => {
      // ─── Exit ───
      let exits = 0;
      for (let p = state.positions.length - 1; p >= 0; p--) {
        const pos = state.positions[p];
        const bars = barsByMarket.get(pos.market);
        if (!bars) continue;
        const confirmed = bars.filter(b => b.ts + FOUR_H_MS <= now && b.ts > pos.entryTs);
        const exit = evalF7Exit(v, confirmed, pos.entryPrice);
        if (!exit) continue;
        let exitPrice = f7FillPrice(exit.reason, exit.price);
        if (exit.reason !== 'TP') {
          const mkt = await tickerPrice(pos.market);
          if (mkt != null) exitPrice = mkt * (1 - F7_SLIPPAGE);
        }
        const cashGained = pos.vol * exitPrice * (1 - F7_FEE);
        const profitKrw = cashGained - pos.cashUsed;
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        state.cash += cashGained; state.totalRealizedPnl += profitKrw; state.totalTrades += 1;
        const closed: F7ClosedTrade = {
          market: pos.market, entryTs: pos.entryTs, exitTs: exit.ts,
          entryDate: pos.entryDate, exitDate: kstISO(exit.ts),
          entryPrice: pos.entryPrice, exitPrice, profitRate, profitKrw,
          reason: exit.reason, recordedAt: new Date().toISOString(),
        };
        appendF7Trade(v, closed);
        state.positions.splice(p, 1);
        exits++;
        console.log(`[${v.id}] exit ${pos.market} ${exit.reason} @${exitPrice.toFixed(2)} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`);
      }

      // ─── Entry (33% × max 3) ───
      let entries = 0;
      for (const sig of (v.btc50 && btcOff ? [] : pending)) {
        if (state.positions.length >= F7_MAX_CONCURRENT) break;
        if (isWarningBlocked(sig.market)) { console.log(`[warning] ${sig.market} 유의 공지로 진입 차단`); continue; }
        if (state.positions.some(p => p.market === sig.market)) continue;
        const bars = barsByMarket.get(sig.market)!;
        const raw = (await tickerPrice(sig.market)) ?? bars[bars.length - 1].close;
        const entryPrice = raw * (1 + F7_SLIPPAGE);
        const cashToUse = state.cash * F7_POSITION_PCT;
        if (cashToUse < 5000) continue;
        state.cash -= cashToUse;
        const pos: F7Position = {
          market: sig.market, entryTs: now, entryDate: kstISO(now), entryPrice,
          vol: cashToUse * (1 - F7_FEE) / entryPrice, cashUsed: cashToUse, entryBarsRemaining: v.maxBars,
        };
        state.positions.push(pos);
        entries++;
        console.log(`[${v.id}] entry ${sig.market} @${entryPrice.toFixed(2)} amount=${cashToUse.toFixed(0)} TP=${(entryPrice * (1 + v.tpPct / 100)).toFixed(2)} volZ=${sig.volZ.toFixed(2)}`);
      }

      state.lastTickTs = now;
      state.lastTickAt = new Date().toISOString();
      appendF7Tick(v, {
        ts: now, tickAt: kstISO(now),
        signalsCount: pending.length, newEntries: entries, exits, ...(v.btc50 ? { btcOff } : {}),
        openPositions: state.positions.length, cash: state.cash,
      });
      console.log(`[${v.id}] signals=${pending.length}, entries=${entries}, exits=${exits}, open=${state.positions.length}, cash=${state.cash.toFixed(0)}`);
    });
  }
  process.exit(0);
})().catch((e) => { console.error('[F7 tick FAIL]', e); process.exit(1); });
