import { NextResponse } from 'next/server';
import { runPipeline } from '@/lib/strategy-pipeline';
import type { PipelineConfig } from '@/types/strategy-pipeline';

/** POST /api/pipeline/run — 전체 파이프라인 1회 수동 실행 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const overrideConfig = body as Partial<PipelineConfig> | undefined;

    const result = await runPipeline(overrideConfig);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
