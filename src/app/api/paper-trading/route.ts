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
  INITIAL_CASH_KRW as F1F2_INITIAL_CASH,
  TP_PCT as F1F2_TP_PCT,
  SL_PCT as F1F2_SL_PCT,
  MAX_DAYS as F1F2_MAX_DAYS,
} from '@/lib/paper-trading-store';
import {
  F6_STATE_FILE, F6_INITIAL_CASH_KRW, F6_TP_PCT, F6_SL_PCT, F6_MAX_BARS,
} from '@/lib/paper-f6-store';
import {
  F6V2_STATE_FILE, F6V2_INITIAL_CASH_KRW, F6V2_TP_PCT, F6V2_SL_PCT, F6V2_MAX_BARS,
} from '@/lib/paper-f6v2-store';
import {
  F6V3_STATE_FILE, F6V3_INITIAL_CASH_KRW, F6V3_TP_PCT, F6V3_SL_PCT, F6V3_MAX_BARS,
} from '@/lib/paper-f6v3-store';

interface PaperStrategy {
  id: string;
  name: string;
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

  // Collect all markets to fetch ticker
  const markets = new Set<string>();
  if (f1f2State?.strategies?.FUNDING_F1F2_50?.position) markets.add('KRW-BTC');
  if (f6State?.positions) for (const p of f6State.positions) markets.add(p.market);
  if (f6v2State?.positions) for (const p of f6v2State.positions) markets.add(p.market);
  if (f6v3State?.positions) for (const p of f6v3State.positions) markets.add(p.market);

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
    strategies.push({
      id: 'F1F2_50',
      name: 'FUNDING_F1F2_50 (MAIN)',
      description: 'Upbit BTC daily, funding contrarian. 자본 50%.',
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
    strategies.push({
      id: 'F6_v2',
      name: 'F6_v2 NEW_HIGH 42 (TP_OPT)',
      description: 'F6 동일 신호, exit TP/SL 최적화 (R35/R36 검증).',
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
    strategies.push({
      id: 'F6',
      name: 'F6 NEW_HIGH 42',
      description: 'Upbit 4h, 28코인. 7d 신고가 + follow-through 모멘텀.',
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
    strategies.push({
      id: 'F6_v3',
      name: 'F6_v3 NEW_HIGH 42 (CONFIRM)',
      description: 'F6 신호 + 거짓돌파 다음봉 확정. 큰 TP (R45 검증, 약세장 방어).',
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
    });
  }

  const totalCapital = strategies.reduce((s, x) => s + x.capitalAlloc, 0);
  const totalEquity = strategies.reduce((s, x) => s + x.totalEquity, 0);

  return NextResponse.json({
    strategies,
    total: {
      capitalAlloc: totalCapital,
      totalEquity,
      returnRate: totalCapital > 0 ? (totalEquity - totalCapital) / totalCapital * 100 : 0,
    },
    now: new Date().toISOString(),
  });
}
