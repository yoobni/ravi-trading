/**
 * 축 M — 포트폴리오 배분 설계 (2026-10-02)
 * 1) 페이퍼 후보 전략의 '현실화' 일별 수익 시계열 (일 경계 = KST 09:00 = UTC 00:00)
 *    - 15m 경로 2024-10~2026-10: 판단지연 0, 코인별 스프레드½ 슬리피지, TP 지정가 관통 0 / 0.2% 두 버전
 *      체결 모델은 _bt_synth.ts 와 동일(TP 는 15m 고가로 상시 감시, 손절·시간청산·트레일은 봉마감 tick 가격)
 *    - 4h 하네스 2022-06~2026-08: 낙관(관통0·슬리피지0.05%) / 보수(관통0.2%·스프레드½)
 *    - BTC_TREND: 업비트 일봉 SMA50 (_ext_btctrend.ts 와 같은 정의)
 *    - 비관(생존편향) 시나리오: F 계열 일수익을 기간 평균만큼 빼서 '엣지 0, 변동·상관 그대로'
 * 2) 상관·국면별 성과  3) 배분안(동일·역변동성·최소분산·코어위성·변동성타게팅) × 목표 MDD 17/25, 워크포워드, 비용×2
 * 결과 시계열은 data/research-ext/alloc/ 에 저장.
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT = path.resolve(process.cwd(), 'data', 'research-ext', 'alloc'); fs.mkdirSync(OUT, { recursive: true });
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const FEE0 = 0.0005, H = 3600e3, FOUR = 4 * H, TWELVE = 12 * H, DAY = 24 * H, Q = 15 * 60e3;
interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
const agg = (b: B[], W: number) => { const o: B[] = []; for (const x of b) { const k = Math.floor(x.ts / W) * W; const l = o[o.length - 1]; if (!l || l.ts !== k) o.push({ ...x, ts: k }); else { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume += x.volume; } } return o; };
const load = (m: string, tag: string) => { const fs_ = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_${tag}_`)); let best: B[] | null = null; for (const f of fs_) { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (!best || d.length > best.length) best = d; } return best ? best.slice().sort((a, b) => a.ts - b.ts) : null; };

// ── 데이터 ──
const M15 = new Map<string, B[]>(), M4 = new Map<string, B[]>(), M12 = new Map<string, B[]>(), C4 = new Map<string, B[]>(), C12 = new Map<string, B[]>();
for (const m of COINS) {
  const b15 = load(m, '15m'); if (b15) { M15.set(m, b15); M4.set(m, agg(b15, FOUR)); M12.set(m, agg(b15, TWELVE)); }
  const b4 = load(m, '240m'); if (b4) { C4.set(m, b4); C12.set(m, agg(b4, TWELVE)); }
}
const idx = (mp: Map<string, B[]>) => new Map([...mp].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const I15 = idx(M15), I4 = idx(M4), I12 = idx(M12), IC4 = idx(C4), IC12 = idx(C12);

const volZ = (b: B[], i: number, w: number) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sd > 0 ? (b[i].volume - mn) / sd : 0; };
const hiOf = (b: B[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig = (b: B[], i: number, L: number, w: number) => i >= L + 1 && b[i - 1].high > hiOf(b, i - L, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i, w) >= 0.5;

interface D { kind: 'tp' | 'trail'; tf: 4 | 12; tp?: number; sl: number | null; maxb: number; btc50?: boolean }
const DES: Record<string, D> = {
  F6: { kind: 'tp', tf: 4, tp: 5, sl: -2, maxb: 84 },
  F7: { kind: 'tp', tf: 4, tp: 6, sl: null, maxb: 18 },
  F7_sl: { kind: 'tp', tf: 4, tp: 6, sl: -2, maxb: 18 },
  F7_p: { kind: 'tp', tf: 4, tp: 4, sl: null, maxb: 12 },
  F7_btc: { kind: 'tp', tf: 4, tp: 6, sl: null, maxb: 18, btc50: true },
  F6_v6: { kind: 'trail', tf: 12, sl: -2, maxb: 28 },
};
interface P { m: string; ep: number; vol: number; used: number; t0: number; slip: number }

/**
 * 범용 시뮬레이터. mode '15m': 15m 경로로 TP 상시 체결, tick 가격 = 그 시각 15m 시가.
 * mode '4h': 봉 단위 — TP 는 진입봉 포함 봉 고가로(TP 가 손절보다 먼저: 지정가는 봉 중 상시, 손절은 봉마감 판정),
 *            tick 가격 = 다음 봉 시가.
 * 반환: 일별 수익(Map dayTs→r) + 일별 투입비율.
 */
