/**
 * Research Round 3 — R7 / R8 / R9 동시 실행 (1년: 2025-06-09 ~ 2026-06-09).
 *
 * R7 MULTI_SIGNAL_CONFLUENCE
 *   김프 z-score(60d) ≤ -1.5 + F2 daily funding(어제 ≤ p10) + volume z-score(30d) ≥ +1.5
 *   셋 다 동시 만족 → 다음 day 매수
 *
 * R8 WEEKLY_FUNDING
 *   7d cumulative funding p10/p90 (train period 2019-09 ~ 2024-01)
 *   다음 day 매수 (LONG, paper와 동일 contrarian)
 *
 * R9 TIME_OF_DAY
 *   F1F2 신호 (paper와 동일) + entry 시각 변형
 *   KST 09:00 (paper) / KST 13:00 / KST 17:00 / KST 21:00 / KST 01:00 (D+1)
 *   1m bars로 정확한 entry price + 1m path verify
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const ANALYSIS_START = '2025-06-09';
const ANALYSIS_END = '2026-06-09';
const COST_LEVELS = [0.002, 0.003, 0.005];

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface FundingPoint { ts: number; date: string; rate: number; }

interface Variant { name: string; tp: number; sl: number; maxDays: number; }
const DAILY_VARIANTS: Variant[] = [
  { name: 'A_TP1.5_SL1.0_3d', tp: 1.5, sl: -1.0, maxDays: 3 },
  { name: 'B_TP2.5_SL1.5_5d', tp: 2.5, sl: -1.5, maxDays: 5 },
  { name: 'C_TP4.0_SL2.5_10d', tp: 4.0, sl: -2.5, maxDays: 10 },
];

function load(file: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
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

function simulateDailyExit(bars: Bar[], entryIdx: number, entryPriceRaw: number, v: Variant) {
  const tpPrice = entryPriceRaw * (1 + v.tp / 100);
  const slPrice = entryPriceRaw * (1 + v.sl / 100);
  for (let d = 0; d < v.maxDays; d++) {
    const idx = entryIdx + d;
    if (idx >= bars.length) {
      const last = bars[bars.length - 1];
      return { exitIdx: bars.length - 1, exitPrice: last.close, reason: 'TIME' as const, rawReturn: (last.close - entryPriceRaw) / entryPriceRaw * 100 };
    }
    const bar = bars[idx];
    if (bar.low <= slPrice) return { exitIdx: idx, exitPrice: slPrice, reason: 'SL' as const, rawReturn: v.sl };
    if (bar.high >= tpPrice) return { exitIdx: idx, exitPrice: tpPrice, reason: 'TP' as const, rawReturn: v.tp };
    if (d === v.maxDays - 1) return { exitIdx: idx, exitPrice: bar.close, reason: 'TIME' as const, rawReturn: (bar.close - entryPriceRaw) / entryPriceRaw * 100 };
  }
  const last = bars[bars.length - 1];
  return { exitIdx: bars.length - 1, exitPrice: last.close, reason: 'TIME' as const, rawReturn: (last.close - entryPriceRaw) / entryPriceRaw * 100 };
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
  const byMonth = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
    byMonth.get(t.monthKey)!.push(t);
  }
  let cum = 0;
  for (const mk of monthList()) {
    const ts = byMonth.get(mk) ?? [];
    const s = statsFor(ts);
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

  // 데이터
  const krwBtc: Bar[] = load('KRW-BTC_daily_1800d_asof_2026-06-08.json').sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
  const krwBtcMap = new Map(krwBtc.map((b) => [b.date, b]));
  const usdt: Bar[] = load('KRW-USDT_daily_1800d_asof_2026-06-01.json');
  const btcUsdt: Bar[] = load('BINANCE_BTCUSDT_daily_1800d.json');
  const usdtMap = new Map(usdt.map((b) => [b.date, b]));
  const btcUsdtMap = new Map(btcUsdt.map((b) => [b.date, b]));
  const funding: FundingPoint[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'));
  const fundingDaily = new Map<string, number>();
  for (const p of funding) fundingDaily.set(p.date, (fundingDaily.get(p.date) ?? 0) + p.rate);
  const thr = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data', 'paper-trading', 'train-thresholds.json'), 'utf-8'));

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`Research Round 3 — R7 / R8 / R9 (period: ${ANALYSIS_START} ~ ${ANALYSIS_END})`);
  L.push('='.repeat(140));

  // ─── R7 MULTI_SIGNAL_CONFLUENCE ───
  // discount z-score 60d
  const dates = [...usdt.map((b) => b.date)].filter((d) => btcUsdtMap.has(d) && krwBtcMap.has(d)).sort();
  interface DP { date: string; discount: number; }
  const dps: DP[] = [];
  for (const d of dates) {
    const u = usdtMap.get(d)!; const bu = btcUsdtMap.get(d)!; const k = krwBtcMap.get(d)!;
    dps.push({ date: d, discount: (k.close / u.close - bu.close) / bu.close * 100 });
  }
  const Z_W = 60;
  const disZ: (number | null)[] = dps.map((_, i) => {
    if (i < Z_W) return null;
    const win = dps.slice(i - Z_W, i).map((d) => d.discount);
    const m = win.reduce((s, v) => s + v, 0) / win.length;
    const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length;
    const std = Math.sqrt(v);
    return std === 0 ? 0 : (dps[i].discount - m) / std;
  });
  const disZByDate = new Map(dps.map((d, i) => [d.date, disZ[i]]));

  // volume z-score 30d (KRW-BTC daily)
  const volWin = 30;
  const volZ: (number | null)[] = krwBtc.map((_, i) => {
    if (i < volWin) return null;
    const vols = krwBtc.slice(i - volWin, i).map((b) => b.volume);
    const m = vols.reduce((s, v) => s + v, 0) / vols.length;
    const v = vols.reduce((s, x) => s + (x - m) ** 2, 0) / vols.length;
    const std = Math.sqrt(v);
    return std === 0 ? 0 : (krwBtc[i].volume - m) / std;
  });
  const volZByDate = new Map(krwBtc.map((b, i) => [b.date, volZ[i]]));

  L.push(`\n## R7: MULTI_SIGNAL_CONFLUENCE`);
  L.push(`(김프 z(60d) ≤ -1.5) AND (어제 funding ≤ p10) AND (volume z(30d) ≥ +1.5)\n`);

  function simR7(v: Variant, cost: number, disThresh: number, volThresh: number): Trade[] {
    const trades: Trade[] = [];
    let cooldownIdx = -1;
    for (let i = 0; i < krwBtc.length - 1; i++) {
      const day = krwBtc[i].date;
      if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
      if (i < cooldownIdx) continue;
      const dz = disZByDate.get(day);
      const vz = volZByDate.get(day);
      if (dz == null || vz == null) continue;
      if (dz > disThresh) continue;
      if (vz < volThresh) continue;
      const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
      const yF = fundingDaily.get(yesterday);
      if (yF == null || yF > thr.p10_1d) continue;

      const entryIdx = i + 1;
      const entryDay = krwBtc[entryIdx];
      const exit = simulateDailyExit(krwBtc, entryIdx, entryDay.open, v);
      const netReturn = exit.rawReturn - cost * 100;
      trades.push({
        signalDate: day, entryDate: entryDay.date, entryPrice: entryDay.open,
        exitDate: krwBtc[exit.exitIdx].date, exitPrice: exit.exitPrice,
        reason: exit.reason, rawReturnPct: exit.rawReturn, netReturnPct: netReturn,
        monthKey: day.slice(0, 7),
      });
      cooldownIdx = exit.exitIdx + 1;
    }
    return trades;
  }

  L.push(`### 월별 (B variant, cost 0.2%, disZ≤-1.5 + volZ≥1.5)`);
  L.push(...monthlyTable(simR7(DAILY_VARIANTS[1], 0.002, -1.5, 1.5)));

  L.push(`\n### 1년 합계 sweep`);
  L.push(`${pad('config', 32)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(72));
  for (const [dis, vol] of [[-1.5, 1.5], [-1.0, 1.0], [-2.0, 2.0]] as const) {
    for (const v of DAILY_VARIANTS) {
      for (const cost of COST_LEVELS) {
        const trades = simR7(v, cost, dis, vol);
        const s = statsFor(trades);
        L.push(`${pad(`disZ≤${dis} volZ≥${vol} ${v.name}`, 32)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
    }
  }

  // ─── R8 WEEKLY_FUNDING ───
  // 7d cumulative funding on each day
  const sortedDays = [...fundingDaily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const cum7: { date: string; cum: number }[] = [];
  for (let i = 6; i < sortedDays.length; i++) {
    let sum = 0;
    for (let j = i - 6; j <= i; j++) sum += sortedDays[j][1];
    cum7.push({ date: sortedDays[i][0], cum: sum });
  }
  // Train period (2019-09 ~ 2024-01) thresholds
  const TRAIN_END = '2024-01-01';
  const trainCum7 = cum7.filter((c) => c.date < TRAIN_END).map((c) => c.cum);
  function pct(arr: number[], p: number): number {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * p / 100)];
  }
  const cum7P10 = pct(trainCum7, 10);
  const cum7P90 = pct(trainCum7, 90);
  const cum7ByDate = new Map(cum7.map((c) => [c.date, c.cum]));

  L.push(`\n\n## R8: WEEKLY_FUNDING`);
  L.push(`7d cumulative funding train(${TRAIN_END} 이전) p10=${cum7P10.toFixed(4)}, p90=${cum7P90.toFixed(4)}`);
  L.push(`신호: 어제 cum7 ≤ p10 (음수 극단) → 다음 day 매수\n`);

  function simR8(v: Variant, cost: number, useNegative: boolean): Trade[] {
    const trades: Trade[] = [];
    let cooldownIdx = -1;
    for (let i = 0; i < krwBtc.length - 1; i++) {
      const day = krwBtc[i].date;
      if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
      if (i < cooldownIdx) continue;
      const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
      const c7 = cum7ByDate.get(yesterday);
      if (c7 == null) continue;
      const hit = useNegative ? c7 <= cum7P10 : c7 >= cum7P90;
      if (!hit) continue;

      const entryIdx = i + 1;
      const entryDay = krwBtc[entryIdx];
      const exit = simulateDailyExit(krwBtc, entryIdx, entryDay.open, v);
      const netReturn = exit.rawReturn - cost * 100;
      trades.push({
        signalDate: day, entryDate: entryDay.date, entryPrice: entryDay.open,
        exitDate: krwBtc[exit.exitIdx].date, exitPrice: exit.exitPrice,
        reason: exit.reason, rawReturnPct: exit.rawReturn, netReturnPct: netReturn,
        monthKey: day.slice(0, 7),
      });
      cooldownIdx = exit.exitIdx + 1;
    }
    return trades;
  }

  for (const useNeg of [true, false] as const) {
    L.push(`### ${useNeg ? 'cum7 ≤ p10 (음수)' : 'cum7 ≥ p90 (양수)'} — 월별 (B variant cost 0.2%)`);
    L.push(...monthlyTable(simR8(DAILY_VARIANTS[1], 0.002, useNeg)));
    L.push('');
  }

  L.push(`### R8 1년 합계 sweep`);
  L.push(`${pad('signal + variant', 30)} | ${padS('cost', 5)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(70));
  for (const useNeg of [true, false] as const) {
    for (const v of DAILY_VARIANTS) {
      for (const cost of COST_LEVELS) {
        const trades = simR8(v, cost, useNeg);
        const s = statsFor(trades);
        L.push(`${pad(`${useNeg ? 'NEG' : 'POS'} ${v.name}`, 30)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
      }
    }
  }

  // ─── R9 TIME_OF_DAY ───
  // F1F2 신호 발생 → 다음 day의 다양한 시간대 1m bar의 close로 진입
  // 1m bars 로드
  L.push(`\n\n## R9: TIME_OF_DAY (F1F2 신호 + 진입 시간 변형)`);
  L.push(`1m bars로 정확한 시점 entry price + 1m path verified exit\n`);

  function load1mBars(): Bar[] {
    const files = ['KRW-BTC_1m_2025-06-01_2025-11-30.json', 'KRW-BTC_1m_2025-12-01_2026-05-29.json'];
    const all: Bar[] = [];
    for (const f of files) {
      const arr = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8')) as Bar[];
      for (let i = 0; i < arr.length; i++) all.push(arr[i]);
    }
    const seen = new Set<number>();
    return all.filter((b) => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; }).sort((a, b) => a.ts - b.ts);
  }
  const bars1m = load1mBars();
  L.push(`1m bars: ${bars1m.length}`);

  function find1mIdx(ts: number): number {
    let lo = 0, hi = bars1m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars1m[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 진입 시간 (KST hour) 옵션
  const ENTRY_HOURS = [0, 9, 13, 17, 21]; // KST. 0 = 자정. Paper는 9:30이지만 R9는 09:00 기준.

  // F1F2 paper TP/SL/MAX (8/-5/10d)
  const PAPER_TP = 8, PAPER_SL = -5, PAPER_MAX_DAYS = 10;
  const FEE_RT = 0.002; // 왕복 0.2%

  interface R9Trade extends Trade {
    entryHour: number;
  }

  function simR9(entryHourKst: number): R9Trade[] {
    const trades: R9Trade[] = [];
    let cooldownTs = 0;
    for (let i = 0; i < krwBtc.length - 1; i++) {
      const day = krwBtc[i].date;
      if (day < ANALYSIS_START || day > ANALYSIS_END) continue;
      if (krwBtc[i].ts < cooldownTs) continue;
      // 어제 funding 평가
      const yesterday = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
      const yF = fundingDaily.get(yesterday);
      if (yF == null) continue;
      const isF1 = yF >= thr.p90_1d;
      const isF2 = yF <= thr.p10_1d;
      if (!isF1 && !isF2) continue;

      // 진입 시간 — day의 entryHour KST = UTC (entryHour - 9)
      const entryUtcHour = entryHourKst - 9;
      const dayDate = new Date(day + 'T00:00:00Z');
      const entryTs = dayDate.getTime() + entryUtcHour * 3600_000;
      const entryIdx1m = find1mIdx(entryTs);
      if (entryIdx1m >= bars1m.length) continue;
      const entryBar = bars1m[entryIdx1m];
      const entryPriceRaw = entryBar.open;

      // 1m path verified exit
      const tpPrice = entryPriceRaw * (1 + PAPER_TP / 100);
      const slPrice = entryPriceRaw * (1 + PAPER_SL / 100);
      const maxMs = PAPER_MAX_DAYS * 86400_000;
      let exitTs = entryTs, exitPrice = entryPriceRaw, reason: 'TP' | 'SL' | 'TIME' = 'TIME', rawRet = 0;
      for (let j = entryIdx1m; j < bars1m.length; j++) {
        const b = bars1m[j];
        const elapsed = b.ts - entryTs;
        if (b.low <= slPrice) { exitTs = b.ts; exitPrice = slPrice; reason = 'SL'; rawRet = PAPER_SL; break; }
        if (b.high >= tpPrice) { exitTs = b.ts; exitPrice = tpPrice; reason = 'TP'; rawRet = PAPER_TP; break; }
        if (elapsed >= maxMs) { exitTs = b.ts; exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - entryPriceRaw) / entryPriceRaw * 100; break; }
      }
      const netReturn = rawRet - FEE_RT * 100;
      trades.push({
        signalDate: yesterday, entryDate: day, entryPrice: entryPriceRaw,
        exitDate: new Date(exitTs + 9 * 3600_000).toISOString().slice(0, 10), exitPrice,
        reason, rawReturnPct: rawRet, netReturnPct: netReturn,
        monthKey: day.slice(0, 7), entryHour: entryHourKst,
      });
      cooldownTs = exitTs;
    }
    return trades;
  }

  L.push(`### R9 entry hour 비교 (1년 합계, F1F2 paper 룰, cost 0.2%)`);
  L.push(`${pad('entryHour(KST)', 16)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(75));
  for (const eh of ENTRY_HOURS) {
    const trades = simR9(eh);
    const s = statsFor(trades);
    const label = eh === 0 ? '00:00 (자정)' : `${String(eh).padStart(2, '0')}:00`;
    L.push(`${pad(label, 16)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.avgWin), 7)} | ${padS(fmt(s.avgLoss), 7)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)}`);
  }

  // 각 entry hour 월별 (간단)
  L.push(`\n### KST 09:00 (paper 비슷한 시점) 월별`);
  L.push(...monthlyTable(simR9(9)));
  L.push(`\n### KST 17:00 (펀딩 마감 직후) 월별`);
  L.push(...monthlyTable(simR9(17)));

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R7_R8_R9.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
