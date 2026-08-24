/**
 * 자본 가동률(capital deployment) 가설.
 *
 * 관찰: 지금까지 실패한 개선안 — 국면 게이트, 절반 익절, 13시 필터, 종목 선발 —
 *   은 전부 "거래를 줄이는" 방향이었고 전부 포트폴리오 총익에서 졌다.
 *   유일하게 이긴 집중 배분(50%×2)만 "더 많이 태우는" 방향이었다.
 *   → 병목은 신호 품질이 아니라 자본이 놀고 있는 시간일 수 있다. 한 번도 안 재봤다.
 *
 * ① 진단   : 현행 33%×3 이 실제로 자본의 몇 %를, 몇 %의 시간 동안 굴리고 있나.
 * ② 사이징 : cash×pct(현행, 3번째 포지션이 첫번째의 절반) vs equity×pct vs 남은 슬롯에 전액 분배
 * ③ 피라미딩: 같은 코인 재신호 시 추가 진입 허용 — 이기는 말에 더 태우기(거래를 늘리는 방향)
 * ④ 베이스 : 노는 현금을 BTC 에 담아두고 F6 진입 때만 꺼내 쓰기 — 현금 드래그 제거
 * ⑤ 리스크오프: BTC 추세 붕괴 시 전량 청산 — ④가 키운 MDD 를 되돌릴 수 있나
 *
 * 전부 현금·동시보유 제약을 모사한 포트폴리오 시뮬. lookahead-safe:
 * 신호는 확정봉, 진입은 다음봉 시가, 청산은 진입봉 다음 봉부터.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005;
const INIT = 10_000_000;
const SL = -2, ACT = 2, GAP = 2, MAXB = 84;   // 트레일링 A2 (F6_v5 와 동일)

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_240m_'));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const SERIES = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 400) SERIES.set(m, b); }
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

const btc = SERIES.get('KRW-BTC')!, btcIdx = IDX.get('KRW-BTC')!;
/** BTC 30일(180봉) 추세 — 확정봉 종가끼리 비교하므로 미래참조 없음 */
function btcTrend(ts: number): number | null {
  const i = btcIdx.get(ts); if (i === undefined || i < 180) return null;
  return btc[i].close / btc[i - 180].close - 1;
}

type Sizing = 'cashPct' | 'equityPct' | 'fillSlots';
interface Cfg {
  sizing: Sizing;
  pct: number;
  maxConcurrent: number;
  /** 같은 코인에 재신호가 뜨면 추가 진입(피라미딩)을 허용할지, 최대 몇 트란치까지 */
  maxPerCoin: number;
  /** 노는 현금 중 BTC 에 담아둘 비율 (0 = 사용 안 함) */
  baseFrac: number;
  /** BTC 30일 추세가 이 값 이하이면 전량 청산 + 신규 진입 금지 (null = 사용 안 함) */
  riskOff: number | null;
}
const cfg = (o: Partial<Cfg>): Cfg => ({ sizing: 'cashPct', pct: 0.33, maxConcurrent: 3, maxPerCoin: 1, baseFrac: 0, riskOff: null, ...o });

interface Pos { market: string; entryPrice: number; vol: number; cashUsed: number; entryIdxBar: number; peak: number; tsl: number; armed: boolean }
interface Res {
  total: number; mdd: number; trades: number; wr: number; pf: number;
  monthly: Map<string, number>;
  /** 평균 투입비중 = (평가액-현금)/평가액 의 봉 평균 */
  deploy: number;
  /** 포지션 0개인 봉의 비율 */
  idle: number;
  /** 동시보유 개수 히스토그램 */
  hist: number[];
}

