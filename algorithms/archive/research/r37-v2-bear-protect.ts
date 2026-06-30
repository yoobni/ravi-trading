/**
 * R37 — V2 약세장 보강 5변형 검증.
 *
 * Base: V2 TP_OPT (TP+7%/SL-2.5%/MAX 14d, lookback 42, vol z 0.5)
 *
 * 변형:
 *   V2_BASE   : 보강 없음 (paper 현재 F6_v2)
 *   V2_A      : + BTC 4h EMA50 trend filter (단기 regime)
 *   V2_B      : + 연속 손실 cooldown (5 consecutive losses → 7d cooldown)
 *   V2_C      : + Crash 회피 (BTC 7d return < -10% 시 진입 stop)
 *   V2_D      : + 코인 자체 4h EMA200 above (V6 보강 idea)
 *   V2_E      : + Trailing BE stop (+2% 도달 시 SL을 entry로 이동)
 *
 * 기간:
 *   4Y: 2022-06 ~ 2026-06 (15코인)  ← 약세장 포함
 *   2Y: 2024-06 ~ 2026-06 (28코인)  ← 최근 + 넓은 풀
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const COST_RT = 0.001;
const TP_PCT = 7.0;
const SL_PCT = -2.5;
const MAX_BARS = 84;
const LOOKBACK = 42;
const VOL_Z = 0.5;

const COINS_4Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const COINS_2Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function load4hBars(coin: string, years: string[]): CachedBar[] {
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const yf of years) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
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
function calcVolZ(volumes: number[], i: number, window = 30): number | null {
  if (i < window) return null;
  let sum = 0, sum2 = 0;
  for (let j = i - window; j < i; j++) { sum += volumes[j]; sum2 += volumes[j]*volumes[j]; }
  const mean = sum / window;
  const sd = Math.sqrt(Math.max((sum2/window) - mean*mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

interface Signal { coin: string; barIdx: number; ts: number; volZ: number; }

function sigF6(bars: CachedBar[], coin: string, coinEma200Filter?: boolean): Signal[] {
  const volumes = bars.map(b => b.volume);
  const closes = bars.map(b => b.close);
  const ema200_4h = coinEma200Filter ? calcEMA(closes, 200) : null;
  const out: Signal[] = [];
  for (let i = LOOKBACK + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - LOOKBACK; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < VOL_Z) continue;
    if (coinEma200Filter && (ema200_4h![i] == null || closes[i] <= ema200_4h![i]!)) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; trailing?: { triggered: boolean; }; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

interface VariantConfig {
  name: string;
  btcEma50Gate4h?: boolean;
  consecutiveLossCooldown?: { count: number; cooldownMs: number };
  crashAvoid?: { lookbackBars: number; threshold: number }; // BTC 7d return < threshold
  coinEma200?: boolean;
  trailingBE?: { triggerPct: number }; // +X% 도달 시 SL → entry
}

function simulate(
  cfg: VariantConfig, rawSignals: Signal[],
  barsByCoin: Map<string, CachedBar[]>,
  periodStartTs: number, periodEndTs: number,
) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: Trade[] = [];
  const filtered = rawSignals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, Signal[]>();
  for (const sig of [...filtered].sort((a, b) => a.ts - b.ts)) {
    if (!sigByTs.has(sig.ts)) sigByTs.set(sig.ts, []);
    sigByTs.get(sig.ts)!.push(sig);
  }
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) {
    if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  }
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }

  // BTC 4h EMA50 (for V2_A)
  const btcBars = barsByCoin.get('BTC')!;
  const btcCloses = btcBars.map(b => b.close);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcByTs = new Map<number, { idx: number; close: number; ema50: number | null }>();
  for (let i = 0; i < btcBars.length; i++) btcByTs.set(btcBars[i].ts, { idx: i, close: btcBars[i].close, ema50: btcEma50[i] });

  let cooldownUntilTs = 0;
  let peak = INITIAL_CASH, mdd = 0;

  function btcEma50Pass(ts: number): boolean {
    const data = btcByTs.get(ts);
    if (!data || data.ema50 == null) return false;
    return data.close > data.ema50;
  }
  function btc7dCrashAvoid(ts: number, lookbackBars: number, threshold: number): boolean {
    const data = btcByTs.get(ts);
    if (!data || data.idx < lookbackBars) return true;
    const prevClose = btcBars[data.idx - lookbackBars].close;
    const ret = (data.close - prevClose) / prevClose * 100;
    return ret >= threshold;
  }

  for (const ts of tsList) {
    // Exit check
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const holdBars = idx - pos.entryIdx;

      // Trailing BE trigger
      if (cfg.trailingBE && !pos.trailing?.triggered) {
        const trigger = pos.entryPrice * (1 + cfg.trailingBE.triggerPct / 100);
        if (b.high >= trigger) {
          pos.sl = pos.entryPrice; // SL → entry (BE)
          pos.trailing = { triggered: true };
        }
      }

      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; rawRet = (pos.sl - pos.entryPrice) / pos.entryPrice * 100; }
      else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; rawRet = (pos.tp - pos.entryPrice) / pos.entryPrice * 100; }
      else if (holdBars >= MAX_BARS) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(q, 1);

        // Consecutive loss cooldown trigger
        if (cfg.consecutiveLossCooldown) {
          const recent = trades.slice(-cfg.consecutiveLossCooldown.count);
          if (recent.length >= cfg.consecutiveLossCooldown.count && recent.every(t => t.netRet <= 0)) {
            cooldownUntilTs = ts + cfg.consecutiveLossCooldown.cooldownMs;
          }
        }
      }
    }

    // Cooldown check
    if (ts < cooldownUntilTs) {
      // Equity 계산만, 진입 X
      let openValue = 0;
      for (const pos of positions) {
        const idx = idxByCoinTs.get(pos.coin)!.get(ts);
        if (idx != null) openValue += pos.vol * barsByCoin.get(pos.coin)![idx].close;
      }
      const eq = cash + openValue;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > mdd) mdd = dd;
      continue;
    }

    // Entry filters
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
      // V2_A: BTC 4h EMA50 above
      if (cfg.btcEma50Gate4h && !btcEma50Pass(ts)) continue;
      // V2_C: Crash avoid
      if (cfg.crashAvoid && !btc7dCrashAvoid(ts, cfg.crashAvoid.lookbackBars, cfg.crashAvoid.threshold)) continue;
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const eBar = bars[entryIdx];
      const entryPrice = eBar.open;
      const cashToUse = cash * POSITION_PCT;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 + SL_PCT / 100);
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse, tp, sl });
    }

    let openValue = 0;
    for (const pos of positions) {
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx != null) openValue += pos.vol * barsByCoin.get(pos.coin)![idx].close;
    }
    const eq = cash + openValue;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > mdd) mdd = dd;
  }
  for (const pos of positions) {
    const bars = barsByCoin.get(pos.coin)!;
    let lastIdx = bars.length - 1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= periodEndTs) { lastIdx = i; break; }
    }
    const exitPrice = bars[lastIdx].close;
    const gross = pos.vol * exitPrice;
    const cashGained = gross * (1 - COST_RT / 2);
    const profitKrw = cashGained - pos.cashUsed;
    const rawRet = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const netRet = rawRet - COST_RT * 100;
    cash += cashGained;
    trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: bars[lastIdx].ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason: 'END' });
  }
  return { trades, finalCash: cash, mdd };
}
function statsFor(trades: Trade[], finalCash: number, mdd: number) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, total: 0, pf: 0, mdd, finalCash };
  const wins = trades.filter(t => t.profitKrw > 0);
  const losses = trades.filter(t => t.profitKrw <= 0);
  const wr = wins.length / n * 100;
  const totWin = wins.reduce((s, t) => s + t.profitKrw, 0);
  const totLoss = Math.abs(losses.reduce((s, t) => s + t.profitKrw, 0));
  const pf = totLoss > 0 ? totWin / totLoss : (totWin > 0 ? 99 : 0);
  const total = (finalCash - INITIAL_CASH) / INITIAL_CASH * 100;
  return { n, wr, total, pf, mdd, finalCash };
}
function fmt(n: number, sign = true): string { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function pad(s: string, w: number): string { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number): string { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`\n=== R37 V2 약세장 보강 5변형 ===\n`);

  // Load both 4y and 2y pools
  console.log('Loading 4y (15 coins) + 2y (28 coins) bars...');
  const bars4y = new Map<string, CachedBar[]>();
  for (const coin of COINS_4Y) {
    const b = load4hBars(coin, ['2022-06-10_2023-06-10','2023-06-10_2024-06-10','2024-06-10_2025-06-10','2025-06-10_2026-06-10']);
    if (b.length >= 8000) bars4y.set(coin, b);
  }
  const bars2y = new Map<string, CachedBar[]>();
  for (const coin of COINS_2Y) {
    const b = load4hBars(coin, ['2024-06-10_2025-06-10','2025-06-10_2026-06-10']);
    if (b.length >= 4000) bars2y.set(coin, b);
  }
  console.log(`  4y: ${bars4y.size} coins, 2y: ${bars2y.size} coins`);

  // Pre-compute signals
  const sigBase_4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigF6(bars4y.get(c)!, c)) sigBase_4y.push(s);
  const sigCoinTrend_4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigF6(bars4y.get(c)!, c, true)) sigCoinTrend_4y.push(s);
  const sigBase_2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigF6(bars2y.get(c)!, c)) sigBase_2y.push(s);
  const sigCoinTrend_2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigF6(bars2y.get(c)!, c, true)) sigCoinTrend_2y.push(s);

  const variants: { name: string; cfg: VariantConfig; sigs: { '4y': Signal[]; '2y': Signal[] } }[] = [
    { name: 'V2_BASE ★',            cfg: {}, sigs: { '4y': sigBase_4y, '2y': sigBase_2y } },
    { name: 'V2_A BTC_4H_EMA50',     cfg: { btcEma50Gate4h: true }, sigs: { '4y': sigBase_4y, '2y': sigBase_2y } },
    { name: 'V2_B CONSEC_LOSS_CD',   cfg: { consecutiveLossCooldown: { count: 5, cooldownMs: 7 * 86400_000 } }, sigs: { '4y': sigBase_4y, '2y': sigBase_2y } },
    { name: 'V2_C CRASH_AVOID',      cfg: { crashAvoid: { lookbackBars: 42, threshold: -10 } }, sigs: { '4y': sigBase_4y, '2y': sigBase_2y } },
    { name: 'V2_D COIN_EMA200',      cfg: { coinEma200: true }, sigs: { '4y': sigCoinTrend_4y, '2y': sigCoinTrend_2y } },
    { name: 'V2_E TRAILING_BE',      cfg: { trailingBE: { triggerPct: 2 } }, sigs: { '4y': sigBase_4y, '2y': sigBase_2y } },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R37 V2 약세장 보강 5변형 — Base TP+7%/SL-2.5%/MAX 14d`);
  L.push(`4Y (2022-06~2026-06, ${bars4y.size}코인) + 2Y (2024-06~2026-06, ${bars2y.size}코인)`);
  L.push('='.repeat(170));

  for (const [periodName, periodStart, periodEnd, barsByCoin, sigKey] of [
    ['4Y (15코인)', '2022-06-10', '2026-06-10', bars4y, '4y'],
    ['2Y (28코인)', '2024-06-10', '2026-06-10', bars2y, '2y'],
  ] as const) {
    const pStart = new Date(`${periodStart}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${periodEnd}T23:59:59+09:00`).getTime();
    L.push(`\n## ${periodName}\n`);
    L.push(`${pad('variant', 22)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
    L.push('-'.repeat(80));

    interface Row { name: string; stats: ReturnType<typeof statsFor>; }
    const rows: Row[] = [];
    for (const v of variants) {
      const sigs = v.sigs[sigKey];
      const r = simulate(v.cfg, sigs, barsByCoin, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      rows.push({ name: v.name, stats: s });
    }
    for (const r of rows) {
      const pass = r.stats.pf >= 1.2 && r.stats.total > 0;
      L.push(`${pad(r.name, 22)} | ${padS(String(r.stats.n), 5)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 9)} | ${padS(r.stats.pf.toFixed(2), 5)} | ${padS(r.stats.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
    }

    // BASE 대비 비교
    const base = rows[0].stats;
    L.push(`\n${pad('변형', 22)} | ${padS('Δtotal', 9)} | ${padS('ΔPF', 7)} | ${padS('ΔMDD', 8)} | 평가`);
    L.push('-'.repeat(80));
    for (const r of rows.slice(1)) {
      const dt = r.stats.total - base.total;
      const dp = r.stats.pf - base.pf;
      const dm = r.stats.mdd - base.mdd;
      const evals: string[] = [];
      if (dt > 5) evals.push('수익↑');
      else if (dt < -5) evals.push('수익↓');
      if (dm < -2) evals.push('MDD↓');
      else if (dm > 2) evals.push('MDD↑');
      L.push(`${pad(r.name, 22)} | ${padS((dt>=0?'+':'')+dt.toFixed(2)+'%', 9)} | ${padS((dp>=0?'+':'')+dp.toFixed(2), 7)} | ${padS((dm>=0?'+':'')+dm.toFixed(1)+'%', 8)} | ${evals.join(' ') || '동등'}`);
    }
  }

  // 4년 분기별 비교 (약세장 분기 강조)
  L.push(`\n## 약세장 분기 (4Y) 비교 — 진짜 보강 효과 확인\n`);
  const bearQuarters = [
    { name: 'Q2 22-09', start: '2022-09-10', end: '2022-12-10' },
    { name: 'Q3 22-12', start: '2022-12-10', end: '2023-03-10' },
    { name: 'Q4 23-03', start: '2023-03-10', end: '2023-06-10' },
    { name: 'Q7 23-12', start: '2023-12-10', end: '2024-03-10' },
    { name: 'Q8 24-03', start: '2024-03-10', end: '2024-06-10' },
    { name: 'Q11 24-12', start: '2024-12-10', end: '2025-03-10' },
    { name: 'Q15 25-12', start: '2025-12-10', end: '2026-03-10' },
  ];
  L.push(`${pad('변형', 22)} | ${bearQuarters.map(q => padS(q.name, 11)).join(' | ')}`);
  L.push('-'.repeat(120));
  for (const v of variants) {
    const cells: string[] = [];
    for (const q of bearQuarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      // 분기 시기에 따라 4y/2y 선택
      const useBars = q.start >= '2024-06-10' ? bars2y : bars4y;
      const useSigs = q.start >= '2024-06-10' ? v.sigs['2y'] : v.sigs['4y'];
      const r = simulate(v.cfg, useSigs, useBars, ps, pe);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      cells.push(padS(fmt(s.total), 11));
    }
    L.push(`${pad(v.name, 22)} | ${cells.join(' | ')}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R37_BEAR.txt`), L.join('\n'));
  process.exit(0);
})();
