import {
  getActivityFeed,
  getActivitySummary,
  getAvailableActivityDates,
} from '@/lib/activity-feed';
import type {
  ActivityItem,
  ActivitySummary,
  ActivitySeverity,
  AIJudgmentDetail,
  OrderDetail,
  CycleDetail,
  RiskDetail,
} from '@/types/activity';
import Link from 'next/link';

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function timeOnly(iso: string): string {
  return iso.slice(11, 19); // HH:mm:ss
}

function severityColor(s: ActivitySeverity): string {
  switch (s) {
    case 'success': return 'text-emerald-600';
    case 'warning': return 'text-amber-600';
    case 'error':   return 'text-rose-600';
    default:        return 'text-zinc-500';
  }
}

function severityBg(s: ActivitySeverity): string {
  switch (s) {
    case 'success': return 'bg-emerald-50 border-emerald-200';
    case 'warning': return 'bg-amber-50 border-amber-200';
    case 'error':   return 'bg-rose-50 border-rose-200';
    default:        return 'bg-zinc-50 border-zinc-200';
  }
}

function typeBadge(type: ActivityItem['type']): { label: string; cls: string } {
  switch (type) {
    case 'cycle_end':
      return { label: '사이클', cls: 'bg-blue-100 text-blue-700' };
    case 'cycle_error':
      return { label: '사이클 에러', cls: 'bg-rose-100 text-rose-700' };
    case 'ai_judgment':
      return { label: 'AI 판단', cls: 'bg-violet-100 text-violet-700' };
    case 'order_buy':
      return { label: '매수', cls: 'bg-emerald-100 text-emerald-700' };
    case 'order_sell':
      return { label: '매도', cls: 'bg-rose-100 text-rose-700' };
    case 'risk_stop_loss':
      return { label: '손절', cls: 'bg-red-100 text-red-700' };
    case 'risk_take_profit':
      return { label: '익절', cls: 'bg-green-100 text-green-700' };
    case 'risk_trailing':
      return { label: '트레일링', cls: 'bg-orange-100 text-orange-700' };
    case 'circuit_breaker':
      return { label: '서킷 브레이커', cls: 'bg-red-100 text-red-700' };
    default:
      return { label: '기타', cls: 'bg-zinc-100 text-zinc-600' };
  }
}

// ──────────────────────────────────────────────
// 요약 카드
// ──────────────────────────────────────────────

