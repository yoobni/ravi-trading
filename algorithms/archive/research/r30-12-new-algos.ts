/**
 * R30-12 — 새 algo 8개. 알파 source 분명하게 분리해서 설계.
 *
 * 카테고리:
 * [A] 코인 무관/분산 강제
 *   N1 CROSS_TREND       : 매주 7d ROC 상위 3 코인만 BREAKOUT 매수 (cross-sectional momentum)
 *   N2 COIN_QUOTA        : 각 코인 max 5 진입/period (한 코인 의존 차단)
 *   N3 ALL_COIN_SIGNAL   : 5+ 코인 동시 강세 시 진입 (집단적 강세 확인)
 *
 * [B] 장 regime 명시 처리
 *   N4 BULL_ONLY_BREAKOUT: BTC daily close > 200d EMA 시만 진입
 *   N5 BEAR_REVERSAL     : BTC bear 시 RSI 30 회복 진입 (counter-trend)
 *   N6 VOL_REGIME_SWITCH : BTC ATR% 높을 때 mean reversion, 낮을 때 trend follow
 *
 * [C] 다른 차원
 *   N7 NEW_HIGH_CONFIRM  : 어제 신고가 + 오늘도 양봉 + 거래량 (follow-through)
 *   N8 LOW_VOL_BREAKOUT  : ATR % 30d 분위 하위 → breakout (변동성 expansion 직전)
 *
 * 검증:
 *   - 1년 (2025-06~26-06) + 2년 (2024-06~26-06) 각각
 *   - 분기 walk-forward: 4개 / 8개
 *   - top-3 코인 제거 시 PF
 *   - bull/bear regime PF
 *
 * Pool: 15 coin. Position 33% × max 3. TP/SL은 algo별 baseline 통일 (TP+5%/SL-2%/MAX 14d).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const UNIT = 60;
const COST_RT = 0.001;
const COINS_15 = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];

function loadBarsFor(coin: string, from: string, to: string): CachedBar[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `KRW-${coin}_${UNIT}m_${from}_${to}.json`), 'utf-8'));
}
function loadBars2Y(coin: string): CachedBar[] {
  const y1 = loadBarsFor(coin, '2024-06-10', '2025-06-10');
  const y2 = loadBarsFor(coin, '2025-06-10', '2026-06-10');
  const seen = new Set<number>();
  const all: CachedBar[] = [];
  for (const b of y1) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
  for (const b of y2) { if (!seen.has(b.ts)) { seen.add(b.ts); all.push(b); } }
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
function calcRSI(closes: number[], period = 14): (number|null)[] {
  const out: (number|null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period;
      if (i === period) { const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); } }
    else { avgGain = (avgGain*(period-1)+gain)/period; avgLoss = (avgLoss*(period-1)+loss)/period;
      const rs = avgGain / (avgLoss || 1e-12); out[i] = 100 - 100/(1+rs); }
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

interface RawSignal { coin: string; barIdx: number; ts: number; }

// ─── [A] 코인 무관/분산 ───

// N1 CROSS_TREND: 매 ts에서 코인 7d ROC ranking → top 3만 + BREAKOUT24
function sigN1(bars: CachedBar[], coin: string, rankTop3: Map<number, Set<string>>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    const rank = rankTop3.get(bars[i].ts);
    if (!rank || !rank.has(coin)) continue;
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// N3 ALL_COIN_SIGNAL: 한 ts에서 5+ 코인 동시 BREAKOUT24 시 모두 진입
function sigN3(allBars: Map<string, CachedBar[]>, coin: string): RawSignal[] {
  // 1) 모든 코인의 raw BREAKOUT 신호 수집
  const tsCount = new Map<number, number>();
  for (const [c, bars] of allBars) {
    const volumes = bars.map(b => b.volume);
    for (let i = 24 + 1; i < bars.length; i++) {
      let prevMax = -Infinity;
      for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
      if (bars[i].close <= prevMax) continue;
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 0.5) continue;
      tsCount.set(bars[i].ts, (tsCount.get(bars[i].ts) || 0) + 1);
    }
  }
  // 2) 자기 코인의 신호 중 5+ 코인 동시 진입한 ts만
  const bars = allBars.get(coin)!;
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = 24 + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    if ((tsCount.get(bars[i].ts) || 0) < 5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// ─── [B] 장 regime ───

// N4 BULL_ONLY_BREAKOUT: BTC daily close > 200d EMA만 진입 + BREAKOUT24
function sigN4(bars: CachedBar[], coin: string, btcRegime: Map<string, 'bull'|'bear'>): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const out: RawSignal[] = [];
  for (let i = 24 + 1; i < bars.length; i++) {
    const date = new Date(bars[i].ts + 9 * 3600_000).toISOString().slice(0, 10);
    if (btcRegime.get(date) !== 'bull') continue;
    let prevMax = -Infinity;
    for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// N5 BEAR_REVERSAL: BTC bear 시 RSI<30 후 cross up 30 + 양봉
function sigN5(bars: CachedBar[], coin: string, btcRegime: Map<string, 'bull'|'bear'>): RawSignal[] {
  const closes = bars.map(b => b.close);
  const rsi = calcRSI(closes, 14);
  const out: RawSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const date = new Date(bars[i].ts + 9 * 3600_000).toISOString().slice(0, 10);
    if (btcRegime.get(date) !== 'bear') continue;
    if (rsi[i-1] == null || rsi[i] == null) continue;
    if (!(rsi[i-1]! < 30 && rsi[i]! >= 30)) continue;
    if (bars[i].close <= bars[i].open) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// N6 VOL_REGIME_SWITCH: BTC daily ATR% 분위로 switch
//   ATR% high → mean reversion (RSI oversold bounce)
//   ATR% low  → trend follow (BREAKOUT24)
function sigN6(
  bars: CachedBar[], coin: string,
  btcVolRegime: Map<string, 'high'|'low'>,
): RawSignal[] {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const rsi = calcRSI(closes, 14);
  const out: RawSignal[] = [];
  for (let i = 24 + 1; i < bars.length; i++) {
    const date = new Date(bars[i].ts + 9 * 3600_000).toISOString().slice(0, 10);
    const regime = btcVolRegime.get(date);
    if (!regime) continue;
    if (regime === 'high') {
      // mean reversion
      if (rsi[i-1] == null || rsi[i] == null) continue;
      if (!(rsi[i-1]! < 30 && rsi[i]! >= 30)) continue;
      if (bars[i].close <= bars[i].open) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    } else {
      // trend follow
      let prevMax = -Infinity;
      for (let j = i - 24; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
      if (bars[i].close <= prevMax) continue;
      const z = calcVolZ(volumes, i, 30);
      if (z == null || z < 1.0) continue;
      out.push({ coin, barIdx: i, ts: bars[i].ts });
    }
  }
  return out;
}

// ─── [C] 다른 차원 ───

// N7 NEW_HIGH_CONFIRM: 어제 신고가 + 오늘 양봉 follow-through
function sigN7(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 168; // 7d
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    // 직전 24h (i-24~i-1) 안에 7d 신고가 발생했는가?
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i - 24; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    let yesterdayHigh = -Infinity;
    let madeNewHigh = false;
    for (let j = i - 24; j < i; j++) {
      if (bars[j].high > prevMax) madeNewHigh = true;
      if (bars[j].high > yesterdayHigh) yesterdayHigh = bars[j].high;
    }
    if (!madeNewHigh) continue;
    // 현재 bar 양봉 + 이전 24h high 갱신
    if (bars[i].close <= bars[i].open) continue;
    if (bars[i].close <= yesterdayHigh) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 0.5) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// N8 LOW_VOL_BREAKOUT: ATR% 30d 분위 하위 25% → BREAKOUT24
function sigN8(bars: CachedBar[], coin: string): RawSignal[] {
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const atr = calcATR(highs, lows, closes, 14);
  const lookback = 24;
  const atrLookback = 30 * 24; // 30d
  const out: RawSignal[] = [];
  for (let i = Math.max(lookback, atrLookback) + 1; i < bars.length; i++) {
    if (atr[i] == null) continue;
    // 30d 동안 ATR/close 분위 (현재)
    const atrPct = atr[i]! / closes[i];
    const sorted: number[] = [];
    for (let j = i - atrLookback; j < i; j++) {
      if (atr[j] != null && closes[j] > 0) sorted.push(atr[j]! / closes[j]);
    }
    sorted.sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    if (atrPct > p25) continue;
    // 추가: breakout 24h
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// N2 COIN_QUOTA: BREAKOUT24, 단 코인당 최대 5 trades / period (시간순 first-come)
//   simulate level에서 처리 (raw signals 그대로 + quota 적용)
function sigN2Raw(bars: CachedBar[], coin: string): RawSignal[] {
  const volumes = bars.map(b => b.volume);
  const lookback = 24;
  const out: RawSignal[] = [];
  for (let i = lookback + 1; i < bars.length; i++) {
    let prevMax = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j].high > prevMax) prevMax = bars[j].high;
    if (bars[i].close <= prevMax) continue;
    const z = calcVolZ(volumes, i, 30);
    if (z == null || z < 1.0) continue;
    out.push({ coin, barIdx: i, ts: bars[i].ts });
  }
  return out;
}

// ─── Simulation ───

const INITIAL_CASH = 10_000_000;
const POSITION_PCT = 0.33;
const MAX_CONCURRENT = 3;
const TP_PCT = 5.0;
const SL_PCT = -2.0;
const MAX_BARS = 336; // 14d

interface Position { coin: string; entryTs: number; entryIdx: number; entryPrice: number; vol: number; cashUsed: number; }
interface PfTrade { coin: string; entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; rawRet: number; netRet: number; profitKrw: number; reason: 'TP'|'SL'|'TIME'|'END'; }

function simulate(
  rawSignals: RawSignal[],
  barsByCoin: Map<string, CachedBar[]>,
  periodStartTs: number, periodEndTs: number,
  options?: { coinQuota?: number },
) {
  let cash = INITIAL_CASH;
  const positions: Position[] = [];
  const trades: PfTrade[] = [];
  const filtered = rawSignals.filter(s => s.ts >= periodStartTs && s.ts <= periodEndTs);
  const sigByTs = new Map<number, RawSignal[]>();
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
  const coinTradeCount = new Map<string, number>();
  let peak = INITIAL_CASH, mdd = 0;
  for (const ts of tsList) {
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const idx = idxByCoinTs.get(pos.coin)!.get(ts);
      if (idx == null) continue;
      const bars = barsByCoin.get(pos.coin)!;
      const b = bars[idx];
      const tp = pos.entryPrice * (1 + TP_PCT / 100), sl = pos.entryPrice * (1 + SL_PCT / 100);
      const holdBars = idx - pos.entryIdx;
      let exitPrice = 0, reason: PfTrade['reason'] | null = null, rawRet = 0;
      if (b.low <= sl) { exitPrice = sl; reason = 'SL'; rawRet = SL_PCT; }
      else if (b.high >= tp) { exitPrice = tp; reason = 'TP'; rawRet = TP_PCT; }
      else if (holdBars >= MAX_BARS) { exitPrice = b.close; reason = 'TIME'; rawRet = (b.close - pos.entryPrice) / pos.entryPrice * 100; }
      if (reason) {
        const gross = pos.vol * exitPrice;
        const cashGained = gross * (1 - COST_RT / 2);
        const profitKrw = cashGained - pos.cashUsed;
        const netRet = rawRet - COST_RT * 100;
        cash += cashGained;
        trades.push({ coin: pos.coin, entryTs: pos.entryTs, exitTs: ts, entryPrice: pos.entryPrice, exitPrice, rawRet, netRet, profitKrw, reason });
        positions.splice(p, 1);
      }
    }
    const sigs = sigByTs.get(ts) || [];
    for (const sig of sigs) {
      if (positions.length >= MAX_CONCURRENT) break;
      if (options?.coinQuota && (coinTradeCount.get(sig.coin) || 0) >= options.coinQuota) continue;
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
      cash -= cashToUse;
      positions.push({ coin: sig.coin, entryTs: eBar.ts, entryIdx, entryPrice, vol, cashUsed: cashToUse });
      coinTradeCount.set(sig.coin, (coinTradeCount.get(sig.coin) || 0) + 1);
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

function statsFor(trades: PfTrade[], finalCash: number, mdd: number) {
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
  console.log(`\n=== R30-12 새 algo 8개 검증 ===\n`);

  // Load bars
  console.log(`Loading 2y bars for ${COINS_15.length} coins...`);
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const coin of COINS_15) barsByCoin.set(coin, loadBars2Y(coin));

  // Build BTC daily regimes
  console.log('Building BTC daily regimes...');
  const btcBars = barsByCoin.get('BTC')!;
  const btcDaily = new Map<string, { open: number; high: number; low: number; close: number }>();
  for (const b of btcBars) {
    const date = new Date(b.ts + 9 * 3600_000).toISOString().slice(0, 10);
    const d = btcDaily.get(date);
    if (!d) btcDaily.set(date, { open: b.open, high: b.high, low: b.low, close: b.close });
    else { d.high = Math.max(d.high, b.high); d.low = Math.min(d.low, b.low); d.close = b.close; }
  }
  const dailyArr = [...btcDaily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyCloses = dailyArr.map(([, d]) => d.close);
  const dailyHighs = dailyArr.map(([, d]) => d.high);
  const dailyLows = dailyArr.map(([, d]) => d.low);
  const dailyEma200 = calcEMA(dailyCloses, 200);
  const dailyAtr14 = calcATR(dailyHighs, dailyLows, dailyCloses, 14);
  const btcRegime = new Map<string, 'bull'|'bear'>();
  const btcVolRegime = new Map<string, 'high'|'low'>();
  for (let i = 0; i < dailyArr.length; i++) {
    // bull/bear: D-1 daily close vs EMA200 (lookahead-safe: 사용은 다음 날부터)
    const reg = dailyEma200[i] != null && dailyArr[i][1].close > dailyEma200[i]! ? 'bull' : 'bear';
    // 다음 날 lookup용
    const nextDate = i + 1 < dailyArr.length ? dailyArr[i + 1][0] : null;
    if (nextDate) btcRegime.set(nextDate, reg);
    // ATR% high/low: 60d 분위 50% 기준
    if (dailyAtr14[i] != null && i >= 60) {
      const sorted: number[] = [];
      for (let j = i - 60; j < i; j++) {
        if (dailyAtr14[j] != null && dailyArr[j][1].close > 0) sorted.push(dailyAtr14[j]! / dailyArr[j][1].close);
      }
      sorted.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length * 0.5)];
      const curAtrPct = dailyAtr14[i]! / dailyArr[i][1].close;
      const volReg = curAtrPct > median ? 'high' : 'low';
      if (nextDate) btcVolRegime.set(nextDate, volReg);
    }
  }

  // Build N1 ranking (rolling per ts top-3 by 7d ROC)
  console.log('Building N1 ranking (7d ROC top-3 per ts)...');
  const allTs = new Set<number>();
  for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a, b) => a - b);
  const idxMap = new Map<string, Map<number, number>>();
  for (const [coin, bars] of barsByCoin) {
    const m = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) m.set(bars[i].ts, i);
    idxMap.set(coin, m);
  }
  const rankTop3 = new Map<number, Set<string>>();
  for (const ts of tsList) {
    const rocs: { coin: string; roc: number }[] = [];
    for (const [coin, bars] of barsByCoin) {
      const idx = idxMap.get(coin)!.get(ts);
      if (idx == null || idx < 168) continue;
      const cur = bars[idx].close;
      const prev = bars[idx - 168].close;
      const roc = (cur - prev) / prev * 100;
      rocs.push({ coin, roc });
    }
    rocs.sort((a, b) => b.roc - a.roc);
    rankTop3.set(ts, new Set(rocs.slice(0, 3).map(r => r.coin)));
  }

  // Build all signals
  console.log('Building signals for 8 algos...');
  const sigs: Record<string, RawSignal[]> = {
    'N1 CROSS_TREND':       [],
    'N2 COIN_QUOTA':        [],
    'N3 ALL_COIN_SIGNAL':   [],
    'N4 BULL_ONLY_BO':      [],
    'N5 BEAR_REVERSAL':     [],
    'N6 VOL_REGIME_SWITCH': [],
    'N7 NEW_HIGH_CONFIRM':  [],
    'N8 LOW_VOL_BREAKOUT':  [],
  };
  for (const coin of COINS_15) {
    const bars = barsByCoin.get(coin)!;
    for (const s of sigN1(bars, coin, rankTop3)) sigs['N1 CROSS_TREND'].push(s);
    for (const s of sigN2Raw(bars, coin)) sigs['N2 COIN_QUOTA'].push(s);
    for (const s of sigN3(barsByCoin, coin)) sigs['N3 ALL_COIN_SIGNAL'].push(s);
    for (const s of sigN4(bars, coin, btcRegime)) sigs['N4 BULL_ONLY_BO'].push(s);
    for (const s of sigN5(bars, coin, btcRegime)) sigs['N5 BEAR_REVERSAL'].push(s);
    for (const s of sigN6(bars, coin, btcVolRegime)) sigs['N6 VOL_REGIME_SWITCH'].push(s);
    for (const s of sigN7(bars, coin)) sigs['N7 NEW_HIGH_CONFIRM'].push(s);
    for (const s of sigN8(bars, coin)) sigs['N8 LOW_VOL_BREAKOUT'].push(s);
  }
  for (const k of Object.keys(sigs)) console.log(`  ${k}: ${sigs[k].length} signals`);

  const periods = [
    { name: '1Y (25-06~26-06)', start: '2025-06-10', end: '2026-06-10' },
    { name: '2Y (24-06~26-06)', start: '2024-06-10', end: '2026-06-10' },
  ];
  const quarters = [
    { name: 'Q1', start: '2024-06-10', end: '2024-09-10' },
    { name: 'Q2', start: '2024-09-10', end: '2024-12-10' },
    { name: 'Q3', start: '2024-12-10', end: '2025-03-10' },
    { name: 'Q4', start: '2025-03-10', end: '2025-06-10' },
    { name: 'Q5', start: '2025-06-10', end: '2025-09-10' },
    { name: 'Q6', start: '2025-09-10', end: '2025-12-10' },
    { name: 'Q7', start: '2025-12-10', end: '2026-03-10' },
    { name: 'Q8', start: '2026-03-10', end: '2026-06-10' },
  ];

  const L: string[] = [];
  L.push('='.repeat(170));
  L.push(`R30-12 — 새 algo 8개. 15코인 풀, TP+5%/SL-2%/MAX 14d, 자본 10M, position 33%×max 3`);
  L.push('='.repeat(170));

  // 1Y / 2Y
  for (const period of periods) {
    const pStart = new Date(`${period.start}T00:00:00+09:00`).getTime();
    const pEnd = new Date(`${period.end}T23:59:59+09:00`).getTime();
    L.push(`\n## ${period.name}\n`);
    L.push(`${pad('algo', 22)} | ${padS('n', 4)} | ${padS('WR', 5)} | ${padS('total', 9)} | ${padS('PF', 5)} | ${padS('MDD', 6)} | pass`);
    L.push('-'.repeat(85));
    for (const algoName of Object.keys(sigs)) {
      const opts = algoName === 'N2 COIN_QUOTA' ? { coinQuota: 5 } : undefined;
      const { trades, finalCash, mdd } = simulate(sigs[algoName], barsByCoin, pStart, pEnd, opts);
      const s = statsFor(trades, finalCash, mdd);
      const pass = s.pf >= 1.2 && s.total > 0;
      L.push(`${pad(algoName, 22)} | ${padS(String(s.n), 4)} | ${padS(s.wr.toFixed(0)+'%', 5)} | ${padS(fmt(s.total), 9)} | ${padS(s.pf.toFixed(2), 5)} | ${padS(s.mdd.toFixed(1)+'%', 6)} | ${pass ? '✓' : ''}`);
    }
  }

  // 분기 walk-forward (Q1~Q8)
  L.push(`\n## 분기 walk-forward (Q1~Q8 통과 횟수)\n`);
  L.push(`${pad('algo', 22)} | ${quarters.map(q => padS(q.name, 3)).join(' | ')} | pass/8`);
  L.push('-'.repeat(85));
  for (const algoName of Object.keys(sigs)) {
    const opts = algoName === 'N2 COIN_QUOTA' ? { coinQuota: 5 } : undefined;
    const passes: boolean[] = [];
    for (const q of quarters) {
      const pStart = new Date(`${q.start}T00:00:00+09:00`).getTime();
      const pEnd = new Date(`${q.end}T23:59:59+09:00`).getTime();
      const { trades, finalCash, mdd } = simulate(sigs[algoName], barsByCoin, pStart, pEnd, opts);
      const s = statsFor(trades, finalCash, mdd);
      passes.push(s.pf >= 1.2 && s.total > 0);
    }
    const cnt = passes.filter(p => p).length;
    L.push(`${pad(algoName, 22)} | ${passes.map(p => padS(p ? '✓' : '✗', 3)).join(' | ')} | ${cnt}/8`);
  }

  // 코인 의존도 — 2Y 기준 top-3 제거
  L.push(`\n## 코인 의존도 (2Y, top-3 코인 제거 시 PF)\n`);
  L.push(`${pad('algo', 22)} | ${padS('full PF', 8)} | ${padS('top-1 제외', 11)} | ${padS('top-3 제외', 11)}`);
  L.push('-'.repeat(70));
  const pStart2y = new Date('2024-06-10T00:00:00+09:00').getTime();
  const pEnd2y = new Date('2026-06-10T23:59:59+09:00').getTime();
  for (const algoName of Object.keys(sigs)) {
    const opts = algoName === 'N2 COIN_QUOTA' ? { coinQuota: 5 } : undefined;
    const { trades: full } = simulate(sigs[algoName], barsByCoin, pStart2y, pEnd2y, opts);
    const fullPF = (() => { const w = full.filter(t => t.profitKrw > 0).reduce((s, t) => s + t.profitKrw, 0); const l = Math.abs(full.filter(t => t.profitKrw <= 0).reduce((s, t) => s + t.profitKrw, 0)); return l > 0 ? w / l : (w > 0 ? 99 : 0); })();
    // 코인별 PnL 합 → top-3 코인 식별
    const byCoin = new Map<string, number>();
    for (const t of full) byCoin.set(t.coin, (byCoin.get(t.coin) || 0) + t.profitKrw);
    const sortedCoins = [...byCoin.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const top1 = new Set(sortedCoins.slice(0, 1));
    const top3 = new Set(sortedCoins.slice(0, 3));
    const minus1 = full.filter(t => !top1.has(t.coin));
    const minus3 = full.filter(t => !top3.has(t.coin));
    const pf1 = (() => { const w = minus1.filter(t => t.profitKrw > 0).reduce((s, t) => s + t.profitKrw, 0); const l = Math.abs(minus1.filter(t => t.profitKrw <= 0).reduce((s, t) => s + t.profitKrw, 0)); return l > 0 ? w / l : (w > 0 ? 99 : 0); })();
    const pf3 = (() => { const w = minus3.filter(t => t.profitKrw > 0).reduce((s, t) => s + t.profitKrw, 0); const l = Math.abs(minus3.filter(t => t.profitKrw <= 0).reduce((s, t) => s + t.profitKrw, 0)); return l > 0 ? w / l : (w > 0 ? 99 : 0); })();
    L.push(`${pad(algoName, 22)} | ${padS(fullPF.toFixed(2), 8)} | ${padS(pf1.toFixed(2)+` (${[...top1][0]||''})`, 11)} | ${padS(pf3.toFixed(2), 11)}`);
  }

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R30-12_NEW.txt`), L.join('\n'));
  process.exit(0);
})();
