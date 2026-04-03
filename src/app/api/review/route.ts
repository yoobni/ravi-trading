import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const RESULT_FILE = path.resolve(process.cwd(), 'data/integration-test-2nd-result.json');

/** GET /api/review — 2차 통합 리뷰 테스트 결과 조회 */
export async function GET() {
  try {
    if (!fs.existsSync(RESULT_FILE)) {
      return NextResponse.json({ error: '테스트 결과 파일이 없습니다. 먼저 테스트를 실행해주세요.' }, { status: 404 });
    }

    const raw = fs.readFileSync(RESULT_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