function run(c: Cfg, from?: number, to?: number): Res {
  let cash = INIT;
  let baseVol = 0;                       // 베이스 레이어(BTC) 보유량
  const open: Pos[] = [];
  const rets: number[] = []; const monthly = new Map<string, number>();
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0;
  let deploySum = 0, idleBars = 0, nBars = 0;
  const hist = new Array(c.maxConcurrent + 1).fill(0);

  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const tEnd = to ? (TS.findIndex(x => x >= to) < 0 ? TS.length : TS.findIndex(x => x >= to)) : TS.length;

  const btcPx = (ts: number) => { const i = btcIdx.get(ts); return i === undefined ? null : btc[i].close; };
  /** 베이스에서 need 만큼 현금 확보 (수수료·슬리피지 부담) */
  function raise(need: number, ts: number) {
    if (baseVol <= 0 || need <= 0) return;
    const px = btcPx(ts); if (px === null) return;
    const net = px * (1 - SLIP) * (1 - FEE);
    const sellVol = Math.min(baseVol, need / net);
    baseVol -= sellVol; cash += sellVol * net;
  }
  /** 노는 현금의 baseFrac 만큼을 BTC 로 유지 — 편차가 클 때만 리밸런스(거래비용 절약) */
  function rebalanceBase(ts: number, allowed: boolean) {
    if (c.baseFrac <= 0) return;
    const px = btcPx(ts); if (px === null) return;
    const cur = baseVol * px;
    const target = allowed ? (cash + cur) * c.baseFrac : 0;
    const eqApprox = cash + cur + 1;
    if (Math.abs(target - cur) / eqApprox < 0.05) return;
    if (target > cur) {
      const spend = Math.min(cash, target - cur);
      if (spend <= 0) return;
      const ep = px * (1 + SLIP);
      baseVol += spend * (1 - FEE) / ep; cash -= spend;
    } else {
      const net = px * (1 - SLIP) * (1 - FEE);
      const sellVol = Math.min(baseVol, (cur - target) / net);
      baseVol -= sellVol; cash += sellVol * net;
    }
  }
  function closePos(p: Pos, px: number, ts: number) {
    const proceeds = p.vol * px * (1 - SLIP) * (1 - FEE);
    cash += proceeds;
    const r = proceeds / p.cashUsed - 1;
    rets.push(r); if (r > 0) { wins++; gw += r; } else gl += -r;
    const k = new Date(ts).toISOString().slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + (proceeds - p.cashUsed) / INIT);
  }

  for (let t = t0; t < tEnd; t++) {
    const ts = TS[t];
    const trend = btcTrend(ts);
    const riskOn = c.riskOff === null ? true : (trend !== null && trend > c.riskOff);

    // 1) 청산
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
      // 리스크오프 전환 시 종가 청산
      if (!done && !riskOn) { px = bar.close; done = true; }
      if (done) { closePos(pos, px, ts); open.splice(p, 1); }
    }

    // 2) 신규 진입 (구간 마지막 20봉은 미청산 편향 방지로 중단)
    if (riskOn && open.length < c.maxConcurrent && t < tEnd - 20) {
      // 진입 크기 기준이 되는 평가액 — 이 봉 종가 기준
      let eqNow = cash + baseVol * (btcPx(ts) ?? 0);
      for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) eqNow += p.vol * SERIES.get(p.market)![i].close; }
      for (const [m, b] of SERIES) {
        if (open.length >= c.maxConcurrent) break;
        if (open.filter(p => p.market === m).length >= c.maxPerCoin) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
        if (!sigF6(b, i)) continue;
        let want: number;
        if (c.sizing === 'cashPct') want = cash * c.pct;
        else if (c.sizing === 'equityPct') want = eqNow * c.pct;
        else want = cash / Math.max(1, c.maxConcurrent - open.length);   // fillSlots
        if (c.baseFrac > 0 && want > cash) raise(want - cash, ts);
        const use = Math.min(want, cash);
        if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ market: m, entryPrice: ep, vol: use * (1 - FEE) / ep, cashUsed: use, entryIdxBar: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false });
      }
    }

    // 3) 베이스 리밸런스 → 평가 → MDD·가동률
    rebalanceBase(ts, riskOn);
    let eq = cash + baseVol * (btcPx(ts) ?? 0);
    let f6Val = 0;
    for (const p of open) { const i = IDX.get(p.market)!.get(ts); if (i !== undefined) f6Val += p.vol * SERIES.get(p.market)![i].close; }
    eq += f6Val;
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    nBars++; deploySum += eq > 0 ? f6Val / eq : 0;
    if (!open.length) idleBars++;
    hist[Math.min(open.length, c.maxConcurrent)]++;
  }

  const lastTs = TS[Math.min(tEnd - 1, TS.length - 1)];
  let finalEq = cash + baseVol * (btcPx(lastTs) ?? 0);
  for (const p of open) { const i = IDX.get(p.market)!.get(lastTs); if (i !== undefined) finalEq += p.vol * SERIES.get(p.market)![i].close; }
  return {
    total: (finalEq / INIT - 1) * 100, mdd, trades: rets.length,
    wr: rets.length ? wins / rets.length * 100 : 0, pf: gl > 0 ? gw / gl : 99,
    monthly, deploy: nBars ? deploySum / nBars * 100 : 0, idle: nBars ? idleBars / nBars * 100 : 0, hist,
  };
}

/** BTC 단순 보유 벤치마크 */
function btcHold(from?: number, to?: number) {
  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const tEnd = to ? (TS.findIndex(x => x >= to) < 0 ? TS.length : TS.findIndex(x => x >= to)) : TS.length;
  const i0 = btcIdx.get(TS[t0]), i1 = btcIdx.get(TS[tEnd - 1]);
  if (i0 === undefined || i1 === undefined) return { total: NaN, mdd: NaN };
  let peak = -Infinity, mdd = 0;
  for (let i = i0; i <= i1; i++) { peak = Math.max(peak, btc[i].close); mdd = Math.max(mdd, (peak - btc[i].close) / peak * 100); }
  return { total: (btc[i1].close / btc[i0].close - 1) * 100, mdd };
}

