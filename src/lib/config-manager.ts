/**
 * 통합 설정 관리자
 *
 * config.json 파일 하나로 전체 전략 파라미터를 관리합니다.
 *
 * 기능:
 *  - 시작 시 config.json 로드 (없으면 기본값으로 생성)
 *  - fs.watch로 파일 변경 감지 → 재시작 없이 핫 리로드
 *  - 검증: 범위/타입 체크 후 위반 시 거부
 *  - 변경 시 각 모듈(scheduler, trading-engine 등)에 자동 분배
 *  - 변경 이력 로깅
 */

import fs from 'fs';
import path from 'path';
import type {
  AppConfig,
  AppConfigPatch,
  ConfigChangeEvent,
  ConfigValidationResult,
  ConfigValidationError,
} from '@/types/config';
import type { SchedulerConfig } from '@/types/scheduler';
import type { DecisionEngineConfig } from '@/types/trading-decision';
import type { MarketSelectorConfig } from '@/types/market-selector';
import type { AIJudgmentConfig } from '@/types/ai-judgment';

// ──────────────────────────────────────────────
// 경로
// ──────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONFIG_HISTORY_FILE = path.join(DATA_DIR, 'config-history.json');

// ──────────────────────────────────────────────
// 기본값 (각 모듈의 DEFAULT_CONFIG 통합)
// ──────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  updatedAt: new Date().toISOString(),

  scheduler: {
    intervalMs: 5 * 60 * 1000, // 5분
    targetMarketCount: 5,
    candleUnit: 5,
    candleCount: 200,
    enabled: true,
  },

  trading: {
    buyThreshold: 25,
    sellThreshold: -25,
    minConfidence: 40,
    strategyWeights: {
      rsi: 0.20,
      macd: 0.20,
      bollinger: 0.15,
      movingAverage: 0.15,
      volume: 0.15,
      sentiment: 0.15,
    },
  },

  marketSelector: {
    minTradePrice24h: 1_000_000_000,
    maxChangeRate: 25,
    excludeCaution: true,
    selectCount: 5,
    watchlistMaxSize: 15,
    watchlistRetainCycles: 12,
  },

  risk: {
    totalCapital: 10_000_000,
    stopLoss: {
      stopLossRate: -3,
      takeProfitRate: 5,
      useTrailingStop: true,
      trailingStopRate: 2,
    },
    positionSize: {
      maxAmountPerTrade: 1_000_000,
      maxRatePerTrade: 10,
      maxTotalPosition: 7_000_000,
      maxTotalPositionRate: 70,
    },
    dailyLoss: {
      maxDailyLossAmount: 500_000,
      maxDailyLossRate: 5,
      maxDailyTrades: 20,
    },
    diversification: {
      maxHoldings: 5,
      maxSingleAssetRate: 30,
      blockSurgeCoins: true,
      minTradeVolume24h: 500_000_000,
    },
  },

  paperTrading: {
    initialCapital: 10_000_000,
    fee: {
      feeRate: 0.0005,
      slippageRate: 0.0005,
    },
  },

  ai: {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1024,
    temperature: 0.1,
    minIntervalMs: 10_000,
    timeoutMs: 30_000,
    fallbackToAlgorithm: true,
  },
};

// ──────────────────────────────────────────────
// 상태
// ──────────────────────────────────────────────

let currentConfig: AppConfig = deepClone(DEFAULT_CONFIG);
let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** 변경 리스너 (모듈 분배용) */
type ConfigListener = (event: ConfigChangeEvent) => void;
const listeners: ConfigListener[] = [];

// ──────────────────────────────────────────────
// 초기화
// ──────────────────────────────────────────────

/**
 * 설정 관리자 초기화.
 * - config.json 로드 (없으면 기본값으로 생성)
 * - 파일 변경 감시 시작
 */
export function initConfigManager(): AppConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const loaded = JSON.parse(raw) as Partial<AppConfig>;
      currentConfig = mergeWithDefaults(loaded);
      console.log('[ConfigManager] config.json 로드 완료');
    } catch (err) {
      console.error('[ConfigManager] config.json 파싱 실패 — 기본값 사용:', err);
      currentConfig = deepClone(DEFAULT_CONFIG);
    }
  } else {
    currentConfig = deepClone(DEFAULT_CONFIG);
    saveConfigToFile(currentConfig);
    console.log('[ConfigManager] config.json 기본값으로 생성');
  }

  startWatching();
  return deepClone(currentConfig);
}

/** 설정 관리자 종료 (파일 감시 중지) */
export function destroyConfigManager(): void {
  stopWatching();
  listeners.length = 0;
}

// ──────────────────────────────────────────────
// 조회
// ──────────────────────────────────────────────

/** 현재 설정 전체 조회 (복사본) */
export function getConfig(): AppConfig {
  return deepClone(currentConfig);
}

