/**
 * GET /api/paper-trading
 *
 * F1F2 + F6 · F6_v6 + F7 계열 paper portfolio 통합 조회.
 * (2026-10-01 함대 개편: F6_v2·v3·v5·v7·v8 은퇴 → data/_archive/20261001/)
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
  F6V6_STATE_FILE, F6V6_TRADES_FILE, F6V6_INITIAL_CASH_KRW, F6V6_SL_PCT, F6V6_TRAIL_ACT, F6V6_TRAIL_GAP, F6V6_MAX_BARS,
} from '@/lib/paper-f6v6-store';
import { BT_STATE_FILE, BT_TRADES_FILE, BT_INITIAL_CASH_KRW, BT_SMA_DAYS } from '@/lib/paper-btctrend-store';
import { F7_VARIANTS, F7_INITIAL_CASH_KRW, F7_POSITION_PCT, F7_MAX_CONCURRENT, f7Files } from '@/lib/paper-f7-store';
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
  const f6v6State = safeReadJson<any>(F6V6_STATE_FILE);
  const btState = safeReadJson<any>(BT_STATE_FILE);
  const f7States = F7_VARIANTS.map((v) => ({ v, state: safeReadJson<any>(f7Files(v).state) }));

  // Collect all markets to fetch ticker
  const markets = new Set<string>();
  if (f1f2State?.strategies?.FUNDING_F1F2_50?.position) markets.add('KRW-BTC');
  if (f6State?.positions) for (const p of f6State.positions) markets.add(p.market);
  if (f6v6State?.positions) for (const p of f6v6State.positions) markets.add(p.market);
  for (const { state } of f7States) for (const p of state?.positions || []) markets.add(p.market);
  if (btState?.positions?.length) markets.add('KRW-BTC');

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

  // F6_v6 (TRAIL 12h·A2) — F6 신호를 12h 봉에 · 트레일링(act2/gap2).
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

  // F7 계열 — "체결손실 0" 설계: TP 지정가 + 시간청산(+ F7_sl 만 손절). 규칙은 paper-f7-store.ts.
  for (const { v, state } of f7States) {
    if (!state) continue;
    const positions = [];
    let positionValue = 0;
    for (const pos of (state.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      positionValue += pos.vol * cur;
      positions.push({
        market: pos.market,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        currentPrice: cur,
        vol: pos.vol,
        profitRate: (cur - pos.entryPrice) / pos.entryPrice * 100,
        profitKrw: pos.vol * cur - pos.cashUsed,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = state.cash + positionValue;
    const trades = tradesFromFile(f7Files(v).trades);
    portfolioInputs.push({ initial: F7_INITIAL_CASH_KRW, equity, trades });
    strategies.push({
      id: v.id,
      name: v.name,
      description: strategyDescription(v.id),
      rule: `7d high break + 양봉 + vol z\u22650.5 \u2192 TP 지정가 +${v.tpPct}% / ${v.slPct == null ? '스톱 없음' : `손절 ${v.slPct}%(봉마감 시장가)`} / ${v.maxBars / 6}일 시간청산, ${F7_POSITION_PCT * 100}%\u00d7${F7_MAX_CONCURRENT}${v.btc50 ? ' · BTC 50일선 아래면 진입 중단' : ''}`,
      capitalAlloc: F7_INITIAL_CASH_KRW,
      cash: state.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - F7_INITIAL_CASH_KRW) / F7_INITIAL_CASH_KRW * 100,
      totalTrades: state.totalTrades || 0,
      totalRealizedPnl: state.totalRealizedPnl || 0,
      positions,
      lastTickAt: state.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: F7_INITIAL_CASH_KRW, cash: state.cash,
        positions: state.positions || [], trades, currentPrices: priceByMarket,
      }),
    });
  }

  // BTC_TREND — BTC 일봉 > SMA50 이면 보유, 아래면 현금. 규칙은 paper-btctrend-store.ts.
  if (btState) {
    const positions = [];
    let positionValue = 0;
    for (const pos of (btState.positions || [])) {
      const cur = priceByMarket.get(pos.market) ?? pos.entryPrice;
      positionValue += pos.vol * cur;
      positions.push({
        market: pos.market, entryDate: pos.entryDate, entryPrice: pos.entryPrice, currentPrice: cur, vol: pos.vol,
        profitRate: (cur - pos.entryPrice) / pos.entryPrice * 100, profitKrw: pos.vol * cur - pos.cashUsed,
        daysHeld: daysSince(pos.entryDate),
      });
    }
    const equity = btState.cash + positionValue;
    const trades = tradesFromFile(BT_TRADES_FILE);
    portfolioInputs.push({ initial: BT_INITIAL_CASH_KRW, equity, trades });
    strategies.push({
      id: 'BTC_TREND',
      name: 'BTC_TREND (BTC 50일선 추세추종)',
      description: strategyDescription('BTC_TREND'),
      rule: `매일 KST 09:02 · BTC 일봉 종가 > SMA${BT_SMA_DAYS} 이면 보유, 아래면 현금 · 상태 바뀔 때만 시장가 · 자본 100%`,
      capitalAlloc: BT_INITIAL_CASH_KRW,
      cash: btState.cash,
      positionValue,
      totalEquity: equity,
      returnRate: (equity - BT_INITIAL_CASH_KRW) / BT_INITIAL_CASH_KRW * 100,
      totalTrades: btState.totalTrades || 0,
      totalRealizedPnl: btState.totalRealizedPnl || 0,
      positions,
      lastTickAt: btState.lastTickAt || null,
      metrics: computeStrategyMetrics({
        initial: BT_INITIAL_CASH_KRW, cash: btState.cash,
        positions: btState.positions || [], trades, currentPrices: priceByMarket,
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
