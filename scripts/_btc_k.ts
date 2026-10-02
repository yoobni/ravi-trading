/**
 * 축 K — BTC 전용 단기 전략 (2026-10-02). 데이터: data/research-ext/btc15m.json (KRW-BTC 15m 2021-01~2026-10).
 * 엔진: 거래 목록 → 1시간 수익 시계열(가중치 합산) → 동일위험(MDD 17%) 스케일. 비용: 수수료 0.05%/편도,
 *   시장가 슬리피지 0.02%(BTC 스프레드 ~1bp, 보수), 지정가 = 슬리피지 0 + 관통 요구(0.05% 기본 / 0.2% 스트레스).
 * 모드: base | dip | grid | tod | vbo | exec
 */
import fs from 'fs';
const RAW: number[][] = JSON.parse(fs.readFileSync('data/research-ext/btc15m.json', 'utf8'));
const Q = 15 * 60e3, H = 3600e3, DAY = 86400e3, FOUR = 4 * H;
let FEE = 0.0005, SLIP = 0.0002;
interface B { ts: number; o: number; h: number; l: number; c: number; v: number }
const M15: B[] = RAW.map(r => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
const I15 = new Map(M15.map((b, i) => [b.ts, i]));
function agg(step: number, off = 0): B[] {
  const out: B[] = [];
  for (const x of M15) {
    const k = Math.floor((x.ts - off) / step) * step + off; const l = out[out.length - 1];
    if (!l || l.ts !== k) out.push({ ts: k, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
    else { l.h = Math.max(l.h, x.h); l.l = Math.min(l.l, x.l); l.c = x.c; l.v += x.v; }
  }
  return out;
}
const H1 = agg(H), H4 = agg(FOUR), D1 = agg(DAY);
const IH = new Map(H1.map((b, i) => [b.ts, i]));
/** ts 시각 체결가 = 그 시각을 포함하는 15m 봉 시가(없으면 직전 봉 종가) */
function pxAt(ts: number): number { const k = Math.floor(ts / Q) * Q; const i = I15.get(k); if (i !== undefined) return M15[i].o; for (let t = k - Q; t > k - DAY; t -= Q) { const j = I15.get(t); if (j !== undefined) return M15[j].c; } return NaN; }
const T0 = Date.UTC(2021, 3, 1);   // SMA·지표 워밍업 이후
const T1 = M15[M15.length - 1].ts;
const SPLIT = Date.UTC(2024, 0, 1);

interface Trade { te: number; pe: number; tx: number; px: number; w: number; entryLimit?: boolean; exitLimit?: boolean }
/** 거래 → 1시간 수익 시계열(시작 T0). 가격은 비용 적용 전 원가, 비용은 진입/청산 시간에 차감. */
function series(trades: Trade[], from = T0, to = T1): Float64Array {
  const i0 = IH.get(Math.floor(from / H) * H) ?? 0; const n = (IH.get(Math.floor(to / H) * H) ?? H1.length - 1) - i0 + 1;
  const r = new Float64Array(Math.max(n, 0));
  for (const t of trades) {
    if (t.tx <= from || t.te >= to) continue;
    const ie = IH.get(Math.floor(t.te / H) * H)!, ix = IH.get(Math.floor(t.tx / H) * H)!;
    if (ie === undefined || ix === undefined) continue;
    const ce = (t.entryLimit ? 0 : SLIP) + FEE, cx = (t.exitLimit ? 0 : SLIP) + FEE;
    if (ie === ix) { const k = ie - i0; if (k >= 0 && k < n) r[k] += t.w * (t.px / t.pe - 1 - ce - cx); continue; }
    for (let i = ie; i <= ix; i++) {
      const k = i - i0; if (k < 0 || k >= n) continue;
      let x: number;
      if (i === ie) x = H1[i].c / t.pe - 1 - ce;
      else if (i === ix) x = t.px / H1[i - 1].c - 1 - cx;
      else x = H1[i].c / H1[i - 1].c - 1;
      r[k] += t.w * x;
    }
  }
  return r;
}
const stats = (r: Float64Array, f = 1) => { let e = 1, pk = 1, mdd = 0; for (const x of r) { e *= 1 + f * x; if (e > pk) pk = e; const d = 1 - e / pk; if (d > mdd) mdd = d; } return { ret: 100 * (e - 1), mdd: 100 * mdd }; };
const eq17 = (r: Float64Array, fmax = 1) => { const s = stats(r, fmax); if (s.mdd <= 17) return { f: fmax, ...s }; let lo = 0, hi = fmax; for (let k = 0; k < 28; k++) { const m = (lo + hi) / 2; if (stats(r, m).mdd > 17) hi = m; else lo = m; } return { f: lo, ...stats(r, lo) }; };
const yearsOf = (r: Float64Array, f: number, from = T0) => { const i0 = IH.get(Math.floor(from / H) * H)!; const out: Record<number, number> = {}; const eq: Record<number, number> = {};
  for (let k = 0; k < r.length; k++) { const y = new Date(H1[i0 + k].ts).getUTCFullYear(); eq[y] = (eq[y] ?? 1) * (1 + f * r[k]); } for (const y in eq) out[+y] = 100 * (eq[+y] - 1); return out; };
const P = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const YRS = [2021, 2022, 2023, 2024, 2025, 2026];
function show(lab: string, tr: Trade[], extra = '', from = T0, to = T1) {
  const r = series(tr, from, to); const maxW = Math.max(1, ...tr.map(t => t.w)); const s = stats(r), e = eq17(r, 1 / maxW);
  const y = yearsOf(r, e.f, from); const n = tr.filter(t => t.te >= from && t.te < to).length;
  const avg = n ? 100 * tr.filter(t => t.te >= from && t.te < to).reduce((a, t) => a + (t.px / t.pe - 1 - (t.entryLimit ? 0 : SLIP) - (t.exitLimit ? 0 : SLIP) - 2 * FEE), 0) / n : 0;
  console.log(`${lab.padEnd(34)}${P(s.ret).padStart(8)} MDD${s.mdd.toFixed(0).padStart(3)}% | eq17 ${P(e.ret).padStart(7)} f${e.f.toFixed(2)} | n${String(n).padStart(5)} 평균${(avg >= 0 ? '+' : '') + avg.toFixed(2)}% |${YRS.map(yy => (y[yy] == null ? '' : P(y[yy])).padStart(6)).join('')} ${extra}`);
  return { r, e, n, avg };
}
const HDR = () => console.log(''.padEnd(34) + '    총익    MDD  |    동일위험17%    |    거래·평균(비용후) |' + YRS.map(y => String(y).padStart(6)).join(''));

// ── BTC_TREND (일봉 경계 off, 실행 = 경계 + execMin 분) ──
function trendState(N = 50, boundary = 0): Map<number, boolean> {
  const d = boundary ? agg(DAY, boundary) : D1; const m = new Map<number, boolean>();
  for (let i = N - 1; i < d.length - 1; i++) { let s = 0; for (let j = i - N + 1; j <= i; j++) s += d[j].c; m.set(d[i + 1].ts, d[i].c > s / N); }
  return m;   // key = 다음 날 시작 시각 → 그날의 보유 여부
}
function trendTrades(N = 50, boundary = 0, execMin = 2, band = 0): Trade[] {
  const st = trendState(N, boundary); const days = [...st.keys()].sort((a, b) => a - b); const out: Trade[] = [];
  let on = false, te = 0, pe = 0;
  for (const d of days) {
    const want = st.get(d)!; const t = d + execMin * 60e3;
    if (want && !on) { on = true; te = t; pe = pxAt(t); }
    else if (!want && on) { on = false; out.push({ te, pe, tx: t, px: pxAt(t), w: 1 }); }
  }
  if (on) out.push({ te, pe, tx: T1, px: M15[M15.length - 1].c, w: 1 });
  return out;
}
/** 시각 t 에 BTC_TREND 가 보유 중인가 (직전 일 경계의 결정) */
const TS50 = trendState(50);
const trendOnAt = (t: number) => TS50.get(Math.floor(t / DAY) * DAY) ?? false;

const mode = process.argv[2] || 'base';

if (mode === 'base') {
  console.log(`데이터 ${new Date(M15[0].ts).toISOString().slice(0, 10)} ~ ${new Date(T1).toISOString().slice(0, 16)} · 15m ${M15.length}봉 · 평가 시작 ${new Date(T0).toISOString().slice(0, 10)}`);
  HDR();
  show('BTC 보유', [{ te: T0, pe: pxAt(T0), tx: T1, px: M15[M15.length - 1].c, w: 1 }]);
  for (const N of [20, 50, 100]) show(`BTC_TREND SMA${N} (09:02 실행)`, trendTrades(N));
}

// ── 3. 시간대 · 요일 · BTC_TREND 실행시각/경계 ──
if (mode === 'tod' || mode === 'exec') {
  if (mode === 'tod') {
    console.log('KST 시간대별 1시간 수익 평균(bp) — IS 2021-04~2023 / OOS 2024~ · t값');
    const row = (filter: (b: B, i: number) => boolean, lab: string) => {
      const f = (a: number, b: number) => { const xs: number[] = []; for (let i = 1; i < H1.length; i++) { const b0 = H1[i]; if (b0.ts < a || b0.ts >= b) continue; if (!filter(b0, i)) continue; xs.push(H1[i].c / H1[i - 1].c - 1); }
        const m = xs.reduce((s, x) => s + x, 0) / xs.length; const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); return { m: 1e4 * m, t: m / (sd / Math.sqrt(xs.length)), n: xs.length }; };
      const a = f(T0, SPLIT), b = f(SPLIT, T1);
      console.log(`  ${lab.padEnd(12)} IS ${a.m.toFixed(1).padStart(6)}bp t${a.t.toFixed(1).padStart(5)}   OOS ${b.m.toFixed(1).padStart(6)}bp t${b.t.toFixed(1).padStart(5)}`);
      return [a.m, b.m];
    };
    const both: number[][] = [];
    for (let h = 0; h < 24; h++) both.push(row(b => new Date(b.ts + 9 * H + H).getUTCHours() === h, `${String(h).padStart(2, '0')}시 마감`));
    const isv = both.map(x => x[0]), oov = both.map(x => x[1]);
    const rk = (a: number[]) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); s.forEach((x, k) => r[x[1]] = k); return r; };
    const ra = rk(isv), rb = rk(oov); const n = 24; let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
    console.log(`  → 24시간대 IS·OOS 순위상관 ${(1 - 6 * d2 / (n * (n * n - 1))).toFixed(2)}`);
    console.log('요일(KST, 일 단위 09시→09시)');
    const dn = ['일', '월', '화', '수', '목', '금', '토'];
    for (let w = 0; w < 7; w++) {
      const f = (a: number, b: number) => { const xs: number[] = []; for (let i = 1; i < D1.length; i++) { if (D1[i].ts < a || D1[i].ts >= b) continue; if (new Date(D1[i].ts + 9 * H).getUTCDay() !== w) continue; xs.push(D1[i].c / D1[i - 1].c - 1); } const m = xs.reduce((s, x) => s + x, 0) / xs.length; const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); return `${(1e4 * m).toFixed(0).padStart(5)}bp t${(m / (sd / Math.sqrt(xs.length))).toFixed(1).padStart(5)}`; };
      console.log(`  ${dn[w]}  IS ${f(T0, SPLIT)}   OOS ${f(SPLIT, T1)}`);
    }
    console.log('미국장 개장 전후: KST 22~24시(서머타임 21:30) 보유 vs 다른 시간 — 아래 시간대 표에서 읽는다');
  }
  if (mode === 'exec') {
    console.log('BTC_TREND SMA50 — 일봉 경계(UTC 기준 시각)·실행 지연 민감도. 경계 0 = KST 09시(업비트 일봉).');
    HDR();
    for (const bh of [0, 4, 8, 12, 16, 20]) show(`경계 UTC${String(bh).padStart(2, '0')} (KST ${String((bh + 9) % 24).padStart(2, '0')}시)`, trendTrades(50, bh * H, 2));
    console.log('경계 24개 전부 — IS(~2023)/OOS(2024~) eq17');
    const v: Array<[number, number, number]> = [];
    for (let bh = 0; bh < 24; bh++) { const tr = trendTrades(50, bh * H, 2); v.push([bh, eq17(series(tr, T0, SPLIT)).ret, eq17(series(tr, SPLIT, T1)).ret]); }
    for (const [bh, a, b] of v) console.log(`  KST ${String((bh + 9) % 24).padStart(2, '0')}시 경계  IS ${P(a).padStart(6)}  OOS ${P(b).padStart(6)}`);
    const is = v.map(x => x[1]), oo = v.map(x => x[2]); const mi = is.reduce((a, b) => a + b, 0) / 24, mo = oo.reduce((a, b) => a + b, 0) / 24;
    let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < 24; k++) { sxy += (is[k] - mi) * (oo[k] - mo); sxx += (is[k] - mi) ** 2; syy += (oo[k] - mo) ** 2; }
    console.log(`  IS·OOS 상관 ${(sxy / Math.sqrt(sxx * syy)).toFixed(2)} · IS 범위 ${P(Math.min(...is))}~${P(Math.max(...is))} · OOS 범위 ${P(Math.min(...oo))}~${P(Math.max(...oo))} · KST09 IS ${P(is[0])} OOS ${P(oo[0])}`);
    console.log('실행 지연 (경계 KST 09시 고정)');
    for (const m of [2, 30, 60, 120, 240, 480, 720]) show(`실행 +${m}분`, trendTrades(50, 0, m));
  }
}

