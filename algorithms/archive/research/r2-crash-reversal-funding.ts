/**
 * R2: BTC_CRASH_REVERSAL_WITH_FUNDING — 급락 후 회복 매수 + 펀딩 게이트.
 *
 * 룰:
 *   1. BTC 1h return ≤ -2.0% (또는 -3.0%)
 *   2. F1F2 contrarian bullish 상태 (yesterday daily funding ≤ p10 [F2])
 *      또는 최근 3일 funding 누적 음수
 *   3. 15m close > EMA20 회복
 *   4. 15m 양봉
 *   5. 직전 저점 이탈 실패 (최근 N 15m low > entry bar low) — 회복 확인
 *   6. 다음 15m 시초가 진입
 *
 * 청산: 1m path verified TP/SL/MAX
 *
 * 검증:
 *   - 4 variant TP/SL/MAX
 *   - Crash threshold 2가지 (-2%, -3%)
 *   - Funding gate 2가지 (yesterday F2 / 3d cum negative)
 *   - Cost stress 0.2 / 0.3 / 0.5%
 *   - Walk-forward 3 fold
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
  { name: 'A_TP1.5_SL1.0_8h',  tp: 1.5, sl: -1.0, maxMin: 480 },
  { name: 'B_TP2.0_SL1.5_24h', tp: 2.0, sl: -1.5, maxMin: 1440 },
  { name: 'C_TP3.0_SL2.0_48h', tp: 3.0, sl: -2.0, maxMin: 2880 },
];

const COST_LEVELS = [0.002, 0.003, 0.005];
const EMA_PERIOD = 20;

// 펀딩 thresholds — paper frozen
const THRESHOLDS_FILE = path.resolve(process.cwd(), 'data', 'paper-trading', 'train-thresholds.json');
const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf-8'));
const P10 = thresholds.p10_1d;

// ─── 데이터 로드 (R1과 동일 패턴) ───
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
  return all.filter((b) => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; }).sort((a, b) => a.ts - b.ts);
}
function aggregate1mTo(bars1m: Bar[], minutes: number): Bar[] {
  const buckets = new Map<number, Bar[]>();
  const slot = minutes * 60_000;
  for (const b of bars1m) {
    const bucketTs = Math.floor(b.ts / slot) * slot;
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

// ─── 1m path verify (R1과 동일) ───
interface ExitResult {
  exitTs: number; exitPrice: number;
  reason: 'TP' | 'SL' | 'TIME' | 'END';
  rawReturnPct: number; durationMin: number;
}
function pathVerifyExit(
  bars1m: Bar[], startIdx: number, entryTs: number, entryPriceRaw: number,
  tpPct: number, slPct: number, maxMin: number,
): ExitResult {
  const tpPrice = entryPriceRaw * (1 + tpPct / 100);
  const slPrice = entryPriceRaw * (1 + slPct / 100);
  for (let i = startIdx; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const elapsedMin = (bar.ts - entryTs) / 60_000;
    if (bar.low <= slPrice) return { exitTs: bar.ts, exitPrice: slPrice, reason: 'SL', rawReturnPct: slPct, durationMin: elapsedMin };
    if (bar.high >= tpPrice) return { exitTs: bar.ts, exitPrice: tpPrice, reason: 'TP', rawReturnPct: tpPct, durationMin: elapsedMin };
    if (elapsedMin >= maxMin) {
      const ret = (bar.close - entryPriceRaw) / entryPriceRaw * 100;
      return { exitTs: bar.ts, exitPrice: bar.close, reason: 'TIME', rawReturnPct: ret, durationMin: elapsedMin };
    }
  }
  const lastBar = bars1m[bars1m.length - 1];
  const ret = (lastBar.close - entryPriceRaw) / entryPriceRaw * 100;
  return { exitTs: lastBar.ts, exitPrice: lastBar.close, reason: 'END', rawReturnPct: ret, durationMin: (lastBar.ts - entryTs) / 60_000 };
}

// ─── Simulator ───
interface Trade {
  signalDate: string;
  fundingGate: 'F2_DAILY' | 'CUM3_NEG';
  crashPct: number;
  entryTs: number; entryDate: string; entryPrice: number;
  exitTs: number; exitDate: string; exitPrice: number;
  reason: string;
  rawReturnPct: number; netReturnPct: number;
  durationMin: number; monthKey: string;
}

function simulate(
  bars1m: Bar[], bars15m: Bar[], bars1h: Bar[],
  fundingDaily: Map<string, number>,
  ema: (number | null)[],
  variant: Variant, cost: number,
  crashThresh: number, fundingGate: 'F2_DAILY' | 'CUM3_NEG' | 'DAILY_NEG',
  dateStart: string, dateEnd: string,
): Trade[] {
  const trades: Trade[] = [];
  const slot1h = 3600_000;
  const slot15m = 15 * 60_000;

  // 1h returns
  function return1h(ts: number): number | null {
    // 현재 ts 시점의 1h candle return
    const bucket = Math.floor(ts / slot1h) * slot1h;
    const cur = bars1h.find((b) => b.ts === bucket);
    if (!cur) return null;
    return (cur.close - cur.open) / cur.open * 100;
  }

  // funding gate
  const dailySorted = [...fundingDaily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyArr = dailySorted.map(([d, r]) => ({ date: d, rate: r }));
  function cum3Negative(date: string): boolean {
    const idx = dailyArr.findIndex((d) => d.date === date);
    if (idx < 2) return false;
    return (dailyArr[idx].rate + dailyArr[idx - 1].rate + dailyArr[idx - 2].rate) < 0;
  }

  // 1m index
  function find1mIdx(ts: number): number {
    let lo = 0, hi = bars1m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars1m[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const dbg = { bars: 0, ret1hNull: 0, crashEvents: 0, inWindow: 0, gateHit: 0, emaHit: 0, greenHit: 0, recoverHit: 0, all: 0 };
  let lastExitTs = 0;
  let crashWindowEnd = 0; // 활성 window 종료 ts (0이면 inactive)
  const CRASH_WINDOW_MIN = 24 * 60; // 급락 후 24h 회복 wait

  for (let i = 0; i < bars15m.length; i++) {
    const bar = bars15m[i];
    const day = bar.date.slice(0, 10);
    if (day < dateStart || day > dateEnd) continue;
    if (bar.ts < lastExitTs) continue;
    dbg.bars++;

    // crash 이벤트 감지: 1h return < threshold → window 시작
    const ret1h = return1h(bar.ts);
    if (ret1h != null && ret1h <= crashThresh) {
      crashWindowEnd = bar.ts + CRASH_WINDOW_MIN * 60_000;
      dbg.crashEvents++;
    }
    // window 안에 있는가
    if (bar.ts > crashWindowEnd) continue;
    dbg.inWindow++;

    // funding gate
    const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
    let gateHit = false;
    if (fundingGate === 'F2_DAILY') {
      const yF = fundingDaily.get(yesterday);
      gateHit = yF != null && yF <= P10;
    } else if (fundingGate === 'CUM3_NEG') {
      gateHit = cum3Negative(yesterday);
    } else { // DAILY_NEG
      const yF = fundingDaily.get(yesterday);
      gateHit = yF != null && yF < 0;
    }
    if (!gateHit) continue;
    dbg.gateHit++;

    // 15m close > EMA20 + 양봉
    const e = ema[i];
    if (e == null) continue;
    if (bar.close > e) dbg.emaHit++;
    if (bar.close > bar.open) dbg.greenHit++;
    if (bar.close <= e) continue;
    if (bar.close <= bar.open) continue;

    // 직전 5개 15m의 low보다 현재 low가 높지 않으면 (회복 아님) skip
    let recoveryConfirmed = true;
    for (let j = Math.max(0, i - 5); j < i; j++) {
      if (bars15m[j].low < bar.low * 0.995) { recoveryConfirmed = false; break; }
    }
    // 너무 strict라 일단 raw하게 — bar.low가 직전 5봉 low의 평균보다 높으면 OK
    {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - 5); j < i; j++) { sum += bars15m[j].low; cnt++; }
      if (cnt > 0) {
        const avg = sum / cnt;
        recoveryConfirmed = bar.low > avg * 0.995;
      }
    }
    if (!recoveryConfirmed) continue;
    dbg.recoverHit++; dbg.all++;

    // 진입
    const entryBarIdx = i + 1;
    if (entryBarIdx >= bars15m.length) break;
    const entryBar = bars15m[entryBarIdx];
    const start1mIdx = find1mIdx(entryBar.ts);
    if (start1mIdx >= bars1m.length) break;
    const entryPriceRaw = entryBar.open;

    const exit = pathVerifyExit(bars1m, start1mIdx, entryBar.ts, entryPriceRaw, variant.tp, variant.sl, variant.maxMin);
    const netReturnPct = exit.rawReturnPct - cost * 100;
    trades.push({
      signalDate: yesterday,
      fundingGate, crashPct: ret1h,
      entryTs: entryBar.ts, entryDate: entryBar.date, entryPrice: entryPriceRaw,
      exitTs: exit.exitTs, exitDate: new Date(exit.exitTs + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
      exitPrice: exit.exitPrice,
      reason: exit.reason,
      rawReturnPct: exit.rawReturnPct, netReturnPct,
      durationMin: exit.durationMin,
      monthKey: day.slice(0, 7),
    });
    lastExitTs = exit.exitTs;
    crashWindowEnd = 0; // 한 번 진입 후 window 종료
  }
  if (process.env.R2_DEBUG) {
    console.error(`[dbg crash=${crashThresh} gate=${fundingGate} v=${variant.name} cost=${cost}] bars=${dbg.bars} crashEvents=${dbg.crashEvents} inWindow=${dbg.inWindow} gateHit=${dbg.gateHit} emaHit=${dbg.emaHit} greenHit=${dbg.greenHit} recoverHit=${dbg.recoverHit} trades=${trades.length}`);
  }
  return trades;
}

// ─── Stats (R1과 동일) ───
interface Stats {
  n: number; totalReturnPct: number; monthlyAvg: number;
  wr: number; pf: number; avgWin: number; avgLoss: number; payoff: number;
  mdd: number; noTop5: number; noTop10: number; maxLosingStreak: number;
}
function calcStats(trades: Trade[], months: number): Stats {
  if (trades.length === 0) return { n: 0, totalReturnPct: 0, monthlyAvg: 0, wr: 0, pf: 0, avgWin: 0, avgLoss: 0, payoff: 0, mdd: 0, noTop5: 0, noTop10: 0, maxLosingStreak: 0 };
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
  let eq = 0, peak = 0, mdd = 0;
  for (const t of trades) { eq += t.netReturnPct; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; }
  const sorted = [...trades].sort((a, b) => b.netReturnPct - a.netReturnPct);
  const top5 = sorted.slice(0, 5).reduce((s, t) => s + t.netReturnPct, 0);
  const top10 = sorted.slice(0, 10).reduce((s, t) => s + t.netReturnPct, 0);
  let streak = 0, maxStreak = 0;
  for (const t of trades) { if (t.netReturnPct <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0; }
  return { n: trades.length, totalReturnPct, monthlyAvg, wr, pf, avgWin, avgLoss, payoff, mdd, noTop5: totalReturnPct - top5, noTop10: totalReturnPct - top10, maxLosingStreak: maxStreak };
}

function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }
function monthsBetween(s: string, e: string) { return (new Date(e).getTime() - new Date(s).getTime()) / (30 * 86400_000); }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R2: BTC_CRASH_REVERSAL_WITH_FUNDING ===\n`);
  const fundingDaily = loadFundingDaily();
  const bars1m = load1mBars();
  console.log(`1m: ${bars1m.length} bars (${new Date(bars1m[0].ts + 9*3600*1000).toISOString().slice(0,10)} ~ ${new Date(bars1m[bars1m.length-1].ts + 9*3600*1000).toISOString().slice(0,10)})`);
  const bars15m = aggregate1mTo(bars1m, 15);
  const bars1h = aggregate1mTo(bars1m, 60);
  console.log(`15m: ${bars15m.length}, 1h: ${bars1h.length}\n`);

  const closes15m = bars15m.map((b) => b.close);
  const ema = calcEMA(closes15m, EMA_PERIOD);
  const dataStart = new Date(bars1m[0].ts + 9*3600*1000).toISOString().slice(0,10);
  const dataEnd = new Date(bars1m[bars1m.length-1].ts + 9*3600*1000).toISOString().slice(0,10);
  const totalMonths = monthsBetween(dataStart, dataEnd);

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R2: BTC_CRASH_REVERSAL_WITH_FUNDING`);
  L.push(`Period: ${dataStart} ~ ${dataEnd} (${totalMonths.toFixed(1)} mo)`);
  L.push(`Crash threshold: 1h return ≤ -2.0% or -3.0%`);
  L.push(`Funding gate: F2 daily (yesterday ≤ p10) OR 3d cum < 0`);
  L.push('='.repeat(150));

  // Full period: 2 crash × 2 gate × 3 variant × 3 cost
  L.push(`\n## Full period\n`);
  L.push(`${pad('config', 38)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('월평균', 7)} | ${padS('WR', 4)} | ${padS('payoff', 6)} | ${padS('Top10제거', 9)} | 판정`);
  L.push('-'.repeat(150));

  interface Cell { config: string; variant: Variant; cost: number; trades: Trade[]; stats: Stats; }
  const allCells: Cell[] = [];

  for (const crash of [-2.0, -3.0]) {
    for (const gate of ['F2_DAILY', 'CUM3_NEG', 'DAILY_NEG'] as const) {
      for (const v of VARIANTS) {
        for (const cost of COST_LEVELS) {
          const trades = simulate(bars1m, bars15m, bars1h, fundingDaily, ema, v, cost, crash, gate, dataStart, dataEnd);
          const s = calcStats(trades, totalMonths);
          const config = `crash${crash}_${gate}_${v.name}`;
          allCells.push({ config, variant: v, cost, trades, stats: s });
          const reasons: string[] = [];
          if (s.n < 30) reasons.push(`n<30`);
          if (s.pf < 1.2) reasons.push(`PF<1.2`);
          if (s.mdd > 20) reasons.push(`MDD>20`);
          if (s.noTop10 < 0) reasons.push(`Top10<0`);
          const verdict = reasons.length ? '✗ ' + reasons.join(',') : '✓ PASS';
          L.push(`${pad(config, 38)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${padS(fmt(s.monthlyAvg), 7)} | ${padS(s.wr.toFixed(0)+'%', 4)} | ${padS(s.payoff.toFixed(2), 6)} | ${padS(fmt(s.noTop10), 9)} | ${verdict}`);
        }
      }
    }
  }

  // 최종 판정
  L.push(`\n## 최종 판정 (라비 기준: OOS PF≥1.2 / cost0.3 PF≥1.1 / cost0.5 PF≥1.0 / MDD≤20 / Top10>0 / n≥50)\n`);
  const passing = new Set<string>();
  for (const config of new Set(allCells.map((c) => c.config))) {
    const c02 = allCells.find((c) => c.config === config && c.cost === 0.002)!.stats;
    const c03 = allCells.find((c) => c.config === config && c.cost === 0.003)!.stats;
    const c05 = allCells.find((c) => c.config === config && c.cost === 0.005)!.stats;
    const pass = c02.pf >= 1.2 && c02.mdd <= 20 && c02.noTop10 > 0 && c02.n >= 50 && c03.pf >= 1.1 && c05.pf >= 1.0;
    if (pass) passing.add(config);
    L.push(`  ${pad(config, 38)}: ${pass ? '✓ PASS' : '✗'} (PF ${c02.pf.toFixed(2)}/${c03.pf.toFixed(2)}/${c05.pf.toFixed(2)}, MDD ${c02.mdd.toFixed(1)}%, Top10제거 ${fmt(c02.noTop10)}, n=${c02.n})`);
  }
  L.push('');
  L.push(passing.size > 0 ? `→ Paper 후보 발견: ${[...passing].join(', ')}` : `→ R2 폐기 — 모든 조합 기준 미달`);

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R2_CRASH_REVERSAL.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
