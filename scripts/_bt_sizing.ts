/**
 * 자금관리 알고리즘 비교 — 신호(F6 돌파)는 고정, "얼마를 어떻게 태우고 어떻게 빼느냐"만 변경.
 *
 * 배경: 신규 신호는 전부 탈락했고(_bt_newideas), 종목 선발은 현행이 이미 최적에 가깝다(_bt_selection).
 *       남은 개선 여지는 베팅 크기와 청산 구조뿐이라는 결론에서 출발한다.
 *
 *   A 현행         : 현금의 33%씩 최대 3종, 트레일링 A2(-2% 스톱, +2% 후 고점-2%)
 *   B 변동성 타겟   : 코인별 ATR%에 반비례해 크기 조절(변동성 큰 코인은 적게) — 평균 노출은 A와 동일
 *   C 절반 익절     : +5%에서 절반 실현, 나머지는 트레일링으로 끝까지
 *   D B+C          : 둘 다
 *
 * 전부 lookahead-safe: ATR 은 진입 직전 확정봉까지만 사용.
 * 실행: npx tsx scripts/_bt_sizing.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, INIT = 10_000_000;

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
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;
/** 진입 직전 확정봉까지의 ATR% (14봉 true range 평균 / 종가) */
function atrPct(b: Bar[], i: number, n = 14): number {
  if (i < n + 1) return 0.02;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const tr = Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close));
    s += tr;
  }
  return (s / n) / b[i].close;
}

interface Cfg { volTarget: boolean; halfTp: boolean; positionPct: number; maxConcurrent: number }
interface Res { total: number; mdd: number; trades: number; wr: number; pf: number; expo: number }

function run(cfg: Cfg, from?: number, to?: number): Res {
  const SL = -2, ACT = 2, GAP = 2, MAXB = 84, HALF_TP = 5;
  const TARGET_ATR = 0.02;   // 기준 변동성 2% — 이보다 출렁이면 작게, 잔잔하면 크게
  let cash = INIT;
  const open: Array<{ m: string; ep: number; vol: number; used: number; ei: number; peak: number; tsl: number; armed: boolean; halfDone: boolean }> = [];
  let peakEq = INIT, mdd = 0, wins = 0, gw = 0, gl = 0, n = 0, expoSum = 0, expoN = 0;
  const t0 = from ? Math.max(200, TS.findIndex(x => x >= from)) : 200;
  const t1raw = to ? TS.findIndex(x => x >= to) : TS.length;
  const t1 = t1raw < 0 ? TS.length : t1raw;

  for (let t = t0; t < t1; t++) {
    const ts = TS[t];
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]; const b = SERIES.get(pos.m)!; const i = IDX.get(pos.m)!.get(ts);
      if (i === undefined || i <= pos.ei) continue;
      const bar = b[i];
      // C: 절반 익절 (같은 봉에서 스톱과 동시 충족되면 스톱을 먼저 — 보수적)
      if (cfg.halfTp && !pos.halfDone && bar.low > pos.tsl && bar.high >= pos.ep * (1 + HALF_TP / 100)) {
        const px = pos.ep * (1 + HALF_TP / 100);
        const half = pos.vol / 2;
        const proceeds = half * px * (1 - SLIP) * (1 - FEE);
        const usedHalf = pos.used / 2;
        cash += proceeds; pos.vol -= half; pos.used -= usedHalf; pos.halfDone = true;
        const r = proceeds / usedHalf - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
      }
      let px = 0, done = false;
      if (bar.low <= pos.tsl) { px = pos.tsl; done = true; }
      else {
        pos.peak = Math.max(pos.peak, bar.high);
        if (!pos.armed && pos.peak >= pos.ep * (1 + ACT / 100)) pos.armed = true;
        if (pos.armed) pos.tsl = Math.max(pos.tsl, pos.peak * (1 - GAP / 100));
      }
      if (!done && (i - pos.ei) >= MAXB) { px = bar.close; done = true; }
      if (done) {
        const proceeds = pos.vol * px * (1 - SLIP) * (1 - FEE);
        cash += proceeds;
        const r = proceeds / pos.used - 1;
        n++; if (r > 0) { wins++; gw += r; } else gl += -r;
        open.splice(p, 1);
      }
    }
    if (open.length < cfg.maxConcurrent && t < t1 - 20) {
      for (const [m, b] of SERIES) {
        if (open.length >= cfg.maxConcurrent) break;
        if (open.some(p => p.m === m)) continue;
        const i = IDX.get(m)!.get(ts); if (i === undefined || i + 1 >= b.length) continue;
        if (!sigF6(b, i)) continue;
        let pct = cfg.positionPct;
        if (cfg.volTarget) {
          const a = atrPct(b, i);
          pct = Math.min(cfg.positionPct * 2, Math.max(cfg.positionPct * 0.4, cfg.positionPct * (TARGET_ATR / Math.max(a, 1e-6))));
        }
        const use = cash * pct; if (use < 5000) continue;
        const ep = b[i + 1].open * (1 + SLIP);
        cash -= use;
        open.push({ m, ep, vol: use * (1 - FEE) / ep, used: use, ei: i + 1, peak: ep, tsl: ep * (1 + SL / 100), armed: false, halfDone: false });
      }
    }
    let eq = cash, inv = 0;
    for (const p of open) { const i = IDX.get(p.m)!.get(ts); if (i !== undefined) { const v = p.vol * SERIES.get(p.m)![i].close; eq += v; inv += v; } }
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq * 100);
    expoSum += eq > 0 ? inv / eq : 0; expoN++;
  }
  let fin = cash;
  const lastTs = TS[Math.min(t1 - 1, TS.length - 1)];
  for (const p of open) { const i = IDX.get(p.m)!.get(lastTs); if (i !== undefined) fin += p.vol * SERIES.get(p.m)![i].close; }
  return { total: (fin / INIT - 1) * 100, mdd, trades: n, wr: n ? wins / n * 100 : 0, pf: gl > 0 ? gw / gl : 99, expo: expoN ? expoSum / expoN * 100 : 0 };
}

