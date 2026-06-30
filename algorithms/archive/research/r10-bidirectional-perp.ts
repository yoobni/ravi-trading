/**
 * R10 BIDIRECTIONAL_PERP — 모든 펀딩 신호 LONG/SHORT 양방향 검증.
 *
 * 가정: Binance BTCUSDT perpetual
 *   - Direction: F1/cum3+/cum7+/V8 BOTH_F1/dis z+ → SHORT (contrarian)
 *                F2/cum3-/cum7-/V8 BOTH_F2/dis z- → LONG
 *   - Fee/slippage: 왕복 0.2% (taker + slippage)
 *   - Funding payment: 8h마다 정산
 *       LONG: -funding rate × hours/8 (양수일 때 지급)
 *       SHORT: +funding rate × hours/8
 *   - Entry: signal day+1 시가 (Binance daily open)
 *   - Exit: daily OHLC TP/SL/MAX
 *
 * 비교: LONG only / SHORT only / Bidirectional
 *
 * 데이터:
 *   - Binance BTC daily 1800d (실 perp 가격 proxy)
 *   - Binance funding 5+ years
 *
 * Period: 1년 (2025-06-09 ~ 2026-06-09) + 5년 OOS (2024-01 ~ 2026-06)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface FundingPoint { ts: number; date: string; rate: number; }

const COST_RT = 0.002; // 왕복 0.2% (perp taker + slippage)
const TRAIN_END = '2024-01-01'; // funding threshold 계산 기준

interface Variant { name: string; tp: number; sl: number; maxDays: number; }
const VARIANTS: Variant[] = [
  { name: 'B_TP2.5_SL1.5_5d', tp: 2.5, sl: -1.5, maxDays: 5 },
  { name: 'C_TP4.0_SL2.5_10d', tp: 4.0, sl: -2.5, maxDays: 10 },
];

function load(file: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
}
function pct(arr: number[], p: number): number {
  const s = [...arr].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}
function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

type Direction = 'LONG' | 'SHORT';

interface Trade {
  signalDate: string;
  direction: Direction;
  entryDate: string; entryPrice: number;
  exitDate: string; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME';
  priceReturnPct: number;   // 가격 변화 PnL
  fundingReturnPct: number; // 펀딩 정산 PnL
  netReturnPct: number;     // total - cost
  monthKey: string;
}

interface Stats { n: number; wr: number; avgWin: number; avgLoss: number; total: number; pf: number; }
function statsFor(trades: Trade[]): Stats {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, avgWin: 0, avgLoss: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const wr = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
  const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  return { n, wr, avgWin, avgLoss, total, pf };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const btcUsdt: Bar[] = load('BINANCE_BTCUSDT_daily_1800d.json').sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
  const btcByDate = new Map(btcUsdt.map((b, i) => [b.date, { i, bar: b }]));
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));

  // Funding 8h points → ts indexed
  const fundingByTs = funding.sort((a, b) => a.ts - b.ts);
  // Daily aggregated for signal evaluation
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);
  const dailySortedDates = [...fundingDaily.keys()].sort();
  const dailySortedRates = dailySortedDates.map((d) => fundingDaily.get(d)!);

  // cum3 / cum7
  const cum3ByDate = new Map<string, number>();
  const cum7ByDate = new Map<string, number>();
  for (let i = 0; i < dailySortedDates.length; i++) {
    if (i >= 2) {
      const sum = dailySortedRates[i] + dailySortedRates[i - 1] + dailySortedRates[i - 2];
      cum3ByDate.set(dailySortedDates[i], sum);
    }
    if (i >= 6) {
      let s = 0;
      for (let j = i - 6; j <= i; j++) s += dailySortedRates[j];
      cum7ByDate.set(dailySortedDates[i], s);
    }
  }

  // Train period thresholds (2019-09 ~ 2024-01)
  const trainDaily = dailySortedDates.filter((d) => d < TRAIN_END).map((d) => fundingDaily.get(d)!);
  const trainCum3 = dailySortedDates.filter((d) => d < TRAIN_END && cum3ByDate.has(d)).map((d) => cum3ByDate.get(d)!);
  const trainCum7 = dailySortedDates.filter((d) => d < TRAIN_END && cum7ByDate.has(d)).map((d) => cum7ByDate.get(d)!);

  const thr = {
    p10_1d: pct(trainDaily, 10),
    p90_1d: pct(trainDaily, 90),
    p10_3d: pct(trainCum3, 10),
    p90_3d: pct(trainCum3, 90),
    p10_7d: pct(trainCum7, 10),
    p90_7d: pct(trainCum7, 90),
  };

  // Funding payment 계산: entry_ts ~ exit_ts 사이의 모든 8h funding rate 합
  function fundingPaymentBetween(entryTs: number, exitTs: number, direction: Direction): number {
    let sum = 0;
    for (const fp of fundingByTs) {
      if (fp.ts < entryTs) continue;
      if (fp.ts > exitTs) break;
      sum += fp.rate;
    }
    // LONG: funding 양수일 때 지급 (PnL -), 음수일 때 받음 (PnL +) → -sum
    // SHORT: 반대 → +sum
    return direction === 'LONG' ? -sum : sum;
  }

  function simulate(
    bars: Bar[],
    entryIdx: number,
    entryPriceRaw: number,
    direction: Direction,
    v: Variant,
    entryTs: number,
  ): { exitIdx: number; exitPrice: number; reason: 'TP' | 'SL' | 'TIME'; priceReturnPct: number; fundingReturnPct: number } {
    // LONG: TP = entry × (1 + tp%), SL = entry × (1 + sl%) [sl<0 so SL < entry]
    //       SL hit when bar.low <= slPrice, TP hit when bar.high >= tpPrice
    // SHORT: TP = entry × (1 - tp%) [price falls = win], SL = entry × (1 + |sl%|) [price rises = loss]
    //        TP hit when bar.low <= tpPrice (price fell to TP), SL hit when bar.high >= slPrice (price rose)
    const tpPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.tp / 100) : entryPriceRaw * (1 - v.tp / 100);
    const slPrice = direction === 'LONG' ? entryPriceRaw * (1 + v.sl / 100) : entryPriceRaw * (1 - v.sl / 100); // sl<0 → 1 - sl/100 > 1
    for (let d = 0; d < v.maxDays; d++) {
      const idx = entryIdx + d;
      if (idx >= bars.length) {
        const last = bars[bars.length - 1];
        const exitTs = last.ts;
        const fundingRet = fundingPaymentBetween(entryTs, exitTs, direction);
        const priceRet = direction === 'LONG'
          ? (last.close - entryPriceRaw) / entryPriceRaw * 100
          : (entryPriceRaw - last.close) / entryPriceRaw * 100;
        return { exitIdx: bars.length - 1, exitPrice: last.close, reason: 'TIME', priceReturnPct: priceRet, fundingReturnPct: fundingRet };
      }
      const bar = bars[idx];
      let hit: 'TP' | 'SL' | 'TIME' | null = null;
      let exitP = 0;
      if (direction === 'LONG') {
        if (bar.low <= slPrice) { hit = 'SL'; exitP = slPrice; }
        else if (bar.high >= tpPrice) { hit = 'TP'; exitP = tpPrice; }
      } else {
        // SHORT
        if (bar.high >= slPrice) { hit = 'SL'; exitP = slPrice; }
        else if (bar.low <= tpPrice) { hit = 'TP'; exitP = tpPrice; }
      }
      if (hit) {
        const exitTs = bar.ts;
        const fundingRet = fundingPaymentBetween(entryTs, exitTs, direction);
        const priceRet = direction === 'LONG'
          ? (exitP - entryPriceRaw) / entryPriceRaw * 100
          : (entryPriceRaw - exitP) / entryPriceRaw * 100;
        return { exitIdx: idx, exitPrice: exitP, reason: hit, priceReturnPct: priceRet, fundingReturnPct: fundingRet };
      }
      if (d === v.maxDays - 1) {
        const exitTs = bar.ts;
        const fundingRet = fundingPaymentBetween(entryTs, exitTs, direction);
        const priceRet = direction === 'LONG'
          ? (bar.close - entryPriceRaw) / entryPriceRaw * 100
          : (entryPriceRaw - bar.close) / entryPriceRaw * 100;
        return { exitIdx: idx, exitPrice: bar.close, reason: 'TIME', priceReturnPct: priceRet, fundingReturnPct: fundingRet };
      }
    }
    const last = bars[bars.length - 1];
    return { exitIdx: bars.length - 1, exitPrice: last.close, reason: 'TIME', priceReturnPct: 0, fundingReturnPct: 0 };
  }

  type SignalType = 'F1F2' | 'CUM3' | 'CUM7' | 'V8' | 'NONE';

  function getSignalDirection(date: string, signalType: SignalType): Direction | null {
    const yesterday = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
    if (signalType === 'F1F2') {
      const r = fundingDaily.get(yesterday);
      if (r == null) return null;
      if (r >= thr.p90_1d) return 'SHORT';
      if (r <= thr.p10_1d) return 'LONG';
      return null;
    }
    if (signalType === 'CUM3') {
      const r = cum3ByDate.get(yesterday);
      if (r == null) return null;
      if (r >= thr.p90_3d) return 'SHORT';
      if (r <= thr.p10_3d) return 'LONG';
      return null;
    }
    if (signalType === 'CUM7') {
      const r = cum7ByDate.get(yesterday);
      if (r == null) return null;
      if (r >= thr.p90_7d) return 'SHORT';
      if (r <= thr.p10_7d) return 'LONG';
      return null;
    }
    if (signalType === 'V8') {
      const r1 = fundingDaily.get(yesterday);
      const r3 = cum3ByDate.get(yesterday);
      if (r1 == null || r3 == null) return null;
      if (r1 >= thr.p90_1d && r3 >= thr.p90_3d) return 'SHORT';
      if (r1 <= thr.p10_1d && r3 <= thr.p10_3d) return 'LONG';
      return null;
    }
    return null;
  }

  function runStrategy(
    signalType: SignalType,
    mode: 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH',
    v: Variant,
    startDate: string,
    endDate: string,
  ): Trade[] {
    const trades: Trade[] = [];
    let cooldownIdx = -1;
    for (let i = 0; i < btcUsdt.length - 1; i++) {
      const day = btcUsdt[i].date;
      if (day < startDate || day > endDate) continue;
      if (i < cooldownIdx) continue;
      const dir = getSignalDirection(day, signalType);
      if (!dir) continue;
      if (mode === 'LONG_ONLY' && dir !== 'LONG') continue;
      if (mode === 'SHORT_ONLY' && dir !== 'SHORT') continue;
      const entryIdx = i + 1;
      if (entryIdx >= btcUsdt.length) break;
      const entryBar = btcUsdt[entryIdx];
      const entryPriceRaw = entryBar.open;
      const result = simulate(btcUsdt, entryIdx, entryPriceRaw, dir, v, entryBar.ts);
      const netReturn = result.priceReturnPct + result.fundingReturnPct - COST_RT * 100;
      trades.push({
        signalDate: day, direction: dir,
        entryDate: entryBar.date, entryPrice: entryPriceRaw,
        exitDate: btcUsdt[result.exitIdx].date, exitPrice: result.exitPrice,
        reason: result.reason,
        priceReturnPct: result.priceReturnPct,
        fundingReturnPct: result.fundingReturnPct,
        netReturnPct: netReturn,
        monthKey: day.slice(0, 7),
      });
      cooldownIdx = result.exitIdx + 1;
    }
    return trades;
  }

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R10 BIDIRECTIONAL_PERP — Binance BTCUSDT 가정`);
  L.push(`Fee/slippage: 왕복 ${(COST_RT*100).toFixed(1)}% / Funding payment 8h마다 정산`);
  L.push(`Direction rule: 양수 극단 → SHORT (contrarian), 음수 극단 → LONG`);
  L.push('='.repeat(140));

  L.push(`\nThresholds (train ~${TRAIN_END}):`);
  L.push(`  1d: p10=${thr.p10_1d.toFixed(4)}  p90=${thr.p90_1d.toFixed(4)}`);
  L.push(`  3d: p10=${thr.p10_3d.toFixed(4)}  p90=${thr.p90_3d.toFixed(4)}`);
  L.push(`  7d: p10=${thr.p10_7d.toFixed(4)}  p90=${thr.p90_7d.toFixed(4)}`);

  // Periods
  const periods = [
    { name: '1년 (2025-06 ~ 2026-06)', start: '2025-06-09', end: '2026-06-09' },
    { name: '2.5년 OOS (2024-01 ~ 2026-06)', start: '2024-01-01', end: '2026-06-01' },
  ];

  const signalTypes: SignalType[] = ['F1F2', 'CUM3', 'CUM7', 'V8'];
  const modes: Array<'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH'> = ['LONG_ONLY', 'SHORT_ONLY', 'BOTH'];

  for (const period of periods) {
    L.push(`\n\n## Period: ${period.name}\n`);
    for (const v of VARIANTS) {
      L.push(`\n### Variant ${v.name}`);
      L.push(`${pad('signal × mode', 28)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('priceRet', 9)} | ${padS('fundingRet', 11)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
      L.push('-'.repeat(120));
      for (const sig of signalTypes) {
        for (const mode of modes) {
          const trades = runStrategy(sig, mode, v, period.start, period.end);
          const s = statsFor(trades);
          const priceRet = trades.reduce((a, t) => a + t.priceReturnPct, 0);
          const fundingRet = trades.reduce((a, t) => a + t.fundingReturnPct, 0);
          L.push(`${pad(`${sig} × ${mode}`, 28)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(priceRet), 9)} | ${padS(fmt(fundingRet), 11)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
        }
        L.push(''); // 신호 사이 빈 줄
      }
    }
  }

  // 추가: best cell의 trade 내역 (direction별 분해)
  L.push(`\n\n## 분해: V8 × BOTH × B variant × 1년 (sample trades)\n`);
  const sampleTrades = runStrategy('V8', 'BOTH', VARIANTS[0], '2025-06-09', '2026-06-09');
  for (const t of sampleTrades) {
    L.push(`  ${t.direction.padEnd(5)} sig=${t.signalDate} entry=${t.entryDate}@${t.entryPrice.toFixed(0)} exit=${t.exitDate}@${t.exitPrice.toFixed(0)} price=${fmt(t.priceReturnPct)} fund=${fmt(t.fundingReturnPct)} net=${fmt(t.netReturnPct)} ${t.reason}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R10_BIDIRECTIONAL.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
