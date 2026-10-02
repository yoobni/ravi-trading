/**
 * 축 E-3 변동성 돌파 (래리 윌리엄스) — 15m 28코인 2024-10~2026-10 정밀판 (2026-10-02)
 * 업비트 일봉 = KST 09:00 시작. 목표가 = 당일 시가 + k × 전일(고−저).
 * 업비트엔 스톱 매수 주문이 없다 → '감시 후 시장가'. 체결 모델 2종:
 *   watch  : 15m 고가가 목표가에 닿은 그 순간 시장가 — 체결가 = 목표가 × (1 + 관통 0.42%[1분 감시 실측] + 슬리피지)
 *   poll15 : 15분 폴링 — 닿은 15m 봉 다음 봉 시가 × (1 + 슬리피지)
 * 청산: 다음날 KST 09:00 시가 시장가. 동시 보유 = 유니버스 전 코인, 코인당 자본 1/K (K = 코인 수, 고전 방식).
 * 변형: 노이즈 필터 k = 직전 20일 평균 노이즈비율(1 − |종가−시가|/(고−저)), 이평 필터(시가 > 5일 이평).
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const COINS = Object.keys(SPREAD);
const FEE = 0.0005, Q = 15 * 60e3, DAY = 86400e3, KST9 = 0; // 일봉 시작 = UTC 00:00
interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
const M15 = new Map<string, B[]>();
for (const m of COINS) { const f = fs.readdirSync(DIR).find(x => x.startsWith(`${m}_15m_`)); if (f) M15.set(m, JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))); }
// 일봉 합성 (UTC 00:00 = KST 09:00 경계)
const D = new Map<string, { ts: number; open: number; high: number; low: number; close: number; bars: B[] }[]>();
for (const [m, b] of M15) {
  const out: any[] = [];
  for (const x of b) { const k = Math.floor((x.ts - KST9) / DAY) * DAY + KST9; const l = out[out.length - 1];
    if (!l || l.ts !== k) out.push({ ts: k, open: x.open, high: x.high, low: x.low, close: x.close, bars: [x] });
    else { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.bars.push(x); } }
  D.set(m, out.filter((d: any) => d.bars.length >= 90));
}
const slip = (m: string, mult: number) => Math.max(0.0005, SPREAD[m] / 2 / 1e4) * mult;
interface Cfg { k: number | 'noise'; maFilter: boolean; fill: 'watch' | 'poll15'; costMult: number; pen?: number }
function run(c: Cfg, from = 0, to = Infinity) {
  // 일별 포트폴리오 수익 (코인당 1/K)
  const K = M15.size;
  const daily = new Map<number, number>();
  const trades: number[] = [];
  for (const [m, d] of D) {
    for (let i = 21; i < d.length - 1; i++) {
      const t = d[i]; if (t.ts < from || t.ts > to) continue;
      const prev = d[i - 1];
      let k: number;
      if (c.k === 'noise') { let s = 0; for (let j = i - 20; j < i; j++) { const r = d[j].high - d[j].low; s += r > 0 ? 1 - Math.abs(d[j].close - d[j].open) / r : 1; } k = s / 20; }
      else k = c.k;
      if (c.maFilter) { let s = 0; for (let j = i - 5; j < i; j++) s += d[j].close; if (t.open <= s / 5) continue; }
      const target = t.open + k * (prev.high - prev.low);
      let entry: number | null = null;
      for (let q = 0; q < t.bars.length; q++) {
        if (t.bars[q].high >= target) {
          if (c.fill === 'watch') entry = Math.max(target, t.bars[q].open) * (1 + (c.pen ?? 0.0042) * c.costMult + slip(m, c.costMult));
          else { const nx = t.bars[q + 1]; if (nx) entry = nx.open * (1 + slip(m, c.costMult)); }
          break;
        }
      }
      if (entry == null) continue;
      const exit = d[i + 1].open * (1 - slip(m, c.costMult));
      const r = (exit / entry) * (1 - FEE * c.costMult) ** 2 - 1;
      trades.push(r);
      daily.set(t.ts, (daily.get(t.ts) ?? 0) + r / K);
    }
  }
  const days = [...daily.keys()].sort((a, b) => a - b);
  return { series: days.map(t => ({ ts: t, r: daily.get(t)! })), trades };
}
const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[]) => { const s = st(rs); if (s.mdd <= 17) return { f: 1, ...s }; let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > 17) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const SEG: Array<[string, number, number]> = [['24Q4', Date.UTC(2024, 9, 1), Date.UTC(2025, 0, 1)], ['25H1', Date.UTC(2025, 0, 1), Date.UTC(2025, 6, 1)], ['25H2', Date.UTC(2025, 6, 1), Date.UTC(2026, 0, 1)], ['26', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)]];
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
console.log(`28코인 15m · 2024-10~2026-10 · 일봉 KST09 · 코인당 1/${M15.size}`);
console.log('설정'.padEnd(34) + '거래  거래당    총익   MDD | eq17 총익  f   |' + SEG.map(s => s[0].padStart(6)).join(''));
const show = (lab: string, c: Cfg) => {
  const { series, trades } = run(c); const s = st(series), e = eq(series);
  const avg = trades.reduce((a, b) => a + b, 0) / Math.max(trades.length, 1) * 100;
  const seg = SEG.map(([, a, b]) => P(st(series.filter(x => x.ts >= a && x.ts < b), e.f).ret).padStart(6)).join('');
  console.log(`${lab.padEnd(34)}${String(trades.length).padStart(5)} ${(avg >= 0 ? '+' : '') + avg.toFixed(2)}% ${P(s.ret).padStart(7)} ${s.mdd.toFixed(0).padStart(4)}% | ${P(e.ret).padStart(7)} ${e.f.toFixed(2)} |${seg}`);
};
for (const fill of ['watch', 'poll15'] as const) for (const k of [0.3, 0.5, 0.7, 'noise'] as const) for (const ma of [false, true])
  show(`${fill} k=${k}${ma ? ' +MA5' : ''}`, { k, maFilter: ma, fill, costMult: 1 });
console.log('── 스트레스 (비용×2) ──');
for (const k of [0.5, 'noise'] as const) show(`watch k=${k} +MA5 비용×2`, { k, maFilter: true, fill: 'watch', costMult: 2 });
console.log('── 낙관 (관통 0, 슬리피지만) — 고전 백테스트 가정 ──');
for (const k of [0.5, 'noise'] as const) show(`watch k=${k} +MA5 관통0`, { k, maFilter: true, fill: 'watch', costMult: 1, pen: 0 });
