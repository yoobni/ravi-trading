/**
 * F6_v6 (TRAIL 12h) paper trading store.
 *
 * F6_v5(A2·4h)의 자매 — 동일 트레일 파라미터(act2/gap2·SL−2%)를 **12시간봉**에 적용.
 * 12h 네이티브 캔들이 없어 4h(240m)를 UTC 12시간창(00–12/12–24 UTC)으로 합성한다.
 * 룩백은 "7일 신고가" 유지 위해 봉수 스케일: 4h 42 → 12h 14, MAX 84→28, volZ 30→10.
 *
 * 근거: 타임프레임 스윕에서 4h→12h로 갈수록 PF↑(1.51→1.93)·총익↑(869→1317%),
 *       대신 MDD↑(84→161%, 4년). 아웃샘플 PF 1.47→1.82. 4h(v5)와 병행 실측용.
 *       (scripts/_bt_4h12h.ts) ⚠ 페이퍼 실증 단계.
 *
 * 별도 state + 별도 tick (12h cron: KST 09시·21시 = UTC창 마감 직후).
 */
import fs from 'fs';
import path from 'path';
import { withFileLock } from './file-lock';

export const F6V6_DIR = path.resolve(process.cwd(), 'data', 'paper-f6v6');
export const F6V6_STATE_FILE = path.join(F6V6_DIR, 'state.json');
export const F6V6_TRADES_FILE = path.join(F6V6_DIR, 'trades.jsonl');
export const F6V6_TICKS_FILE = path.join(F6V6_DIR, 'ticks.jsonl');

export const F6V6_INITIAL_CASH_KRW = 10_000_000;
export const F6V6_FEE = 0.0005;
export const F6V6_SLIPPAGE = 0.0005;
export const F6V6_SL_PCT = -2.0;
export const F6V6_TRAIL_ACT = 2.0;       // A2 파라미터
export const F6V6_TRAIL_GAP = 2.0;
export const F6V6_TF_HOURS = 12;
export const F6V6_MAX_BARS = 28;         // 14d / 12h
export const F6V6_POSITION_PCT = 0.33;
export const F6V6_MAX_CONCURRENT = 3;
export const F6V6_VOL_Z_THRESHOLD = 0.5;
export const F6V6_LOOKBACK_BARS = 14;    // 7d / 12h
export const F6V6_VOLZ_WINDOW = 10;      // ~5d / 12h

export const F6V6_COINS = [
  'KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH',
  'KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO',
  'KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT',
];

export interface BarLite { ts: number; open: number; high: number; low: number; close: number; volume: number; }

export interface F6V6Position { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number; }
export interface F6V6ClosedTrade { market: string; entryTs: number; exitTs: number; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; profitRate: number; profitKrw: number; reason: 'TRAIL' | 'SL' | 'TIME' | 'MANUAL'; recordedAt: string; }
export interface F6V6State { startedAt: string; lastTickTs: number | null; lastTickAt: string | null; cash: number; positions: F6V6Position[]; totalTrades: number; totalRealizedPnl: number; }

export function ensureF6V6Dir() { if (!fs.existsSync(F6V6_DIR)) fs.mkdirSync(F6V6_DIR, { recursive: true }); }
export function readF6V6State(): F6V6State | null {
  if (!fs.existsSync(F6V6_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(F6V6_STATE_FILE, 'utf-8')); } catch { return null; }
}
export function emptyF6V6State(): F6V6State {
  return { startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null, cash: F6V6_INITIAL_CASH_KRW, positions: [], totalTrades: 0, totalRealizedPnl: 0 };
}
export async function withF6V6State<T>(fn: (state: F6V6State) => Promise<T>): Promise<T> {
  ensureF6V6Dir();
  return withFileLock(F6V6_STATE_FILE, async () => {
    let st = readF6V6State();
    if (!st) { st = emptyF6V6State(); fs.writeFileSync(F6V6_STATE_FILE, JSON.stringify(st, null, 2)); }
    const result = await fn(st);
    fs.writeFileSync(F6V6_STATE_FILE, JSON.stringify(st, null, 2));
    return result;
  });
}
export function appendF6V6Trade(t: F6V6ClosedTrade) { ensureF6V6Dir(); fs.appendFileSync(F6V6_TRADES_FILE, JSON.stringify(t) + '\n'); }
export function appendF6V6Tick(r: object) { ensureF6V6Dir(); fs.appendFileSync(F6V6_TICKS_FILE, JSON.stringify(r) + '\n'); }

