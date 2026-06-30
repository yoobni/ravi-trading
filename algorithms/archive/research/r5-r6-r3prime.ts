/**
 * Research Round 2 — R5 + R6 + R3' 동시 실행.
 *
 * R5 VOLUME_SPIKE + FUNDING: BTC daily volume z-score(30d) ≥ p90 + F2 funding → 다음 day BTC 진입
 * R6 BTC_DOMINANCE_SIGNAL : BTC dominance 1d 변화 극단 → 다음 day BTC 진입/회피
 * R3' DISLOCATION 개선     : z-window 60d, "z<-1.5 hit 후 z>-0.8 회복" 패턴 진입
 *
 * 출력: 1년 한정 (2025-06-09 ~ 2026-06-09) 월별 + 1년 합계.
 * 라비 통과 기준 표시 X. WR / 이익률 / 월별 cumRet 중심.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const METRICS_DIR = path.resolve(process.cwd(), 'data', 'daily-metrics');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_LEVELS = [0.002, 0.003, 0.005];

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface FundingPoint { ts: number; date: string; rate: number; }
interface MetricRow { date: string; ts: number; value: number; extras?: any; }

interface Variant { name: string; tp: number; sl: number; maxDays: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP1.5_SL1.0_3d', tp: 1.5, sl: -1.0, maxDays: 3 },
  { name: 'B_TP2.5_SL1.5_5d', tp: 2.5, sl: -1.5, maxDays: 5 },
  { name: 'C_TP4.0_SL2.5_10d', tp: 4.0, sl: -2.5, maxDays: 10 },
];

function load(file: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
}
function loadMetric(file: string): MetricRow[] {
  const fp = path.join(METRICS_DIR, file);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}
function percentile(arr: number[], p: number): number {
  const s = [...arr].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}
function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

interface Trade {
  signalDate: string; entryDate: string; entryPrice: number;
  exitDate: string; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}

// Common: TP/SL/MAX days simulate on daily bars
function simulateDailyExit(
  bars: Bar[],
  entryIdx: number,
  entryPriceRaw: number,
  v: Variant,
): { exitIdx: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; rawReturn: number } {
  const tpPrice = entryPriceRaw * (1 + v.tp / 100);
  const slPrice = entryPriceRaw * (1 + v.sl / 100);
  for (let d = 0; d < v.maxDays; d++) {
    const idx = entryIdx + d;
    if (idx >= bars.length) {
      const lastBar = bars[bars.length - 1];
      return { exitIdx: bars.length - 1, exitPrice: lastBar.close, reason: 'TIME', rawReturn: (lastBar.close - entryPriceRaw) / entryPriceRaw * 100 };
    }
    const bar = bars[idx];
    if (bar.low <= slPrice) return { exitIdx: idx, exitPrice: slPrice, reason: 'SL', rawReturn: v.sl };
    if (bar.high >= tpPrice) return { exitIdx: idx, exitPrice: tpPrice, reason: 'TP', rawReturn: v.tp };
    if (d === v.maxDays - 1) return { exitIdx: idx, exitPrice: bar.close, reason: 'TIME', rawReturn: (bar.close - entryPriceRaw) / entryPriceRaw * 100 };
  }
  const lastBar = bars[bars.length - 1];
  return { exitIdx: bars.length - 1, exitPrice: lastBar.close, reason: 'TIME', rawReturn: (lastBar.close - entryPriceRaw) / entryPriceRaw * 100 };
}

function statsFor(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, avgWin: 0, avgLoss: 0, payoff: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const wr = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
  const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  return { n, wr, avgWin, avgLoss, payoff, total, pf };
}

function monthList(): string[] {
  const out: string[] = [];
  let y = parseInt(ANALYSIS_START.slice(0, 4));
  let m = parseInt(ANALYSIS_START.slice(5, 7));
  const endY = parseInt(ANALYSIS_END.slice(0, 4));
  const endM = parseInt(ANALYSIS_END.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${m.toString().padStart(2, '0')}`);
    m++; if (m > 12) { y++; m = 1; }
  }
  return out;
}

function monthlyTable(trades: Trade[]): string[] {
  const L: string[] = [];
  L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
  L.push('-'.repeat(85));
  const tradesByMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!tradesByMonth.has(t.monthKey)) tradesByMonth.set(t.monthKey, []);
    tradesByMonth.get(t.monthKey)!.push(t);
  }
  let cum = 0;
  for (const mk of monthList()) {
    const monthTrades = tradesByMonth.get(mk) ?? [];
    const s = statsFor(monthTrades);
    cum += s.total;
    if (s.n === 0) {
      L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
    } else {
      L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
    }
  }
  const all = statsFor(trades);
  L.push(`${pad('TOTAL', 8)} | ${padS(String(all.n), 3)} | ${padS(all.wr.toFixed(0)+'%', 5)} | ${padS(fmt(all.avgWin), 7)} | ${padS(fmt(all.avgLoss), 7)} | ${padS(fmt(all.total), 8)} | ${padS(all.pf.toFixed(2), 5)} | ${padS(fmt(all.total), 8)}`);
  return L;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 데이터 로드
  const krwBtc: Bar[] = load('KRW-BTC_daily_1800d_asof_2026-06-08.json');
  const krwBtcMap = new Map(krwBtc.map((b) => [b.date, b]));

  // Funding daily (KST aggregated)
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);
  const THR_FILE = path.resolve(process.cwd(), 'data', 'paper-trading', 'train-thresholds.json');
  const thr = JSON.parse(fs.readFileSync(THR_FILE, 'utf-8'));

  // USDT/KRW + Binance BTC daily for R3'
  const usdt: Bar[] = load('KRW-USDT_daily_1800d_asof_2026-06-01.json');
  const btcUsdt: Bar[] = load('BINANCE_BTCUSDT_daily_1800d.json');
  const usdtMap = new Map(usdt.map((b) => [b.date, b]));
  const btcUsdtMap = new Map(btcUsdt.map((b) => [b.date, b]));

  // Dominance 1y
  const dominance = loadMetric('cg_dominance.json');

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`Research Round 2 — R5 / R6 / R3' (period: ${ANALYSIS_START} ~ ${ANALYSIS_END})`);
  L.push('='.repeat(140));

  // ─── R5: VOLUME_SPIKE + FUNDING ───
  L.push(`\n## R5: BTC daily volume z-score(30d) ≥ p90 + F2 funding (yesterday ≤ p10)`);
  L.push(`가설: 거래량 급증 + 펀딩 음수 = capitulation. 다음 day 매수, daily TP/SL/MAX.\n`);

  const volWindow = 30;
  const krwBtcSorted = [...krwBtc].sort((a, b) => a.date.localeCompare(b.date));
  const volZ: (number | null)[] = krwBtcSorted.map((_, i) => {
    if (i < volWindow) return null;
    const vols = krwBtcSorted.slice(i - volWindow, i).map((b) => b.volume);
    const m = vols.reduce((s, v) => s + v, 0) / vols.length;
    const v = vols.reduce((s, x) => s + (x - m) ** 2, 0) / vols.length;
    const std = Math.sqrt(v);
    return std === 0 ? 0 : (krwBtcSorted[i].volume - m) / std;
  });

  function simR5(v: Variant, cost: number): Trade[] {
    const trades: Trade[] = [];
    let cooldownUntil = -1;
    for (let i = volWindow; i < krwBtcSorted.length - 1; i++) {
      if (i < cooldownUntil) continue;
      const day = krwBtcSorted[i].date;
      if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
      const z = volZ[i];
      if (z == null || z < 1.28) continue; // p90 ≈ z 1.28
      const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
      const yF = fundingDaily.get(yesterday);
      if (yF == null || yF > thr.p10_1d) continue; // F2 만족 필요

      const entryIdx = i + 1;
      const entryDay = krwBtcSorted[entryIdx];
      const exit = simulateDailyExit(krwBtcSorted, entryIdx, entryDay.open, v);
      const netReturn = exit.rawReturn - cost * 100;
      trades.push({
        signalDate: day,
        entryDate: entryDay.date, entryPrice: entryDay.open,
        exitDate: krwBtcSorted[exit.exitIdx].date, exitPrice: exit.exitPrice,
        reason: exit.reason,
        rawReturnPct: exit.rawReturn, netReturnPct: netReturn,
        monthKey: day.slice(0, 7),
      });
      cooldownUntil = exit.exitIdx + 1;
    }
    return trades;
  }

  L.push(`### 월별 (best variant B, cost 0.2%)`);
  const r5Best = simR5(VARIANTS[1], 0.002);
  L.push(...monthlyTable(r5Best));

  L.push(`\n### Variant × cost 1년 합계`);
  L.push(`${pad('variant', 24)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('payoff', 6)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(75));
  for (const v of VARIANTS) {
    for (const cost of COST_LEVELS) {
      const trades = simR5(v, cost);
      const s = statsFor(trades);
      L.push(`${pad(v.name, 24)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(s.payoff.toFixed(2), 6)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
    }
  }

  // ─── R6: BTC dominance change ───
  L.push(`\n\n## R6: BTC dominance 1d 변화 극단 (rolling 30d) → 다음 day BTC 매수`);
  L.push(`데이터: cg_dominance.json (${dominance.length}일)`);
  if (dominance.length < 60) {
    L.push(`⚠ 데이터 부족 (${dominance.length}일). R6 skip.`);
  } else {
    // dominance daily change %
    const domSorted = [...dominance].sort((a, b) => a.date.localeCompare(b.date));
    const domChange: { date: string; change: number }[] = [];
    for (let i = 1; i < domSorted.length; i++) {
      const prev = domSorted[i - 1].value;
      const cur = domSorted[i].value;
      domChange.push({ date: domSorted[i].date, change: (cur - prev) / prev * 100 });
    }

    // z-score with 30d window
    const domWindow = 30;
    const domZ: (number | null)[] = domChange.map((_, i) => {
      if (i < domWindow) return null;
      const win = domChange.slice(i - domWindow, i).map((d) => d.change);
      const m = win.reduce((s, v) => s + v, 0) / win.length;
      const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length;
      const std = Math.sqrt(v);
      return std === 0 ? 0 : (domChange[i].change - m) / std;
    });

    function simR6(v: Variant, cost: number, direction: 'DOM_UP' | 'DOM_DOWN'): Trade[] {
      const trades: Trade[] = [];
      let cooldownDate = '';
      for (let i = 0; i < domChange.length - 1; i++) {
        const day = domChange[i].date;
        if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
        if (day <= cooldownDate) continue;
        const z = domZ[i];
        if (z == null) continue;
        if (direction === 'DOM_UP' && z < 1.65) continue; // p95
        if (direction === 'DOM_DOWN' && z > -1.65) continue;

        // 다음 day BTC 진입
        const nextDate = new Date(new Date(day + 'T00:00:00Z').getTime() + 86400_000).toISOString().slice(0, 10);
        const entryBar = krwBtcMap.get(nextDate);
        if (!entryBar) continue;
        const entryIdx = krwBtcSorted.findIndex((b) => b.date === nextDate);
        if (entryIdx < 0) continue;

        const exit = simulateDailyExit(krwBtcSorted, entryIdx, entryBar.open, v);
        const netReturn = exit.rawReturn - cost * 100;
        trades.push({
          signalDate: day,
          entryDate: entryBar.date, entryPrice: entryBar.open,
          exitDate: krwBtcSorted[exit.exitIdx].date, exitPrice: exit.exitPrice,
          reason: exit.reason,
          rawReturnPct: exit.rawReturn, netReturnPct: netReturn,
          monthKey: day.slice(0, 7),
        });
        cooldownDate = krwBtcSorted[exit.exitIdx].date;
      }
      return trades;
    }

    for (const direction of ['DOM_UP', 'DOM_DOWN'] as const) {
      L.push(`\n### ${direction} (z ${direction === 'DOM_UP' ? '≥' : '≤'} ${direction === 'DOM_UP' ? '+1.65' : '-1.65'}) — best variant B, cost 0.2%`);
      const trades = simR6(VARIANTS[1], 0.002, direction);
      L.push(...monthlyTable(trades));
    }

    L.push(`\n### R6 Variant × cost × direction 1년 합계`);
    L.push(`${pad('variant + dir', 28)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
    L.push('-'.repeat(70));
    for (const direction of ['DOM_UP', 'DOM_DOWN'] as const) {
      for (const v of VARIANTS) {
        for (const cost of COST_LEVELS) {
          const trades = simR6(v, cost, direction);
          const s = statsFor(trades);
          L.push(`${pad(`${v.name} ${direction}`, 28)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
        }
      }
    }
  }

  // ─── R3': DISLOCATION 개선 (window 60d + 회복 패턴) ───
  L.push(`\n\n## R3': DISLOCATION 개선 — window 60d, "z<-1.5 hit 후 z>-0.8 회복" 패턴 매수`);

  const allDates = [...usdt.map((b) => b.date)].filter((d) => btcUsdtMap.has(d) && krwBtcMap.has(d)).sort();
  interface DP { date: string; discount: number; krwBtcOpen: number; krwBtcHigh: number; krwBtcLow: number; krwBtcClose: number; }
  const days: DP[] = [];
  for (const d of allDates) {
    const u = usdtMap.get(d)!;
    const bu = btcUsdtMap.get(d)!;
    const k = krwBtcMap.get(d)!;
    const upbitUsd = k.close / u.close;
    const discount = (upbitUsd - bu.close) / bu.close * 100;
    days.push({ date: d, discount, krwBtcOpen: k.open, krwBtcHigh: k.high, krwBtcLow: k.low, krwBtcClose: k.close });
  }
  const Z_WINDOW = 60;
  const zNew: (number | null)[] = days.map((_, i) => {
    if (i < Z_WINDOW) return null;
    const win = days.slice(i - Z_WINDOW, i).map((d) => d.discount);
    const m = win.reduce((s, v) => s + v, 0) / win.length;
    const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length;
    const std = Math.sqrt(v);
    return std === 0 ? 0 : (days[i].discount - m) / std;
  });

  function simR3Prime(v: Variant, cost: number, hitZ: number, recoverZ: number): Trade[] {
    const trades: Trade[] = [];
    let cooldownIdx = -1;
    let hitWaitEnd = -1; // hit 이후 회복 wait 종료 idx
    for (let i = Z_WINDOW; i < days.length - 1; i++) {
      const day = days[i].date;
      if (day < ANALYSIS_START || day > ANALYSIS_END) {
        if (zNew[i] != null && zNew[i]! <= hitZ) hitWaitEnd = i + 10;
        continue;
      }
      if (i < cooldownIdx) continue;
      const z = zNew[i];
      if (z == null) continue;

      // hit 단계
      if (z <= hitZ) {
        hitWaitEnd = i + 10; // 10일 안에 회복 신호 wait
      }

      // 회복 단계
      if (i <= hitWaitEnd && z >= recoverZ) {
        const entryIdx = i + 1;
        if (entryIdx >= days.length) break;
        const entryDay = days[entryIdx];
        const krwBars = krwBtcSorted;
        const krwEntryIdx = krwBars.findIndex((b) => b.date === entryDay.date);
        if (krwEntryIdx < 0) continue;
        const exit = simulateDailyExit(krwBars, krwEntryIdx, entryDay.krwBtcOpen, v);
        const netReturn = exit.rawReturn - cost * 100;
        trades.push({
          signalDate: day, entryDate: entryDay.date, entryPrice: entryDay.krwBtcOpen,
          exitDate: krwBars[exit.exitIdx].date, exitPrice: exit.exitPrice,
          reason: exit.reason, rawReturnPct: exit.rawReturn, netReturnPct: netReturn,
          monthKey: day.slice(0, 7),
        });
        cooldownIdx = days.findIndex((d) => d.date === krwBars[exit.exitIdx].date) + 1;
        hitWaitEnd = -1;
      }
    }
    return trades;
  }

  L.push(`### 월별 (best variant B, cost 0.2%, hit z≤-1.5 / recover z≥-0.8)`);
  const r3pBest = simR3Prime(VARIANTS[1], 0.002, -1.5, -0.8);
  L.push(...monthlyTable(r3pBest));

  L.push(`\n### R3' Variant × cost × hit/recover thresholds`);
  L.push(`${pad('config', 32)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(72));
  for (const [hitZ, recoverZ] of [[-1.5, -0.8], [-2.0, -1.0], [-1.0, -0.5]] as const) {
    for (const v of VARIANTS) {
      for (const cost of COST_LEVELS) {
        const trades = simR3Prime(v, cost, hitZ, recoverZ);
        const s = statsFor(trades);
        L.push(`${pad(`hit${hitZ}/rec${recoverZ} ${v.name}`, 32)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R5_R6_R3PRIME.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
