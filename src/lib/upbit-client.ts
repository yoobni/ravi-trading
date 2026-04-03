import axios, { AxiosInstance, AxiosError } from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type {
  UpbitMarket,
  UpbitTicker,
  UpbitCandle,
  UpbitDayCandle,
  UpbitOrderbook,
  UpbitAccount,
  CandleMinuteUnit,
} from '@/types/upbit';
import type {
  ClassifiedApiError,
  RetryPolicy,
} from '@/types/error';
import {
  DEFAULT_RETRY_POLICY,
  RATE_LIMIT_RETRY_POLICY,
} from '@/types/error';

const UPBIT_API_BASE = 'https://api.upbit.com/v1';

// ──────────────────────────────────────────────
// 에러 분류
// ──────────────────────────────────────────────

/** axios 에러를 분류된 API 에러로 변환 */
export function classifyApiError(err: unknown): ClassifiedApiError {
  if (!axios.isAxiosError(err)) {
    return {
      kind: 'unknown',
      statusCode: null,
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
      retryAfterMs: null,
      originalError: err,
    };
  }

  const axErr = err as AxiosError;

  // 타임아웃
  if (axErr.code === 'ECONNABORTED' || axErr.code === 'ETIMEDOUT') {
    return {
      kind: 'timeout',
      statusCode: null,
      message: `요청 타임아웃: ${axErr.message}`,
      retryable: true,
      retryAfterMs: 2000,
      originalError: err,
    };
  }

  // 네트워크 에러 (DNS, 연결 거부 등)
  if (!axErr.response) {
    return {
      kind: 'network',
      statusCode: null,
      message: `네트워크 에러: ${axErr.message}`,
      retryable: true,
      retryAfterMs: 3000,
      originalError: err,
    };
  }

  const status = axErr.response.status;

  // 레이트 리밋
  if (status === 429) {
    const retryAfter = axErr.response.headers['retry-after'];
    const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
    return {
      kind: 'rate_limit',
      statusCode: 429,
      message: `레이트 리밋 초과 (429)`,
      retryable: true,
      retryAfterMs: retryMs,
      originalError: err,
    };
  }

  // 서버 에러
  if (status >= 500) {
    return {
      kind: 'server_error',
      statusCode: status,
      message: `서버 에러 (${status})`,
      retryable: true,
      retryAfterMs: 3000,
      originalError: err,
    };
  }

  // 클라이언트 에러 (재시도 불가)
  return {
    kind: 'client_error',
    statusCode: status,
    message: `클라이언트 에러 (${status}): ${axErr.response.statusText}`,
    retryable: false,
    retryAfterMs: null,
    originalError: err,
  };
}

// ──────────────────────────────────────────────
// 재시도 유틸
// ──────────────────────────────────────────────

/** 지수 백오프 대기 시간 계산 */
function calcBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const delay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  // 지터 추가 (±20%)
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, policy.maxDelayMs);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 업비트 REST API 클라이언트
 *
 * - JWT 인증 자동 처리
 * - 시세 조회 (ticker, candle)
 * - 호가 조회 (orderbook)
 * - 계좌 조회 (accounts)
 * - 자동 재시도 (타임아웃/네트워크/레이트 리밋/서버 에러)
 * - 레이트 리밋 대응 (429 시 Retry-After 헤더 존중)
 */
export class UpbitClient {
  private accessKey: string;
  private secretKey: string;
  private http: AxiosInstance;
  private retryPolicy: RetryPolicy;
  private rateLimitPolicy: RetryPolicy;

  /** 최근 API 에러 통계 (모니터링용) */
  private _errorStats = {
    totalErrors: 0,
    consecutiveErrors: 0,
    lastErrorAt: null as string | null,
    lastErrorKind: null as string | null,
  };

