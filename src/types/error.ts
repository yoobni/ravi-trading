// ──────────────────────────────────────────────
// API 에러 분류
// ──────────────────────────────────────────────

/** API 에러 종류 */
export type ApiErrorKind =
  | 'timeout'        // 요청 타임아웃
  | 'network'        // 네트워크 연결 실패
  | 'rate_limit'     // 429 Too Many Requests
  | 'server_error'   // 500+ 서버 에러
  | 'client_error'   // 400~499 (rate_limit 제외)
  | 'unknown';       // 분류 불가

/** 분류된 API 에러 */
export interface ClassifiedApiError {
  kind: ApiErrorKind;
  /** HTTP 상태 코드 (네트워크/타임아웃은 null) */
  statusCode: number | null;
  /** 원본 에러 메시지 */
  message: string;
  /** 재시도 가능 여부 */
  retryable: boolean;
  /** 권장 대기 시간 (ms) — 재시도 불가 시 null */
  retryAfterMs: number | null;
  /** 원본 에러 */
  originalError: unknown;
}

// ──────────────────────────────────────────────
// 재시도 설정
// ──────────────────────────────────────────────

/** 재시도 정책 */
export interface RetryPolicy {
  /** 최대 재시도 횟수 */
  maxRetries: number;
  /** 기본 대기 시간 (ms) */
  baseDelayMs: number;
  /** 최대 대기 시간 (ms) */
  maxDelayMs: number;
  /** 지수 백오프 배수 */
  backoffMultiplier: number;
}

/** 기본 재시도 정책 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  backoffMultiplier: 2,
};

/** 레이트 리밋 전용 재시도 정책 (더 보수적) */
export const RATE_LIMIT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  backoffMultiplier: 2.5,
};

// ──────────────────────────────────────────────
// 스케줄러 상태 영속화
// ──────────────────────────────────────────────

/** 스케줄러 영속 상태 (프로세스 재시작 복원용) */
export interface PersistedSchedulerState {
  /** 실행 중이었는지 */
  wasRunning: boolean;
  /** 마지막 사이클 시각 */
  lastCycleAt: string | null;
  /** 총 사이클 수 */
  totalCycles: number;
  /** 연속 에러 수 */
  consecutiveErrors: number;
  /** 저장 시각 */
  savedAt: string;
  /** 스케줄러 설정 스냅샷 */
  config: {
    intervalMs: number;
    targetMarketCount: number;
    candleUnit: number;
    candleCount: number;
    enabled: boolean;
  };
}

// ──────────────────────────────────────────────
// 긴급 청산
// ──────────────────────────────────────────────

/** 긴급 청산 사유 */
export type EmergencyReason =
  | 'consecutive_errors'  // 연속 에러 임계치 초과
  | 'api_down'            // API 완전 불통
  | 'critical_loss'       // 치명적 손실
  | 'manual';             // 수동 요청

/** 긴급 청산 결과 */
export interface EmergencyLiquidationResult {
  /** 청산 사유 */
  reason: EmergencyReason;
  /** 청산 시도 시각 */
  triggeredAt: string;
  /** 청산 시도한 포지션 수 */
  totalPositions: number;
  /** 성공 청산 수 */
  liquidatedCount: number;
  /** 실패 건 */
  failures: Array<{
    market: string;
    orderId: string;
    error: string;
  }>;
  /** 청산 후 현금 잔고 */
  cashAfter: number | null;
}
