/**
 * Next.js Instrumentation Hook
 *
 * 서버 시작 시 1회 실행됩니다.
 * ConfigBridge를 초기화하여 config.json → 각 모듈 설정 분배를 시작합니다.
 */

export async function register() {
  // 서버 사이드에서만 실행
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initConfigBridge } = await import('@/lib/config-bridge');
    initConfigBridge();
  }
}
