/**
 * AI 리스크 데스크 리서치(2026-10) — B: 규칙 전략(RS_LAG·ALT_SWING) 거래와 업비트 부정 공지의 겹침, 거부권 시나리오 (리서치 전용)
 *
 * 엔진: _bt_dip_alt_lib 의 port 와 같은 규칙(일봉, i 종가 신호 → i+1 시가 + 스프레드½, TP 지정가 관통 0.2%, H일 종가, 무스톱, K 슬롯, 슬롯당 평가액×size)
 *   + 거래 로그 + 거부권 훅(진입 차단 / 보유 중 그 날 종가 시장가 청산).
 * 부정 공지(ann-catalog.json): CORE = CAUTION_ON·CAUTION_EXT·WARN·DELIST(KRW) / ALL = CORE + DW_SUSPEND(PLAIN|ISSUE)
 * 시나리오:
 *   base      거부권 없음
 *   live      현행 paper-warning: 지정·연장·촉구 ON ~ 해제 OFF 동안 진입 금지, 보유 중 ON 공지 뜬 봉 종가 청산 (DELIST 는 ON 아님 — 현행 규칙 그대로)
 *   react     결정론 대리 데스크: ALL 공지 후 14일 진입 금지 + 보유 중 ALL 공지 뜬 봉 종가 청산
 *   fore7     선견 7일: 신호 종가 이후 7일 안에 CORE 공지가 뜰 코인은 진입 금지(보유 중에도 7일 앞 공지 보이면 그 날 종가 청산)
 *   perfect   상한: 보유 창 [진입일, 청산일] 안에 CORE(또는 ALL) 공지가 뜨는 거래 전부 차단
 * 상폐 코인 보완: 바이낸스 USDT 일봉(binance-1d-ext) × KRW=X 환율, 거래대금 = 바이낸스 quoteVol×환율×(업비트/바이낸스 비율의 날짜별 중앙값), 창 = [KRW 상장공지+1일 또는 2019-01-01, 상폐공지+7일]
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/riskdesk-2026-10';
const DAY = L.DAY;
interface Bar { ts: number; open: number; high: number; low: number; close: number; value: number }
const SPREAD: Record<string, number> = JSON.parse(fs.readFileSync('data/research-spread-p50.json', 'utf8'));

// ── 공지 ──
interface Ev { id: number; ts: number; at: string; type: string; sub?: string; scope?: string; sym: string; title: string }
const ANN: Ev[] = JSON.parse(fs.readFileSync(`${OUT}/ann-catalog.json`, 'utf8'));
const isCore = (e: Ev) => e.type === 'CAUTION_ON' || e.type === 'CAUTION_EXT' || e.type === 'WARN' || (e.type === 'DELIST' && e.scope === 'KRW');
const isAll = (e: Ev) => isCore(e) || (e.type === 'DW_SUSPEND' && (e.sub === 'PLAIN' || e.sub === 'ISSUE'));
const isOn = (e: Ev) => e.type === 'CAUTION_ON' || e.type === 'CAUTION_EXT' || e.type === 'WARN';
const NEG = new Map<string, Ev[]>();
for (const e of ANN) { const m = 'KRW-' + e.sym; if (!NEG.has(m)) NEG.set(m, []); NEG.get(m)!.push(e); }
for (const v of NEG.values()) v.sort((a, b) => a.ts - b.ts);
/** (t0, t1] 안의 공지 */
const within = (m: string, t0: number, t1: number, f: (e: Ev) => boolean) => (NEG.get(m) ?? []).filter(e => e.ts > t0 && e.ts <= t1 && f(e));
/** paper-warning 상태: 마지막 ON/OFF (ts ≤ t) */
function onState(m: string, t: number) { let s = false; for (const e of NEG.get(m) ?? []) { if (e.ts > t) break; if (isOn(e)) s = true; else if (e.type === 'CAUTION_OFF') s = false; } return s; }
/** 변형: 지정·연장은 해제까지, 촉구(WARN)는 30일만 차단 (촉구에는 해제 공지가 없어 현행 규칙은 영구 차단이 됨) */
function onState30(m: string, t: number, warnDays = 30) { let s = false, wu = 0; for (const e of NEG.get(m) ?? []) { if (e.ts > t) break; if (e.type === 'CAUTION_ON' || e.type === 'CAUTION_EXT') s = true; else if (e.type === 'WARN') wu = e.ts + warnDays * DAY; else if (e.type === 'CAUTION_OFF') { s = false; wu = 0; } } return s || t < wu; }
const isCaution = (e: Ev) => e.type === 'CAUTION_ON' || e.type === 'CAUTION_EXT';
function cautionState(m: string, t: number) { let s = false; for (const e of NEG.get(m) ?? []) { if (e.ts > t) break; if (isCaution(e)) s = true; else if (e.type === 'CAUTION_OFF') s = false; } return s; }