/** 4h bars → 12h bars (UTC 12시간창 그룹, epoch 기준 00/12 UTC 정렬). 완성창(3봉)만 반환. */
export function aggregate12h(bars4h: BarLite[]): BarLite[] {
  const WIN = F6V6_TF_HOURS * 3600_000;
  const groups = new Map<number, BarLite[]>();
  for (const b of bars4h) {
    const key = Math.floor(b.ts / WIN);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
  }
  const out: BarLite[] = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length < 3) continue; // 미완성 12h창 제외
    g.sort((a, b) => a.ts - b.ts);
    out.push({ ts: key * WIN, open: g[0].open, high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)), close: g[g.length - 1].close, volume: g.reduce((a, x) => a + x.volume, 0) });
  }
  return out;
}

export function calcVolZ(volumes: number[], i: number, window: number): number | null {
  if (i < window) return null;
  let s = 0, s2 = 0; for (let j = i - window; j < i; j++) { s += volumes[j]; s2 += volumes[j] * volumes[j]; }
  const mean = s / window, sd = Math.sqrt(Math.max(s2 / window - mean * mean, 1e-12));
  return sd > 0 ? (volumes[i] - mean) / sd : null;
}

/** F6 base 신호 (12h 파라미터). bars = 12h봉, 마지막이 확정봉. */
export function evaluateF6v6Signal(bars: BarLite[]): { hit: boolean; volZ: number | null } {
  const i = bars.length - 1;
  if (i < F6V6_LOOKBACK_BARS + 1 || i < F6V6_VOLZ_WINDOW) return { hit: false, volZ: null };
  let pm = -Infinity;
  for (let j = i - F6V6_LOOKBACK_BARS; j < i - 1; j++) if (bars[j].high > pm) pm = bars[j].high;
  if (!(bars[i - 1].high > pm)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i].open)) return { hit: false, volZ: null };
  if (!(bars[i].close > bars[i - 1].high)) return { hit: false, volZ: null };
  const z = calcVolZ(bars.map(b => b.volume), i, F6V6_VOLZ_WINDOW);
  if (z == null || z < F6V6_VOL_Z_THRESHOLD) return { hit: false, volZ: z };
  return { hit: true, volZ: z };
}

/** 트레일링 청산 (무상태·멱등). */
export function evalTrailExit(bars: { ts:number; high:number; low:number; close:number }[], entryPrice: number): { reason: 'TRAIL' | 'SL' | 'TIME'; price: number; ts: number } | null {
  let peak = entryPrice, sl = entryPrice * (1 + F6V6_SL_PCT / 100), trailOn = false;
  for (const b of bars) {
    if (b.low <= sl) return { reason: trailOn ? 'TRAIL' : 'SL', price: sl, ts: b.ts };
    peak = Math.max(peak, b.high);
    if (!trailOn && peak >= entryPrice * (1 + F6V6_TRAIL_ACT / 100)) trailOn = true;
    if (trailOn) sl = Math.max(sl, peak * (1 - F6V6_TRAIL_GAP / 100));
  }
  if (bars.length >= F6V6_MAX_BARS) { const last = bars[F6V6_MAX_BARS - 1] || bars[bars.length - 1]; return { reason: 'TIME', price: last.close, ts: last.ts }; }
  return null;
}
