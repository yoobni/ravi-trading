/**
 * 설정 브릿지
 *
 * ConfigManager의 변경 이벤트를 수신하여
 * 각 모듈의 update*Config 함수로 분배합니다.
 *
 * 앱 시작 시 initConfigBridge()를 호출하면:
 *  1. ConfigManager 초기화
 *  2. 초기 설정을 각 모듈에 분배
 *  3. 변경 리스너 등록 (이후 핫 리로드 자동 처리)
 */

import {
  initConfigManager,
  onConfigChange,
  getConfig,
  destroyConfigManager,
} from '@/lib/config-manager';
import { updateSchedulerConfig } from '@/lib/scheduler';
import { updateEngineConfig } from '@/lib/trading-engine';
import { updateSelectorConfig } from '@/lib/market-selector';
import { updateAIConfig } from '@/lib/ai-judgment-engine';
import { updateRiskConfig } from '@/lib/risk-manager';
import type { ConfigChangeEvent } from '@/types/config';

let unsubscribe: (() => void) | null = null;

/**
 * 설정 브릿지 초기화.
 * 앱 시작 시 1회 호출.
 */
export function initConfigBridge(): void {
  const config = initConfigManager();

  // 초기 설정 분배
  distributeAll(config);

  // 변경 리스너 등록
  unsubscribe = onConfigChange(handleConfigChange);

  console.log('[ConfigBridge] 초기화 완료 — 모든 모듈에 설정 분배됨');
}

/** 설정 브릿지 종료 */
export function destroyConfigBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  destroyConfigManager();
}

/** 변경 이벤트 핸들러 */
function handleConfigChange(event: ConfigChangeEvent): void {
  const { changedSections, current } = event;

  for (const section of changedSections) {
    switch (section) {
      case 'scheduler':
        updateSchedulerConfig(current.scheduler);
        console.log('[ConfigBridge] scheduler 설정 업데이트 적용');
        break;

      case 'trading':
        updateEngineConfig(current.trading);
        console.log('[ConfigBridge] trading 설정 업데이트 적용');
        break;

      case 'marketSelector':
        updateSelectorConfig(current.marketSelector);
        console.log('[ConfigBridge] marketSelector 설정 업데이트 적용');
        break;

      case 'ai':
        updateAIConfig(current.ai);
        console.log('[ConfigBridge] ai 설정 업데이트 적용');
        break;

      case 'risk':
        updateRiskConfig(current.risk);
        console.log('[ConfigBridge] risk 설정 업데이트 적용');
        break;

      case 'paperTrading':
        // paper-trading-engine은 파일 기반으로 이미 동작하므로
        // config.json → paper-trading-config.json 동기화
        try {
          const { saveConfig } = require('@/lib/paper-trading-engine');
          saveConfig(current.paperTrading);
          console.log('[ConfigBridge] paperTrading 설정 업데이트 적용');
        } catch {
          console.warn('[ConfigBridge] paperTrading 설정 업데이트 실패');
        }
        break;
    }
  }
}

/** 전체 설정을 모든 모듈에 분배 */
function distributeAll(config: ReturnType<typeof getConfig>): void {
  updateSchedulerConfig(config.scheduler);
  updateEngineConfig(config.trading);
  updateSelectorConfig(config.marketSelector);
  updateAIConfig(config.ai);
  // risk와 paperTrading은 이미 파일 기반이므로 초기화 시 config.json → 기존 파일 동기화
  updateRiskConfig(config.risk);
}