function sim(name: string, d: D, mode: '15m' | '4h', pen: number, realSlip: boolean, costMult: number) {
  const W = d.tf === 4 ? FOUR : TWELVE;
  const BARS = mode === '15m' ? (d.tf === 4 ? M4 : M12) : (d.tf === 4 ? C4 : C12);
  const IB = mode === '15m' ? (d.tf === 4 ? I4 : I12) : (d.tf === 4 ? IC4 : IC12);
  const btcB = BARS.get('KRW-BTC')!, btcI = IB.get('KRW-BTC')!;
  const btcOff = (barTs: number) => { const n = Math.round(300 * FOUR / W); const i = btcI.get(barTs); if (i === undefined || i < n) return false; let s = 0; for (let j = i - n + 1; j <= i; j++) s += btcB[j].close; return btcB[i].close < s / n; };
  const FEE = FEE0 * costMult;
  const slipOf = (m: string) => costMult * (realSlip ? Math.max(0.0005, (SPREAD[m] ?? 10) / 2 / 1e4) : 0.0005);
  const L = d.tf === 4 ? 42 : 14, VW = d.tf === 4 ? 30 : 10;
  const px = (m: string, ts: number): number | null => {
    if (mode === '15m') { const i = I15.get(m)!.get(Math.floor(ts / Q) * Q); return i === undefined ? null : M15.get(m)![i].open; }
    const i = IB.get(m)!.get(ts); return i === undefined ? null : BARS.get(m)![i].open;
  };
  const all = [...BARS.values()];
  const T0 = Math.max(...all.map(b => b[0].ts)) + (d.tf === 4 ? 310 : 110) * W;
  const T1 = Math.min(...all.map(b => b[b.length - 1].ts));
  let cash = 1e7; const open: P[] = [];
  const dayEq = new Map<number, number>(), dayExp = new Map<number, number>();
  for (let bar = Math.ceil(T0 / W) * W; bar <= T1; bar += W) {
    const tick = bar;
    // (a) TP 지정가
    if (d.kind === 'tp') for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const tgt = q.ep * (1 + d.tp! / 100); let hit = false;
      if (mode === '15m') {
        const b15 = M15.get(q.m)!, i15 = I15.get(q.m)!;
        for (let t = Math.max(q.t0, tick - W); t < tick; t += Q) { const i = i15.get(t); if (i !== undefined && b15[i].high >= tgt * (1 + pen)) { hit = true; break; } }
      } else { const i = IB.get(q.m)!.get(tick - W); if (i !== undefined && tick - W >= q.t0 && BARS.get(q.m)![i].high >= tgt * (1 + pen)) hit = true; }
      if (hit) { cash += q.vol * tgt * (1 - FEE); open.splice(p, 1); }
    }
    // (b) 봉마감 판정: 손절·트레일·시간
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const bb = BARS.get(q.m)!; const ib = IB.get(q.m)!;
      const conf: B[] = []; for (let t = Math.floor(q.t0 / W) * W + W; t + W <= tick; t += W) { const i = ib.get(t); if (i !== undefined) conf.push(bb[i]); }
      let out = false;
      if (d.kind === 'tp') out = (d.sl != null && conf.some(x => x.low <= q.ep * (1 + d.sl! / 100))) || conf.length >= d.maxb;
      else { let stop = q.ep * (1 + d.sl! / 100), peak = q.ep, armed = false; for (const x of conf) { if (x.low <= stop) { out = true; break; } peak = Math.max(peak, x.high); if (!armed && peak >= q.ep * 1.02) armed = true; if (armed) stop = Math.max(stop, peak * 0.98); } if (conf.length >= d.maxb) out = true; }
      if (out) { const pr = px(q.m, tick); if (pr == null) continue; cash += q.vol * pr * (1 - q.slip) * (1 - FEE); open.splice(p, 1); }
    }
    // (c) 진입
    if (!(d.btc50 && btcOff(bar - W))) for (const m of COINS) {
      if (open.length >= 3) break;
      const bb = BARS.get(m); if (!bb) continue; const i = IB.get(m)!.get(bar - W);
      if (i === undefined || !sig(bb, i, L, VW) || open.some(q => q.m === m)) continue;
      const pr = px(m, tick); if (pr == null) continue;
      const used = cash * 0.33; if (used < 5000) continue;
      const slip = slipOf(m); const ep = pr * (1 + slip);
      cash -= used; open.push({ m, ep, vol: used * (1 - FEE) / ep, used, t0: tick, slip });
    }
    if (tick % DAY === 0) {
      let pv = 0; for (const q of open) pv += q.vol * (px(q.m, tick) ?? q.ep);
      dayEq.set(tick, cash + pv); dayExp.set(tick, pv / (cash + pv));
    }
  }
  const r = new Map<number, number>(); const days = [...dayEq.keys()].sort((a, b) => a - b);
  for (let k = 1; k < days.length; k++) r.set(days[k - 1], dayEq.get(days[k])! / dayEq.get(days[k - 1])! - 1);
  return { name, r, exp: dayExp };
}