// ── 1. 상승추세 내 눌림 매수 오버레이 ──
function rsi(c: number[], i: number, n = 14) { if (i < n) return 50; let g = 0, l = 0; for (let j = i - n + 1; j <= i; j++) { const d = c[j] - c[j - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
function smaArr(c: number[], i: number, n: number) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; }
function sdArr(c: number[], i: number, n: number) { const m = smaArr(c, i, n); let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - m) ** 2; return Math.sqrt(s / n); }
interface DipCfg { sig: 'rsi' | 'bb' | 'drop'; p: number; exit: 'rsi50' | 'sma20' | 'tp'; tp?: number; maxBars: number; pen?: number; onlyTrend?: boolean }
function dipTrades(cfg: DipCfg, bars = H4, step = FOUR, placeboSeed = 0): Trade[] {
  const c = bars.map(b => b.c); const out: Trade[] = []; let pos: { te: number; pe: number; i: number } | null = null;
  let seed = placeboSeed; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sigs: number[] = [];
  const isSig = (i: number) => cfg.sig === 'rsi' ? rsi(c, i) < cfg.p : cfg.sig === 'bb' ? c[i] < smaArr(c, i, 20) - cfg.p * sdArr(c, i, 20) : c[i] / c[i - 6] - 1 <= -cfg.p / 100;
  // 플라시보용: 실제 신호 수를 먼저 센다
  let nSig = 0, nElig = 0;
  if (placeboSeed) for (let i = 30; i < bars.length - 1; i++) { const t = bars[i].ts + step; if (t < T0) continue; if (cfg.onlyTrend !== false && !trendOnAt(t)) continue; nElig++; if (isSig(i)) nSig++; }
  const pr = placeboSeed ? nSig / Math.max(nElig, 1) : 0;
  for (let i = 30; i < bars.length - 1; i++) {
    const t = bars[i].ts + step;   // 봉 마감 = 판단 시각
    if (t < T0) continue;
    if (pos) {
      const held = i - pos.i; let exitPx = 0, lim = false, tx = t;
      if (cfg.exit === 'tp') {
        // 진입 이후 15m 경로에서 TP 지정가 (관통 요구)
        const tgt = pos.pe * (1 + cfg.tp! / 100);
        for (let tt = Math.max(pos.te + Q, bars[i].ts); tt < t; tt += Q) { const j = I15.get(tt); if (j !== undefined && M15[j].h >= tgt * (1 + (cfg.pen ?? 0.0005))) { exitPx = tgt; lim = true; tx = tt; break; } }
      } else if (cfg.exit === 'rsi50' ? rsi(c, i) > 50 : c[i] > smaArr(c, i, 20)) { exitPx = pxAt(t); }
      if (!exitPx && (held >= cfg.maxBars || (cfg.onlyTrend !== false && !trendOnAt(t)))) exitPx = pxAt(t);
      if (exitPx) { out.push({ te: pos.te, pe: pos.pe, tx, px: exitPx, w: 1, exitLimit: lim }); pos = null; }
    }
    if (!pos) {
      if (cfg.onlyTrend !== false && !trendOnAt(t)) continue;
      const go = placeboSeed ? rnd() < pr : isSig(i);
      if (go) { pos = { te: t, pe: pxAt(t), i }; sigs.push(t); }
    }
  }
  return out;
}
if (mode === 'dip') {
  HDR();
  const trend = trendTrades(50); const rT = series(trend); const eT = eq17(rT);
  show('BTC_TREND SMA50 (기준)', trend);
  const cfgs: Array<[string, DipCfg]> = [];
  for (const p of [25, 30, 35]) cfgs.push([`RSI4h<${p} → RSI>50`, { sig: 'rsi', p, exit: 'rsi50', maxBars: 18 }]);
  for (const p of [1.5, 2, 2.5]) cfgs.push([`BB(20,${p})하단 → SMA20`, { sig: 'bb', p, exit: 'sma20', maxBars: 18 }]);
  for (const p of [3, 5, 7]) cfgs.push([`1일 −${p}% → SMA20`, { sig: 'drop', p, exit: 'sma20', maxBars: 18 }]);
  for (const tp of [2, 3, 5]) cfgs.push([`RSI4h<30 → TP+${tp}% 지정가`, { sig: 'rsi', p: 30, exit: 'tp', tp, maxBars: 18 }]);
  for (const tp of [2, 3, 5]) cfgs.push([`1일 −5% → TP+${tp}% 지정가`, { sig: 'drop', p: 5, exit: 'tp', tp, maxBars: 18 }]);
  const res: Array<[string, DipCfg, Float64Array]> = [];
  console.log('── 단독 (추세 ON 국면에서만, 1h 마크) ──');
  for (const [lab, c] of cfgs) { const tr = dipTrades(c); const o = show(lab, tr); res.push([lab, c, o.r]); }
  console.log('── 추세 OFF 국면에서도 (대조) ──');
  for (const [lab, c] of cfgs.slice(0, 1).concat(cfgs.slice(6, 7))) show(lab + ' [전 국면]', dipTrades({ ...c, onlyTrend: false }));
  console.log('── 플라시보 (같은 국면·같은 빈도 무작위 진입, 같은 청산) 20시드 eq17 ──');
  for (const [lab, c] of cfgs.filter((_, k) => [1, 4, 7, 10, 13].includes(k))) {
    const real = eq17(series(dipTrades(c))).ret; const pl: number[] = [];
    for (let s = 1; s <= 20; s++) pl.push(eq17(series(dipTrades(c, H4, FOUR, s * 7919 + 1))).ret);
    pl.sort((a, b) => a - b);
    console.log(`  ${lab.padEnd(30)} 실제 ${P(real).padStart(6)}  플라시보 중앙 ${P(pl[10]).padStart(6)} 최대 ${P(pl[19]).padStart(6)}  초과 ${pl.filter(x => x >= real).length}/20`);
  }
  console.log('── 합성: a×추세 + b×눌림 (a+b≤1), MDD 17% 에서 최대 총익 ──');
  console.log(`  추세 단독 eq17 ${P(eT.ret)} (f ${eT.f.toFixed(2)})`);
  for (const [lab, , rD] of res) {
    let best = { ret: -1e9, a: 0, b: 0 };
    for (let a = 0; a <= 1.0001; a += 0.05) for (let b = 0; a + b <= 1.0001; b += 0.05) {
      const n = Math.min(rT.length, rD.length); const r = new Float64Array(n); for (let k = 0; k < n; k++) r[k] = a * rT[k] + b * rD[k];
      const s = stats(r); if (s.mdd <= 17 && s.ret > best.ret) best = { ret: s.ret, a, b };
    }
    let cc = 0; { const n = Math.min(rT.length, rD.length); let mt = 0, md = 0; for (let k = 0; k < n; k++) { mt += rT[k]; md += rD[k]; } mt /= n; md /= n; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < n; k++) { sxy += (rT[k] - mt) * (rD[k] - md); sxx += (rT[k] - mt) ** 2; syy += (rD[k] - md) ** 2; } cc = sxy / Math.sqrt(sxx * syy); }
    console.log(`  ${lab.padEnd(30)} 합성 ${P(best.ret).padStart(7)} (추세 ${best.a.toFixed(2)} + 눌림 ${best.b.toFixed(2)}) · 상관 ${cc.toFixed(2)}`);
  }
  console.log('── 워크포워드: IS(~2023)에서 단독 eq17 최고 설정 → OOS(2024~) ──');
  { let best = { lab: '', c: cfgs[0][1], v: -1e9 };
    for (const [lab, c] of cfgs) { const v = eq17(series(dipTrades(c), T0, SPLIT)).ret; if (v > best.v) best = { lab, c, v }; }
    const oos = eq17(series(dipTrades(best.c), SPLIT, T1)).ret;
    const all = cfgs.map(([, c]) => eq17(series(dipTrades(c), SPLIT, T1)).ret).sort((a, b) => a - b);
    console.log(`  IS 최고 ${best.lab} (IS ${P(best.v)}) → OOS ${P(oos)} · OOS 격자 중앙 ${P(all[Math.floor(all.length / 2)])} · 추세 OOS ${P(eq17(series(trend, SPLIT, T1)).ret)} · 보유 OOS ${P(eq17(series([{ te: SPLIT, pe: pxAt(SPLIT), tx: T1, px: M15[M15.length - 1].c, w: 1 }], SPLIT, T1)).ret)}`); }
  console.log('── 비용 스트레스 (상위 3설정) ──');
  const top = res.map(([lab, c, r]) => ({ lab, c, v: eq17(r).ret })).sort((a, b) => b.v - a.v).slice(0, 3);
  for (const t of top) { const o: string[] = []; for (const m of [1, 2, 4]) { FEE = 0.0005 * m; SLIP = 0.0002 * m; o.push(`×${m} ${P(eq17(series(dipTrades(t.c))).ret)}`); } FEE = 0.0005; SLIP = 0.0002; console.log(`  ${t.lab.padEnd(30)} ${o.join('  ')}`); }
  console.log('── TP 지정가 관통 0.2% 스트레스 ──');
  for (const [lab, c] of cfgs.filter(([, c]) => c.exit === 'tp')) show(lab + ' pen0.2', dipTrades({ ...c, pen: 0.002 }));
}

