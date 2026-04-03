/**
 * 통합 설정 파일 타입 정의
 *
 * config.json 하나로 전체 전략 파라미터를 관리합니다.
 * 재시작 없이 파일 변경 감지(fs.watch)로 핫 리로드됩니다.
 */

import type { SchedulerConfig } from './scheduler';
import type { DecisionEngineConfig } from './trading-decision';
import type { MarketSelectorConfig } from './market-selector';
import type { RiskConfig } from './risk';
import type { PaperTradingConfig } from './paper-trading';
import type { AIJudgmentConfig } from './ai-judgment';

// ──────────────────────────────────────────────
// 통합 설정
// ──────────────────────────────────────────────

/** config.json 최상위 구조 */
export interface AppConfig {
  /** 설정 파일 버전 (마이그레이션용) */
  version: number;
  /** 마지막 수정 시각 (ISO 8601) */
  updatedAt: string;
  /** 스케줄러 설정 (분석 주기, 캔들 단위 등) */
  scheduler: SchedulerConfig;
  /** 매매 판단 엔진 설정 (매수/매도 임계값, 전략 가중치 등) */
  trading: DecisionEngineConfig;
  /** 종목 선정 알고리즘 설정 (거래대금 필터, 선정 종목 수 등) */
  marketSelector: MarketSelectorConfig;
  /** 리스크 관리 설정 (손절/익절, 포지션 크기, 일일 한도 등) */
  risk: RiskConfig;
  /** 모의 거래 엔진 설정 (초기 자본, 수수료 등) */
  paperTrading: PaperTradingConfig;
  /** AI 판단 엔진 설정 (모델 선택, 온도, 폴백 등) */
  ai: AIJudgmentConfig;
}

/** 설정 부분 업데이트용 (모든 필드 선택적) */
export type AppConfigPatch = {
  [K in keyof Omit<AppConfig, 'version' | 'updatedAt'>]?: Partial<AppConfig[K]>;
};

/** 설정 변경 이벤트 */
export interface ConfigChangeEvent {
  /** 변경된 섹션 목록 */
  changedSections: (keyof Omit<AppConfig, 'version' | 'updatedAt'>)[];
  /** 변경 전 설정 */
  previous: AppConfig;
  /** 변경 후 설정 */
  current: AppConfig;
  /** 변경 시각 */
  timestamp: string;
  /** 변경 소스 */
  source: 'api' | 'file_watch' | 'startup';
}

/** 설정 검증 결과 */
export interface ConfigValidationResult {
  /** 유효 여부 */
  valid: boolean;
  /** 검증 오류 목록 */
  errors: ConfigValidationError[];
}

/** 개별 검증 오류 */
export interface ConfigValidationError {
  /** 오류 위치 (예: "scheduler.intervalMs") */
  path: string;
  /** 오류 메시지 */
  message: string;
  /** 현재 값 */
  value: unknown;
}