  constructor(accessKey?: string, secretKey?: string) {
    this.accessKey = accessKey ?? process.env.UPBIT_ACCESS_KEY ?? '';
    this.secretKey = secretKey ?? process.env.UPBIT_SECRET_KEY ?? '';

    if (!this.accessKey || !this.secretKey) {
      throw new Error('UPBIT_ACCESS_KEY와 UPBIT_SECRET_KEY가 필요합니다.');
    }

    this.http = axios.create({
      baseURL: UPBIT_API_BASE,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.retryPolicy = { ...DEFAULT_RETRY_POLICY };
    this.rateLimitPolicy = { ...RATE_LIMIT_RETRY_POLICY };
  }

  /** API 에러 통계 조회 */
  get errorStats() {
    return { ...this._errorStats };
  }

  /** 에러 통계 리셋 */
  resetErrorStats(): void {
    this._errorStats = {
      totalErrors: 0,
      consecutiveErrors: 0,
      lastErrorAt: null,
      lastErrorKind: null,
    };
  }

  // ──────────────────────────────────────────────
  // JWT 인증
  // ──────────────────────────────────────────────

  /** 쿼리 파라미터 없는 요청용 JWT 토큰 생성 */
  private createToken(): string {
    const payload = {
      access_key: this.accessKey,
      nonce: crypto.randomUUID(),
    };
    return jwt.sign(payload, this.secretKey);
  }

  /** 쿼리 파라미터가 있는 요청용 JWT 토큰 생성 (query_hash 포함) */
  private createTokenWithQuery(params: Record<string, string | number>): string {
    const queryString = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();

    const hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');

    const payload = {
      access_key: this.accessKey,
      nonce: crypto.randomUUID(),
      query_hash: hash,
      query_hash_alg: 'SHA512',
    };
    return jwt.sign(payload, this.secretKey);
  }

  /** 인증 헤더 반환 */
  private authHeader(params?: Record<string, string | number>): Record<string, string> {
    const token = params ? this.createTokenWithQuery(params) : this.createToken();
    return { Authorization: `Bearer ${token}` };
  }

  // ──────────────────────────────────────────────
  // 재시도 래퍼
  // ──────────────────────────────────────────────

  /**
   * API 요청을 재시도 정책에 따라 실행.
   * 재시도 가능한 에러(타임아웃/네트워크/레이트 리밋/서버 에러)는 자동 재시도.
   * 재시도 불가능한 에러(클라이언트 에러 등)는 즉시 throw.
   */
  private async requestWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: ClassifiedApiError | null = null;

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fn();
        // 성공 시 연속 에러 카운트 리셋
        this._errorStats.consecutiveErrors = 0;
        return result;
      } catch (err) {
        const classified = classifyApiError(err);
        lastError = classified;

        // 에러 통계 갱신
        this._errorStats.totalErrors++;
        this._errorStats.consecutiveErrors++;
        this._errorStats.lastErrorAt = new Date().toISOString();
        this._errorStats.lastErrorKind = classified.kind;

        // 재시도 불가능한 에러 → 즉시 throw
        if (!classified.retryable) {
          throw err;
        }

        // 레이트 리밋은 별도 정책
        const policy = classified.kind === 'rate_limit'
          ? this.rateLimitPolicy
          : this.retryPolicy;

        // 최대 재시도 초과
        if (attempt >= policy.maxRetries) {
          console.error(
            `[UpbitClient] ${label} — ${policy.maxRetries}회 재시도 실패 (${classified.kind}): ${classified.message}`,
          );
          throw err;
        }

        // 대기 시간 결정: 레이트 리밋은 서버 지시 우선, 나머지는 지수 백오프
        const waitMs = classified.kind === 'rate_limit' && classified.retryAfterMs
          ? classified.retryAfterMs
          : calcBackoffDelay(attempt, policy);

        console.warn(
          `[UpbitClient] ${label} — ${classified.kind} 에러, ` +
          `${attempt + 1}/${policy.maxRetries} 재시도 (${Math.round(waitMs)}ms 대기)`,
        );

        await sleepMs(waitMs);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public API (인증 불필요)
  // ──────────────────────────────────────────────

  /** 마켓 코드 조회 */
  async getMarkets(isDetails = true): Promise<UpbitMarket[]> {
    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitMarket[]>('/market/all', {
        params: { is_details: isDetails },
      });
      return data;
    }, 'getMarkets');
  }

  /** 현재가(ticker) 조회 — 최대 100개 마켓 */
  async getTicker(markets: string[]): Promise<UpbitTicker[]> {
    if (markets.length === 0) return [];
    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitTicker[]>('/ticker', {
        params: { markets: markets.join(',') },
      });
      return data;
    }, `getTicker(${markets.length}종목)`);
  }

  /** 분(minute) 캔들 조회 */
  async getCandlesMinutes(
    unit: CandleMinuteUnit,
    market: string,
    count = 200,
    to?: string,
  ): Promise<UpbitCandle[]> {
    const params: Record<string, string | number> = { market, count };
    if (to) params.to = to;

    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitCandle[]>(`/candles/minutes/${unit}`, {
        params,
      });
      return data;
    }, `getCandlesMinutes(${market})`);
  }

  /** 일(day) 캔들 조회 */
  async getCandlesDays(
    market: string,
    count = 200,
    to?: string,
  ): Promise<UpbitDayCandle[]> {
    const params: Record<string, string | number> = { market, count };
    if (to) params.to = to;

    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitDayCandle[]>('/candles/days', {
        params,
      });
      return data;
    }, `getCandlesDays(${market})`);
  }

  /** 주(week) 캔들 조회 */
  async getCandlesWeeks(
    market: string,
    count = 200,
    to?: string,
  ): Promise<UpbitCandle[]> {
    const params: Record<string, string | number> = { market, count };
    if (to) params.to = to;

    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitCandle[]>('/candles/weeks', {
        params,
      });
      return data;
    }, `getCandlesWeeks(${market})`);
  }

  /** 월(month) 캔들 조회 */
  async getCandlesMonths(
    market: string,
    count = 200,
    to?: string,
  ): Promise<UpbitCandle[]> {
    const params: Record<string, string | number> = { market, count };
    if (to) params.to = to;

    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitCandle[]>('/candles/months', {
        params,
      });
      return data;
    }, `getCandlesMonths(${market})`);
  }

  /** 호가(orderbook) 조회 */
  async getOrderbook(markets: string[]): Promise<UpbitOrderbook[]> {
    if (markets.length === 0) return [];
    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitOrderbook[]>('/orderbook', {
        params: { markets: markets.join(',') },
      });
      return data;
    }, `getOrderbook(${markets.length}종목)`);
  }

  // ──────────────────────────────────────────────
  // Private API (인증 필요)
  // ──────────────────────────────────────────────

  /** 전체 계좌 조회 */
  async getAccounts(): Promise<UpbitAccount[]> {
    return this.requestWithRetry(async () => {
      const { data } = await this.http.get<UpbitAccount[]>('/accounts', {
        headers: this.authHeader(),
      });
      return data;
    }, 'getAccounts');
  }

  /**
   * API 상태 확인 (헬스체크).
   * 가장 가벼운 API를 호출하여 연결 상태 확인.
   * @returns true면 정상, false면 불통
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get('/market/all', {
        params: { is_details: false },
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** 환경변수 기반 싱글턴 인스턴스 (lazy) */
let _instance: UpbitClient | null = null;

export function getUpbitClient(): UpbitClient {
  if (!_instance) {
    _instance = new UpbitClient();
  }
  return _instance;
}
