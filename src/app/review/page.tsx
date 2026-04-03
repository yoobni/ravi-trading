'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// ──────────────────────────────────────────────
// 타입
// ──────────────────────────────────────────────

interface MemorySnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

interface CycleDecision {
  market: string;
  action: 'buy' | 'sell' | 'hold';
  confidence: number;
  compositeScore: number;
  reasoning: string;
  executed: boolean;
  executedPrice: number | null;
  executedAmount: number | null;
}

interface CycleRecord {
  cycleNumber: number;
  cycleId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  intervalFromPreviousMs: number | null;
  selectedMarkets: string[];
  decisions: CycleDecision[];
  portfolio: {
    cash: number;
    positionValue: number;
    totalEquity: number;
    returnRate: number;
    positionCount: number;
    realizedPnl: number;
    feesPaid: number;
  };
  memory: MemorySnapshot;
  apiCalls: { total: number; byType: Record<string, number> };
  error: string | null;
}

interface TestResult {
  testName: string;
  testId: string;
  startedAt: string;
  endedAt: string | null;
  totalDurationMs: number | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  config: {
    targetCycles: number;
    cycleIntervalMs: number;
    initialCapital: number;
    targetMarketCount: number;
    candleUnit: number;
    candleCount: number;
  };
  cycles: CycleRecord[];
  summary: {
    totalCycles: number;
    successCycles: number;
    errorCycles: number;
    completionRate: number;
    avgCycleDurationMs: number;
    maxCycleDurationMs: number;
    minCycleDurationMs: number;
    avgIntervalMs: number | null;
    intervalDriftPct: number | null;
  } | null;
  performance: {
    finalEquity: number;
    returnRate: number;
    realizedPnl: number;
    feesPaid: number;
    totalBuys: number;
    totalSells: number;
    winCount: number;
    lossCount: number;
    winRate: number;
  } | null;
  stability: {
    memoryGrowthMB: number;
    avgApiCallsPerCycle: number;
    maxApiCallsPerCycle: number;
    errorRate: number;
    passedCriteria: Record<string, boolean>;
    overallPass: boolean;
  } | null;
  errors: { cycleNumber: number; time: string; message: string }[];
}

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function pct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-emerald-600';
  if (n < 0) return 'text-rose-600';
  return 'text-zinc-500';
}

