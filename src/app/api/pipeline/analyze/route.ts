import { NextResponse } from 'next/server';
import { runSingleMarketPipeline } from '@/lib/strategy-pipeline';

/** POST /api/pipeline/analyze — 단일 종목 분석 파이프라인 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { market } = body as { market?: string };

    if (!market || typeof market !== 'string') {
      return NextResponse.json(
        { error: 'market 파라미터가 필요합니다. (예: KRW-BTC)' },
        { status: 400 },
      );
    }

    const result = await runSingleMarketPipeline({ market });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