// ── 2. 지정가 그리드 ──
interface GridCfg { x: number; y: number; T: number; reset: number; pen: number; regime: 'off' | 'on' | 'all'; tpDelay?: number }
function gridTrades(g: GridCfg): Trade[] {
  const out: Trade[] = []; let pos: { te: number; pe: number } | null = null; let order: { lim: number; until: number } | null = null;
  for (let k = 0; k < M15.length; k++) {
    const b = M15[k]; if (b.ts < T0) continue;
    const reg = trendOnAt(b.ts); const ok = g.regime === 'all' || (g.regime === 'on' ? reg : !reg);
    if (pos) {
      const tgt = pos.pe * (1 + g.y / 100);
      const tpOn = g.tpDelay ? Math.floor(pos.te / (g.tpDelay * H)) * (g.tpDelay * H) + g.tpDelay * H : pos.te + 1;   // 실운영: 체결을 다음 tick 에 알아채고 TP 를 건다
      if (b.ts >= tpOn && b.h >= tgt * (1 + g.pen)) { out.push({ te: pos.te, pe: pos.pe, tx: b.ts, px: tgt, w: 1, entryLimit: true, exitLimit: true }); pos = null; }
      else if (b.ts - pos.te >= g.T * H) { out.push({ te: pos.te, pe: pos.pe, tx: b.ts, px: b.o, w: 1, entryLimit: true }); pos = null; }
      continue;
    }
    // 주문 갱신: reset 시각마다 직전 종가 기준 재호가
    if (b.ts % (g.reset * H) === 0) { order = ok ? { lim: M15[k - 1].c * (1 - g.x / 100), until: b.ts + g.reset * H } : null; }
    if (order && b.ts < order.until && b.l <= order.lim * (1 - g.pen)) { pos = { te: b.ts, pe: order.lim }; order = null; }
  }
  return out;
}
if (mode === 'grid') {
  HDR();
  show('BTC_TREND SMA50 (기준)', trendTrades(50));
  const rows: Array<{ g: GridCfg; is: number; oos: number; all: number }> = [];
  for (const regime of ['off', 'all'] as const) {
    console.log(`── 국면 ${regime === 'off' ? '추세 OFF(박스권)' : '전 국면'} · 관통 0.05% ──`);
    for (const x of [1, 2, 3, 5]) for (const y of [1, 2, 3]) for (const T of [24, 72]) {
      const g: GridCfg = { x, y, T, reset: 4, pen: 0.0005, regime }; const tr = gridTrades(g);
      const o = show(`−${x}% 매수 / +${y}% 매도 / ${T}h`, tr);
      rows.push({ g, is: eq17(series(tr, T0, SPLIT)).ret, oos: eq17(series(tr, SPLIT, T1)).ret, all: o.e.ret });
    }
  }
  console.log('── 관통 0.2% 스트레스 (상위 6칸) ──');
  for (const r of rows.slice().sort((a, b) => b.all - a.all).slice(0, 6)) show(`−${r.g.x}/+${r.g.y}/${r.g.T}h [${r.g.regime}] pen0.2`, gridTrades({ ...r.g, pen: 0.002 }));
  console.log('── 워크포워드 ──');
  for (const regime of ['off', 'all']) { const rr = rows.filter(r => r.g.regime === regime); const b = rr.slice().sort((a, c) => c.is - a.is)[0]; const med = rr.map(r => r.oos).sort((a, c) => a - c)[Math.floor(rr.length / 2)];
    console.log(`  [${regime}] IS 최고 −${b.g.x}/+${b.g.y}/${b.g.T}h IS ${P(b.is)} → OOS ${P(b.oos)} · OOS 격자 중앙 ${P(med)} · IS·OOS 둘 다 양수 ${rr.filter(r => r.is > 0 && r.oos > 0).length}/${rr.length}`); }
}

