/**
 * 판단 로그 서비스
 *
 * 매 판단 사이클마다 통합 로그를 기록:
 * - JSON 파일 저장 (data/decision-logs/{YYYY-MM-DD}/{pipelineId}.json)
 * - 콘솔 출력 (읽기 쉬운 형식)
 */

import fs from 'fs';
import path from 'path';
import type {
  DecisionLog,
  PipelineDecisionLog,
  DecisionLogFilter,
  DecisionLogDailySummary,
  IndicatorSnapshot,
  SentimentSnapshot,
  PortfolioSnapshot,
  AIJudgmentRaw,
  RiskCheckResult,
  ExecutionResult,
} from '@/types/decision-log';
import type { MarketPipelineResult, PipelineResult } from '@/types/strategy-pipeline';
import type { MarketAnalysis } from '@/types/market-analysis';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'decision-logs');

// ──────────────────────────────────────────────
// 파이프라인 결과 → 판단 로그 변환
// ──────────────────────────────────────────────

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dl_${ts}_${rand}`;
}

function extractIndicators(market: MarketPipelineResult): IndicatorSnapshot {
  const ctx = market.judgment?.decision;
  // analysis 스테이지의 기술 분석 결과에서 추출
  if (!market.analysis) {
    return emptyIndicators();
  }

  const ta = market.analysis.technicalAnalysis;
  const latestNonNull = (arr: (number | null)[], nth = 0): number | null => {
    let count = 0;
    for (const v of arr) {
      if (v !== null) {
        if (count === nth) return v;
        count++;
      }
    }
    return null;
  };

  const detectTrend = (arr: (number | null)[]): 'rising' | 'falling' | 'flat' => {
    const a = latestNonNull(arr, 0);
    const b = latestNonNull(arr, 1);
    if (a === null || b === null) return 'flat';
    const diff = a - b;
    if (Math.abs(diff) < 0.5) return 'flat';
    return diff > 0 ? 'rising' : 'falling';
  };

  const detectMACDCross = (histogram: (number | null)[]): 'golden' | 'dead' | 'none' => {
    const curr = latestNonNull(histogram, 0);
    const prev = latestNonNull(histogram, 1);
    if (curr === null || prev === null) return 'none';
    if (prev <= 0 && curr > 0) return 'golden';
    if (prev >= 0 && curr < 0) return 'dead';
    return 'none';
  };

  const detectMAAlignment = (
    ma5: number | null,
    ma20: number | null,
    ma60: number | null,
  ): 'bullish' | 'bearish' | 'mixed' => {
    if (ma5 === null || ma20 === null) return 'mixed';
    if (ma60 === null) return ma5 > ma20 ? 'bullish' : ma5 < ma20 ? 'bearish' : 'mixed';
    if (ma5 > ma20 && ma20 > ma60) return 'bullish';
    if (ma5 < ma20 && ma20 < ma60) return 'bearish';
    return 'mixed';
  };

  const detectOBVTrend = (obv: number[]): 'rising' | 'falling' | 'flat' => {
    if (obv.length < 3) return 'flat';
    const recent = obv.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const diff = last - first;
    if (Math.abs(diff) < Math.abs(first) * 0.01) return 'flat';
    return diff > 0 ? 'rising' : 'falling';
  };

  const ma5 = latestNonNull(ta.ma.ma5.values);
  const ma20 = latestNonNull(ta.ma.ma20.values);
  const ma60 = latestNonNull(ta.ma.ma60.values);

  return {
    rsi: latestNonNull(ta.rsi.values),
    rsiTrend: detectTrend(ta.rsi.values),
    macdHistogram: latestNonNull(ta.macd.histogram),
    macdCross: detectMACDCross(ta.macd.histogram),
    bollingerPercentB: latestNonNull(ta.bollingerBand.percentB),
    bollingerBandwidth: latestNonNull(ta.bollingerBand.bandwidth),
    maAlignment: detectMAAlignment(ma5, ma20, ma60),
    ma5,
    ma20,
    ma60,
    volumeRatio: ta.volume.volumeRatio,
    volumeSurge: ta.volume.isSurge,
    obvTrend: detectOBVTrend(ta.volume.obv),
  };
}

function emptyIndicators(): IndicatorSnapshot {
  return {
    rsi: null, rsiTrend: 'flat',
    macdHistogram: null, macdCross: 'none',
    bollingerPercentB: null, bollingerBandwidth: null,
    maAlignment: 'mixed',
    ma5: null, ma20: null, ma60: null,
    volumeRatio: 0, volumeSurge: false, obvTrend: 'flat',
  };
}

function extractSentiment(marketAnalysis: MarketAnalysis): SentimentSnapshot {
  return {
    fearGreedScore: marketAnalysis.fearGreed?.score ?? 0,
    fearGreedLabel: marketAnalysis.fearGreed?.label ?? 'N/A',
    btcDominance: marketAnalysis.btcDominance?.dominanceRate ?? 0,
    btcChangeRate: marketAnalysis.btcDominance?.btcChangeRate ?? 0,
    surgeCount: marketAnalysis.surges?.length ?? 0,
    crashCount: marketAnalysis.crashes?.length ?? 0,
  };
}

function extractPortfolio(market: MarketPipelineResult): PortfolioSnapshot {
  if (!market.analysis) {
    return { isHolding: false, avgBuyPrice: null, currentProfitRate: null, holdingCount: 0, availableBalance: 0 };
  }
  const p = market.analysis.portfolio;
  return {
    isHolding: p.isHolding,
    avgBuyPrice: p.avgBuyPrice,
    currentProfitRate: p.currentProfitRate,
    holdingCount: p.holdingCount,
    availableBalance: p.availableBalance,
  };
}

function extractAIJudgment(market: MarketPipelineResult): AIJudgmentRaw {
  if (!market.judgment) {
    return {
      engine: 'algorithm', action: 'hold', confidence: 0, compositeScore: 0,
      reasoning: '판단 미수행', keySignals: [],
      suggestedSizeRate: 0, suggestedStopLoss: null, suggestedTakeProfit: null,
      latencyMs: 0, tokenUsage: null,
    };
  }

  const d = market.judgment.decision;
  return {
    engine: market.judgment.source === 'ai' ? 'claude' : 'algorithm',
    action: d.action,
    confidence: d.confidence,
    compositeScore: d.compositeScore,
    reasoning: d.reasoning,
    keySignals: d.signals.map((s) => ({
      name: s.name,
      direction: s.score > 0 ? 'bullish' as const : s.score < 0 ? 'bearish' as const : 'neutral' as const,
      importance: Math.round(Math.abs(s.score) * 5),
      description: s.reason,
    })),
    suggestedSizeRate: d.suggestedSizeRate,
    suggestedStopLoss: d.suggestedStopLoss,
    suggestedTakeProfit: d.suggestedTakeProfit,
    latencyMs: market.traces.find((t) => t.stage === 'judgment')?.durationMs ?? 0,
    tokenUsage: null, // 토큰 사용량은 ai-judgment-store에서 별도 기록
  };
}

function extractRiskCheck(market: MarketPipelineResult): RiskCheckResult {
  if (!market.riskCheck) {
    return { checked: false, allowed: true, adjustedAmount: null, blockReason: null };
  }
  return {
    checked: true,
    allowed: market.riskCheck.allowed,
    adjustedAmount: market.riskCheck.adjustedAmount,
    blockReason: market.riskCheck.blockReason,
  };
}

function extractExecution(market: MarketPipelineResult): ExecutionResult {
  if (!market.execution || !market.execution.execution) {
    return {
      executed: false,
      action: market.judgment?.decision.action ?? 'hold',
      executedPrice: null,
      amount: null,
      fee: null,
      success: false,
      skipReason: market.execution?.skipReason ?? '실행 스킵',
    };
  }
  const e = market.execution.execution;
  return {
    executed: true,
    action: e.action,
    executedPrice: e.executedPrice,
    amount: e.amount,
    fee: e.fee,
    success: e.success,
    skipReason: null,
  };
}

function extractStageDurations(market: MarketPipelineResult): Record<string, number> {
  const durations: Record<string, number> = {};
  for (const t of market.traces) {
    durations[t.stage] = t.durationMs;
  }
  return durations;
}

/** 파이프라인 결과 → 통합 판단 로그 변환 */
export function buildDecisionLog(
  pipelineResult: PipelineResult,
): PipelineDecisionLog {
  const decisions: DecisionLog[] = [];

  for (const market of pipelineResult.markets) {
    const totalDurationMs = market.traces.reduce((sum, t) => sum + t.durationMs, 0);

    const log: DecisionLog = {
      id: generateId(),
      pipelineId: pipelineResult.pipelineId,
      market: market.market,
      currentPrice: market.analysis?.currentPrice ?? 0,
      timestamp: new Date().toISOString(),
      indicators: extractIndicators(market),
      sentiment: extractSentiment(pipelineResult.screening.marketAnalysis),
      portfolio: extractPortfolio(market),
      aiJudgment: extractAIJudgment(market),
      riskCheck: extractRiskCheck(market),
      execution: extractExecution(market),
      stageDurations: extractStageDurations(market),
      totalDurationMs,
    };

    decisions.push(log);
  }

  return {
    pipelineId: pipelineResult.pipelineId,
    startedAt: pipelineResult.startedAt,
    endedAt: pipelineResult.endedAt,
    durationMs: pipelineResult.durationMs,
    marketCount: pipelineResult.markets.length,
    executedCount: pipelineResult.executedCount,
    decisions,
    error: pipelineResult.error,
  };
}

// ──────────────────────────────────────────────
// JSON 파일 저장
// ──────────────────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 판단 로그를 JSON 파일로 저장 */
export function saveDecisionLog(log: PipelineDecisionLog): void {
  const date = log.startedAt.slice(0, 10);
  const dir = path.join(DATA_DIR, date);
  ensureDir(dir);

  const filepath = path.join(dir, `${log.pipelineId}.json`);
  fs.writeFileSync(filepath, JSON.stringify(log, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// 콘솔 출력
// ──────────────────────────────────────────────

function fmtNum(n: number | null, decimals = 2): string {
  if (n === null) return 'N/A';
  return n.toLocaleString('ko-KR', { maximumFractionDigits: decimals });
}

function actionEmoji(action: string): string {
  if (action === 'buy') return '[매수]';
  if (action === 'sell') return '[매도]';
  return '[관망]';
}

/** 종목별 판단 로그를 콘솔에 출력 */
function printDecisionToConsole(d: DecisionLog): void {
  const ind = d.indicators;
  const ai = d.aiJudgment;
  const exec = d.execution;

  const lines: string[] = [
    '',
    `┌─── ${d.market} ${actionEmoji(ai.action)} ───────────────────────────`,
    `│ 현재가: ${fmtNum(d.currentPrice, 0)}원  |  엔진: ${ai.engine}  |  ${d.totalDurationMs}ms`,
    `│`,
    `│ [지표]`,
    `│   RSI: ${fmtNum(ind.rsi, 1)} (${ind.rsiTrend})`,
    `│   MACD: ${fmtNum(ind.macdHistogram, 4)} (${ind.macdCross})`,
    `│   볼린저 %B: ${fmtNum(ind.bollingerPercentB, 3)}  밴드폭: ${fmtNum(ind.bollingerBandwidth, 4)}`,
    `│   이평선: MA5=${fmtNum(ind.ma5, 0)} MA20=${fmtNum(ind.ma20, 0)} MA60=${fmtNum(ind.ma60, 0)} (${ind.maAlignment})`,
    `│   거래량: ${fmtNum(ind.volumeRatio)}배 ${ind.volumeSurge ? '(서지)' : ''}  OBV: ${ind.obvTrend}`,
    `│`,
    `│ [심리] 공포/탐욕 ${d.sentiment.fearGreedScore}점(${d.sentiment.fearGreedLabel})  BTC 도미넌스 ${d.sentiment.btcDominance}%`,
    `│`,
    `│ [AI 판단]`,
    `│   결정: ${ai.action.toUpperCase()}  신뢰도: ${ai.confidence}%  점수: ${ai.compositeScore}`,
    `│   비율: ${(ai.suggestedSizeRate * 100).toFixed(0)}%  손절: ${fmtNum(ai.suggestedStopLoss, 0)}  익절: ${fmtNum(ai.suggestedTakeProfit, 0)}`,
    `│   근거: ${ai.reasoning}`,
  ];

  if (ai.keySignals.length > 0) {
    lines.push(`│   시그널:`);
    for (const sig of ai.keySignals) {
      const dir = sig.direction === 'bullish' ? '+' : sig.direction === 'bearish' ? '-' : '=';
      lines.push(`│     ${dir} ${sig.name} (${sig.importance}/5): ${sig.description}`);
    }
  }

  lines.push(`│`);

  if (exec.executed && exec.success) {
    lines.push(`│ [실행] ${exec.action.toUpperCase()} 체결: ${fmtNum(exec.executedPrice!, 0)}원 × ${fmtNum(exec.amount!, 0)}원 (수수료 ${fmtNum(exec.fee!, 0)}원)`);
  } else if (exec.skipReason) {
    lines.push(`│ [실행] 스킵 — ${exec.skipReason}`);
  } else {
    lines.push(`│ [실행] 미실행`);
  }

  lines.push(`└──────────────────────────────────────────────`);

  console.log(lines.join('\n'));
}

/** 파이프라인 판단 로그를 콘솔에 출력 */
export function printPipelineLogToConsole(log: PipelineDecisionLog): void {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[판단 로그] 파이프라인 ${log.pipelineId}`);
  console.log(`  시작: ${log.startedAt.slice(11, 19)}  종료: ${log.endedAt.slice(11, 19)}  소요: ${log.durationMs}ms`);
  console.log(`  분석: ${log.marketCount}종목  실행: ${log.executedCount}건`);

  if (log.error) {
    console.log(`  에러: ${log.error}`);
  }

  for (const d of log.decisions) {
    printDecisionToConsole(d);
  }

  console.log(`${'='.repeat(50)}\n`);
}