/** 특정 섹션만 조회 */
export function getConfigSection<K extends keyof AppConfig>(key: K): AppConfig[K] {
  return deepClone(currentConfig[key]);
}

/** 기본값 조회 */
export function getDefaultConfig(): AppConfig {
  return deepClone(DEFAULT_CONFIG);
}

// ──────────────────────────────────────────────
// 변경
// ──────────────────────────────────────────────

/**
 * 설정 부분 업데이트.
 * 검증 후 저장 + 리스너 알림.
 */
export function updateConfig(
  patch: AppConfigPatch,
  source: ConfigChangeEvent['source'] = 'api',
): { config: AppConfig; validation: ConfigValidationResult } {
  const merged = applyPatch(currentConfig, patch);
  const validation = validateConfig(merged);

  if (!validation.valid) {
    return { config: deepClone(currentConfig), validation };
  }

  const previous = currentConfig;
  merged.updatedAt = new Date().toISOString();
  currentConfig = merged;

  saveConfigToFile(currentConfig);

  // 변경된 섹션 감지
  const changedSections = detectChangedSections(previous, currentConfig);

  if (changedSections.length > 0) {
    const event: ConfigChangeEvent = {
      changedSections,
      previous: deepClone(previous),
      current: deepClone(currentConfig),
      timestamp: new Date().toISOString(),
      source,
    };

    appendHistory(event);
    notifyListeners(event);

    console.log(
      `[ConfigManager] 설정 업데이트 (${source}): ${changedSections.join(', ')}`,
    );
  }

  return { config: deepClone(currentConfig), validation };
}

/** 설정을 기본값으로 초기화 */
export function resetConfig(): AppConfig {
  const patch: AppConfigPatch = {
    scheduler: deepClone(DEFAULT_CONFIG.scheduler),
    trading: deepClone(DEFAULT_CONFIG.trading),
    marketSelector: deepClone(DEFAULT_CONFIG.marketSelector),
    risk: deepClone(DEFAULT_CONFIG.risk),
    paperTrading: deepClone(DEFAULT_CONFIG.paperTrading),
    ai: deepClone(DEFAULT_CONFIG.ai),
  };
  const { config } = updateConfig(patch, 'api');
  return config;
}

// ──────────────────────────────────────────────
// 리스너 (모듈 분배용)
// ──────────────────────────────────────────────

/** 설정 변경 리스너 등록 */
export function onConfigChange(listener: ConfigListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notifyListeners(event: ConfigChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('[ConfigManager] 리스너 에러:', err);
    }
  }
}

// ──────────────────────────────────────────────
// 검증
// ──────────────────────────────────────────────

