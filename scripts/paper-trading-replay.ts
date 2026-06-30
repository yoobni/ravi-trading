/**
 * Paper trading 정합성 검증 — historical replay.
 *
 * paper 운영 룰(F1+F2)을 historical 데이터로 walk해서
 * backtest D7-C3 결과와 일치 검증.
 *
 * 두 전략(FUNDING_F1F2_50 = 자본 50%, FUNDING_F1F2_100 = 자본 100%)
 * 각각 replay 후 boost backtest reference와 비교.
 *
 * Reference (boost backtest):
 *   자본  50%: PF=1.54, MDD=10.7%, 월=+0.70%, Top5제거=-1.15%, 3/3년, n=34
 *   자본 100%: PF=1.51, MDD=21.2%, 월=+1.40%, Top5제거=-5.23%, 3/3년, n=34
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchDailyCached, type DailyBar } from './_daily-cache';
import {
  loadThresholds,
  FEE,
  SLIPPAGE,
  TP_PCT,
  SL_PCT,
  MAX_DAYS,
  INITIAL_CASH_KRW,
  STRATEGY_SIZE_FRACTION,
  type SignalLabel,
  type TrainThresholds,
} from '@/lib/paper-trading-store';
import {
  evalF1F2,
  aggregateDaily,
  type FundingFetchPoint,
} from '@/lib/paper-funding-strategy';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const TEST_START = '2024-01-01';
const TEST_END = '2026-06-01';
const TEST_MONTHS = 29;

interface FundingPoint {
  ts: number;
  date: string;
  rate: number;
}

interface Trade {
  signal: SignalLabel;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: string;
  year: string;
}

function daysBetween(later: string, earlier: string): number {
  const ms =
    new Date(later + 'T00:00:00Z').getTime() -
    new Date(earlier + 'T00:00:00Z').getTime();
  return Math.round(ms / 86400_000);
}
function addDays(date: string, n: number): string {
  return new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400_000)
    .toISOString()
    .slice(0, 10);
}

function simulateReplay(
  bars: DailyBar[],
  dailyMap: ReturnType<typeof aggregateDaily>,
  thresholds: TrainThresholds,
  sizeFraction: number,
): { trades: Trade[]; finalCash: number; mdd: number } {
  const byDate = new Map(bars.map((b, i) => [b.date, { i, bar: b }]));
  let cash = INITIAL_CASH_KRW;
  let pos: {
    signal: SignalLabel;
    signalDate: string;
    entryDate: string;
    entryPrice: number;
    vol: number;
    buyAmount: number;
  } | null = null;
  const trades: Trade[] = [];
  const curve: number[] = [];

  for (const b of bars) {
    const today = b.date;
    if (today < addDays(TEST_START, 1) || today > TEST_END) continue;
    const todayEntry = byDate.get(today);
    if (!todayEntry) continue;
    const yesterday = addDays(today, -1);
    const yEntry = byDate.get(yesterday);

    if (pos && yEntry && pos.entryDate <= yesterday && pos.entryDate !== today) {
      const tp = pos.entryPrice * (1 + TP_PCT / 100);
      const sl = pos.entryPrice * (1 + SL_PCT / 100);
      const daysHeld = daysBetween(yesterday, pos.entryDate);
      const yBar = yEntry.bar;
      let exitPrice = 0;
      let reason = '';
      if (yBar.low <= sl) {
        exitPrice = sl * (1 - SLIPPAGE);
        reason = 'SL';
      } else if (yBar.high >= tp) {
        exitPrice = tp * (1 - SLIPPAGE);
        reason = 'TP';
      } else if (daysHeld >= MAX_DAYS) {
        exitPrice = yBar.close * (1 - SLIPPAGE);
        reason = 'TIME';
      }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross - gross * FEE;
        const profitKrw = cashGained - pos.buyAmount * (1 + FEE);
        const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
        cash += cashGained;
        trades.push({
          signal: pos.signal,
          signalDate: pos.signalDate,
          entryDate: pos.entryDate,
          exitDate: yesterday,
          entryPrice: pos.entryPrice,
          exitPrice,
          profitRate,
          profitKrw,
          reason,
          year: pos.entryDate.slice(0, 4),
        });
        pos = null;
      }
    }

    if (!pos && todayEntry.i + MAX_DAYS + 1 < bars.length) {
      const ctx = { evalDate: yesterday, dailyMap, thresholds };
      const sig = evalF1F2(ctx);
      if (sig.label) {
        const entryPrice = todayEntry.bar.open * (1 + SLIPPAGE);
        const buyAmount = cash * sizeFraction * 0.995;
        if (buyAmount >= 5000) {
          const fee = buyAmount * FEE;
          if (buyAmount + fee <= cash) {
            const vol = buyAmount / entryPrice;
            cash -= buyAmount + fee;
            pos = {
              signal: sig.label,
              signalDate: yesterday,
              entryDate: today,
              entryPrice,
              vol,
              buyAmount,
            };
          }
        }
      }
    }

    let eq = cash;
    if (pos) eq += pos.vol * todayEntry.bar.close;
    curve.push(eq);
  }

  if (pos) {
    const lastBar = bars[bars.length - 1];
    const exitPrice = lastBar.close * (1 - SLIPPAGE);
    const gross = pos.vol * exitPrice;
    const cashGained = gross - gross * FEE;
    const profitKrw = cashGained - pos.buyAmount * (1 + FEE);
    const profitRate = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    cash += cashGained;
    trades.push({
      signal: pos.signal,
      signalDate: pos.signalDate,
      entryDate: pos.entryDate,
      exitDate: lastBar.date,
      entryPrice: pos.entryPrice,
      exitPrice,
      profitRate,
      profitKrw,
      reason: 'END',
      year: pos.entryDate.slice(0, 4),
    });
  }

  let peak = INITIAL_CASH_KRW;
  let mdd = 0;
  for (const e of curve) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > mdd) mdd = dd;
  }

  return { trades, finalCash: cash, mdd };
}

function statsOf(trades: Trade[], finalCash: number, mdd: number) {
  const totalReturn = (finalCash - INITIAL_CASH_KRW) / INITIAL_CASH_KRW * 100;
  const monthlyAvg = totalReturn / TEST_MONTHS;
  const wins = trades.filter((t) => t.profitRate > 0);
  const losses = trades.filter((t) => t.profitRate <= 0);
  const wr = trades.length ? wins.length / trades.length * 100 : 0;
  const totalWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;
  const sortedKrw = [...trades].sort((a, b) => b.profitKrw - a.profitKrw);
  const top5 = sortedKrw.slice(0, 5).reduce((s, t) => s + t.profitKrw, 0);
  const noTop5 = (finalCash - top5 - INITIAL_CASH_KRW) / INITIAL_CASH_KRW * 100;
  const yearly: Record<string, number> = {};
  for (const y of ['2024', '2025', '2026']) {
    const yc = trades.filter((t) => t.year === y);
    yearly[y] = yc.length ? yc.reduce((s, t) => s + t.profitKrw, 0) : 0;
  }
  const posY = Object.values(yearly).filter((v) => v > 0).length;
  return { totalReturn, monthlyAvg, mdd, pf, wr, noTop5, posY, n: trades.length };
}

function fmt(n: number, sign = true): string {
  return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

interface ReferenceStat {
  n: number;
  pf: number;
  mdd: number;
  monthly: number;
  top5: number;
  posY: number;
}

const REFERENCES: Record<string, ReferenceStat> = {
  FUNDING_F1F2_50: { n: 34, pf: 1.54, mdd: 10.7, monthly: 0.70, top5: -1.15, posY: 3 },
  FUNDING_F1F2_100: { n: 34, pf: 1.51, mdd: 21.2, monthly: 1.40, top5: -5.23, posY: 3 },
};

(async () => {
  console.log(`\n=== Paper Trading 정합성 Replay ===`);
  console.log(`Test: ${TEST_START} ~ ${TEST_END}\n`);

  const thresholds = loadThresholds();
  console.log(`Train thresholds:`);
  console.log(`  p10_1d=${thresholds.p10_1d.toFixed(4)}  p90_1d=${thresholds.p90_1d.toFixed(4)}`);
  console.log(`  p10_3d=${thresholds.p10_3d.toFixed(4)}  p90_3d=${thresholds.p90_3d.toFixed(4)}\n`);

  const fundingFile = path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json');
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(fundingFile, 'utf-8'));
  const points: FundingFetchPoint[] = funding.map((f) => ({
    ts: f.ts,
    date: f.date,
    rate: f.rate,
  }));
  const dailyMap = aggregateDaily(points);
  const bars = await fetchDailyCached('KRW-BTC', 1800);
  console.log(`Loaded: ${funding.length} funding pts, ${bars.length} BTC bars\n`);

  console.log(`## Replay vs Backtest 비교\n`);
  console.log(
    `${'전략 / source'.padEnd(28)} | ${'n'.padStart(3)} | ${'PF'.padStart(5)} | ${'MDD'.padStart(6)} | ${'월평균'.padStart(7)} | ${'Top5제거'.padStart(9)} | ${'pos년'.padStart(5)}`,
  );
  console.log('-'.repeat(85));

  const results: Record<string, { replayStats: ReturnType<typeof statsOf>; replayTrades: Trade[] }> = {};
  let allMatch = true;

  for (const [sn, sf] of Object.entries(STRATEGY_SIZE_FRACTION)) {
    const sim = simulateReplay(bars, dailyMap, thresholds, sf);
    const s = statsOf(sim.trades, sim.finalCash, sim.mdd);
    results[sn] = { replayStats: s, replayTrades: sim.trades };
    const ref = REFERENCES[sn];
    console.log(
      `${(sn + ' replay').padEnd(28)} | ${String(s.n).padStart(3)} | ${s.pf.toFixed(2).padStart(5)} | ${(s.mdd.toFixed(1) + '%').padStart(6)} | ${fmt(s.monthlyAvg).padStart(7)} | ${fmt(s.noTop5).padStart(9)} | ${(s.posY + '/3').padStart(5)}`,
    );
    console.log(
      `${(sn + ' backtest ref').padEnd(28)} | ${String(ref.n).padStart(3)} | ${ref.pf.toFixed(2).padStart(5)} | ${(ref.mdd.toFixed(1) + '%').padStart(6)} | ${fmt(ref.monthly).padStart(7)} | ${fmt(ref.top5).padStart(9)} | ${(ref.posY + '/3').padStart(5)}`,
    );
    const match =
      Math.abs(s.n - ref.n) <= 2 &&
      Math.abs(s.pf - ref.pf) <= 0.10 &&
      Math.abs(s.mdd - ref.mdd) <= 2.0;
    if (!match) allMatch = false;
    console.log(
      `  → ${match ? '✓ PASS — paper 코드와 backtest 결과 일치' : '✗ FAIL — 불일치, 디버깅 필요'}\n`,
    );
  }

  // Trade list 출력
  for (const sn of Object.keys(STRATEGY_SIZE_FRACTION)) {
    const r = results[sn];
    console.log(`## ${sn} trade list (n=${r.replayTrades.length})\n`);
    for (const t of r.replayTrades) {
      console.log(
        `  ${t.signal.padEnd(7)} sig=${t.signalDate} entry=${t.entryDate}@${t.entryPrice.toFixed(0).padStart(10)} exit=${t.exitDate}@${t.exitPrice.toFixed(0).padStart(10)} ret=${(t.profitRate >= 0 ? '+' : '') + t.profitRate.toFixed(2)}% ${t.reason}`,
      );
    }
    console.log('');
  }

  console.log(`\n=== 종합 판정: ${allMatch ? '✓ ALL PASS' : '✗ FAIL'} ===`);

  const outFile = path.join(
    process.cwd(),
    'data',
    'backtest-results',
    `paper-replay-${new Date().toISOString().slice(0, 10)}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`Detail saved: ${outFile}`);

  process.exit(0);
})();