const VAR: Array<[string, Cfg]> = [
  ['A 현행 (33%×3, 트레일)',   { volTarget: false, halfTp: false, positionPct: 0.33, maxConcurrent: 3 }],
  ['B 변동성 타겟 사이징',       { volTarget: true,  halfTp: false, positionPct: 0.33, maxConcurrent: 3 }],
  ['C 절반 익절 + 트레일',       { volTarget: false, halfTp: true,  positionPct: 0.33, maxConcurrent: 3 }],
  ['D B+C',                  { volTarget: true,  halfTp: true,  positionPct: 0.33, maxConcurrent: 3 }],
  ['A2 집중 (50%×2)',         { volTarget: false, halfTp: false, positionPct: 0.50, maxConcurrent: 2 }],
  ['B2 변동성타겟 집중 (50%×2)', { volTarget: true,  halfTp: false, positionPct: 0.50, maxConcurrent: 2 }],
];
console.log(`=== 자금관리 비교 (${SERIES.size}코인 4h, ${new Date(TS[200]).toISOString().slice(0,7)}~${new Date(TS[TS.length-1]).toISOString().slice(0,7)}) ===`);
console.log('  신호=F6 돌파 고정. 노출=평균 투자비중(현금 제외분)\n');
console.log('  변형                      |     총익 |    MDD | 수익/MDD | 체결 |    WR |    PF | 노출');
const done: Array<[string, Cfg, Res]> = [];
for (const [name, cfg] of VAR) {
  const r = run(cfg); done.push([name, cfg, r]);
  console.log(`  ${name.padEnd(24)}| ${(r.total.toFixed(0)+'%').padStart(8)} | ${(r.mdd.toFixed(1)+'%').padStart(6)} | ${(r.mdd>0?r.total/r.mdd:0).toFixed(2).padStart(8)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(1).padStart(4)}% | ${r.pf.toFixed(2).padStart(5)} | ${r.expo.toFixed(0).padStart(3)}%`);
}
console.log('\n◆ 기간 분할 (총익 / MDD, 구간마다 자본 리셋)');
const P: Array<[string, string, string]> = [
  ['2022H2','2022-07-01','2023-01-01'], ['2023','2023-01-01','2024-01-01'],
  ['2024','2024-01-01','2025-01-01'], ['2025','2025-01-01','2026-01-01'], ['2026','2026-01-01','2026-09-01'],
];
console.log('  기간     | ' + done.map(([n]) => n.slice(0, 12).padStart(14)).join(' | '));
for (const [pn, f, t] of P) {
  const cells = done.map(([, cfg]) => {
    const r = run(cfg, Date.parse(f + 'T00:00:00Z'), Date.parse(t + 'T00:00:00Z'));
    return `${(r.total.toFixed(0)+'%').padStart(6)}/${(r.mdd.toFixed(0)+'%').padStart(3)}`.padStart(14);
  });
  console.log(`  ${pn.padEnd(8)} | ` + cells.join(' | '));
}
