/**
 * 가설 C — "체결 손실이 0 인 설계" (2026-10-01)
 *
 * 업비트의 구조적 비대칭:
 *   ▲ 위로: 지정가 매도를 호가창에 **미리 올려둘 수 있다** → 목표가에 정확히 체결(슬리피지 0)
 *   ▼ 아래로: 스톱 주문이 API 에 없다 → 폴링 후 시장가뿐 (실측 손해의 전부가 여기서 나왔다)
 *
 * 그래서 **아래쪽 트리거를 아예 쓰지 않는 설계**를 시험한다. 쓸 수 있는 청산은 둘뿐:
 *   TP   — 진입×(1+tp) 에 지정가 매도를 걸어둔다. 봉 고가가 닿으면 그 가격에 체결. 슬리피지 0.
 *   TIME — N일 뒤 시장가 청산. 특정 가격을 노리는 게 아니므로 '격차'가 없다(통상 슬리피지만).
 * 선택적으로 **재난 스톱**(−15% 등)만 남긴다 — 거의 안 걸리므로 격차 비용이 희박하다.
 *
 * 비교 대상: 현행 A2(트레일, 현실 체결) / BTC 축소보유(동일 MDD).
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE0 = 0.0005, SLIP0 = 0.0005, INIT = 10_000_000;
let FEE = FEE0, SLIP = SLIP0;
const H = 3600_000, FOUR = 4 * H;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
let ORDER: string[] = [];
let LAG = 0;        // 신호를 N봉 늦춘다 (미래참조 검사)
let RANDF = 0;      // >0 이면 그 확률로 무작위 진입 (플라시보)
let SEED = 1;
const rnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
let FRIC = 1;
const setFric = (f: number) => { FRIC = f; FEE = FEE0 * f; SLIP = SLIP0 * f; };
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) RAW.set(m, b); }
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
ORDER = [...RAW.keys()];

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

/** 청산 설계 */
interface Design {
  kind: 'TRAIL' | 'TPONLY';
  sl?: number; act?: number; gap?: number;        // TRAIL
  rungs?: Array<[number, number]>;                // TPONLY: [목표%, 비중] 사다리
  maxb: number;                                   // 시간청산 (4h봉 수)
  disaster?: number;                               // 재난 스톱 % (음수) — 없으면 미사용
}
interface Pos { m: string; ep: number; vol: number; used: number; left: number; bars: number; peak: number; stop: number; armed: boolean; last: number; done: number[] }

