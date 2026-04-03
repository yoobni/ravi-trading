import { NextRequest, NextResponse } from 'next/server';
import {
  loadCircuitBreakerConfig,
  loadCircuitBreakerState,
  updateCircuitBreakerConfig,
  resetCircuitBreaker,
} from '@/lib/risk-manager';

/** GET /api/risk/circuit-breaker — 서킷 브레이커 상태 + 설정 조회 */
export async function GET() {
  return NextResponse.json({
    config: loadCircuitBreakerConfig(),
    state: loadCircuitBreakerState(),
  });
}

/** PATCH /api/risk/circuit-breaker — 서킷 브레이커 설정 업데이트 */
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const updated = updateCircuitBreakerConfig(body);
  return NextResponse.json({ config: updated, state: loadCircuitBreakerState() });
}

/** POST /api/risk/circuit-breaker — 서킷 브레이커 수동 해제 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const reason = (body as Record<string, unknown>).reason as string | undefined;
  const state = resetCircuitBreaker(reason ?? '수동 해제 (API)');
  return NextResponse.json(state);
}
