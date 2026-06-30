/**
 * R3 월별 분석 — 최근 1년 (2025-06 ~ 2026-05).
 *
 * R3 daily proxy 룰 그대로:
 *   - discount z-score (rolling 30d) 하위 컷오프
 *   - 다음 day 시가 진입
 *   - TP/SL/MAX days
 *
 * 각 월에 대해:
 *   - 신호 발생 수
 *   - 진입 수
 *   - WR
 *   - avgWin / avgLoss / payoff
 *   - month total return
 *   - PF
 *   - 누적 return
 *
 * cell 비교: z5 vs z10, variant A/B/C, cost 0.2/0.3/0.5%
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Variant { name: string; tp: number; sl: number; maxDays: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP1.5_SL1.0_3d', tp: 1.5, sl: -1.0, maxDays: 3 },
  { name: 'B_TP2.5_SL1.5_5d', tp: 2.5, sl: -1.5, maxDays: 5 },
  { name: 'C_TP4.0_SL2.5_10d', tp: 4.0, sl: -2.5, maxDays: 10 },
];

const ZSCORE_WINDOW = 30;
const Z_PERCENTILES = [5, 10];
const COST_LEVELS = [0.002, 0.003, 0.005];

function load(file: string): Bar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
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
  zscore: number; discount: number;
  reason: 'TP' | 'SL' | 'TIME';
  rawReturnPct: number; netReturnPct: number;
  monthKey: string;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const usdt = load('KRW-USDT_daily_1800d_asof_2026-06-01.json');
  const btcUsdt = load('BINANCE_BTCUSDT_daily_1800d.json');
  const krwBtc = load('KRW-BTC_daily_1800d_asof_2026-06-08.json');

  const usdtMap = new Map(usdt.map((b) => [b.date, b]));
  const btcUsdtMap = new Map(btcUsdt.map((b) => [b.date, b]));
  const krwBtcMap = new Map(krwBtc.map((b) => [b.date, b]));
  const allDates = [...usdt.map((b) => b.date)].filter((d) => btcUsdtMap.has(d) && krwBtcMap.has(d)).sort();

  interface DayPoint { date: string; discount: number; krwBtcOpen: number; krwBtcHigh: number; krwBtcLow: number; krwBtcClose: number; }
  const days: DayPoint[] = [];
  for (const d of allDates) {
    const u = usdtMap.get(d)!;
    const bu = btcUsdtMap.get(d)!;
    const k = krwBtcMap.get(d)!;
    const upbitUsd = k.close / u.close;
    const discount = (upbitUsd - bu.close) / bu.close * 100;
    days.push({ date: d, discount, krwBtcOpen: k.open, krwBtcHigh: k.high, krwBtcLow: k.low, krwBtcClose: k.close });
  }

  const zscores: (number | null)[] = days.map((_, i) => {
    if (i < ZSCORE_WINDOW) return null;
    const window = days.slice(i - ZSCORE_WINDOW, i).map((d) => d.discount);
    const m = window.reduce((s, v) => s + v, 0) / window.length;
    const v = window.reduce((s, x) => s + (x - m) ** 2, 0) / window.length;
    const std = Math.sqrt(v);
    return std === 0 ? 0 : (days[i].discount - m) / std;
  });

  const validZ = zscores.filter((z): z is number => z != null);
  const zCutoff5 = percentile(validZ, 5);
  const zCutoff10 = percentile(validZ, 10);

  function simulate(zCutoff: number, v: Variant, cost: number, startDate: string, endDate: string): Trade[] {
    const trades: Trade[] = [];
    let cooldownUntil = -1;
    for (let i = ZSCORE_WINDOW; i < days.length - 1; i++) {
      if (i < cooldownUntil) continue;
      const z = zscores[i];
      if (z == null) continue;
      if (z >= zCutoff) continue;
      if (days[i].date < startDate || days[i].date > endDate) continue;
      const entryIdx = i + 1;
      const entryDay = days[entryIdx];
      const entryPriceRaw = entryDay.krwBtcOpen;
      const tpPrice = entryPriceRaw * (1 + v.tp / 100);
      const slPrice = entryPriceRaw * (1 + v.sl / 100);
      let exitIdx = entryIdx;
      let exitPrice = 0;
      let reason: 'TP' | 'SL' | 'TIME' = 'TIME';
      let rawReturn = 0;
      for (let d = 0; d < v.maxDays; d++) {
        const idx = entryIdx + d;
        if (idx >= days.length) break;
        const bar = days[idx];
        if (bar.krwBtcLow <= slPrice) { exitIdx = idx; exitPrice = slPrice; reason = 'SL'; rawReturn = v.sl; break; }
        if (bar.krwBtcHigh >= tpPrice) { exitIdx = idx; exitPrice = tpPrice; reason = 'TP'; rawReturn = v.tp; break; }
        if (d === v.maxDays - 1) { exitIdx = idx; exitPrice = bar.krwBtcClose; rawReturn = (bar.krwBtcClose - entryPriceRaw) / entryPriceRaw * 100; reason = 'TIME'; }
      }
      const netReturn = rawReturn - cost * 100;
      trades.push({
        signalDate: days[i].date,
        entryDate: entryDay.date, entryPrice: entryPriceRaw,
        exitDate: days[exitIdx].date, exitPrice,
        zscore: z, discount: days[i].discount,
        reason,
        rawReturnPct: rawReturn, netReturnPct: netReturn,
        monthKey: days[i].date.slice(0, 7),
      });
      cooldownUntil = exitIdx + 1;
    }
    return trades;
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

  // Generate month list (12 months)
  function monthList(startDate: string, endDate: string): string[] {
    const out: string[] = [];
    let y = parseInt(startDate.slice(0, 4));
    let m = parseInt(startDate.slice(5, 7));
    const endY = parseInt(endDate.slice(0, 4));
    const endM = parseInt(endDate.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      out.push(`${y}-${m.toString().padStart(2, '0')}`);
      m++;
      if (m > 12) { y++; m = 1; }
    }
    return out;
  }
  const months = monthList(ANALYSIS_START, ANALYSIS_END);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R3 월별 분석 — ${ANALYSIS_START} ~ ${ANALYSIS_END} (1년)`);
  L.push(`z cutoffs: p5=${zCutoff5.toFixed(2)}, p10=${zCutoff10.toFixed(2)}`);
  L.push('='.repeat(140));

  // 각 z-cutoff × variant × cost cell 별 월별
  for (const zP of Z_PERCENTILES) {
    const cutoff = zP === 5 ? zCutoff5 : zCutoff10;
    for (const v of VARIANTS) {
      // cost 0.2% 기준만 (다른 cost는 cell 비교 표에서)
      const trades = simulate(cutoff, v, 0.002, ANALYSIS_START, ANALYSIS_END);
      const tradesByMonth = new Map<string, Trade[]>();
      for (const t of trades) {
        if (!tradesByMonth.has(t.monthKey)) tradesByMonth.set(t.monthKey, []);
        tradesByMonth.get(t.monthKey)!.push(t);
      }

      L.push(`\n## z<p${zP} (${cutoff.toFixed(2)}) × ${v.name} × cost 0.2% — 월별`);
      L.push(`${pad('month', 8)} | ${padS('n', 3)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('payoff', 6)} | ${padS('mTotal', 8)} | ${padS('PF', 5)} | ${padS('cumRet', 8)}`);
      L.push('-'.repeat(100));
      let cum = 0;
      for (const mk of months) {
        const monthTrades = tradesByMonth.get(mk) ?? [];
        const s = statsFor(monthTrades);
        cum += s.total;
        if (s.n === 0) {
          L.push(`${pad(mk, 8)} | ${padS('-', 3)} | ${padS('-', 5)} | ${padS('-', 7)} | ${padS('-', 7)} | ${padS('-', 6)} | ${padS(fmt(0), 8)} | ${padS('-', 5)} | ${padS(fmt(cum), 8)}`);
        } else {
          L.push(`${pad(mk, 8)} | ${padS(String(s.n), 3)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(s.payoff.toFixed(2), 6)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(cum), 8)}`);
        }
      }
      // 12개월 합계
      const allStats = statsFor(trades);
      L.push(`${pad('TOTAL', 8)} | ${padS(String(allStats.n), 3)} | ${padS(allStats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(allStats.avgWin), 7)} | ${padS(fmt(allStats.avgLoss), 7)} | ${padS(allStats.payoff.toFixed(2), 6)} | ${padS(fmt(allStats.total), 8)} | ${padS(allStats.pf.toFixed(2), 5)} | ${padS(fmt(allStats.total), 8)}`);
    }
  }

  // cell 비교: 1년 합계 (cost 0.2/0.3/0.5 × variant × z)
  L.push(`\n\n## 1년 합계 cell 비교\n`);
  L.push(`${pad('z + variant', 35)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('payoff', 6)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(110));
  for (const zP of Z_PERCENTILES) {
    const cutoff = zP === 5 ? zCutoff5 : zCutoff10;
    for (const v of VARIANTS) {
      for (const cost of COST_LEVELS) {
        const trades = simulate(cutoff, v, cost, ANALYSIS_START, ANALYSIS_END);
        const s = statsFor(trades);
        L.push(`${pad(`z<p${zP} ${v.name}`, 35)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(s.payoff.toFixed(2), 6)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R3_MONTHLY.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
