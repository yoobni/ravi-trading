/**
 * PM2 Ecosystem Configuration
 * 업비트 자동 매매 프로그램 프로세스 관리
 *
 * 사용법:
 *   pm2 start ecosystem.config.js              # 프로덕션 실행
 *   pm2 start ecosystem.config.js --env dev    # 개발 실행
 *   pm2 stop all
 *   pm2 restart all
 *   pm2 logs upbit-trading
 *   pm2 monit
 */

module.exports = {
  apps: [
    {
      // ─────────────────────────────────────
      // 메인 앱: Next.js 프로덕션 서버
      // 트레이딩 스케줄러 포함 (scheduler.ts, instrumentation.ts)
      // ─────────────────────────────────────
      name: 'upbit-trading',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/Users/goyubin/Desktop/ai/upbit-trading',

      // 인스턴스: 단일 (트레이딩 상태는 파일 기반 공유, 멀티 인스턴스 불가)
      instances: 1,
      exec_mode: 'fork',

      // ─── 자동 재시작 ───
      autorestart: true,
      watch: false,           // Next.js 자체 감시와 충돌 방지
      max_restarts: 10,       // 최대 재시작 횟수 (이후 stopped 상태)
      min_uptime: '30s',      // 이 시간 이상 유지돼야 "정상 시작" 인정
      restart_delay: 5000,    // 재시작 전 대기 (ms)

      // ─── 메모리 한도 ───
      // AI 판단(Claude API) + 캔들 데이터 처리로 메모리 높을 수 있음
      max_memory_restart: '900M',

      // ─── 로그 관리 ───
      log_date_format: 'YYYY-MM-DD HH:mm:ss KST',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_type: 'json',

      // ─── 환경 변수 (프로덕션) ───
      env: {
        NODE_ENV: 'production',
        PORT: 4004,
      },

      // ─── 환경 변수 (개발) ───
      // pm2 start ecosystem.config.js --env dev
      env_dev: {
        NODE_ENV: 'development',
        PORT: 4004,
      },

      // ─── 기타 ───
      // 프로세스 타이틀 (ps aux에서 식별)
      // shutdown_with_message: false,
      kill_timeout: 10000,    // SIGKILL 전 대기 (ms), graceful shutdown 보장
      listen_timeout: 10000,  // 포트 리슨 감지 타임아웃 (ms)
    },
  ],
};