// ── 데이터(기본 + 확장) ──
interface Data { G: Map<string, (Bar | null)[]>; RANK: Map<string, number>[]; VAL30: Map<string, Float64Array>; ext: Set<string> }
const tickOld = (p: number) => p >= 2e6 ? 1000 : p >= 1e6 ? 500 : p >= 5e5 ? 100 : p >= 1e5 ? 50 : p >= 1e4 ? 10 : p >= 1e3 ? 5 : p >= 100 ? 1 : p >= 10 ? 0.1 : p >= 1 ? 0.01 : 0.001;
const tick = (p: number) => p >= 2e6 ? 1000 : p >= 1e6 ? 500 : p >= 5e5 ? 100 : p >= 1e5 ? 50 : p >= 1e4 ? 10 : p >= 1e3 ? 1 : p >= 100 ? 0.1 : p >= 10 ? 0.01 : p >= 1 ? 0.001 : p >= 0.1 ? 0.0001 : 0.00001;
let COSTX = 1;
function build(extra: Map<string, (Bar | null)[]>): Data {
  const G = new Map<string, (Bar | null)[]>([...L.G, ...extra]);
  const VAL30 = new Map<string, Float64Array>(); const HIST = new Map<string, Int32Array>();
  for (const [m, a] of G) {
    const v = new Float64Array(L.TS.length); const h = new Int32Array(L.TS.length); let s = 0, cnt = 0; const q: number[] = [];
    for (let i = 0; i < L.TS.length; i++) { const x = a[i]; const val = x ? x.value : 0; q.push(val); s += val; if (q.length > 30) s -= q.shift()!; if (x) cnt++; v[i] = s; h[i] = cnt; }
    VAL30.set(m, v); HIST.set(m, h);
  }
  const RANK = L.TS.map((_, i) => { const arr = [...G.keys()].filter(m => m !== 'KRW-BTC' && G.get(m)![i] && HIST.get(m)![i] >= 30).map(m => [m, VAL30.get(m)![i]] as [string, number]).sort((a, b) => b[1] - a[1]); return new Map(arr.map(([m], r) => [m, r])); });
  return { G, RANK, VAL30, ext: new Set(extra.keys()) };
}
function slip(D: Data, m: string, i: number) {
  let spBps: number;
  if (SPREAD[m] != null) spBps = SPREAD[m];
  else { const v = D.VAL30.get(m)![i] / 30; const fit = Math.exp(12.885 - 0.437 * Math.log(Math.max(v, 1e7))) * 1.3; const p = D.G.get(m)![i]?.close ?? 1; spBps = Math.max(fit, ((L.TS[i] < Date.UTC(2023, 0, 1) ? tickOld(p) : tick(p)) / p) * 1e4, 15); spBps = Math.min(spBps, 150); }
  return COSTX * Math.max(0.0005, spBps / 2 / 1e4);
}
const FEE = () => 0.0005 * COSTX;
const retOf = (D: Data, m: string, i: number, k: number) => { const a = D.G.get(m)![i], b = D.G.get(m)![i - k]; return a && b ? a.close / b.close - 1 : null; };
function valZ(D: Data, m: string, i: number, w = 30) { const a = D.G.get(m)!; let s = 0, s2 = 0, n = 0; for (let j = i - w; j < i; j++) { const x = a[j]; if (!x) continue; s += x.value; s2 += x.value ** 2; n++; } if (n < 20 || !a[i]) return null; const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-9)); return (a[i]!.value - mu) / sd; }

