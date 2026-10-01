/**
 * 가설 H1 — "스톱은 종가로 판정해야 한다" (2026-10-01)
 *
 * 근거: 오늘 페이퍼 291건 측정에서 **손절 체결격차가 평균 −0.026%, 53% 는 오히려 유리**했다.
 *   가격이 손절선을 한 번 찍고 되돌아오는 일이 절반이라는 뜻이다. 그런데 현행 규칙은
 *   `bar.low <= stop` — **봉 안에서 한 번 찍기만 하면 나간다**. 되돌아올 절반을 버리고 있다.
 *
 * 그래서 비교한다:
 *   touch — 저가가 스톱을 찍으면 청산 (현행)
 *   close — **봉이 스톱 아래에서 마감해야** 청산
 * 둘 다 '확인 시점 종가' 체결(= 업비트에서 실제 가능한 체결)로 동일 조건.
 * close 규칙은 예약 스톱 주문이 아예 필요 없다는 부수 장점도 있다.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005, FR = (1 - FEE) ** 2 * (1 - SLIP) / (1 + SLIP);
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best;
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

const DATA: Array<{ m: string; b: Bar[] }> = [];
for (const m of COINS) { const b = load(m); if (b && b.length > 500) DATA.push({ m, b }); }

/** 청산: 현실 체결(봉 종가)로 고정. 판정 기준만 touch/close 로 바꾼다 */
function exitSim(b: Bar[], s: number, ep: number, rule: 'touch' | 'close' | 'none', sl: number, act: number, gap: number, maxB: number) {
  let stop = ep * (1 + sl / 100), peak = ep, armed = false;
  for (let j = s; j < b.length && j - s < maxB; j++) {
    const bar = b[j];
    const hit = rule === 'none' ? false : rule === 'touch' ? bar.low <= stop : bar.close <= stop;
    if (hit) return { px: bar.close, bars: j - s + 1 };     // 확인 시점 = 봉마감 → 종가 체결
    peak = Math.max(peak, bar.high);
    if (!armed && peak >= ep * (1 + act / 100)) armed = true;
    if (armed) stop = Math.max(stop, peak * (1 - gap / 100));
  }
  const last = b[Math.min(s + maxB - 1, b.length - 1)];
  return last ? { px: last.close, bars: maxB } : null;
}
function run(rule: 'touch' | 'close' | 'none', sl: number, act: number, gap: number, from = 0, to = Infinity) {
  const r: number[] = []; const hold: number[] = [];
  for (const d of DATA) {
    for (let i = 43; i < d.b.length - 1; i++) {
      if (!sigF6(d.b, i)) continue;
      if (d.b[i].ts < from || d.b[i].ts > to) continue;
      const ep = d.b[i + 1].open * (1 + SLIP);
      const e = exitSim(d.b, i + 2, ep, rule, sl, act, gap, 84); if (!e) continue;
      r.push((e.px / ep) * FR - 1); hold.push(e.bars);
    }
  }
  const w = r.filter(x => x > 0), l = r.filter(x => x <= 0);
  const gl = Math.abs(l.reduce((a, b) => a + b, 0));
  return { n: r.length, avg: 100 * r.reduce((a, b) => a + b, 0) / r.length, wr: 100 * w.length / r.length,
           pf: gl ? w.reduce((a, b) => a + b, 0) / gl : Infinity, hold: hold.reduce((a, b) => a + b, 0) / hold.length };
}
console.log(`28코인 4h · 신호 ${run('touch', -2, 2, 2).n}건 · 전부 "확인시점 종가" 체결(업비트 가능 조건)\n`);
console.log('스톱판정  SL    ACT/GAP   거래당평균   승률      PF    평균보유(봉)');
for (const [sl, act, gap] of [[-2, 2, 2], [-3, 2, 2], [-4, 2, 3], [-2, 3, 3]] as const) {
  for (const rule of ['touch', 'close'] as const) {
    const r = run(rule, sl, act, gap);
    console.log(`${rule.padEnd(9)} ${String(sl).padEnd(5)} ${(act + '/' + gap).padEnd(9)} ` +
      `${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(3) + '%').padStart(10)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(3).padStart(7)} ${r.hold.toFixed(1).padStart(10)}`);
  }
}
// ── H1b: A2 파라미터는 '불가능한 체결' 위에서 고른 값이다. 현실 체결로 다시 스윕 ──
console.log('\n── 재스윕: 현실 체결 기준 최적 스톱 (touch 규칙) ──');
console.log('   GAP→      2        3        4        5        6');
let best = { avg: -9, lab: '' };
for (const sl of [-2, -3, -4, -5, -6, -8]) {
  const row: string[] = [];
  for (const gap of [2, 3, 4, 5, 6]) {
    const r = run('touch', sl, 2, gap);
    if (r.avg > best.avg) best = { avg: r.avg, lab: `SL${sl} ACT2 GAP${gap} (PF ${r.pf.toFixed(3)})` };
    row.push(`${(r.avg >= 0 ? '+' : '') + r.avg.toFixed(3)}%`.padStart(8));
  }
  console.log(`SL ${String(sl).padStart(3)}  ` + row.join(' '));
}
console.log(`\n최고: ${best.lab} → 거래당 ${best.avg.toFixed(3)}%  (현행 A2 = SL-2 GAP2)`);

