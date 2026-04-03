import { NextRequest, NextResponse } from 'next/server';
import { generateReport, reportToCsv, saveReportToFile } from '@/lib/report-generator';
import type { ReportPeriod, ExportFormat } from '@/types/report';

/**
 * POST /api/reports/generate — 거래 리포트 생성
 *
 * Body:
 *   period: 'daily' | 'weekly'
 *   format: 'json' | 'csv'
 *   fromDate?: string (YYYY-MM-DD)
 *   toDate?: string (YYYY-MM-DD)
 *   market?: string
 *   save?: boolean (파일 저장 여부, 기본 false)
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>;

  const period = (body.period as string) ?? 'daily';
  const format = (body.format as string) ?? 'json';

  if (period !== 'daily' && period !== 'weekly') {
    return NextResponse.json(
      { error: `잘못된 기간 단위: "${period}" (daily 또는 weekly)` },
      { status: 400 },
    );
  }
  if (format !== 'json' && format !== 'csv') {
    return NextResponse.json(
      { error: `잘못된 내보내기 형식: "${format}" (json 또는 csv)` },
      { status: 400 },
    );
  }

  const report = generateReport({
    period: period as ReportPeriod,
    format: format as ExportFormat,
    fromDate: body.fromDate as string | undefined,
    toDate: body.toDate as string | undefined,
    market: body.market as string | undefined,
  });

  // 파일 저장 요청 시
  if (body.save) {
    const filepath = saveReportToFile(report, format as ExportFormat);
    return NextResponse.json({ report, savedTo: filepath });
  }

  // CSV 형식이면 텍스트로 반환
  if (format === 'csv') {
    const csv = reportToCsv(report);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="report_${period}_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json(report);
}