// ── 4. 변동성 돌파 (BTC 단독) ──
interface VboCfg { k: number; exec: 'fast' | 'poll'; filt: 'none' | 'trend' | 'ma5'; exitH: number }
function vboTrades(v: VboCfg): Trade[] {
  const out: Trade[] = [];
  for (let d = 5; d < D1.length - 1; d++) {
    const day = D1[d]; if (day.ts < T0) continue;
    const prev = D1[d - 1]; const tgt = day.o + v.k * (prev.h - prev.l);
    if (v.filt === 'trend' && !trendOnAt(day.ts)) continue;
    if (v.filt === 'ma5') { let s = 0; for (let j = d - 5; j < d; j++) s += D1[j].c; if (day.o < s / 5) continue; }
    const end = day.ts + v.exitH * H;
    for (let t = day.ts; t < Math.min(end, day.ts + DAY); t += Q) {
      const j = I15.get(t); if (j === undefined) continue; const b = M15[j];
      if (b.h >= tgt) {
        // fast = 실시간 감시(웹소켓) 후 시장가: 돌파가 + 0.05% 관통(BTC 1분 p90 움직임 6bp) / poll = 15m 봉 마감 후 다음 봉 시가
        const te = v.exec === 'fast' ? t : t + Q; const pe = v.exec === 'fast' ? Math.max(tgt, b.o) * 1.0005 : pxAt(t + Q);
        if (te >= end) break;
        out.push({ te, pe, tx: end, px: pxAt(end), w: 1 });
        break;
      }
    }
  }
  return out;
}
if (mode === 'vbo') {
  HDR();
  show('BTC 보유', [{ te: T0, pe: pxAt(T0), tx: T1, px: M15[M15.length - 1].c, w: 1 }]);
  show('BTC_TREND SMA50', trendTrades(50));
  const rows: Array<{ lab: string; v: VboCfg; is: number; oos: number; all: number }> = [];
  for (const filt of ['none', 'ma5', 'trend'] as const) for (const exec of ['fast', 'poll'] as const) {
    console.log(`── 필터 ${filt} · 체결 ${exec === 'fast' ? '실시간 감시(+0.05%)' : '15분 폴링(다음 봉 시가)'} · 다음날 09시 청산 ──`);
    for (const k of [0.3, 0.4, 0.5, 0.6, 0.7]) { const v: VboCfg = { k, exec, filt, exitH: 24 }; const tr = vboTrades(v); const lab = `k=${k}`; const o = show(lab, tr);
      rows.push({ lab: `${filt}/${exec}/k${k}`, v, is: eq17(series(tr, T0, SPLIT)).ret, oos: eq17(series(tr, SPLIT, T1)).ret, all: o.e.ret }); }
  }
  console.log('── 워크포워드 (IS ~2023 최고 → OOS 2024~) ──');
  const b = rows.slice().sort((a, c) => c.is - a.is)[0]; const med = rows.map(r => r.oos).sort((a, c) => a - c)[Math.floor(rows.length / 2)];
  console.log(`  IS 최고 ${b.lab} IS ${P(b.is)} → OOS ${P(b.oos)} · OOS 격자 중앙 ${P(med)} · 추세 OOS ${P(eq17(series(trendTrades(50), SPLIT, T1)).ret)}`);
  console.log('── 비용 ×2·×4 (상위 3) ──');
  for (const r of rows.slice().sort((a, c) => c.all - a.all).slice(0, 3)) { const o: string[] = []; for (const m of [1, 2, 4]) { FEE = 0.0005 * m; SLIP = 0.0002 * m; o.push(`×${m} ${P(eq17(series(vboTrades(r.v))).ret)}`); } FEE = 0.0005; SLIP = 0.0002; console.log(`  ${r.lab.padEnd(22)} ${o.join('  ')}`); }
  console.log('── 합성: 추세 + 최고 VBO (a+b≤1, MDD17) ──');
  { const rT = series(trendTrades(50)); const top = rows.slice().sort((a, c) => c.all - a.all)[0]; const rV = series(vboTrades(top.v)); let best = { ret: -1e9, a: 0, b: 0 };
    for (let a = 0; a <= 1.0001; a += 0.05) for (let bb = 0; a + bb <= 1.0001; bb += 0.05) { const n = Math.min(rT.length, rV.length); const r = new Float64Array(n); for (let k = 0; k < n; k++) r[k] = a * rT[k] + bb * rV[k]; const s = stats(r); if (s.mdd <= 17 && s.ret > best.ret) best = { ret: s.ret, a, b: bb }; }
    console.log(`  ${top.lab}: 합성 ${P(best.ret)} (추세 ${best.a.toFixed(2)} + VBO ${best.b.toFixed(2)}) vs 추세 단독 ${P(eq17(rT).ret)}`); }
}