// ── 전략 ──
type Sig = (D: Data, m: string, i: number) => number | null;
interface Strat { name: string; sig: Sig; btcOk: (i: number) => boolean; N: number; K: number; tp: number; H: number }
const STRATS: Strat[] = [
  { name: 'RS_LAG', N: 20, K: 3, tp: 10, H: 7, btcOk: (i) => { const r = L.btcRet(i, 7); return r != null && r <= -0.05; }, sig: (D, m, i) => { const r = retOf(D, m, i, 14), b = L.btcRet(i, 14); if (r == null || b == null) return null; const s = r - b; return s <= -0.15 ? -s : null; } },
  { name: 'ALT_SWING', N: 20, K: 3, tp: 6, H: 3, btcOk: (i) => L.REGIME[i] != null && L.REGIME[i] !== 'a', sig: (D, m, i) => { const a = D.G.get(m)!; const x = a[i]; if (!x || x.close <= x.open) return null; let hi = -Infinity; for (let j = i - 7; j < i; j++) { if (!a[j]) return null; hi = Math.max(hi, a[j]!.high); } const z = valZ(D, m, i); return x.close > hi && z != null && z >= 0.5 ? z : null; } },
];
const SIGC = new Map<string, Float64Array>();
function sigAt(D: Data, tag: string, s: Strat, m: string, i: number) { const k = tag + '|' + s.name + '|' + m; let a = SIGC.get(k); if (!a) { a = new Float64Array(L.TS.length).fill(NaN); for (let j = 40; j < L.TS.length; j++) { const v = s.sig(D, m, j); if (v != null) a[j] = v; } SIGC.set(k, a); } const v = a[i]; return Number.isNaN(v) ? null : v; }

