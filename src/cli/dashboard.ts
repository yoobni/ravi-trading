#!/usr/bin/env tsx
// ──────────────────────────────────────────────
// CLI 실시간 대시보드
// 터미널에서 매매 현황을 한눈에 확인
// ──────────────────────────────────────────────

import { getPerformanceSummary, getDailyStats, getMarketStats } from '@/lib/dashboard-stats';
import { getOpenPositions, listOrders } from '@/lib/order-store';
import { getBalanceState, getPortfolioSnapshot } from '@/lib/balance-tracker';
import { getSchedulerStatus, getSchedulerConfig } from '@/lib/scheduler';
import { getRecentCycleLogs, getTodayCycleSummary } from '@/lib/cycle-logger';
import type { Order } from '@/types/order';

// ──────────────────────────────────────────────
// ANSI 색상
// ──────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',
};

// ──────────────────────────────────────────────
// 포맷 유틸
// ──────────────────────────────────────────────

function krw(n: number): string {
  return n.toLocaleString('ko-KR') + '원';
}

function pct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function colorPct(n: number): string {
  const str = pct(n);
  if (n > 0) return `${c.green}${str}${c.reset}`;
  if (n < 0) return `${c.red}${str}${c.reset}`;
  return `${c.dim}${str}${c.reset}`;
}

function colorKrw(n: number): string {
  const str = (n > 0 ? '+' : '') + krw(n);
  if (n > 0) return `${c.green}${str}${c.reset}`;
  if (n < 0) return `${c.red}${str}${c.reset}`;
  return `${c.dim}${str}${c.reset}`;
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 ${min % 60}분 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

function timeUntil(isoStr: string): string {
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff <= 0) return '곧 실행';
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return `${min}분 ${remainSec}초 후`;
}