// ── 2b. 깊은 급락 흡수 반증 ──
if (mode === 'grid2') {
  HDR();
  const base: GridCfg = { x: 3, y: 3, T: 72, reset: 4, pen: 0.0005, regime: 'all' };
  show('기준 −3/+3/72h reset4h', gridTrades(base));
  console.log('── 고원: x × y (72h, reset 4h, pen 0.05%) eq17 / IS / OOS ──');
  for (const x of [2.5, 3, 3.5, 4, 4.5, 5, 6]) {
    const cells = [1.5, 2, 3, 4, 5].map(y => { const tr = gridTrades({ ...base, x, y }); return `+${y}:${P(eq17(series(tr)).ret).padStart(5)}(${P(eq17(series(tr, T0, SPLIT)).ret)}/${P(eq17(series(tr, SPLIT, T1)).ret)})`; });
    console.log(`  −${x}%  ${cells.join('  ')}`);
  }
  console.log('── 기준가 재설정 주기 · 보유시간 ──');
  for (const reset of [1, 2, 4, 8, 24]) for (const T of [24, 72, 168]) show(`reset ${reset}h · ${T}h`, gridTrades({ ...base, reset, T }));
  console.log('── 국면별 ──');
  for (const regime of ['on', 'off', 'all'] as const) show(`국면 ${regime}`, gridTrades({ ...base, regime }));
  console.log('── 관통·비용 스트레스 ──');
  for (const pen of [0.0005, 0.002, 0.005, 0.01]) show(`관통 ${pen * 100}%`, gridTrades({ ...base, pen }));
  for (const m of [2, 4]) { FEE = 0.0005 * m; SLIP = 0.0002 * m; show(`비용 ×${m}`, gridTrades(base)); } FEE = 0.0005; SLIP = 0.0002;
  console.log('── 집중도: 거래 손익 상위 날짜 / 잭나이프(상위 N일 거래 제거) ──');
  const tr = gridTrades(base);
  const pnl = (t: Trade) => t.px / t.pe - 1 - (t.exitLimit ? 0 : SLIP) - 2 * FEE;
  const byDay = new Map<string, number>(); for (const t of tr) { const d = new Date(t.te + 9 * H).toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + pnl(t)); }
  const top = [...byDay].sort((a, b) => b[1] - a[1]); const tot = top.reduce((a, x) => a + x[1], 0);
  console.log(`  거래 ${tr.length} · 고유일 ${byDay.size} · 합계 ${(100 * tot).toFixed(0)}%p · 상위5일 ${(100 * top.slice(0, 5).reduce((a, x) => a + x[1], 0)).toFixed(0)}%p`);
  console.log('  상위 8일: ' + top.slice(0, 8).map(([d, v]) => `${d} ${(100 * v).toFixed(1)}`).join(' · '));
  for (const k of [0, 3, 5, 10, 20]) { const drop = new Set(top.slice(0, k).map(x => x[0])); const t2 = tr.filter(t => !drop.has(new Date(t.te + 9 * H).toISOString().slice(0, 10))); const r = series(t2); console.log(`  상위 ${String(k).padStart(2)}일 제거 → eq17 ${P(eq17(r).ret).padStart(6)} · 거래당 ${(100 * t2.reduce((a, t) => a + pnl(t), 0) / t2.length).toFixed(2)}%`); }
  console.log('── 청산 사유 ──');
  const tp = tr.filter(t => t.exitLimit), tm = tr.filter(t => !t.exitLimit);
  console.log(`  TP ${tp.length}건 평균 ${(100 * tp.reduce((a, t) => a + pnl(t), 0) / tp.length).toFixed(2)}% · 시간청산 ${tm.length}건 평균 ${(100 * tm.reduce((a, t) => a + pnl(t), 0) / tm.length).toFixed(2)}% · 최악 ${(100 * Math.min(...tr.map(pnl))).toFixed(1)}%`);
  console.log('── 플라시보: 같은 날짜 수만큼 무작위 시각 시장가 매수 → 같은 TP/72h (20시드) ──');
  { const real = eq17(series(tr)).ret; const out: number[] = [];
    for (let s = 1; s <= 20; s++) { let seed = s * 7919 + 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const ts: Trade[] = []; let busyUntil = 0;
      for (let k = 0; k < tr.length * 3 && ts.length < tr.length; k++) { const t = Math.floor((T0 + rnd() * (T1 - T0 - 4 * DAY)) / Q) * Q; if (t < busyUntil) continue; const pe = pxAt(t); const tgt = pe * 1.03; let tx = t + 72 * H, px = pxAt(tx), lim = false;
        for (let tt = t + Q; tt < t + 72 * H; tt += Q) { const j = I15.get(tt); if (j !== undefined && M15[j].h >= tgt * 1.0005) { tx = tt; px = tgt; lim = true; break; } }
        ts.push({ te: t, pe, tx, px, w: 1, exitLimit: lim }); busyUntil = tx; }
      ts.sort((a, b) => a.te - b.te); out.push(eq17(series(ts)).ret); }
    out.sort((a, b) => a - b); console.log(`  실제 ${P(real)} · 플라시보 중앙 ${P(out[10])} 최대 ${P(out[19])} · 초과 ${out.filter(x => x >= real).length}/20`); }
  console.log('── 합성: 추세 + 급락흡수 (a+b≤1, MDD 17%) ──');
  { const rT = series(trendTrades(50)); const rG = series(tr); let best = { ret: -1e9, a: 0, b: 0 };
    for (let a = 0; a <= 1.0001; a += 0.05) for (let b = 0; a + b <= 1.0001; b += 0.05) { const n = Math.min(rT.length, rG.length); const r = new Float64Array(n); for (let k = 0; k < n; k++) r[k] = a * rT[k] + b * rG[k]; const s = stats(r); if (s.mdd <= 17 && s.ret > best.ret) best = { ret: s.ret, a, b }; }
    let cc: number; { const n = Math.min(rT.length, rG.length); let mt = 0, mg = 0; for (let k = 0; k < n; k++) { mt += rT[k]; mg += rG[k]; } mt /= n; mg /= n; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < n; k++) { sxy += (rT[k] - mt) * (rG[k] - mg); sxx += (rT[k] - mt) ** 2; syy += (rG[k] - mg) ** 2; } cc = sxy / Math.sqrt(sxx * syy); }
    console.log(`  추세 단독 ${P(eq17(rT).ret)} · 급락흡수 단독 ${P(eq17(rG).ret)} · 합성 ${P(best.ret)} (추세 ${best.a.toFixed(2)} + 흡수 ${best.b.toFixed(2)}) · 상관 ${cc.toFixed(2)}`);
    for (const [a, b] of [[0.25, 0.5], [0.3, 0.6], [0.2, 0.8]]) { const n = Math.min(rT.length, rG.length); const r = new Float64Array(n); for (let k = 0; k < n; k++) r[k] = a * rT[k] + b * rG[k]; const s = stats(r); const y = yearsOf(r, 1); console.log(`  고정 ${a}/${b}: ${P(s.ret)} MDD ${s.mdd.toFixed(0)}% |${YRS.map(yy => (y[yy] == null ? '' : P(y[yy])).padStart(6)).join('')}`); } }
}

