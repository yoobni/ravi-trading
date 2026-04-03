import { NextResponse } from 'next/server';
import { listReportFiles } from '@/lib/report-generator';

/** GET /api/reports/files — 저장된 리포트 파일 목록 */
export async function GET() {
  const files = listReportFiles();
  return NextResponse.json({ files });
}
