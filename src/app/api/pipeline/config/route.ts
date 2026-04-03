import { NextResponse } from 'next/server';
import { getPipelineConfig, updatePipelineConfig } from '@/lib/strategy-pipeline';
import type { PipelineConfig } from '@/types/strategy-pipeline';

/** GET /api/pipeline/config — 파이프라인 설정 조회 */
export async function GET() {
  return NextResponse.json(getPipelineConfig());
}

/** PATCH /api/pipeline/config — 파이프라인 설정 변경 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const updated = updatePipelineConfig(body as Partial<PipelineConfig>);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
