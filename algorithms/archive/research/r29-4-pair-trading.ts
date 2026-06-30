/**
 * R29-4 — ETH/BTC pair trading.
 *
 * 가설: ETH/BTC 가격 비율 (ETHBTC ratio)의 mean-reversion.
 *      Rolling z-score 극단 → 비율이 평균으로 회귀.
 *      z > +2: ETHBTC 비싸 → ETH SHORT (BTC LONG으로 hedge 또는 단독)
 *      z < -2: ETHBTC 싸 → ETH LONG (BTC SHORT으로 hedge 또는 단독)
 *
 * 단순화: 단일 ETH 방향 trade로만 검증 (BTC hedge 별도).
 * Period: PREV + CURR (2024-06~26-06)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildSafeContext, signalTs,
  simulateSafe, statsFor, inPeriod, fmt, pad, padS,
  type SafeContext, type SafeSignal, type Variant,
} from './_safe';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const COST_RT = 0.002;

const VARIANTS: Variant[] = [
  { name: 'TP3_SL1_24h',  tp: 3, sl: -1, maxMin: 1440 },
  { name: 'TP5_SL2_72h',  tp: 5, sl: -2, maxMin: 4320 },
  { name: 'TP6_SL1_72h',  tp: 6, sl: -1, maxMin: 4320 },
  { name: 'TP10_SL3_168h', tp: 10, sl: -3, maxMin: 10080 },
];

function buildEthBtcSignals(
  ctxETH: SafeContext,
  ctxBTC: SafeContext,
  zThreshold: number,
  rollingWindow: number,
): { entryShort: SafeSignal[]; entryLong: SafeSignal[] } {
  // ETHBTC 비율 (15m bar 기준)
  // BTC 시점 매칭: BTC ts → BTC close, ETH ts → ETH close, 비율 = ETH/BTC
  const btcByTs = new Map<number, number>();
  for (const b of ctxBTC.bars15m) btcByTs.set(b.ts, b.close);
  const ratios: { ts: number; r: number; barIdx: number }[] = [];
  for (let i = 0; i < ctxETH.bars15m.length; i++) {
    const eb = ctxETH.bars15m[i];
    const btcClose = btcByTs.get(eb.ts);
    if (btcClose == null) continue;
    ratios.push({ ts: eb.ts, r: eb.close / btcClose, barIdx: i });
  }
  // Lookahead-safe rolling z-score: window는 i-1까지 (current 제외) — 더 안전
  const entryShort: SafeSignal[] = [];
  const entryLong: SafeSignal[] = [];
  for (let i = rollingWindow; i < ratios.length; i++) {
    // window = [i - rollingWindow, i - 1] (inclusive previous bars only)
    let sum = 0, sum2 = 0;
    for (let j = i - rollingWindow; j < i; j++) {
      sum += ratios[j].r;
      sum2 += ratios[j].r * ratios[j].r;
    }
    const n = rollingWindow;
    const mean = sum / n;
    const variance = (sum2 / n) - mean * mean;
    const sd = Math.sqrt(Math.max(variance, 1e-12));
    if (sd <= 0) continue;
    const z = (ratios[i].r - mean) / sd;
    // signal_ts는 현재 ETH bar의 close 시점 = bar.ts + 15m
    const ethBar = ctxETH.bars15m[ratios[i].barIdx];
    const sigTs = signalTs(ethBar, ctxETH.durationMs15m);
    if (z >= zThreshold) entryShort.push({ signalTs: sigTs, signalBarIdx: ratios[i].barIdx, direction: 'SHORT' });
    else if (z <= -zThreshold) entryLong.push({ signalTs: sigTs, signalBarIdx: ratios[i].barIdx, direction: 'LONG' });
  }
  return {
    entryShort: entryShort.filter(s => inPeriod(s.signalTs, ctxETH)),
    entryLong: entryLong.filter(s => inPeriod(s.signalTs, ctxETH)),
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n=== R29-4 ETH/BTC PAIR TRADING ===\n`);

  const periods = [
    { label: 'PREV', start: '2024-06-09', end: '2025-06-09' },
    { label: 'CURR', start: '2025-06-09', end: '2026-06-09' },
  ];

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R29-4 ETH/BTC PAIR — Rolling z-score mean reversion`);
  L.push(`Signal: ETHBTC ratio z-score (15m, rolling window) | z≥+2 SHORT ETH, z≤-2 LONG ETH`);
  L.push('='.repeat(140));

  const Z_THRESHOLDS = [1.5, 2.0, 2.5];
  const WINDOWS = [96, 192, 480]; // 24h, 48h, 5days (in 15m bars)

  for (const w of WINDOWS) {
    for (const z of Z_THRESHOLDS) {
      L.push(`\n## window=${w} (15m bars = ${(w*15/60).toFixed(0)}h), |z|≥${z}\n`);
      L.push(`${pad('variant', 18)} | ${pad('period dir', 15)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 8)} | ${padS('PF', 5)}`);
      L.push('-'.repeat(80));

      for (const v of VARIANTS) {
        for (const p of periods) {
          const ctxETH = buildSafeContext(p.start, p.end, 'ETHUSDT');
          const ctxBTC = buildSafeContext(p.start, p.end, 'BTCUSDT');
          if (!ctxETH || !ctxBTC) continue;
          const sigs = buildEthBtcSignals(ctxETH, ctxBTC, z, w);
          const shortTrades = simulateSafe(ctxETH, sigs.entryShort, v, COST_RT);
          const longTrades = simulateSafe(ctxETH, sigs.entryLong, v, COST_RT);
          const sS = statsFor(shortTrades);
          const sL = statsFor(longTrades);
          if (sS.n > 0) L.push(`${pad(v.name, 18)} | ${pad(`${p.label} SHORT`, 15)} | ${padS(String(sS.n), 4)} | ${padS(sS.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sS.total), 8)} | ${padS(sS.pf.toFixed(2), 5)}`);
          if (sL.n > 0) L.push(`${pad(v.name, 18)} | ${pad(`${p.label} LONG`, 15)} | ${padS(String(sL.n), 4)} | ${padS(sL.wr.toFixed(0)+'%', 5)} | ${padS(fmt(sL.total), 8)} | ${padS(sL.pf.toFixed(2), 5)}`);
        }
        L.push('');
      }
    }
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R29-4_PAIR.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
