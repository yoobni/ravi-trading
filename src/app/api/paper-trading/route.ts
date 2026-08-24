/**
 * GET /api/paper-trading
 *
 * F1F2_50 (MAIN) + F6 NEW_HIGH 42 paper portfolio 통합 조회.
 * 각 strategy: cash, positions (current price → unrealized PnL), totalTrades, equity, returnRate.
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  STATE_FILE as F1F2_STATE_FILE,
  POSITIONS_FILE as F1F2_POSITIONS_FILE,
  INITIAL_CASH_KRW as F1F2_INITIAL_CASH,
  TP_PCT as F1F2_TP_PCT,
  SL_PCT as F1F2_SL_PCT,
  MAX_DAYS as F1F2_MAX_DAYS,
} from '@/lib/paper-trading-store';
import {
  F6_STATE_FILE, F6_TRADES_FILE, F6_INITIAL_CASH_KRW, F6_TP_PCT, F6_SL_PCT, F6_MAX_BARS,
} from '@/lib/paper-f6-store';
import {
  F6V2_STATE_FILE, F6V2_TRADES_FILE, F6V2_INITIAL_CASH_KRW, F6V2_TP_PCT, F6V2_SL_PCT, F6V2_MAX_BARS,
} from '@/lib/paper-f6v2-store';
import {
  F6V3_STATE_FILE, F6V3_TRADES_FILE, F6V3_INITIAL_CASH_KRW, F6V3_TP_PCT, F6V3_SL_PCT, F6V3_MAX_BARS,
} from '@/lib/paper-f6v3-store';
import {
  F6V5_STATE_FILE, F6V5_TRADES_FILE, F6V5_INITIAL_CASH_KRW, F6V5_SL_PCT, F6V5_TRAIL_ACT, F6V5_TRAIL_GAP, F6V5_MAX_BARS,
} from '@/lib/paper-f6v5-store';
import {
  F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_INITIAL_CASH_KRW, F6V6_SL_PCT, F6V6_TRAIL_ACT, F6V6_TRAIL_GAP, F6V6_MAX_BARS,
} from '@/lib/paper-f6v6-store';
import { strategyDescription } from '@/lib/paper-strategy-meta';
import {
  computeStrategyMetrics, computePortfolio,
  type StrategyMetrics, type ClosedTradeLite,
} from '@/lib/paper-metrics';

interface PaperStrategy {
  id: string;
  name: string;
  /**
   * 합성 포트폴리오에서 제외되는 벤치마크 여부.
   * F1F2_100 은 F1F2_50 과 동일 신호를 자본 100% 로 태운 사이징 비교군이라
   * (상관 ≈ 1) 합성에 같이 넣으면 같은 전략을 이중 계산하게 된다.
   */
  benchmark?: boolean;
  description: string;
  rule: string;
  capitalAlloc: number;
  cash: number;
  positionValue: number;
  totalEquity: number;
  returnRate: number;
  totalTrades: number;
  totalRealizedPnl: number;
  positions: Array<{
    market: string;
    entryDate: string;
    entryPrice: number;
    currentPrice: number;
    vol: number;
    profitRate: number;
    profitKrw: number;
    daysHeld: number;
  }>;
  lastTickAt: string | null;
  metrics: StrategyMetrics;
}

interface F1F2Position {
  signal: string;
  entryDate: string;
  entryPrice: number;
  vol: number;
  buyAmount: number;
}

function safeReadJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function readJsonl<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** F6 계열 trades.jsonl → ClosedTradeLite */
function tradesFromFile(p: string): ClosedTradeLite[] {
  return readJsonl<any>(p).map((t) => ({ profitKrw: t.profitKrw, exitTs: t.exitTs }));
}

function daysSince(date: string): number {
  const ms = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.floor(ms / 86400_000));
}

