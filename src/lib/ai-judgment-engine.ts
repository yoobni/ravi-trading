/**
 * AI 판단 엔진 — Claude API 기반 매매 신호 생성
 *
 * 1. 시장 데이터를 구조화된 프롬프트로 변환
 * 2. Claude API tool_use로 호출하여 정형화된 응답 확보
 * 3. 응답을 TradingDecision으로 변환
 * 4. 실패 시 알고리즘 엔진(trading-engine.ts)으로 폴백
 * 5. 판단 로그를 구조화된 형식으로 저장
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  DecisionInput,
  TradingDecision,
  StrategySignal,
} from '@/types/trading-decision';
import type {
  AIJudgmentConfig,
  AIJudgmentResponse,
  AIJudgmentLog,
  MarketPromptContext,
} from '@/types/ai-judgment';
import { evaluate as algorithmEvaluate } from '@/lib/trading-engine';
import { saveJudgmentLog } from '@/lib/ai-judgment-store';

// ─── 설정 ────────────────────────────────────────────────────

const DEFAULT_CONFIG: AIJudgmentConfig = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 1024,
  temperature: 0.1,
  minIntervalMs: 10_000, // 최소 10초 간격
  timeoutMs: 30_000,
  fallbackToAlgorithm: true,
};

let config: AIJudgmentConfig = { ...DEFAULT_CONFIG };
let lastCallTimestamp = 0;
let client: Anthropic | null = null;

// ─── 설정 관리 ───────────────────────────────────────────────

export function getAIConfig(): AIJudgmentConfig {
  return { ...config };
}

export function updateAIConfig(partial: Partial<AIJudgmentConfig>): AIJudgmentConfig {
  config = { ...config, ...partial };
  return { ...config };
}

// ─── Claude 클라이언트 ───────────────────────────────────────

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// ─── 프롬프트 컨텍스트 변환 ─────────────────────────────────

function latestNonNull(arr: (number | null)[], nth = 0): number | null {
  let count = 0;
  for (const v of arr) {
    if (v !== null) {
      if (count === nth) return v;
      count++;
    }
  }
  return null;
}

function detectTrend(arr: (number | null)[]): 'rising' | 'falling' | 'flat' {
  const a = latestNonNull(arr, 0);
  const b = latestNonNull(arr, 1);
  if (a === null || b === null) return 'flat';
  const diff = a - b;
  if (Math.abs(diff) < 0.5) return 'flat';
  return diff > 0 ? 'rising' : 'falling';
}

function detectMACDCross(histogram: (number | null)[]): 'golden' | 'dead' | 'none' {
  const curr = latestNonNull(histogram, 0);
  const prev = latestNonNull(histogram, 1);
  if (curr === null || prev === null) return 'none';
  if (prev <= 0 && curr > 0) return 'golden';
  if (prev >= 0 && curr < 0) return 'dead';
  return 'none';
}

function detectMAAlignment(
  ma5: number | null,
  ma20: number | null,
  ma60: number | null,
): 'bullish' | 'bearish' | 'mixed' {
  if (ma5 === null || ma20 === null) return 'mixed';
  if (ma60 === null) {
    return ma5 > ma20 ? 'bullish' : ma5 < ma20 ? 'bearish' : 'mixed';
  }
  if (ma5 > ma20 && ma20 > ma60) return 'bullish';
  if (ma5 < ma20 && ma20 < ma60) return 'bearish';
  return 'mixed';
}

function detectOBVTrend(obv: number[]): 'rising' | 'falling' | 'flat' {
  if (obv.length < 3) return 'flat';
  const recent = obv.slice(-5);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const diff = last - first;
  if (Math.abs(diff) < Math.abs(first) * 0.01) return 'flat';
  return diff > 0 ? 'rising' : 'falling';
}

export function buildPromptContext(input: DecisionInput): MarketPromptContext {
  const { technicalAnalysis: ta, marketAnalysis: ma, portfolio } = input;

  return {
    market: input.market,
    currentPrice: input.currentPrice,
    technical: {
      rsi: latestNonNull(ta.rsi.values),
      rsiTrend: detectTrend(ta.rsi.values),
      macdHistogram: latestNonNull(ta.macd.histogram),
      macdCross: detectMACDCross(ta.macd.histogram),
      bollingerPercentB: latestNonNull(ta.bollingerBand.percentB),
      bollingerBandwidth: latestNonNull(ta.bollingerBand.bandwidth),
      maAlignment: detectMAAlignment(
        latestNonNull(ta.ma.ma5.values),
        latestNonNull(ta.ma.ma20.values),
        latestNonNull(ta.ma.ma60.values),
      ),
      ma5: latestNonNull(ta.ma.ma5.values),
      ma20: latestNonNull(ta.ma.ma20.values),
      ma60: latestNonNull(ta.ma.ma60.values),
      volumeRatio: ta.volume.volumeRatio,
      volumeSurge: ta.volume.isSurge,
      obvTrend: detectOBVTrend(ta.volume.obv),
    },
    marketSentiment: {
      fearGreedScore: ma.fearGreed.score,
      fearGreedLabel: ma.fearGreed.label,
      btcDominance: ma.btcDominance.dominanceRate,
      btcChangeRate: ma.btcDominance.btcChangeRate,
      surgeCount: ma.surges.length,
      crashCount: ma.crashes.length,
      topVolumeMarkets: ma.topVolume.slice(0, 5).map((v) => v.koreanName),
    },
    portfolio: {
      isHolding: portfolio.isHolding,
      avgBuyPrice: portfolio.avgBuyPrice,
      currentProfitRate: portfolio.currentProfitRate,
      holdingCount: portfolio.holdingCount,
      availableBalance: portfolio.availableBalance,
      todayTradeCount: portfolio.todayTradeCount,
      todayRealizedPnL: portfolio.todayRealizedPnL,
    },
  };
}

// ─── 시스템 프롬프트 ────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 암호화폐 매매 전문 AI 분석가입니다.
제공된 기술적 지표, 시장 심리, 포트폴리오 상태를 종합 분석하여 매수/매도/관망을 판단합니다.

## 판단 원칙
1. 수익률과 승률을 최우선으로 고려합니다.
2. 과도한 매매(오버트레이딩)를 피하고, 확실한 시그널이 있을 때만 행동합니다.
3. 손절은 빠르게, 익절은 느리게 — 손실 최소화 우선입니다.
4. 시장 전체 흐름(공포/탐욕, BTC 도미넌스)을 개별 종목 판단에 반영합니다.
5. 거래량이 뒷받침되지 않는 움직임은 신뢰하지 않습니다.
6. 이미 보유 중이면 추가 매수보다 관망/매도를 우선 검토합니다.
7. 오늘 손실이 크면 매수를 자제합니다.

## 응답 규칙
- 판단 근거를 반드시 한글로, 구체적 수치와 함께 작성합니다.
- confidence가 40 미만이면 반드시 hold(관망)을 선택합니다.
- 매수 시 suggestedSizeRate는 0.1~0.3 범위를 권장합니다 (보수적 운용).
- 매도 시 이미 보유 중인 경우에만 sell을 선택합니다.`;

// ─── Tool 정의 (구조화된 응답 강제) ────────────────────────

const JUDGMENT_TOOL: Anthropic.Tool = {
  name: 'submit_trading_judgment',
  description: '매매 판단 결과를 구조화된 형식으로 제출합니다.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['buy', 'sell', 'hold'],
        description: '매수/매도/관망',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: '신뢰도 (0~100). 40 미만이면 반드시 hold.',
      },
      compositeScore: {
        type: 'number',
        minimum: -100,
        maximum: 100,
        description: '종합 점수. 양수=매수 성향, 음수=매도 성향.',
      },
      suggestedSizeRate: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: '제안 매매 비율 (가용 자금 대비 0~1)',
      },
      suggestedStopLoss: {
        type: ['number', 'null'],
        description: '매수 시 제안 손절가 (KRW). hold/sell이면 null.',
      },
      suggestedTakeProfit: {
        type: ['number', 'null'],
        description: '매수 시 제안 익절가 (KRW). hold/sell이면 null.',
      },
      reasoning: {
        type: 'string',
        description: '판단 근거 요약 (한글, 200자 이내). 핵심 시그널, 리스크, 결론 포함.',
      },
      keySignals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '시그널 이름' },
            direction: {
              type: 'string',
              enum: ['bullish', 'bearish', 'neutral'],
            },
            importance: {
              type: 'number',
              minimum: 1,
              maximum: 5,
              description: '중요도 (1~5)',
            },
            description: { type: 'string', description: '설명' },
          },
          required: ['name', 'direction', 'importance', 'description'],
        },
        description: '핵심 시그널 목록 (3~5개)',
      },
    },
    required: [
      'action',
      'confidence',
      'compositeScore',
      'suggestedSizeRate',
      'suggestedStopLoss',
      'suggestedTakeProfit',
      'reasoning',
      'keySignals',
    ],
  },
};

// ─── 유저 프롬프트 생성 ─────────────────────────────────────

function buildUserPrompt(ctx: MarketPromptContext): string {
  const t = ctx.technical;
  const s = ctx.marketSentiment;
  const p = ctx.portfolio;

  const lines: string[] = [
    `## 분석 대상: ${ctx.market}`,
    `현재가: ${ctx.currentPrice.toLocaleString()}원`,
    '',
    '## 기술적 지표',
    `- RSI: ${t.rsi?.toFixed(1) ?? 'N/A'} (추세: ${t.rsiTrend})`,
    `- MACD 히스토그램: ${t.macdHistogram?.toFixed(4) ?? 'N/A'} (크로스: ${t.macdCross})`,
    `- 볼린저 %B: ${t.bollingerPercentB?.toFixed(3) ?? 'N/A'}, 밴드폭: ${t.bollingerBandwidth?.toFixed(4) ?? 'N/A'}`,
    `- 이동평균: MA5=${t.ma5?.toLocaleString() ?? 'N/A'}, MA20=${t.ma20?.toLocaleString() ?? 'N/A'}, MA60=${t.ma60?.toLocaleString() ?? 'N/A'} (${t.maAlignment})`,
    `- 거래량 비율: ${t.volumeRatio.toFixed(2)}배 (서지: ${t.volumeSurge ? '예' : '아니오'}, OBV: ${t.obvTrend})`,
    '',
    '## 시장 심리',
    `- 공포/탐욕: ${s.fearGreedScore}점 (${s.fearGreedLabel})`,
    `- BTC 도미넌스: ${s.btcDominance}%, BTC 변동률: ${s.btcChangeRate > 0 ? '+' : ''}${s.btcChangeRate}%`,
    `- 급등 ${s.surgeCount}건, 급락 ${s.crashCount}건`,
    `- 거래대금 TOP5: ${s.topVolumeMarkets.join(', ')}`,
    '',
    '## 포트폴리오',
    `- 보유 여부: ${p.isHolding ? '보유 중' : '미보유'}`,
  ];

  if (p.isHolding) {
    lines.push(`- 평균 매수가: ${p.avgBuyPrice?.toLocaleString() ?? 'N/A'}원`);
    lines.push(`- 현재 수익률: ${p.currentProfitRate !== null ? (p.currentProfitRate * 100).toFixed(2) + '%' : 'N/A'}`);
  }

  lines.push(
    `- 보유 종목 수: ${p.holdingCount}`,
    `- 가용 잔고: ${p.availableBalance.toLocaleString()}원`,
    `- 오늘 거래 횟수: ${p.todayTradeCount}건`,
    `- 오늘 실현 손익: ${p.todayRealizedPnL.toLocaleString()}원`,
    '',
    '위 데이터를 종합 분석하여 submit_trading_judgment 도구로 판단을 제출해주세요.',
  );

  return lines.join('\n');
}

// ─── Claude API 호출 ────────────────────────────────────────

async function callClaude(
  ctx: MarketPromptContext,
): Promise<{ response: AIJudgmentResponse; latencyMs: number; tokenUsage: { input: number; output: number } }> {
  const anthropic = getClient();
  const userPrompt = buildUserPrompt(ctx);

  const startTime = Date.now();

  const message = await anthropic.messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    system: SYSTEM_PROMPT,
    tools: [JUDGMENT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_trading_judgment' },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const latencyMs = Date.now() - startTime;

  const tokenUsage = {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
  };

  // tool_use 블록에서 응답 추출
  const toolBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolBlock) {
    throw new Error('Claude 응답에서 tool_use 블록을 찾을 수 없습니다.');
  }

  const raw = toolBlock.input as Record<string, unknown>;

  const response: AIJudgmentResponse = {
    action: validateAction(raw.action),
    confidence: clamp(Number(raw.confidence) || 0, 0, 100),
    compositeScore: clamp(Number(raw.compositeScore) || 0, -100, 100),
    suggestedSizeRate: clamp(Number(raw.suggestedSizeRate) || 0, 0, 1),
    suggestedStopLoss: raw.suggestedStopLoss != null ? Number(raw.suggestedStopLoss) : null,
    suggestedTakeProfit: raw.suggestedTakeProfit != null ? Number(raw.suggestedTakeProfit) : null,
    reasoning: String(raw.reasoning || ''),
    keySignals: Array.isArray(raw.keySignals)
      ? raw.keySignals.map((s: Record<string, unknown>) => ({
          name: String(s.name || ''),
          direction: validateDirection(s.direction),
          importance: clamp(Number(s.importance) || 1, 1, 5),
          description: String(s.description || ''),
        }))
      : [],
  };

  // 신뢰도 40 미만이면 강제 hold
  if (response.confidence < 40 && response.action !== 'hold') {
    response.action = 'hold';
    response.reasoning += ' [신뢰도 40 미만 → 관망으로 보정]';
  }

  return { response, latencyMs, tokenUsage };
}

// ─── AI 응답 → TradingDecision 변환 ────────────────────────

function toTradingDecision(
  input: DecisionInput,
  aiResponse: AIJudgmentResponse,
): TradingDecision {
  const signals: StrategySignal[] = aiResponse.keySignals.map((s) => ({
    name: s.name,
    score: s.direction === 'bullish' ? s.importance / 5 : s.direction === 'bearish' ? -s.importance / 5 : 0,
    weight: s.importance / 5,
    reason: s.description,
  }));

  return {
    market: input.market,
    timestamp: new Date().toISOString(),
    action: aiResponse.action,
    confidence: aiResponse.confidence,
    compositeScore: aiResponse.compositeScore,
    signals,
    reasoning: aiResponse.reasoning,
    suggestedSizeRate: aiResponse.suggestedSizeRate,
    currentPrice: input.currentPrice,
    suggestedStopLoss: aiResponse.suggestedStopLoss,
    suggestedTakeProfit: aiResponse.suggestedTakeProfit,
  };
}

// ─── 메인 함수: AI 기반 판단 ────────────────────────────────

/**
 * AI(Claude) 기반 매매 판단.
 *
 * 1. 입력 데이터를 구조화된 프롬프트로 변환
 * 2. Claude API tool_use로 호출
 * 3. 응답을 TradingDecision으로 변환
 * 4. 판단 로그를 JSON 파일로 저장
 * 5. 실패 시 알고리즘 엔진으로 폴백
 */
