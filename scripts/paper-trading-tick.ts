/**
 * Paper trading daily tick — KST 09:30 cron.
 *
 * 흐름 (오늘 = D, 어제 = D-1):
 *   1. evalDate = D-1 (어제 funding 8h × 3 모두 confirmed)
 *   2. 포지션 청산 체크: 어제(D-1) 일봉 high/low (entry day 이후만)
 *   3. 신호 발생 시 D 시가 (KRW-BTC 오늘 일봉 open) 에 진입
 *   4. signals / forward-returns / snapshot 기록
 *
 * 전략: FUNDING_F1F2_50 (MAIN) + FUNDING_F1F2_100 (BENCHMARK).
 *      동일 D7-C3 F1+F2 신호, 자본 비율만 다름.
 *
 * 멱등성: state.lastTickDate === today 이면 skip.
 */
import 'dotenv/config';
import axios from 'axios';
import { fetchDailyCached } from './_daily-cache';
import {
  loadThresholds,
  withState,
  appendPosition,
  appendSnapshot,
  appendSignal,
  appendForwardReturn,
  updateForwardReturn,
  loadPeaks,
  savePeaks,
  FEE,
  SLIPPAGE,
  TP_PCT,
  SL_PCT,
  MAX_DAYS,
  INITIAL_CASH_KRW,
  STRATEGIES,
  STRATEGY_SIZE_FRACTION,
  type ClosedPosition,
  type DailySnapshot,
  type StrategyMetric,
  type SignalRecord,
  type ForwardReturnRecord,
  type StrategyName,
} from '@/lib/paper-trading-store';
import {
  fetchRecentFunding,
  aggregateDaily,
  evalF1F2,
  classifyVolRegime,
  calcVol14,
} from '@/lib/paper-funding-strategy';
import { getStablecoinChange, classifyBtcTrend } from '@/lib/paper-meta-collector';

function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(later: string, earlier: string): number {
  const ms =
    new Date(later + 'T00:00:00Z').getTime() -
    new Date(earlier + 'T00:00:00Z').getTime();
  return Math.round(ms / 86400_000);
}