// ── 엔진 ──
interface Hooks { block?: (m: string, j: number, e: number) => boolean; exitNow?: (m: string, i: number) => boolean }
interface Trade { m: string; j: number; e: number; k: number; r: number; kind: string; used: number; pnl: number; ext: boolean }
interface Res { ret: number; mdd: number; n: number; win: number; sharpe: number; daily: Float64Array; trades: Trade[]; first: number; last: number }
/** 진입일 e, 진입가 ep 에서 TP/시간청산 경로 (훅 없이) → 청산 인덱스 */
function walkK(D: Data, m: string, e: number, ep: number, s: Strat) { const a = D.G.get(m)!; const tgt = ep * (1 + s.tp / 100); let held = 0, last = e; for (let k = e; k < L.TS.length; k++) { const b = a[k]; if (!b) continue; last = k; if (b.high >= tgt * 1.002) return k; held++; if (held >= s.H) return k; } return last; }
function run(D: Data, tag: string, s: Strat, size: number, hooks: Hooks = {}, from = L.START, to = Infinity): Res {
  let cash = 1e7, peak = 1e7, mdd = 0, prevEq = 1e7, first = -1, last = -1;
  const open: { m: string; ep: number; vol: number; used: number; tgt: number; held: number; j: number; e: number; last: number }[] = [];
  const daily = new Float64Array(L.TS.length).fill(NaN); const trades: Trade[] = [];
  const close = (q: typeof open[0], px: number, k: number, kind: string) => { const got = q.vol * px * (1 - FEE()); cash += got; trades.push({ m: q.m, j: q.j, e: q.e, k, r: got / q.used - 1, kind, used: q.used, pnl: got - q.used, ext: D.ext.has(q.m) }); };
  for (let i = 60; i < L.TS.length; i++) {
    if (L.TS[i] < from || L.TS[i] > to) continue; if (first < 0) first = i; last = i;
    for (let p = open.length - 1; p >= 0; p--) {
      const q = open[p]; const b = D.G.get(q.m)![i]; if (!b) continue;
      let px = 0, kind = '';
      if (hooks.exitNow && hooks.exitNow(q.m, i)) { px = b.close * (1 - slip(D, q.m, i)); kind = 'veto'; }
      else if (b.high >= q.tgt * 1.002) { px = q.tgt; kind = 'tp'; }
      else { q.held++; if (q.held >= s.H) { px = b.close * (1 - slip(D, q.m, i)); kind = 'time'; } }
      if (px) { close(q, px, i, kind); open.splice(p, 1); } else q.last = b.close;
    }
    const j = i - 1;
    if (j >= 60 && s.btcOk(j)) {
      const cands: [string, number][] = [];
      for (const [m, r] of D.RANK[j]) { if (r >= s.N) continue; if (!D.G.get(m)![i]) continue; const v = sigAt(D, tag, s, m, j); if (v != null) cands.push([m, v]); }
      cands.sort((a, b) => b[1] - a[1]);
      const eqNow = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
      let takenToday = 0;   // 당일 TP 로 바로 닫힌 거래도 그날 슬롯을 쓴 것으로 센다 (_bt_dip_alt_lib.port 는 이걸 세지 않아 급락일에 K 를 초과 진입함)
      for (const [m] of cands) {
        if (open.length + takenToday >= s.K) break; if (open.some(q => q.m === m)) continue;
        if (hooks.block && hooks.block(m, j, i)) continue;
        const b = D.G.get(m)![i]!; const ep = b.open * (1 + slip(D, m, j)); const used = Math.min(cash, eqNow * size); if (used < 5000) continue;
        cash -= used; takenToday++; const tgt = ep * (1 + s.tp / 100);
        const q = { m, ep, vol: used * (1 - FEE()) / ep, used, tgt, held: 0, j, e: i, last: b.close };
        if (hooks.exitNow && hooks.exitNow(m, i)) { close(q, b.close * (1 - slip(D, m, i)), i, 'veto'); continue; }
        if (b.high >= tgt * 1.002) { close(q, tgt, i, 'tp'); continue; }
        q.held = 1; if (q.held >= s.H) { close(q, b.close * (1 - slip(D, m, i)), i, 'time'); continue; }
        open.push(q);
      }
    }
    const eq = cash + open.reduce((a, q) => a + q.vol * q.last, 0);
    daily[i] = eq / prevEq - 1; prevEq = eq; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
  }
  // 데이터 끝 미청산분(상폐 포함)은 마지막 가격으로 평가(상폐 코인은 마지막 바이낸스 봉)
  const dr = [...daily].filter(x => !Number.isNaN(x)); const mu = dr.reduce((a, b) => a + b, 0) / dr.length; const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mu) ** 2, 0) / dr.length);
  const n = trades.length;
  return { ret: 100 * (prevEq / 1e7 - 1), mdd: 100 * mdd, n, win: n ? 100 * trades.filter(t => t.r > 0).length / n : 0, sharpe: sd > 0 ? mu / sd * Math.sqrt(365) : 0, daily, trades, first, last };
}
function sizeFor(D: Data, tag: string, s: Strat, target = 17) { let lo = 0.01, hi = 1; if (run(D, tag, s, hi).mdd <= target) return hi; for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (run(D, tag, s, mid).mdd > target) hi = mid; else lo = mid; } return (lo + hi) / 2; }
const yrs = (r: Res) => (r.last - r.first + 1) / 365;
const fmt = (nm: string, r: Res) => `${nm.padEnd(22)} ret ${L.f0(r.ret).padStart(6)}% CAGR ${L.f1(100 * (Math.pow(1 + r.ret / 100, 1 / yrs(r)) - 1)).padStart(6)}% MDD ${r.mdd.toFixed(1).padStart(5)}% Sh ${r.sharpe.toFixed(2)} n ${String(r.n).padStart(4)} win ${r.win.toFixed(0)}% veto-exits ${r.trades.filter(t => t.kind === 'veto').length}`;
const per = (r: Res) => L.PERIODS.map(([p, a, b]) => `${p} ${L.f1(L.periodRet(r.daily, a, b))}`).join(' | ');

