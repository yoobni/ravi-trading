/**
 * R3: UPBIT_BINANCE_DISLOCATION (daily proxy version).
 *
 * Binance BTC 1m 데이터 없어서 daily만으로 검증.
 *
 * 신호:
 *   discount = (UpbitBTC_KRW / USDT_KRW - BinanceBTC_USDT) / BinanceBTC_USDT × 100  (= 김프 %)
 *   z-score (rolling 30d) 하위 P5 또는 P10 → 진입
 *
 * 진입: 다음 day 시가 (KRW-BTC open)
 * 청산: TP/SL/MAX days (variant) — daily 일봉 path
 *
 * 결과: WR + avgWin/avgLoss/payoff/total + 분해. 라비 통과 기준 표시 안 함.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

interface Bar { ts: number; date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Variant { name: string; tp: number; sl: number; maxDays: number; }
const VARIANTS: Variant[] = [
  { name: 'A_TP1.5_SL1.0_3d', tp: 1.5, sl: -1.0, maxDays: 3 },
  { name: 'B_TP2.5_SL1.5_5d', tp: 2.5, sl: -1.5, maxDays: 5 },
  { name: 'C_TP4.0_SL2.5_10d', tp: 4.0, sl: -2.5, maxDays: 10 },
];

const ZSCORE_WINDOW = 30;
const Z_PERCENTILES = [5, 10]; // 진입 z-score 하위 %
const FEE_RT = 0.001; // 0.1% one-side = 0.2% rt 표현은 r1과 다름
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

  // 매칭 가능한 일자
  const allDates = [...usdt.map((b) => b.date)]
    .filter((d) => btcUsdtMap.has(d) && krwBtcMap.has(d))
    .sort();

  // 일별 discount % 계산
  interface DayPoint { date: string; discount: number; krwBtcOpen: number; krwBtcHigh: number; krwBtcLow: number; krwBtcClose: number; }
  const days: DayPoint[] = [];
  for (const d of allDates) {
    const u = usdtMap.get(d)!;
    const bu = btcUsdtMap.get(d)!;
    const k = krwBtcMap.get(d)!;
    const upbitUsd = k.close / u.close;
    const discount = (upbitUsd - bu.close) / bu.close * 100; // 김프 (양수면 upbit 비쌈)
    days.push({ date: d, discount, krwBtcOpen: k.open, krwBtcHigh: k.high, krwBtcLow: k.low, krwBtcClose: k.close });
  }
  console.log(`\n=== R3: UPBIT_BINANCE_DISLOCATION ===`);
  console.log(`Matched days: ${days.length} (${days[0].date} ~ ${days[days.length - 1].date})\n`);

  // z-score (rolling 30d) — 음수 discount일수록 z-score 음수 (= upbit이 저평가)
  // 하위 5/10% z-score = upbit 매수 기회
  const zscores: (number | null)[] = days.map((_, i) => {
    if (i < ZSCORE_WINDOW) return null;
    const window = days.slice(i - ZSCORE_WINDOW, i).map((d) => d.discount);
    const m = window.reduce((s, v) => s + v, 0) / window.length;
    const v = window.reduce((s, x) => s + (x - m) ** 2, 0) / window.length;
    const std = Math.sqrt(v);
    if (std === 0) return 0;
    return (days[i].discount - m) / std;
  });

  // 모든 z-score 분포 출력
  const validZ = zscores.filter((z): z is number => z != null);
  console.log(`Discount z-score 분포:`);
  console.log(`  min=${Math.min(...validZ).toFixed(2)}, max=${Math.max(...validZ).toFixed(2)}`);
  console.log(`  p5=${percentile(validZ, 5).toFixed(2)}, p10=${percentile(validZ, 10).toFixed(2)}, p50=${percentile(validZ, 50).toFixed(2)}, p90=${percentile(validZ, 90).toFixed(2)}\n`);

  // Variant × z-cutoff × cost simulate
  interface Cell { name: string; trades: Trade[]; }
  const cells: Cell[] = [];

  function simulate(zCutoff: number, v: Variant, cost: number): Trade[] {
    const trades: Trade[] = [];
    let cooldownUntil = -1; // idx
    for (let i = ZSCORE_WINDOW; i < days.length - 1; i++) {
      if (i < cooldownUntil) continue;
      const z = zscores[i];
      if (z == null) continue;
      if (z >= zCutoff) continue; // 하위 z일 때만

      // 다음 day 시가 진입
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
        if (bar.krwBtcLow <= slPrice) {
          exitIdx = idx; exitPrice = slPrice; reason = 'SL'; rawReturn = v.sl; break;
        }
        if (bar.krwBtcHigh >= tpPrice) {
          exitIdx = idx; exitPrice = tpPrice; reason = 'TP'; rawReturn = v.tp; break;
        }
        if (d === v.maxDays - 1) {
          exitIdx = idx; exitPrice = bar.krwBtcClose;
          rawReturn = (bar.krwBtcClose - entryPriceRaw) / entryPriceRaw * 100;
          reason = 'TIME';
        }
      }
      const netReturn = rawReturn - cost * 100;
      trades.push({
        signalDate: days[i].date,
        entryDate: entryDay.date,
        entryPrice: entryPriceRaw,
        exitDate: days[exitIdx].date,
        exitPrice,
        zscore: z, discount: days[i].discount,
        reason,
        rawReturnPct: rawReturn, netReturnPct: netReturn,
        monthKey: days[i].date.slice(0, 7),
      });
      cooldownUntil = exitIdx + 1;
    }
    return trades;
  }

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R3: UPBIT_BINANCE_DISLOCATION (daily proxy — Binance BTC 1m 데이터 없음)`);
  L.push(`Period: ${days[ZSCORE_WINDOW].date} ~ ${days[days.length-1].date} (~${((days.length - ZSCORE_WINDOW) / 30).toFixed(1)} months)`);
  L.push('='.repeat(140));

  L.push(`\n## Raw 결과 (WR / 이익률 중심, 통과 기준 표시 안 함)\n`);
  L.push(`${pad('config (z_cut + variant + cost)', 42)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgWin', 7)} | ${padS('avgLoss', 7)} | ${padS('payoff', 6)} | ${padS('totalRet', 9)} | ${padS('PF', 5)}`);
  L.push('-'.repeat(140));

  // z-cutoff 계산 (-1.65 ≈ p5, -1.28 ≈ p10)
  const zCutoffMap: Record<number, number> = {
    5: percentile(validZ, 5),
    10: percentile(validZ, 10),
  };

  for (const zP of Z_PERCENTILES) {
    const cutoff = zCutoffMap[zP];
    for (const v of VARIANTS) {
      for (const cost of COST_LEVELS) {
        const trades = simulate(cutoff, v, cost);
        const wins = trades.filter((t) => t.netReturnPct > 0);
        const losses = trades.filter((t) => t.netReturnPct <= 0);
        const n = trades.length;
        const wr = n ? wins.length / n * 100 : 0;
        const avgWin = wins.length ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
        const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
        const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
        const total = trades.reduce((s, t) => s + t.netReturnPct, 0);
        const totalWin = wins.reduce((s, t) => s + t.netReturnPct, 0);
        const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturnPct, 0));
        const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
        cells.push({ name: `z${zP}_${v.name}_c${cost}`, trades });
        L.push(`${pad(`z<${cutoff.toFixed(2)} (p${zP}) ${v.name}`, 32)} | ${padS((cost*100).toFixed(1)+'%', 5)} | ${padS(String(n), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(avgWin), 7)} | ${padS(fmt(avgLoss), 7)} | ${padS(payoff.toFixed(2), 6)} | ${padS(fmt(total), 9)} | ${padS(pf.toFixed(2), 5)}`);
      }
    }
  }

  // 분해: best PF cell
  const best = [...cells].filter((c) => c.trades.length >= 5).sort((a, b) => {
    const aTotal = a.trades.reduce((s, t) => s + t.netReturnPct, 0);
    const bTotal = b.trades.reduce((s, t) => s + t.netReturnPct, 0);
    return bTotal - aTotal;
  })[0];

  if (best) {
    L.push(`\n## 분해 분석 (best total return: ${best.name}, n=${best.trades.length})\n`);

    // 분기별
    L.push(`### 분기별 성과`);
    L.push(`${pad('quarter', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('avgRet', 8)}`);
    L.push('-'.repeat(60));
    const byQuarter = new Map<string, Trade[]>();
    for (const t of best.trades) {
      const q = t.monthKey.slice(0, 4) + 'Q' + Math.ceil(parseInt(t.monthKey.slice(5, 7)) / 3);
      if (!byQuarter.has(q)) byQuarter.set(q, []);
      byQuarter.get(q)!.push(t);
    }
    for (const [q, ts] of [...byQuarter.entries()].sort()) {
      const wins = ts.filter((t) => t.netReturnPct > 0);
      const wr = ts.length ? wins.length / ts.length * 100 : 0;
      const total = ts.reduce((s, t) => s + t.netReturnPct, 0);
      const avg = total / ts.length;
      L.push(`${pad(q, 10)} | ${padS(String(ts.length), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(total), 9)} | ${padS(fmt(avg), 8)}`);
    }

    // Exit reason
    L.push(`\n### Exit reason별`);
    L.push(`${pad('reason', 8)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('avgRet', 8)}`);
    L.push('-'.repeat(40));
    for (const r of ['TP', 'SL', 'TIME']) {
      const ts = best.trades.filter((t) => t.reason === r);
      if (ts.length === 0) { L.push(`${pad(r, 8)} | ${padS('-', 4)} | ${padS('-', 5)} | ${padS('-', 8)}`); continue; }
      const wins = ts.filter((t) => t.netReturnPct > 0);
      const wr = wins.length / ts.length * 100;
      const avg = ts.reduce((s, t) => s + t.netReturnPct, 0) / ts.length;
      L.push(`${pad(r, 8)} | ${padS(String(ts.length), 4)} | ${padS(wr.toFixed(0)+'%', 5)} | ${padS(fmt(avg), 8)}`);
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R3_DISLOCATION.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
