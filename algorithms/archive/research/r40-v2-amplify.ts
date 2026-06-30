/**
 * R40 — V2 강점 강화 8변형.
 *
 * 가설: V2가 본질적으로 좋으니 강점 도드라지게 → 더 큰 수익 가능?
 *
 * 변형:
 *   V2_BASE        : 비교 (TP7/SL-2.5, position 33%×3, vol z 0.5)
 *   S1 SIZE_50     : position 50%, max 2 (집중)
 *   S2 SIZE_100    : position 100%, max 1 (single all-in)
 *   S3 VOLZ_HIGH   : vol z ≥ 1.5 (quality strict)
 *   S4 VOLZ_VHIGH  : vol z ≥ 2.5 (최강 quality)
 *   S5 TRAILING_TP : TP +5% 도달 시 trail (peak × 0.93에서 청산)
 *   S6 MTF_ALIGN   : 4h F6 + 직전 7d daily high break 동시
 *   S7 PYRAMID     : 진입 후 +3% 도달 시 추가 진입 1회 (같은 코인)
 *   S8 TOP_PERF    : 최근 30d return 상위 50% 코인만
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const COST_RT = 0.001;

const COINS_4Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const COINS_2Y = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];

function load4hBars(coin: string, years: string[]): CachedBar[] {
  const seen = new Set<number>(); const all: CachedBar[] = [];
  for (const yf of years) {
    const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_${yf}.json`);
    if (!fs.existsSync(fp)) continue;
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const b of arr) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
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
function sigV2(bars: CachedBar[], coin: string, volZThresh = 0.5): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = 43; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 42; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZThresh) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

// S6 MTF_ALIGN: F6 signal + 직전 daily에서도 7d high break (즉 daily 단위 강세 확인)
function sigMTF(bars: CachedBar[], coin: string): Signal[] {
  const v2 = sigV2(bars, coin, 0.5);
  // 4h bar의 daily 합성
  const byDate = new Map<string, { h: number; l: number; ts: number[] }>();
  for (const b of bars) {
    const d = new Date(b.ts + 9*3600_000).toISOString().slice(0, 10);
    const cur = byDate.get(d);
    if (!cur) byDate.set(d, { h: b.high, l: b.low, ts: [b.ts] });
    else { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.ts.push(b.ts); }
  }
  const dailyArr = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyHighByDate = new Map<string, number>();
  for (const [d, v] of dailyArr) dailyHighByDate.set(d, v.h);
  const out: Signal[] = [];
  for (const s of v2) {
    const date = new Date(s.ts + 9*3600_000).toISOString().slice(0, 10);
    const prevDate = new Date(s.ts + 9*3600_000 - 86400_000).toISOString().slice(0, 10);
    const prevDayHigh = dailyHighByDate.get(prevDate);
    if (prevDayHigh == null) continue;
    // 직전 7일 daily high 중 최대
    let weekHigh = -Infinity;
    for (let k = 1; k <= 7; k++) {
      const dk = new Date(s.ts + 9*3600_000 - k*86400_000).toISOString().slice(0, 10);
      const h = dailyHighByDate.get(dk);
      if (h != null && h > weekHigh) weekHigh = h;
    }
    // 직전 daily에서 weekHigh break 됐는지
    if (prevDayHigh < weekHigh) continue;
    out.push(s);
  }
  return out;
}

// S8 TOP_PERF: 최근 30d (180 4h bars) return 코인별 ranking → 매 ts 상위 50%만
function buildTopPerfRanking(barsByCoin: Map<string, CachedBar[]>): Map<number, Set<string>> {
  const lookbackBars = 180; // 30d
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxMap = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxMap.set(coin, m);
  }
  const rank = new Map<number, Set<string>>();
  for (const ts of tsList) {
    const rets: { coin: string; r: number }[] = [];
    for (const [coin, bars] of barsByCoin) {
      const idx = idxMap.get(coin)!.get(ts);
      if (idx == null || idx < lookbackBars) continue;
      const r = (bars[idx].close - bars[idx - lookbackBars].close) / bars[idx - lookbackBars].close * 100;
      rets.push({ coin, r });
    }
    rets.sort((a, b) => b.r - a.r);
    const topK = Math.ceil(rets.length / 2);
    rank.set(ts, new Set(rets.slice(0, topK).map(r => r.coin)));
  }
  return rank;
}

interface Position {
  coin: string; entryTs: number; entryIdx: number; entryPrice: number;
  vol: number; cashUsed: number; tp: number; sl: number; maxBars: number;
  peakPrice?: number; trailingActive?: boolean;
  pyramidAdded?: boolean;
}
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'|'TRAIL'; }

interface Variant {
  name: string;
  signalFn: (bars: CachedBar[], coin: string) => Signal[];
  positionPct: number;
  maxConcurrent: number;
  tp: number; sl: number; maxBars: number;
  trailing?: { triggerPct: number; pullbackPct: number }; // TP 도달 후 peak × (1-pullback%) 청산
  pyramid?: { addAt: number; maxAdds: number };
  topPerfFilter?: boolean;
}

function simulate(cfg: Variant, rawSignals: Signal[], barsByCoin: Map<string, CachedBar[]>, topPerfRank: Map<number, Set<string>>, periodStartTs: number, periodEndTs: number) {
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
  for (const bars of barsByCoin.values()) for (const b of bars) if (b.ts >= periodStartTs && b.ts <= periodEndTs) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxByCoinTs = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxByCoinTs.set(coin, m);
  }
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    // Exit
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const holdBars = idx - pos.entryIdx;

      // Trailing TP logic
      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (cfg.trailing) {
        const trigger = pos.entryPrice * (1 + cfg.trailing.triggerPct / 100);
        if (!pos.trailingActive && b.high >= trigger) {
          pos.trailingActive = true;
          pos.peakPrice = trigger;
        }
        if (pos.trailingActive) {
          if (b.high > (pos.peakPrice || 0)) pos.peakPrice = b.high;
          const trailExit = (pos.peakPrice || 0) * (1 - cfg.trailing.pullbackPct / 100);
          if (b.low <= trailExit) {
            exitPrice = trailExit; reason = 'TRAIL';
            rawRet = (trailExit - pos.entryPrice) / pos.entryPrice * 100;
          }
        }
      }
      if (!reason) {
        if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; rawRet = (pos.sl - pos.entryPrice) / pos.entryPrice * 100; }
        else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; rawRet = (pos.tp - pos.entryPrice) / pos.entryPrice * 100; }
        else if (holdBars >= pos.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(q, 1);
      }
    }

    // Pyramid add-on
    if (cfg.pyramid) {
      for (const pos of positions) {
        if (pos.pyramidAdded) continue;
        const idx = idxByCoinTs.get(pos.coin)!.get(ts);
        if (idx == null) continue;
        const bars = barsByCoin.get(pos.coin)!;
        const trigger = pos.entryPrice * (1 + cfg.pyramid.addAt / 100);
        if (bars[idx].high < trigger) continue;
        // Add: cash 절반으로 추가 매수
        const cashToUse = cash * 0.2; // 20% 추가
        if (cashToUse < 5000) continue;
        const addPrice = trigger;
        const cashAfterFee = cashToUse * (1 - COST_RT / 2);
        const addVol = cashAfterFee / addPrice;
        // 평균 단가 reweight
        const totalCost = pos.cashUsed + cashToUse;
        const totalVol = pos.vol + addVol;
        const newEntry = totalCost * (1 - COST_RT / 2) / totalVol;
        pos.entryPrice = newEntry;
        pos.vol = totalVol;
        pos.cashUsed = totalCost;
        pos.tp = newEntry * (1 + cfg.tp / 100);
        pos.sl = newEntry * (1 + cfg.sl / 100);
        pos.pyramidAdded = true;
        cash -= cashToUse;
      }
    }

    // Entry
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= cfg.maxConcurrent) break;
      if (cfg.topPerfFilter) {
        const top = topPerfRank.get(ts);
        if (!top || !top.has(sig.coin)) continue;
      }
      const bars = barsByCoin.get(sig.coin);
      if (!bars) continue;
      const entryIdx = sig.barIdx + 1;
      if (entryIdx >= bars.length) continue;
      const eBar = bars[entryIdx];
      const entryPrice = eBar.open;
      const cashToUse = cash * cfg.positionPct;
      if (cashToUse < 5000) continue;
      const cashAfterFee = cashToUse * (1 - COST_RT / 2);
      const vol = cashAfterFee / entryPrice;
      const tp = entryPrice * (1 + cfg.tp / 100);
      const sl = entryPrice * (1 + cfg.sl / 100);
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse, tp, sl, maxBars: cfg.maxBars });
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
  console.log(`\n=== R40 V2 강점 강화 8변형 ===\n`);

  const bars4y = new Map<string, CachedBar[]>();
  for (const c of COINS_4Y) { const b = load4hBars(c, ['2022-06-10_2023-06-10','2023-06-10_2024-06-10','2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 8000) bars4y.set(c, b); }
  const bars2y = new Map<string, CachedBar[]>();
  for (const c of COINS_2Y) { const b = load4hBars(c, ['2024-06-10_2025-06-10','2025-06-10_2026-06-10']); if (b.length >= 4000) bars2y.set(c, b); }
  console.log(`4y: ${bars4y.size}, 2y: ${bars2y.size}`);

  const topPerf4y = buildTopPerfRanking(bars4y);
  const topPerf2y = buildTopPerfRanking(bars2y);

  // Build signal sets
  const sigBase4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigV2(bars4y.get(c)!, c, 0.5)) sigBase4y.push(s);
  const sigVolzHigh4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigV2(bars4y.get(c)!, c, 1.5)) sigVolzHigh4y.push(s);
  const sigVolzVHigh4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigV2(bars4y.get(c)!, c, 2.5)) sigVolzVHigh4y.push(s);
  const sigMTF4y: Signal[] = []; for (const c of bars4y.keys()) for (const s of sigMTF(bars4y.get(c)!, c)) sigMTF4y.push(s);
  const sigBase2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigV2(bars2y.get(c)!, c, 0.5)) sigBase2y.push(s);
  const sigVolzHigh2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigV2(bars2y.get(c)!, c, 1.5)) sigVolzHigh2y.push(s);
  const sigVolzVHigh2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigV2(bars2y.get(c)!, c, 2.5)) sigVolzVHigh2y.push(s);
  const sigMTF2y: Signal[] = []; for (const c of bars2y.keys()) for (const s of sigMTF(bars2y.get(c)!, c)) sigMTF2y.push(s);

  const variants: { cfg: Variant; sig4y: Signal[]; sig2y: Signal[] }[] = [
    { cfg: { name: 'V2_BASE ★',    signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigBase4y, sig2y: sigBase2y },
    { cfg: { name: 'S1 SIZE_50',   signalFn: ()=>[], positionPct: 0.50, maxConcurrent: 2, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigBase4y, sig2y: sigBase2y },
    { cfg: { name: 'S2 SIZE_100',  signalFn: ()=>[], positionPct: 1.00, maxConcurrent: 1, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigBase4y, sig2y: sigBase2y },
    { cfg: { name: 'S3 VOLZ_HIGH', signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigVolzHigh4y, sig2y: sigVolzHigh2y },
    { cfg: { name: 'S4 VOLZ_VHIGH', signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigVolzVHigh4y, sig2y: sigVolzVHigh2y },
    { cfg: { name: 'S5 TRAILING_TP', signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 99, sl: -2.5, maxBars: 84, trailing: { triggerPct: 5, pullbackPct: 2.5 } }, sig4y: sigBase4y, sig2y: sigBase2y },
    { cfg: { name: 'S6 MTF_ALIGN', signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84 }, sig4y: sigMTF4y, sig2y: sigMTF2y },
    { cfg: { name: 'S7 PYRAMID',   signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84, pyramid: { addAt: 3, maxAdds: 1 } }, sig4y: sigBase4y, sig2y: sigBase2y },
    { cfg: { name: 'S8 TOP_PERF',  signalFn: ()=>[], positionPct: 0.33, maxConcurrent: 3, tp: 7, sl: -2.5, maxBars: 84, topPerfFilter: true }, sig4y: sigBase4y, sig2y: sigBase2y },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R40 V2 강점 강화 8변형`);
  L.push(`4Y (15코인) + 2Y (28코인)`);
  L.push('='.repeat(170));

  for (const [name, ps, pe, barsByCoin, sigKey, topPerf] of [
    ['4Y', '2022-06-10', '2026-06-10', bars4y, 'sig4y', topPerf4y],
    ['2Y', '2024-06-10', '2026-06-10', bars2y, 'sig2y', topPerf2y],
  ] as const) {
    const pStart = new Date(`${ps}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${pe}T23:59:59+09:00`).getTime();
    L.push(`\n## ${name}\n`);
    L.push(`${pad('variant', 22)} | ${padS('n', 5)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | ${padS('finalCash', 12)} | pass`);
    L.push('-'.repeat(100));
    const stats: { name: string; stats: ReturnType<typeof statsFor> }[] = [];
    for (const v of variants) {
      const sigs = sigKey === 'sig4y' ? v.sig4y : v.sig2y;
      const r = simulate(v.cfg, sigs, barsByCoin, topPerf, pStart, pEnd);
      const s = statsFor(r.trades, r.finalCash, r.mdd);
      stats.push({ name: v.cfg.name, stats: s });
    }
    for (const r of stats) {
      const pass = r.stats.pf >= 1.2 && r.stats.total > 0;
      L.push(`${pad(r.name, 22)} | ${padS(String(r.stats.n), 5)} | ${padS(r.stats.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.stats.total), 9)} | ${padS(r.stats.pf.toFixed(2), 5)} | ${padS(r.stats.mdd.toFixed(1)+'%', 6)} | ${padS(r.stats.finalCash.toFixed(0), 12)} | ${pass ? '✓' : ''}`);
    }
  }

  // BASE 대비 (2Y)
  L.push(`\n## BASE 대비 변화 (2Y)\n`);
  const pStart = new Date('2024-06-10T00:00:00+09:00').getTime();
  const pEnd = new Date('2026-06-10T23:59:59+09:00').getTime();
  const baseR = simulate(variants[0].cfg, variants[0].sig2y, bars2y, topPerf2y, pStart, pEnd);
  const baseS = statsFor(baseR.trades, baseR.finalCash, baseR.mdd);
  L.push(`${pad('variant', 22)} | ${padS('Δtotal', 10)} | ${padS('ΔPF', 7)} | ${padS('ΔMDD', 7)} | 평가`);
  L.push('-'.repeat(80));
  for (const v of variants.slice(1)) {
    const r = simulate(v.cfg, v.sig2y, bars2y, topPerf2y, pStart, pEnd);
    const s = statsFor(r.trades, r.finalCash, r.mdd);
    const dt = s.total - baseS.total;
    const dp = s.pf - baseS.pf;
    const dm = s.mdd - baseS.mdd;
    const evals: string[] = [];
    if (dt > 5) evals.push('수익↑');
    else if (dt < -5) evals.push('수익↓');
    if (dm < -2) evals.push('MDD↓');
    else if (dm > 2) evals.push('MDD↑');
    L.push(`${pad(v.cfg.name, 22)} | ${padS((dt>=0?'+':'')+dt.toFixed(2)+'%', 10)} | ${padS((dp>=0?'+':'')+dp.toFixed(2), 7)} | ${padS((dm>=0?'+':'')+dm.toFixed(1)+'%', 7)} | ${evals.join(' ')||'동등'}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R40_AMPLIFY.txt`), L.join('\n'));
  process.exit(0);
})();
