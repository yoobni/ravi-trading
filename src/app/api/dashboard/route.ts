import { NextRequest, NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/dashboard-stats';
import { listOrders, getOpenPositions } from '@/lib/order-store';
import type { DashboardQueryOptions } from '@/types/dashboard';

/**
 * GET /api/dashboard — 대시보드 전체 데이터 조회
 *
 * Query params:
 *   fromDate?: string (YYYY-MM-DD)
 *   toDate?: string (YYYY-MM-DD)
 *   market?: string
 *   dailyLimit?: number
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const options: DashboardQueryOptions = {};
  if (searchParams.has('fromDate')) options.fromDate = searchParams.get('fromDate')!;
  if (searchParams.has('toDate')) options.toDate = searchParams.get('toDate')!;
  if (searchParams.has('market')) options.market = searchParams.get('market')!;
  if (searchParams.has('dailyLimit')) options.dailyLimit = Number(searchParams.get('dailyLimit'));

  const dashboard = getDashboardData(options);
  const recentOrders = listOrders({ limit: 20 });
  const openPositions = getOpenPositions();

  return NextResponse.json({
    ...dashboard,
    recentOrders,
    openPositions,
  });
}
