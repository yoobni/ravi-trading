/** 김치 프리미엄 리서치 공통 로더 (2026-10-02). 4h UTC 격자 정렬. */
import fs from 'fs';
import path from 'path';
export const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
export const FOUR = 4 * 3600e3, DAY = 86400e3;
const CC = path.resolve(process.cwd(), 'data', 'candle-cache'), EX = path.resolve(process.cwd(), 'data', 'research-ext');
export interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
const longest = (m: string): Bar[] => {
  let best: Bar[] = [];
  for (const f of fs.readdirSync(CC).filter(x => x.startsWith(`KRW-${m}_240m_`))) { const d = JSON.parse(fs.readFileSync(path.join(CC, f), 'utf8')); if (d.length > best.length) best = d; }
  return best.sort((a, b) => a.ts - b.ts);
};
export const UP = new Map<string, Map<number, Bar>>(), BN = new Map<string, Map<number, Bar>>();
for (const c of COINS) {
  UP.set(c, new Map(longest(c).map(b => [b.ts, b])));
  const bn: Bar[] = JSON.parse(fs.readFileSync(path.join(EX, `binance-${c}_240m.json`), 'utf8'));
  BN.set(c, new Map(bn.map(b => [b.ts, b])));
}
export const USDT = new Map<number, Bar>((JSON.parse(fs.readFileSync(path.join(EX, 'upbit-KRW-USDT_240m.json'), 'utf8')) as Bar[]).map(b => [b.ts, b]));
const fxRaw: Record<string, number> = JSON.parse(fs.readFileSync(path.join(EX, 'fx-usdkrw.json'), 'utf8'));
const fxDays = Object.keys(fxRaw).sort();
/** ts 시점에 알 수 있는 환율 = ts 의 '전날'(UTC) 이하 마지막 ECB 고시 — 미래참조 방지 */
export function fxAt(ts: number): number | null {
  const d = new Date(ts - DAY).toISOString().slice(0, 10);
  let lo = 0, hi = fxDays.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fxDays[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? fxRaw[fxDays[ans]] : null;
}
export const TS = [...UP.get('BTC')!.keys()].filter(t => BN.get('BTC')!.has(t)).sort((a, b) => a - b);
/** 시장 김프(BTC 기준) — 봉 종가 기준, 봉 마감 시점에 알 수 있다 */
export function marketKimp(ts: number): number | null {
  const u = UP.get('BTC')!.get(ts), b = BN.get('BTC')!.get(ts), fx = fxAt(ts);
  return u && b && fx ? u.close / (b.close * fx) - 1 : null;
}
export function usdtKimp(ts: number): number | null {
  const u = USDT.get(ts), fx = fxAt(ts); return u && fx ? u.close / fx - 1 : null;
}
/** 코인 상대 김프 = 그 코인의 업비트/바이낸스 비율 ÷ BTC 의 비율 − 1 (환율 불필요) */
export function relKimp(c: string, ts: number): number | null {
  const u = UP.get(c)!.get(ts), b = BN.get(c)!.get(ts), ub = UP.get('BTC')!.get(ts), bb = BN.get('BTC')!.get(ts);
  return u && b && ub && bb ? (u.close / b.close) / (ub.close / bb.close) - 1 : null;
}
export const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
export const slip = (c: string, mult = 1) => mult * Math.max(0.0005, (SPREAD[`KRW-${c}`] ?? 40) / 2 / 1e4);
export const SPLIT = Date.UTC(2024, 6, 15);
export const P = (x: number, d = 2) => (x >= 0 ? '+' : '') + (100 * x).toFixed(d) + '%';
export const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
export function spearman(x: number[], y: number[]) {
  const rk = (a: number[]) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rk(x), ry = rk(y), n = x.length, mx = mean(rx), my = mean(ry);
  let s = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { s += (rx[i] - mx) * (ry[i] - my); sx += (rx[i] - mx) ** 2; sy += (ry[i] - my) ** 2; }
  return s / Math.sqrt(sx * sy);
}
