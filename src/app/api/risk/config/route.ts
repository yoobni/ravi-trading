import { NextRequest, NextResponse } from 'next/server';
import {
  loadRiskConfig,
  updateRiskConfig,
} from '@/lib/risk-manager';

/** GET /api/risk/config — 리스크 설정 조회 */
export async function GET() {
  const config = loadRiskConfig();
  return NextResponse.json(config);
}

/** PATCH /api/risk/config — 리스크 설정 부분 업데이트 */
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const updated = updateRiskConfig(body);
  return NextResponse.json(updated);
}
