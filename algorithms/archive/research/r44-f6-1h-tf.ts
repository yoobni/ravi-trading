/**
 * R44 — F6 신고가-돌파 로직을 1h TF로 변형 비교 (2년, 28코인).
 *
 * ★ 운영 paper(F6/F6_v2) 절대 안 건드림. 읽기 전용 R&D 백테스트.
 *   - 캔들은 fetchMinutesCached로 별도 캐시(data/candle-cache), 결과는 data/research.
 *   - 엔진/신호/시뮬은 R36(검증된 F6 백테스트)에서 그대로 가져옴.
 *
 * 3-way 비교 (동일 엔진·코인풀·비용 RT 0.1%):
 *   4h BASE  : unit 240, lookback 42,  MAX 84bar,  TP5/SL-2  ← 현 F6 paper
 *   1h TIME  : unit 60,  lookback 168, MAX 336bar, TP5/SL-2  (7일 신고가·14d 보유 = 시간 의미 유지)
 *   1h BAR   : unit 60,  lookback 42,  MAX 84bar,  TP5/SL-2  (bar 수 유지 = 더 단기)
 *
 * 통과 기준: 분기 PF≥1.2 & total>0.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fetchMinutesCached, type CachedBar } from '../_candle-cache';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const COST_RT = 0.001;

const FROM = '2024-06-10';
const TO = '2026-06-10';

const COINS_28 = [
  'BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH',
  'POL','NEAR','ATOM','TRX','ALGO',
  'ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT',
];

// ── 지표 (R36 그대로) ─────────────────────────────────────
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
function calcATR(highs: number[], lows: number[], closes: number[], period = 14): (number|null)[] {
  const tr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let atr: number | null = null; let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { sum += tr[i]; continue; }
    if (atr === null) { sum += tr[i]; atr = sum / period; }
    else atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
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
function buildBtcDaily(btcBars: CachedBar[]) {
  const byDate = new Map<string, { o: number; h: number; l: number; c: number; }>();
  for (const b of btcBars) {
    const d = new Date(b.ts + 9*3600_000).toISOString().slice(0, 10);
    const cur = byDate.get(d);
    if (!cur) byDate.set(d, { o: b.open, h: b.high, l: b.low, c: b.close });
    else { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.c = b.close; }
  }
  const arr = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const closes = arr.map(([, d]) => d.c);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const dateToData = new Map<string, { c: number; ema50: number|null; ema200: number|null }>();
  for (let i = 0; i < arr.length; i++) dateToData.set(arr[i][0], { c: arr[i][1].c, ema50: ema50[i], ema200: ema200[i] });
  return dateToData;
}

interface Signal { coin: string; barIdx: number; ts: number; volZ: number; }
function sigF6Generic(bars: CachedBar[], coin: string, lookback: number, volZThresh: number): Signal[] {
  const volumes = bars.map(b => b.volume);
  const out: Signal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i - 1; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (!(bars[i-1].high > prevMax)) continue;
    if (!(bars[i].close > bars[i].open)) continue;
    if (!(bars[i].close > bars[i-1].high)) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < volZThresh) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts, volZ: z });
  }
  return out;
}

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; tp: number; sl: number; maxBars: number; }
interface Trade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }
interface VariantConfig { name: string; tp: number; sl: number; maxBars: number; }

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
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let q = positions.length - 1; q >= 0; q--) {
      const pos = positions[q];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: Trade['reason'] | null = null, rawRet = 0;
      if (b.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; rawRet = (pos.sl - pos.entryPrice) / pos.entryPrice * 100; }
      else if (b.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; rawRet = (pos.tp - pos.entryPrice) / pos.entryPrice * 100; }
      else if (holdBars >= pos.maxBars) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
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
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
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
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].ts <= periodEndTs) { lastIdx = i; break; } }
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
  console.log(`\n=== R44 — F6 1h TF 비교 (2년 28코인) ===\n`);

  // fetch 4h + 1h (캐시)
  const bars4h = new Map<string, CachedBar[]>();
  const bars1h = new Map<string, CachedBar[]>();
  for (const coin of COINS_28) {
    const mkt = `KRW-${coin}`;
    process.stdout.write(`fetch ${coin} 4h...`);
    const b4 = await fetchMinutesCached(mkt, 240, FROM, TO);
    process.stdout.write(` 1h...`);
    const b1 = await fetchMinutesCached(mkt, 60, FROM, TO);
    console.log(` 4h=${b4.length} 1h=${b1.length}`);
    // 동일 코인풀 보장: 두 TF 모두 충분할 때만 포함
    if (b4.length >= 4000 && b1.length >= 12000) { bars4h.set(coin, b4); bars1h.set(coin, b1); }
  }
  console.log(`\n공통 코인풀: ${bars4h.size}개 (4h≥4000 & 1h≥12000)`);

  const variants: { name: string; barsByCoin: Map<string, CachedBar[]>; lookback: number; maxBars: number }[] = [
    { name: '4h BASE  ★',  barsByCoin: bars4h, lookback: 42,  maxBars: 84  },
    { name: '1h TIME',     barsByCoin: bars1h, lookback: 168, maxBars: 336 },
    { name: '1h BAR',      barsByCoin: bars1h, lookback: 42,  maxBars: 84  },
  ];

  const periodAll = {
    start: new Date('2024-06-10T00:00:00+09:00').getTime(),
    end: new Date('2026-06-10T23:59:59+09:00').getTime(),
  };
  const quarters: { name: string; start: string; end: string }[] = [];
  const sd = new Date('2024-06-10');
  for (let q = 0; q < 8; q++) {
    const s = new Date(sd); s.setMonth(s.getMonth() + q * 3);
    const e = new Date(s); e.setMonth(e.getMonth() + 3);
    quarters.push({ name: `Q${q+1}`, start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
  }

  const L: string[] = [];
  L.push('='.repeat(120));
  L.push(`R44 — F6 신고가돌파 1h TF 비교 (2년 2024-06~2026-06, ${bars4h.size}코인 공통풀)`);
  L.push(`Capital 10M, position 33% × max 3, cost RT 0.1%. 진입=신호 다음봉 open, TP+5%/SL-2%.`);
  L.push('='.repeat(120));

  interface Row { name: string; full: ReturnType<typeof statsFor>; oneYear: ReturnType<typeof statsFor>; qPass: number; qDetail: string[] }
  const rows: Row[] = [];

  for (const v of variants) {
    const sigs: Signal[] = [];
    for (const c of v.barsByCoin.keys()) for (const s of sigF6Generic(v.barsByCoin.get(c)!, c, v.lookback, 0.5)) sigs.push(s);
    const cfg: VariantConfig = { name: v.name, tp: 5, sl: -2, maxBars: v.maxBars };

    const rFull = simulate(cfg, sigs, v.barsByCoin, periodAll.start, periodAll.end);
    const full = statsFor(rFull.trades, rFull.finalCash, rFull.mdd);

    let qPass = 0; const qDetail: string[] = [];
    for (const q of quarters) {
      const ps = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pe = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const rr = simulate(cfg, sigs, v.barsByCoin, ps, pe);
      const ss = statsFor(rr.trades, rr.finalCash, rr.mdd);
      const pass = ss.pf >= 1.2 && ss.total > 0;
      if (pass) qPass++;
      qDetail.push(`${ss.pf.toFixed(2)}/${fmt(ss.total)}${pass?'✓':''}`);
    }
    const r1y = simulate(cfg, sigs, v.barsByCoin, new Date('2025-06-10T00:00:00+09:00').getTime(), periodAll.end);
    const oneYear = statsFor(r1y.trades, r1y.finalCash, r1y.mdd);
    rows.push({ name: v.name, full, oneYear, qPass, qDetail });
  }

  L.push(`\n## 2Y FULL\n`);
  L.push(`${pad('variant', 12)} | ${padS('n', 6)} | ${padS('WR', 5)} | ${padS('total', 10)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(70));
  for (const r of rows) {
    const p = r.full.pf >= 1.2 && r.full.total > 0;
    L.push(`${pad(r.name, 12)} | ${padS(String(r.full.n), 6)} | ${padS(r.full.wr.toFixed(0)+'%', 5)} | ${padS(fmt(r.full.total), 10)} | ${padS(r.full.pf.toFixed(2), 5)} | ${padS(r.full.mdd.toFixed(1)+'%', 6)} | ${p?'✓':''}`);
  }

  L.push(`\n## 1Y (최근 2025-06~2026-06)\n`);
  L.push(`${pad('variant', 12)} | ${padS('n', 6)} | ${padS('WR', 5)} | ${padS('total', 10)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
  L.push('-'.repeat(70));
  for (const r of rows) {
    const s = r.oneYear; const p = s.pf >= 1.2 && s.total > 0;
    L.push(`${pad(r.name, 12)} | ${padS(String(s.n), 6)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 10)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${p?'✓':''}`);
  }

  L.push(`\n## 분기 통과 (Q1~Q8, PF≥1.2 & total>0)\n`);
  L.push(`${pad('variant', 12)} | ${padS('pass/8', 7)} | 분기별 PF/total`);
  L.push('-'.repeat(110));
  for (const r of rows) {
    L.push(`${pad(r.name, 12)} | ${padS(`${r.qPass}/8`, 7)} | ${r.qDetail.join('  ')}`);
  }

  const out = L.join('\n');
  console.log(out);
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R44_F6_1h.txt`), out);
  console.log(`\n저장: data/research/${stamp}_R44_F6_1h.txt`);
  process.exit(0);
})();