/** 전체 설정 검증 */
export function validateConfig(config: AppConfig): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  // ── scheduler ──
  const s = config.scheduler;
  if (s.intervalMs < 10_000) {
    errors.push({ path: 'scheduler.intervalMs', message: '최소 10초 이상이어야 합니다', value: s.intervalMs });
  }
  if (s.intervalMs > 3_600_000) {
    errors.push({ path: 'scheduler.intervalMs', message: '최대 1시간 이하여야 합니다', value: s.intervalMs });
  }
  if (s.targetMarketCount < 1 || s.targetMarketCount > 20) {
    errors.push({ path: 'scheduler.targetMarketCount', message: '1~20 범위여야 합니다', value: s.targetMarketCount });
  }
  if (![5, 15, 30, 60].includes(s.candleUnit)) {
    errors.push({ path: 'scheduler.candleUnit', message: '5, 15, 30, 60 중 하나여야 합니다', value: s.candleUnit });
  }
  if (s.candleCount < 30 || s.candleCount > 500) {
    errors.push({ path: 'scheduler.candleCount', message: '30~500 범위여야 합니다', value: s.candleCount });
  }

  // ── trading ──
  const t = config.trading;
  if (t.buyThreshold < 0 || t.buyThreshold > 100) {
    errors.push({ path: 'trading.buyThreshold', message: '0~100 범위여야 합니다', value: t.buyThreshold });
  }
  if (t.sellThreshold < -100 || t.sellThreshold > 0) {
    errors.push({ path: 'trading.sellThreshold', message: '-100~0 범위여야 합니다', value: t.sellThreshold });
  }
  if (t.minConfidence < 0 || t.minConfidence > 100) {
    errors.push({ path: 'trading.minConfidence', message: '0~100 범위여야 합니다', value: t.minConfidence });
  }

  // 전략 가중치 합 검증
  const weightSum = Object.values(t.strategyWeights).reduce((sum, w) => sum + w, 0);
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push({ path: 'trading.strategyWeights', message: `가중치 합이 1.0이어야 합니다 (현재 ${weightSum.toFixed(3)})`, value: weightSum });
  }

  // ── marketSelector ──
  const ms = config.marketSelector;
  if (ms.minTradePrice24h < 0) {
    errors.push({ path: 'marketSelector.minTradePrice24h', message: '0 이상이어야 합니다', value: ms.minTradePrice24h });
  }
  if (ms.maxChangeRate < 1 || ms.maxChangeRate > 100) {
    errors.push({ path: 'marketSelector.maxChangeRate', message: '1~100 범위여야 합니다', value: ms.maxChangeRate });
  }
  if (ms.selectCount < 1 || ms.selectCount > 30) {
    errors.push({ path: 'marketSelector.selectCount', message: '1~30 범위여야 합니다', value: ms.selectCount });
  }

  // ── risk ──
  const r = config.risk;
  if (r.totalCapital < 100_000) {
    errors.push({ path: 'risk.totalCapital', message: '최소 10만원 이상이어야 합니다', value: r.totalCapital });
  }
  if (r.stopLoss.stopLossRate > 0) {
    errors.push({ path: 'risk.stopLoss.stopLossRate', message: '음수여야 합니다 (예: -3)', value: r.stopLoss.stopLossRate });
  }
  if (r.stopLoss.takeProfitRate < 0) {
    errors.push({ path: 'risk.stopLoss.takeProfitRate', message: '양수여야 합니다 (예: 5)', value: r.stopLoss.takeProfitRate });
  }
  if (r.positionSize.maxRatePerTrade < 1 || r.positionSize.maxRatePerTrade > 100) {
    errors.push({ path: 'risk.positionSize.maxRatePerTrade', message: '1~100 범위여야 합니다', value: r.positionSize.maxRatePerTrade });
  }
  if (r.diversification.maxHoldings < 1 || r.diversification.maxHoldings > 20) {
    errors.push({ path: 'risk.diversification.maxHoldings', message: '1~20 범위여야 합니다', value: r.diversification.maxHoldings });
  }

  // ── paperTrading ──
  const pt = config.paperTrading;
  if (pt.initialCapital < 100_000) {
    errors.push({ path: 'paperTrading.initialCapital', message: '최소 10만원 이상이어야 합니다', value: pt.initialCapital });
  }
  if (pt.fee.feeRate < 0 || pt.fee.feeRate > 0.01) {
    errors.push({ path: 'paperTrading.fee.feeRate', message: '0~0.01 범위여야 합니다', value: pt.fee.feeRate });
  }

  // ── ai ──
  const ai = config.ai;
  if (!ai.model || ai.model.trim().length === 0) {
    errors.push({ path: 'ai.model', message: '모델 ID가 비어있습니다', value: ai.model });
  }
  if (ai.maxTokens < 256 || ai.maxTokens > 8192) {
    errors.push({ path: 'ai.maxTokens', message: '256~8192 범위여야 합니다', value: ai.maxTokens });
  }
  if (ai.temperature < 0 || ai.temperature > 1) {
    errors.push({ path: 'ai.temperature', message: '0~1 범위여야 합니다', value: ai.temperature });
  }

  return { valid: errors.length === 0, errors };
}

// ──────────────────────────────────────────────
// 파일 감시 (핫 리로드)
// ──────────────────────────────────────────────

function startWatching(): void {
  if (watcher) return;

  try {
    watcher = fs.watch(CONFIG_FILE, (eventType) => {
      if (eventType !== 'change') return;

      // 디바운스: 짧은 시간 내 여러 이벤트 방지
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        reloadFromFile();
      }, 500);
    });

    watcher.on('error', (err) => {
      console.error('[ConfigManager] 파일 감시 에러:', err);
    });

    console.log('[ConfigManager] config.json 파일 감시 시작');
  } catch (err) {
    console.warn('[ConfigManager] 파일 감시 시작 실패:', err);
  }
}

function stopWatching(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

/** 파일에서 설정 다시 로드 (외부 편집 감지 시) */
function reloadFromFile(): void {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;

    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const loaded = JSON.parse(raw) as Partial<AppConfig>;
    const merged = mergeWithDefaults(loaded);

    const validation = validateConfig(merged);
    if (!validation.valid) {
      console.warn(
        '[ConfigManager] 파일 변경 감지 — 검증 실패, 무시:',
        validation.errors.map((e) => `${e.path}: ${e.message}`).join(', '),
      );
      return;
    }

    const previous = currentConfig;
    currentConfig = merged;

    const changedSections = detectChangedSections(previous, currentConfig);
    if (changedSections.length > 0) {
      const event: ConfigChangeEvent = {
        changedSections,
        previous: deepClone(previous),
        current: deepClone(currentConfig),
        timestamp: new Date().toISOString(),
        source: 'file_watch',
      };

      appendHistory(event);
      notifyListeners(event);

      console.log(
        `[ConfigManager] 파일 변경 감지 — 핫 리로드: ${changedSections.join(', ')}`,
      );
    }
  } catch (err) {
    console.error('[ConfigManager] 파일 리로드 실패:', err);
  }
}

