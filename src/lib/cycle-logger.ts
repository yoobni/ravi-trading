import fs from 'fs';
import path from 'path';
import type { CycleLog } from '@/types/scheduler';

// ──────────────────────────────────────────────
// 사이클 로그 저장소
// ──────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LOGS_DIR = path.join(DATA_DIR, 'cycle-logs');

/** 날짜별 로그 파일 경로 (YYYY-MM-DD.json) */
function logFilePath(date: string): string {
  return path.join(LOGS_DIR, `${date}.json`);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/** 날짜별 로그 로드 */
function loadLogs(date: string): CycleLog[] {
  const filePath = logFilePath(date);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as CycleLog[];
}

/** 날짜별 로그 저장 */
function saveLogs(date: string, logs: CycleLog[]): void {
  ensureDir();
  fs.writeFileSync(logFilePath(date), JSON.stringify(logs, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// 공개 API
// ──────────────────────────────────────────────

/** 사이클 로그 추가 */
export function appendCycleLog(log: CycleLog): void {
  const date = log.startedAt.slice(0, 10);
  const logs = loadLogs(date);
  logs.push(log);
  saveLogs(date, logs);
}

/** 오늘 사이클 로그 조회 */
export function getTodayCycleLogs(): CycleLog[] {
  return loadLogs(todayStr());
}

/** 특정 날짜 사이클 로그 조회 */
export function getCycleLogs(date: string): CycleLog[] {
  return loadLogs(date);
}

/** 최근 N개 사이클 로그 조회 (오늘 기준) */
export function getRecentCycleLogs(count: number): CycleLog[] {
  const logs = loadLogs(todayStr());
  return logs.slice(-count);
}

/** 오늘 사이클 통계 요약 */
export function getTodayCycleSummary(): {
  totalCycles: number;
  successCycles: number;
  errorCycles: number;
  totalExecutions: number;
  buyCount: number;
  sellCount: number;
} {
  const logs = loadLogs(todayStr());

  let totalExecutions = 0;
  let buyCount = 0;
  let sellCount = 0;
  let errorCycles = 0;

  for (const log of logs) {
    if (log.error) {
      errorCycles++;
      continue;
    }
    for (const r of log.results) {
      if (r.execution && r.execution.success) {
        totalExecutions++;
        if (r.execution.action === 'buy') buyCount++;
        else sellCount++;
      }
    }
  }

  return {
    totalCycles: logs.length,
    successCycles: logs.length - errorCycles,
    errorCycles,
    totalExecutions,
    buyCount,
    sellCount,
  };
}

/** 사용 가능한 로그 날짜 목록 조회 */
export function getAvailableLogDates(): string[] {
  ensureDir();
  return fs.readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort()
    .reverse();
}
