'use client';

/**
 * 전략별 과거 기록 패널 — /api/paper-trading/history
 *
 *   1) tick 커버리지: 기대 tick 슬롯을 라이브 / 백필 / 결손 으로 칠한 격자 (cron 구멍 눈으로 확인)
 *   2) 실현 자산 곡선: 청산 손익 누적 (tick 에 평가액이 없어 실현 기준)
 *   3) 거래 내역: 청산된 거래 전체
 *
 * 시각은 API 가 epoch ms(UTC) 로 주고 여기서 KST 로 포맷한다.
 */

import { useEffect, useMemo, useState } from 'react';

const KST_OFFSET = 9 * 3600_000;
const DAY = 86400_000;

type SlotMode = 'live' | 'backfill' | 'missing';

interface HistoryTrade {
  market: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  profitRate: number;
  profitKrw: number;
  reason: string;
}

interface HistoryStrategy {
  id: string;
  name: string;
  description: string;
  initial: number;
  stepMs: number;
  slotsPerDay: number;
  trades: HistoryTrade[];
  equityCurve: Array<{ ts: number; equity: number }>;
  coverage: {
    from: number;
    to: number;
    expected: number;
    live: number;
    backfilled: number;
    missing: number;
    slots: Array<{ ts: number; mode: SlotMode }>;
  };
}

const SLOT_STYLE: Record<SlotMode, { cls: string; label: string }> = {
  live: { cls: 'bg-emerald-500', label: '라이브' },
  backfill: { cls: 'bg-sky-500', label: '백필' },
  missing: { cls: 'bg-rose-300', label: '결손' },
};

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function kstDate(ts: number): Date {
  return new Date(ts + KST_OFFSET);
}