// ── 시나리오 훅 ──
function hooksFor(D: Data, s: Strat, kind: string): Hooks {
  const tEnd = (i: number) => L.TS[i] + DAY;   // i 봉 마감 시각(UTC00 = KST09)
  switch (kind) {
    case 'base': return {};
    case 'live': return { block: (m, j) => onState(m, tEnd(j)), exitNow: (m, i) => within(m, L.TS[i], tEnd(i), isOn).length > 0 };
    case 'live30': return { block: (m, j) => onState30(m, tEnd(j)), exitNow: (m, i) => within(m, L.TS[i], tEnd(i), isOn).length > 0 };
    case 'cautionOnly': return { block: (m, j) => cautionState(m, tEnd(j)), exitNow: (m, i) => within(m, L.TS[i], tEnd(i), isCaution).length > 0 };
    case 'react': return { block: (m, j) => within(m, tEnd(j) - 14 * DAY, tEnd(j), isAll).length > 0, exitNow: (m, i) => within(m, L.TS[i], tEnd(i), isAll).length > 0 };
    case 'fore7': return { block: (m, j) => within(m, tEnd(j), tEnd(j) + 7 * DAY, isCore).length > 0, exitNow: (m, i) => within(m, tEnd(i), tEnd(i) + 7 * DAY, isCore).length > 0 };
    case 'perfect': return { block: (m, j, e) => { const b = D.G.get(m)![e]!; const k = walkK(D, m, e, b.open * (1 + slip(D, m, j)), s); return within(m, L.TS[e], tEnd(k), isCore).length > 0; } };
    case 'perfectAll': return { block: (m, j, e) => { const b = D.G.get(m)![e]!; const k = walkK(D, m, e, b.open * (1 + slip(D, m, j)), s); return within(m, L.TS[e], tEnd(k), isAll).length > 0; } };
    case 'perfectLoss': return { block: (m, j, e) => { const b = D.G.get(m)![e]!; const ep = b.open * (1 + slip(D, m, j)); const k = walkK(D, m, e, ep, s); const a = D.G.get(m)!; const xb = a[k]!; const px = xb.high >= ep * (1 + s.tp / 100) * 1.002 ? ep * (1 + s.tp / 100) : xb.close; return px < ep && within(m, L.TS[e], tEnd(k), isAll).length > 0; } };
  }
  return {};
}
const SCEN = ['base', 'live', 'live30', 'cautionOnly', 'react', 'fore7', 'perfect', 'perfectAll', 'perfectLoss'];

// ── 겹침 통계 ──
function overlap(trades: Trade[], L2: string[], tag: string) {
  const T = trades.length; const tot = trades.reduce((a, t) => a + t.pnl, 0);
  const cats: [string, (e: Ev) => boolean][] = [['CAUTION_ON/EXT', e => e.type === 'CAUTION_ON' || e.type === 'CAUTION_EXT'], ['WARN', e => e.type === 'WARN'], ['DELIST_KRW', e => e.type === 'DELIST' && e.scope === 'KRW'], ['DW_SUSPEND plain/issue', e => e.type === 'DW_SUSPEND' && (e.sub === 'PLAIN' || e.sub === 'ISSUE')], ['DW_SUSPEND fork/maint', e => e.type === 'DW_SUSPEND' && (e.sub === 'FORK' || e.sub === 'MAINT')], ['CORE any', isCore], ['ALL any', isAll]];
  L2.push(`[${tag}] trades ${T}, total pnl ${(tot / 1e4).toFixed(0)}만원`);
  L2.push('notice type              | pre14d(n, pnl만, avg%) | during hold(n, pnl만, avg%) | either(n, %of trades, pnl만, avg%)');
  for (const [nm, f] of cats) {
    const pre = trades.filter(t => within(t.m, L.TS[t.e] - 14 * DAY, L.TS[t.e], f).length > 0);
    const dur = trades.filter(t => within(t.m, L.TS[t.e], L.TS[t.k] + DAY, f).length > 0);
    const eit = trades.filter(t => within(t.m, L.TS[t.e] - 14 * DAY, L.TS[t.k] + DAY, f).length > 0);
    const S = (xs: Trade[]) => `${xs.length}, ${(xs.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}, ${xs.length ? (100 * xs.reduce((a, t) => a + t.r, 0) / xs.length).toFixed(1) : '-'}`;
    L2.push(`${nm.padEnd(24)} | ${S(pre).padEnd(22)} | ${S(dur).padEnd(27)} | ${eit.length}, ${(100 * eit.length / Math.max(1, T)).toFixed(1)}%, ${(eit.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}, ${eit.length ? (100 * eit.reduce((a, t) => a + t.r, 0) / eit.length).toFixed(1) : '-'}`);
  }
  const noAll = trades.filter(t => within(t.m, L.TS[t.e] - 14 * DAY, L.TS[t.k] + DAY, isAll).length === 0);
  L2.push(`no ALL notice: n ${noAll.length} avg ${(100 * noAll.reduce((a, t) => a + t.r, 0) / Math.max(1, noAll.length)).toFixed(2)}% | worst 10 trades: ` + [...trades].sort((a, b) => a.r - b.r).slice(0, 10).map(t => `${new Date(L.TS[t.e]).toISOString().slice(0, 10)} ${t.m.slice(4)} ${(100 * t.r).toFixed(0)}%${within(t.m, L.TS[t.e] - 14 * DAY, L.TS[t.k] + DAY, isAll).length ? '*' : ''}`).join(', '));
}

