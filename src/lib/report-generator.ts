/**
 * 거래 내역 리포트 생성기
 *
 * 일별/주별 거래 리포트를 JSON 또는 CSV로 생성.
 * 각 거래의 진입/청산 가격, 수익률, AI 판단 근거 요약 포함.
 */

import fs from 'fs';
import path from 'path';
import type { Order } from '@/types/order';
import type {
  ReportOptions,
  TradeReport,
  TradeReportEntry,
  PeriodSummary,
} from '@/types/report';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// ──────────────────────────────────────────────
// 내부 유틸
// ──────────────────────────────────────────────

function loadOrders(): Order[] {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
  return JSON.parse(raw) as Order[];
}

/** ISO 문자열에서 YYYY-MM-DD 추출 */
function toDateStr(iso: string): string {
  return iso.slice(0, 10);
}

/** 날짜의 ISO 주차 라벨 (YYYY-Www) */
function toWeekLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay() || 7; // 일요일=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // 목요일 기준
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** 주차의 월요일~일요일 범위 */
function getWeekRange(weekLabel: string): { start: string; end: string } {
  const [yearStr, weekStr] = weekLabel.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);

  // ISO 8601: 해당 연도 1월 4일이 속한 주가 W01
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

/** 청산 완료 거래 쌍 추출 */
interface ClosedPair {
  buy: Order;
  sell: Order;
}

function getClosedPairs(orders: Order[]): ClosedPair[] {
  const orderMap = new Map<string, Order>();
  for (const o of orders) orderMap.set(o.id, o);

  const pairs: ClosedPair[] = [];
  for (const sell of orders) {
    if (sell.side !== 'sell' || sell.status !== 'filled' || !sell.linkedOrderId) continue;
    const buy = orderMap.get(sell.linkedOrderId);
    if (!buy || buy.side !== 'buy' || buy.status !== 'filled') continue;
    pairs.push({ buy, sell });
  }

  // 매도 시각 기준 오름차순
  pairs.sort((a, b) => {
    const tA = new Date(a.sell.filledAt ?? a.sell.createdAt).getTime();
    const tB = new Date(b.sell.filledAt ?? b.sell.createdAt).getTime();
    return tA - tB;
  });

  return pairs;
}

// ──────────────────────────────────────────────
// 리포트 생성
// ──────────────────────────────────────────────

/** 거래 리포트 생성 */
export function generateReport(options: ReportOptions): TradeReport {
  const orders = loadOrders();
  let pairs = getClosedPairs(orders);

  // 날짜 범위 필터
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = options.fromDate ?? '2000-01-01';
  const toDate = options.toDate ?? today;

  pairs = pairs.filter((p) => {
    const d = toDateStr(p.sell.filledAt ?? p.sell.createdAt);
    return d >= fromDate && d <= toDate;
  });

  // 종목 필터
  if (options.market) {
    pairs = pairs.filter((p) => p.buy.market === options.market);
  }

  // 개별 거래 항목 변환
  const trades: TradeReportEntry[] = pairs.map((p, i) => {
    const entryTime = p.buy.filledAt ?? p.buy.createdAt;
    const exitTime = p.sell.filledAt ?? p.sell.createdAt;
    const holdingMs = Math.max(new Date(exitTime).getTime() - new Date(entryTime).getTime(), 0);
    const pnl = p.sell.totalAmount - p.buy.totalAmount;
    const profitRate = p.sell.profitRate ?? (
      p.buy.price > 0
        ? Math.round(((p.sell.price - p.buy.price) / p.buy.price) * 100 * 100) / 100
        : 0
    );

    return {
      no: i + 1,
      market: p.buy.market,
      buyOrderId: p.buy.id,
      sellOrderId: p.sell.id,
      entryPrice: p.buy.price,
      exitPrice: p.sell.price,
      volume: p.buy.volume,
      investedAmount: p.buy.totalAmount,
      exitAmount: p.sell.totalAmount,
      realizedPnl: Math.round(pnl),
      profitRate,
      result: profitRate > 0 ? 'win' : profitRate < 0 ? 'loss' : 'even',
      entryTime,
      exitTime,
      holdingMinutes: Math.round(holdingMs / 60000),
      entryReasoning: p.buy.reasoning,
      exitReasoning: p.sell.reasoning,
    };
  });

  // 기간별 그룹핑
  const groupKey = options.period === 'daily' ? toDateStr : (iso: string) => toWeekLabel(toDateStr(iso));
  const grouped = new Map<string, TradeReportEntry[]>();

  for (const t of trades) {
    const key = groupKey(t.exitTime);
    const arr = grouped.get(key) ?? [];
    arr.push(t);
    grouped.set(key, arr);
  }

  // 기간별 집계
  const periodSummaries: PeriodSummary[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, items]) => {
      const wins = items.filter((t) => t.result === 'win');
      const totalPnl = items.reduce((s, t) => s + t.realizedPnl, 0);
      const avgProfit = items.length > 0
        ? Math.round((items.reduce((s, t) => s + t.profitRate, 0) / items.length) * 100) / 100
        : 0;
      const profits = items.map((t) => t.profitRate);

      let startDate: string;
      let endDate: string;
      if (options.period === 'weekly') {
        const range = getWeekRange(label);
        startDate = range.start;
        endDate = range.end;
      } else {
        startDate = label;
        endDate = label;
      }

      return {
        periodLabel: label,
        startDate,
        endDate,
        tradeCount: items.length,
        winCount: wins.length,
        lossCount: items.length - wins.length,
        winRate: items.length > 0 ? Math.round((wins.length / items.length) * 100 * 100) / 100 : 0,
        totalPnl: Math.round(totalPnl),
        avgProfitRate: avgProfit,
        bestProfitRate: profits.length > 0 ? Math.max(...profits) : 0,
        worstProfitRate: profits.length > 0 ? Math.min(...profits) : 0,
      };
    });

  // 전체 요약
  const allWins = trades.filter((t) => t.result === 'win');
  const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  const avgProfit = trades.length > 0
    ? Math.round((trades.reduce((s, t) => s + t.profitRate, 0) / trades.length) * 100) / 100
    : 0;
  const avgHolding = trades.length > 0
    ? Math.round(trades.reduce((s, t) => s + t.holdingMinutes, 0) / trades.length)
    : 0;

  const report: TradeReport = {
    generatedAt: new Date().toISOString(),
    period: options.period,
    fromDate,
    toDate,
    marketFilter: options.market ?? null,
    periodSummaries,
    trades: [...trades].reverse(), // 최신순
    totalSummary: {
      tradeCount: trades.length,
      winCount: allWins.length,
      lossCount: trades.length - allWins.length,
      winRate: trades.length > 0 ? Math.round((allWins.length / trades.length) * 100 * 100) / 100 : 0,
      totalPnl: Math.round(totalPnl),
      avgProfitRate: avgProfit,
      avgHoldingMinutes: avgHolding,
    },
  };

  return report;
}

