import { NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtest-engine';
import type { BacktestConfig } from '@/types/backtest';
import { DEFAULT_BACKTEST_CONFIG } from '@/types/backtest';

/** POST /api/backtest/run — 백테스트 실행 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const { market, startDate, endDate, initialCapital, candleUnit, lookbackCandles } = body;

    if (!market || !startDate || !endDate) {
      return NextResponse.json(
        { error: 'market, startDate, endDate 는 필수입니다.' },
        { status: 400 },
      );
    }

    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      market,
      startDate,
      endDate,
      ...(initialCapital != null && { initialCapital: Number(initialCapital) }),
      ...(candleUnit != null && { candleUnit: Number(candleUnit) as BacktestConfig['candleUnit'] }),
      ...(lookbackCandles != null && { lookbackCandles: Number(lookbackCandles) }),
    };

    const result = await runBacktest(config);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