function run(d: Design, size: number, from = 0, to = Infinity) {
  let cash = INIT; const open: Pos[] = [];
  let peakEq = INIT, mdd = 0, n = 0, sumR = 0, gapCost = 0, gapN = 0;
  for (const ts of TS) {
    if (ts < from || ts > to) continue;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const i = IDX.get(q.m)!.get(ts); if (i === undefined) continue;
      const bar = RAW.get(q.m)![i]; q.last = bar.close; q.bars++;
      let closed = false;
      if (d.kind === 'TRAIL') {
        if (bar.low <= q.stop) {                           // 스톱: 확인시점 종가 체결(현실)
          const px = bar.close;
          gapCost += (px / q.stop - 1); gapN++;
          cash += q.left * px * (1 - SLIP) * (1 - FEE); n++; sumR += (q.left * px * (1 - SLIP) * (1 - FEE)) / q.used - 1;
          closed = true;
        } else {
          q.peak = Math.max(q.peak, bar.high);
          if (!q.armed && q.peak >= q.ep * (1 + d.act! / 100)) q.armed = true;
          if (q.armed) q.stop = Math.max(q.stop, q.peak * (1 - d.gap! / 100));
        }
      } else {
        // TPONLY: 호가창에 올려둔 지정가 매도 — 고가가 닿으면 **그 가격에** 체결 (슬리피지 0)
        for (let k = 0; k < d.rungs!.length; k++) {
          if (q.done.includes(k)) continue;
          const [tp, w] = d.rungs![k];
          const target = q.ep * (1 + tp / 100);
          if (bar.high >= target) {
            const part = q.used * w;
            const volPart = (part / q.used) * (q.used * (1 - FEE) / q.ep);
            cash += volPart * target * (1 - FEE);          // 슬리피지 없음 = 지정가 체결
            q.left -= volPart; q.done.push(k);
            n++; sumR += (volPart * target * (1 - FEE)) / part - 1;
          }
        }
        if (d.disaster != null && bar.low <= q.ep * (1 + d.disaster / 100) && q.left > 0) {
          const px = bar.close;                             // 재난 스톱만 시장가(격차 발생)
          const basis = q.used * (1 - d.rungs!.filter((_, k) => q.done.includes(k)).reduce((a, r) => a + r[1], 0));
          gapCost += (px / (q.ep * (1 + d.disaster / 100)) - 1); gapN++;
          cash += q.left * px * (1 - SLIP) * (1 - FEE); n++; sumR += (q.left * px * (1 - SLIP) * (1 - FEE)) / Math.max(basis, 1) - 1;
          q.left = 0; closed = true;
        }
        if (q.left <= 1e-12) closed = true;
      }
      if (!closed && q.bars >= d.maxb) {                    // 시간청산 — 시장가, 격차 개념 없음
        const basis = d.kind === 'TPONLY'
          ? q.used * (1 - d.rungs!.filter((_, k) => q.done.includes(k)).reduce((a, r) => a + r[1], 0))
          : q.used;
        if (q.left > 0 && basis > 1) {
          cash += q.left * bar.close * (1 - SLIP) * (1 - FEE); n++;
          sumR += (q.left * bar.close * (1 - SLIP) * (1 - FEE)) / basis - 1;
        }
        closed = true;
      }
      if (closed) open.splice(p, 1);
    }
    if (open.length < 3) {
      for (const m of ORDER) {
        if (open.length >= 3) break;
        const bb = RAW.get(m)!; const i = IDX.get(m)!.get(ts);
        if (i === undefined || i < 45) continue;
        const ok = RANDF > 0 ? rnd() < RANDF : sigF6(bb, i - 1 - LAG);
        if (!ok) continue;
        if (open.some(q => q.m === m)) continue;
        const ep = bb[i].open * (1 + SLIP); const used = cash * size;
        if (used < 5000) continue;
        cash -= used;
        const vol = used * (1 - FEE) / ep;
        open.push({ m, ep, vol, used, left: vol, bars: 0, peak: ep, stop: ep * (1 + (d.sl ?? -99) / 100), armed: false, last: ep, done: [] });
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.left * q.last, 0);
    peakEq = Math.max(peakEq, eq); mdd = Math.max(mdd, (peakEq - eq) / peakEq);
  }
  const eq = cash + open.reduce((a, q) => a + q.left * q.last, 0);
  return { ret: 100 * (eq / INIT - 1), mdd: 100 * mdd, n, avg: n ? 100 * sumR / n : 0,
           gap: gapN ? 100 * gapCost / gapN : 0, gapN };
}
function sizeFor(d: Design, target: number) {
  let lo = 0.02, hi = 0.95;
  for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (run(d, mid).mdd > target) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
const T = 17;
const show = (lab: string, d: Design) => {
  const s = sizeFor(d, T); const r = run(d, s);
  console.log(`${lab.padEnd(34)} ${(r.ret.toFixed(0) + '%').padStart(7)} ${(r.mdd.toFixed(1) + '%').padStart(6)} ${((s * 100).toFixed(1) + '%').padStart(7)} ${String(r.n).padStart(6)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%').padStart(8)} ${(r.gapN ? r.gap.toFixed(3) + '% (' + r.gapN + ')' : '없음').padStart(16)}`);
  return r.ret;
};
const T2 = 17;
const cell = (d: Design, from = 0, to = Infinity) => { const sz = sizeFor(d, T2); return run(d, sz, from, to).ret; };
const CAND: Design = { kind: 'TPONLY', rungs: [[7, 1]], maxb: 18 };      // 후보: TP+7% · 3일
const BASE: Design = { kind: 'TRAIL', sl: -2, act: 2, gap: 2, maxb: 84 }; // 현행 A2
console.log('후보 = TP단일 +7% · 3일 시간청산 · 스톱 없음 (체결격차 0)\n');
console.log(`  후보        ${cell(CAND).toFixed(0)}%`);
console.log(`  현행 A2     ${cell(BASE).toFixed(0)}%`);
console.log(`  BTC 축소보유  +15%`);

console.log('\n① 결정적 대조군 — 이득이 "스톱 제거"인가 "짧은 보유"인가');
console.log(`  A2 트레일 + 3일 시간청산          ${cell({ kind: 'TRAIL', sl: -2, act: 2, gap: 2, maxb: 18 }).toFixed(0)}%`);
console.log(`  A2 트레일 + 3일, 스톱만 제거(=후보)  ${cell(CAND).toFixed(0)}%`);
console.log(`  넓은스톱(-10%) + TP+7% + 3일       ${cell({ kind: 'TPONLY', rungs: [[7, 1]], maxb: 18, disaster: -10 }).toFixed(0)}%`);
console.log(`  재난스톱(-15%) + TP+7% + 3일       ${cell({ kind: 'TPONLY', rungs: [[7, 1]], maxb: 18, disaster: -15 }).toFixed(0)}%`);

console.log('\n② 미래참조 검사 — 신호를 N봉 늦추면 무너져야 한다');
for (const lag of [0, 1, 2, 3]) { LAG = lag; console.log(`  지연 ${lag}봉: ${cell(CAND).toFixed(0)}%`); }
LAG = 0;

console.log('\n③ 플라시보 — 같은 빈도로 무작위 진입');
for (const sd of [1, 2, 3]) { SEED = sd * 7919 + 13; RANDF = 0.012; console.log(`  무작위 #${sd}: ${cell(CAND).toFixed(0)}%`); }
RANDF = 0;

console.log('\n④ 마찰 스트레스');
for (const f of [1, 2, 3]) { setFric(f); console.log(`  왕복 ${(0.2 * f).toFixed(1)}%: 후보 ${cell(CAND).toFixed(0)}% / A2 ${cell(BASE).toFixed(0)}%`); }
setFric(1);

console.log('\n⑤ 기간분할');
const SP: Array<[string, number, number]> = [['2022H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)],
  ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
  ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
let wins = 0;
for (const [lab, a, b] of SP) {
  const c = cell(CAND, a, b), z = cell(BASE, a, b);
  if (c > z) wins++;
  console.log(`  ${lab.padEnd(11)} 후보 ${(c.toFixed(0)+'%').padStart(6)}  A2 ${(z.toFixed(0)+'%').padStart(6)}  ${c > z ? '우세' : '열위'}`);
}
console.log(`  → ${wins}/4 구간 우세`);

console.log('\n⑥ 하네스 민감도 — 코인 배열 순서');
const base0 = [...RAW.keys()];
const orders: Array<[string, string[]]> = [['시총순', [...base0]], ['역순', [...base0].reverse()], ['알파벳', [...base0].sort()],
  ['셔플A', [...base0].map((m,i)=>[m,(i*7)%base0.length] as [string,number]).sort((x,y)=>x[1]-y[1]).map(([m])=>m)],
  ['셔플B', [...base0].map((m,i)=>[m,(i*13)%base0.length] as [string,number]).sort((x,y)=>x[1]-y[1]).map(([m])=>m)]];
for (const [lab, o] of orders) { ORDER = o; console.log(`  ${lab.padEnd(7)} 후보 ${(cell(CAND).toFixed(0)+'%').padStart(6)}  A2 ${(cell(BASE).toFixed(0)+'%').padStart(6)}`); }
ORDER = base0;

console.log('\n⑦ 워크포워드 — 앞 절반(~2024-08)에서 TP/일수 고르고 뒤 절반 적용');
{
  const IS_END = Date.UTC(2024, 7, 1);
  let best = { tp: 0, dy: 0, v: -1e9 };
  for (const tp of [3,4,5,6,7,8,10,12]) for (const dy of [2,3,4,5,7]) {
    const v = cell({ kind: 'TPONLY', rungs: [[tp,1]], maxb: dy*6 }, 0, IS_END);
    if (v > best.v) best = { tp, dy, v };
  }
  const oos = cell({ kind: 'TPONLY', rungs: [[best.tp,1]], maxb: best.dy*6 }, IS_END, Infinity);
  const oosA2 = cell(BASE, IS_END, Infinity);
  console.log(`  IS 최적 = TP+${best.tp}% · ${best.dy}일 (IS ${best.v.toFixed(0)}%)`);
  console.log(`  OOS 후보 ${oos.toFixed(0)}%  /  OOS A2 ${oosA2.toFixed(0)}%`);
}

console.log('\n⑦b 워크포워드 정밀 — IS/OOS 각각의 격자 전체를 본다 (고원이 OOS 에서도 유지되나)');
{
  const IS_END = Date.UTC(2024, 7, 1);
  const DAYS = [2, 3, 4, 5, 7];
  const TPS = [3, 4, 5, 6, 7, 8, 10];
  for (const [lab, a, b] of [['IS (2022-07~2024-08)', 0, IS_END], ['OOS (2024-08~2026-08)', IS_END, Infinity]] as Array<[string, number, number]>) {
    console.log(`\n  ${lab}   (행=TP%, 열=일수)`);
    console.log('    TP\\일 ' + DAYS.map(d => String(d).padStart(7)).join(''));
    const vals: number[] = [];
    for (const tp of TPS) {
      const row = DAYS.map(dy => cell({ kind: 'TPONLY', rungs: [[tp, 1]], maxb: dy * 6 }, a, b));
      vals.push(...row);
      console.log(`    +${String(tp).padStart(2)}% ` + row.map(v => (v.toFixed(0) + '%').padStart(7)).join(''));
    }
    const a2 = cell(BASE, a, b);
    const beat = vals.filter(v => v > a2).length;
    console.log(`    A2 대조군 ${a2.toFixed(0)}%  → 후보 격자 ${beat}/${vals.length} 칸이 A2 초과, 격자 중앙값 ${vals.slice().sort((x,y)=>x-y)[Math.floor(vals.length/2)].toFixed(0)}%`);
  }
}