async function fetchBinanceSpot(): Promise<number | null> {
  try {
    const { data } = await axios.get<{ price: string }>(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { timeout: 8000 },
    );
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

(async () => {
  // PAPER_TICK_DATE 환경변수로 historical backfill 가능 (YYYY-MM-DD KST)
  const now = process.env.PAPER_TICK_DATE
    ? new Date(`${process.env.PAPER_TICK_DATE}T02:00:00.000Z`) // KST 11:00에 해당
    : new Date();
  const today = kstDate(now);
  const yesterday = kstDate(new Date(now.getTime() - 86400_000));

  console.log(`\n=== Paper Trading Tick ${today} (KST) ===`);
  console.log(`Eval date (D-1): ${yesterday}\n`);

  const thresholds = loadThresholds();

  // 1. Funding fetch
  let dailyMap: ReturnType<typeof aggregateDaily>;
  try {
    const pts = await fetchRecentFunding(40);
    dailyMap = aggregateDaily(pts);
    console.log(`[fetch] funding ${pts.length} pts / ${dailyMap.size} KST days`);
  } catch (e: any) {
    console.error(`[fetch] funding FAIL: ${e?.message ?? e}`);
    process.exit(1);
  }

  // 2. BTC daily bars
  const bars = await fetchDailyCached('KRW-BTC', 60, today);
  const barByDate = new Map(bars.map((b) => [b.date, b]));
  const todayBar = barByDate.get(today);
  const yesterdayBar = barByDate.get(yesterday);
  console.log(
    `[fetch] upbit bars ${bars.length}, today=${todayBar ? 'OK' : 'MISS'}, yesterday=${yesterdayBar ? 'OK' : 'MISS'}`,
  );

  const binancePrice = await fetchBinanceSpot();
  console.log(`[fetch] binance spot ${binancePrice ?? 'FAIL'}\n`);

  // 3. Signal eval (using yesterday)
  const ctx = { evalDate: yesterday, dailyMap, thresholds };
  const sig = evalF1F2(ctx);
  console.log(
    `[signal] F1F2=${sig.label ?? 'none'} (daily=${Number.isNaN(sig.dailyFunding) ? 'N/A' : sig.dailyFunding.toFixed(4) + '%'})\n`,
  );

  // 4. Meta (as of yesterday)
  const closesUpToYesterday = bars.filter((b) => b.date <= yesterday).map((b) => b.close);
  const vol14 = calcVol14(closesUpToYesterday);
  const volRegime = vol14 != null ? classifyVolRegime(vol14, thresholds) : null;
  const stableChange = getStablecoinChange(yesterday);
  const btcTrend = classifyBtcTrend(closesUpToYesterday);

  // funding_intensity = |funding| / max(|p10|, |p90|)
  const yFunding = dailyMap.get(yesterday)?.sum ?? null;
  const threshMax = Math.max(Math.abs(thresholds.p10_1d), Math.abs(thresholds.p90_1d));
  const fundingIntensity =
    yFunding != null && threshMax > 0 ? Math.abs(yFunding) / threshMax : null;

  // data missing
  const dataMissing: string[] = [];
  if (!todayBar) dataMissing.push('upbit_today_bar');
  if (!yesterdayBar) dataMissing.push('upbit_yesterday_bar');
  if (binancePrice == null) dataMissing.push('binance_spot');
  if (!dailyMap.get(yesterday)) dataMissing.push('funding_yesterday');
  if (vol14 == null) dataMissing.push('vol14');
  if (stableChange.c1d == null) dataMissing.push('stablecoin');

  const strategySignalLabel: DailySnapshot['strategy_signal'] = sig.label ? 'F1F2' : 'none';
  const fundingSignalState: DailySnapshot['funding_signal_state'] =
    sig.label === 'F1'
      ? 'F1_HOT'
      : sig.label === 'F2'
        ? 'F2_COLD'
        : 'NEUTRAL';

  await withState(async (state) => {
    if (state.lastTickDate === today) {
      console.log(`[skip] already ticked today (${today})`);
      return;
    }

    // (a) Settlement check — yesterday bar high/low
    if (yesterdayBar) {
      for (const sn of STRATEGIES) {
        const st = state.strategies[sn];
        if (!st.position) continue;
        const ed = st.position.entryDate;
        if (ed > yesterday) continue;
        if (ed === today) continue;

        const tp = st.position.entryPrice * (1 + TP_PCT / 100);
        const sl = st.position.entryPrice * (1 + SL_PCT / 100);
        const daysHeld = daysBetween(yesterday, ed);
        let exitPrice = 0;
        let reason: 'TP' | 'SL' | 'TIME' | null = null;
        if (yesterdayBar.low <= sl) {
          exitPrice = sl * (1 - SLIPPAGE);
          reason = 'SL';
        } else if (yesterdayBar.high >= tp) {
          exitPrice = tp * (1 - SLIPPAGE);
          reason = 'TP';
        } else if (daysHeld >= MAX_DAYS) {
          exitPrice = yesterdayBar.close * (1 - SLIPPAGE);
          reason = 'TIME';
        }

        if (reason) {
          const gross = st.position.vol * exitPrice;
          const cashGained = gross - gross * FEE;
          const profitKrw = cashGained - st.position.buyAmount * (1 + FEE);
          const profitRate = (exitPrice - st.position.entryPrice) / st.position.entryPrice * 100;

          st.cash += cashGained;
          st.totalRealizedPnl += profitKrw;
          st.totalTrades += 1;

          const closed: ClosedPosition = {
            strategy: sn,
            signal: st.position.signal,
            entryDate: ed,
            exitDate: yesterday,
            entryPrice: st.position.entryPrice,
            exitPrice,
            profitRate,
            profitKrw,
            reason,
            recordedAt: now.toISOString(),
          };
          const exitSignalId = st.position.signalId;
          st.position = null;
          await appendPosition(closed);
          await updateForwardReturn(exitSignalId, (fr) => {
            fr.return_until_exit_rule = profitRate;
            fr.exitRuleTriggered = reason;
          });
          console.log(
            `[exit] ${sn} ${reason} entry=${ed} exit=${yesterday} pnl=${profitKrw.toFixed(0)} (${profitRate.toFixed(2)}%)`,
          );
        } else {
          st.position.daysHeld = daysHeld + 1;
        }
      }
    } else {
      console.log(`[settle skip] yesterday bar missing`);
    }

    // (b) Entry — today's KRW-BTC open
    if (sig.label && todayBar) {
      const todayOpen = todayBar.open;
      for (const sn of STRATEGIES) {
        const st = state.strategies[sn];
        const signalId = `${sn}-${yesterday}-${sig.label}`;
        const signalRec: SignalRecord = {
          signalId,
          signalTime: now.toISOString(),
          signalDate: yesterday,
          strategyName: sn,
          signalLabel: sig.label,
          dailyFunding: sig.dailyFunding,
          cum3Funding: sig.cum3Funding,
          entryAllowed: !st.position,
          entryExecuted: false,
          entryDate: null,
          entryPrice: null,
          priceAtSignal: todayOpen,
          volatilityRegimeAtSignal: volRegime,
          stablecoinStateAtSignal: {
            c1d: stableChange.c1d,
            c3d: stableChange.c3d,
            c7d: stableChange.c7d,
          },
          skippedReason: st.position ? 'position_already_open' : null,
        };

        if (!st.position) {
          const entryPrice = todayOpen * (1 + SLIPPAGE);
          const buyAmount = st.cash * STRATEGY_SIZE_FRACTION[sn] * 0.995;
          if (buyAmount >= 5000) {
            const fee = buyAmount * FEE;
            if (buyAmount + fee <= st.cash) {
              const vol = buyAmount / entryPrice;
              st.cash -= buyAmount + fee;
              st.position = {
                signal: sig.label,
                signalId,
                entryDate: today,
                entryPrice,
                vol,
                buyAmount,
                daysHeld: 0,
              };
              signalRec.entryExecuted = true;
              signalRec.entryDate = today;
              signalRec.entryPrice = entryPrice;
              console.log(
                `[entry] ${sn} ${sig.label} @${entryPrice.toFixed(0)} amount=${buyAmount.toFixed(0)} (${(STRATEGY_SIZE_FRACTION[sn] * 100).toFixed(0)}%)`,
              );
            } else {
              signalRec.skippedReason = 'insufficient_cash';
            }
          } else {
            signalRec.skippedReason = 'buy_amount_below_min';
          }
        }

        await appendSignal(signalRec);

        const fr: ForwardReturnRecord = {
          signalId,
          signalTime: now.toISOString(),
          signalDate: yesterday,
          strategyName: sn,
          signalLabel: sig.label,
          priceAtSignal: todayOpen,
          return_1h: null,
          return_4h: null,
          return_1d: null,
          return_3d: null,
          return_5d: null,
          return_until_exit_rule: null,
          exitRuleTriggered: null,
          volatilityRegimeAtSignal: volRegime,
          stablecoinStateAtSignal: {
            c1d: stableChange.c1d,
            c3d: stableChange.c3d,
            c7d: stableChange.c7d,
          },
          lastUpdated: now.toISOString(),
          finalized: false,
        };
        await appendForwardReturn(fr);
      }
    }

    // (c) strategy_metrics 계산 (cumulative_return / drawdown / capital_usage_pct)
    const markPrice = todayBar?.close ?? todayBar?.open ?? 0;
    const peakTracker = loadPeaks();
    const strategyMetrics: Record<StrategyName, StrategyMetric> = {} as any;
    for (const sn of STRATEGIES) {
      const st = state.strategies[sn];
      const positionValue = st.position ? st.position.vol * markPrice : 0;
      const equity = st.cash + positionValue;
      const cumRet = (equity - INITIAL_CASH_KRW) / INITIAL_CASH_KRW * 100;
      const prevPeak = peakTracker.peaks[sn] ?? INITIAL_CASH_KRW;
      const newPeak = Math.max(prevPeak, equity);
      peakTracker.peaks[sn] = newPeak;
      const drawdown = newPeak > 0 ? (newPeak - equity) / newPeak * 100 : 0;
      const capUsage = equity > 0 ? positionValue / equity * 100 : 0;
      const unrealizedPnl = st.position
        ? (markPrice - st.position.entryPrice) * st.position.vol
        : 0;
      strategyMetrics[sn] = {
        cumulative_return: cumRet,
        drawdown,
        capital_usage_pct: capUsage,
        cash: st.cash,
        equity,
        unrealized_pnl: unrealizedPnl,
      };
    }
    savePeaks(peakTracker);

    // (d) snapshot
    const snap: DailySnapshot = {
      timestamp: now.toISOString(),
      date: today,
      upbit_btc_krw_price: todayBar ? todayBar.open : null,
      binance_btc_usdt_price: binancePrice,
      funding_rate: yFunding,
      funding_intensity: fundingIntensity,
      funding_signal_state: fundingSignalState,
      strategy_signal: strategySignalLabel,
      position_state: {
        FUNDING_F1F2_50: state.strategies.FUNDING_F1F2_50.position ? 'IN' : 'OUT',
        FUNDING_F1F2_100: state.strategies.FUNDING_F1F2_100.position ? 'IN' : 'OUT',
      },
      strategy_metrics: strategyMetrics,
      volatility_regime: volRegime,
      vol_std_14d: vol14,
      stablecoin_1d_change: stableChange.c1d,
      stablecoin_3d_change: stableChange.c3d,
      stablecoin_7d_change: stableChange.c7d,
      btc_trend_state: btcTrend,
      skipped_reason: dataMissing.length > 0 ? 'data_missing' : null,
      data_missing_flag: dataMissing,
    };
    await appendSnapshot(snap);

    state.lastTickDate = today;

    // 콘솔 요약
    console.log(`\n[meta] funding intensity=${fundingIntensity?.toFixed(2) ?? 'N/A'}`);
    console.log(`[meta] vol regime=${volRegime ?? 'N/A'} std14=${vol14?.toFixed(2) ?? 'N/A'}%`);
    console.log(
      `[meta] stablecoin Δ c1d=${stableChange.c1d?.toFixed(3) ?? 'N/A'}% c3d=${stableChange.c3d?.toFixed(3) ?? 'N/A'}% c7d=${stableChange.c7d?.toFixed(3) ?? 'N/A'}%`,
    );
    console.log(`[meta] btc trend=${btcTrend ?? 'N/A'}`);
    if (dataMissing.length) console.log(`[meta] missing: ${dataMissing.join(',')}`);

    console.log(`\nStrategies:`);
    for (const sn of STRATEGIES) {
      const st = state.strategies[sn];
      const m = strategyMetrics[sn];
      const posStr = st.position
        ? `${st.position.signal} entry=${st.position.entryDate}@${st.position.entryPrice.toFixed(0)} d${st.position.daysHeld}`
        : 'none';
      console.log(
        `  ${sn}: eq=${m.equity.toFixed(0)} cumRet=${m.cumulative_return.toFixed(2)}% DD=${m.drawdown.toFixed(2)}% cap=${m.capital_usage_pct.toFixed(0)}% trades=${st.totalTrades} pos=${posStr}`,
      );
    }
  });

  console.log(`\n=== Tick complete ===`);
  process.exit(0);
})();
