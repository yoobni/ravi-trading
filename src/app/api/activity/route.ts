import { NextRequest, NextResponse } from 'next/server';
import {
  getActivityFeed,
  getActivitySummary,
  getAvailableActivityDates,
} from '@/lib/activity-feed';
import type { ActivityType } from '@/types/activity';

const VALID_TYPES = new Set<string>([
  'cycle_start', 'cycle_end', 'cycle_error',
  'ai_judgment',
  'order_buy', 'order_sell',
  'risk_stop_loss', 'risk_take_profit', 'risk_trailing',
  'circuit_breaker',
]);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 500;

/**
 * GET /api/activity — 활동 타임라인 조회
 *
 * Query params:
 *   date?: string (YYYY-MM-DD, 기본 오늘)
 *   types?: string (쉼표 구분, 예: "ai_judgment,order_buy")
 *   market?: string (종목 코드)
 *   limit?: number (최대 500)
 *   summary?: "true" (요약 통계만 반환)
 *   dates?: "true" (사용 가능한 날짜 목록 반환)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  // 날짜 목록만 반환
  if (searchParams.get('dates') === 'true') {
    return NextResponse.json({ dates: getAvailableActivityDates() });
  }

  // 날짜 검증
  const dateParam = searchParams.get('date');
  if (dateParam && !DATE_REGEX.test(dateParam)) {
    return NextResponse.json(
      { error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  // 타입 필터 검증
  const typesParam = searchParams.get('types');
  let types: ActivityType[] | undefined;
  if (typesParam) {
    const requested = typesParam.split(',');
    const invalid = requested.filter((t) => !VALID_TYPES.has(t));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `잘못된 활동 유형: ${invalid.join(', ')}` },
        { status: 400 },
      );
    }
    types = requested as ActivityType[];
  }

  // limit 검증
  const limitParam = searchParams.get('limit');
  let limit = 100;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json(
        { error: 'limit는 1 이상의 숫자여야 합니다' },
        { status: 400 },
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const market = searchParams.get('market') ?? undefined;
  const date = dateParam ?? undefined;

  // 요약만 반환
  if (searchParams.get('summary') === 'true') {
    return NextResponse.json(getActivitySummary(date));
  }

  // 타임라인 반환
  const feed = getActivityFeed({ date, types, market, limit });
  const summary = getActivitySummary(date);

  return NextResponse.json({ items: feed, summary });
}
