import { NextResponse } from 'next/server';
import { getRiskStatus } from '@/lib/risk-manager';

/** GET /api/risk/status — 리스크 현황 요약 (대시보드용) */
export async function GET() {
  const status = getRiskStatus();
  return NextResponse.json(status);
}