// BTC_TREND (일봉)
const bd: any[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/daily/KRW-BTC.json'), 'utf8'));
function btcTrend(costMult = 1) {
  const r = new Map<number, number>(); const reg = new Map<number, boolean>(); let on = false;
  const C = (0.0005 + 0.0005) * costMult;
  for (let i = 50; i < bd.length - 1; i++) {
    let s = 0; for (let j = i - 49; j <= i; j++) s += bd[j].close; const want = bd[i].close > s / 50;
    let x = 0; if (want !== on) x -= C;
    if (want) { x += bd[i + 1].close / bd[i + 1].open - 1; if (on) x += bd[i + 1].open / bd[i].close - 1; }
    on = want; r.set(bd[i + 1].ts, x); reg.set(bd[i + 1].ts, want);
  }
  return r;
}
const btcHold = new Map<number, number>(); for (let i = 1; i < bd.length; i++) btcHold.set(bd[i].ts, bd[i].close / bd[i - 1].close - 1);
const btcBull = new Map<number, boolean>(); for (let i = 50; i < bd.length; i++) { let s = 0; for (let j = i - 49; j <= i; j++) s += bd[j].close; btcBull.set(bd[i].ts + DAY, bd[i].close > s / 50); }

// ── 시나리오별 시계열 구성 ──
type Series = Map<number, number>;
interface Scen { label: string; ser: Record<string, Series>; cost2: Record<string, Series> }
const NAMES = Object.keys(DES);
function scen(label: string, mode: '15m' | '4h', pen: number, real: boolean): Scen {
  const ser: Record<string, Series> = {}, cost2: Record<string, Series> = {};
  for (const n of NAMES) { ser[n] = sim(n, DES[n], mode, pen, real, 1).r; cost2[n] = sim(n, DES[n], mode, pen, real, 2).r; process.stdout.write('.'); }
  ser.BTC_TREND = btcTrend(1); cost2.BTC_TREND = btcTrend(2);
  console.log(` ${label}`);
  return { label, ser, cost2 };
}
const S: Scen[] = [
  scen('A 15m·관통0·스프레드', '15m', 0, true),
  scen('B 15m·관통0.2%·스프레드 (보수)', '15m', 0.002, true),
  scen('C 4h·관통0·0.05% (낙관)', '4h', 0, false),
  scen('D 4h·관통0.2%·스프레드 (보수)', '4h', 0.002, true),
];
// 비관(생존편향): B·D 의 F 계열을 기간 평균만큼 de-mean
for (const base of [S[1], S[3]]) {
  const ser: Record<string, Series> = {}, cost2: Record<string, Series> = {};
  for (const k of Object.keys(base.ser)) {
    if (k === 'BTC_TREND') { ser[k] = base.ser[k]; cost2[k] = base.cost2[k]; continue; }
    for (const [src, dst] of [[base.ser, ser], [base.cost2, cost2]] as const) {
      const v = [...src[k].values()]; const mu = v.reduce((a, b) => a + b, 0) / v.length;
      dst[k] = new Map([...src[k]].map(([t, r]) => [t, r - mu]));
    }
  }
  S.push({ label: base.label.split(' ')[0] + "' 비관(F 엣지 0)", ser, cost2 });
}
fs.writeFileSync(path.join(OUT, 'series.json'), JSON.stringify(S.map(s => ({ label: s.label, ser: Object.fromEntries(Object.entries(s.ser).map(([k, v]) => [k, [...v]])) }))));

// ── 분석 유틸 ──
const ALL = [...NAMES, 'BTC_TREND'];
const common = (s: Record<string, Series>) => { const ks = ALL.map(k => s[k]); return [...ks[0].keys()].filter(t => ks.every(m => m.has(t))).sort((a, b) => a - b); };
const stats = (rs: number[], f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of rs) { e *= 1 + f * x; pk = Math.max(pk, e); mdd = Math.max(mdd, 1 - e / pk); } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const fitK = (rs: number[], T: number) => { if (stats(rs).mdd <= T) return 1; let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (stats(rs, m).mdd > T) hi = m; else lo = m; } return lo; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
function minVar(cols: number[][]) {   // 롱온리 최소분산 — 심플렉스 투영 경사하강
  const n = cols.length, T = cols[0].length; const mu = cols.map(mean);
  const cov = cols.map((a, i) => cols.map((b, j) => mean(a.map((x, t) => (x - mu[i]) * (b[t] - mu[j])))));
  let w = Array(n).fill(1 / n);
  const proj = (v: number[]) => { const u = v.slice().sort((a, b) => b - a); let c = 0, th = 0; for (let i = 0; i < n; i++) { c += u[i]; const t = (c - 1) / (i + 1); if (u[i] - t > 0) th = t; } return v.map(x => Math.max(0, x - th)); };
  const lr = 0.5 / Math.max(...cov.map((r, i) => r[i]));
  for (let it = 0; it < 3000; it++) { const g = cov.map(r => 2 * r.reduce((s, c, j) => s + c * w[j], 0)); w = proj(w.map((x, i) => x - lr * g[i])); }
  return w;
}
const port = (s: Record<string, Series>, days: number[], w: Record<string, number>, volTarget = 0) => {
  const rs: number[] = []; const hist: number[] = [];
  for (const t of days) {
    let r = 0; for (const k in w) r += w[k] * (s[k].get(t) ?? 0);
    let scale = 1;
    if (volTarget > 0 && hist.length >= 30) { const v = sd(hist.slice(-30)) * Math.sqrt(365); scale = Math.min(1, volTarget / Math.max(v, 1e-9)); }
    hist.push(r); rs.push(scale * r);
  }
  return rs;
};

for (const sc of S) {
  const days = common(sc.ser); const half = days[Math.floor(days.length / 2)];
  const D1 = days.filter(t => t < half), D2 = days.filter(t => t >= half);
  console.log(`\n══════ ${sc.label} · ${new Date(days[0]).toISOString().slice(0, 10)}~${new Date(days[days.length - 1]).toISOString().slice(0, 10)} (${days.length}일, 앞/뒤 분할 ${new Date(half).toISOString().slice(0, 10)}) ══════`);
  // 단일 전략
  console.log('① 단일 전략 (자본 100% 슬리브)   총익    MDD   연변동  | MDD17 총익(k) | 강세일 평균  약세일 평균');
  for (const k of ALL) {
    const rs = days.map(t => sc.ser[k].get(t)!); const s = stats(rs); const k17 = fitK(rs, 17);
    const bull = mean(days.filter(t => btcBull.get(t)).map(t => sc.ser[k].get(t)!)), bear = mean(days.filter(t => btcBull.get(t) === false).map(t => sc.ser[k].get(t)!));
    console.log(`   ${k.padEnd(10)} ${P(s.ret).padStart(8)} ${(s.mdd.toFixed(0) + '%').padStart(5)} ${((sd(rs) * Math.sqrt(365) * 100).toFixed(0) + '%').padStart(6)}  | ${P(stats(rs, k17).ret).padStart(6)} (${k17.toFixed(2)}) | ${(bull * 1e4).toFixed(1).padStart(6)}bp ${(bear * 1e4).toFixed(1).padStart(6)}bp`);
  }
  const bh = stats(days.map(t => btcHold.get(t) ?? 0)); console.log(`   (BTC 보유 ${P(bh.ret)} MDD ${bh.mdd.toFixed(0)}%, MDD17 ${P(stats(days.map(t => btcHold.get(t) ?? 0), fitK(days.map(t => btcHold.get(t) ?? 0), 17)).ret)})`);
  // 상관
  console.log('② 일별 상관');
  console.log('            ' + ALL.map(k => k.slice(0, 7).padStart(8)).join(''));
  for (const a of ALL) { const ra = days.map(t => sc.ser[a].get(t)!); console.log(`   ${a.padEnd(9)}` + ALL.map(b => { const rb = days.map(t => sc.ser[b].get(t)!); const ma = mean(ra), mb = mean(rb); let c = 0, va = 0, vb = 0; for (let i = 0; i < ra.length; i++) { c += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; } return (c / Math.sqrt(va * vb)).toFixed(2).padStart(8); }).join('')); }
  // 배분안: 가중치는 앞 절반에서 정함(워크포워드)
  const Fs = NAMES;
  const colsIS = (ks: string[]) => ks.map(k => D1.map(t => sc.ser[k].get(t)!));
  const ivw = (ks: string[]) => { const v = colsIS(ks).map(c => 1 / sd(c)); const s = v.reduce((a, b) => a + b, 0); return Object.fromEntries(ks.map((k, i) => [k, v[i] / s])); };
  const mvw = (ks: string[]) => { const w = minVar(colsIS(ks)); return Object.fromEntries(ks.map((k, i) => [k, w[i]])); };
  const eqw = (ks: string[]) => Object.fromEntries(ks.map(k => [k, 1 / ks.length]));
  const core = (c: number, sats: string[]) => ({ BTC_TREND: c, ...Object.fromEntries(sats.map(k => [k, (1 - c) / sats.length])) });
  const PLANS: Array<[string, Record<string, number>, number]> = [
    ['BTC_TREND 단독', { BTC_TREND: 1 }, 0],
    ['F 계열 동일가중(6)', eqw(Fs), 0],
    ['전체 동일가중(7)', eqw(ALL), 0],
    ['역변동성(7)', ivw(ALL), 0],
    ['최소분산(7)', mvw(ALL), 0],
    ['코어 BTC 50 + F7·F7_sl·F7_btc', core(0.5, ['F7', 'F7_sl', 'F7_btc']), 0],
    ['코어 BTC 70 + F7·F7_sl·F7_btc', core(0.7, ['F7', 'F7_sl', 'F7_btc']), 0],
    ['코어 BTC 70 + F 6종', core(0.7, Fs), 0],
    ['코어 BTC 50 + F 6종', core(0.5, Fs), 0],
    ['역변동성(7) + 변동성타겟 20%', ivw(ALL), 0.20],
    ['코어 70/30 + 변동성타겟 20%', core(0.7, ['F7', 'F7_sl', 'F7_btc']), 0.20],
  ];
  console.log('③ 배분안 (가중치=앞 절반 결정) | 전체 MDD17 | 전체 MDD25 | WF: 앞에서 k(MDD17) 정해 뒤에 적용 → 뒤 총익/MDD | 비용×2 MDD17 | 가중치');
  for (const [lab, w, vt] of PLANS) {
    const rsAll = port(sc.ser, days, w, vt), rs1 = port(sc.ser, D1, w, vt), rs2 = port(sc.ser, D2, w, vt), rsC = port(sc.cost2, days, w, vt);
    const k17 = fitK(rsAll, 17), k25 = fitK(rsAll, 25), kIS = fitK(rs1, 17);
    const o = stats(rs2, kIS);
    const ws = Object.entries(w).filter(([, v]) => v > 0.005).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}`).join(' · ');
    console.log(`   ${lab.padEnd(30)} ${P(stats(rsAll, k17).ret).padStart(6)}(${k17.toFixed(2)}) ${P(stats(rsAll, k25).ret).padStart(6)}(${k25.toFixed(2)}) | ${P(o.ret).padStart(6)} / ${o.mdd.toFixed(0).padStart(2)}% | ${P(stats(rsC, fitK(rsC, 17)).ret).padStart(6)} | ${ws}`);
  }
  // 연도별 (코어 70/30, 전체 동일가중, BTC_TREND)
  const yrs = [...new Set(days.map(t => new Date(t).getUTCFullYear()))];
  console.log('④ 연도별 (MDD17 k 적용)  ' + yrs.map(y => String(y).padStart(7)).join(''));
  for (const [lab, w] of [['BTC_TREND', { BTC_TREND: 1 }], ['F 동일가중', eqw(Fs)], ['전체 동일가중', eqw(ALL)], ['코어 70/30', core(0.7, ['F7', 'F7_sl', 'F7_btc'])]] as Array<[string, Record<string, number>]>) {
    const rs = port(sc.ser, days, w); const k = fitK(rs, 17);
    console.log(`   ${lab.padEnd(22)}` + yrs.map(y => P(stats(days.map((t, i) => [t, rs[i]] as const).filter(([t]) => new Date(t).getUTCFullYear() === y).map(([, r]) => r), k).ret).padStart(7)).join(''));
  }
}
