'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { BacktestResult, BacktestTrade, PeriodStats, EquityPoint } from '@/types/backtest';

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function pct(n: number, decimals = 2): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-emerald-600';
  if (n < 0) return 'text-rose-600';
  return 'text-zinc-500';
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ──────────────────────────────────────────────
// SVG 에퀴티 커브
// ──────────────────────────────────────────────

function EquityChart({ data }: { data: EquityPoint[] }) {
  if (data.length < 2) return <div className="text-center text-zinc-400 py-10">데이터 부족</div>;

  const W = 800;
  const H = 200;
  const PAD = { top: 16, right: 16, bottom: 32, left: 72 };

  const minEq = Math.min(...data.map((d) => d.equity));
  const maxEq = Math.max(...data.map((d) => d.equity));
  const eqRange = maxEq - minEq || 1;

  const toX = (i: number) =>
    PAD.left + ((i / (data.length - 1)) * (W - PAD.left - PAD.right));
  const toY = (eq: number) =>
    PAD.top + ((1 - (eq - minEq) / eqRange) * (H - PAD.top - PAD.bottom));

  const points = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.equity).toFixed(1)}`).join(' ');
  const fillPoints = [
    `${toX(0).toFixed(1)},${(H - PAD.bottom).toFixed(1)}`,
    ...data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.equity).toFixed(1)}`),
    `${toX(data.length - 1).toFixed(1)},${(H - PAD.bottom).toFixed(1)}`,
  ].join(' ');

  const initial = data[0].equity;
  const isPositive = data[data.length - 1].equity >= initial;

  // Y축 레이블 (4 레벨)
  const yLabels = [0, 1, 2, 3].map((i) => {
    const val = minEq + (eqRange * (3 - i)) / 3;
    const y = toY(val);
    return { val, y };
  });

  // X축 레이블 (5 포인트)
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((r) => {
    const idx = Math.round(r * (data.length - 1));
    return { x: toX(idx), label: data[idx].time.slice(0, 10) };
  });

  const strokeColor = isPositive ? '#059669' : '#e11d48';
  const fillColor = isPositive ? '#d1fae5' : '#ffe4e6';

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: '200px' }}
      preserveAspectRatio="none"
    >
      {/* 그리드 */}
      {yLabels.map(({ y }, i) => (
        <line
          key={i}
          x1={PAD.left}
          y1={y}
          x2={W - PAD.right}
          y2={y}
          stroke="#e4e4e7"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
      ))}

      {/* 기준선 (초기 자본) */}
      <line
        x1={PAD.left}
        y1={toY(initial)}
        x2={W - PAD.right}
        y2={toY(initial)}
        stroke="#94a3b8"
        strokeWidth="1"
        strokeDasharray="6 3"
      />

      {/* 채우기 */}
      <polygon points={fillPoints} fill={fillColor} opacity="0.6" />

      {/* 라인 */}
      <polyline
        points={points}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
      />

      {/* Y축 레이블 */}
      {yLabels.map(({ val, y }, i) => (
        <text
          key={i}
          x={PAD.left - 6}
          y={y + 4}
          textAnchor="end"
          fontSize="10"
          fill="#71717a"
        >
          {(val / 10000).toFixed(0)}만
        </text>
      ))}

      {/* X축 레이블 */}
      {xLabels.map(({ x, label }, i) => (
        <text
          key={i}
          x={x}
          y={H - 4}
          textAnchor="middle"
          fontSize="10"
          fill="#71717a"
        >
          {label}
        </text>
      ))}
    </svg>
  );
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
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color ?? 'text-zinc-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

// ──────────────────────────────────────────────
// 거래 내역 테이블
// ──────────────────────────────────────────────

