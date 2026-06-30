'use client';

import { useEffect, useState } from 'react';

interface PaperStrategy {
  id: string;
  name: string;
  description: string;
  rule: string;
  capitalAlloc: number;
  cash: number;
  positionValue: number;
  totalEquity: number;
  returnRate: number;
  totalTrades: number;
  totalRealizedPnl: number;
  positions: Array<{
    market: string;
    entryDate: string;
    entryPrice: number;
    currentPrice: number;
    vol: number;
    profitRate: number;
    profitKrw: number;
    daysHeld: number;
  }>;
  lastTickAt: string | null;
}

interface PaperApiResponse {
  strategies: PaperStrategy[];
  total: { capitalAlloc: number; totalEquity: number; returnRate: number };
  now: string;
}

function fmtKrw(n: number): string {
  return Math.round(n).toLocaleString() + '원';
}

function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}억`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
  return n.toLocaleString();
}

function fmtPct(n: number, withSign = true): string {
  const sign = n >= 0 ? '+' : '';
  return `${withSign ? sign : ''}${n.toFixed(2)}%`;
}

export default function Dashboard() {
  const [paperData, setPaperData] = useState<PaperApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchData() {
    try {
      const res = await fetch('/api/paper-trading', { cache: 'no-store' });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const json = await res.json();
      setPaperData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="p-8 text-zinc-700">로딩 중...</div>;
  if (error) return <div className="p-8 text-rose-600">에러: {error}</div>;
  if (!paperData) return null;

  const total = paperData.total;
  const totalProfit = total.totalEquity - total.capitalAlloc;

  return (
    <div className="min-h-screen bg-zinc-100">
      {/* 헤더 */}
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-zinc-900">Paper Strategies</h1>
            <p className="text-[10px] text-zinc-500">각 1,000만원 독립 운영 · 30초 자동 갱신</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        {/* 총합 */}
        <section className="rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 p-6 text-white shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-300">
                  운영 중 · F1F2 KST 11:00 / F6·F6_v2·F6_v3 매 4h
                </span>
              </div>
              <p className="mt-2 text-3xl font-bold tabular-nums">{fmtKrw(total.totalEquity)}</p>
              <p className="mt-1 text-xs text-zinc-400">시작 자본 {fmtKrw(total.capitalAlloc)}</p>
            </div>

            <div className="text-right">
              <p className="text-xs text-zinc-400 uppercase tracking-wider">수익률</p>
              <p className={`text-3xl font-bold tabular-nums ${total.returnRate > 0 ? 'text-emerald-400' : total.returnRate < 0 ? 'text-rose-400' : 'text-zinc-300'}`}>
                {fmtPct(total.returnRate)}
              </p>
              <p className={`mt-1 text-xs tabular-nums ${totalProfit > 0 ? 'text-emerald-400' : totalProfit < 0 ? 'text-rose-400' : 'text-zinc-400'}`}>
                {totalProfit >= 0 ? '+' : ''}{fmtKrw(totalProfit)}
              </p>
            </div>
          </div>
        </section>

        {/* Paper Strategies 카드 그리드 */}
        {paperData.strategies.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-zinc-900 mb-3">전략별 현황</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {paperData.strategies.map((s) => {
                const profitPositive = s.returnRate >= 0;
                return (
                  <div key={s.id} className="bg-white border border-zinc-200 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono font-semibold text-zinc-500">{s.id}</span>
                          <span className="font-bold text-zinc-900 truncate">{s.name}</span>
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">{s.description}</p>
                        <p className="text-[10px] font-mono text-zinc-400 mt-0.5">{s.rule}</p>
                      </div>
                      <div className={`text-lg font-bold tabular-nums shrink-0 ${profitPositive ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {fmtPct(s.returnRate)}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs mt-3">
                      <div>
                        <p className="text-[9px] text-zinc-500 uppercase">자산</p>
                        <p className="font-mono font-semibold tabular-nums">{fmtKrw(s.totalEquity)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-zinc-500 uppercase">손익</p>
                        <p className={`font-mono font-semibold tabular-nums ${(s.totalEquity - s.capitalAlloc) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {(s.totalEquity - s.capitalAlloc) >= 0 ? '+' : ''}{fmtKrw(s.totalEquity - s.capitalAlloc)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[9px] text-zinc-500 uppercase">현금</p>
                        <p className="font-mono tabular-nums text-zinc-700">{fmtCompact(s.cash)}원</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-zinc-500 uppercase">실현 / 거래</p>
                        <p className="font-mono tabular-nums text-zinc-700">{(s.totalRealizedPnl >= 0 ? '+' : '')}{fmtCompact(s.totalRealizedPnl)}원 / {s.totalTrades}건</p>
                      </div>
                    </div>

                    {s.positions.length > 0 ? (
                      <div className="mt-3 pt-3 border-t border-zinc-100">
                        <p className="text-[9px] text-zinc-500 uppercase mb-1">보유 ({s.positions.length}종)</p>
                        <div className="space-y-1">
                          {s.positions.map((pos, i) => (
                            <div key={i} className="flex justify-between text-[11px]">
                              <span className="text-zinc-700">{pos.market.replace('KRW-', '')} <span className="text-zinc-400">·{pos.daysHeld}일</span></span>
                              <span className={`font-semibold tabular-nums ${pos.profitRate >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                {fmtPct(pos.profitRate)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 pt-3 border-t border-zinc-100">
                        <p className="text-[10px] text-zinc-400">보유 없음 (cash)</p>
                        {s.lastTickAt && (
                          <p className="text-[9px] text-zinc-400 mt-0.5">마지막 tick: {new Date(s.lastTickAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-7xl px-6 py-4 text-center text-[10px] text-zinc-400">
        paper trading · 실제 자금 거래 아님 · F1F2: KST 11:00 / 1일 1회 · F6 / F6_v2 / F6_v3: 매 4h KST
      </footer>
    </div>
  );
}