function fmtDateTime(ts: number): string {
  const d = kstDate(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtDate(ts: number): string {
  const d = kstDate(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}억`;
  if (abs >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`;
  return Math.round(n).toLocaleString();
}

/** KST 날짜별로 슬롯 묶기 (하루 = slotsPerDay 칸) */
function groupByDay(slots: Array<{ ts: number; mode: SlotMode }>, stepMs: number, slotsPerDay: number) {
  const days = new Map<string, { label: string; weekday: number; cells: Array<{ ts: number; mode: SlotMode } | null> }>();
  for (const s of slots) {
    const d = kstDate(s.ts);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    if (!days.has(key)) {
      days.set(key, { label: fmtDate(s.ts), weekday: d.getUTCDay(), cells: Array(slotsPerDay).fill(null) });
    }
    const msIntoDay = d.getUTCHours() * 3600_000 + d.getUTCMinutes() * 60_000;
    const col = Math.min(slotsPerDay - 1, Math.floor(msIntoDay / stepMs));
    days.get(key)!.cells[col] = s;
  }
  return [...days.values()];
}

/** 컬럼별 대표 시각 라벨 (예: 4h → 00 04 08 12 16 20) */
function slotHourLabels(slots: Array<{ ts: number }>, stepMs: number, slotsPerDay: number): string[] {
  const labels = Array<string>(slotsPerDay).fill('');
  for (const s of slots) {
    const d = kstDate(s.ts);
    const msIntoDay = d.getUTCHours() * 3600_000 + d.getUTCMinutes() * 60_000;
    const col = Math.min(slotsPerDay - 1, Math.floor(msIntoDay / stepMs));
    if (!labels[col]) labels[col] = String(d.getUTCHours()).padStart(2, '0');
  }
  return labels;
}

function EquityChart({ strategy }: { strategy: HistoryStrategy }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = strategy.equityCurve;

  const W = 720, H = 180, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 18;
  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const xs = pts.map((p) => p.ts);
    const ys = pts.map((p) => p.equity);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const lo = Math.min(...ys, strategy.initial), hi = Math.max(...ys, strategy.initial);
    const padY = (hi - lo) * 0.12 || strategy.initial * 0.01;
    const yLo = lo - padY, yHi = hi + padY;
    const sx = (ts: number) => PAD_L + ((ts - x0) / Math.max(1, x1 - x0)) * (W - PAD_L - PAD_R);
    const sy = (v: number) => PAD_T + (1 - (v - yLo) / Math.max(1, yHi - yLo)) * (H - PAD_T - PAD_B);
    return { sx, sy, x0, x1, yLo, yHi };
  }, [pts, strategy.initial]);

  if (!geom) {
    return <p className="text-[11px] text-zinc-400 py-8 text-center">청산 거래가 없어 곡선을 그릴 수 없음</p>;
  }

  const { sx, sy } = geom;
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.ts).toFixed(1)},${sy(p.equity).toFixed(1)}`).join(' ');
  const base = sy(strategy.initial);
  const last = pts[pts.length - 1];
  const up = last.equity >= strategy.initial;
  const hp = hover !== null ? pts[hover] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(sx(p.ts) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[180px]"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* 시작 자본 기준선 */}
        <line x1={PAD_L} x2={W - PAD_R} y1={base} y2={base} stroke="#d4d4d8" strokeWidth={1} strokeDasharray="4 4" />
        <text x={W - PAD_R} y={base - 4} textAnchor="end" className="fill-zinc-400" fontSize={9}>
          시작 {fmtCompact(strategy.initial)}원
        </text>

        <path d={line} fill="none" stroke={up ? '#059669' : '#e11d48'} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {hp && (
          <>
            <line x1={sx(hp.ts)} x2={sx(hp.ts)} y1={PAD_T} y2={H - PAD_B} stroke="#a1a1aa" strokeWidth={1} />
            <circle cx={sx(hp.ts)} cy={sy(hp.equity)} r={4.5} fill="#fff" stroke={up ? '#059669' : '#e11d48'} strokeWidth={2} />
          </>
        )}

        <text x={PAD_L} y={H - 4} className="fill-zinc-400" fontSize={9}>{fmtDate(pts[0].ts)}</text>
        <text x={W - PAD_R} y={H - 4} textAnchor="end" className="fill-zinc-400" fontSize={9}>{fmtDate(last.ts)}</text>
      </svg>

      {hp && (
        <div
          className="pointer-events-none absolute top-1 rounded-md bg-zinc-900/95 px-2 py-1 text-[10px] text-white shadow"
          style={{ left: `${(sx(hp.ts) / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div className="tabular-nums">{fmtDateTime(hp.ts)}</div>
          <div className="tabular-nums font-semibold">{Math.round(hp.equity).toLocaleString()}원</div>
          <div className={`tabular-nums ${hp.equity >= strategy.initial ? 'text-emerald-300' : 'text-rose-300'}`}>
            {hp.equity >= strategy.initial ? '+' : ''}{((hp.equity - strategy.initial) / strategy.initial * 100).toFixed(2)}%
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageGrid({ strategy }: { strategy: HistoryStrategy }) {
  const { coverage, stepMs, slotsPerDay } = strategy;
  const days = useMemo(
    () => groupByDay(coverage.slots, stepMs, slotsPerDay),
    [coverage.slots, stepMs, slotsPerDay],
  );

  const hourLabels = useMemo(
    () => slotHourLabels(coverage.slots, stepMs, slotsPerDay),
    [coverage.slots, stepMs, slotsPerDay],
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 text-[10px] mb-2">
        {(['live', 'backfill', 'missing'] as SlotMode[]).map((m) => (
          <span key={m} className="flex items-center gap-1 text-zinc-600">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${SLOT_STYLE[m].cls}`} />
            {SLOT_STYLE[m].label}
            <span className="tabular-nums font-semibold text-zinc-800">
              {m === 'live' ? coverage.live : m === 'backfill' ? coverage.backfilled : coverage.missing}
            </span>
          </span>
        ))}
        <span className="text-zinc-400">/ 기대 {coverage.expected}틱 (최근 3주)</span>
        {coverage.missing === 0 && <span className="text-emerald-600 font-semibold">결손 없음</span>}
      </div>

      <div className="max-w-[420px] space-y-[3px]">
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0" />
          <div className="flex gap-[3px] flex-1">
            {hourLabels.map((h, i) => (
              <span key={i} className="flex-1 text-center text-[8px] tabular-nums text-zinc-400">{h}시</span>
            ))}
          </div>
        </div>
        {days.map((d) => (
          <div key={d.label} className="flex items-center gap-2">
            <span className={`w-14 shrink-0 text-[9px] tabular-nums ${d.weekday === 0 ? 'text-rose-400' : 'text-zinc-400'}`}>
              {d.label} {WEEKDAY[d.weekday]}
            </span>
            <div className="flex gap-[3px] flex-1">
              {d.cells.map((c, i) => (
                <div
                  key={i}
                  title={c ? `${fmtDateTime(c.ts)} · ${SLOT_STYLE[c.mode].label}` : '운영 구간 밖'}
                  className={`h-3 flex-1 rounded-[2px] ${c ? SLOT_STYLE[c.mode].cls : 'bg-zinc-100'}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradeTable({ strategy }: { strategy: HistoryStrategy }) {
  const daily = strategy.stepMs >= DAY;
  const fmt = daily ? fmtDate : fmtDateTime;
  const rows = useMemo(() => [...strategy.trades].sort((a, b) => b.exitTs - a.exitTs), [strategy.trades]);

  if (!rows.length) return <p className="text-[11px] text-zinc-400 py-6 text-center">청산된 거래 없음</p>;

  return (
    <div className="max-h-[320px] overflow-y-auto overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-white">
          <tr className="text-[9px] uppercase text-zinc-400 border-b border-zinc-200">
            <th className="text-left font-medium py-1 pr-2">코인</th>
            <th className="text-left font-medium py-1 pr-2">진입 (KST)</th>
            <th className="text-left font-medium py-1 pr-2">청산 (KST)</th>
            <th className="text-right font-medium py-1 pr-2">진입가</th>
            <th className="text-right font-medium py-1 pr-2">청산가</th>
            <th className="text-right font-medium py-1 pr-2">수익률</th>
            <th className="text-right font-medium py-1 pr-2">손익</th>
            <th className="text-left font-medium py-1">사유</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((t, i) => (
            <tr key={i} className="border-b border-zinc-50 hover:bg-zinc-50">
              <td className="py-1 pr-2 font-medium text-zinc-800">{t.market.replace('KRW-', '')}</td>
              <td className="py-1 pr-2 text-zinc-500">{fmt(t.entryTs)}</td>
              <td className="py-1 pr-2 text-zinc-500">{fmt(t.exitTs)}</td>
              <td className="py-1 pr-2 text-right text-zinc-600">{t.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className="py-1 pr-2 text-right text-zinc-600">{t.exitPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className={`py-1 pr-2 text-right font-semibold ${t.profitRate >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {t.profitRate >= 0 ? '+' : ''}{t.profitRate.toFixed(2)}%
              </td>
              <td className={`py-1 pr-2 text-right ${t.profitKrw >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {t.profitKrw >= 0 ? '+' : ''}{fmtCompact(t.profitKrw)}원
              </td>
              <td className="py-1 text-zinc-500">{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PaperHistory() {
  const [data, setData] = useState<HistoryStrategy[] | null>(null);
  const [selected, setSelected] = useState<string>('F6');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/paper-trading/history', { cache: 'no-store' });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const json = await res.json();
        if (alive) { setData(json.strategies); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (error) return <p className="text-[11px] text-rose-600">히스토리 로드 실패: {error}</p>;
  if (!data) return <p className="text-[11px] text-zinc-400">히스토리 로딩 중...</p>;
  if (!data.length) return <p className="text-[11px] text-zinc-400">과거 기록 없음</p>;

  const s = data.find((x) => x.id === selected) ?? data[0];
  const realized = s.equityCurve.length ? s.equityCurve[s.equityCurve.length - 1].equity - s.initial : 0;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h2 className="text-sm font-bold text-zinc-900">
          과거 기록 <span className="font-mono text-zinc-500">· {s.id}</span>
        </h2>
        <div className="flex flex-wrap gap-1">
          {data.map((x) => (
            <button
              key={x.id}
              onClick={() => setSelected(x.id)}
              className={`px-2 py-1 rounded-md text-[10px] font-mono font-semibold border transition-colors ${
                x.id === s.id
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-400'
              }`}
            >
              {x.id}
              {x.coverage.missing > 0 && (
                <span className={`ml-1 ${x.id === s.id ? 'text-rose-300' : 'text-rose-500'}`}>●</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-zinc-600 mb-3">{s.description}</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-white border border-zinc-200 rounded-xl p-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-[11px] font-semibold text-zinc-700">실현 자산 곡선</h3>
            <span className={`text-[11px] font-semibold tabular-nums ${realized >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              실현 {realized >= 0 ? '+' : ''}{fmtCompact(realized)}원 · {s.trades.length}건
            </span>
          </div>
          <EquityChart strategy={s} />
          <p className="text-[9px] text-zinc-400 mt-1">tick 에 평가액 기록이 없어 청산 손익 누적(실현) 기준. 보유 중 평가손익은 위 카드 참고.</p>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-4">
          <h3 className="text-[11px] font-semibold text-zinc-700 mb-2">tick 커버리지</h3>
          <CoverageGrid strategy={s} />
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-4 lg:col-span-2">
          <h3 className="text-[11px] font-semibold text-zinc-700 mb-2">거래 내역 ({s.trades.length}건)</h3>
          <TradeTable strategy={s} />
        </div>
      </div>
    </section>
  );
}
