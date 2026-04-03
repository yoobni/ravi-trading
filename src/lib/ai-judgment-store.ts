/**
 * AI 판단 로그 저장소
 *
 * 판단 근거를 구조화된 JSON 파일로 저장.
 * 날짜별 디렉토리에 개별 파일로 기록하여 추적 가능.
 */

import fs from 'fs';
import path from 'path';
import type { AIJudgmentLog } from '@/types/ai-judgment';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'ai-judgments');

// ─── 저장 ────────────────────────────────────────────────────

/** 판단 로그 저장 (날짜별 디렉토리) */
export function saveJudgmentLog(log: AIJudgmentLog): void {
  const dateDir = log.timestamp.slice(0, 10); // YYYY-MM-DD
  const dir = path.join(DATA_DIR, dateDir);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${log.id}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(log, null, 2), 'utf-8');
}

// ─── 조회 ────────────────────────────────────────────────────

/** 특정 날짜의 판단 로그 목록 (최신순) */
export function getLogsByDate(date: string): AIJudgmentLog[] {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const logs: AIJudgmentLog[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    logs.push(JSON.parse(raw) as AIJudgmentLog);
  }

  return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** 특정 마켓의 최근 판단 로그 (날짜 역순, 최대 limit개) */
export function getLogsByMarket(market: string, limit = 20): AIJudgmentLog[] {
  const results: AIJudgmentLog[] = [];
  if (!fs.existsSync(DATA_DIR)) return results;

  const dateDirs = fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a)); // 최신순

  for (const dateDir of dateDirs) {
    if (results.length >= limit) break;

    const dir = path.join(DATA_DIR, dateDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      if (results.length >= limit) break;

      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const log = JSON.parse(raw) as AIJudgmentLog;
      if (log.market === market) {
        results.push(log);
      }
    }
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** 오늘의 판단 요약 통계 */
export function getTodayJudgmentStats(): {
  total: number;
  byEngine: Record<string, number>;
  byAction: Record<string, number>;
  avgConfidence: number;
  avgLatencyMs: number;
  totalTokens: { input: number; output: number };
} {
  const today = new Date().toISOString().slice(0, 10);
  const logs = getLogsByDate(today);

  const byEngine: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let totalConfidence = 0;
  let totalLatency = 0;
  const totalTokens = { input: 0, output: 0 };

  for (const log of logs) {
    byEngine[log.engine] = (byEngine[log.engine] || 0) + 1;
    byAction[log.decision.action] = (byAction[log.decision.action] || 0) + 1;
    totalConfidence += log.decision.confidence;
    totalLatency += log.latencyMs;
    if (log.tokenUsage) {
      totalTokens.input += log.tokenUsage.input;
      totalTokens.output += log.tokenUsage.output;
    }
  }

  return {
    total: logs.length,
    byEngine,
    byAction,
    avgConfidence: logs.length > 0 ? Math.round(totalConfidence / logs.length) : 0,
    avgLatencyMs: logs.length > 0 ? Math.round(totalLatency / logs.length) : 0,
    totalTokens,
  };
}

/** 특정 로그 조회 */
export function getLogById(id: string): AIJudgmentLog | null {
  if (!fs.existsSync(DATA_DIR)) return null;

  const dateDirs = fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));

  for (const dateDir of dateDirs) {
    const filepath = path.join(DATA_DIR, dateDir, `${id}.json`);
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(raw) as AIJudgmentLog;
    }
  }

  return null;
}