// ──────────────────────────────────────────────
// 조회 API
// ──────────────────────────────────────────────

/** 특정 날짜의 판단 로그 목록 조회 */
export function getDecisionLogsByDate(date: string): PipelineDecisionLog[] {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const logs: PipelineDecisionLog[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      logs.push(JSON.parse(raw) as PipelineDecisionLog);
    } catch {
      // 손상된 파일 무시
    }
  }

  return logs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 개별 판단 로그 조회 (모든 파이프라인의 decisions를 flat으로) */
export function getDecisionLogs(filter?: DecisionLogFilter): DecisionLog[] {
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const pipelineLogs = getDecisionLogsByDate(date);

  let decisions = pipelineLogs.flatMap((p) => p.decisions);

  if (filter?.market) {
    decisions = decisions.filter((d) => d.market === filter.market);
  }
  if (filter?.action) {
    decisions = decisions.filter((d) => d.aiJudgment.action === filter.action);
  }
  if (filter?.engine) {
    decisions = decisions.filter((d) => d.aiJudgment.engine === filter.engine);
  }
  if (filter?.executedOnly) {
    decisions = decisions.filter((d) => d.execution.executed && d.execution.success);
  }

  decisions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const limit = filter?.limit ?? 100;
  return decisions.slice(0, limit);
}

