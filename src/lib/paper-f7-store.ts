/**
 * F7 계열 paper trading store — "체결손실 0" 설계 (2026-10-01, docs/RESEARCH-LOG.md · scripts/_bt_execfree.ts).
 *
 * 업비트의 비대칭: 위로 향한 지정가 매도는 호가창에 미리 걸어둘 수 있어 목표가에 정확히 체결되지만,
 * 아래로 향한 스톱은 API 에 없어 폴링 후 시장가뿐이다. 그래서 아래쪽 트리거를 쓰지 않는다.
 *
 *   F7     TP 지정가 +6% · 3일 시간청산 · 스톱 없음          ← 본 설계
 *   F7_sl  TP 지정가 +6% · 3일 시간청산 · 손절 −2%           ← 손절 유무 하나만 다른 통제군
 *   F7_p   TP 지정가 +4% · 2일 시간청산 · 스톱 없음          ← 고원의 다른 지점 (파라미터 전이 측정)
 *   F7_btc F7 + BTC 가 50일선(4h 300봉 평균) 아래면 신규 진입 안 함 ← 2026-10-02 추가, 국면 탐색(_bt_regime.ts)의 유일한 생존 후보
 *
 * 신호·사이징은 F6 그대로(evaluateF6, 33%×max3). 변형 셋은 이 파일 하나의 설정 테이블로만 다르다 —
 * F6 계열처럼 store 를 복제하지 않는다(복제 탓에 60봉 버그를 7곳에서 고친 적이 있다).
 *
 * 체결 모델 — 백테스트(_bt_execfree.ts)와 같다:
 *   TP   — 진입 직후 지정가 매도가 걸려 있다고 본다. 진입봉 이후 확정봉의 고가가 목표 × (1+0.2%) 를 넘으면
 *          **목표가 그대로** 체결(슬리피지 0, 수수료만). 진입봉 자체는 보지 않는다(진입 전 고가일 수 있음 → 보수적).
 *   SL   — (F7_sl 만) 확정봉 저가가 손절선에 닿으면 **그 봉 종가(=크론이 알아챈 시점 시장가)**에 청산.
 *          스톱 '가격'으로 정산하지 않는다 — 그게 이 통제군이 측정하려는 바로 그 비용이다.
 *   TIME — 진입봉 이후 확정봉 maxBars 개가 지나면 시장가(슬리피지 적용).
 *   같은 봉에서 TP 와 SL 이 둘 다 닿으면 TP 우선(백테스트와 동일).
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';
export { evaluateF6 as evaluateF7Signal, F6_COINS as F7_COINS, type BarLite } from './paper-f6-store';

export const F7_INITIAL_CASH_KRW = 10_000_000;
export const F7_FEE = 0.0005;
export const F7_SLIPPAGE = 0.0005;
export const F7_POSITION_PCT = 0.33;
export const F7_MAX_CONCURRENT = 3;
export const F7_LOOKBACK_BARS = 42;
/** TP 지정가 체결 판정에 요구하는 관통폭. 2026-10-02 재출발부터 0.2% — '닿으면 체결'은 F7 을 120%→45% 로 부풀린다(축 G 반증). */
export const F7_TP_PEN = 0.002;

export interface F7Variant {
  id: 'F7' | 'F7_sl' | 'F7_p' | 'F7_btc';
  name: string;
  dir: string;
  tpPct: number;
  slPct: number | null;   // null = 스톱 없음
  maxBars: number;        // 4h 봉 수 (6봉 = 1일)
  btc50?: boolean;        // true = BTC 가 50일선 아래면 신규 진입 중단(청산은 그대로)
}

const dirOf = (d: string) => path.resolve(process.cwd(), 'data', d);

// 2026-10-02 밤 10개 선정: F7(무스톱)·F7_p 은퇴 — data/_archive/20261002/
export const F7_VARIANTS: F7Variant[] = [
  { id: 'F7_sl', name: 'F7_sl (F7 + 손절 −2%)',        dir: dirOf('paper-f7sl'), tpPct: 6, slPct: -2,   maxBars: 18 },
  { id: 'F7_btc', name: 'F7_btc (F7 + BTC 50일선 필터)', dir: dirOf('paper-f7btc'), tpPct: 6, slPct: null, maxBars: 18, btc50: true },
];

