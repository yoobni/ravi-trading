/**
 * 포트폴리오 레벨 실험 — 개별 코인 독립 시뮬이 답할 수 없는 두 질문.
 *   ① F6의 자금 배분(33%×3종)이 최적인가? 더 얇게 더 많이 들면?
 *   ② 종목 로테이션(상대강도 상위 K개 보유)이 F6와 다른 수익원이 되나?
 *
 * 둘 다 현금·동시보유 제약을 실제로 모사한다(기존 per-coin 시뮬은 무한자본 가정).
 * lookahead-safe: 신호는 확정봉, 진입은 다음봉 시가, 청산은 진입봉 다음 봉부터.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005;
const INIT = 10_000_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_240m_'));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const SERIES = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 400) SERIES.set(m, b); }
/** 전 코인 공통 타임라인 + 코인별 ts→index */
const TS = [...new Set([...SERIES.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
const IDX = new Map<string, Map<number, number>>();
for (const [m, b] of SERIES) IDX.set(m, new Map(b.map((x, i) => [x.ts, i])));

const volZ = (b: Bar[], i: number, w: number) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hi = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hi(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

/** BTC 30일(180봉) 추세 — 국면 게이트용 */
const btc = SERIES.get('KRW-BTC')!, btcIdx = IDX.get('KRW-BTC')!;
function btcTrend(ts: number): number | null {
  const i = btcIdx.get(ts); if (i === undefined || i < 180) return null;
  return btc[i].close / btc[i - 180].close - 1;
}

interface Pos { market: string; entryTs: number; entryPrice: number; vol: number; cashUsed: number; entryIdxBar: number; peak: number; tsl: number; armed: boolean }
interface Res { total: number; mdd: number; trades: number; wr: number; pf: number; monthly: Map<string, number> }

/** F6 포트폴리오 시뮬 — 트레일링 청산(A2) 고정, 배분만 바꿔가며 비교 */
function runF6(positionPct: number, maxConcurrent: number, regimeGate: boolean, from?: number, to?: number): Res {
  const SL = -2, ACT = 2, GAP = 2, MAXB = 84;
  let cash = INIT;
  const open: Pos[] = [];
  const rets: number[] = []; const monthly = new Map<string, number>();
  let peakEq = INIT, mdd = 0; let wins = 0, gw = 0, gl = 0;

  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const t1 = to ? TS.findIndex(x => x >= to) : TS.length;
  for (let t = t0; t < (t1 < 0 ? TS.length : t1); t++) {
    const ts = TS[t];
    // 1) 청산 판정 (진입봉 다음 봉부터)
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = SERIES.get(pos.market)!; const i = IDX.get(pos.market)!.get(ts);
      if (i === undefined || i <= pos.entryIdxBar) continue;
      const bar = b[i]; let px = 0, done = false;
      if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.entryPrice * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.entryIdxBar) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const proceeds = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / pos.cashUsed - 1;
        rets.push(r); if (r > 0) { wins++; gw += r; } else gl += -r;
        const k = new Date(ts).toISOString().slice(0, 7);
        monthly.set(k, (monthly.get(k) ?? 0) + (proceeds - pos.cashUsed) / INIT);
        open.splice(p, 1);
      }
    }
    // 2) 신호 평가 → 다음 봉 시가 진입 (구간 마지막 20봉은 신규 진입 중단 — 미청산 편향 방지)
    if (open.length < maxConcurrent && t < (t1 < 0 ? TS.length : t1) - 20) {
      const gate = regimeGate ? btcTrend(ts) : 0;
      if (!(regimeGate && (gate === null || gate <= 0))) {
        for (const [m, b] of SERIES) {
          if (open.length >= maxConcurrent) break;
          if (open.some(p => p.market === m)) continue;
          const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
          if (!sigF6(b, i)) continue;
          const use = cash * positionPct; if (use < 5000) continue;
          const ep = b[i + 1].open * (1 + SLIP);
          cash -= use;
          open.push({ market: m, entryTs: b[i + 1].ts, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, entryIdxBar: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
        }
      }
    }
    // 3) 자산 평가 → MDD
    let eq = cash;
    for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) eq += p.vol * SERIES.get(p.market)![i].close; }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  let finalEq = cash;
  const lastTs = TS[Math.min((t1 < 0 ? TS.length : t1) - 1, TS.length - 1)];
  for (const p of open) { const i = IDX.get(p.market)!.get(lastTs); if (i !== undefined) finalEq += p.vol * SERIES.get(p.market)![i].close; }
  return { total: (finalEq / INIT - 1) * 100, mdd, trades: rets.length, wr: rets.length ? wins / rets.length * 100 : 0, pf: gl > 0 ? gw / gl : 99, monthly };
}

/** 상대강도 로테이션 — REBAL 봉마다 과거 LOOK봉 수익률 상위 K개 균등보유 */
function runRotation(look: number, k: number, rebal: number, regimeGate: boolean): Res {
  let cash = INIT;
  let held: Array<{ market: string; vol: number; cashUsed: number }> = [];
  const monthly = new Map<string, number>(); const rets: number[] = [];
  let peakEq = INIT, mdd = 0; let wins = 0, gw = 0, gl = 0;

  for (let t = 200; t < TS.length; t++) {
    const ts = TS[t];
    const price = (m: string) => { const i = IDX.get(m)!.get(ts); return i === undefined ? null : SERIES.get(m)![i].close; };
    if ((t - 200) % rebal === 0) {
      // 전량 청산
      for (const h of held) {
        const px = price(h.market); if (px === null) continue;
        const proceeds = h.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / h.cashUsed - 1;
        rets.push(r); if (r > 0) { wins++; gw += r; } else gl += -r;
        const key = new Date(ts).toISOString().slice(0, 7);
        monthly.set(key, (monthly.get(key) ?? 0) + (proceeds - h.cashUsed) / INIT);
      }
      held = [];
      const gate = regimeGate ? btcTrend(ts) : 0;
      if (!(regimeGate && (gate === null || gate <= 0))) {
        const ranked: Array<[string, number]> = [];
        for (const [m, b] of SERIES) {
          const i = IDX.get(m)!.get(ts); if (i === undefined || i < look) continue;
          ranked.push([m, b[i].close / b[i - look].close - 1]);
        }
        ranked.sort((a, b) => b[1] - a[1]);
        const picks = ranked.slice(0, k).filter(([, r]) => r > 0);
        const per = cash / Math.max(picks.length, 1);
        for (const [m] of picks) {
          const b = SERIES.get(m)!; const i = IDX.get(m)!.get(ts)!;
          if (i + 1 >= b.length) continue;
          const ep = b[i + 1].open * (1 + SLIP);
          cash -= per;
          held.push({ market: m, vol: per * (1 - FEE) / ep, cashUsed: per });
        }
      }
    }
    let eq = cash;
    for (const h of held) { const px = price(h.market); if (px !== null) eq += h.vol * px; }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
  }
  let finalEq = cash;
  for (const h of held) { const i = IDX.get(h.market)!.get(TS[TS.length - 1]); if (i !== undefined) finalEq += h.vol * SERIES.get(h.market)![i].close; }
  return { total: (finalEq / INIT - 1) * 100, mdd, trades: rets.length, wr: rets.length ? wins / rets.length * 100 : 0, pf: gl > 0 ? gw / gl : 99, monthly };
}

function corr(a: Map<string, number>, b: Map<string, number>) {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const x = keys.map(k => a.get(k) ?? 0), y = keys.map(k => b.get(k) ?? 0);
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : NaN;
}
const row = (l: string, r: Res, c?: number) => console.log(
  `  ${l.padEnd(30)}| ${(r.total.toFixed(0) + '%').padStart(8)} | ${(r.mdd.toFixed(1) + '%').padStart(6)} | ` +
  `${(r.mdd > 0 ? r.total / r.mdd : 0).toFixed(2).padStart(7)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)}` +
  (c === undefined ? '' : ` | ${(Number.isNaN(c) ? '-' : c.toFixed(2)).padStart(6)}`),
);

console.log(`=== 포트폴리오 시뮬 (${SERIES.size}코인, 4h, ${new Date(TS[200]).toISOString().slice(0,7)}~${new Date(TS[TS.length-1]).toISOString().slice(0,7)}, 초기 1,000만) ===`);
console.log('  현금·동시보유 제약 반영. MDD는 일별 평가액 기준(실현 MDD 아님)\n');
console.log('◆ ① F6 자금 배분 (트레일링 A2 고정)');
console.log('  구성                          |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF');
const base = runF6(0.33, 3, false);
row('33% × 3종 (현행)', base);
row('20% × 5종', runF6(0.20, 5, false));
row('15% × 7종', runF6(0.15, 7, false));
row('10% × 10종', runF6(0.10, 10, false));
row('50% × 2종', runF6(0.50, 2, false));
console.log('\n◆ ② 국면 게이트 (BTC 30일 추세 > 0 일 때만 신규 진입)');
row('33% × 3종 + 게이트', runF6(0.33, 3, true));
row('20% × 5종 + 게이트', runF6(0.20, 5, true));

console.log('\n◆ ③ 상대강도 로테이션 (상위 K개 균등, 리밸런스 주기)');
console.log('  구성                          |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF | F6상관');
for (const [look, k, rebal, label] of [
  [42, 3, 42, '7일 수익률 상위3 · 7일마다'],
  [42, 5, 42, '7일 수익률 상위5 · 7일마다'],
  [180, 3, 42, '30일 수익률 상위3 · 7일마다'],
  [180, 5, 42, '30일 수익률 상위5 · 7일마다'],
  [180, 5, 180, '30일 수익률 상위5 · 30일마다'],
] as Array<[number, number, number, string]>) {
  const r = runRotation(look, k, rebal, false);
  row(label, r, corr(r.monthly, base.monthly));
}
const rg = runRotation(180, 5, 42, true);
row('30일 상위5 · 7일 · +게이트', rg, corr(rg.monthly, base.monthly));

// ── 기간 분할: 배분 결론이 특정 구간의 우연인지 확인 ──────────
console.log('\n◆ ④ 기간 분할 — 배분별 총익 / MDD (구간마다 자본 1,000만 리셋)');
const PERIODS: Array<[string, string, string]> = [
  ['2022H2', '2022-07-01', '2023-01-01'],
  ['2023',   '2023-01-01', '2024-01-01'],
  ['2024',   '2024-01-01', '2025-01-01'],
  ['2025',   '2025-01-01', '2026-01-01'],
  ['2026(8월까지)', '2026-01-01', '2026-09-01'],
];
const ALLOC: Array<[string, number, number]> = [
  ['50%×2', 0.50, 2], ['33%×3(현행)', 0.33, 3], ['20%×5', 0.20, 5], ['10%×10', 0.10, 10],
];
const hdr = '  기간          | ' + ALLOC.map(([l]) => l.padStart(16)).join(' | ');
console.log(hdr);
for (const [name, f, t] of PERIODS) {
  const cells = ALLOC.map(([, pct, mc]) => {
    const r = runF6(pct, mc, false, Date.parse(f + 'T00:00:00Z'), Date.parse(t + 'T00:00:00Z'));
    return `${(r.total.toFixed(0) + '%').padStart(7)}/${(r.mdd.toFixed(0) + '%').padStart(4)}`.padStart(16);
  });
  console.log(`  ${name.padEnd(13)}| ` + cells.join(' | '));
}
console.log('  (셀 = 총익 / MDD)');
