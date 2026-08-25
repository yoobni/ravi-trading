/**
 * 정합성 검사 — _bt_panel.ts 의 반전 결과를 믿기 전에 계산 자체가 옳은지 본다.
 *
 * 앞서 같은 파일에서 두 개의 실제 버그가 나왔다:
 *   ① 진입가를 close[i+1] 로 둬서 h=1 수익률이 항상 0
 *   ② 동점 순위를 배열 순서로 매겨 코인 순서와의 가짜 상관
 * 그래서 이번엔 결론을 내기 전에 아래를 전부 통과시킨다.
 *
 *   A 미래참조   : 신호 시점 이후 정보가 새어 들어가는지 — 신호를 1봉 늦추면 성과가 죽어야 정상
 *   B 무작위 대조: 같은 진입 횟수를 무작위 시점에 넣으면 성과가 0 근처여야 한다
 *   C 부호 반전  : 급락이 아니라 급등을 사면 반대로 나빠져야 한다(모멘텀이면 그 반대)
 *   D 데이터 위생: NaN·0가격·중복 ts·비정상 수익률(|r|>50%) 개수
 *   E 생존 편향  : 현재 유니버스가 "지금 살아있는 코인"만이라는 사실의 크기
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const INIT = 10_000_000;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(`${m}_60m_`));
  let best: Bar[] | null = null;
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
}
const SERIES = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) SERIES.set(m, b); }
const MKTS = [...SERIES.keys()];
const counts = new Map<number, number>();
for (const b of SERIES.values()) for (const x of b) counts.set(x.ts, (counts.get(x.ts) ?? 0) + 1);
const TS = [...counts.entries()].filter(([, c]) => c === MKTS.length).map(([t]) => t).sort((a, b) => a - b);
const PX = new Map(MKTS.map((m) => [m, new Map(SERIES.get(m)!.map((b) => [b.ts, b]))]));
const C = MKTS.map((m) => TS.map((t) => PX.get(m)!.get(t)!.close));
const O = MKTS.map((m) => TS.map((t) => PX.get(m)!.get(t)!.open));
const ret1 = (ci: number, i: number) => (i < 1 ? NaN : C[ci][i] / C[ci][i - 1] - 1);

console.log(`=== 정합성 검사 (${MKTS.length}코인 1h, ${TS.length}봉) ===\n`);

// ── D 데이터 위생 (먼저: 데이터가 더러우면 나머지 결과가 무의미)
console.log('◆ D 데이터 위생');
{
  let nan = 0, zero = 0, wild = 0, nonMono = 0, gaps = 0;
  for (let ci = 0; ci < MKTS.length; ci++) {
    for (let i = 1; i < TS.length; i++) {
      const c = C[ci][i], o = O[ci][i];
      if (!Number.isFinite(c) || !Number.isFinite(o)) nan++;
      else if (c <= 0 || o <= 0) zero++;
      else if (Math.abs(c / C[ci][i - 1] - 1) > 0.5) wild++;
    }
  }
  for (let i = 1; i < TS.length; i++) {
    if (TS[i] <= TS[i - 1]) nonMono++;
    if (TS[i] - TS[i - 1] !== 3600_000) gaps++;
  }
  console.log(`  NaN ${nan} · 0이하 가격 ${zero} · |1h수익|>50% ${wild} · ts 역순 ${nonMono} · 1시간 아닌 간격 ${gaps}`);
  console.log(`  ${nan + zero + nonMono === 0 ? '✔ 통과' : '⚠ 문제 있음'} (간격 ${gaps}건은 공통 타임라인 필터로 빠진 구간 — 정상)`);
}

/** 급락 반전 이벤트 시뮬. lag=1 이면 신호를 1봉 늦춰 진입(미래참조 검사용), sign=+1 이면 급등 매수 */
function sim(dropPct: number, H: number, maxCon: number, opts: { lag?: number; sign?: number; random?: number; seed?: number } = {}) {
  const lag = opts.lag ?? 0, sign = opts.sign ?? -1;
  let cash = INIT;
  const open: Array<{ ci: number; exitAt: number; vol: number; used: number }> = [];
  let n = 0, wins = 0, gw = 0, gl = 0, peak = INIT, mdd = 0;
  // 무작위 대조군은 결정적 의사난수 사용 (Math.random 없이 재현 가능)
  let seed = (opts.seed ?? 1) * 7919 + 13;   // 확률이 아니라 seed 인자에서 받는다
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 200; i < TS.length - H - 3; i++) {
    for (let p = open.length - 1; p >= 0; p--) {
      if (open[p].exitAt > i) continue;
      const pos = open[p];
      const proceeds = pos.vol * C[pos.ci][i] * (1 - COST / 2);
      cash += proceeds;
      const r = proceeds / pos.used - 1;
      n++; if (r > 0) { wins++; gw += r; } else gl += -r;
      open.splice(p, 1);
    }
    if (open.length < maxCon) {
      let hits: number[];
      if (opts.random) {
        // 같은 빈도로 무작위 진입 (진입 빈도만 맞춘 대조군)
        hits = MKTS.map((_, ci) => ci).filter(() => rnd() < opts.random!);
      } else {
        const sigIdx = i - lag;   // lag>0 이면 더 오래된 신호를 쓴다
        hits = MKTS.map((_, ci) => ci)
          .filter((ci) => sign < 0 ? ret1(ci, sigIdx) <= -dropPct / 100 : ret1(ci, sigIdx) >= dropPct / 100)
          .sort((a, b) => sign < 0 ? ret1(a, sigIdx) - ret1(b, sigIdx) : ret1(b, sigIdx) - ret1(a, sigIdx));
      }
      for (const ci of hits) {
        if (open.length >= maxCon) break;
        if (open.some((p) => p.ci === ci)) continue;
        const use = cash / (maxCon - open.length);
        if (use < 5000) continue;
        const ep = O[ci][i + 1] * (1 + COST / 2);
        if (!Number.isFinite(ep) || ep <= 0) continue;
        cash -= use; open.push({ ci, exitAt: i + H, vol: use / ep, used: use });
      }
    }
    let eq = cash;
    for (const p of open) eq += p.vol * C[p.ci][i];
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let fin = cash;
  for (const p of open) fin += p.vol * C[p.ci][TS.length - 3];
  return { total: (fin / INIT - 1) * 100, mdd, n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99 };
}