export const f7Files = (v: F7Variant) => ({
  state: path.join(v.dir, 'state.json'),
  trades: path.join(v.dir, 'trades.jsonl'),
  ticks: path.join(v.dir, 'ticks.jsonl'),
});

export interface F7Position {
  market: string;
  entryTs: number;
  entryDate: string;
  entryPrice: number;   // 슬리피지 반영
  vol: number;
  cashUsed: number;
  entryBarsRemaining: number;
}
export interface F7ClosedTrade {
  market: string;
  entryTs: number; exitTs: number;
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;   // exitPrice = 실제 체결가(TP 는 목표가, SL·TIME 은 시장가)
  profitRate: number;
  profitKrw: number;
  reason: 'TP' | 'SL' | 'TIME' | 'MANUAL';
  recordedAt: string;
}
export interface F7State {
  startedAt: string;
  lastTickTs: number | null;
  lastTickAt: string | null;
  cash: number;
  positions: F7Position[];
  totalTrades: number;
  totalRealizedPnl: number;
}

export function readF7State(v: F7Variant): F7State | null {
  const f = f7Files(v).state;
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}
export function emptyF7State(): F7State {
  return { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null,
    cash: F7_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
}
export async function withF7State<T>(v: F7Variant, fn: (state: F7State) => Promise<T>): Promise<T> {
  if (!fs.existsSync(v.dir)) fs.mkdirSync(v.dir, { recursive: true });
  const f = f7Files(v).state;
  return withFileLock(f, async () => {
    let st = readF7State(v);
    if (!st) { st = emptyF7State(); fs.writeFileSync(f, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(f, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF7Trade(v: F7Variant, t: F7ClosedTrade) { fs.appendFileSync(f7Files(v).trades, JSON.stringify(t) + '\n'); }
export function appendF7Tick(v: F7Variant, r: object) { fs.appendFileSync(f7Files(v).ticks, JSON.stringify(r) + '\n'); }

/**
 * 청산 판정. bars = 진입봉 이후의 확정봉(시간순). 무상태·멱등 — 매 tick 진입 이후 전체를 다시 스캔한다.
 * price 는 슬리피지 적용 전 기준가. TP 는 지정가라 호출측이 슬리피지를 붙이지 않는다.
 */
export function evalF7Exit(
  v: F7Variant,
  bars: { ts: number; high: number; low: number; close: number }[],
  entryPrice: number,
): { reason: 'TP' | 'SL' | 'TIME'; price: number; ts: number } | null {
  const target = entryPrice * (1 + v.tpPct / 100);
  const stop = v.slPct == null ? null : entryPrice * (1 + v.slPct / 100);
  for (let k = 0; k < bars.length; k++) {
    const b = bars[k];
    if (b.high >= target * (1 + F7_TP_PEN)) return { reason: 'TP', price: target, ts: b.ts };
    if (stop != null && b.low <= stop) return { reason: 'SL', price: b.close, ts: b.ts };
    if (k + 1 >= v.maxBars) return { reason: 'TIME', price: b.close, ts: b.ts };
  }
  return null;
}

/** 청산 기준가 → 체결가. TP(지정가)만 슬리피지가 없다. */
export const f7FillPrice = (reason: 'TP' | 'SL' | 'TIME', price: number) =>
  reason === 'TP' ? price : price * (1 - F7_SLIPPAGE);

/** BTC 50일선 근사 = 4h 300봉 종가 평균. */
export const F7_BTC_SMA_BARS = 300;
/**
 * idx 봉(확정봉) 종가가 직전 300봉(자신 포함) 평균보다 낮으면 true. 데이터가 모자라면 false(필터 미적용).
 * 백테스트(_bt_synth.ts btcBelow50)와 같은 정의 — 신호봉 시점의 BTC 로 판단한다.
 */
export function btcBelowSma(btcBars: { close: number }[], idx: number): boolean {
  if (idx < F7_BTC_SMA_BARS - 1) return false;
  let s = 0;
  for (let j = idx - F7_BTC_SMA_BARS + 1; j <= idx; j++) s += btcBars[j].close;
  return btcBars[idx].close < s / F7_BTC_SMA_BARS;
}
