import { NextRequest, NextResponse } from 'next/server';
import {
  getDecisionLogs,
  getDecisionLogsByDate,
  getDecisionLogByPipelineId,
  getDecisionLogSummary,
  getAvailableDecisionLogDates,
} from '@/lib/decision-log-service';
import type { DecisionLogFilter } from '@/types/decision-log';

/**
 * GET /api/decision-logs — 판단 로그 조회
 *
 * Query params:
 *   date?: string (YYYY-MM-DD, 기본 오늘)
 *   market?: string (종목 필터)
 *   action?: 'buy' | 'sell' | 'hold'
 *   engine?: 'claude' | 'algorithm' | 'fallback'
 *   executedOnly?: 'true'
 *   pipelineId?: string (특정 파이프라인 조회)
 *   view?: 'summary' | 'dates' | 'pipeline' | 'list' (기본 list)
 *   limit?: number
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const view = searchParams.get('view') ?? 'list';

  // 날짜 목록 조회
  if (view === 'dates') {
    return NextResponse.json({ dates: getAvailableDecisionLogDates() });
  }

  // 요약 통계 조회
  if (view === 'summary') {
    const date = searchParams.get('date') ?? undefined;
    return NextResponse.json(getDecisionLogSummary(date));
  }

  // 특정 파이프라인 조회
  if (view === 'pipeline') {
    const pipelineId = searchParams.get('pipelineId');
    if (!pipelineId) {
      return NextResponse.json({ error: 'pipelineId 필수' }, { status: 400 });
    }
    const log = getDecisionLogByPipelineId(pipelineId);
    if (!log) {
      return NextResponse.json({ error: '해당 파이프라인 로그 없음' }, { status: 404 });
    }
    return NextResponse.json(log);
  }

  // 개별 판단 로그 목록 조회 (기본)
  const filter: DecisionLogFilter = {};
  if (searchParams.has('date')) filter.date = searchParams.get('date')!;
  if (searchParams.has('market')) filter.market = searchParams.get('market')!;
  if (searchParams.has('action')) filter.action = searchParams.get('action') as DecisionLogFilter['action'];
  if (searchParams.has('engine')) filter.engine = searchParams.get('engine') as DecisionLogFilter['engine'];
  if (searchParams.get('executedOnly') === 'true') filter.executedOnly = true;
  if (searchParams.has('limit')) filter.limit = Number(searchParams.get('limit'));

  const logs = getDecisionLogs(filter);
  const summary = getDecisionLogSummary(filter.date);

  return NextResponse.json({ logs, summary });
}