function SummaryBar({ s }: { s: ActivitySummary }) {
  const stats = [
    { label: '사이클', value: `${s.totalCycles}회`, sub: s.errorCycles > 0 ? `에러 ${s.errorCycles}` : null, color: s.errorCycles > 0 ? 'text-rose-600' : 'text-blue-600' },
    { label: 'AI 판단', value: `${s.totalJudgments}건`, sub: null, color: 'text-violet-600' },
    { label: '매수', value: `${s.buyCount}건`, sub: null, color: 'text-emerald-600' },
    { label: '매도', value: `${s.sellCount}건`, sub: null, color: 'text-rose-600' },
    { label: '리스크', value: `${s.riskEventCount}건`, sub: null, color: s.riskEventCount > 0 ? 'text-amber-600' : 'text-zinc-500' },
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {stats.map((st) => (
        <div key={st.label} className="rounded-lg border border-zinc-200 bg-white p-3 text-center shadow-sm">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">{st.label}</p>
          <p className={`mt-0.5 text-lg font-bold tabular-nums ${st.color}`}>{st.value}</p>
          {st.sub && <p className="text-xs text-rose-400">{st.sub}</p>}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// 활동 상세 패널
// ──────────────────────────────────────────────

function DetailContent({ item }: { item: ActivityItem }) {
  const d = item.detail;

  if (d.kind === 'cycle') {
    const cd = d as CycleDetail;
    return (
      <div className="mt-2 text-xs text-zinc-500 space-y-1">
        <p>소요 시간: <span className="font-mono">{cd.durationMs}ms</span></p>
        {cd.executedCount > 0 && <p>매매 실행: {cd.executedCount}건</p>}
        {cd.marketSummary && <p className="truncate">{cd.marketSummary}</p>}
        {cd.error && <p className="text-rose-500">{cd.error}</p>}
      </div>
    );
  }

  if (d.kind === 'ai_judgment') {
    const jd = d as AIJudgmentDetail;
    return (
      <div className="mt-2 text-xs text-zinc-500 space-y-1">
        <div className="flex gap-4">
          <span>엔진: <span className="font-medium text-zinc-700">{jd.engine}</span></span>
          <span>신뢰도: <span className="font-mono">{jd.confidence}%</span></span>
          <span>점수: <span className="font-mono">{jd.compositeScore}</span></span>
          <span>응답: <span className="font-mono">{jd.latencyMs}ms</span></span>
        </div>
        <p className="text-zinc-600 leading-relaxed line-clamp-3">{jd.reasoning}</p>
      </div>
    );
  }

  if (d.kind === 'order') {
    const od = d as OrderDetail;
    return (
      <div className="mt-2 text-xs text-zinc-500 space-y-1">
        <div className="flex gap-4">
          <span>가격: <span className="font-mono">{fmt(od.price)}</span></span>
          <span>수량: <span className="font-mono">{od.volume}</span></span>
          <span>금액: <span className="font-mono">{fmt(od.totalAmount)} KRW</span></span>
          {od.profitRate !== null && (
            <span className={od.profitRate > 0 ? 'text-emerald-600' : 'text-rose-600'}>
              수익률: {od.profitRate > 0 ? '+' : ''}{od.profitRate.toFixed(2)}%
            </span>
          )}
        </div>
        <p className="text-zinc-600 leading-relaxed line-clamp-2">{od.reasoning}</p>
      </div>
    );
  }

  if (d.kind === 'risk') {
    const rd = d as RiskDetail;
    return (
      <div className="mt-2 text-xs text-zinc-500 space-y-1">
        <div className="flex gap-4">
          <span>매수가: <span className="font-mono">{fmt(rd.buyPrice)}</span></span>
          <span>현재가: <span className="font-mono">{fmt(rd.currentPrice)}</span></span>
          <span className={rd.profitRate > 0 ? 'text-emerald-600' : 'text-rose-600'}>
            수익률: {rd.profitRate > 0 ? '+' : ''}{rd.profitRate.toFixed(2)}%
          </span>
        </div>
        <p className="text-zinc-600">{rd.reasoning}</p>
      </div>
    );
  }

  // circuit_breaker
  return (
    <div className="mt-2 text-xs text-rose-500">
      <p>{(d as { kind: string; reason: string }).reason}</p>
    </div>
  );
}

// ──────────────────────────────────────────────
// 활동 아이템 행
// ──────────────────────────────────────────────

function ActivityRow({ item }: { item: ActivityItem }) {
  const badge = typeBadge(item.type);

  return (
    <div className={`rounded-lg border p-4 ${severityBg(item.severity)}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-zinc-400 tabular-nums w-16 flex-shrink-0">
            {timeOnly(item.timestamp)}
          </span>
          <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${badge.cls}`}>
            {badge.label}
          </span>
          {item.market && (
            <span className="font-mono text-xs font-medium text-zinc-700">{item.market}</span>
          )}
        </div>
      </div>
      <p className={`mt-1 text-sm font-medium ${severityColor(item.severity)}`}>
        {item.message}
      </p>
      <DetailContent item={item} />
    </div>
  );
}

// ──────────────────────────────────────────────
// 날짜 선택기
// ──────────────────────────────────────────────

function DateSelector({
  dates,
  current,
}: {
  dates: string[];
  current: string;
}) {
  if (dates.length === 0) {
    return <p className="text-sm text-zinc-400">기록된 날짜 없음</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {dates.slice(0, 14).map((d) => (
        <Link
          key={d}
          href={`/activity?date=${d}`}
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
// 메인 페이지
// ──────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; types?: string; market?: string }>;
}) {
  // Next.js 15+ : searchParams는 Promise이지만 Server Component에서 동기 접근 가능
  // 실제로는 캐스팅으로 처리
  const params = searchParams as unknown as { date?: string; types?: string; market?: string };

  const today = new Date().toISOString().slice(0, 10);
  const date = params.date ?? today;

  const types = params.types?.split(',').filter(Boolean) as
    | import('@/types/activity').ActivityType[]
    | undefined;

  const feed = getActivityFeed({ date, types, market: params.market, limit: 200 });
  const summary = getActivitySummary(date);
  const availableDates = getAvailableActivityDates();

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* 헤더 */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-zinc-900">활동 타임라인</h1>
              <p className="mt-1 text-xs text-zinc-400">
                {date} &middot; 마지막 갱신: {new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
              </p>
            </div>
            <Link
              href="/"
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition"
            >
              대시보드
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        {/* 날짜 선택 */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-600 mb-3">날짜 선택</h2>
          <DateSelector dates={availableDates} current={date} />
        </section>

        {/* 요약 통계 */}
        <SummaryBar s={summary} />

        {/* 타임라인 */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-800 mb-4">
            활동 내역{' '}
            <span className="text-sm font-normal text-zinc-400">({feed.length}건)</span>
          </h2>

          {feed.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center shadow-sm">
              <p className="text-zinc-400">이 날짜에 기록된 활동이 없습니다.</p>
              <p className="mt-1 text-xs text-zinc-300">
                스케줄러가 실행되면 사이클 로그, AI 판단, 매매 기록이 여기에 표시됩니다.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {feed.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* 푸터 */}
      <footer className="border-t border-zinc-200 bg-white mt-10">
        <div className="mx-auto max-w-5xl px-6 py-4 text-center text-xs text-zinc-400">
          AI 자동매매 시스템 &middot; 활동 타임라인 &middot; 모의 운영 모드
        </div>
      </footer>
    </div>
  );
}