/** 특정 파이프라인 판단 로그 조회 */
export function getDecisionLogByPipelineId(pipelineId: string): PipelineDecisionLog | null {
  if (!fs.existsSync(DATA_DIR)) return null;

  const dateDirs = fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));

  for (const dateDir of dateDirs) {
    const filepath = path.join(DATA_DIR, dateDir, `${pipelineId}.json`);
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(raw) as PipelineDecisionLog;
    }
  }

  return null;
}

/** 날짜별 요약 통계 */
export function getDecisionLogSummary(date?: string): DecisionLogDailySummary {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const decisions = getDecisionLogs({ date: targetDate, limit: 10000 });

  const byAction: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  let totalConfidence = 0;
  let totalLatency = 0;
  let executedCount = 0;

  for (const d of decisions) {
    const action = d.aiJudgment.action;
    const engine = d.aiJudgment.engine;
    byAction[action] = (byAction[action] || 0) + 1;
    byEngine[engine] = (byEngine[engine] || 0) + 1;
    totalConfidence += d.aiJudgment.confidence;
    totalLatency += d.aiJudgment.latencyMs;
    if (d.execution.executed && d.execution.success) executedCount++;
  }

  return {
    date: targetDate,
    totalDecisions: decisions.length,
    byAction,
    byEngine,
    executedCount,
    avgConfidence: decisions.length > 0 ? Math.round(totalConfidence / decisions.length) : 0,
    avgLatencyMs: decisions.length > 0 ? Math.round(totalLatency / decisions.length) : 0,
  };
}

/** 사용 가능한 로그 날짜 목록 */
export function getAvailableDecisionLogDates(): string[] {
  ensureDir(DATA_DIR);
  return fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));
}