if (mode === 'grid3') {
  HDR();
  const base: GridCfg = { x: 3, y: 3, T: 72, reset: 4, pen: 0.0005, regime: 'all' };
  for (const pen of [0.0005, 0.002]) for (const d of [0, 1, 4]) for (const [x, y] of [[3, 3], [4, 2], [5, 3], [4.5, 2]]) show(`−${x}/+${y} pen${pen * 100}% TP지연 ${d ? d + 'h tick' : '즉시'}`, gridTrades({ ...base, x, y, pen, tpDelay: d || undefined }));
}

// ── 2c. 1분봉으로 체결 현실성 확인 (업비트 API, 초당 4회 이하) ──
if (mode === 'fill1m') {
  (async () => {
    const { getUpbitClient } = await import('@/lib/upbit-client');
    const c = getUpbitClient(); const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const tr = gridTrades({ x: 3, y: 3, T: 72, reset: 4, pen: 0.002, regime: 'all' });
    const rows: Array<{ d: string; below: number; minutesBelow: number; lowVsLim: number }> = [];
    for (const t of tr) {
      for (;;) { const k = new Date(Date.now() + 9 * H); const h = k.getUTCHours(), m = k.getUTCMinutes(); if (!(([0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58) || ([1, 5, 9, 11, 13, 17, 21].includes(h) && m < 4))) break; await sleep(20000); }
      const to = new Date(t.te + Q).toISOString().slice(0, 19);
      let bars: any[] = [];
      for (let a = 0; a < 4; a++) { try { bars = await c.getCandlesMinutes(1, 'KRW-BTC', 15, to); break; } catch { await sleep(1500); } }
      const lim = t.pe; let below = 0, mins = 0, low = Infinity;
      for (const b of bars) { low = Math.min(low, b.low_price); if (b.low_price <= lim) { mins++; below += b.candle_acc_trade_price * Math.min(1, (lim - b.low_price) / Math.max(b.high_price - b.low_price, 1)); } }
      rows.push({ d: new Date(t.te + 9 * H).toISOString().slice(0, 16), below, minutesBelow: mins, lowVsLim: 100 * (low / lim - 1) });
      await sleep(280);
    }
    const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
    const bel = rows.map(r => r.below / 1e6), mins = rows.map(r => r.minutesBelow), dep = rows.map(r => r.lowVsLim);
    console.log(`체결 ${rows.length}건 (관통 0.2% 기준) — 지정가 아래에서 거래된 추정 원화(백만): p10 ${q(bel, .1).toFixed(0)} · p50 ${q(bel, .5).toFixed(0)} · p90 ${q(bel, .9).toFixed(0)}`);
    console.log(`지정가 아래 머문 1분봉 수: p10 ${q(mins, .1)} · p50 ${q(mins, .5)} · p90 ${q(mins, .9)} · 1분만 찍고 올라온 건 ${rows.filter(r => r.minutesBelow <= 1).length}건`);
    console.log(`1분 저가 vs 지정가: p50 ${q(dep, .5).toFixed(2)}% · p90 ${q(dep, .9).toFixed(2)}% (음수 = 지정가 아래로 내려감)`);
    console.log('최근 8건: ' + rows.slice(-8).map(r => `${r.d} ${(r.below / 1e6).toFixed(0)}M/${r.minutesBelow}분`).join(' · '));
    process.exit(0);
  })();
}
