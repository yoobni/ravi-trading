/**
 * 급등 결합 후보를 "체결 현실"로 재채점 (2026-10-01).
 *
 * `_bt_surge.ts` 의 판정은 트레일 트리거 '가격'에 정산한다. 그런데 업비트 Open API 는
 * 스톱 주문이 없어 실제로는 폴링 후 시장가뿐이고, 그 할인이 F6 기준 PF 1.756→1.299 였다
 * (`_bt_execreal.ts`). 문제는 **급등 진입이 고변동 봉이라 트레일 격차가 더 클 수 있다**는 것.
 * 그러면 결합의 우위가 깎인다. 그걸 직접 잰다.
 *
 * 설계: 1h 캐시로 봉 안을 보되 신호·진입·청산규칙은 4h 그대로. 신호 출처(F6 / SURGE)를
 *   분리해 각각의 열화를 따로 본다. 슬롯 경쟁 없는 독립 거래 — 차이가 전부 신호×체결에서만 나오게.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, FR = (1 - FEE) ** 2 * (1 - SLIP) / (1 + SLIP);
const H = 3600_000;
const SL = -2, ACT = 2, GAP = 2, MAX_H = 84 * 4;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load1h(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(m + '_60m_'));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
function to4h(h1: Bar[]): Bar[] {
  const bk = new Map<number, Bar[]>();
  for (const b of h1) { const k = Math.floor(b.ts / (4 * H)) * 4 * H; (bk.get(k) ?? bk.set(k, []).get(k)!).push(b); }
  const out: Bar[] = [];
  for (const k of [...bk.keys()].sort((a, b) => a - b)) {
    const s = bk.get(k)!.sort((a, b) => a.ts - b.ts);
    if (s.length !== 4) continue;
    out.push({ ts: k, open: s[0].open, high: Math.max(...s.map(x => x.high)), low: Math.min(...s.map(x => x.low)), close: s[3].close, volume: s.reduce((a, x) => a + x.volume, 0) });
  }
  return out;
}
const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
const sigSurge = (b: Bar[], i: number, pct: number, vz: number) =>
  i >= 43 && (b[i].close / b[i].open - 1) >= pct / 100 && b[i].close > b[i].open && volZ(b, i) >= vz;

const DATA: Array<{ m: string; h1: Bar[]; h4: Bar[]; idx1: Map<number, number> }> = [];
for (const m of COINS) {
  const h1 = load1h(m); if (!h1 || h1.length < 2000) continue;
  DATA.push({ m, h1, h4: to4h(h1), idx1: new Map(h1.map((b, i) => [b.ts, i])) });
}

/** 4h 봉마감마다 확인. settle='stop' 트리거가격 / 'market' 확인시점 종가 */
function exitSim(h1: Bar[], s1: number, ep: number, settle: 'stop' | 'market') {
  let stop = ep * (1 + SL / 100), peak = ep, armed = false;
  for (let j = s1; j < h1.length && j - s1 < MAX_H; j++) {
    const b = h1[j];
    const isPoll = ((b.ts + H) / H) % 4 === 0;
    const broke = b.low <= stop;
    if (isPoll) {
      if (broke) return { px: settle === 'stop' ? stop : b.close, hours: j - s1 + 1 };
      peak = Math.max(peak, hiOf(h1, s1, j + 1));
      if (!armed && peak >= ep * (1 + ACT / 100)) armed = true;
      if (armed) stop = Math.max(stop, peak * (1 - GAP / 100));
    } else if (broke) {
      for (let k = j + 1; k < h1.length && k - s1 < MAX_H; k++) {
        if (((h1[k].ts + H) / H) % 4 === 0) return { px: settle === 'stop' ? stop : h1[k].close, hours: k - s1 + 1 };
      }
      break;
    }
  }
  const last = h1[Math.min(s1 + MAX_H - 1, h1.length - 1)];
  return last ? { px: last.close, hours: MAX_H } : null;
}

function collect(pct: number, vz: number, settle: 'stop' | 'market') {
  const f6: number[] = [], sg: number[] = [];
  for (const d of DATA) {
    for (let i = 43; i < d.h4.length - 1; i++) {
      const isF6 = sigF6(d.h4, i);
      const isSg = !isF6 && sigSurge(d.h4, i, pct, vz);   // F6 아닌 급등만 = 증분
      if (!isF6 && !isSg) continue;
      const eb = d.h4[i + 1]; const ep = eb.open * (1 + SLIP);
      const s1 = d.idx1.get(eb.ts); if (s1 === undefined) continue;
      const r = exitSim(d.h1, s1 + 4, ep, settle); if (!r) continue;
      (isF6 ? f6 : sg).push((r.px / ep) * FR - 1);
    }
  }
  return { f6, sg };
}
const stat = (r: number[]) => {
  if (!r.length) return { n: 0, avg: 0, pf: 0, wr: 0 };
  const w = r.filter(x => x > 0), l = r.filter(x => x <= 0);
  const gl = Math.abs(l.reduce((a, b) => a + b, 0));
  return { n: r.length, avg: 100 * r.reduce((a, b) => a + b, 0) / r.length, wr: 100 * w.length / r.length, pf: gl ? w.reduce((a, b) => a + b, 0) / gl : Infinity };
};