function TradeTable({ trades }: { trades: BacktestTrade[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (trades.length === 0) {
    return <p className="text-sm text-zinc-400 py-4">거래 없음</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-zinc-500 text-xs">
            <th className="py-2 pr-4 text-left font-medium">#</th>
            <th className="py-2 pr-4 text-left font-medium">진입</th>
            <th className="py-2 pr-4 text-left font-medium">청산</th>
            <th className="py-2 pr-4 text-right font-medium">진입가</th>
            <th className="py-2 pr-4 text-right font-medium">청산가</th>
            <th className="py-2 pr-4 text-right font-medium">수익률</th>
            <th className="py-2 pr-4 text-right font-medium">손익(KRW)</th>
            <th className="py-2 text-right font-medium">보유(캔들)</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <>
              <tr
                key={i}
                className="border-b border-zinc-100 hover:bg-zinc-50 cursor-pointer"
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <td className="py-2 pr-4 text-zinc-400">{i + 1}</td>
                <td className="py-2 pr-4 tabular-nums text-xs text-zinc-600">
                  {t.entryTime.slice(0, 16)}
                </td>
                <td className="py-2 pr-4 tabular-nums text-xs text-zinc-600">
                  {t.exitTime.slice(0, 16)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt(Math.round(t.entryPrice))}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt(Math.round(t.exitPrice))}</td>
                <td className={`py-2 pr-4 text-right tabular-nums font-medium ${pnlColor(t.profitRate)}`}>
                  {pct(t.profitRate)}
                </td>
                <td className={`py-2 pr-4 text-right tabular-nums ${pnlColor(t.profit)}`}>
                  {t.profit > 0 ? '+' : ''}{fmt(t.profit)}
                </td>
                <td className="py-2 text-right text-zinc-500">{t.holdingPeriod}</td>
              </tr>
              {expanded === i && (
                <tr key={`exp-${i}`} className="bg-zinc-50">
                  <td colSpan={8} className="px-4 py-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="font-semibold text-emerald-700 mb-1">매수 판단</p>
                        <p className="text-zinc-600 whitespace-pre-wrap leading-relaxed">
                          {t.entryReasoning || '기록 없음'}
                        </p>
                      </div>
                      <div>
                        <p className="font-semibold text-rose-700 mb-1">매도 판단</p>
                        <p className="text-zinc-600 whitespace-pre-wrap leading-relaxed">
                          {t.exitReasoning || '기록 없음'}
                        </p>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────
// 기간별 통계 테이블
// ──────────────────────────────────────────────

function PeriodTable({ stats, label }: { stats: PeriodStats[]; label: string }) {
  if (stats.length === 0) {
    return <p className="text-sm text-zinc-400 py-2">데이터 없음</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-zinc-500 text-xs">
            <th className="py-2 pr-4 text-left font-medium">{label}</th>
            <th className="py-2 pr-4 text-right font-medium">거래</th>
            <th className="py-2 pr-4 text-right font-medium">승/패</th>
            <th className="py-2 pr-4 text-right font-medium">승률</th>
            <th className="py-2 pr-4 text-right font-medium">손익(KRW)</th>
            <th className="py-2 text-right font-medium">자산</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i} className="border-b border-zinc-100 hover:bg-zinc-50">
              <td className="py-2 pr-4 font-mono text-xs">{s.period}</td>
              <td className="py-2 pr-4 text-right">{s.tradeCount}</td>
              <td className="py-2 pr-4 text-right text-xs">
                <span className="text-emerald-600">{s.winCount}승</span>
                <span className="text-zinc-400 mx-1">/</span>
                <span className="text-rose-600">{s.lossCount}패</span>
              </td>
              <td className={`py-2 pr-4 text-right font-medium ${s.winRate >= 50 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {s.winRate.toFixed(1)}%
              </td>
              <td className={`py-2 pr-4 text-right tabular-nums ${pnlColor(s.profit)}`}>
                {s.profit > 0 ? '+' : ''}{fmt(s.profit)}
              </td>
              <td className="py-2 text-right tabular-nums text-xs text-zinc-600">
                {fmt(s.equity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────
// 설정 폼
// ──────────────────────────────────────────────

const MARKETS = [
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE',
  'KRW-ADA', 'KRW-AVAX', 'KRW-DOT', 'KRW-MATIC', 'KRW-LINK',
];

const CANDLE_UNITS = [
  { value: 1, label: '1분' },
  { value: 3, label: '3분' },
  { value: 5, label: '5분' },
  { value: 10, label: '10분' },
  { value: 15, label: '15분' },
  { value: 30, label: '30분' },
  { value: 60, label: '60분' },
  { value: 240, label: '240분' },
];

interface FormState {
  market: string;
  startDate: string;
  endDate: string;
  initialCapital: string;
  candleUnit: string;
  lookbackCandles: string;
}

function defaultForm(): FormState {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 16);
  return {
    market: 'KRW-BTC',
    startDate: fmt(start),
    endDate: fmt(end),
    initialCapital: '10000000',
    candleUnit: '5',
    lookbackCandles: '200',
  };
}

// ──────────────────────────────────────────────
// 메인 페이지
// ──────────────────────────────────────────────

export default function BacktestPage() {
  const [form, setForm] = useState<FormState>(defaultForm());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [activeTab, setActiveTab] = useState<'equity' | 'trades' | 'daily' | 'weekly'>('equity');

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market: form.market,
          startDate: new Date(form.startDate).toISOString(),
          endDate: new Date(form.endDate).toISOString(),
          initialCapital: Number(form.initialCapital),
          candleUnit: Number(form.candleUnit),
          lookbackCandles: Number(form.lookbackCandles),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '알 수 없는 오류');
      } else {
        setResult(data as BacktestResult);
        setActiveTab('equity');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const r = result;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900">백테스트</h1>
            <p className="text-xs text-zinc-500 mt-0.5">과거 캔들 데이터로 전략 성과 시뮬레이션</p>
          </div>
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
            ← 대시보드
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* 설정 폼 */}
        <section className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-zinc-800 mb-5">백테스트 설정</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* 마켓 */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">마켓</label>
              <select
                name="market"
                value={form.market}
                onChange={handleChange}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                {MARKETS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* 캔들 단위 */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">캔들 단위</label>
              <select
                name="candleUnit"
                value={form.candleUnit}
                onChange={handleChange}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                {CANDLE_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </div>

            {/* 초기 자본 */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">초기 자본 (KRW)</label>
              <input
                type="number"
                name="initialCapital"
                value={form.initialCapital}
                onChange={handleChange}
                min={100000}
                step={1000000}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            {/* 시작일 */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">시작일</label>
              <input
                type="datetime-local"
                name="startDate"
                value={form.startDate}
                onChange={handleChange}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            {/* 종료일 */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">종료일</label>
              <input
                type="datetime-local"
                name="endDate"
                value={form.endDate}
                onChange={handleChange}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            {/* lookback */}
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">
                Lookback 캔들 수
                <span className="ml-1 text-zinc-400">(MA 계산용)</span>
              </label>
              <input
                type="number"
                name="lookbackCandles"
                value={form.lookbackCandles}
                onChange={handleChange}
                min={60}
                max={500}
                step={10}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            {/* 실행 버튼 */}
            <div className="lg:col-span-3 flex items-center gap-4 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2.5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? '실행 중...' : '백테스트 실행'}
              </button>
              {loading && (
                <p className="text-sm text-zinc-500 animate-pulse">
                  캔들 데이터 수집 및 시뮬레이션 중입니다. 기간에 따라 수 분이 소요될 수 있습니다.
                </p>
              )}
            </div>
          </form>
        </section>

        {/* 에러 */}
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            오류: {error}
          </div>
        )}

        {/* 결과 */}
        {r && (
          <>
            {/* 실행 메타 */}
            <div className="text-xs text-zinc-400 flex gap-4 flex-wrap">
              <span>마켓: <strong className="text-zinc-600">{r.config.market}</strong></span>
              <span>캔들: <strong className="text-zinc-600">{r.config.candleUnit}분</strong></span>
              <span>기간: <strong className="text-zinc-600">{r.config.startDate.slice(0, 10)} ~ {r.config.endDate.slice(0, 10)}</strong></span>
              <span>총 캔들: <strong className="text-zinc-600">{fmt(r.totalCandles)}개</strong></span>
              <span>평가 스텝: <strong className="text-zinc-600">{fmt(r.evaluatedSteps)}개</strong></span>
              <span>실행 시간: <strong className="text-zinc-600">{fmtDuration(r.durationMs)}</strong></span>
            </div>

            {/* KPI 카드 */}
            <section>
              <h2 className="text-base font-semibold text-zinc-800 mb-4">성과 요약</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                <KpiCard
                  label="총 수익률"
                  value={pct(r.totalReturnRate)}
                  sub={`${r.totalProfit > 0 ? '+' : ''}${fmt(r.totalProfit)} KRW`}
                  color={pnlColor(r.totalReturnRate)}
                />
                <KpiCard
                  label="연환산 수익률"
                  value={pct(r.annualizedReturn)}
                  color={pnlColor(r.annualizedReturn)}
                />
                <KpiCard
                  label="최종 자산"
                  value={`${fmt(r.finalEquity)} KRW`}
                  sub={`초기 ${fmt(r.initialCapital)} KRW`}
                />
                <KpiCard
                  label="승률"
                  value={`${r.winRate.toFixed(1)}%`}
                  sub={`${r.winCount}승 / ${r.lossCount}패`}
                  color={r.winRate >= 50 ? 'text-emerald-600' : 'text-rose-600'}
                />
                <KpiCard
                  label="총 거래"
                  value={`${r.tradeCount}건`}
                  sub={`총 수수료 ${fmt(r.totalFees)} KRW`}
                />
                <KpiCard
                  label="손익비"
                  value={isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}
                  sub={`평균 수익 ${pct(r.avgWinRate)} / 손실 ${pct(r.avgLossRate)}`}
                  color={r.profitFactor >= 1 ? 'text-emerald-600' : 'text-rose-600'}
                />
                <KpiCard
                  label="최대 낙폭 (MDD)"
                  value={pct(-r.maxDrawdown)}
                  sub={`${r.maxDrawdownDuration}캔들 지속`}
                  color={r.maxDrawdown > 20 ? 'text-rose-600' : r.maxDrawdown > 10 ? 'text-amber-600' : 'text-zinc-900'}
                />
                <KpiCard
                  label="샤프 비율"
                  value={r.sharpeRatio.toFixed(2)}
                  color={r.sharpeRatio >= 1 ? 'text-emerald-600' : r.sharpeRatio >= 0 ? 'text-zinc-900' : 'text-rose-600'}
                />
                <KpiCard
                  label="평균 수익률"
                  value={pct(r.avgProfitRate)}
                  color={pnlColor(r.avgProfitRate)}
                />
                <KpiCard
                  label="최고 거래"
                  value={pct(r.bestTradeRate)}
                  color="text-emerald-600"
                />
                <KpiCard
                  label="최악 거래"
                  value={pct(r.worstTradeRate)}
                  color="text-rose-600"
                />
                <KpiCard
                  label="평균 보유기간"
                  value={`${r.avgHoldingPeriod}캔들`}
                  sub={`≈ ${Math.round(r.avgHoldingPeriod * r.config.candleUnit / 60)}시간`}
                />
              </div>
            </section>

            {/* 탭 */}
            <section className="bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden">
              <div className="flex border-b border-zinc-200">
                {([
                  { key: 'equity', label: '에퀴티 커브' },
                  { key: 'trades', label: `거래 내역 (${r.tradeCount}건)` },
                  { key: 'daily', label: `일별 통계 (${r.dailyStats.length}일)` },
                  { key: 'weekly', label: `주별 통계 (${r.weeklyStats.length}주)` },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === tab.key
                        ? 'border-zinc-900 text-zinc-900'
                        : 'border-transparent text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="p-6">
                {activeTab === 'equity' && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-4">
                      총 {r.equityCurve.length}개 포인트 (전체 {r.evaluatedSteps}스텝 중 샘플링)
                    </p>
                    <EquityChart data={r.equityCurve} />
                  </div>
                )}
                {activeTab === 'trades' && <TradeTable trades={r.trades} />}
                {activeTab === 'daily' && <PeriodTable stats={r.dailyStats} label="날짜" />}
                {activeTab === 'weekly' && <PeriodTable stats={r.weeklyStats} label="주" />}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
