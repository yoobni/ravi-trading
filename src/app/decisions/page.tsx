import {
  getDecisionLogs,
  getDecisionLogSummary,
  getAvailableDecisionLogDates,
  getDecisionLogsByDate,
} from '@/lib/decision-log-service';
import type {
  DecisionLog,
  DecisionLogDailySummary,
  PipelineDecisionLog,
} from '@/types/decision-log';
import Link from 'next/link';

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function fmt(n: number | null, decimals = 0): string {
  if (n === null) return 'N/A';
  return n.toLocaleString('ko-KR', { maximumFractionDigits: decimals });
}

function pct(n: number | null): string {
  if (n === null) return '-';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function timeOnly(iso: string): string {
  return iso.slice(11, 19);
}

function actionBadge(action: string): { label: string; cls: string } {
  switch (action) {
    case 'buy':
      return { label: '매수', cls: 'bg-emerald-100 text-emerald-700' };
    case 'sell':
      return { label: '매도', cls: 'bg-rose-100 text-rose-700' };
    default:
      return { label: '관망', cls: 'bg-zinc-100 text-zinc-600' };
  }
}

function engineBadge(engine: string): { label: string; cls: string } {
  switch (engine) {
    case 'claude':
      return { label: 'Claude AI', cls: 'bg-violet-100 text-violet-700' };
    case 'algorithm':
      return { label: '알고리즘', cls: 'bg-blue-100 text-blue-700' };
    case 'fallback':
      return { label: '폴백', cls: 'bg-amber-100 text-amber-700' };
    default:
      return { label: engine, cls: 'bg-zinc-100 text-zinc-600' };
  }
}

function confidenceColor(c: number): string {
  if (c >= 70) return 'text-emerald-600';
  if (c >= 40) return 'text-amber-600';
  return 'text-rose-600';
}

function scoreColor(s: number): string {
  if (s > 20) return 'text-emerald-600';
  if (s < -20) return 'text-rose-600';
  return 'text-zinc-600';
}

function trendIcon(trend: string): string {
  if (trend === 'rising' || trend === 'bullish' || trend === 'golden') return '\u2191';
  if (trend === 'falling' || trend === 'bearish' || trend === 'dead') return '\u2193';
  return '\u2192';
}

// ──────────────────────────────────────────────
// 요약 바
// ──────────────────────────────────────────────

function SummaryBar({ s }: { s: DecisionLogDailySummary }) {
  const stats = [
    { label: '총 판단', value: `${s.totalDecisions}건`, color: 'text-zinc-800' },
    { label: '매수', value: `${s.byAction.buy ?? 0}건`, color: 'text-emerald-600' },
    { label: '매도', value: `${s.byAction.sell ?? 0}건`, color: 'text-rose-600' },
    { label: '관망', value: `${s.byAction.hold ?? 0}건`, color: 'text-zinc-500' },
    { label: '실행', value: `${s.executedCount}건`, color: 'text-blue-600' },
    { label: '평균 신뢰도', value: `${s.avgConfidence}%`, color: confidenceColor(s.avgConfidence) },
    { label: '평균 응답', value: `${s.avgLatencyMs}ms`, color: 'text-zinc-600' },
  ];

  return (
    <div className="grid grid-cols-4 md:grid-cols-7 gap-3">
      {stats.map((st) => (
        <div key={st.label} className="rounded-lg border border-zinc-200 bg-white p-3 text-center shadow-sm">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">{st.label}</p>
          <p className={`mt-0.5 text-lg font-bold tabular-nums ${st.color}`}>{st.value}</p>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// 날짜 선택기
// ──────────────────────────────────────────────

function DateSelector({ dates, current }: { dates: string[]; current: string }) {
  if (dates.length === 0) {
    return <p className="text-sm text-zinc-400">기록된 날짜 없음</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {dates.slice(0, 14).map((d) => (
        <Link
          key={d}
          href={`/decisions?date=${d}`}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            d === current
              ? 'bg-zinc-900 text-white'
              : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
          }`}
        >
          {d}
        </Link>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// 지표 패널
// ──────────────────────────────────────────────

function IndicatorPanel({ d }: { d: DecisionLog }) {
  const ind = d.indicators;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
      <div>
        <span className="text-zinc-400">RSI</span>{' '}
        <span className="font-mono font-medium">{fmt(ind.rsi, 1)}</span>{' '}
        <span className="text-zinc-400">{trendIcon(ind.rsiTrend)}</span>
      </div>
      <div>
        <span className="text-zinc-400">MACD</span>{' '}
        <span className="font-mono font-medium">{fmt(ind.macdHistogram, 4)}</span>{' '}
        <span className="text-zinc-400">{trendIcon(ind.macdCross)}</span>
      </div>
      <div>
        <span className="text-zinc-400">볼린저 %B</span>{' '}
        <span className="font-mono font-medium">{fmt(ind.bollingerPercentB, 3)}</span>
      </div>
      <div>
        <span className="text-zinc-400">밴드폭</span>{' '}
        <span className="font-mono font-medium">{fmt(ind.bollingerBandwidth, 4)}</span>
      </div>
      <div>
        <span className="text-zinc-400">이평선</span>{' '}
        <span className={`font-mono font-medium ${
          ind.maAlignment === 'bullish' ? 'text-emerald-600' :
          ind.maAlignment === 'bearish' ? 'text-rose-600' : 'text-zinc-600'
        }`}>
          {ind.maAlignment}
        </span>
      </div>
      <div>
        <span className="text-zinc-400">거래량</span>{' '}
        <span className="font-mono font-medium">{fmt(ind.volumeRatio, 2)}x</span>
        {ind.volumeSurge && <span className="ml-1 text-amber-500 font-bold">서지</span>}
      </div>
      <div className="col-span-2 text-zinc-400 font-mono text-[10px]">
        MA5={fmt(ind.ma5, 0)} MA20={fmt(ind.ma20, 0)} MA60={fmt(ind.ma60, 0)}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 판단 카드
// ──────────────────────────────────────────────

function DecisionCard({ d }: { d: DecisionLog }) {
  const ai = d.aiJudgment;
  const exec = d.execution;
  const badge = actionBadge(ai.action);
  const engBadge = engineBadge(ai.engine);

  const isExecuted = exec.executed && exec.success;

  return (
    <div className={`rounded-xl border bg-white shadow-sm overflow-hidden ${
      ai.action === 'buy' ? 'border-emerald-200' :
      ai.action === 'sell' ? 'border-rose-200' : 'border-zinc-200'
    }`}>
      {/* 헤더 */}
      <div className={`px-5 py-3 flex items-center justify-between ${
        ai.action === 'buy' ? 'bg-emerald-50' :
        ai.action === 'sell' ? 'bg-rose-50' : 'bg-zinc-50'
      }`}>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold text-zinc-800">{d.market}</span>
          <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${badge.cls}`}>
            {badge.label}
          </span>
          <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${engBadge.cls}`}>
            {engBadge.label}
          </span>
          {isExecuted && (
            <span className="inline-block rounded px-2 py-0.5 text-xs font-bold bg-blue-100 text-blue-700">
              체결
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="font-mono">{timeOnly(d.timestamp)}</span>
          <span className="font-mono">{d.totalDurationMs}ms</span>
        </div>
      </div>

      {/* 본문 */}
      <div className="px-5 py-4 space-y-4">
        {/* 상단: 가격 + 핵심 수치 */}
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-zinc-400">현재가</p>
            <p className="text-xl font-bold tabular-nums text-zinc-800">{fmt(d.currentPrice)}원</p>
          </div>
          <div className="flex gap-4 text-center">
            <div>
              <p className="text-xs text-zinc-400">신뢰도</p>
              <p className={`text-lg font-bold tabular-nums ${confidenceColor(ai.confidence)}`}>
                {ai.confidence}%
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">종합 점수</p>
              <p className={`text-lg font-bold tabular-nums ${scoreColor(ai.compositeScore)}`}>
                {ai.compositeScore}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">제안 비율</p>
              <p className="text-lg font-bold tabular-nums text-zinc-700">
                {(ai.suggestedSizeRate * 100).toFixed(0)}%
              </p>
            </div>
          </div>
        </div>

        {/* 판단 근거 */}
        <div className="rounded-lg bg-zinc-50 p-3">
          <p className="text-xs font-medium text-zinc-500 mb-1">AI 판단 근거</p>
          <p className="text-sm text-zinc-700 leading-relaxed">{ai.reasoning}</p>
        </div>

        {/* 핵심 시그널 */}
        {ai.keySignals.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-500 mb-2">핵심 시그널</p>
            <div className="flex flex-wrap gap-2">
              {ai.keySignals.map((sig, i) => (
                <div
                  key={i}
                  className={`rounded-lg px-3 py-1.5 text-xs border ${
                    sig.direction === 'bullish' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                    sig.direction === 'bearish' ? 'bg-rose-50 border-rose-200 text-rose-700' :
                    'bg-zinc-50 border-zinc-200 text-zinc-600'
                  }`}
                >
                  <span className="font-medium">{sig.name}</span>
                  <span className="ml-1 opacity-60">({sig.importance}/5)</span>
                  {sig.description && (
                    <span className="ml-1 opacity-80">— {sig.description}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2열 레이아웃: 지표 + 실행 결과 */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* 기술 지표 */}
          <div className="rounded-lg border border-zinc-100 p-3">
            <p className="text-xs font-medium text-zinc-500 mb-2">분석 지표</p>
            <IndicatorPanel d={d} />
          </div>

          {/* 실행 결과 + 시장 심리 */}
          <div className="space-y-3">
            {/* 시장 심리 */}
            <div className="rounded-lg border border-zinc-100 p-3">
              <p className="text-xs font-medium text-zinc-500 mb-1">시장 심리</p>
              <div className="flex gap-4 text-xs text-zinc-600">
                <span>공포/탐욕: <span className="font-mono font-medium">{d.sentiment.fearGreedScore}</span> ({d.sentiment.fearGreedLabel})</span>
                <span>BTC: <span className="font-mono font-medium">{d.sentiment.btcDominance}%</span></span>
              </div>
            </div>

            {/* 실행 결과 */}
            <div className={`rounded-lg border p-3 ${
              isExecuted ? 'border-blue-200 bg-blue-50' :
              exec.skipReason ? 'border-zinc-100' : 'border-zinc-100'
            }`}>
              <p className="text-xs font-medium text-zinc-500 mb-1">실행 결과</p>
              {isExecuted ? (
                <div className="text-xs text-zinc-700 space-y-0.5">
                  <p>
                    <span className="font-medium">{exec.action.toUpperCase()}</span>{' '}
                    체결: <span className="font-mono">{fmt(exec.executedPrice!)}</span>원{' '}
                    &times; <span className="font-mono">{fmt(exec.amount!)}</span>원
                  </p>
                  <p className="text-zinc-400">수수료: {fmt(exec.fee!)}원</p>
                </div>
              ) : (
                <p className="text-xs text-zinc-400">{exec.skipReason ?? '미실행'}</p>
              )}
            </div>

            {/* 손절/익절 */}
            {(ai.suggestedStopLoss || ai.suggestedTakeProfit) && (
              <div className="rounded-lg border border-zinc-100 p-3">
                <p className="text-xs font-medium text-zinc-500 mb-1">손절/익절 제안</p>
                <div className="flex gap-4 text-xs">
                  {ai.suggestedStopLoss && (
                    <span className="text-rose-600">
                      손절: <span className="font-mono">{fmt(ai.suggestedStopLoss)}</span>원
                    </span>
                  )}
                  {ai.suggestedTakeProfit && (
                    <span className="text-emerald-600">
                      익절: <span className="font-mono">{fmt(ai.suggestedTakeProfit)}</span>원
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 포트폴리오 상태 */}
        <div className="flex gap-4 text-xs text-zinc-400 border-t border-zinc-100 pt-3">
          <span>보유: {d.portfolio.isHolding ? '예' : '아니오'}</span>
          <span>보유종목: {d.portfolio.holdingCount}개</span>
          <span>가용잔고: {fmt(d.portfolio.availableBalance)}원</span>
          {d.portfolio.currentProfitRate !== null && (
            <span>현재수익률: {pct(d.portfolio.currentProfitRate * 100)}</span>
          )}
          <span className="ml-auto font-mono text-zinc-300">ID: {d.id}</span>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 파이프라인 그룹
// ──────────────────────────────────────────────

function PipelineGroup({ pipeline }: { pipeline: PipelineDecisionLog }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-mono text-xs bg-zinc-100 rounded px-2 py-1 text-zinc-600">
          #{pipeline.pipelineId}
        </span>
        <span className="text-zinc-500">
          {timeOnly(pipeline.startedAt)} ~ {timeOnly(pipeline.endedAt)}
        </span>
        <span className="text-zinc-400">({pipeline.durationMs}ms)</span>
        <span className="text-zinc-600 font-medium">
          {pipeline.marketCount}종목 / 실행 {pipeline.executedCount}건
        </span>
        {pipeline.error && (
          <span className="text-rose-500 text-xs">{pipeline.error}</span>
        )}
      </div>

      <div className="space-y-4">
        {pipeline.decisions.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 메인 페이지
// ──────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; market?: string; action?: string }>;
}) {
  const params = searchParams as unknown as { date?: string; market?: string; action?: string };
  const today = new Date().toISOString().slice(0, 10);
  const date = params.date ?? today;

  const pipelineLogs = getDecisionLogsByDate(date);
  const summary = getDecisionLogSummary(date);
  const availableDates = getAvailableDecisionLogDates();

  // 필터 적용
  let filteredPipelines = pipelineLogs;
  if (params.market || params.action) {
    filteredPipelines = pipelineLogs.map((p) => ({
      ...p,
      decisions: p.decisions.filter((d) => {
        if (params.market && d.market !== params.market) return false;
        if (params.action && d.aiJudgment.action !== params.action) return false;
        return true;
      }),
    })).filter((p) => p.decisions.length > 0);
  }

  // 모든 종목 추출 (필터용)
  const allMarkets = [...new Set(pipelineLogs.flatMap((p) => p.decisions.map((d) => d.market)))].sort();

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* 헤더 */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-zinc-900">판단 로그</h1>
              <p className="mt-1 text-xs text-zinc-400">
                {date} &middot; 매 사이클 AI 판단 근거 + 지표값 + 실행 결과
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/"
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition"
              >
                대시보드
              </Link>
              <Link
                href="/activity"
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition"
              >
                활동 타임라인
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-8">
        {/* 날짜 선택 */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-600 mb-3">날짜 선택</h2>
          <DateSelector dates={availableDates} current={date} />
        </section>

        {/* 요약 */}
        <SummaryBar s={summary} />

        {/* 필터 */}
        {allMarkets.length > 0 && (
          <section className="flex flex-wrap gap-2">
            <Link
              href={`/decisions?date=${date}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                !params.market && !params.action
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              전체
            </Link>
            {['buy', 'sell', 'hold'].map((action) => (
              <Link
                key={action}
                href={`/decisions?date=${date}&action=${action}${params.market ? `&market=${params.market}` : ''}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  params.action === action
                    ? 'bg-zinc-900 text-white'
                    : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {actionBadge(action).label}
              </Link>
            ))}
            <span className="border-l border-zinc-200 mx-1" />
            {allMarkets.map((m) => (
              <Link
                key={m}
                href={`/decisions?date=${date}&market=${m}${params.action ? `&action=${params.action}` : ''}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition ${
                  params.market === m
                    ? 'bg-zinc-900 text-white'
                    : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {m}
              </Link>
            ))}
          </section>
        )}

        {/* 파이프라인별 판단 로그 */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-800 mb-4">
            판단 내역{' '}
            <span className="text-sm font-normal text-zinc-400">
              ({filteredPipelines.reduce((sum, p) => sum + p.decisions.length, 0)}건)
            </span>
          </h2>

          {filteredPipelines.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center shadow-sm">
              <p className="text-zinc-400">이 날짜에 기록된 판단 로그가 없습니다.</p>
              <p className="mt-1 text-xs text-zinc-300">
                스케줄러가 실행되면 매 사이클마다 판단 근거가 여기에 기록됩니다.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {filteredPipelines.map((p) => (
                <PipelineGroup key={p.pipelineId} pipeline={p} />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* 푸터 */}
      <footer className="border-t border-zinc-200 bg-white mt-10">
        <div className="mx-auto max-w-6xl px-6 py-4 text-center text-xs text-zinc-400">
          AI 자동매매 시스템 &middot; 판단 로그 &middot; 모의 운영 모드
        </div>
      </footer>
    </div>
  );
}