export async function GET() {
  // Load states
  const f1f2State = safeReadJson<any>(F1F2_STATE_FILE);
  const f6State = safeReadJson<any>(F6_STATE_FILE);
  const f6v2State = safeReadJson<any>(F6V2_STATE_FILE);
  const f6v3State = safeReadJson<any>(F6V3_STATE_FILE);
  const f6v5State = safeReadJson<any>(F6V5_STATE_FILE);
  const f6v6State = safeReadJson<any>(F6V6_STATE_FILE);

  // Collect all markets to fetch ticker
  const markets = new Set<string>();
  if (f1f2State?.strategies?.FUNDING_F1F2_50?.position) markets.add('KRW-BTC');
  if (f6State?.positions) for (const p of f6State.positions) markets.add(p.market);
  if (f6v2State?.positions) for (const p of f6v2State.positions) markets.add(p.market);
  if (f6v3State?.positions) for (const p of f6v3State.positions) markets.add(p.market);
  if (f6v5State?.positions) for (const p of f6v5State.positions) markets.add(p.market);
  if (f6v6State?.positions) for (const p of f6v6State.positions) markets.add(p.market);

  const priceByMarket = new Map<string, number>();
  if (markets.size > 0) {
    try {
      const client = getUpbitClient();
      const tickers = await client.getTicker([...markets]);
      for (const t of tickers as any[]) priceByMarket.set(t.market, t.trade_price);
    } catch (e) {
      console.warn('[api/paper-trading] ticker fetch failed:', e);
    }
  }

  const strategies: PaperStrategy[] = [];
  const portfolioInputs: Array<{ initial: number; equity: number; trades: ClosedTradeLite[] }> = [];

  // F1F2_50
  if (f1f2State?.strategies?.FUNDING_F1F2_50) {
    const st = f1f2State.strategies.FUNDING_F1F2_50;
    const pos = st.position as F1F2Position | null;
    const positions = [];
    let positionValue = 0;
    if (pos) {
      const cur = priceByMarket.get('KRW-BTC') ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.buyAmount;
      positionValue = pos.vol * cur;
      positions.push({
        market: 'KRW-BTC',
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = st.cash + positionValue;
    const f1f2Trades: ClosedTradeLite[] = readJsonl<any>(F1F2_POSITIONS_FILE)
      .filter((t) => t.strategy === 'FUNDING_F1F2_50')
      .map((t) => ({ profitKrw: t.profitKrw, exitTs: Date.parse(t.exitDate) }));
    const metrics = computeStrategyMetrics({
      initial: F1F2_INITIAL_CASH,
      cash: st.cash,
      positions: pos ? [{ cashUsed: pos.buyAmount, vol: pos.vol, entryPrice: pos.entryPrice, market: 'KRW-BTC' }] : [],
      trades: f1f2Trades,
      currentPrices: priceByMarket,
    });
    portfolioInputs.push({ initial: F1F2_INITIAL_CASH, equity, trades: f1f2Trades });
    strategies.push({
      id: 'F1F2_50',
      name: 'FUNDING_F1F2_50 (MAIN)',
      description: strategyDescription('F1F2_50'),
      rule: `daily F1/F2 funding extreme → LONG @ open. TP+${F1F2_TP_PCT}%/SL${F1F2_SL_PCT}%/MAX ${F1F2_MAX_DAYS}d`,
      capitalAlloc: F1F2_INITIAL_CASH,
      cash: st.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F1F2_INITIAL_CASH) / F1F2_INITIAL_CASH * 100,
      totalTrades: st.totalTrades || 0,
      totalRealizedPnl: st.totalRealizedPnl || 0,
      positions,
      lastTickAt: f1f2State.lastTickDate || null,
      metrics,
    });
  }

  // F1F2_100 (BENCHMARK) — F1F2_50 동일 신호, 자본 100% aggressive
  if (f1f2State?.strategies?.FUNDING_F1F2_100) {
    const st100 = f1f2State.strategies.FUNDING_F1F2_100;
    const pos100 = st100.position as F1F2Position | null;
    const positions100 = [];
    let positionValue100 = 0;
    if (pos100) {
      const cur = priceByMarket.get('KRW-BTC') ?? pos100.entryPrice;
      const profitRate = (cur - pos100.entryPrice) / pos100.entryPrice * 100;
      const profitKrw = pos100.vol * cur - pos100.buyAmount;
      positionValue100 = pos100.vol * cur;
      positions100.push({
        market: 'KRW-BTC',
        entryDate: pos100.entryDate,
        entryPrice: pos100.entryPrice,
        currentPrice: cur,
        vol: pos100.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos100.entryDate),
      });
    }
    const equity100 = st100.cash + positionValue100;
    const f1f2Trades100: ClosedTradeLite[] = readJsonl<any>(F1F2_POSITIONS_FILE)
      .filter((t) => t.strategy === 'FUNDING_F1F2_100')
      .map((t) => ({ profitKrw: t.profitKrw, exitTs: Date.parse(t.exitDate) }));
    const metrics100 = computeStrategyMetrics({
      initial: F1F2_INITIAL_CASH,
      cash: st100.cash,
      positions: pos100 ? [{ cashUsed: pos100.buyAmount, vol: pos100.vol, entryPrice: pos100.entryPrice, market: 'KRW-BTC' }] : [],
      trades: f1f2Trades100,
      currentPrices: priceByMarket,
    });
    // 합성 제외 (F1F2_50 과 동일 신호 · 상관 ≈ 1 — 사이징 비교군)
    strategies.push({
      id: 'F1F2_100',
      name: 'FUNDING_F1F2_100 (BENCHMARK)',
      benchmark: true,
      description: strategyDescription('F1F2_100'),
      rule: `daily F1/F2 funding extreme → LONG @ open. TP+${F1F2_TP_PCT}%/SL${F1F2_SL_PCT}%/MAX ${F1F2_MAX_DAYS}d`,
      capitalAlloc: F1F2_INITIAL_CASH,
      cash: st100.cash,
      positionValue: positionValue100,
      totalEquity: equity100,
      returnRate: (equity100 - F1F2_INITIAL_CASH) / F1F2_INITIAL_CASH * 100,
      totalTrades: st100.totalTrades || 0,
      totalRealizedPnl: st100.totalRealizedPnl || 0,
      positions: positions100,
      lastTickAt: f1f2State.lastTickDate || null,
      metrics: metrics100,
    });
  }

  // F6_v2 (TP_OPT) — F6_v1과 별도, 같은 signal 다른 exit
  if (f6v2State) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (f6v2State.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.cashUsed;
      const v = pos.vol * cur;
      positionValue += v;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = f6v2State.cash + positionValue;
    const f6v2Trades = tradesFromFile(F6V2_TRADES_FILE);
    portfolioInputs.push({ initial: F6V2_INITIAL_CASH_KRW, equity, trades: f6v2Trades });
    strategies.push({
      id: 'F6_v2',
      name: 'F6_v2 NEW_HIGH 42 (TP_OPT)',
      description: strategyDescription('F6_v2'),
      rule: `7d high break + 양봉 + vol z≥0.5 → TP+${F6V2_TP_PCT}%/SL${F6V2_SL_PCT}%/MAX ${F6V2_MAX_BARS/6}d`,
      capitalAlloc: F6V2_INITIAL_CASH_KRW,
      cash: f6v2State.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F6V2_INITIAL_CASH_KRW) / F6V2_INITIAL_CASH_KRW * 100,
      totalTrades: f6v2State.totalTrades || 0,
      totalRealizedPnl: f6v2State.totalRealizedPnl || 0,
      positions,
      lastTickAt: f6v2State.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F6V2_INITIAL_CASH_KRW, cash: f6v2State.cash,
        positions: f6v2State.positions || [], trades: f6v2Trades, currentPrices: priceByMarket,
      }),
    });
  }

  // F6
  if (f6State) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (f6State.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.cashUsed;
      const v = pos.vol * cur;
      positionValue += v;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = f6State.cash + positionValue;
    const f6Trades = tradesFromFile(F6_TRADES_FILE);
    portfolioInputs.push({ initial: F6_INITIAL_CASH_KRW, equity, trades: f6Trades });
    strategies.push({
      id: 'F6',
      name: 'F6 NEW_HIGH 42',
      description: strategyDescription('F6'),
      rule: `7d high break + 양봉 + vol z≥0.5 → TP+${F6_TP_PCT}%/SL${F6_SL_PCT}%/MAX ${F6_MAX_BARS/6}d`,
      capitalAlloc: F6_INITIAL_CASH_KRW,
      cash: f6State.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F6_INITIAL_CASH_KRW) / F6_INITIAL_CASH_KRW * 100,
      totalTrades: f6State.totalTrades || 0,
      totalRealizedPnl: f6State.totalRealizedPnl || 0,
      positions,
      lastTickAt: f6State.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F6_INITIAL_CASH_KRW, cash: f6State.cash,
        positions: f6State.positions || [], trades: f6Trades, currentPrices: priceByMarket,
      }),
    });
  }

  // F6_v3 (CONFIRM) — 거짓돌파 확정 + TP10/SL3, 25%×4
  if (f6v3State) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (f6v3State.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.cashUsed;
      const v = pos.vol * cur;
      positionValue += v;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = f6v3State.cash + positionValue;
    const f6v3Trades = tradesFromFile(F6V3_TRADES_FILE);
    portfolioInputs.push({ initial: F6V3_INITIAL_CASH_KRW, equity, trades: f6v3Trades });
    strategies.push({
      id: 'F6_v3',
      name: 'F6_v3 NEW_HIGH 42 (CONFIRM)',
      description: strategyDescription('F6_v3'),
      rule: `7d high break + 확인봉 follow + vol z≥0.5 → TP+${F6V3_TP_PCT}%/SL${F6V3_SL_PCT}%/MAX ${F6V3_MAX_BARS/6}d, 25%×4`,
      capitalAlloc: F6V3_INITIAL_CASH_KRW,
      cash: f6v3State.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F6V3_INITIAL_CASH_KRW) / F6V3_INITIAL_CASH_KRW * 100,
      totalTrades: f6v3State.totalTrades || 0,
      totalRealizedPnl: f6v3State.totalRealizedPnl || 0,
      positions,
      lastTickAt: f6v3State.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F6V3_INITIAL_CASH_KRW, cash: f6v3State.cash,
        positions: f6v3State.positions || [], trades: f6v3Trades, currentPrices: priceByMarket,
      }),
    });
  }

  // F6_v5 (TRAIL) — F6 신호 + 트레일링 스톱(승자 태우기). H4 백테스트 근거.
  if (f6v5State) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (f6v5State.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.cashUsed;
      const v = pos.vol * cur;
      positionValue += v;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = f6v5State.cash + positionValue;
    const f6v5Trades = tradesFromFile(F6V5_TRADES_FILE);
    portfolioInputs.push({ initial: F6V5_INITIAL_CASH_KRW, equity, trades: f6v5Trades });
    strategies.push({
      id: 'F6_v5',
      name: 'F6_v5 NEW_HIGH 42 (TRAIL A2·안정)',
      description: strategyDescription('F6_v5'),
      rule: `7d high break + 양봉 + vol z≥0.5 → SL${F6V5_SL_PCT}%, +${F6V5_TRAIL_ACT}% 후 고점−${F6V5_TRAIL_GAP}% 트레일 / MAX ${F6V5_MAX_BARS/6}d, 33%×3`,
      capitalAlloc: F6V5_INITIAL_CASH_KRW,
      cash: f6v5State.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F6V5_INITIAL_CASH_KRW) / F6V5_INITIAL_CASH_KRW * 100,
      totalTrades: f6v5State.totalTrades || 0,
      totalRealizedPnl: f6v5State.totalRealizedPnl || 0,
      positions,
      lastTickAt: f6v5State.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F6V5_INITIAL_CASH_KRW, cash: f6v5State.cash,
        positions: f6v5State.positions || [], trades: f6v5Trades, currentPrices: priceByMarket,
      }),
    });
  }

  // F6_v6 (TRAIL A4·수익) — F6 신호 + 트레일링(act4/gap2). F6_v5(A2)의 공격형 자매.
  if (f6v6State) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (f6v6State.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      const profitRate = (cur - pos.entryPrice) / pos.entryPrice * 100;
      const profitKrw = pos.vol * cur - pos.cashUsed;
      const v = pos.vol * cur;
      positionValue += v;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate,
        profitKrw,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = f6v6State.cash + positionValue;
    const f6v6Trades = tradesFromFile(F6V6_TRADES_FILE);
    portfolioInputs.push({ initial: F6V6_INITIAL_CASH_KRW, equity, trades: f6v6Trades });
    strategies.push({
      id: 'F6_v6',
      name: 'F6_v6 NEW_HIGH (TRAIL 12h·A2)',
      description: strategyDescription('F6_v6'),
      rule: `[12h봉] 7d high break + 양봉 + vol z≥0.5 → SL${F6V6_SL_PCT}%, +${F6V6_TRAIL_ACT}% 후 고점−${F6V6_TRAIL_GAP}% 트레일 / MAX ${F6V6_MAX_BARS/2}d, 33%×3`,
      capitalAlloc: F6V6_INITIAL_CASH_KRW,
      cash: f6v6State.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F6V6_INITIAL_CASH_KRW) / F6V6_INITIAL_CASH_KRW * 100,
      totalTrades: f6v6State.totalTrades || 0,
      totalRealizedPnl: f6v6State.totalRealizedPnl || 0,
      positions,
      lastTickAt: f6v6State.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F6V6_INITIAL_CASH_KRW, cash: f6v6State.cash,
        positions: f6v6State.positions || [], trades: f6v6Trades, currentPrices: priceByMarket,
      }),
    });
  }

  // 합계는 실제 운영 전략만 (벤치마크 제외) — portfolioInputs 와 같은 모집단
  const operating = strategies.filter((x) => !x.benchmark);
  const totalCapital = operating.reduce((s, x) => s + x.capitalAlloc, 0);
  const totalEquity = operating.reduce((s, x) => s + x.totalEquity, 0);
  const portfolio = computePortfolio(portfolioInputs);

  return NextResponse.json({
    strategies,
    total: {
      capitalAlloc: totalCapital,
      totalEquity,
      returnRate: totalCapital > 0 ? (totalEquity - totalCapital) / totalCapital * 100 : 0,
      realizedMdd: portfolio.realizedMdd,
      trades: portfolio.trades,
      excluded: strategies.filter((x) => x.benchmark).map((x) => x.id),
    },
    now: new Date().toISOString(),
  });
}
