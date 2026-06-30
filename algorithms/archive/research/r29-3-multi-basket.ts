/**
 * R29-3 — Multi-asset basket (BTC+ETH+SOL+XRP 합산).
 *
 * 가설: 단일 코인 변동성보다 4코인 동시 운영 → 분산으로 MDD 감소, sharpe ↑.
 *      각 코인 신호 발생 시 진입 (시간순), 동일 자본 비율 (각 25%), 합산 equity.
 *
 * 룰: R23-C (MTF SHORT + Volume z>1.0 + TP6/SL1/72h)
 * Period: PREV (2024-06~25-06) + CURR (2025-06~26-06) — 알트 데이터 있는 구간
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, latestClosedBarIdx, signalTs,
  safeVolumeZ, calcEMASafe,
  simulateSafe, statsFor, fmt, pad, padS,
  type SafeContext, type SafeSignal, type Variant, type Trade,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;
const TP6_1: Variant = { name: 'TP6_SL1_72h', tp: 6, sl: -1, maxMin: 4320 };

function mtfShortSignals(ctx: SafeContext): SafeSignal[] {
  const out: SafeSignal[] = [];
  const closes15 = ctx.bars15m.map(b => b.close);
  const ema20_15 = calcEMASafe(closes15, 20);
  const closes4h = ctx.bars4h.map(b => b.close);
  const ema50_4h = calcEMASafe(closes4h, 50);
  for (let i = 1; i < ctx.bars15m.length; i++) {
    const bar = ctx.bars15m[i];
    const sigTs = signalTs(bar, ctx.durationMs15m);
    const idx4h = latestClosedBarIdx(ctx.bars4h, ctx.durationMs4h, sigTs);
    if (idx4h < 0) continue;
    const e4h = ema50_4h[idx4h];
    if (e4h == null || ctx.bars4h[idx4h].close >= e4h) continue;
    const ePrev = ema20_15[i - 1], eCur = ema20_15[i];
    if (ePrev == null || eCur == null) continue;
    const prev = ctx.bars15m[i - 1];
    if (!(prev.close > ePrev && bar.close < eCur)) continue;
    const z = safeVolumeZ(ctx.bars15m, i, 30, true);
    if (z == null || z < 1.0) continue;
    out.push({ signalTs: sigTs, signalBarIdx: i, direction: 'SHORT' });
  }
  return out.sort((a, b) => a.signalTs - b.signalTs);
}

/** equity curve: 시작 capital 100, 각 trade의 netReturnPct가 size 만큼 affect */
function equityCurve(trades: { ts: number; ret: number }[], sizePct: number, startCap = 100): number[] {
  const eq = [startCap];
  let cap = startCap;
  for (const t of trades) {
    cap = cap * (1 + (t.ret / 100) * sizePct);
    eq.push(cap);
  }
  return eq;
}

function maxDrawdownPct(eq: number[]): number {
  let peak = eq[0], maxDD = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R29-3 MULTI-ASSET BASKET ===\n`);

  const periods = [
    { label: 'PREV', start: '2024-06-09', end: '2025-06-09' },
    { label: 'CURR', start: '2025-06-09', end: '2026-06-09' },
  ];
  const coins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R29-3 MULTI-ASSET BASKET — BTC+ETH+SOL+XRP 합산, R23-C 신호`);
  L.push(`각 코인 동일 size (25% each, full position when triggered)`);
  L.push('='.repeat(140));

  for (const p of periods) {
    L.push(`\n## Period: ${p.label} (${p.start} ~ ${p.end})\n`);
    L.push(`${pad('coin', 8)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)} | ${padS('avg trade', 9)}`);
    L.push('-'.repeat(60));

    const perCoin: { coin: string; trades: Trade[] }[] = [];
    for (const coin of coins) {
      const ctx = buildSafeContext(p.start, p.end, coin);
      if (!ctx) {
        L.push(`${pad(coin.replace('USDT',''), 8)} | (데이터 없음)`);
        continue;
      }
      const sigs = mtfShortSignals(ctx);
      const trades = simulateSafe(ctx, sigs, TP6_1, COST_RT);
      perCoin.push({ coin, trades });
      const s = statsFor(trades);
      const avg = s.n ? s.total / s.n : 0;
      L.push(`${pad(coin.replace('USDT',''), 8)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 8)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(fmt(avg), 9)}`);
    }

    // Basket: 모든 trade 합치고 time-sorted, equity curve 계산
    const allByTime: { ts: number; ret: number; coin: string }[] = [];
    for (const pc of perCoin) {
      for (const t of pc.trades) allByTime.push({ ts: t.signalTs, ret: t.netReturnPct, coin: pc.coin });
    }
    allByTime.sort((a, b) => a.ts - b.ts);

    // Equal-weight: 25% per signal (each coin gets 25% of equity)
    const eq25 = equityCurve(allByTime, 0.25);
    const ret25 = (eq25[eq25.length - 1] - 100);
    const dd25 = maxDrawdownPct(eq25);

    // 50% per signal (aggressive)
    const eq50 = equityCurve(allByTime, 0.50);
    const ret50 = (eq50[eq50.length - 1] - 100);
    const dd50 = maxDrawdownPct(eq50);

    // 100% (full position per signal, BTC-only equivalent)
    const eq100 = equityCurve(allByTime, 1.0);
    const ret100 = (eq100[eq100.length - 1] - 100);
    const dd100 = maxDrawdownPct(eq100);

    L.push('-'.repeat(60));
    L.push(`Basket combined — ${allByTime.length} trades`);
    L.push(`  size 25%: equity ${eq25[eq25.length-1].toFixed(2)} (${fmt(ret25)}), MDD ${dd25.toFixed(2)}%`);
    L.push(`  size 50%: equity ${eq50[eq50.length-1].toFixed(2)} (${fmt(ret50)}), MDD ${dd50.toFixed(2)}%`);
    L.push(`  size 100%: equity ${eq100[eq100.length-1].toFixed(2)} (${fmt(ret100)}), MDD ${dd100.toFixed(2)}%`);

    // PF (basket level)
    const wins = allByTime.filter(t => t.ret > 0).reduce((s, t) => s + t.ret, 0);
    const losses = Math.abs(allByTime.filter(t => t.ret <= 0).reduce((s, t) => s + t.ret, 0));
    const basketPF = losses > 0 ? wins / losses : 0;
    const basketWR = allByTime.filter(t => t.ret > 0).length / allByTime.length * 100;
    L.push(`  basket PF: ${basketPF.toFixed(2)}, WR: ${basketWR.toFixed(0)}%`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R29-3_BASKET.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
