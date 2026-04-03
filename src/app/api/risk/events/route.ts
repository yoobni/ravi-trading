import { NextRequest, NextResponse } from 'next/server';
import {
  getTodayRiskEvents,
  getRecentRiskEvents,
  getRiskEventsByType,
} from '@/lib/risk-manager';
import type { RiskEventType } from '@/types/risk';

/** GET /api/risk/events — 리스크 이벤트 조회 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') as RiskEventType | null;
  const count = parseInt(searchParams.get('count') ?? '50', 10);
  const today = searchParams.get('today');

  if (type) {
    return NextResponse.json(getRiskEventsByType(type));
  }

  if (today === 'true') {
    return NextResponse.json(getTodayRiskEvents());
  }

  return NextResponse.json(getRecentRiskEvents(count));
}