console.log(`코인 ${DATA.length}종 · 1h봉 ${DATA.reduce((a, d) => a + d.h1.length, 0).toLocaleString()}개 (2024-06~2026-08)\n`);
console.log('급등조건      출처     정산      건수   거래당평균    승률      PF');
for (const [pct, vz] of [[7, 1], [6, 1.5], [8, 1]] as const) {
  for (const settle of ['stop', 'market'] as const) {
    const { f6, sg } = collect(pct, vz, settle);
    for (const [label, r] of [['F6', f6], ['SURGE', sg]] as const) {
      const s = stat(r);
      console.log(`+${pct}% z${vz}`.padEnd(13) + `${label}`.padEnd(8) + `${settle}`.padEnd(9) +
        `${s.n}`.padStart(5) + `${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}%`.padStart(12) +
        `${s.wr.toFixed(1)}%`.padStart(8) + `${s.pf.toFixed(3)}`.padStart(8));
    }
  }
  console.log('');
}

// ── 추가 검증 ①: 기전 — 트리거가격 대비 확인시점 종가가 얼마나 나쁜가 (출처별) ──
function gaps(pct: number, vz: number) {
  const g: Record<string, number[]> = { F6: [], SURGE: [] };
  for (const d of DATA) {
    for (let i = 43; i < d.h4.length - 1; i++) {
      const isF6 = sigF6(d.h4, i); const isSg = !isF6 && sigSurge(d.h4, i, pct, vz);
      if (!isF6 && !isSg) continue;
      const eb = d.h4[i + 1]; const ep = eb.open * (1 + SLIP);
      const s1 = d.idx1.get(eb.ts); if (s1 === undefined) continue;
      const a = exitSim(d.h1, s1 + 4, ep, 'stop'), b = exitSim(d.h1, s1 + 4, ep, 'market');
      if (!a || !b) continue;
      g[isF6 ? 'F6' : 'SURGE'].push(100 * (b.px / a.px - 1));
    }
  }
  return g;
}
console.log('── 체결격차 기전 (+7% z1): 확인시점 종가 vs 트리거가격 ──');
{
  const g = gaps(7, 1);
  for (const k of ['F6', 'SURGE']) {
    const v = g[k].filter(x => x !== 0); const all = g[k];
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    const s = [...v].sort((a, b) => a - b);
    console.log(`  ${k.padEnd(6)} n=${all.length}  전체평균 ${avg.toFixed(3)}%  격차발생 ${v.length}건(${(100 * v.length / all.length).toFixed(0)}%) 그중 평균 ${(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)).toFixed(3)}%  최악 ${s.length ? s[0].toFixed(2) : '-'}%`);
  }
}
// ── 추가 검증 ②: 기간분할 (시장가 정산 기준) ──
console.log('\n── 기간분할 · 시장가 정산 (+7% z1) · 거래당 평균 ──');
{
  const SPLITS: Array<[string, number, number]> = [
    ['2024H2', Date.UTC(2024, 5, 1), Date.UTC(2024, 11, 31)],
    ['2025H1', Date.UTC(2025, 0, 1), Date.UTC(2025, 5, 30)],
    ['2025H2', Date.UTC(2025, 6, 1), Date.UTC(2025, 11, 31)],
    ['2026YTD', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)],
  ];
  console.log('  구간      F6(n)            SURGE(n)         SURGE 우세?');
  for (const [lab, a, b] of SPLITS) {
    const f6: number[] = [], sg: number[] = [];
    for (const d of DATA) {
      for (let i = 43; i < d.h4.length - 1; i++) {
        if (d.h4[i].ts < a || d.h4[i].ts > b) continue;
        const isF6 = sigF6(d.h4, i); const isSg = !isF6 && sigSurge(d.h4, i, 7, 1);
        if (!isF6 && !isSg) continue;
        const eb = d.h4[i + 1]; const ep = eb.open * (1 + SLIP);
        const s1 = d.idx1.get(eb.ts); if (s1 === undefined) continue;
        const r = exitSim(d.h1, s1 + 4, ep, 'market'); if (!r) continue;
        (isF6 ? f6 : sg).push((r.px / ep) * FR - 1);
      }
    }
    const A = stat(f6), B = stat(sg);
    console.log(`  ${lab.padEnd(9)} ${((A.avg >= 0 ? '+' : '') + A.avg.toFixed(3) + '%').padStart(8)} (${String(A.n).padStart(3)})   ${((B.avg >= 0 ? '+' : '') + B.avg.toFixed(3) + '%').padStart(8)} (${String(B.n).padStart(3)})   ${B.avg > A.avg ? '예' : '아니오'}`);
  }
}