const base = sim(4, 2, 3);
console.log(`\n◆ 기준 (1h −4% → 2봉 보유, 최대 3종): 총익 ${base.total.toFixed(0)}% · MDD ${base.mdd.toFixed(1)}% · 거래 ${base.n} · PF ${base.pf.toFixed(2)}`);

console.log('\n◆ A 미래참조 검사 — 신호를 N봉 늦추면 성과가 죽어야 정상');
for (const lag of [0, 1, 2, 3, 4, 5, 6, 8, 12, 24]) {
  const s = sim(4, 2, 3, { lag });
  console.log(`  신호 ${lag}봉 지연 | 총익 ${(s.total.toFixed(0) + '%').padStart(7)} · PF ${s.pf.toFixed(2)} · 거래 ${s.n}`);
}

console.log('\n◆ B 무작위 대조군 — 같은 빈도로 아무 때나 사면 (edge 없으면 비용만큼 마이너스여야)');
for (const seedIdx of [1, 2, 3, 4, 5]) {
  const p = base.n / (TS.length * MKTS.length) * 3;   // 진입 빈도 근사 맞춤
  const s = sim(4, 2, 3, { random: p, seed: seedIdx });
  console.log(`  무작위 #${seedIdx} | 총익 ${(s.total.toFixed(0) + '%').padStart(7)} · PF ${s.pf.toFixed(2)} · 거래 ${s.n}`);
}

console.log('\n◆ C 부호 반전 — 급락 대신 급등을 사면?');
for (const d of [3, 4, 5]) {
  const dn = sim(d, 2, 3, { sign: -1 }), up = sim(d, 2, 3, { sign: +1 });
  console.log(`  ±${d}% | 급락매수 ${(dn.total.toFixed(0) + '%').padStart(7)} (PF ${dn.pf.toFixed(2)}) vs 급등매수 ${(up.total.toFixed(0) + '%').padStart(7)} (PF ${up.pf.toFixed(2)})`);
}

console.log('\n◆ E 생존 편향');
console.log(`  이 28종은 전부 2026-08 현재 업비트에 상장돼 있는 코인이다.`);
console.log(`  상장폐지된 코인은 API 에서 사라지므로 과거 검증에 넣을 수 없다.`);
console.log(`  → 급락 후 반등을 사는 전략은 "결국 살아남은 코인"만 보는 셈이라 낙관 편향이 있다.`);
console.log(`  급락 후 회복하지 못하고 사라진 코인이 표본에서 통째로 빠져 있다는 뜻.`);
