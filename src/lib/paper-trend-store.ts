/**
 * 일봉 추세추종 계열 paper store — 설정 테이블 하나로 세 변형 (2026-10-02, docs/RESEARCH-LOG.md 3·4라운드).
 *
 *   BTC_TREND  BTC 일봉 종가 > SMA50 이면 100% 보유, 아래면 현금 (축 E · 기준 전략)
 *   BTC_ENS    SMA 10/20/50/100/200 중 종가가 위에 있는 개수 k → 보유 비중 k/5 (축 H · 판정 지연에 강한 개량판)
 *   ETH_TREND  ETH 자기 SMA50 으로 같은 규칙 (축 I · ETH 사후선택 위험 있는 통제군)
 *
 * 매일 KST 09:02, 직전 확정 일봉 기준으로 목표 비중을 정하고 현재 비중과 다르면 차액만 시장가로 매매한다.
 * 근거: BTC_TREND 2018~ 동일위험 209%(보유 39%), BTC_ENS 270%·1일 지연 시 227%(SMA50 은 93%), ETH_TREND 단독 336%.
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const TREND_INITIAL_CASH_KRW = 10_000_000;
export const TREND_FEE = 0.0005;
export const TREND_SLIPPAGE = 0.0005;
export const TREND_TICK_MINUTE = 2;           // KST 09:02 — 일봉 경계(09:00) 직후
export const TREND_MAX_BARS = 0;              // 시간청산 없음 (paper-asof 호환)

export interface TrendVariant { id: 'BTC_TREND' | 'BTC_ENS' | 'ETH_TREND' | 'BTC_TREND_AI'; name: string; market: string; mode: 'sma50' | 'ens'; dir: string; aiFilter?: boolean }
const dirOf = (d: string) => path.resolve(process.cwd(), 'data', d);
export const TREND_VARIANTS: TrendVariant[] = [
  { id: 'BTC_TREND', name: 'BTC_TREND (BTC 50일선)',       market: 'KRW-BTC', mode: 'sma50', dir: dirOf('paper-btctrend') },
  { id: 'BTC_ENS',   name: 'BTC_ENS (BTC 이평 앙상블)',    market: 'KRW-BTC', mode: 'ens',   dir: dirOf('paper-btcens') },
  { id: 'ETH_TREND', name: 'ETH_TREND (ETH 50일선)',       market: 'KRW-ETH', mode: 'sma50', dir: dirOf('paper-ethtrend') },
  // AI 쌍둥이 — BTC_TREND 와 같고 AI 리스크 판단이 비중 상한을 건다(paper-ai-stance.ts). BTC_TREND 가 대조군.
  { id: 'BTC_TREND_AI', name: 'BTC_TREND_AI (BTC 50일선 + AI 리스크)', market: 'KRW-BTC', mode: 'sma50', dir: dirOf('paper-btctrend-ai'), aiFilter: true },
];
export const trendFiles = (v: TrendVariant) => ({
  state: path.join(v.dir, 'state.json'), trades: path.join(v.dir, 'trades.jsonl'), ticks: path.join(v.dir, 'ticks.jsonl'),
});

export interface TrendPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number }
export interface TrendState { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; cash: number; positions: TrendPosition[]; totalTrades: number; totalRealizedPnl: number }

export function readTrendState(v: TrendVariant): TrendState | null {
  const f = trendFiles(v).state;
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}
export async function withTrendState<T>(v: TrendVariant, fn: (s: TrendState) => Promise<T>): Promise<T> {
  if (!fs.existsSync(v.dir)) fs.mkdirSync(v.dir, { recursive: true });
  const f = trendFiles(v).state;
  return withFileLock(f, async () => {
    let st = readTrendState(v);
    if (!st) st = { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, cash: TREND_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
    const r = await fn(st);
    fs.writeFileSync(f, JSON.stringify(st, null, 2));
    return r;
  });
}

const sma = (c: number[], n: number) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
/** closes = 확정 일봉 종가(오래된→최근). 목표 보유 비중 0~1. 데이터 부족이면 null. */
export function trendTarget(v: TrendVariant, closes: number[]): { w: number; close: number; detail: string } | null {
  const close = closes[closes.length - 1];
  if (v.mode === 'sma50') {
    if (closes.length < 50) return null;
    const s = sma(closes, 50);
    return { w: close > s ? 1 : 0, close, detail: `SMA50 ${s.toFixed(0)}` };
  }
  const Ns = [10, 20, 50, 100, 200];
  if (closes.length < 200) return null;
  const above = Ns.filter((n) => close > sma(closes, n)).length;
  return { w: above / Ns.length, close, detail: `${above}/5 이평 위` };
}

/**
 * 목표 비중으로 리밸런싱. px = 체결 기준가(라이브 = 현재가, 백필 = 그날 일봉 시가).
 * 비중 차이가 5%p 미만이면 거래하지 않는다(앙상블의 미세 변동 비용 방지 — 앙상블 비중은 20%p 단위라 실제로는 항상 0 또는 ≥20%p).
 * 반환: 실행한 액션 문자열 + 청산 기록(부분 매도 포함).
 */
export function rebalanceTrend(
  v: TrendVariant, st: TrendState, w: number, px: number, ts: number, kst: (t: number) => string, recordedAt: string,
): { action: string; trade?: object } {
  const pos = st.positions[0];
  const posVal = pos ? pos.vol * px : 0;
  const equity = st.cash + posVal;
  const curW = equity > 0 ? posVal / equity : 0;
  if (Math.abs(w - curW) < 0.05) return { action: 'HOLD' };
  if (w > curW) {
    const spend = Math.min(st.cash, equity * (w - curW));
    if (spend < 5000) return { action: 'HOLD' };
    const ep = px * (1 + TREND_SLIPPAGE);
    const vol = spend * (1 - TREND_FEE) / ep;
    st.cash -= spend;
    if (pos) { pos.entryPrice = (pos.entryPrice * pos.vol + ep * vol) / (pos.vol + vol); pos.vol += vol; pos.cashUsed += spend; }
    else st.positions.push({ market: v.market, entryTs: ts, entryDate: kst(ts), entryPrice: ep, vol, cashUsed: spend, entryBarsRemaining: 0 });
    return { action: `BUY ${(100 * curW).toFixed(0)}→${(100 * w).toFixed(0)}%` };
  }
  // 비중 축소 — 매도 수량 비율만큼 원가(cashUsed)를 같이 덜어 실현손익 계산
  const frac = Math.min(1, (curW - w) / curW);
  const sellVol = pos!.vol * frac;
  const xp = px * (1 - TREND_SLIPPAGE);
  const got = sellVol * xp * (1 - TREND_FEE);
  const basis = pos!.cashUsed * frac;
  const profitKrw = got - basis;
  st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw;
  const trade = {
    market: v.market, entryTs: pos!.entryTs, exitTs: ts, entryDate: pos!.entryDate, exitDate: kst(ts),
    entryPrice: pos!.entryPrice, exitPrice: xp, profitRate: (xp - pos!.entryPrice) / pos!.entryPrice * 100, profitKrw,
    reason: w === 0 ? 'TREND_OFF' : 'TREND_REDUCE', fraction: frac, recordedAt,
  };
  if (frac >= 0.999) st.positions = [];
  else { pos!.vol -= sellVol; pos!.cashUsed -= basis; }
  return { action: `SELL ${(100 * curW).toFixed(0)}→${(100 * w).toFixed(0)}%`, trade };
}
