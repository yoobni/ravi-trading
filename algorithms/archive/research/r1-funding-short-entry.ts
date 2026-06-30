/**
 * R1: FUNDING_SHORT_ENTRY — 펀딩 알파를 짧은 보유로 변환.
 *
 * 룰:
 *   1. F1F2 bullish signal (yesterday daily funding ≤ p10 [F2] 또는 ≥ p90 [F1])
 *   2. D 일자 (signal 발생일 다음 날) 동안 15m bar 평가:
 *      - RSI(14) < 35
 *      - close > EMA20
 *      - 양봉 (close > open)
 *      세 조건 동시 만족하는 첫 15m 봉 발견 시 발생
 *   3. 신호 발생 다음 15m 시초가 진입
 *   4. 1분봉 path verified 청산 (TP/SL/MAX 변형)
 *
 * 검증:
 *   - 4 variant TP/SL/MAX
 *   - Cost stress 0.2% / 0.3% / 0.5% 왕복
 *   - Walk-forward 3 fold (2025-06~09 / 2025-10~2026-01 / 2026-02~2026-05)
 *   - 분해: exit reason, 월별, F1 vs F2
 *
 * Paper trading 룰 변경 없음. 별도 트랙.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { calcRSI, calcEMA } from '@/lib/indicators';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

interface FundingPoint { ts: number; date: string; rate: number; }
interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Variant { name: string; tp: number; sl: number; maxMin: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP1.0_SL0.8_4h',  tp: 1.0, sl: -0.8, maxMin: 240 },
  { name: 'B_TP1.5_SL1.0_8h',  tp: 1.5, sl: -1.0, maxMin: 480 },
  { name: 'C_TP2.0_SL1.2_24h', tp: 2.0, sl: -1.2, maxMin: 1440 },
  { name: 'D_TP1.2_SL1.5_8h',  tp: 1.2, sl: -1.5, maxMin: 480 },
];

const COST_LEVELS = [0.002, 0.003, 0.005]; // round-trip cost
const RSI_MAX = 35;
const EMA_PERIOD = 20;
const RSI_PERIOD = 14;
const OVERSOLD_LOOKBACK = 10; // 직전 10개 15m (2.5h) 안에 RSI<35 hit 있어야

// Funding thresholds — paper trading 그대로 (frozen)
const THRESHOLDS_FILE = path.resolve(process.cwd(), 'data', 'paper-trading', 'train-thresholds.json');
const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf-8'));
const P10 = thresholds.p10_1d;
const P90 = thresholds.p90_1d;

// ─────────────────────────────────────────────────────
// 데이터 로드
// ─────────────────────────────────────────────────────

function loadFundingDaily(): Map<string, number> {
  const file = path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json');
  const points: FundingPoint[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const m = new Map<string, number>();
  for (const p of points) m.set(p.date, (m.get(p.date) ?? 0) + p.rate);
  return m;
}

function load1mBars(): Bar[] {
  const files = [
    'KRW-BTC_1m_2025-06-01_2025-11-30.json',
    'KRW-BTC_1m_2025-12-01_2026-05-29.json',
  ];
  const all: Bar[] = [];
  for (const f of files) {
    const fp = path.join(CACHE_DIR, f);
    if (!fs.existsSync(fp)) throw new Error(`Missing: ${fp}`);
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Bar[];
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);
  }
  const seen = new Set<number>();
  return all
    .filter((b) => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
    .sort((a, b) => a.ts - b.ts);
}

/** 1m → 15m 합성 (KST 기준 15분 bucket) */
function aggregate1mTo15m(bars1m: Bar[]): Bar[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of bars1m) {
    const bucketTs = Math.floor(b.ts / (15 * 60_000)) * (15 * 60_000);
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, []);
    buckets.get(bucketTs)!.push(b);
  }
  const out: Bar[] = [];
  for (const [ts, bs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length === 0) continue;
    const date = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    out.push({
      ts, date,
      open: bs[0].open,
      high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)),
      close: bs[bs.length - 1].close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────
// 1m path verified exit
// ─────────────────────────────────────────────────────

interface ExitResult {
  exitTs: number;
  exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME' | 'END';
  rawReturnPct: number; // before cost
  durationMin: number;
}

function pathVerifyExit(
  bars1m: Bar[],
  startIdx: number,
  entryTs: number,
  entryPriceRaw: number,
  tpPct: number,
  slPct: number,
  maxMin: number,
): ExitResult | null {
  const tpPrice = entryPriceRaw * (1 + tpPct / 100);
  const slPrice = entryPriceRaw * (1 + slPct / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsedMin = (bar.ts - entryTs) / 60_000;
    if (bar.low <= slPrice) {
      return {
        exitTs: bar.ts, exitPrice: slPrice, reason: 'SL',
        rawReturnPct: slPct, durationMin: elapsedMin,
      };
    }
    if (bar.high >= tpPrice) {
      return {
        exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP',
        rawReturnPct: tpPct, durationMin: elapsedMin,
      };
    }
    if (elapsedMin >= maxMin) {
      const ret = (bar.close - entryPriceRaw) / entryPriceRaw * 100;
      return {
        exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME',
        rawReturnPct: ret, durationMin: elapsedMin,
      };
    }
  }
  const lastBar = bars1m[bars1m.length - 1];
  const ret = (lastBar.close - entryPriceRaw) / entryPriceRaw * 100;
  return {
    exitTs: lastBar.ts, exitPrice: lastBar.close, reason: 'END',
    rawReturnPct: ret, durationMin: (lastBar.ts - entryTs) / 60_000,
  };
}

// ─────────────────────────────────────────────────────
// Simulator
// ─────────────────────────────────────────────────────

interface Trade {
  signal: 'F1' | 'F2';
  signalDate: string;
  entryTs: number; entryDate: string; entryPrice: number;
  exitTs: number; exitDate: string; exitPrice: number;
  reason: string;
  rawReturnPct: number;
  netReturnPct: number; // after cost
  durationMin: number;
  monthKey: string; // YYYY-MM
}

function simulate(
  bars1m: Bar[],
  bars15m: Bar[],
  fundingDaily: Map<string, number>,
  rsi: (number | null)[],
  ema: (number | null)[],
  variant: Variant,
  cost: number,
  dateStart: string,
  dateEnd: string,
): Trade[] {
  const trades: Trade[] = [];
  // 그룹: 15m bars by KST day
  const barsByDay = new Map<string, { idx: number; bar: Bar }[]>();
  for (let i = 0; i < bars15m.length; i++) {
    const day = bars15m[i].date.slice(0, 10);
    if (!barsByDay.has(day)) barsByDay.set(day, []);
    barsByDay.get(day)!.push({ idx: i, bar: bars15m[i] });
  }
  const sortedDays = [...barsByDay.keys()].sort();

  // 1m index quick lookup
  function find1mIdx(ts: number): number {
    let lo = 0, hi = bars1m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars1m[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const dbg = { days: 0, withFunding: 0, withSignal: 0, barsEvald: 0, hitRsi: 0, hitEma: 0, hitGreen: 0, hitAll: 0 };
  for (const day of sortedDays) {
    if (day < dateStart || day > dateEnd) continue;
    dbg.days++;
    // Yesterday funding
    const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000)
      .toISOString().slice(0, 10);
    const yFunding = fundingDaily.get(yesterday);
    if (yFunding == null) continue;
    dbg.withFunding++;
    let signal: 'F1' | 'F2' | null = null;
    if (yFunding >= P90) signal = 'F1';
    else if (yFunding <= P10) signal = 'F2';
    if (!signal) continue;
    dbg.withSignal++;

    // Day 15m loop — "과매도 → 회복" 흐름
    const dayBars = barsByDay.get(day)!;
    for (const { idx, bar } of dayBars) {
      const r = rsi[idx];
      const e = ema[idx];
      if (r == null || e == null) continue;
      dbg.barsEvald++;
      // 직전 LOOKBACK 안에 RSI<35 hit (과매도 통과)
      let oversoldRecently = false;
      for (let j = Math.max(0, idx - OVERSOLD_LOOKBACK); j < idx; j++) {
        const rj = rsi[j];
        if (rj != null && rj < RSI_MAX) { oversoldRecently = true; break; }
      }
      if (oversoldRecently) dbg.hitRsi++;
      if (bar.close > e) dbg.hitEma++;
      if (bar.close > bar.open) dbg.hitGreen++;
      if (!oversoldRecently) continue;
      if (bar.close <= e) continue;
      if (bar.close <= bar.open) continue;
      dbg.hitAll++;

      // 진입: 다음 15m 시초가
      const entryBarIdx = idx + 1;
      if (entryBarIdx >= bars15m.length) break;
      const entryBar = bars15m[entryBarIdx];
      const entryTs = entryBar.ts;
      const entryPriceRaw = entryBar.open;
      const start1mIdx = find1mIdx(entryTs);
      if (start1mIdx >= bars1m.length) break;

      const exit = pathVerifyExit(
        bars1m, start1mIdx, entryTs, entryPriceRaw,
        variant.tp, variant.sl, variant.maxMin,
      );
      if (!exit) break;

      const netReturnPct = exit.rawReturnPct - cost * 100;
      const monthKey = day.slice(0, 7);
      trades.push({
        signal,
        signalDate: yesterday,
        entryTs, entryDate: entryBar.date, entryPrice: entryPriceRaw,
        exitTs: exit.exitTs, exitDate: new Date(exit.exitTs + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
        exitPrice: exit.exitPrice,
        reason: exit.reason,
        rawReturnPct: exit.rawReturnPct,
        netReturnPct,
        durationMin: exit.durationMin,
        monthKey,
      });
      break; // 그 day는 한 번만 진입
    }
  }
  if (process.env.R1_DEBUG) {
    console.error(`[dbg variant=${variant.name} cost=${cost}] days=${dbg.days} withFunding=${dbg.withFunding} withSignal=${dbg.withSignal} barsEvald=${dbg.barsEvald} hitRsi=${dbg.hitRsi} hitEma=${dbg.hitEma} hitGreen=${dbg.hitGreen} hitAll=${dbg.hitAll} trades=${trades.length}`);
  }
  return trades;
}

// ─────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────

interface Stats {
  n: number;
  totalReturnPct: number;
  monthlyAvg: number;
  wr: number;
  pf: number;
  avgWin: number;
  avgLoss: number;
  payoff: number;
  mdd: number;
  noTop5: number;
  noTop10: number;
  maxLosingStreak: number;
}

function calcStats(trades: Trade[], months: number): Stats {
  if (trades.length === 0) {
    return { n: 0, totalReturnPct: 0, monthlyAvg: 0, wr: 0, pf: 0, avgWin: 0, avgLoss: 0, payoff: 0, mdd: 0, noTop5: 0, noTop10: 0, maxLosingStreak: 0 };
  }
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct <= 0);
  const totalReturnPct = trades.reduce((s, t) => s + t.netReturnPct, 0);
  const monthlyAvg = months > 0 ? totalReturnPct / months : 0;
  const wr = wins.length / trades.length * 100;
  const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
  const avgWin = wins.length ? totalWin / wins.length : 0;
  const avgLoss = losses.length ? -totalLoss / losses.length : 0;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;

  // MDD
  let eq = 0; let peak = 0; let mdd = 0;
  for (const t of trades) {
    eq += t.netReturnPct;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > mdd) mdd = dd;
  }

  // Top5 / Top10 제거
  const sorted = [...trades].sort((a, b) => b.netReturnPct - a.netReturnPct);
  const top5 = sorted.slice(0, 5).reduce((s, t) => s + t.netReturnPct, 0);
  const top10 = sorted.slice(0, 10).reduce((s, t) => s + t.netReturnPct, 0);
  const noTop5 = totalReturnPct - top5;
  const noTop10 = totalReturnPct - top10;

  // Max losing streak
  let streak = 0; let maxStreak = 0;
  for (const t of trades) {
    if (t.netReturnPct <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }

  return { n: trades.length, totalReturnPct, monthlyAvg, wr, pf, avgWin, avgLoss, payoff, mdd, noTop5, noTop10, maxLosingStreak: maxStreak };
}

function monthsBetween(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / (30 * 86400_000);
}

// ─────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────

function fmt(n: number, sign = true): string {
  return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R1: FUNDING_SHORT_ENTRY ===`);
  console.log(`Thresholds: p10=${P10.toFixed(4)}, p90=${P90.toFixed(4)} (paper frozen)\n`);

  const fundingDaily = loadFundingDaily();
  const bars1m = load1mBars();
  console.log(`Loaded: 1m=${bars1m.length} bars (${new Date(bars1m[0].ts + 9*3600*1000).toISOString().slice(0,10)} ~ ${new Date(bars1m[bars1m.length-1].ts + 9*3600*1000).toISOString().slice(0,10)})`);

  const bars15m = aggregate1mTo15m(bars1m);
  console.log(`15m aggregated: ${bars15m.length} bars`);

  const closes15m = bars15m.map((b) => b.close);
  const rsi = calcRSI(closes15m, RSI_PERIOD).values;
  const ema = calcEMA(closes15m, EMA_PERIOD);

  // Full period
  const dataStart = new Date(bars1m[0].ts + 9*3600*1000).toISOString().slice(0,10);
  const dataEnd = new Date(bars1m[bars1m.length-1].ts + 9*3600*1000).toISOString().slice(0,10);
  const totalMonths = monthsBetween(dataStart, dataEnd);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R1: FUNDING_SHORT_ENTRY`);
  L.push(`Period: ${dataStart} ~ ${dataEnd} (${totalMonths.toFixed(1)} months)`);
  L.push(`Signal: F1F2 (paper threshold) + 15m RSI<${RSI_MAX} + close>EMA${EMA_PERIOD} + 양봉`);
  L.push(`Exit: 1m path verified`);
  L.push(`Cost levels (round-trip): ${COST_LEVELS.map((c) => (c*100).toFixed(1)+'%').join(' / ')}`);
  L.push('='.repeat(140));

  // ─── Full period × variants × cost
  L.push(`\n## Full period (${dataStart} ~ ${dataEnd})\n`);
  L.push(`${pad('variant', 24)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('월평균', 7)} | ${padS('WR', 4)} | ${padS('payoff', 6)} | ${padS('Top10제거', 9)} | ${padS('streak', 6)} | 판정`);
  L.push('-'.repeat(140));

  interface Cell { variant: Variant; cost: number; trades: Trade[]; stats: Stats; }
  const fullCells: Cell[] = [];

  for (const v of VARIANTS) {
    for (const cost of COST_LEVELS) {
      const trades = simulate(bars1m, bars15m, fundingDaily, rsi, ema, v, cost, dataStart, dataEnd);
      const s = calcStats(trades, totalMonths);
      fullCells.push({ variant: v, cost, trades, stats: s });

      let verdict = '✗';
      const reasons: string[] = [];
      if (s.n < 50) reasons.push(`n<50 (${s.n})`);
      if (s.pf < 1.2) reasons.push(`PF<1.2`);
      if (s.mdd > 20) reasons.push(`MDD>20`);
      if (s.noTop10 < 0) reasons.push(`Top10<0`);
      if (reasons.length === 0) verdict = '✓ PASS';
      else verdict = '✗ ' + reasons.join(',');

      L.push(`${pad(v.name, 24)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${padS(fmt(s.monthlyAvg), 7)} | ${padS(s.wr.toFixed(0)+'%', 4)} | ${padS(s.payoff.toFixed(2), 6)} | ${padS(fmt(s.noTop10), 9)} | ${padS(String(s.maxLosingStreak), 6)} | ${verdict}`);
    }
  }

  // ─── Walk-forward 3 fold (baseline cost 0.2%)
  L.push(`\n\n## Walk-forward 3 fold (cost 0.2% baseline)\n`);
  const folds = [
    { name: 'F1: 2025-06~09', start: '2025-06-01', end: '2025-09-30', months: 4 },
    { name: 'F2: 2025-10~26-01', start: '2025-10-01', end: '2026-01-31', months: 4 },
    { name: 'F3: 2026-02~05', start: '2026-02-01', end: '2026-05-31', months: 4 },
  ];

  for (const v of VARIANTS) {
    L.push(`\n### ${v.name}`);
    L.push(`${pad('fold', 20)} | ${padS('n', 4)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('월평균', 7)} | ${padS('WR', 4)} | ${padS('Top10제거', 9)}`);
    L.push('-'.repeat(100));
    let posCount = 0;
    for (const f of folds) {
      const trades = simulate(bars1m, bars15m, fundingDaily, rsi, ema, v, 0.002, f.start, f.end);
      const s = calcStats(trades, f.months);
      if (s.totalReturnPct > 0) posCount++;
      L.push(`${pad(f.name, 20)} | ${padS(String(s.n), 4)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${padS(fmt(s.monthlyAvg), 7)} | ${padS(s.wr.toFixed(0)+'%', 4)} | ${padS(fmt(s.noTop10), 9)}`);
    }
    L.push(`→ pos fold: ${posCount}/3 ${posCount >= 2 ? '✓' : '✗'}`);
  }

  // ─── 분해: best variant 기준 (가장 PF 높은 cost 0.2% cell)
  const best = [...fullCells]
    .filter((c) => c.cost === 0.002 && c.stats.n >= 5)
    .sort((a, b) => b.stats.pf - a.stats.pf)[0];

  if (best) {
    L.push(`\n\n## 분해 분석 (best variant: ${best.variant.name}, cost 0.2%)\n`);

    // 월별
    L.push(`\n### 월별 성과`);
    L.push(`${pad('month', 10)} | ${padS('n', 4)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('WR', 4)}`);
    L.push('-'.repeat(50));
    const byMonth = new Map<string, Trade[]>();
    for (const t of best.trades) {
      if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
      byMonth.get(t.monthKey)!.push(t);
    }
    for (const [m, ts] of [...byMonth.entries()].sort()) {
      const s = calcStats(ts, 1);
      L.push(`${pad(m, 10)} | ${padS(String(ts.length), 4)} | ${padS(fmt(s.totalReturnPct), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.wr.toFixed(0)+'%', 4)}`);
    }

    // exit reason별
    L.push(`\n### Exit reason별`);
    L.push(`${pad('reason', 8)} | ${padS('n', 4)} | ${padS('avgRet', 8)} | ${padS('WR', 4)}`);
    L.push('-'.repeat(40));
    const reasons = ['TP', 'SL', 'TIME', 'END'];
    for (const r of reasons) {
      const ts = best.trades.filter((t) => t.reason === r);
      if (ts.length === 0) { L.push(`${pad(r, 8)} | ${padS('-', 4)} | ${padS('-', 8)} | ${padS('-', 4)}`); continue; }
      const avg = ts.reduce((s, t) => s + t.netReturnPct, 0) / ts.length;
      const wr = ts.filter((t) => t.netReturnPct > 0).length / ts.length * 100;
      L.push(`${pad(r, 8)} | ${padS(String(ts.length), 4)} | ${padS(fmt(avg), 8)} | ${padS(wr.toFixed(0)+'%', 4)}`);
    }

    // F1 vs F2
    L.push(`\n### F1 vs F2 signal`);
    L.push(`${pad('signal', 8)} | ${padS('n', 4)} | ${padS('avgRet', 8)} | ${padS('PF', 5)} | ${padS('WR', 4)}`);
    L.push('-'.repeat(50));
    for (const sig of ['F1', 'F2']) {
      const ts = best.trades.filter((t) => t.signal === sig);
      if (ts.length === 0) { L.push(`${pad(sig, 8)} | ${padS('-', 4)} | ${padS('-', 8)} | ${padS('-', 5)} | ${padS('-', 4)}`); continue; }
      const s = calcStats(ts, 1);
      const avg = ts.reduce((s, t) => s + t.netReturnPct, 0) / ts.length;
      L.push(`${pad(sig, 8)} | ${padS(String(ts.length), 4)} | ${padS(fmt(avg), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.wr.toFixed(0)+'%', 4)}`);
    }
  }

  // ─── 최종 판정
  L.push(`\n\n## 최종 판정 (라비 통과 기준)`);
  L.push(`OOS PF≥1.2, MDD≤20%, Top10제거 양수, cost 0.3% PF≥1.1, cost 0.5% PF≥1.0, n≥50, 2+ fold 양수`);
  L.push('');
  let anyPass = false;
  for (const v of VARIANTS) {
    const c02 = fullCells.find((c) => c.variant.name === v.name && c.cost === 0.002)!.stats;
    const c03 = fullCells.find((c) => c.variant.name === v.name && c.cost === 0.003)!.stats;
    const c05 = fullCells.find((c) => c.variant.name === v.name && c.cost === 0.005)!.stats;
    const pass =
      c02.pf >= 1.2 && c02.mdd <= 20 && c02.noTop10 > 0 && c02.n >= 50 &&
      c03.pf >= 1.1 && c05.pf >= 1.0;
    if (pass) anyPass = true;
    L.push(`  ${v.name.padEnd(24)}: ${pass ? '✓ PASS' : '✗'} (PF ${c02.pf.toFixed(2)}/${c03.pf.toFixed(2)}/${c05.pf.toFixed(2)} @ 0.2/0.3/0.5, MDD ${c02.mdd.toFixed(1)}%, Top10제거 ${fmt(c02.noTop10)}, n=${c02.n})`);
  }
  L.push('');
  L.push(anyPass ? `→ Paper 후보 발견 (라비에게 보고 후 별도 검토)` : `→ R1 폐기 — 라비 기준 미달`);

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R1_FUNDING_SHORT_ENTRY.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