// ──────────────────────────────────────────────
// CSV 변환
// ──────────────────────────────────────────────

/** CSV 셀 이스케이프 */
function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 리포트를 CSV 문자열로 변환 */
export function reportToCsv(report: TradeReport): string {
  const BOM = '\uFEFF'; // 한글 엑셀 호환 BOM
  const headers = [
    'No',
    '종목',
    '진입가격(KRW)',
    '청산가격(KRW)',
    '수량',
    '투자금액(KRW)',
    '청산금액(KRW)',
    '실현손익(KRW)',
    '수익률(%)',
    '결과',
    '매수시각',
    '매도시각',
    '보유시간(분)',
    '매수근거',
    '매도근거',
  ];

  const rows = report.trades.map((t) => [
    String(t.no),
    t.market,
    String(t.entryPrice),
    String(t.exitPrice),
    String(t.volume),
    String(t.investedAmount),
    String(t.exitAmount),
    String(t.realizedPnl),
    String(t.profitRate),
    t.result === 'win' ? '수익' : t.result === 'loss' ? '손실' : '보합',
    t.entryTime,
    t.exitTime,
    String(t.holdingMinutes),
    escapeCsv(t.entryReasoning),
    escapeCsv(t.exitReasoning),
  ]);

  // 기간 요약 섹션
  const summaryHeaders = [
    '기간',
    '시작일',
    '종료일',
    '거래수',
    '승리',
    '패배',
    '승률(%)',
    '총손익(KRW)',
    '평균수익률(%)',
    '최고수익률(%)',
    '최저수익률(%)',
  ];

  const summaryRows = report.periodSummaries.map((s) => [
    s.periodLabel,
    s.startDate,
    s.endDate,
    String(s.tradeCount),
    String(s.winCount),
    String(s.lossCount),
    String(s.winRate),
    String(s.totalPnl),
    String(s.avgProfitRate),
    String(s.bestProfitRate),
    String(s.worstProfitRate),
  ]);

  const lines: string[] = [];

  // 메타 정보
  lines.push(`리포트 생성시각,${report.generatedAt}`);
  lines.push(`기간단위,${report.period === 'daily' ? '일별' : '주별'}`);
  lines.push(`조회범위,${report.fromDate} ~ ${report.toDate}`);
  lines.push(`종목필터,${report.marketFilter ?? '전체'}`);
  lines.push(`총거래수,${report.totalSummary.tradeCount}`);
  lines.push(`승률,${report.totalSummary.winRate}%`);
  lines.push(`총손익,${report.totalSummary.totalPnl} KRW`);
  lines.push('');

  // 기간별 요약
  lines.push('[기간별 요약]');
  lines.push(summaryHeaders.join(','));
  for (const row of summaryRows) lines.push(row.join(','));
  lines.push('');

  // 개별 거래 내역
  lines.push('[거래 내역]');
  lines.push(headers.join(','));
  for (const row of rows) lines.push(row.join(','));

  return BOM + lines.join('\n');
}

// ──────────────────────────────────────────────
// 파일 저장
// ──────────────────────────────────────────────

/** 리포트를 파일로 저장하고 경로 반환 */
export function saveReportToFile(report: TradeReport, format: 'json' | 'csv'): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const periodLabel = report.period === 'daily' ? 'daily' : 'weekly';
  const filename = `report_${periodLabel}_${timestamp}.${format}`;
  const filepath = path.join(REPORTS_DIR, filename);

  if (format === 'csv') {
    fs.writeFileSync(filepath, reportToCsv(report), 'utf-8');
  } else {
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
  }

  return filepath;
}

/** 저장된 리포트 파일 목록 (최신순) */
export function listReportFiles(): { filename: string; createdAt: string; size: number }[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];

  return fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith('report_') && (f.endsWith('.json') || f.endsWith('.csv')))
    .map((f) => {
      const stat = fs.statSync(path.join(REPORTS_DIR, f));
      return { filename: f, createdAt: stat.mtime.toISOString(), size: stat.size };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
