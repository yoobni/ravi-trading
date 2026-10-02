/**
 * 축 H — 다자산 추세추종(시점별 유니버스) (2026-10-02)
 *
 * 데이터: 업비트 KRW 일봉 전체(data/research-ext/daily, KST 09 시작). 상폐 코인은 업비트가 캔들을 안 줘서 빠져 있다(생존편향 — 한계 명시).
 * 체결 모델(_ext_btctrend.ts 와 동일 계열): 일봉 종가로 판단 → 다음 일봉 시가 체결. 일 수익 = 보유 비중 × (오늘 종가/어제 종가 −1),
 *   비중이 바뀐 날은 바뀐 만큼 비용(수수료 0.05% + 슬리피지) 차감. 시가≈전일종가(24h 시장)라 갭은 무시.
 * 슬리피지: max(0.05%, 스프레드 p50 / 2) — data/research-spread-p50.json(28코인), 없는 코인 0.3%.
 * 유니버스: 매일 '직전 W일 평균 거래대금' 상위 N (스테이블 제외, 상장 후 최소 SMA길이+10일 경과) — 그 시점 정보만.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data/research-ext/daily');
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const STABLE = /^KRW-(USDT|USDC|USDE|USDG|USDS|USD1|PYUSD|RLUSD|DAI|TUSD)$/;
const DAY = 86400e3;
const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

interface Bar { ts: number; open: number; close: number; value: number }
const RAW = new Map<string, Bar[]>();
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const m = f.replace('.json', ''); if (STABLE.test(m)) continue;
  const b: Bar[] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).map((x: any) => ({ ts: x.ts, open: x.open, close: x.close, value: x.value ?? x.volume * x.close }));
  // 오늘(진행 중) 일봉 제외 — 업비트 일봉 ts 는 UTC 00:00(=KST 09:00)
  const done = b.filter((x) => x.ts + DAY <= Date.now());
  if (done.length > 60) RAW.set(m, done);
}
const T = [...new Set([...RAW.values()].flatMap((b) => b.map((x) => x.ts)))].sort((a, b) => a - b);
const TI = new Map(T.map((t, i) => [t, i]));
const MK = [...RAW.keys()];
// 코인별 T 정렬 배열 (없으면 NaN)
const CL = new Map<string, Float64Array>(), VAL = new Map<string, Float64Array>(), FIRST = new Map<string, number>();
for (const m of MK) {
  const c = new Float64Array(T.length).fill(NaN), v = new Float64Array(T.length).fill(NaN);
  for (const x of RAW.get(m)!) { const i = TI.get(x.ts)!; c[i] = x.close; v[i] = x.value; }
  CL.set(m, c); VAL.set(m, v); FIRST.set(m, TI.get(RAW.get(m)![0].ts)!);
}
const slip = (m: string) => Math.max(0.0005, SPREAD[m] != null ? SPREAD[m] / 2 / 1e4 : 0.003);

// 지표 캐시
const smaCache = new Map<string, Float64Array>();
function sma(m: string, n: number) {
  const k = m + ':' + n; if (smaCache.has(k)) return smaCache.get(k)!;
  const c = CL.get(m)!, o = new Float64Array(T.length).fill(NaN); let s = 0, cnt = 0;
  for (let i = 0; i < T.length; i++) {
    if (isNaN(c[i])) { s = 0; cnt = 0; continue; }
    s += c[i]; cnt++; if (cnt > n) { s -= c[i - n]; cnt = n; }
    if (cnt === n) o[i] = s / n;
  }
  smaCache.set(k, o); return o;
}
const avgVal = new Map<string, Float64Array>();
function trailVal(m: string, w: number) {
  const k = m + ':' + w; if (avgVal.has(k)) return avgVal.get(k)!;
  const v = VAL.get(m)!, o = new Float64Array(T.length).fill(NaN); let s = 0, cnt = 0;
  for (let i = 0; i < T.length; i++) { if (isNaN(v[i])) { s = 0; cnt = 0; continue; } s += v[i]; cnt++; if (cnt > w) { s -= v[i - w]; cnt = w; } if (cnt === w) o[i] = s / w; }
  avgVal.set(k, o); return o;
}
function vol30(m: string, i: number) {
  const c = CL.get(m)!; let s = 0, s2 = 0, n = 0;
  for (let j = i - 29; j <= i; j++) { if (j < 1 || isNaN(c[j]) || isNaN(c[j - 1])) continue; const r = c[j] / c[j - 1] - 1; s += r; s2 += r * r; n++; }
  return n > 20 ? Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 1e-10)) : NaN;
}

interface Cfg {
  coins?: string[];          // 고정 코인 목록(없으면 시점별 상위 N)
  N?: number; W?: number;     // 유니버스 크기·거래대금 창
  smas: number[];            // 1개 = 단일 SMA, 여러 개 = 앙상블(위에 있는 비율만큼 비중)
  weight: 'eq' | 'iv';       // 슬롯 동일가중 / 변동성 역가중
  volTarget?: number;        // 연변동성 목표(예 0.4) — 포트 노출 스케일(최대 1)
  costMult?: number;
  lagDays?: number;          // 판단 지연(일)
  placeboSeed?: number;      // >0: 추세 신호 대신 같은 비율 무작위 on/off(블록 단위)
  randUniverseSeed?: number; // >0: 상위 N 대신 상위 3N 중 무작위 N
}
let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** 일별 포트 수익 시계열 */
function run(c: Cfg, from = Date.UTC(2018, 0, 1), to = Infinity) {
  const maxS = Math.max(...c.smas), W = c.W ?? 30, lag = c.lagDays ?? 0, cm = c.costMult ?? 1;
  let w = new Map<string, number>();
  const out: { ts: number; r: number; expo: number }[] = [];
  const recent: number[] = [];   // 포트 일 수익(변동성 타게팅용)
  const placeboState = new Map<string, { on: boolean; left: number }>();
  if (c.placeboSeed) seed = c.placeboSeed;
  if (c.randUniverseSeed) seed = c.randUniverseSeed;
  for (let i = maxS + 40; i < T.length - 1; i++) {
    const d = i - lag;  // 판단에 쓰는 날
    // i 종가로 새 비중 결정 → i+1 시가(≈i 종가)에 체결 → i→i+1 수익에 적용. 비용은 비중 변화분.
    let uni: string[];
    if (c.coins) uni = c.coins.filter((m) => CL.has(m) && !isNaN(CL.get(m)![d]) && d - FIRST.get(m)! > maxS + 10);
    else {
      const cand = MK.filter((m) => d - FIRST.get(m)! > maxS + 10 && !isNaN(trailVal(m, W)[d]) && !isNaN(CL.get(m)![d]))
        .sort((a, b) => trailVal(b, W)[d] - trailVal(a, W)[d]);
      if (c.randUniverseSeed) { const pool = cand.slice(0, 3 * c.N!); uni = []; while (uni.length < c.N! && pool.length) uni.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]); }
      else uni = cand.slice(0, c.N!);
    }
    const slots = c.coins ? c.coins.length : c.N!;
    const sig = new Map<string, number>();
    for (const m of uni) {
      let s: number;
      if (c.placeboSeed) {
        let p = placeboState.get(m); if (!p || p.left <= 0) { p = { on: rnd() < 0.5, left: 5 + Math.floor(rnd() * 40) }; placeboState.set(m, p); }
        p.left--; s = p.on ? 1 : 0;
      } else {
        const cc = CL.get(m)!; let k = 0; for (const n of c.smas) { const v = sma(m, n)[d]; if (!isNaN(v) && cc[d] > v) k++; } s = k / c.smas.length;
      }
      if (s > 0) sig.set(m, s);
    }
    const nw = new Map<string, number>();
    if (c.weight === 'eq') for (const [m, s] of sig) nw.set(m, s / slots);
    else {
      const iv = uni.map((m) => [m, 1 / (vol30(m, d) || 1)] as [string, number]).filter(([, x]) => isFinite(x));
      const tot = iv.reduce((a, [, x]) => a + x, 0);
      for (const [m, x] of iv) if (sig.has(m)) nw.set(m, sig.get(m)! * x / tot);
    }
    if (c.volTarget && recent.length >= 20) {
      const rr = recent.slice(-30); const mu = rr.reduce((a, b) => a + b, 0) / rr.length;
      const sd = Math.sqrt(rr.reduce((a, b) => a + (b - mu) ** 2, 0) / rr.length) * Math.sqrt(365);
      const expo = [...nw.values()].reduce((a, b) => a + b, 0);
      // recent 는 실현 포트 수익 — 노출로 나눠 '풀 노출 변동성' 추정 후 스케일
      const full = expo > 0 ? sd : 0;
      const k = full > 0 ? Math.min(1, c.volTarget / full) : 1;
      for (const [m, x] of nw) nw.set(m, x * k);
    }
    // 작은 재조정은 무시(±2%p 밴드) — 역변동성 가중의 잦은 미세 거래 방지
    for (const [m, x] of w) if (nw.has(m) && Math.abs(nw.get(m)! - x) < 0.02 && sig.has(m)) nw.set(m, x);
    let cost = 0;
    for (const m of new Set([...w.keys(), ...nw.keys()])) cost += Math.abs((nw.get(m) ?? 0) - (w.get(m) ?? 0)) * (0.0005 + slip(m)) * cm;
    w = nw;
    let r = 0;
    for (const [m, x] of w) { const cc = CL.get(m)!; if (!isNaN(cc[i + 1]) && !isNaN(cc[i])) r += x * (cc[i + 1] / cc[i] - 1); }
    const ret = r - cost;
    recent.push(r / Math.max(1e-9, [...w.values()].reduce((a, b) => a + b, 0) || 1));
    if (T[i + 1] >= from && T[i + 1] <= to) out.push({ ts: T[i + 1], r: ret, expo: [...w.values()].reduce((a, b) => a + b, 0) });
  }
  return out;
}
const st = (rs: { r: number }[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x.r; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq = (rs: { r: number }[], Tg = 17) => { const s = st(rs); if (s.mdd <= Tg) return { f: 1, ...s }; let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (st(rs, m).mdd > Tg) hi = m; else lo = m; } return { f: lo, ...st(rs, lo) }; };
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const yrs = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const Y = (y: number) => Date.UTC(y, 0, 1);
const hold = (m: string, from = Y(2018)) => { const c = CL.get(m)!; const o: { ts: number; r: number }[] = []; for (let i = 1; i < T.length; i++) if (!isNaN(c[i]) && !isNaN(c[i - 1]) && T[i] >= from) o.push({ ts: T[i], r: c[i] / c[i - 1] - 1 }); return o; };
const show = (lab: string, rs: { ts: number; r: number; expo?: number }[], extra = '') => {
  const s = st(rs), e = eq(rs);
  const yr = yrs.map((y) => { const z = rs.filter((x) => new Date(x.ts).getUTCFullYear() === y); return (z.length ? P(st(z, e.f).ret) : '—').padStart(6); }).join('');
  const ex = rs[0]?.expo != null ? ` 노출 ${(100 * rs.reduce((a, x) => a + (x.expo ?? 0), 0) / rs.length).toFixed(0)}%` : '';
  console.log(`${lab.padEnd(34)} ${P(s.ret).padStart(9)} MDD ${s.mdd.toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(7)} f${e.f.toFixed(2)} |${yr}${ex} ${extra}`);
  return e.ret;
};
const header = () => console.log('전략'.padEnd(34) + '      총익      MDD |   동일위험17%      |' + yrs.map((y) => String(y).padStart(6)).join(''));
const corr = (a: { ts: number; r: number }[], b: { ts: number; r: number }[]) => {
  const mb = new Map(b.map((x) => [x.ts, x.r])); const c = a.filter((x) => mb.has(x.ts)).map((x) => [x.r, mb.get(x.ts)!]);
  const ma = c.reduce((s, x) => s + x[0], 0) / c.length, mbb = c.reduce((s, x) => s + x[1], 0) / c.length;
  let cv = 0, va = 0, vb = 0; for (const [p, q] of c) { cv += (p - ma) * (q - mbb); va += (p - ma) ** 2; vb += (q - mbb) ** 2; } return cv / Math.sqrt(va * vb);
};
const blend = (a: { ts: number; r: number }[], b: { ts: number; r: number }[], wa: number) => { const mb = new Map(b.map((x) => [x.ts, x.r])); return a.filter((x) => mb.has(x.ts)).map((x) => ({ ts: x.ts, r: wa * x.r + (1 - wa) * mb.get(x.ts)! })); };

const MODE = process.argv[2] || 'all';
const BT = run({ coins: ['KRW-BTC'], smas: [50], weight: 'eq' });   // = BTC_TREND
if (MODE === 'all' || MODE === 'coin') {
  console.log(`\n① 대형 코인 개별 추세추종 (종가>SMA → 보유). 2018~ (SOL 은 상장 후)\n`); header();
  show('BTC 보유', hold('KRW-BTC'));
  show('BTC_TREND (SMA50)', BT);
  for (const m of ['KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-ADA', 'KRW-DOGE', 'KRW-TRX', 'KRW-LINK', 'KRW-BCH']) {
    if (!CL.has(m)) continue;
    show(`${m.slice(4)} 보유`, hold(m));
    const row = [10, 20, 30, 50, 100, 200].map((n) => { const e = eq(run({ coins: [m], smas: [n], weight: 'eq' })); return `${n}:${P(e.ret)}`; }).join(' ');
    show(`${m.slice(4)} SMA50`, run({ coins: [m], smas: [50], weight: 'eq' }), `| eq17 by SMA ${row}`);
  }
}
if (MODE === 'all' || MODE === 'tsmom') {
  console.log(`\n② 시점별 상위 N (직전 W일 거래대금) × 추세 필터 — 2018~\n`); header();
  show('BTC_TREND', BT);
  for (const W of [30, 90]) for (const N of [3, 5, 10]) for (const wt of ['eq', 'iv'] as const)
    show(`top${N} W${W} ${wt} SMA50`, run({ N, W, smas: [50], weight: wt }));
}
if (MODE === 'all' || MODE === 'vt') {
  console.log(`\n③ 앙상블·변동성 타게팅 — 2018~\n`); header();
  const ENS = [10, 20, 50, 100, 200];
  show('BTC SMA50', BT);
  show('BTC 앙상블(10/20/50/100/200)', run({ coins: ['KRW-BTC'], smas: ENS, weight: 'eq' }));
  for (const vt of [0.3, 0.5, 0.8]) show(`BTC SMA50 VT${vt * 100}`, run({ coins: ['KRW-BTC'], smas: [50], weight: 'eq', volTarget: vt }));
  show('BTC 앙상블 VT50', run({ coins: ['KRW-BTC'], smas: ENS, weight: 'eq', volTarget: 0.5 }));
  for (const N of [3, 5]) {
    show(`top${N} W30 eq 앙상블`, run({ N, W: 30, smas: ENS, weight: 'eq' }));
    show(`top${N} W30 iv 앙상블 VT50`, run({ N, W: 30, smas: ENS, weight: 'iv', volTarget: 0.5 }));
  }
  show('BTC+ETH eq SMA50', run({ coins: ['KRW-BTC', 'KRW-ETH'], smas: [50], weight: 'eq' }));
  show('BTC+ETH eq 앙상블', run({ coins: ['KRW-BTC', 'KRW-ETH'], smas: ENS, weight: 'eq' }));
  show('BTC+ETH+XRP eq SMA50', run({ coins: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'], smas: [50], weight: 'eq' }));
}
export { run, eq, st, show, header, corr, blend, hold, BT, P, Y, yrs, CL, T };

if (MODE === 'break') {
  const ENS = [10, 20, 50, 100, 200];
  console.log('\n④ 반증\n'); header();
  console.log('── (a) 앙상블 구성 고원 (BTC) ──');
  for (const set of [[50], [20, 50, 100], [10, 20, 50, 100, 200], [30, 60, 90, 120], [5, 10, 20, 50, 100, 200], [20, 40, 80, 160], [10, 30, 100]])
    show(`BTC ens ${set.join('/')}`, run({ coins: ['KRW-BTC'], smas: set, weight: 'eq' }));
  console.log('── (b) 판정 지연·비용 ──');
  for (const lag of [1, 2]) { show(`BTC SMA50 지연${lag}일`, run({ coins: ['KRW-BTC'], smas: [50], weight: 'eq', lagDays: lag })); show(`BTC 앙상블 지연${lag}일`, run({ coins: ['KRW-BTC'], smas: ENS, weight: 'eq', lagDays: lag })); show(`BTC+ETH 앙상블 지연${lag}일`, run({ coins: ['KRW-BTC', 'KRW-ETH'], smas: ENS, weight: 'eq', lagDays: lag })); }
  for (const cm of [2, 4]) { show(`BTC 앙상블 비용×${cm}`, run({ coins: ['KRW-BTC'], smas: ENS, weight: 'eq', costMult: cm })); show(`BTC+ETH 앙상블 비용×${cm}`, run({ coins: ['KRW-BTC', 'KRW-ETH'], smas: ENS, weight: 'eq', costMult: cm })); }
  console.log('── (c) 시점별 상위 N=2/3 (ETH 사후선택 대신 그 시점 거래대금 순위) ──');
  for (const W of [30, 90, 180]) for (const N of [2, 3]) { show(`top${N} W${W} eq SMA50`, run({ N, W, smas: [50], weight: 'eq' })); show(`top${N} W${W} eq 앙상블`, run({ N, W, smas: ENS, weight: 'eq' })); }
  console.log('── (d) 플라시보: 같은 구조, 추세 대신 무작위 on/off 블록 (BTC 앙상블·BTC+ETH, 20시드 eq17) ──');
  for (const [lab, coins] of [['BTC', ['KRW-BTC']], ['BTC+ETH', ['KRW-BTC', 'KRW-ETH']]] as Array<[string, string[]]>) {
    const v: number[] = []; for (let s = 1; s <= 20; s++) v.push(eq(run({ coins, smas: [50], weight: 'eq', placeboSeed: s * 7919 })).ret);
    v.sort((a, b) => a - b); console.log(`  ${lab} 무작위: 최소 ${P(v[0])} 중앙 ${P(v[10])} 최대 ${P(v[19])}`);
  }
  {
    const v: number[] = []; for (let s = 1; s <= 20; s++) v.push(eq(run({ N: 3, W: 90, smas: ENS, weight: 'eq', randUniverseSeed: s * 104729 })).ret);
    v.sort((a, b) => a - b); console.log(`  top3 W90 앙상블 — 유니버스를 상위9 중 무작위3: 최소 ${P(v[0])} 중앙 ${P(v[10])} 최대 ${P(v[19])}`);
  }
  console.log('── (e) 앞/뒤 절반: 2018~2021 IS / 2022~ OOS (eq17 은 각 구간에서 따로 맞춤) ──');
  const cands: Array<[string, Cfg]> = [['BTC SMA50 (=BTC_TREND)', { coins: ['KRW-BTC'], smas: [50], weight: 'eq' }], ['BTC 앙상블', { coins: ['KRW-BTC'], smas: ENS, weight: 'eq' }],
    ['BTC+ETH SMA50', { coins: ['KRW-BTC', 'KRW-ETH'], smas: [50], weight: 'eq' }], ['BTC+ETH 앙상블', { coins: ['KRW-BTC', 'KRW-ETH'], smas: ENS, weight: 'eq' }],
    ['top2 W90 앙상블', { N: 2, W: 90, smas: ENS, weight: 'eq' }], ['top3 W90 iv SMA50', { N: 3, W: 90, smas: [50], weight: 'iv' }], ['top5 W30 iv 앙상블 VT50', { N: 5, W: 30, smas: ENS, weight: 'iv', volTarget: 0.5 }]];
  for (const [lab, c] of cands) {
    const is = eq(run(c, Y(2018), Y(2022) - 1)), oos = eq(run(c, Y(2022))), o2 = eq(run(c, Y(2024)));
    console.log(`  ${lab.padEnd(26)} IS ${P(is.ret).padStart(7)} | OOS 2022~ ${P(oos.ret).padStart(6)} | 2024~ ${P(o2.ret).padStart(6)}`);
  }
  {
    const b = hold('KRW-BTC'); console.log(`  BTC 보유                   IS ${P(eq(b.filter(x => x.ts < Y(2022))).ret).padStart(7)} | OOS 2022~ ${P(eq(b.filter(x => x.ts >= Y(2022))).ret).padStart(6)} | 2024~ ${P(eq(b.filter(x => x.ts >= Y(2024))).ret).padStart(6)}`);
  }
  console.log('── (f) BTC_TREND 와의 상관·합성 (2018~) ──');
  for (const [lab, c] of cands.slice(1)) {
    const a = run(c); console.log(`  ${lab.padEnd(26)} 상관 ${corr(a, BT).toFixed(2)} | 50:50 합성 eq17 ${P(eq(blend(a, BT, 0.5)).ret)}`);
  }
  const f7f = path.resolve(process.cwd(), 'data/research-ext/f7_daily.json');
  if (fs.existsSync(f7f)) {
    const f7: { ts: number; r: number }[] = JSON.parse(fs.readFileSync(f7f, 'utf8'));
    const f0 = f7[0].ts;
    console.log(`── (g) F7(4h 하네스 일별, ${new Date(f0).toISOString().slice(0, 10)}~) 과의 합성 ──`);
    for (const [lab, c] of cands.slice(0, 4)) {
      const a = run(c, f0); console.log(`  ${lab.padEnd(26)} 단독 eq17 ${P(eq(a).ret).padStart(6)} 상관 F7 ${corr(a, f7).toFixed(2)} | F7 50:50 ${P(eq(blend(a, f7, 0.5)).ret)}`);
    }
    console.log(`  F7 단독 eq17 ${P(eq(f7).ret)}`);
  }
}