// ── 대조군: 스톱 없이 시간청산만 (청산 규칙이 값을 만드나?) ──
console.log('\n── 대조군: 스톱 없음 = 14일 시간청산만 ──');
{
  const z = run('none', -2, 2, 2);
  const a2 = run('touch', -2, 2, 2);
  const wide = run('touch', -8, 2, 6);
  console.log(`  스톱 없음       거래당 ${(z.avg>=0?'+':'')+z.avg.toFixed(3)}%  PF ${z.pf.toFixed(3)}  승률 ${z.wr.toFixed(1)}%  평균보유 ${z.hold.toFixed(1)}봉`);
  console.log(`  현행 A2         거래당 ${(a2.avg>=0?'+':'')+a2.avg.toFixed(3)}%  PF ${a2.pf.toFixed(3)}  승률 ${a2.wr.toFixed(1)}%  평균보유 ${a2.hold.toFixed(1)}봉`);
  console.log(`  최광 SL-8/G6    거래당 ${(wide.avg>=0?'+':'')+wide.avg.toFixed(3)}%  PF ${wide.pf.toFixed(3)}  승률 ${wide.wr.toFixed(1)}%  평균보유 ${wide.hold.toFixed(1)}봉`);
  console.log(`  → 최광 스톱이 스톱없음과 ${Math.abs(wide.avg - z.avg) < 0.05 ? '사실상 동일 = 청산규칙이 무력화된 것' : '다름 = 규칙이 일을 하고 있음'}`);
}
console.log('\n── 기간분할 (A2 기준, 현실 체결) ──');
const SP: Array<[string, number, number]> = [['2022H2~23', Date.UTC(2022,6,1), Date.UTC(2023,11,31)],
  ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
  ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
console.log('구간        touch            close           close 우세?');
let win = 0;
for (const [lab, a, b] of SP) {
  const t = run('touch', -2, 2, 2, a, b), c = run('close', -2, 2, 2, a, b);
  if (c.avg > t.avg) win++;
  console.log(`${lab.padEnd(11)} ${((t.avg>=0?'+':'')+t.avg.toFixed(3)+'%').padStart(8)} (PF ${t.pf.toFixed(2)})  ${((c.avg>=0?'+':'')+c.avg.toFixed(3)+'%').padStart(8)} (PF ${c.pf.toFixed(2)})   ${c.avg>t.avg?'예':'아니오'}`);
}
console.log(`\nclose 규칙 ${win}/4 구간 우세`);

console.log('\n── 기간분할: 현행 A2 vs 재스윕 최적 (둘 다 touch·현실체결) ──');
console.log('구간        A2(SL-2/G2)      넓은스톱(SL-5/G4)   우세?');
let w2 = 0;
for (const [lab, a, b] of SP) {
  const t = run('touch', -2, 2, 2, a, b), c = run('touch', -5, 2, 4, a, b);
  if (c.avg > t.avg) w2++;
  console.log(`${lab.padEnd(11)} ${((t.avg>=0?'+':'')+t.avg.toFixed(3)+'%').padStart(8)} (PF ${t.pf.toFixed(2)})   ${((c.avg>=0?'+':'')+c.avg.toFixed(3)+'%').padStart(8)} (PF ${c.pf.toFixed(2)})      ${c.avg>t.avg?'예':'아니오'}`);
}
console.log(`\n넓은 스톱 ${w2}/4 구간 우세`);
