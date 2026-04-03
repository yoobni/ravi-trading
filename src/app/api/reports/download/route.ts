import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');

/** GET /api/reports/download?filename=xxx — 저장된 리포트 파일 다운로드 */
export async function GET(request: NextRequest) {
  const filename = request.nextUrl.searchParams.get('filename');

  if (!filename) {
    return NextResponse.json({ error: 'filename 파라미터가 필요합니다' }, { status: 400 });
  }

  // 경로 조작 방지
  const basename = path.basename(filename);
  if (basename !== filename || !basename.startsWith('report_')) {
    return NextResponse.json({ error: '잘못된 파일명입니다' }, { status: 400 });
  }

  const filepath = path.join(REPORTS_DIR, basename);
  if (!fs.existsSync(filepath)) {
    return NextResponse.json({ error: '파일을 찾을 수 없습니다' }, { status: 404 });
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  const ext = path.extname(basename);
  const contentType = ext === '.csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';

  return new NextResponse(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${basename}"`,
    },
  });
}