function ms(n: number): string {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function timeOnly(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function actionLabel(action: string): { label: string; cls: string } {
  switch (action) {
    case 'buy': return { label: '매수', cls: 'bg-emerald-100 text-emerald-700' };
    case 'sell': return { label: '매도', cls: 'bg-rose-100 text-rose-700' };
    default: return { label: '관망', cls: 'bg-zinc-100 text-zinc-500' };
  }
}

function statusBadge(status: TestResult['status']): { label: string; cls: string } {
  switch (status) {
    case 'running': return { label: '실행 중', cls: 'bg-blue-100 text-blue-700 animate-pulse' };
    case 'completed': return { label: '완료', cls: 'bg-emerald-100 text-emerald-700' };
    case 'failed': return { label: '실패', cls: 'bg-rose-100 text-rose-700' };
    case 'interrupted': return { label: '중단됨', cls: 'bg-amber-100 text-amber-700' };
    default: return { label: status, cls: 'bg-zinc-100 text-zinc-600' };
  }
}

// ──────────────────────────────────────────────
// 컴포넌트
// ──────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color ?? 'text-zinc-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

function PassFailBadge({ pass }: { pass: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${pass ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
      {pass ? '✓ PASS' : '✗ FAIL'}
    </span>
  );
}

function OverallBadge({ pass }: { pass: boolean }) {
  return (
    <div className={`rounded-xl border-2 p-4 text-center ${pass ? 'border-emerald-300 bg-emerald-50' : 'border-rose-300 bg-rose-50'}`}>
      <p className={`text-2xl font-bold ${pass ? 'text-emerald-700' : 'text-rose-700'}`}>
        {pass ? '✅ 검증 통과' : '❌ 검증 실패'}
      </p>
      <p className="mt-1 text-sm text-zinc-500">
        {pass ? '모든 안정성 기준 충족' : '일부 기준 미충족 — 하단 세부 항목 확인'}
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────
// 메인 페이지
// ──────────────────────────────────────────────

export default function ReviewPage() {
  const [data, setData] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedCycle, setExpandedCycle] = useState<number | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string>('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/review', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? '불러오기 실패');
        return;
      }
      const json: TestResult = await res.json();
      setData(json);
      setError(null);
      setLastFetchedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '네트워크 오류');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 실행 중일 때 30초마다 자동 갱신
  useEffect(() => {
    if (data?.status !== 'running') return;
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [data?.status, fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-400">불러오는 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50">
        <Header />
        <main className="mx-auto max-w-5xl px-6 py-12">
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-rose-700 font-medium">{error}</p>
            {error.includes('테스트 결과 파일') && (
              <div className="mt-4 rounded-lg bg-white border border-zinc-200 p-4 text-left text-sm text-zinc-600">
                <p className="font-medium mb-2">테스트 실행 방법:</p>
                <code className="block bg-zinc-100 rounded p-2 text-xs font-mono">
                  npx tsx -r tsconfig-paths/register scripts/integration-test-30m.ts
                </code>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (!data) return null;

  const badge = statusBadge(data.status);
  const elapsedMin = data.totalDurationMs
    ? Math.round(data.totalDurationMs / 60000 * 10) / 10
    : data.cycles.length > 0
      ? Math.round((new Date().getTime() - new Date(data.startedAt).getTime()) / 60000 * 10) / 10
      : 0;

  return (
    <div className="min-h-screen bg-zinc-50">
      <Header />

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">

        {/* 테스트 헤더 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <h2 className="text-xl font-bold text-zinc-900">{data.testName}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                ID: {data.testId} &middot; 시작: {new Date(data.startedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                {data.endedAt && ` → ${new Date(data.endedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className={`rounded-full px-3 py-1 text-sm font-medium ${badge.cls}`}>
                {badge.label}
              </span>
              <p className="text-xs text-zinc-400">마지막 갱신: {lastFetchedAt}</p>
              {data.status === 'running' && (
                <p className="text-xs text-blue-500">30초마다 자동 갱신</p>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div className="rounded-lg bg-zinc-50 p-3">
              <p className="text-xs text-zinc-400">경과시간</p>
              <p className="font-semibold text-zinc-800">{elapsedMin}분</p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3">
              <p className="text-xs text-zinc-400">사이클</p>
              <p className="font-semibold text-zinc-800">{data.cycles.length} / {data.config.targetCycles}</p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3">
              <p className="text-xs text-zinc-400">초기 자본</p>
              <p className="font-semibold text-zinc-800">{fmt(data.config.initialCapital)}원</p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3">
              <p className="text-xs text-zinc-400">인터벌</p>
              <p className="font-semibold text-zinc-800">{data.config.cycleIntervalMs / 60000}분</p>
            </div>
          </div>
        </section>

        {/* 안정성 검증 결과 */}
        {data.stability && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-800 mb-4">안정성 검증 결과</h2>
            <OverallBadge pass={data.stability.overallPass} />

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-100">
                    <th className="text-left px-5 py-3 font-medium text-zinc-600">검증 항목</th>
                    <th className="text-right px-5 py-3 font-medium text-zinc-600">측정값</th>
                    <th className="text-right px-5 py-3 font-medium text-zinc-600">판정</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {data.summary && (
                    <>
                      <tr>
                        <td className="px-5 py-3 text-zinc-700">사이클 완주율</td>
                        <td className="px-5 py-3 text-right tabular-nums text-zinc-900">{data.summary.completionRate}%</td>
                        <td className="px-5 py-3 text-right">
                          <PassFailBadge pass={data.stability.passedCriteria['사이클 완주율'] ?? false} />
                        </td>
                      </tr>
                      {data.summary.intervalDriftPct !== null && (
                        <tr>
                          <td className="px-5 py-3 text-zinc-700">인터벌 일관성 (5분 기준 편차)</td>
                          <td className="px-5 py-3 text-right tabular-nums text-zinc-900">{data.summary.intervalDriftPct}%</td>
                          <td className="px-5 py-3 text-right">
                            <PassFailBadge pass={data.stability.passedCriteria['인터벌 일관성'] ?? false} />
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                  <tr>
                    <td className="px-5 py-3 text-zinc-700">메모리 누수 (힙 증가량)</td>
                    <td className={`px-5 py-3 text-right tabular-nums ${data.stability.memoryGrowthMB > 50 ? 'text-amber-600' : 'text-zinc-900'}`}>
                      {data.stability.memoryGrowthMB >= 0 ? '+' : ''}{data.stability.memoryGrowthMB}MB
                    </td>
                    <td className="px-5 py-3 text-right">
                      <PassFailBadge pass={data.stability.passedCriteria['메모리 누수'] ?? false} />
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-zinc-700">API 호출 한도 (사이클당 최대)</td>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900">
                      {data.stability.maxApiCallsPerCycle}회 (평균 {data.stability.avgApiCallsPerCycle}회)
                    </td>
                    <td className="px-5 py-3 text-right">
                      <PassFailBadge pass={data.stability.passedCriteria['API 호출 한도'] ?? false} />
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-zinc-700">에러 비율</td>
                    <td className="px-5 py-3 text-right tabular-nums text-zinc-900">{data.stability.errorRate}%</td>
                    <td className="px-5 py-3 text-right">
                      <PassFailBadge pass={data.stability.passedCriteria['에러 비율'] ?? false} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* 성과 요약 */}
        {(data.performance || data.cycles.length > 0) && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-800 mb-4">모의 수익률</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {data.performance ? (
                <>
                  <KpiCard
                    label="총 수익률"
                    value={pct(data.performance.returnRate)}
                    sub={`실현 손익 ${fmt(data.performance.realizedPnl)}원`}
                    color={pnlColor(data.performance.returnRate)}
                  />
                  <KpiCard
                    label="최종 자산"
                    value={`${fmt(data.performance.finalEquity)}원`}
                    sub={`초기 ${fmt(data.config.initialCapital)}원`}
                  />
                  <KpiCard
                    label="승률"
                    value={data.performance.winCount + data.performance.lossCount > 0 ? `${data.performance.winRate}%` : '-'}
                    sub={`${data.performance.winCount}승 ${data.performance.lossCount}패`}
                    color={data.performance.winRate >= 50 ? 'text-emerald-600' : 'text-rose-600'}
                  />
                  <KpiCard
                    label="수수료"
                    value={`${fmt(data.performance.feesPaid)}원`}
                    sub={`매수 ${data.performance.totalBuys}회 / 매도 ${data.performance.totalSells}회`}
                  />
                </>
              ) : data.cycles.length > 0 ? (
                // 테스트 진행 중 — 마지막 사이클 기준 표시
                (() => {
                  const last = data.cycles[data.cycles.length - 1];
                  return (
                    <>
                      <KpiCard
                        label="현재 수익률"
                        value={pct(last.portfolio.returnRate)}
                        color={pnlColor(last.portfolio.returnRate)}
                      />
                      <KpiCard
                        label="현재 자산"
                        value={`${fmt(last.portfolio.totalEquity)}원`}
                      />
                      <KpiCard
                        label="현금"
                        value={`${fmt(last.portfolio.cash)}원`}
                        sub={`포지션 ${fmt(last.portfolio.positionValue)}원`}
                      />
                      <KpiCard
                        label="수수료 누적"
                        value={`${fmt(last.portfolio.feesPaid)}원`}
                      />
                    </>
                  );
                })()
              ) : null}
            </div>
          </section>
        )}

        {/* 사이클 요약 */}
        {data.summary && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-800 mb-4">사이클 통계</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <KpiCard
                label="완주율"
                value={`${data.summary.completionRate}%`}
                sub={`${data.summary.successCycles}성공 / ${data.summary.errorCycles}에러`}
                color={data.summary.completionRate >= 80 ? 'text-emerald-600' : 'text-rose-600'}
              />
              <KpiCard
                label="평균 사이클 시간"
                value={ms(data.summary.avgCycleDurationMs)}
                sub={`최대 ${ms(data.summary.maxCycleDurationMs)}`}
              />
              {data.summary.avgIntervalMs && (
                <KpiCard
                  label="평균 실제 간격"
                  value={ms(data.summary.avgIntervalMs)}
                  sub={`편차 ${data.summary.intervalDriftPct}%`}
                />
              )}
            </div>
          </section>
        )}

        {/* 사이클별 메모리 & API 호출 추이 */}
        {data.cycles.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-800 mb-4">사이클별 메모리 & API 추이</h2>
            <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">#</th>
                    <th className="text-left px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">시작 시각</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">소요</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">Heap 사용</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">RSS</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">API 호출</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">수익률</th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600 whitespace-nowrap">상태</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {data.cycles.map((cycle) => (
                    <tr
                      key={cycle.cycleId}
                      className="hover:bg-zinc-50 cursor-pointer transition"
                      onClick={() => setExpandedCycle(expandedCycle === cycle.cycleNumber ? null : cycle.cycleNumber)}
                    >
                      <td className="px-4 py-3 font-medium text-zinc-700">{cycle.cycleNumber}</td>
                      <td className="px-4 py-3 text-zinc-500 whitespace-nowrap">{timeOnly(cycle.startedAt)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-zinc-700">{ms(cycle.durationMs)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={cycle.memory.heapUsedMB > 200 ? 'text-amber-600 font-medium' : 'text-zinc-700'}>
                          {cycle.memory.heapUsedMB}MB
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-zinc-500">{cycle.memory.rssMB}MB</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={cycle.apiCalls.total > 200 ? 'text-amber-600 font-medium' : 'text-zinc-700'}>
                          {cycle.apiCalls.total}회
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums ${pnlColor(cycle.portfolio.returnRate)}`}>
                        {pct(cycle.portfolio.returnRate)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {cycle.error
                          ? <span className="rounded-full bg-rose-100 text-rose-600 px-2 py-0.5 text-xs">에러</span>
                          : <span className="rounded-full bg-emerald-100 text-emerald-600 px-2 py-0.5 text-xs">성공</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* 선택된 사이클 상세 */}
        {expandedCycle !== null && (() => {
          const cycle = data.cycles.find((c) => c.cycleNumber === expandedCycle);
          if (!cycle) return null;
          return (
            <section className="rounded-xl border border-blue-200 bg-blue-50 p-6">
              <h3 className="text-base font-semibold text-zinc-800 mb-4">
                사이클 #{cycle.cycleNumber} 상세 — {timeOnly(cycle.startedAt)} ({ms(cycle.durationMs)})
              </h3>

              {cycle.error && (
                <div className="mb-4 rounded-lg bg-rose-100 border border-rose-200 p-3">
                  <p className="text-sm text-rose-700 font-medium">에러: {cycle.error}</p>
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-4 mb-4">
                <div className="rounded-lg bg-white border border-zinc-200 p-4">
                  <p className="text-xs text-zinc-400 mb-2">포트폴리오</p>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">총 자산</span>
                      <span className="font-medium">{fmt(cycle.portfolio.totalEquity)}원</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">현금</span>
                      <span>{fmt(cycle.portfolio.cash)}원</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">포지션 가치</span>
                      <span>{fmt(cycle.portfolio.positionValue)}원</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">수익률</span>
                      <span className={pnlColor(cycle.portfolio.returnRate)}>{pct(cycle.portfolio.returnRate)}</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg bg-white border border-zinc-200 p-4">
                  <p className="text-xs text-zinc-400 mb-2">시스템</p>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Heap 사용</span>
                      <span>{cycle.memory.heapUsedMB}MB / {cycle.memory.heapTotalMB}MB</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">RSS</span>
                      <span>{cycle.memory.rssMB}MB</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">API 호출</span>
                      <span>{cycle.apiCalls.total}회</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">선정 종목</span>
                      <span className="text-xs">{cycle.selectedMarkets.join(', ') || '-'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* API 호출 타입별 */}
              {Object.keys(cycle.apiCalls.byType).length > 0 && (
                <div className="mb-4 rounded-lg bg-white border border-zinc-200 p-4">
                  <p className="text-xs text-zinc-400 mb-2">API 호출 유형</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(cycle.apiCalls.byType).map(([type, count]) => (
                      <span key={type} className="rounded-full bg-zinc-100 text-zinc-600 px-2.5 py-0.5 text-xs">
                        {type}: {count}회
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 판단 내역 */}
              {cycle.decisions.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-400 mb-2">AI 판단 내역</p>
                  <div className="space-y-2">
                    {cycle.decisions.map((d, i) => {
                      const ab = actionLabel(d.action);
                      return (
                        <div key={i} className="rounded-lg bg-white border border-zinc-200 p-3">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="font-medium text-sm text-zinc-800">{d.market}</span>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ab.cls}`}>{ab.label}</span>
                            {d.executed && (
                              <span className="rounded-full bg-blue-100 text-blue-600 px-2 py-0.5 text-xs">실행됨</span>
                            )}
                            <span className="text-xs text-zinc-400">신뢰도 {d.confidence}% | 점수 {d.compositeScore}</span>
                          </div>
                          {d.executedPrice !== null && (
                            <p className="text-xs text-zinc-500">
                              체결가: {fmt(d.executedPrice)}원
                              {d.executedAmount !== null && d.action === 'sell' && (
                                <span className={`ml-2 ${pnlColor(d.executedAmount)}`}>
                                  손익 {d.executedAmount >= 0 ? '+' : ''}{fmt(Math.round(d.executedAmount))}원
                                </span>
                              )}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-zinc-400 line-clamp-3">{d.reasoning}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          );
        })()}

        {/* 에러 로그 */}
        {data.errors.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-800 mb-4">에러 로그</h2>
            <div className="rounded-xl border border-rose-200 bg-white shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-rose-50 border-b border-rose-100">
                    <th className="text-left px-4 py-3 font-medium text-rose-700">사이클</th>
                    <th className="text-left px-4 py-3 font-medium text-rose-700">시각</th>
                    <th className="text-left px-4 py-3 font-medium text-rose-700">메시지</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rose-50">
                  {data.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3 text-zinc-700">#{e.cycleNumber}</td>
                      <td className="px-4 py-3 text-zinc-500 whitespace-nowrap">{timeOnly(e.time)}</td>
                      <td className="px-4 py-3 text-rose-700">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* 실행 안내 (결과 없을 때) */}
        {data.cycles.length === 0 && data.status === 'running' && (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 text-center">
            <p className="text-zinc-500">첫 번째 사이클 실행 중...</p>
            <p className="mt-2 text-xs text-zinc-400">페이지가 30초마다 자동으로 갱신됩니다.</p>
          </section>
        )}

      </main>

      <footer className="border-t border-zinc-200 bg-white mt-10">
        <div className="mx-auto max-w-5xl px-6 py-4 text-center text-xs text-zinc-400">
          2차 통합 리뷰 &middot; 모의 운영 모드 &middot; 실제 자금 거래 아님
        </div>
      </footer>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto max-w-5xl px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900">2차 통합 리뷰</h1>
            <p className="mt-1 text-xs text-zinc-400">
              자동 매매 루프 30분 연속 검증 &middot; 안정성 · 메모리 · API 한도
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition"
          >
            대시보드로
          </Link>
        </div>
      </div>
    </header>
  );
}