// ── 확장 유니버스(상폐 코인) ──
function loadExt(): Map<string, (Bar | null)[]> {
  const dir = `${OUT}/binance-1d-ext`; const out = new Map<string, (Bar | null)[]>();
  const fxJ = JSON.parse(fs.readFileSync('data/research-ext/macro/yahoo-KRW=X.json', 'utf8')).chart.result[0];
  const fx = new Map<number, number>(); fxJ.timestamp.forEach((t: number, i: number) => { const c = fxJ.indicators.quote[0].close[i]; if (c) fx.set(Math.floor(t / 86400) * DAY, c); });
  const fxAt = (t: number) => { for (let k = 0; k < 7; k++) { const v = fx.get(t - k * DAY); if (v) return v; } return 1200; };
  // 업비트 value / (바이낸스 quoteVol × fx) 날짜별 중앙값 (현존 코인, binance-1d)
  const ratio = new Float64Array(L.TS.length).fill(NaN);
  { const per: number[][] = L.TS.map(() => []); const bdir = 'data/research-ext/dip-2026-10/alt/binance-1d';
    for (const f of fs.readdirSync(bdir).filter(f => /^[A-Z0-9]+\.json$/.test(f))) { const m = 'KRW-' + f.slice(0, -5); const g = L.G.get(m); if (!g) continue; const b: number[][] = JSON.parse(fs.readFileSync(`${bdir}/${f}`, 'utf8')); for (const k of b) { const i = L.TI.get(k[0]); if (i == null || !g[i] || k[5] <= 0) continue; per[i].push(g[i]!.value / (k[5] * fxAt(k[0]))); } }
    for (let i = 0; i < L.TS.length; i++) if (per[i].length >= 5) ratio[i] = L.median(per[i]);
    let lastv = 1; for (let i = 0; i < L.TS.length; i++) { if (Number.isNaN(ratio[i])) ratio[i] = lastv; else lastv = ratio[i]; }
  }
  const del = ANN.filter(e => e.type === 'DELIST' && e.scope === 'KRW'); const listK = ANN.filter(e => e.type === 'LIST' && e.scope === 'KRW');
  const info: string[] = [];
  for (const f of fs.readdirSync(dir).filter(f => /^[A-Z0-9]+\.json$/.test(f))) {
    const sym = f.slice(0, -5); const m = 'KRW-' + sym; if (L.G.has(m)) continue;
    const d = del.filter(e => e.sym === sym).sort((a, b) => a.ts - b.ts)[0]; if (!d) continue;
    const li = listK.filter(e => e.sym === sym && e.ts < d.ts).sort((a, b) => b.ts - a.ts)[0];
    // KRW 상장 공지가 없는데 BTC/USDT 마켓 상장 공지만 있으면 KRW 마켓 코인이 아니었을 가능성이 높다 → 제외
    if (!li && ANN.some(e => e.sym === sym && e.type === 'LIST' && e.scope === 'OTHER')) { info.push(`${sym} skipped (non-KRW listing only)`); continue; }
    const t0 = Math.max(li ? li.ts + DAY : 0, Date.UTC(2018, 6, 1)); const t1 = d.ts + 7 * DAY; if (t1 < Date.UTC(2019, 0, 1)) continue;
    const b: number[][] = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    const a: (Bar | null)[] = new Array(L.TS.length).fill(null); let n = 0;
    for (const k of b) { const i = L.TI.get(k[0]); if (i == null || k[0] < t0 || k[0] > t1 || k[4] <= 0) continue; const x = fxAt(k[0]); a[i] = { ts: k[0], open: k[1] * x, high: k[2] * x, low: k[3] * x, close: k[4] * x, value: k[5] * x * ratio[i] }; n++; }
    if (n < 60) continue; out.set(m, a);
    info.push(`${sym} ${new Date(t0).toISOString().slice(0, 10)}~${new Date(t1).toISOString().slice(0, 10)} bars ${n} list=${li ? li.at.slice(0, 10) : 'pre'} delist=${d.at.slice(0, 10)}`);
  }
  fs.writeFileSync(`${OUT}/ext-universe.txt`, info.join('\n'));
  return out;
}

