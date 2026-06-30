/**
 * R31-verify — 4h TF 후보 4개 (F1/F2/F5/F6) 깊이 검증.
 *
 * 검증 항목:
 *   1. Lookahead-safe 보장:
 *      - 모든 indicator/signal은 bar i까지의 정보만 사용 (j < i 또는 j ≤ i 명시)
 *      - Entry는 sig.barIdx + 1 의 open (다음 bar open, 신호 시점 이후)
 *      - Volume z-score: window [i-30, i-1] + current volumes[i] (bar i close 시점에 알 수 있음)
 *      - BB upper/width at i: closes [i-period+1, i] (bar i close 시점 OK)
 *      - prevMax for breakout: [i-lookback, i-1] (current bar 제외)
 *
 *   2. 코인 의존도:
 *      - 코인별 PnL distribution
 *      - top-1 / top-3 제거 시 PF
 *      - 한 코인 빼도 PF≥1.2 유지하는지 (진짜 분산된 알파인지)
 *
 *   3. BTC regime 의존도 (daily EMA200 above/below)
 *
 *   4. 시기 의존도 — 월별 PnL + cumulative
 *
 *   5. 거래량 의존도 — vol z 분위별
 *
 * Test period: 2024-06-10 ~ 2026-06-10 (2년 strict OOS, R30-9 1년 fluke 입증된 시기 포함)
 * Standalone analysis (cash/position 무관, 1 trade = 1 진입 가정)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.001;
const COINS_15 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function load4hBars(coin: string): CachedBar[] {
  const y1 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2024-06-10_2025-06-10.json`), 'utf-8'));
  const y2 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_240m_2025-06-10_2026-06-10.json`), 'utf-8'));
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const b of y1) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  for (const b of y2) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}
function loadDailyBars(coin: string): CachedBar[] {
  const arr = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_daily_800d_asof_2026-06-11.json`), 'utf-8'));
  return arr.map((b: any) => ({ ts: b.ts, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

function calcEMA(values: number[], period: number): (number|null)[] {
  const k = 2 / (period + 1); const out: (number|null)[] = new Array(values.length).fill(null);
  let ema: number | null = null; let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { sum += values[i]; continue; }
    if (ema === null) { sum += values[i]; ema = sum / period; }
    else ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  } return out;
}
function calcBB(closes: number[], period: number, mult = 2) {
  const n = closes.length;
  const upper: (number|null)[] = new Array(n).fill(null);
  const width: (number|null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    // SAFE: BB at i uses closes [i-period+1, i] inclusive (bar i close 시점에 알 수 있음)
    if (i < period - 1) continue;
    let sum = 0, sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += closes[j]; sum2 += closes[j]*closes[j]; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max((sum2/period) - mean*mean, 0));
    upper[i] = mean + mult*sd;
    width[i] = (2 * mult * sd) / mean;
  }
  return { upper, width };
}
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  // SAFE: window = [i-30, i-1] (current 제외), 현재 volumes[i]는 bar i close 시점에 알 수 있음
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface Signal { barIdx: number; ts: number; volZ: number; }
function sigF1Breakout24(bars: CachedBar[]): Signal[] {
  // SAFE: prevMax uses [i-24, i-1] (current 제외), 신호 check는 bar i close
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 25; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].close <= prevMax && bars[i].close > prevMax)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}
function sigF2Breakout42(bars: CachedBar[]): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].close <= prevMax && bars[i].close > prevMax)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}
function sigF5BBSqueeze(bars: CachedBar[]): Signal[] {
  // SAFE: BB at i uses [i-29, i], minWidth uses [i-50, i-1]
  const closes = bars.map(b => b.close), volumes = bars.map(b => b.volume);
  const bb = calcBB(closes, 30, 2);
  const out: Signal[] = [];
  for (let i = 51; i < bars.length; i++) {
    if (bb.width[i] == null || bb.upper[i] == null) continue;
    let minWidth = Infinity;
    for (let j = i - 50; j < i; j++) if (bb.width[j] != null && bb.width[j]! < minWidth) minWidth = bb.width[j]!;
    if (bb.width[i]! > minWidth * 1.1) continue;
    if (closes[i] <= bb.upper[i]!) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}
function sigF6NewHigh42(bars: CachedBar[]): Signal[] {
  // SAFE: prevMax_prior uses [i-42, i-2] (bar i-1, i 제외)
  //       bar i-1 high를 별도로 check (신고가 발생한 이전 bar)
  //       bar i close가 bar i-1 high 넘었는지 (양봉 + follow-through)
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;     // bar i-1에서 신고가 발생
    if (!(bars[i].close > bars[i].open)) continue; // 양봉
    if (!(bars[i].close > bars[i-1].high)) continue; // follow-through
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

interface Trade {
  coin: string; signalTs: number;
  entryTs: number; entryPrice: number;
  exitTs: number; exitPrice: number;
  rawRet: number; netRet: number;
  reason: 'TP'|'SL'|'TIME';
  monthKey: string; volZ: number;
  btcRegime: 'bull'|'neutral'|'bear';
}

function simulateStandalone(
  bars: CachedBar[], coin: string, signals: Signal[],
  tp: number, sl: number, maxBars: number,
  btcByDate: Map<string, { close: number; ema200: number | null }>,
  periodStartTs: number, periodEndTs: number,
): Trade[] {
  const out: Trade[] = [];
  for (const sig of signals) {
    if (sig.ts < periodStartTs || sig.ts > periodEndTs) continue;
    // Entry: 다음 4h bar open (signal_ts 이후, lookahead-safe)
    const entryIdx = sig.barIdx + 1;
    if (entryIdx >= bars.length) continue;
    const entry = bars[entryIdx];
    const tpP = entry.open * (1 + tp / 100);
    const slP = entry.open * (1 + sl / 100);
    let exitIdx = -1, rawRet = 0, reason: Trade['reason'] = 'TIME';
    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + maxBars); j++) {
      const b = bars[j];
      // 보수적: SL 우선 check
      if (b.low <= slP) { exitIdx = j; rawRet = sl; reason = 'SL'; break; }
      if (b.high >= tpP) { exitIdx = j; rawRet = tp; reason = 'TP'; break; }
    }
    if (exitIdx < 0) {
      const last = Math.min(bars.length - 1, entryIdx + maxBars - 1);
      exitIdx = last;
      rawRet = (bars[last].close - entry.open) / entry.open * 100;
      reason = 'TIME';
    }
    const netRet = rawRet - COST_RT * 100;
    const entryDateKst = new Date(entry.ts + 9 * 3600_000);
    const dateStr = entryDateKst.toISOString().slice(0, 10);
    const monthKey = dateStr.slice(0, 7);
    // BTC regime: D-1 daily close vs EMA200
    const prevDate = new Date(entry.ts + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
    const btc = btcByDate.get(prevDate) || btcByDate.get(dateStr);
    let btcRegime: Trade['btcRegime'] = 'neutral';
    if (btc && btc.ema200 != null) {
      const diff = (btc.close - btc.ema200) / btc.ema200 * 100;
      if (diff > 5) btcRegime = 'bull';
      else if (diff < -5) btcRegime = 'bear';
    }
    out.push({
      coin, signalTs: sig.ts, entryTs: entry.ts, entryPrice: entry.open,
      exitTs: bars[exitIdx].ts,
      exitPrice: reason === 'TP' ? tpP : reason === 'SL' ? slP : bars[exitIdx].close,
      rawRet, netRet, reason, monthKey, volZ: sig.volZ, btcRegime,
    });
  }
  return out;
}

function statsFor(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0 };
  const wins = trades.filter(t => t.netRet > 0);
  const losses = trades.filter(t => t.netRet <= 0);
  const wr = wins.length / n * 100;
  const total = trades.reduce((s, t) => s + t.netRet, 0);
  const winSum = wins.reduce((s, t) => s + t.netRet, 0);
  const lossSum = Math.abs(losses.reduce((s, t) => s + t.netRet, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n, wr, total, pf };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R31-verify (F1/F2/F5/F6 깊이 검증) ===\n`);

  console.log(`Loading 4h + daily bars (15 coins)...`);
  const bars4h = new Map<string, CachedBar[]>();
  for (const coin of COINS_15) bars4h.set(coin, load4hBars(coin));
  const btcDaily = loadDailyBars('BTC');
  const dailyCloses = btcDaily.map(b => b.close);
  const dailyEma200 = calcEMA(dailyCloses, 200);
  const btcByDate = new Map<string, { close: number; ema200: number | null }>();
  for (let i = 0; i < btcDaily.length; i++) {
    btcByDate.set(btcDaily[i].date, { close: btcDaily[i].close, ema200: dailyEma200[i] });
  }

  const algos = [
    { name: 'F1 BREAKOUT24 (4d)',  fn: sigF1Breakout24,  tp: 5, sl: -2, maxBars: 84 },
    { name: 'F2 BREAKOUT42 (7d)',  fn: sigF2Breakout42,  tp: 5, sl: -2, maxBars: 84 },
    { name: 'F5 BB_SQUEEZE 30/50', fn: sigF5BBSqueeze,   tp: 5, sl: -2, maxBars: 84 },
    { name: 'F6 NEW_HIGH 42 (7d)', fn: sigF6NewHigh42,   tp: 5, sl: -2, maxBars: 84 },
  ];

  const pStart = new Date('2024-06-10T00:00:00+09:00').getTime();
  const pEnd = new Date('2026-06-10T23:59:59+09:00').getTime();

  // Build trades per algo
  interface AlgoTrades { name: string; trades: Trade[]; }
  const results: AlgoTrades[] = [];
  for (const algo of algos) {
    const all: Trade[] = [];
    for (const coin of COINS_15) {
      const bars = bars4h.get(coin)!;
      const sigs = algo.fn(bars);
      const tr = simulateStandalone(bars, coin, sigs, algo.tp, algo.sl, algo.maxBars, btcByDate, pStart, pEnd);
      for (const t of tr) all.push(t);
    }
    results.push({ name: algo.name, trades: all });
  }

  const L: string[] = [];
  L.push('='.repeat(150));
  L.push(`R31-verify — F1/F2/F5/F6 깊이 검증 (4h TF, 2년: 2024-06~26-06)`);
  L.push(`Period: standalone (cash/position 무관, trade return 합산). Variant: TP+5%/SL-2%/MAX 14d.`);
  L.push('='.repeat(150));

  // ============ Lookahead 명시 ============
  L.push(`\n## 0) Lookahead-safe 검증`);
  L.push(`  - 모든 signal 평가: bar i close 시점 정보만 사용`);
  L.push(`    · prevMax = max(bars[j].high for j in [i-lookback, i-1])  ← current bar 제외`);
  L.push(`    · BB at i = mean/sd of closes [i-period+1, i]            ← bar i close 시점 알 수 있음`);
  L.push(`    · vol z = (volumes[i] - mean[i-30, i-1]) / sd            ← bar i volume도 close 시점 OK`);
  L.push(`  - Entry: signals[i] → bars[i+1].open  ← signal 이후의 첫 가능 시점`);
  L.push(`  - Exit:  bars[entry..].high/low → TP/SL hit 시점에 청산 (intra-bar, SL 우선 보수)`);
  L.push(`  - 따라서 future price 미리 보는 코드 경로 없음.`);

  // ============ 1) 전체 stats ============
  L.push(`\n## 1) 전체 stats (2년)\n`);
  L.push(`${pad('algo', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 10)} | ${padS('PF', 5)} | TP/SL/TIME`);
  L.push('-'.repeat(80));
  for (const r of results) {
    const st = statsFor(r.trades);
    const tp = r.trades.filter(t => t.reason === 'TP').length;
    const sl = r.trades.filter(t => t.reason === 'SL').length;
    const tm = r.trades.filter(t => t.reason === 'TIME').length;
    L.push(`${pad(r.name, 22)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 10)} | ${padS(st.pf.toFixed(2), 5)} | ${tp}/${sl}/${tm}`);
  }

  // ============ 2) 코인 의존도 ============
  L.push(`\n## 2) 코인 의존도 — 코인별 PnL + top-N 제거 시 PF\n`);
  for (const r of results) {
    L.push(`\n### ${r.name}`);
    const byCoin = new Map<string, Trade[]>();
    for (const t of r.trades) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
      byCoin.get(t.coin)!.push(t);
    }
    const rows = [...byCoin.entries()].map(([coin, trs]) => ({ coin, st: statsFor(trs) }))
      .sort((a, b) => b.st.total - a.st.total);
    const fullSt = statsFor(r.trades);
    L.push(`  ${pad('coin', 6)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('share%', 7)}`);
    L.push(`  ${'-'.repeat(58)}`);
    for (const row of rows) {
      const share = fullSt.total !== 0 ? row.st.total / fullSt.total * 100 : 0;
      L.push(`  ${pad(row.coin, 6)} | ${padS(String(row.st.n), 4)} | ${padS(row.st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(row.st.total), 9)} | ${padS(row.st.pf.toFixed(2), 5)} | ${padS(share.toFixed(0)+'%', 7)}`);
    }
    // top-N 제거
    for (const topN of [1, 3, 5]) {
      const remove = new Set(rows.slice(0, topN).map(r => r.coin));
      const filtered = r.trades.filter(t => !remove.has(t.coin));
      const st = statsFor(filtered);
      const removedTotal = rows.slice(0, topN).reduce((s, r) => s + r.st.total, 0);
      const removedShare = fullSt.total !== 0 ? removedTotal / fullSt.total * 100 : 0;
      L.push(`  → top-${topN} (${[...remove].join(',')}) 제거: n=${st.n}, WR=${st.wr.toFixed(0)}%, total=${fmt(st.total)}, PF=${st.pf.toFixed(2)} | 제거된 share ${removedShare.toFixed(0)}%`);
    }
    // 음수 코인 수
    const negCount = rows.filter(r => r.st.total < 0).length;
    L.push(`  → 음수 PnL 코인: ${negCount}/${rows.length}`);
  }

  // ============ 3) BTC regime ============
  L.push(`\n## 3) 장 흐름 의존 (BTC daily close vs EMA200, ±5% band)\n`);
  for (const r of results) {
    L.push(`\n### ${r.name}`);
    L.push(`  ${pad('regime', 10)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('avg/trade', 9)}`);
    L.push(`  ${'-'.repeat(60)}`);
    for (const reg of ['bull','neutral','bear'] as const) {
      const sub = r.trades.filter(t => t.btcRegime === reg);
      const st = statsFor(sub);
      const avg = st.n ? st.total / st.n : 0;
      L.push(`  ${pad(reg, 10)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(st.pf.toFixed(2), 5)} | ${padS(fmt(avg, false), 9)}`);
    }
  }

  // ============ 4) Vol z 분위 ============
  L.push(`\n## 4) 거래량 의존 (vol z 분위)\n`);
  for (const r of results) {
    L.push(`\n### ${r.name}`);
    L.push(`  ${pad('vol z', 12)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('totalRet', 9)} | ${padS('PF', 5)} | ${padS('avg', 8)}`);
    L.push(`  ${'-'.repeat(60)}`);
    const buckets = [
      { name: '0.5~1.0', lo: 0.5, hi: 1.0 },
      { name: '1.0~1.5', lo: 1.0, hi: 1.5 },
      { name: '1.5~2.5', lo: 1.5, hi: 2.5 },
      { name: '2.5+',    lo: 2.5, hi: 999 },
    ];
    for (const b of buckets) {
      const sub = r.trades.filter(t => t.volZ >= b.lo && t.volZ < b.hi);
      const st = statsFor(sub);
      const avg = st.n ? st.total / st.n : 0;
      L.push(`  ${pad(b.name, 12)} | ${padS(String(st.n), 4)} | ${padS(st.wr.toFixed(0)+'%', 5)} | ${padS(fmt(st.total), 9)} | ${padS(st.pf.toFixed(2), 5)} | ${padS(fmt(avg, false), 8)}`);
    }
  }

  // ============ 5) 월별 cumulative ============
  L.push(`\n## 5) 시기 의존 (월별 PnL + cumulative)\n`);
  for (const r of results) {
    L.push(`\n### ${r.name}`);
    L.push(`  ${pad('month', 10)} | ${padS('n', 4)} | ${padS('monthRet', 9)} | ${padS('cumRet', 10)} | ${padS('PF', 5)}`);
    L.push(`  ${'-'.repeat(60)}`);
    const byMonth = new Map<string, Trade[]>();
    for (const t of r.trades) {
      if (!byMonth.has(t.monthKey)) byMonth.set(t.monthKey, []);
      byMonth.get(t.monthKey)!.push(t);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    for (const m of months) {
      const sub = byMonth.get(m)!;
      const st = statsFor(sub);
      cum += st.total;
      L.push(`  ${pad(m, 10)} | ${padS(String(st.n), 4)} | ${padS(fmt(st.total), 9)} | ${padS(fmt(cum), 10)} | ${padS(st.pf.toFixed(2), 5)}`);
    }
  }

  // ============ 6) 진단 요약 ============
  L.push(`\n\n## 6) 진단 요약\n`);
  L.push(`${pad('algo', 22)} | ${padS('full PF', 8)} | ${padS('-top3 PF', 9)} | ${padS('neg coins', 9)} | ${padS('bull PF', 8)} | ${padS('bear PF', 8)} | ${padS('regime ratio', 12)}`);
  L.push('-'.repeat(100));
  for (const r of results) {
    const fullSt = statsFor(r.trades);
    const byCoin = new Map<string, Trade[]>();
    for (const t of r.trades) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
      byCoin.get(t.coin)!.push(t);
    }
    const rows = [...byCoin.entries()].map(([coin, trs]) => ({ coin, st: statsFor(trs) })).sort((a, b) => b.st.total - a.st.total);
    const remove = new Set(rows.slice(0, 3).map(r => r.coin));
    const filtered = r.trades.filter(t => !remove.has(t.coin));
    const minus3Pf = statsFor(filtered).pf;
    const negCount = rows.filter(r => r.st.total < 0).length;
    const bullPf = statsFor(r.trades.filter(t => t.btcRegime === 'bull')).pf;
    const bearPf = statsFor(r.trades.filter(t => t.btcRegime === 'bear')).pf;
    const ratio = bearPf > 0 ? (bullPf / bearPf).toFixed(2) : '∞';
    L.push(`${pad(r.name, 22)} | ${padS(fullSt.pf.toFixed(2), 8)} | ${padS(minus3Pf.toFixed(2), 9)} | ${padS(`${negCount}/${rows.length}`, 9)} | ${padS(bullPf.toFixed(2), 8)} | ${padS(bearPf.toFixed(2), 8)} | ${padS(ratio + 'x', 12)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R31_VERIFY.txt`), L.join('\n'));
  process.exit(0);
})();
