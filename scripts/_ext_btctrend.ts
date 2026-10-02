/**
 * 축 E-5 BTC 시계열 추세추종 반증 (2026-10-02) — 'BTC 가 N일 이평 위면 BTC 보유, 아래면 현금'
 * 업비트 KRW-BTC 일봉(KST09 시작) 2017-10~. 판단 = 일봉 종가, 체결 = 다음 일봉 시가(+지연 옵션은 시가 대신 종가 근사 불가 → 비용 가산으로 스트레스).
 * 비용: 수수료 0.05% + 슬리피지(BTC 스프레드½ ≈ 0.05% 하한) per 전환. 반증: 이평 길이 고원, 비용×4, 구간별, 무작위 전환 플라시보(같은 보유비율·전환횟수), F7 상관·합성.
 */
import fs from 'fs';
import path from 'path';
const b: any[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/daily/KRW-BTC.json'), 'utf8'));
const f7: { ts: number; r: number }[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/f7_daily.json'), 'utf8'));
const COST = 0.0005 + 0.0005;
function series(N: number, costMult = 1, band = 0, from = 0) {
  const out: { ts: number; r: number; on: boolean }[] = []; let on = false, sw = 0;
  for (let i = Math.max(N, 1); i < b.length - 1; i++) {
    let s = 0; for (let j = i - N + 1; j <= i; j++) s += b[j].close; const ma = s / N;
    const want = on ? b[i].close >= ma * (1 - band) : b[i].close > ma * (1 + band);
    // i 종가 판단 → i+1 시가 체결. i+1 일 수익 = 보유면 close_{i+1}/open_{i+1}, 그 전 구간(종가→시가 갭)은 0 근사
    let r = 0;
    if (want !== on) { r -= COST * costMult; sw++; }
    on = want;
    if (on) r += b[i + 1].close / b[i + 1].open - 1;
    // 보유 지속 중 시가 갭(전일 종가→오늘 시가)도 포함
    if (on && out.length && out[out.length - 1].on) r += b[i + 1].open / b[i].close - 1;
    if (b[i + 1].ts >= from) out.push({ ts: b[i + 1].ts, r, on });
  }
  return { out, sw };
}
const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[], T = 17) => { const s = st(rs); if (s.mdd <= T) return { f: 1, ...s }; let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > T) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const Y = (y: number) => Date.UTC(y, 0, 1);
const yrs = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const hold = b.slice(1).map((x, i) => ({ ts: x.ts, r: x.close / b[i].close - 1 })).filter(x => x.ts >= Y(2018));
const show = (lab: string, rs: { ts: number; r: number }[], extra = '') => {
  const s = st(rs), e = eq(rs);
  const yr = yrs.map(y => P(st(rs.filter(x => new Date(x.ts).getUTCFullYear() === y), e.f).ret).padStart(6)).join('');
  console.log(`${lab.padEnd(28)} ${P(s.ret).padStart(8)} MDD ${s.mdd.toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(6)} f${e.f.toFixed(2)} |${yr} ${extra}`);
};
console.log('전략'.padEnd(28) + '     총익     MDD  |   동일위험17%     |' + yrs.map(y => String(y).padStart(6)).join(''));
show('BTC 보유', hold);
console.log('── 이평 길이 고원 ──');
for (const N of [10, 20, 30, 50, 75, 100, 150, 200]) { const { out, sw } = series(N, 1, 0, Y(2018)); show(`SMA${N}`, out, `전환 ${sw}회 보유 ${(100 * out.filter(x => x.on).length / out.length).toFixed(0)}%`); }
console.log('── 비용·밴드 스트레스 (SMA50) ──');
for (const c of [2, 4]) show(`SMA50 비용×${c}`, series(50, c, 0, Y(2018)).out);
for (const band of [0.01, 0.03]) { const { out, sw } = series(50, 1, band, Y(2018)); show(`SMA50 밴드±${band * 100}%`, out, `전환 ${sw}회`); }
console.log('── 플라시보: 같은 보유비율·전환횟수 무작위 국면 (SMA50 기준, 20시드) ──');
{
  const { out } = series(50, 1, 0, Y(2018)); const onFrac = out.filter(x => x.on).length / out.length;
  const runs: number[] = []; let n = 0;
  // 실제 국면 구간 길이 분포를 섞어 재배치(블록 셔플)
  const blocks: { on: boolean; len: number }[] = []; for (const x of out) { const l = blocks[blocks.length - 1]; if (l && l.on === x.on) l.len++; else blocks.push({ on: x.on, len: 1 }); }
  let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const base = hold.filter(x => x.ts >= out[0].ts);
  for (let s = 0; s < 20; s++) {
    seed = s * 7919 + 3;
    const onB = blocks.filter(x => x.on).map(x => x.len).sort(() => rnd() - 0.5), offB = blocks.filter(x => !x.on).map(x => x.len).sort(() => rnd() - 0.5);
    const mask: boolean[] = []; let a = 0, c = 0, cur = rnd() < 0.5;
    while (mask.length < base.length && (a < onB.length || c < offB.length)) { const L = cur ? onB[a++] : offB[c++]; if (L == null) { cur = !cur; continue; } for (let k = 0; k < L; k++) mask.push(cur); cur = !cur; }
    const rs = base.map((x, i) => ({ ts: x.ts, r: mask[i] ? x.r : 0 }));
    const e = eq(rs); runs.push(e.ret); n++;
  }
  runs.sort((x, y) => x - y);
  console.log(`  실제 SMA50 eq17 ${P(eq(out).ret)} / 무작위 국면 eq17: 최소 ${P(runs[0])} 중앙 ${P(runs[10])} 최대 ${P(runs[19])} (보유비율 ${(100 * onFrac).toFixed(0)}%)`);
}
console.log('── F7 과 비교·상관·합성 (F7 기간 2022-06~2026-08, F7 = 4h 하네스 33%×3) ──');
{
  const { out } = series(50, 1, 0, 0);
  const mp = new Map(out.map(x => [x.ts, x.r]));
  const common = f7.filter(x => mp.has(x.ts)).map(x => ({ ts: x.ts, a: x.r, b: mp.get(x.ts)! }));
  const ma = common.reduce((s, x) => s + x.a, 0) / common.length, mb = common.reduce((s, x) => s + x.b, 0) / common.length;
  let cv = 0, va = 0, vb = 0; for (const x of common) { cv += (x.a - ma) * (x.b - mb); va += (x.a - ma) ** 2; vb += (x.b - mb) ** 2; }
  console.log(`  일별 상관 F7 vs BTC-SMA50 = ${(cv / Math.sqrt(va * vb)).toFixed(2)}  (n=${common.length})`);
  const A = common.map(x => ({ ts: x.ts, r: x.a })), Bs = common.map(x => ({ ts: x.ts, r: x.b }));
  const ea = eq(A), eb = eq(Bs);
  console.log(`  같은 기간 eq17: F7 ${P(ea.ret)} / BTC-SMA50 ${P(eb.ret)} / BTC 보유 ${P(eq(hold.filter(x => x.ts >= common[0].ts && x.ts <= common[common.length - 1].ts)).ret)}`);
  for (const w of [0.3, 0.5, 0.7]) { const C = common.map(x => ({ ts: x.ts, r: w * x.a + (1 - w) * x.b })); const e = eq(C); console.log(`  합성 F7 ${w * 100}% + BTC-SMA50 ${(1 - w) * 100}%: eq17 ${P(e.ret)} (f${e.f.toFixed(2)})`); }
}
console.log('── 워크포워드: 2018~2021 에서 SMA 길이 고르고 2022~ 적용 ──');
{
  const Ns = [10, 20, 30, 50, 75, 100, 150, 200];
  const isR = Ns.map(N => ({ N, v: eq(series(N, 1, 0, Y(2018)).out.filter(x => x.ts < Y(2022))).ret }));
  const best = isR.sort((a, b) => b.v - a.v)[0];
  const oos = (N: number) => eq(series(N, 1, 0, Y(2022)).out).ret;
  console.log(`  IS 최적 SMA${best.N} (IS eq17 ${P(best.v)}) → OOS eq17 ${P(oos(best.N))} / OOS BTC 보유 ${P(eq(hold.filter(x => x.ts >= Y(2022))).ret)} / OOS 격자: ${Ns.map(N => `${N}:${P(oos(N))}`).join(' ')}`);
}
console.log('── 실행 지연: 판단 후 1일 늦게 체결 (SMA50) ──');
{
  // 하루 늦은 국면 = 국면 마스크를 1일 밀기
  const { out } = series(50, 1, 0, Y(2018));
  const base = hold.filter(x => x.ts >= out[0].ts);
  const mp = new Map(out.map((x, i) => [x.ts, i]));
  for (const lag of [0, 1, 2]) {
    const rs = base.map((x) => { const i = mp.get(x.ts); const j = i == null ? -1 : i - lag; const on = j >= 0 && out[j].on; return { ts: x.ts, r: on ? x.r : 0 }; });
    const e = eq(rs);
    console.log(`  지연 ${lag}일 eq17 ${P(e.ret)}  ` + yrs.map(y => P(st(rs.filter(x => new Date(x.ts).getUTCFullYear() === y), e.f).ret)).join(' '));
  }
}
