/**
 * 축 D-1: 바이낸스 펀딩비 → 업비트 현물 롱 (2026-10-02, 리서치 전용)
 * 데이터: data/research-ext/binance/funding/{C}.json [[fundingTime, rate]] · 업비트 4h 28코인 2022-06~2026-08.
 * 시점 규약: 펀딩 정산 시각 T(UTC 00/08/16, 일부 4h/1h) 의 값은 T 에 확정 → **T 이후 첫 4h 봉의 다음 봉 시가**(T+4h)에 체결 (보수적 4h 지연).
 * 펀딩은 8h 환산(rate × 8/정산간격h).
 */
import fs from 'fs';
import path from 'path';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const CC = path.resolve('data/candle-cache'), FD = path.resolve('data/research-ext/binance/funding');
const FOUR = 4 * 3600e3, DAY = 86400e3, SPLIT = Date.UTC(2024, 7, 1);
interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
const load = (m: string): B[] => { const f = fs.readdirSync(CC).filter(x => x.startsWith(`${m}_240m_2022-06-10_2026-08`)); return f.length ? JSON.parse(fs.readFileSync(path.join(CC, f[0]), 'utf8')).sort((a: B, b: B) => a.ts - b.ts) : []; };
const BARS = new Map<string, B[]>(), IDX = new Map<string, Map<number, number>>();
for (const c of COINS) { const b = load('KRW-' + c); if (b.length > 500) { BARS.set(c, b); IDX.set(c, new Map(b.map((x, i) => [x.ts, i]))); } }
// 펀딩 → 4h 봉 경계별 '그 시점까지 확정된 최신 8h 환산 펀딩' + 직전 24h 평균
const FUND = new Map<string, Array<[number, number]>>();
for (const c of COINS) {
  const raw: Array<[number, number]> = JSON.parse(fs.readFileSync(path.join(FD, c + '.json'), 'utf8'));
  // 같은 시각(±1h) 중복(POL=MATIC 이관 구간) 평균
  const m = new Map<number, number[]>();
  for (const [t, r] of raw) { const k = Math.round(t / 3600e3) * 3600e3; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  const ser = [...m].map(([t, a]) => [t, a.reduce((s, x) => s + x, 0) / a.length] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ser.length; i++) {
    const h = i ? Math.min(8, Math.max(1, (ser[i][0] - ser[i - 1][0]) / 3600e3)) : 8;
    out.push([ser[i][0], ser[i][1] * 8 / h]);
  }
  FUND.set(c, out);
}
/** 4h 봉 시각 t 에서 알 수 있는 지표: 최근 24h 의 8h환산 펀딩 평균(정산 ≤ t) */
function fundAt(c: string, t: number): number | null {
  const s = FUND.get(c)!; let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0 || t - s[k][0] > DAY) return null;
  let sum = 0, n = 0, w = 0; for (let j = k; j >= 0 && s[j][0] > t - DAY; j--) { const h = j ? Math.min(8, Math.max(1, (s[j][0] - s[j - 1][0]) / 3600e3)) : 8; sum += s[j][1] * h; w += h; n++; }
  return n ? sum / w : null;
}
// 이벤트 스터디 표본: 매 일 UTC 00 봉(하루 1번)마다 각 코인
interface Obs { c: string; t: number; f: number; pct: number; xrank: number; mkt: number; r1: number; r3: number; r7: number; ra3: number }
const TS = [...new Set([...BARS.values()].flatMap(b => b.map(x => x.ts)))].filter(t => t % DAY === 0).sort((a, b) => a - b);
const obs: Obs[] = [];
const hist = new Map<string, number[]>();
const fwd = (c: string, i0: number, n: number) => { const b = BARS.get(c)!; return i0 + n < b.length ? b[i0 + n].close / b[i0].open - 1 : null; };
for (const t of TS) {
  const day: Array<{ c: string; f: number; i0: number }> = [];
  for (const c of BARS.keys()) {
    const f = fundAt(c, t); const i = IDX.get(c)!.get(t); if (f == null || i === undefined) continue;
    const i0 = i + 1; // 보수적 지연: 다음 4h 봉 시가 진입
    day.push({ c, f, i0 });
  }
  if (day.length < 10) continue;
  const rets = day.map(d => ({ ...d, r1: fwd(d.c, d.i0, 6), r3: fwd(d.c, d.i0, 18), r7: fwd(d.c, d.i0, 42) })).filter(d => d.r1 != null && d.r3 != null && d.r7 != null);
  const mkt3 = rets.reduce((s, d) => s + d.r3!, 0) / rets.length;
  const mf = day.map(d => d.f).sort((a, b) => a - b)[Math.floor(day.length / 2)];
  const sorted = day.slice().sort((a, b) => a.f - b.f);
  for (const d of rets) {
    const h = hist.get(d.c) ?? []; const pct = h.length >= 60 ? h.filter(x => x <= d.f).length / h.length : NaN;
    obs.push({ c: d.c, t, f: d.f, pct, xrank: sorted.findIndex(x => x.c === d.c) / (day.length - 1), mkt: mf, r1: d.r1!, r3: d.r3!, r7: d.r7!, ra3: d.r3! - mkt3 });
  }
  for (const d of day) { const h = hist.get(d.c) ?? []; h.push(d.f); if (h.length > 90) h.shift(); hist.set(d.c, h); }
}
const P = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const q5 = (xs: Obs[], f: (o: Obs) => number, r: (o: Obs) => number) => { const s = xs.filter(o => Number.isFinite(f(o))).sort((a, b) => f(a) - f(b)); return Array.from({ length: 5 }, (_, j) => P(mean(s.slice(Math.floor(j * s.length / 5), Math.floor((j + 1) * s.length / 5)).map(r))).padStart(8)).join(''); };
console.log(`관측 ${obs.length} (코인·일), IS ${obs.filter(o => o.t < SPLIT).length} / OOS ${obs.filter(o => o.t >= SPLIT).length}`);
console.log('\n① 5분위(1=펀딩 최저=숏 과밀) → 3일 수익 · 시장조정 3일 수익');
for (const [lab, f] of [['펀딩 절대값', (o: Obs) => o.f], ['자기 90일 백분위', (o: Obs) => o.pct], ['횡단면 순위', (o: Obs) => o.xrank]] as Array<[string, (o: Obs) => number]>) {
  for (const [nm, set] of [['IS ', obs.filter(o => o.t < SPLIT)], ['OOS', obs.filter(o => o.t >= SPLIT)]] as Array<[string, Obs[]]>) {
    console.log(`  ${lab.padEnd(10)} ${nm} 원  ${q5(set, f, o => o.r3)}   시장조정 ${q5(set, f, o => o.ra3)}`);
  }
}
console.log('\n② 극단 꼬리 (음수 펀딩 = 숏 과밀)');
const tails: Array<[string, (o: Obs) => boolean]> = [['f ≤ −0.01%', o => o.f <= -0.0001], ['f ≤ −0.03%', o => o.f <= -0.0003], ['f ≤ −0.05%', o => o.f <= -0.0005], ['자기 백분위 ≤ 5%', o => o.pct <= 0.05], ['자기 백분위 ≥ 95%', o => o.pct >= 0.95], ['f ≥ +0.05%', o => o.f >= 0.0005]];
for (const [lab, cond] of tails) for (const [nm, set] of [['IS ', obs.filter(o => o.t < SPLIT)], ['OOS', obs.filter(o => o.t >= SPLIT)]] as Array<[string, Obs[]]>) {
  const x = set.filter(cond); console.log(`  ${lab.padEnd(16)} ${nm} n=${String(x.length).padStart(4)}  1일 ${P(mean(x.map(o => o.r1))).padStart(8)} 3일 ${P(mean(x.map(o => o.r3))).padStart(8)} 7일 ${P(mean(x.map(o => o.r7))).padStart(8)}  시장조정3일 ${P(mean(x.map(o => o.ra3))).padStart(8)}  (전체 3일 ${P(mean(set.map(o => o.r3)))})`);
}
console.log('\n③ 시장 전체 펀딩(코인 중앙값) 5분위 → 동일가중 시장 3일 수익');
for (const [nm, set] of [['IS ', obs.filter(o => o.t < SPLIT)], ['OOS', obs.filter(o => o.t >= SPLIT)]] as Array<[string, Obs[]]>) console.log(`  ${nm} ${q5(set, o => o.mkt, o => o.r3)}`);
fs.writeFileSync('data/research-ext/binance/fund_obs.json', JSON.stringify(obs));
