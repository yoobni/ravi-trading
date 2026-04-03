import { getDashboardData } from '@/lib/dashboard-stats';
import { listOrders, getOpenPositions } from '@/lib/order-store';
import type { PerformanceSummary, DailyStats, MarketStats } from '@/types/dashboard';
import type { Order } from '@/types/order';
import Link from 'next/link';

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function pct(n: number | null): string {
  if (n === null) return '-';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-emerald-600';
  if (n < 0) return 'text-rose-600';
  return 'text-zinc-500';
}

function pnlBg(n: number): string {
  if (n > 0) return 'bg-emerald-50 border-emerald-200';
  if (n < 0) return 'bg-rose-50 border-rose-200';
  return 'bg-zinc-50 border-zinc-200';
}

// ──────────────────────────────────────────────
// KPI 카드
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
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${color ?? 'text-zinc-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

// ──────────────────────────────────────────────
// 성과 요약 섹션
// ──────────────────────────────────────────────

function SummarySection({ s }: { s: PerformanceSummary }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">성과 요약</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <KpiCard
          label="총 수익률"
          value={pct(s.totalReturnRate)}
          sub={`${fmt(s.totalRealizedPnl)} KRW`}
          color={pnlColor(s.totalReturnRate)}
        />
        <KpiCard
          label="현재 자산"
          value={`${fmt(s.currentAssets)} KRW`}
          sub={`초기 ${fmt(s.initialCapital)} KRW`}
        />
        <KpiCard
          label="승률"
          value={`${s.winRate.toFixed(1)}%`}
          sub={`${s.winCount}승 ${s.lossCount}패`}
          color={s.winRate >= 50 ? 'text-emerald-600' : 'text-rose-600'}
        />
        <KpiCard
          label="총 거래"
          value={`${s.closedTradeCount}건`}
          sub={`체결 ${s.totalTradeCount}건`}
        />
        <KpiCard
          label="평균 수익률"
          value={pct(s.avgReturnRate)}
          color={pnlColor(s.avgReturnRate)}
        />
        <KpiCard
          label="손익비"
          value={s.profitLossRatio !== null ? s.profitLossRatio.toFixed(2) : '-'}
          sub={`평균 이익 ${pct(s.avgWinRate)} / 손실 ${pct(s.avgLossRate)}`}
        />
        <KpiCard
          label="최대 낙폭 (MDD)"
          value={pct(s.maxDrawdown)}
          sub={
            s.maxDrawdownPeriod
              ? `${s.maxDrawdownPeriod.peakAt.slice(0, 10)} ~ ${s.maxDrawdownPeriod.troughAt.slice(0, 10)}`
              : undefined
          }
          color="text-rose-600"
        />
        <KpiCard
          label="샤프 비율"
          value={s.sharpeRatio !== null ? s.sharpeRatio.toFixed(2) : '-'}
          sub="연환산 (무위험 3.5%)"
        />
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 일별 통계 테이블
// ──────────────────────────────────────────────

function DailyStatsTable({ stats }: { stats: DailyStats[] }) {
  if (stats.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">일별 통계</h2>
        <p className="text-sm text-zinc-400">아직 거래 데이터가 없습니다.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">일별 통계</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3">날짜</th>
              <th className="px-4 py-3 text-right">거래 수</th>
              <th className="px-4 py-3 text-right">실현 손익</th>
              <th className="px-4 py-3 text-right">수익률</th>
              <th className="px-4 py-3 text-right">승률</th>
              <th className="px-4 py-3 text-right">승/패</th>
              <th className="px-4 py-3 text-right">누적 자산</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((d) => (
              <tr key={d.date} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                <td className="px-4 py-2.5 font-mono text-xs">{d.date}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{d.tradeCount}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${pnlColor(d.realizedPnl)}`}>
                  {fmt(d.realizedPnl)}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${pnlColor(d.returnRate)}`}>
                  {pct(d.returnRate)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{d.winRate.toFixed(1)}%</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                  <span className="text-emerald-600">{d.winCount}</span>
                  {' / '}
                  <span className="text-rose-600">{d.lossCount}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmt(d.cumulativeAssets)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 종목별 통계 테이블
// ──────────────────────────────────────────────

function MarketStatsTable({ stats }: { stats: MarketStats[] }) {
  if (stats.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">종목별 통계</h2>
        <p className="text-sm text-zinc-400">아직 거래 데이터가 없습니다.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">종목별 통계</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3">종목</th>
              <th className="px-4 py-3 text-right">거래 수</th>
              <th className="px-4 py-3 text-right">총 손익</th>
              <th className="px-4 py-3 text-right">평균 수익률</th>
              <th className="px-4 py-3 text-right">승률</th>
              <th className="px-4 py-3 text-right">최고 / 최저</th>
              <th className="px-4 py-3 text-right">평균 보유</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((m) => (
              <tr key={m.market} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                <td className="px-4 py-2.5 font-mono text-xs font-medium">{m.market}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{m.tradeCount}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${pnlColor(m.totalPnl)}`}>
                  {fmt(m.totalPnl)}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${pnlColor(m.avgReturnRate)}`}>
                  {pct(m.avgReturnRate)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{m.winRate.toFixed(1)}%</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                  <span className="text-emerald-600">{pct(m.bestReturn)}</span>
                  {' / '}
                  <span className="text-rose-600">{pct(m.worstReturn)}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{m.avgHoldingHours.toFixed(1)}h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 보유 포지션 섹션
// ──────────────────────────────────────────────

function OpenPositionsSection({ positions }: { positions: Order[] }) {
  if (positions.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">보유 포지션</h2>
        <p className="text-sm text-zinc-400">현재 보유 중인 포지션이 없습니다.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">
        보유 포지션 <span className="text-sm font-normal text-zinc-400">({positions.length}건)</span>
      </h2>
      <div className="grid gap-3">
        {positions.map((p) => (
          <div key={p.id} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-bold">{p.market}</span>
              <span className="text-xs text-zinc-500">{p.filledAt?.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <div className="mt-2 flex gap-6 text-sm">
              <span>매수가: <strong className="tabular-nums">{fmt(p.price)}</strong></span>
              <span>수량: <strong className="tabular-nums">{p.volume}</strong></span>
              <span>금액: <strong className="tabular-nums">{fmt(p.totalAmount)} KRW</strong></span>
            </div>
            <p className="mt-2 text-xs text-zinc-600 leading-relaxed">{p.reasoning}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 최근 거래 내역
// ──────────────────────────────────────────────

function RecentOrdersSection({ orders }: { orders: Order[] }) {
  if (orders.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">최근 거래 내역</h2>
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <p className="text-zinc-400">아직 거래 내역이 없습니다.</p>
          <p className="mt-1 text-xs text-zinc-300">모의 운영이 시작되면 여기에 거래가 표시됩니다.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">
        최근 거래 내역 <span className="text-sm font-normal text-zinc-400">(최근 20건)</span>
      </h2>
      <div className="space-y-3">
        {orders.map((o) => {
          const isBuy = o.side === 'buy';
          return (
            <div
              key={o.id}
              className={`rounded-lg border p-4 ${
                isBuy ? 'border-emerald-200 bg-emerald-50/50' : 'border-rose-200 bg-rose-50/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                      isBuy ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                    }`}
                  >
                    {isBuy ? '매수' : '매도'}
                  </span>
                  <span className="font-mono text-sm font-bold">{o.market}</span>
                  {o.profitRate !== null && (
                    <span className={`text-sm font-bold ${pnlColor(o.profitRate)}`}>
                      {pct(o.profitRate)}
                    </span>
                  )}
                </div>
                <span className="text-xs text-zinc-500">
                  {(o.filledAt ?? o.createdAt).slice(0, 16).replace('T', ' ')}
                </span>
              </div>
              <div className="mt-2 flex gap-6 text-xs text-zinc-600">
                <span>가격: <strong className="tabular-nums">{fmt(o.price)}</strong></span>
                <span>수량: <strong className="tabular-nums">{o.volume}</strong></span>
                <span>금액: <strong className="tabular-nums">{fmt(o.totalAmount)} KRW</strong></span>
              </div>
              <p className="mt-2 text-xs text-zinc-500 leading-relaxed">{o.reasoning}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 실거래 전환 체크리스트
// ──────────────────────────────────────────────

function TransitionChecklist() {
  const items = [
    { label: '실 API 키 발급 (업비트 Open API)', desc: 'access_key, secret_key → .env에 설정' },
    { label: '주문 엔드포인트 전환', desc: 'paper-trading-engine → upbit-client 실주문 API' },
    { label: '잔고 연동', desc: '시뮬레이션 balance.json → 업비트 실계좌 잔고 조회' },
    { label: 'IP 허용 목록 등록', desc: '업비트 API 서버 접근을 위한 IP 화이트리스트' },
    { label: '주문 수량/금액 제한 설정', desc: '실거래 초기에는 소액으로 제한 권장' },
    { label: '비상 정지 로직 확인', desc: 'emergency-liquidation, circuit-breaker 동작 검증' },
    { label: '모의 운영 성과 검토', desc: '최소 1주일 이상 모의 운영 결과 확인 후 전환' },
  ];

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-800 mb-4">실거래 전환 체크리스트</h2>
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <ul className="space-y-3">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <div className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-2 border-zinc-300 bg-white" />
              <div>
                <p className="text-sm font-medium text-zinc-800">{item.label}</p>
                <p className="text-xs text-zinc-400">{item.desc}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-zinc-400 border-t border-zinc-100 pt-3">
          위 항목을 모두 확인한 후 보스 승인을 받아 전환합니다.
        </p>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────
// 메인 페이지
// ──────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const { summary, dailyStats, marketStats } = getDashboardData();
  const recentOrders = listOrders({ limit: 20 });
  const openPositions = getOpenPositions();

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* 헤더 */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-zinc-900">
                업비트 AI 자동매매 대시보드
              </h1>
              <p className="mt-1 text-xs text-zinc-400">
                모의 운영 &middot; 마지막 갱신: {new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/backtest"
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition"
              >
                백테스트
              </Link>
              <Link
                href="/review"
                className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition"
              >
                2차 통합 리뷰
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

      {/* 콘텐츠 */}
      <main className="mx-auto max-w-7xl px-6 py-8 space-y-10">
        <SummarySection s={summary} />
        <OpenPositionsSection positions={openPositions} />

        <div className="grid lg:grid-cols-2 gap-10">
          <DailyStatsTable stats={dailyStats} />
          <MarketStatsTable stats={marketStats} />
        </div>

        <RecentOrdersSection orders={recentOrders} />
        <TransitionChecklist />
      </main>

      {/* 푸터 */}
      <footer className="border-t border-zinc-200 bg-white mt-10">
        <div className="mx-auto max-w-7xl px-6 py-4 text-center text-xs text-zinc-400">
          AI 자동매매 시스템 &middot; 모의 운영 모드 &middot; 실제 자금 거래 아님
        </div>
      </footer>
    </div>
  );
}