// ── 실행 ──
const out: string[] = [];
const D0 = build(new Map());
const EXT = loadExt(); const D1 = build(EXT);
out.push(`ext coins added: ${EXT.size} (${[...EXT.keys()].map(m => m.slice(4)).join(',')})`);
// 확장 코인이 상위 20 에 든 날 수
{ const cnt: Record<string, number> = {}; for (let i = 0; i < L.TS.length; i++) { if (L.TS[i] < L.START) continue; for (const [m, r] of D1.RANK[i]) if (r < 20 && EXT.has(m)) cnt[m] = (cnt[m] || 0) + 1; } out.push('ext coins in top-20 days: ' + Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m.slice(4)}:${n}`).join(' ')); }
const allTrades: Record<string, Trade[]> = {};
for (const s of STRATS) {
  out.push(`\n############ ${s.name} (N${s.N} K${s.K} TP${s.tp} H${s.H}) ############`);
  for (const [tag, D] of [['survivor', D0], ['with-delisted', D1]] as [string, Data][]) {
    const sz = sizeFor(D, tag, s); out.push(`--- universe: ${tag}, eq17 size ${(100 * sz).toFixed(0)}%/slot ---`);
    const base = run(D, tag, s, sz);
    const res: Record<string, Res> = {};
    for (const sc of SCEN) { const r = run(D, tag, s, sz, hooksFor(D, s, sc)); res[sc] = r; out.push(fmt(sc, r) + ` | Δret ${L.f1(r.ret - base.ret)}%p ΔMDD ${L.f1(r.mdd - base.mdd)}%p | ${per(r)}`); }
    // 비용×2, 2022-07~
    COSTX = 2; out.push(`cost×2: base ${L.f0(run(D, tag, s, sz).ret)}% live ${L.f0(run(D, tag, s, sz, hooksFor(D, s, 'live')).ret)}% react ${L.f0(run(D, tag, s, sz, hooksFor(D, s, 'react')).ret)}% perfect ${L.f0(run(D, tag, s, sz, hooksFor(D, s, 'perfect')).ret)}%`); COSTX = 1;
    out.push(`from 2022-07 (same size): ` + SCEN.map(sc => `${sc} ${L.f0(run(D, tag, s, sz, hooksFor(D, s, sc), Date.UTC(2022, 6, 1)).ret)}%`).join(' | '));
    overlap(base.trades, out, `${s.name}/${tag} base`);
    if (tag === 'with-delisted') { const ex = base.trades.filter(t => t.ext); out.push(`ext-coin trades: ${ex.length}, pnl ${(ex.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}만: ` + ex.map(t => `${new Date(L.TS[t.e]).toISOString().slice(0, 10)} ${t.m.slice(4)} ${(100 * t.r).toFixed(0)}% ${t.kind}`).join(', ')); }
    // 거부된 거래 목록(perfect 기준: base 에는 있는데 perfect 에 없는 거래)
    const key = (t: Trade) => `${t.m}|${t.e}`; const pk = new Set(res.perfect.trades.map(key)); const vetoed = base.trades.filter(t => !pk.has(key(t)));
    out.push(`perfect-vetoed trades (${vetoed.length}, pnl ${(vetoed.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}만, avg ${vetoed.length ? (100 * vetoed.reduce((a, t) => a + t.r, 0) / vetoed.length).toFixed(1) : '-'}%): ` + vetoed.map(t => `${new Date(L.TS[t.e]).toISOString().slice(0, 10)} ${t.m.slice(4)} ${(100 * t.r).toFixed(0)}%`).join(', '));
    const lk = new Set(res.live.trades.map(key)); const lv = base.trades.filter(t => !lk.has(key(t))); const bk = new Set(base.trades.map(key)); const ladd = res.live.trades.filter(t => !bk.has(key(t)));
    out.push(`live-rule removed trades (${lv.length}, pnl ${(lv.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}만, avg ${lv.length ? (100 * lv.reduce((a, t) => a + t.r, 0) / lv.length).toFixed(1) : '-'}%): ` + lv.map(t => `${new Date(L.TS[t.e]).toISOString().slice(0, 10)} ${t.m.slice(4)} ${(100 * t.r).toFixed(0)}%`).join(', ') + ` | trades added instead (${ladd.length}, pnl ${(ladd.reduce((a, t) => a + t.pnl, 0) / 1e4).toFixed(0)}만, avg ${ladd.length ? (100 * ladd.reduce((a, t) => a + t.r, 0) / ladd.length).toFixed(1) : '-'}%) | live veto-exit trades: ` + res.live.trades.filter(t => t.kind === 'veto').map(t => `${new Date(L.TS[t.e]).toISOString().slice(0, 10)} ${t.m.slice(4)} ${(100 * t.r).toFixed(0)}%`).join(', '));
    allTrades[`${s.name}/${tag}`] = base.trades;
  }
}
// 슬롯 제약 없는 신호 이벤트(코인별 보유 중복 제거): 부정 공지와 겹친 이벤트의 수익 — 거부권 상한의 '슬롯 운' 무관 버전
for (const s of STRATS) {
  const D = D1; const ev: { m: string; e: number; k: number; r: number }[] = []; const busy = new Map<string, number>();
  for (let i = 60; i < L.TS.length - 1; i++) {
    if (L.TS[i] < L.START || !s.btcOk(i)) continue;
    for (const [m, r] of D.RANK[i]) { if (r >= s.N) continue; if ((busy.get(m) ?? -1) >= i) continue; if (sigAt(D, 'with-delisted', s, m, i) == null) continue; const e = i + 1; const b = D.G.get(m)![e]; if (!b) continue; const ep = b.open * (1 + slip(D, m, i)); const k = walkK(D, m, e, ep, s); const xb = D.G.get(m)![k]!; const px = xb.high >= ep * (1 + s.tp / 100) * 1.002 ? ep * (1 + s.tp / 100) : xb.close * (1 - slip(D, m, k)); ev.push({ m, e, k, r: (px * (1 - FEE())) / (ep / (1 - FEE())) - 1 }); busy.set(m, k); }
  }
  const hitC = ev.filter(x => within(x.m, L.TS[x.e] - DAY, L.TS[x.k] + DAY, isCore).length > 0), hitA = ev.filter(x => within(x.m, L.TS[x.e] - DAY, L.TS[x.k] + DAY, isAll).length > 0);
  const avg = (xs: typeof ev) => xs.length ? (100 * xs.reduce((a, x) => a + x.r, 0) / xs.length).toFixed(1) : '-';
  out.push(`\n[${s.name}] unconstrained signal events (with-delisted universe, 2019~): n ${ev.length} avg ${avg(ev)}% | CORE notice in [entry-1d, exit]: n ${hitC.length} avg ${avg(hitC)}% sum ${(100 * hitC.reduce((a, x) => a + x.r, 0)).toFixed(0)}%-units | ALL: n ${hitA.length} avg ${avg(hitA)}%`);
  out.push('  CORE-hit events: ' + hitC.map(x => `${new Date(L.TS[x.e]).toISOString().slice(0, 10)} ${x.m.slice(4)} ${(100 * x.r).toFixed(0)}%`).join(', '));
  const exEv = ev.filter(x => D.ext.has(x.m) && x.r < -0.3); out.push('  ext-coin events worse than -30%: ' + exEv.map(x => `${new Date(L.TS[x.e]).toISOString().slice(0, 10)} ${x.m.slice(4)} ${(100 * x.r).toFixed(0)}%`).join(', '));
}
// 플라시보: 같은 수의 거래를 무작위로 거부(perfect 와 같은 개수) → 분포
{ const s = STRATS[0]; const sz = sizeFor(D1, 'with-delisted', s); const base = run(D1, 'with-delisted', s, sz); const nv = base.trades.length - run(D1, 'with-delisted', s, sz, hooksFor(D1, s, 'perfect')).trades.length;
  const rs: number[] = []; for (let seed = 1; seed <= 40; seed++) { let x = seed * 7919; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; const p = nv / base.trades.length; rs.push(run(D1, 'with-delisted', s, sz, { block: () => rnd() < p }).ret); }
  rs.sort((a, b) => a - b); out.push(`\nplacebo RS_LAG/with-delisted: randomly veto ${nv}/${base.trades.length} trades ×40 seeds → ret med ${L.f0(rs[20])}% min ${L.f0(rs[0])}% max ${L.f0(rs[39])}% (base ${L.f0(base.ret)}%)`); }
fs.writeFileSync(`${OUT}/overlap-trades.json`, JSON.stringify(Object.fromEntries(Object.entries(allTrades).map(([k, v]) => [k, v.map(t => ({ m: t.m, e: L.TS[t.e], k: L.TS[t.k], r: +t.r.toFixed(4), kind: t.kind, ext: t.ext }))]))));
fs.writeFileSync(`${OUT}/overlap-report.txt`, out.join('\n'));
console.log('done');