// ──────────────────────────────────────────────
// 파일 I/O
// ──────────────────────────────────────────────

function saveConfigToFile(config: AppConfig): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ConfigManager] 설정 파일 저장 실패:', err);
  }
}

/** 변경 이력 추가 (최대 50건 유지) */
function appendHistory(event: ConfigChangeEvent): void {
  try {
    let history: ConfigChangeEvent[] = [];
    if (fs.existsSync(CONFIG_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG_HISTORY_FILE, 'utf-8'));
    }

    history.push({
      changedSections: event.changedSections,
      previous: { version: event.previous.version, updatedAt: event.previous.updatedAt } as AppConfig,
      current: { version: event.current.version, updatedAt: event.current.updatedAt } as AppConfig,
      timestamp: event.timestamp,
      source: event.source,
    });

    // 최대 50건 유지
    if (history.length > 50) {
      history = history.slice(-50);
    }

    fs.writeFileSync(CONFIG_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // 이력 저장 실패는 무시
  }
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

/** 기본값과 병합 (누락 필드 보완) */
function mergeWithDefaults(loaded: Partial<AppConfig>): AppConfig {
  const def = deepClone(DEFAULT_CONFIG);

  return {
    version: loaded.version ?? def.version,
    updatedAt: loaded.updatedAt ?? def.updatedAt,
    scheduler: { ...def.scheduler, ...(loaded.scheduler ?? {}) },
    trading: {
      ...def.trading,
      ...(loaded.trading ?? {}),
      strategyWeights: {
        ...def.trading.strategyWeights,
        ...(loaded.trading?.strategyWeights ?? {}),
      },
    },
    marketSelector: { ...def.marketSelector, ...(loaded.marketSelector ?? {}) },
    risk: {
      ...def.risk,
      ...(loaded.risk ?? {}),
      stopLoss: { ...def.risk.stopLoss, ...(loaded.risk?.stopLoss ?? {}) },
      positionSize: { ...def.risk.positionSize, ...(loaded.risk?.positionSize ?? {}) },
      dailyLoss: { ...def.risk.dailyLoss, ...(loaded.risk?.dailyLoss ?? {}) },
      diversification: { ...def.risk.diversification, ...(loaded.risk?.diversification ?? {}) },
    },
    paperTrading: {
      ...def.paperTrading,
      ...(loaded.paperTrading ?? {}),
      fee: { ...def.paperTrading.fee, ...(loaded.paperTrading?.fee ?? {}) },
    },
    ai: { ...def.ai, ...(loaded.ai ?? {}) },
  };
}

/** 패치 적용 (깊은 병합) */
function applyPatch(base: AppConfig, patch: AppConfigPatch): AppConfig {
  const result = deepClone(base);

  if (patch.scheduler) {
    Object.assign(result.scheduler, patch.scheduler);
  }
  if (patch.trading) {
    if (patch.trading.strategyWeights) {
      result.trading.strategyWeights = {
        ...result.trading.strategyWeights,
        ...patch.trading.strategyWeights,
      };
    }
    const { strategyWeights: _sw, ...rest } = patch.trading;
    Object.assign(result.trading, rest);
  }
  if (patch.marketSelector) {
    Object.assign(result.marketSelector, patch.marketSelector);
  }
  if (patch.risk) {
    if (patch.risk.stopLoss) Object.assign(result.risk.stopLoss, patch.risk.stopLoss);
    if (patch.risk.positionSize) Object.assign(result.risk.positionSize, patch.risk.positionSize);
    if (patch.risk.dailyLoss) Object.assign(result.risk.dailyLoss, patch.risk.dailyLoss);
    if (patch.risk.diversification) Object.assign(result.risk.diversification, patch.risk.diversification);
    if (patch.risk.totalCapital !== undefined) result.risk.totalCapital = patch.risk.totalCapital;
  }
  if (patch.paperTrading) {
    if (patch.paperTrading.fee) Object.assign(result.paperTrading.fee, patch.paperTrading.fee);
    if (patch.paperTrading.initialCapital !== undefined) {
      result.paperTrading.initialCapital = patch.paperTrading.initialCapital;
    }
  }
  if (patch.ai) {
    Object.assign(result.ai, patch.ai);
  }

  return result;
}

/** 변경된 섹션 감지 */
function detectChangedSections(
  prev: AppConfig,
  next: AppConfig,
): (keyof Omit<AppConfig, 'version' | 'updatedAt'>)[] {
  const sections: (keyof Omit<AppConfig, 'version' | 'updatedAt'>)[] = [
    'scheduler', 'trading', 'marketSelector', 'risk', 'paperTrading', 'ai',
  ];

  return sections.filter(
    (key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]),
  );
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
