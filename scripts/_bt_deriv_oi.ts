/**
 * 축 D-4: 바이낸스 메트릭(1h 샘플: OI·탑트레이더/전체 롱숏비율·테이커 비율) → 업비트 현물 (리서치 전용)
 * data/research-ext/binance/metrics/{C}.csv  time(UTC, 정시 행 = 그 시각 스냅샷, 공개는 +5분)
 * Part1: F6 신호 단위 · 4h 2022-06~ · 시장조정 3일 수익 5분위
 * Part2: 청산 캐스케이드 근사 이벤트(OI 급감 + 업비트 급락) · 15m 2024-10~ · 진입 = t+15분 봉 시가
 * Part3: 시장 전체 OI/롱숏 국면 → 동일가중 시장 3일 수익
 */
import fs from 'fs';
import path from 'path';
import { BARS, IDX, TS, FOUR, DAY, SPLIT, sigF6 } from './_bt_deriv_port';
const H = 3600e3, Q = 15 * 60e3;
interface Mrow { t: number; oi: number; oiv: number; topc: number; topp: number; ls: number; tk: number }
const MET = new Map<string, Mrow[]>(), MI = new Map<string, Map<number, number>>();
for (const c of BARS.keys()) {
  const f = path.resolve('data/research-ext/binance/metrics', c + '.csv'); if (!fs.existsSync(f)) continue;
  const rows: Mrow[] = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
    const p = l.split(','); if (p.length < 7) continue;
    const t = Date.parse(p[0].replace(' ', 'T') + 'Z'); const v = p.slice(1).map(Number);
    if (!Number.isFinite(t) || !(v[0] > 0)) continue;
    rows.push({ t, oi: v[0], oiv: v[1], topc: v[2], topp: v[3], ls: v[4], tk: v[5] });
  }
  rows.sort((a, b) => a.t - b.t); MET.set(c, rows); MI.set(c, new Map(rows.map((r, i) => [r.t, i])));
}
/** t 시각(정시) 공개분 기준 행 — 스냅샷 t 는 t+5분에 공개되므로 판단 시각 T 에선 floor((T−5분)/1h) 행 */
const rowAt = (c: string, T: number) => { const k = Math.floor((T - 5 * 60e3) / H) * H; const i = MI.get(c)?.get(k); return i === undefined ? null : i; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const P = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const mode = process.argv[2] || 'all';

if (mode === 'all' || mode === 'p1') {
  // 시장 3일 수익
  const mk = new Map<number, number>();
  for (const t of TS) { const r: number[] = []; for (const c of BARS.keys()) { const i = IDX.get(c)!.get(t); const b = BARS.get(c)!; if (i !== undefined && i + 17 < b.length) r.push(b[i + 17].close / b[i].open - 1); } if (r.length >= 10) mk.set(t, mean(r)); }
  interface S { t: number; ra: number; f: Record<string, number> }
  const S: S[] = [];
  for (const c of BARS.keys()) { const b = BARS.get(c)!; const m = MET.get(c); if (!m) continue;
    for (let i = 50; i < b.length - 19; i++) { if (!sigF6(c, i)) continue;
      // 판단 시각 = 신호봉 마감 + 5분 여유 → 진입은 다음 봉 시가 (기존 F6 와 동일)
      const T = b[i].ts + FOUR + 5 * 60e3; const k = rowAt(c, T); if (k == null || k < 24 * 90) continue;
      const mm = mk.get(b[i + 1].ts); if (mm == null) continue;
      const r = m[k], r24 = m[k - 24], r168 = m[k - 168];
      const lsHist = m.slice(k - 24 * 90, k).map(x => x.ls); const lsPct = lsHist.filter(x => x <= r.ls).length / lsHist.length;
      const tk24 = mean(m.slice(k - 23, k + 1).map(x => x.tk));
      S.push({ t: b[i].ts, ra: b[i + 18].close / b[i + 1].open - 1 - mm, f: {
        'OI 24h 변화': r.oi / r24.oi - 1, 'OI 7d 변화': r.oi / r168.oi - 1, '전체 롱숏(계정)': r.ls, '롱숏 자기90일 백분위': lsPct,
        '탑트레이더 포지션 롱숏': r.topp, '테이커 매수/매도 24h': tk24, 'OI/가격 괴리(OI24−가24)': (r.oi / r24.oi - 1) - (b[i].close / b[i - 6].close - 1) } });
    } }
  console.log(`Part1 F6 신호 ${S.length}건 (IS ${S.filter(s => s.t < SPLIT).length} / OOS ${S.filter(s => s.t >= SPLIT).length}) — 시장조정 3일 수익 5분위(1=낮음)`);
  for (const key of Object.keys(S[0].f)) {
    const row = (xs: S[]) => { const s = xs.slice().sort((a, b) => a.f[key] - b.f[key]); return Array.from({ length: 5 }, (_, j) => P(mean(s.slice(Math.floor(j * s.length / 5), Math.floor((j + 1) * s.length / 5)).map(x => x.ra))).padStart(8)).join(''); };
    console.log(`  ${key.padEnd(20)} IS ${row(S.filter(s => s.t < SPLIT))}   OOS ${row(S.filter(s => s.t >= SPLIT))}`);
  }
}

if (mode === 'all' || mode === 'p2') {
  // 15m 업비트
  const M15 = new Map<string, { ts: number; open: number; close: number; low: number; high: number }[]>(), I15 = new Map<string, Map<number, number>>();
  for (const c of BARS.keys()) { const f = fs.readdirSync('data/candle-cache').find(x => x.startsWith(`KRW-${c}_15m_`)); if (!f) continue; const b = JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')); M15.set(c, b); I15.set(c, new Map(b.map((x: any, i: number) => [x.ts, i]))); }
  const pxAt = (c: string, t: number) => { const i = I15.get(c)?.get(Math.floor(t / Q) * Q); return i === undefined ? null : M15.get(c)![i].open; };
  // 시장(동일가중) 수익 at (t, h)
  const coins = [...M15.keys()];
  const mret = (t0: number, h: number) => { const r: number[] = []; for (const c of coins) { const a = pxAt(c, t0), b = pxAt(c, t0 + h); if (a && b) r.push(b / a - 1); } return r.length >= 10 ? mean(r) : null; };
  interface E { c: string; t: number; r: Record<string, number>; a: Record<string, number> }
  const HZ: Array<[string, number]> = [['1h', H], ['4h', 4 * H], ['1d', DAY], ['3d', 3 * DAY]];
  const runEv = (lab: string, cond: (c: string, k: number, m: Mrow[], T: number) => boolean) => {
    const ev: E[] = []; const last = new Map<string, number>();
    for (const c of coins) { const m = MET.get(c); if (!m) continue;
      for (let k = 168; k < m.length; k++) { const T = m[k].t + 5 * 60e3; if (T < Date.UTC(2024, 9, 2)) continue;
        if (!cond(c, k, m, T)) continue; if ((last.get(c) ?? 0) > T - DAY) continue; last.set(c, T);
        const e0 = Math.ceil(T / Q) * Q; const p0 = pxAt(c, e0); if (!p0) continue;
        const r: Record<string, number> = {}, a: Record<string, number> = {}; let ok = true;
        for (const [hl, h] of HZ) { const p1 = pxAt(c, e0 + h); const mr = mret(e0, h); if (!p1 || mr == null) { ok = false; break; } r[hl] = p1 / p0 - 1; a[hl] = r[hl] - mr; }
        if (ok) ev.push({ c, t: T, r, a }); } }
    const half = Date.UTC(2025, 9, 1);
    const days = new Map<number, number>(); for (const e of ev) { const d = Math.floor(e.t / DAY); days.set(d, (days.get(d) ?? 0) + 1); }
    const top = [...days.values()].sort((a, b) => b - a); const top5 = top.slice(0, 5).reduce((a, b) => a + b, 0);
    const fmt = (xs: E[]) => HZ.map(([hl]) => `${hl} ${P(mean(xs.map(e => e.r[hl])))}/${P(mean(xs.map(e => e.a[hl])))}`).join('  ');
    console.log(`  ${lab}  [고유일 ${days.size} · 상위5일에 ${(100 * top5 / Math.max(ev.length, 1)).toFixed(0)}%]\n     전반 n=${String(ev.filter(e => e.t < half).length).padStart(4)}  ${fmt(ev.filter(e => e.t < half))}\n     후반 n=${String(ev.filter(e => e.t >= half).length).padStart(4)}  ${fmt(ev.filter(e => e.t >= half))}`);
  };
  console.log('\nPart2 이벤트 스터디 (15m 업비트, 2024-10~, 진입 t+15분 시가, 코인당 하루 1회) — 원수익/시장조정');
  const up = (c: string, T: number, h: number) => { const a = pxAt(c, T - h), b = pxAt(c, T); return a && b ? b / a - 1 : null; };
  for (const [k1, y] of [[0.05, 0.03], [0.08, 0.05], [0.12, 0.07]] as Array<[number, number]>) {
    runEv(`청산근사: OI 4h ≤ −${k1 * 100}% & 업비트 4h ≤ −${y * 100}%`, (c, k, m, T) => { const d = m[k].oi / m[k - 4].oi - 1; if (d > -k1) return false; const pr = up(c, T, 4 * H); return pr != null && pr <= -y; });
  }
  if (process.argv[3] === 'ctrl') {
    for (const y of [0.03, 0.05]) {
      runEv(`대조: 업비트 4h ≤ −${y * 100}% (OI 무관)`, (c, k, m, T) => { const pr = up(c, T, 4 * H); return pr != null && pr <= -y; });
      runEv(`대조: 업비트 4h ≤ −${y * 100}% & OI 4h ≥ −1% (청산 없음)`, (c, k, m, T) => { const d = m[k].oi / m[k - 4].oi - 1; if (d < -0.01) return false; const pr = up(c, T, 4 * H); return pr != null && pr <= -y; });
      runEv(`본건: 업비트 4h ≤ −${y * 100}% & OI 4h ≤ −${y === 0.03 ? 5 : 8}%`, (c, k, m, T) => { const d = m[k].oi / m[k - 4].oi - 1; if (d > -(y === 0.03 ? 0.05 : 0.08)) return false; const pr = up(c, T, 4 * H); return pr != null && pr <= -y; });
    }
    runEv('대조: 업비트 1h ≤ −2% (OI 무관)', (c, k, m, T) => { const pr = up(c, T, H); return pr != null && pr <= -0.02; });
    runEv('대조: 업비트 1h ≤ −2% & OI 1h ≥ −1%', (c, k, m, T) => { const d = m[k].oi / m[k - 1].oi - 1; if (d < -0.01) return false; const pr = up(c, T, H); return pr != null && pr <= -0.02; });
    process.exit(0);
  }
  runEv('OI 1h ≤ −4% & 업비트 1h ≤ −2%', (c, k, m, T) => { const d = m[k].oi / m[k - 1].oi - 1; if (d > -0.04) return false; const pr = up(c, T, H); return pr != null && pr <= -0.02; });
  runEv('개인 숏 쏠림: 롱숏(계정) 자기 30일 최저', (c, k, m) => { let mn = Infinity; for (let j = k - 720; j < k; j++) if (j >= 0) mn = Math.min(mn, m[j].ls); return k >= 720 && m[k].ls < mn; });
  runEv('개인 롱 쏠림: 롱숏(계정) 자기 30일 최고', (c, k, m) => { let mx = -Infinity; for (let j = k - 720; j < k; j++) if (j >= 0) mx = Math.max(mx, m[j].ls); return k >= 720 && m[k].ls > mx; });
  runEv('OI 24h ≥ +30% & 업비트 24h ≥ +10% (과열)', (c, k, m, T) => { const d = m[k].oi / m[k - 24].oi - 1; if (d < 0.3) return false; const pr = up(c, T, DAY); return pr != null && pr >= 0.1; });
  runEv('테이커 매수 1h ≥ 2.0 (공격적 매수 폭발)', (c, k, m) => m[k].tk >= 2.0);
  runEv('대조: 무작위 (k % 97 == 0)', (c, k) => k % 97 === 0);
}

if (mode === 'all' || mode === 'p3') {
  console.log('\nPart3 시장 국면 — 코인 중앙값 지표 5분위 → 동일가중 시장 3일 수익 (4h 2022-06~)');
  const mk: Array<{ t: number; r: number; f: Record<string, number> }> = [];
  for (const t of TS.filter(x => x % DAY === 0)) {
    const r: number[] = [], oi7: number[] = [], ls: number[] = [], tk: number[] = [];
    for (const c of BARS.keys()) { const i = IDX.get(c)!.get(t); const b = BARS.get(c)!; const m = MET.get(c); const k = rowAt(c, t); if (i === undefined || i + 18 >= b.length || !m || k == null || k < 168) continue;
      r.push(b[i + 18].close / b[i + 1].open - 1); oi7.push(m[k].oi / m[k - 168].oi - 1); ls.push(m[k].ls); tk.push(mean(m.slice(k - 23, k + 1).map(x => x.tk))); }
    if (r.length < 10) continue; const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    mk.push({ t, r: mean(r), f: { '시장 OI 7d 변화': med(oi7), '시장 롱숏(계정)': med(ls), '시장 테이커 24h': med(tk) } });
  }
  for (const key of Object.keys(mk[0].f)) {
    const row = (xs: typeof mk) => { const s = xs.slice().sort((a, b) => a.f[key] - b.f[key]); return Array.from({ length: 5 }, (_, j) => P(mean(s.slice(Math.floor(j * s.length / 5), Math.floor((j + 1) * s.length / 5)).map(x => x.r))).padStart(8)).join(''); };
    console.log(`  ${key.padEnd(16)} IS ${row(mk.filter(s => s.t < SPLIT))}   OOS ${row(mk.filter(s => s.t >= SPLIT))}`);
  }
}