const HDR = '  구성                              |     총익 |    MDD | 수익/MDD | 거래 |    WR |    PF | 가동률';
const row = (l: string, r: Res) => console.log(
  `  ${l.padEnd(34)}| ${(r.total.toFixed(0) + '%').padStart(8)} | ${(r.mdd.toFixed(1) + '%').padStart(6)} | ` +
  `${(r.mdd > 0 ? r.total / r.mdd : 0).toFixed(2).padStart(8)} | ${String(r.trades).padStart(4)} | ` +
  `${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)} | ${(r.deploy.toFixed(0) + '%').padStart(6)}`,
);

const P0 = new Date(TS[200]).toISOString().slice(0, 10), P1 = new Date(TS[TS.length - 1]).toISOString().slice(0, 10);
console.log(`=== 자본 가동률 실험 (${SERIES.size}코인 4h, ${P0}~${P1}, 초기 1,000만) ===\n`);

console.log('◆ ① 진단 — 현행 33%×3 은 자본을 얼마나 굴리고 있나');
const base = run(cfg({}));
const tot = base.hist.reduce((s, v) => s + v, 0);
console.log(`  평균 투입비중        ${base.deploy.toFixed(1)}%   (나머지는 현금)`);
console.log(`  포지션 0개인 시간    ${base.idle.toFixed(1)}%`);
console.log(`  동시보유 분포        ${base.hist.map((v, i) => `${i}개 ${(v / tot * 100).toFixed(0)}%`).join(' · ')}`);
const bh = btcHold();
console.log(`  (참고) BTC 단순보유  총익 ${bh.total.toFixed(0)}% / MDD ${bh.mdd.toFixed(1)}%\n`);

console.log('◆ ② 사이징 — 같은 신호, 태우는 방식만 변경');
console.log(HDR);
row('cash×33% ×3종 (현행)', base);
row('equity×33% ×3종', run(cfg({ sizing: 'equityPct' })));
row('남은슬롯 전액분배 ×3종', run(cfg({ sizing: 'fillSlots' })));
row('cash×50% ×2종', run(cfg({ pct: 0.50, maxConcurrent: 2 })));
row('equity×50% ×2종', run(cfg({ sizing: 'equityPct', pct: 0.50, maxConcurrent: 2 })));
row('남은슬롯 전액분배 ×2종', run(cfg({ sizing: 'fillSlots', maxConcurrent: 2 })));
row('equity×100% ×1종', run(cfg({ sizing: 'equityPct', pct: 1.0, maxConcurrent: 1 })));

console.log('\n◆ ③ 피라미딩 — 같은 코인 재신호 시 추가 트란치 허용');
console.log(HDR);
row('현행 (코인당 1)', base);
row('코인당 2 · cash×33% ×3종', run(cfg({ maxPerCoin: 2 })));
row('코인당 2 · equity×33% ×3종', run(cfg({ sizing: 'equityPct', maxPerCoin: 2 })));
row('코인당 3 · equity×25% ×4종', run(cfg({ sizing: 'equityPct', pct: 0.25, maxConcurrent: 4, maxPerCoin: 3 })));

console.log('\n◆ ④ 베이스 레이어 — 노는 현금을 BTC 로 (F6 진입 시 매도해 조달)');
console.log(HDR);
row('베이스 없음 (equity×33%×3)', run(cfg({ sizing: 'equityPct' })));
row('노는현금 50% → BTC', run(cfg({ sizing: 'equityPct', baseFrac: 0.5 })));
row('노는현금 100% → BTC', run(cfg({ sizing: 'equityPct', baseFrac: 1.0 })));

console.log('\n◆ ⑤ 리스크오프 오버레이 — BTC 30일 추세 붕괴 시 전량 청산');
console.log(HDR);
row('오버레이 없음 (equity×33%×3)', run(cfg({ sizing: 'equityPct' })));
row('BTC30d < 0% → 청산', run(cfg({ sizing: 'equityPct', riskOff: 0 })));
row('BTC30d < -10% → 청산', run(cfg({ sizing: 'equityPct', riskOff: -0.10 })));
row('베이스100% + BTC30d<0 청산', run(cfg({ sizing: 'equityPct', baseFrac: 1.0, riskOff: 0 })));
row('베이스100% + BTC30d<-10 청산', run(cfg({ sizing: 'equityPct', baseFrac: 1.0, riskOff: -0.10 })));
