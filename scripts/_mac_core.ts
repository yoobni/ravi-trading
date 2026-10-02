/** 축 L 공용 — 업비트 KRW-BTC 1h(2018~), 매크로 발표 시각(UTC), 외부 일봉, BTC_TREND(일봉 KST09 경계=UTC00) */
import fs from 'fs';
const D = 'data/research-ext/macro/';
export const H = 3600e3, DAY = 24 * H;
export interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
export const B: Bar[] = JSON.parse(fs.readFileSync(D + 'KRW-BTC_60m.json', 'utf8'));
export const IDX = new Map(B.map((b, i) => [b.ts, i]));
const dates = JSON.parse(fs.readFileSync(D + 'macro-dates.json', 'utf8'));
/** 미국 서머타임: 3월 둘째 일요일 ~ 11월 첫째 일요일 */
function usDst(y: number, m: number, d: number) {
  const nthSun = (mo: number, n: number) => { const f = new Date(Date.UTC(y, mo, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (n - 1); };
  const t = Date.UTC(y, m, d), s = Date.UTC(y, 2, nthSun(2, 2)), e = Date.UTC(y, 10, nthSun(10, 1));
  return t >= s && t < e;
}
/** ET 시각(h:m)의 UTC ms */
export function etToUtc(date: string, h: number, m: number) {
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, h + (usDst(y, mo - 1, d) ? 4 : 5), m);
}
export const EVENTS: Record<string, number[]> = {
  FOMC: dates.fomc.map((d: string) => etToUtc(d, 14, 0)),
  CPI: dates.cpi.map((d: string) => etToUtc(d, 8, 30)),
  NFP: dates.empsit.map((d: string) => etToUtc(d, 8, 30)),
};
/** 이벤트가 들어있는 1h 봉 인덱스 */
export const barAt = (ts: number) => IDX.get(Math.floor(ts / H) * H);
export function yahoo(name: string) {
  const j = JSON.parse(fs.readFileSync(D + `yahoo-${name}.json`, 'utf8')).chart.result[0];
  const q = j.indicators.quote[0];
  return j.timestamp.map((t: number, i: number) => ({ date: new Date((t + j.meta.gmtoffset) * 1000).toISOString().slice(0, 10), close: q.close[i], open: q.open[i] }))
    .filter((x: any) => x.close != null);
}
/** BTC_TREND 일 신호: 날짜(UTC00 시작) → 그날 보유 여부. 직전 50개 확정 일봉(UTC00~24) 종가 기준. */
export function trendOn(N = 50) {
  const days: { ts: number; close: number }[] = [];
  for (const b of B) { const k = Math.floor(b.ts / DAY) * DAY; const l = days[days.length - 1]; if (!l || l.ts !== k) days.push({ ts: k, close: b.close }); else l.close = b.close; }
  const on = new Map<number, boolean>();
  for (let i = N; i < days.length; i++) { let s = 0; for (let j = i - N; j < i; j++) s += days[j].close; on.set(days[i].ts, days[i - 1].close > s / N); }
  return on;
}
export const FEE = 0.0005, SLIP = 0.0002;
export const P = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
export const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
export const tstat = (a: number[]) => { const m = mean(a); const sd = Math.sqrt(mean(a.map(x => (x - m) ** 2))); return sd > 0 ? m / (sd / Math.sqrt(a.length)) : 0; };
