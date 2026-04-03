import { NextRequest, NextResponse } from 'next/server';
import {
  getConfig,
  updateConfig,
  validateConfig,
  getDefaultConfig,
  resetConfig,
} from '@/lib/config-manager';
import type { AppConfigPatch } from '@/types/config';

/**
 * GET /api/config — 전체 설정 조회
 *
 * Query params:
 *   ?section=scheduler   → 특정 섹션만 반환
 *   ?defaults=true       → 기본값 반환
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const section = searchParams.get('section');
  const defaults = searchParams.get('defaults');

  if (defaults === 'true') {
    return NextResponse.json(getDefaultConfig());
  }

  const config = getConfig();

  if (section) {
    const validSections = ['scheduler', 'trading', 'marketSelector', 'risk', 'paperTrading', 'ai'];
    if (!validSections.includes(section)) {
      return NextResponse.json(
        { error: `유효하지 않은 섹션: ${section}. 사용 가능: ${validSections.join(', ')}` },
        { status: 400 },
      );
    }
    return NextResponse.json({
      section,
      config: config[section as keyof typeof config],
      updatedAt: config.updatedAt,
    });
  }

  return NextResponse.json(config);
}

/**
 * PATCH /api/config — 설정 부분 업데이트
 *
 * Body: AppConfigPatch (변경할 섹션만 포함)
 *
 * 예시:
 *   { "scheduler": { "intervalMs": 180000 } }
 *   { "trading": { "buyThreshold": 30 } }
 *   { "risk": { "stopLoss": { "stopLossRate": -2 } } }
 */
export async function PATCH(request: NextRequest) {
  let body: AppConfigPatch;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'JSON 파싱 실패' },
      { status: 400 },
    );
  }

  // 빈 요청 차단
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return NextResponse.json(
      { error: '변경할 설정이 없습니다' },
      { status: 400 },
    );
  }

  // 허용되지 않는 키 차단
  const allowedKeys = ['scheduler', 'trading', 'marketSelector', 'risk', 'paperTrading', 'ai'];
  const invalidKeys = keys.filter((k) => !allowedKeys.includes(k));
  if (invalidKeys.length > 0) {
    return NextResponse.json(
      { error: `허용되지 않는 키: ${invalidKeys.join(', ')}` },
      { status: 400 },
    );
  }

  const { config, validation } = updateConfig(body);

  if (!validation.valid) {
    return NextResponse.json(
      {
        error: '설정 검증 실패',
        validation,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    message: `설정 업데이트 완료: ${keys.join(', ')}`,
    config,
  });
}

/**
 * POST /api/config — 설정 초기화 (기본값으로 리셋)
 *
 * Body: { "action": "reset" }
 */
export async function POST(request: NextRequest) {
  let body: { action?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'JSON 파싱 실패' },
      { status: 400 },
    );
  }

  if (body.action === 'reset') {
    const config = resetConfig();
    return NextResponse.json({
      message: '설정이 기본값으로 초기화되었습니다',
      config,
    });
  }

  if (body.action === 'validate') {
    const config = getConfig();
    const validation = validateConfig(config);
    return NextResponse.json({ validation });
  }

  return NextResponse.json(
    { error: `알 수 없는 action: ${body.action}. 사용 가능: reset, validate` },
    { status: 400 },
  );
}