function pad(str: string, len: number): string {
  // ANSI escape 코드를 제외한 실제 문자 길이 기준
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = len - stripped.length;
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function padLeft(str: string, len: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = len - stripped.length;
  return diff > 0 ? ' '.repeat(diff) + str : str;
}

function line(char = '─', len = 60): string {
  return char.repeat(len);
}

function header(title: string): string {
  return `\n${c.bgBlue}${c.white}${c.bold} ${title} ${c.reset}`;
}

// ──────────────────────────────────────────────
// 대시보드 렌더링
// ──────────────────────────────────────────────

function renderDashboard(): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // ── 타이틀 ──
  lines.push('');
  lines.push(`${c.bold}${c.cyan}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  lines.push(`${c.bold}${c.cyan}║      📊 업비트 자동매매 대시보드                        ║${c.reset}`);
  lines.push(`${c.bold}${c.cyan}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  lines.push(`${c.dim}  갱신: ${now}${c.reset}`);

  // ── 스케줄러 상태 ──
  const schedulerStatus = getSchedulerStatus();
  const schedulerConfig = getSchedulerConfig();
  lines.push(header('스케줄러'));

  const statusLabel = schedulerStatus.running
    ? `${c.green}● 실행 중${c.reset}`
    : `${c.red}● 중지${c.reset}`;
  const intervalMin = schedulerConfig.intervalMs / 60000;

  lines.push(`  상태: ${statusLabel}  │  주기: ${intervalMin}분  │  총 사이클: ${schedulerStatus.totalCycles}`);

  if (schedulerStatus.lastCycleAt) {
    lines.push(`  마지막 실행: ${timeAgo(schedulerStatus.lastCycleAt)}`);
  }
  if (schedulerStatus.nextCycleAt && schedulerStatus.running) {
    lines.push(`  ${c.yellow}▶ 다음 분석: ${timeUntil(schedulerStatus.nextCycleAt)}${c.reset}`);
  }
  if (schedulerStatus.consecutiveErrors > 0) {
    lines.push(`  ${c.red}⚠ 연속 에러: ${schedulerStatus.consecutiveErrors}회${c.reset}`);
  }

  // ── 자산 현황 ──
  const balance = getBalanceState();
  const summary = getPerformanceSummary();
  lines.push(header('자산 현황'));

  lines.push(`  초기 자본:  ${c.bold}${krw(summary.initialCapital)}${c.reset}`);
  lines.push(`  현재 자산:  ${c.bold}${krw(summary.currentAssets)}${c.reset}  (${colorPct(summary.totalReturnRate)})`);
  lines.push(`  가용 KRW:   ${krw(balance.availableKrw)}`);
  lines.push(`  실현 손익:  ${colorKrw(summary.totalRealizedPnl)}`);
  lines.push(`  미실현 손익: ${colorKrw(summary.totalUnrealizedPnl)}`);

  // ── 성과 지표 ──
  lines.push(header('성과 지표'));

  const winRateColor = summary.winRate >= 50 ? c.green : summary.winRate >= 40 ? c.yellow : c.red;
  lines.push(`  승률:     ${winRateColor}${summary.winRate.toFixed(1)}%${c.reset} (${summary.winCount}승 ${summary.lossCount}패 / ${summary.closedTradeCount}건)`);
  lines.push(`  평균 수익: ${colorPct(summary.avgReturnRate)}  │  평균 이익: ${colorPct(summary.avgWinRate)}  │  평균 손실: ${colorPct(summary.avgLossRate)}`);

  if (summary.profitLossRatio !== null) {
    const plColor = summary.profitLossRatio >= 1 ? c.green : c.red;
    lines.push(`  손익비:   ${plColor}${summary.profitLossRatio.toFixed(2)}${c.reset}`);
  }
  if (summary.sharpeRatio !== null) {
    const srColor = summary.sharpeRatio >= 1 ? c.green : summary.sharpeRatio >= 0 ? c.yellow : c.red;
    lines.push(`  샤프비율: ${srColor}${summary.sharpeRatio.toFixed(2)}${c.reset}`);
  }
  lines.push(`  MDD:      ${c.red}${summary.maxDrawdown.toFixed(2)}%${c.reset}`);

  // ── 보유 포지션 ──
  const positions = getOpenPositions();
  lines.push(header(`보유 포지션 (${positions.length}건)`));

  if (positions.length === 0) {
    lines.push(`  ${c.dim}보유 중인 포지션 없음${c.reset}`);
  } else {
    lines.push(`  ${c.dim}${pad('종목', 12)} ${padLeft('매수가', 14)} ${padLeft('수량', 12)} ${padLeft('매수금액', 14)} ${padLeft('매수시각', 14)}${c.reset}`);
    lines.push(`  ${c.dim}${line('─', 66)}${c.reset}`);

    for (const pos of positions) {
      const market = pad(pos.market, 12);
      const price = padLeft(pos.price.toLocaleString('ko-KR'), 14);
      const volume = padLeft(pos.volume.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''), 12);
      const amount = padLeft(krw(pos.totalAmount), 14);
      const time = padLeft(timeAgo(pos.createdAt), 14);
      lines.push(`  ${market} ${price} ${volume} ${amount} ${time}`);
    }
  }

  // ── 최근 거래 내역 ──
  const recentOrders = listOrders({ limit: 10 });
  lines.push(header('최근 거래 (최대 10건)'));

  if (recentOrders.length === 0) {
    lines.push(`  ${c.dim}거래 내역 없음${c.reset}`);
  } else {
    lines.push(`  ${c.dim}${pad('종목', 12)} ${pad('방향', 6)} ${padLeft('가격', 14)} ${padLeft('금액', 14)} ${padLeft('수익률', 10)} ${padLeft('시각', 14)}${c.reset}`);
    lines.push(`  ${c.dim}${line('─', 70)}${c.reset}`);

    for (const order of recentOrders) {
      const market = pad(order.market, 12);
      const side = order.side === 'buy'
        ? `${c.green}${pad('매수', 6)}${c.reset}`
        : `${c.red}${pad('매도', 6)}${c.reset}`;
      const price = padLeft(order.price.toLocaleString('ko-KR'), 14);
      const amount = padLeft(krw(order.totalAmount), 14);
      const profit = order.profitRate !== null
        ? padLeft(colorPct(order.profitRate), 10)
        : padLeft(`${c.dim}-${c.reset}`, 10);
      const time = padLeft(timeAgo(order.filledAt ?? order.createdAt), 14);
      lines.push(`  ${market} ${side} ${price} ${amount} ${profit} ${time}`);
    }
  }

  // ── 종목별 통계 ──
  const marketStats = getMarketStats();
  if (marketStats.length > 0) {
    lines.push(header('종목별 성과'));
    lines.push(`  ${c.dim}${pad('종목', 12)} ${padLeft('거래', 6)} ${padLeft('승률', 8)} ${padLeft('총 손익', 14)} ${padLeft('평균수익', 10)} ${padLeft('최고', 8)} ${padLeft('최저', 8)}${c.reset}`);
    lines.push(`  ${c.dim}${line('─', 66)}${c.reset}`);

    for (const ms of marketStats.slice(0, 8)) {
      const market = pad(ms.market, 12);
      const trades = padLeft(String(ms.tradeCount), 6);
      const winRate = padLeft(`${ms.winRate.toFixed(0)}%`, 8);
      const totalPnl = padLeft(colorKrw(ms.totalPnl), 14);
      const avgRet = padLeft(colorPct(ms.avgReturnRate), 10);
      const best = padLeft(colorPct(ms.bestReturn), 8);
      const worst = padLeft(colorPct(ms.worstReturn), 8);
      lines.push(`  ${market} ${trades} ${winRate} ${totalPnl} ${avgRet} ${best} ${worst}`);
    }
  }

  // ── 오늘 사이클 요약 ──
  const cycleSummary = getTodayCycleSummary();
  if (cycleSummary.totalCycles > 0) {
    lines.push(header('오늘 사이클 요약'));
    lines.push(`  총 사이클: ${cycleSummary.totalCycles} (성공 ${cycleSummary.successCycles} / 에러 ${cycleSummary.errorCycles})`);
    lines.push(`  실행: 매수 ${c.green}${cycleSummary.buyCount}${c.reset}건, 매도 ${c.red}${cycleSummary.sellCount}${c.reset}건 (총 ${cycleSummary.totalExecutions}건)`);
  }

  // ── 최근 사이클 로그 ──
  const recentLogs = getRecentCycleLogs(3);
  if (recentLogs.length > 0) {
    lines.push(header('최근 사이클 로그'));
    for (const log of recentLogs.reverse()) {
      const status = log.error
        ? `${c.red}✗${c.reset}`
        : `${c.green}✓${c.reset}`;
      const duration = `${(log.durationMs / 1000).toFixed(1)}s`;
      const time = timeAgo(log.startedAt);
      lines.push(`  ${status} [${log.cycleId}] ${time} (${duration}) 실행 ${log.executedCount}건${log.error ? ` — ${c.red}${log.error}${c.reset}` : ''}`);
    }
  }

  // ── 푸터 ──
  lines.push('');
  lines.push(`${c.dim}  Ctrl+C 종료  │  갱신 주기: 5초${c.reset}`);
  lines.push('');

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// 실행 모드
// ──────────────────────────────────────────────

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');

if (isWatch) {
  // 실시간 갱신 모드
  const REFRESH_INTERVAL = 5000;

  function refresh(): void {
    // 화면 클리어
    process.stdout.write('\x1b[2J\x1b[H');
    try {
      process.stdout.write(renderDashboard());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${c.red}대시보드 렌더링 에러: ${msg}${c.reset}`);
    }
  }

  refresh();
  const timer = setInterval(refresh, REFRESH_INTERVAL);

  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\x1b[?25h'); // 커서 복원
    console.log(`\n${c.dim}대시보드 종료${c.reset}`);
    process.exit(0);
  });
} else {
  // 1회 출력 모드
  try {
    console.log(renderDashboard());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}대시보드 에러: ${msg}${c.reset}`);
    process.exit(1);
  }
}