export async function evaluateWithAI(input: DecisionInput): Promise<TradingDecision> {
  const now = Date.now();
  const ctx = buildPromptContext(input);

  // 호출 빈도 제한
  const elapsed = now - lastCallTimestamp;
  if (elapsed < config.minIntervalMs) {
    const waitMs = config.minIntervalMs - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  let log: AIJudgmentLog;

  try {
    lastCallTimestamp = Date.now();
    const { response, latencyMs, tokenUsage } = await callClaude(ctx);
    const decision = toTradingDecision(input, response);

    log = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      market: input.market,
      input: ctx,
      rawResponse: response,
      decision,
      engine: 'claude',
      latencyMs,
      tokenUsage,
      error: null,
    };

    saveJudgmentLog(log);
    return decision;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (config.fallbackToAlgorithm) {
      const fallbackDecision = algorithmEvaluate(input);

      log = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        market: input.market,
        input: ctx,
        rawResponse: null,
        decision: fallbackDecision,
        engine: 'fallback',
        latencyMs: 0,
        tokenUsage: null,
        error: errorMsg,
      };

      saveJudgmentLog(log);
      return fallbackDecision;
    }

    throw new Error(`AI 판단 엔진 실패: ${errorMsg}`);
  }
}

/**
 * 알고리즘 전용 판단 (Claude 미사용).
 * API 키 없이도 동작합니다.
 */
export function evaluateWithAlgorithm(input: DecisionInput): TradingDecision {
  const ctx = buildPromptContext(input);
  const decision = algorithmEvaluate(input);

  const log: AIJudgmentLog = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    market: input.market,
    input: ctx,
    rawResponse: null,
    decision,
    engine: 'algorithm',
    latencyMs: 0,
    tokenUsage: null,
    error: null,
  };

  saveJudgmentLog(log);
  return decision;
}

// ─── 유틸 ────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function validateAction(v: unknown): 'buy' | 'sell' | 'hold' {
  if (v === 'buy' || v === 'sell' || v === 'hold') return v;
  return 'hold';
}

function validateDirection(v: unknown): 'bullish' | 'bearish' | 'neutral' {
  if (v === 'bullish' || v === 'bearish' || v === 'neutral') return v;
  return 'neutral';
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `aj_${ts}_${rand}`;
}
