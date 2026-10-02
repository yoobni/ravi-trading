/** 축 N 추가 반증: 진입가 실측, 집중도, 28코인 비교, BTC_TREND 합성 */
import fs from 'fs';
import { run, sizeFor, SIGS, TS, G, RANK, BTCON, START, SPLIT, YEARS, Y, btcTrend, type Cfg } from './_swing_daily';
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0) + '%';
const BASE: Cfg = { sig: 'breakout7', N: 20, K: 3, tp: 6, sl: null, H: 3, btcOn: true };
const DAY = 86400e3;
const mode = process.argv[2] || 'all';

// 신호 목록(유니버스 N20, BTC on) — 진입일 = 신호 다음날
const sigs: { m: string; j: number }[] = [];
for (let j = 60; j < TS.length - 1; j++) { if (TS[j] < START || !BTCON[j]) continue; for (const [m, r] of RANK[j]) { if (r >= 20) break; if (m !== 'KRW-BTC' && SIGS.breakout7(m, j) != null && G.get(m)![j + 1]) sigs.push({ m, j }); } }

if (mode === 'all' || mode === 'entry') {
  // (a) 1분 마이크로구조: 09:00 이후 1~5분 mid vs 일봉 시가
  const ms = fs.readdirSync('data/microstructure').filter(f => f.endsWith('.jsonl'));
  const mid = new Map<string, number>();   // `${m}|${ts분}` → mid
  for (const f of ms) for (const l of fs.readFileSync('data/microstructure/' + f, 'utf8').split('\n')) {
    if (!l) continue; try { const r = JSON.parse(l); const k = Math.floor(r.ts / 60000); const kst = new Date(r.ts + 9 * 3600e3); if (kst.getUTCHours() === 9 && kst.getUTCMinutes() <= 6) mid.set(`${r.m}|${k}`, r.mid); } catch { }
  }
  const diffs: number[] = [], diffsSig: number[] = [];
  for (const [m, a] of G) for (let i = 0; i < TS.length; i++) {
    const x = a[i]; if (!x || TS[i] < Date.UTC(2026, 7, 20)) continue;
    for (const dm of [2]) { const v = mid.get(`${m}|${TS[i] / 60000 + dm}`); if (v) { const d = (v / x.open - 1) * 100; diffs.push(d); if (sigs.some(s => s.m === m && s.j === i - 1)) diffsSig.push(d); } }
  }
  const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`09:02 mid vs 일봉 시가 (28코인, 2026-08-24~): n=${diffs.length} 평균 ${mean(diffs).toFixed(3)}% 중앙 ${q(diffs, .5).toFixed(3)}% p90 ${q(diffs, .9).toFixed(3)}% p10 ${q(diffs, .1).toFixed(3)}%`);
  console.log(`  그중 신호 다음날 진입 ${diffsSig.length}건: 평균 ${diffsSig.length ? mean(diffsSig).toFixed(3) : '-'}%`);
  // (b) 15분봉(28코인 2024-10~): 신호 다음날 09:00~09:15 봉의 (고+저+종)/3 vs 시가 — 첫 15분 안 체결 근사
  const d15 = new Map<string, Map<number, any>>();
  for (const f of fs.readdirSync('data/candle-cache').filter(f => f.includes('_15m_2024-10-01'))) { const m = f.split('_')[0]; d15.set(m, new Map(JSON.parse(fs.readFileSync('data/candle-cache/' + f, 'utf8')).map((b: any) => [b.ts, b]))); }
  const e15: number[] = [], eAll: number[] = [];
  for (const [m, mp] of d15) { const a = G.get(m); if (!a) continue; for (let i = 0; i < TS.length; i++) { const x = a[i]; const b = mp.get(TS[i]); if (!x || !b) continue; const d = ((b.high + b.low + b.close) / 3 / x.open - 1) * 100; eAll.push(d); if (sigs.some(s => s.m === m && s.j === i - 1)) e15.push(d); } }
  console.log(`첫 15분 평균가 vs 시가 (28코인 15m): 전체 n=${eAll.length} 평균 ${mean(eAll).toFixed(3)}% | 신호 다음날 n=${e15.length} 평균 ${mean(e15).toFixed(3)}% 중앙 ${q(e15, .5).toFixed(3)}% p90 ${q(e15, .9).toFixed(3)}%`);
}
if (mode === 'all' || mode === 'conc') {
  // 코인별·날짜별 기여: 신호마다 독립 거래(같은 청산)로 손익
  const per: { m: string; j: number; r: number }[] = [];
  for (const { m, j } of sigs) {
    const a = G.get(m)!; const i = j + 1; const ep = a[i]!.open * 1.003; const tgt = ep * 1.06; let r = 0;
    for (let k = 0; k <= 3; k++) { const x = a[i + k]; if (!x) break; if (x.high >= tgt * 1.002) { r = 0.06 - 0.001; break; } if (k === 3) { r = x.close * 0.997 / ep - 1 - 0.001; } }
    per.push({ m, j, r });
  }
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  console.log(`\n독립 거래 ${per.length}건 평균 ${(100 * sum(per.map(p => p.r)) / per.length).toFixed(2)}%`);
  const byCoin = new Map<string, number[]>(); for (const p of per) { if (!byCoin.has(p.m)) byCoin.set(p.m, []); byCoin.get(p.m)!.push(p.r); }
  const coins = [...byCoin].map(([m, v]) => [m, sum(v), v.length] as [string, number, number]).sort((a, b) => b[1] - a[1]);
  console.log(`코인 ${coins.length}개 · 상위5 기여: ${coins.slice(0, 5).map(c => `${c[0].slice(4)} ${(c[1] * 100).toFixed(0)}%p(${c[2]})`).join(', ')}`);
  for (const k of [0, 5, 10, 20]) { const ex = new Set(coins.slice(0, k).map(c => c[0])); const rest = per.filter(p => !ex.has(p.m)); console.log(`  상위 ${k}코인 제외: 거래당 ${(100 * sum(rest.map(p => p.r)) / rest.length).toFixed(2)}% (n=${rest.length})`); }
  const byDay = new Map<number, number>(); for (const p of per) byDay.set(p.j, (byDay.get(p.j) || 0) + p.r);
  const days = [...byDay].sort((a, b) => b[1] - a[1]);
  for (const k of [0, 10, 30]) { const ex = new Set(days.slice(0, k).map(d => d[0])); const rest = per.filter(p => !ex.has(p.j)); console.log(`  상위 ${k}일 제외: 거래당 ${(100 * sum(rest.map(p => p.r)) / rest.length).toFixed(2)}%`); }
  // 신규상장 효과: 상장 후 경과일
  const age = (m: string, j: number) => { const a = G.get(m)!; let k = 0; for (let t = 0; t <= j; t++) if (a[t]) k++; return k; };
  for (const [lo, hi] of [[30, 90], [90, 365], [365, 99999]]) { const g = per.filter(p => { const ag = age(p.m, p.j); return ag >= lo && ag < hi; }); console.log(`  상장 ${lo}~${hi}일: n=${g.length} 거래당 ${(100 * sum(g.map(p => p.r)) / Math.max(g.length, 1)).toFixed(2)}%`); }
}
if (mode === 'all' || mode === 'combo') {
  // 포트폴리오 일별 자산 → 상관·합성: run 을 일별 자산으로 다시 돌릴 수 없으므로 연도 단위 비교 + 같은 OOS 위험 맞춤
  const eqIn = (c: Cfg, from: number, to = Infinity) => { const s = sizeFor(c, from, to); return run(c, s, from, to).ret; };
  const btIn = (from: number, to = Infinity) => { let s = 0.02, h = 0.99; for (let k = 0; k < 16; k++) { const mid = (s + h) / 2; if (btcTrend(mid, from, to).mdd > 17) h = mid; else s = mid; } return btcTrend((s + h) / 2, from, to).ret; };
  console.log('\n구간별 MDD17 (각 구간 안에서 위험 맞춤): 알트스윙 N20 vs BTC_TREND');
  for (const [lab, a, b] of [['2019~22', START, SPLIT], ['2023~', SPLIT, Infinity], ['2024~', Y(2024), Infinity], ['2025~', Y(2025), Infinity]] as [string, number, number][])
    console.log(`  ${lab.padEnd(8)} 스윙 ${fmt(eqIn(BASE, a, b)).padStart(7)}  BTC_TREND ${fmt(btIn(a, b)).padStart(7)}`);
}
if (mode === 'all' || mode === 'fixed28') {
  const F28 = new Set(['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT']);
  // RANK 를 28코인 고정으로 치환한 복사본으로 비교
  const saved = RANK.map(r => new Map(r));
  for (let i = 0; i < RANK.length; i++) { const nm = new Map<string, number>(); let k = 0; for (const [m] of saved[i]) if (F28.has(m)) nm.set(m, k++); RANK[i] = nm; }
  const s = sizeFor({ ...BASE, N: 28 }); const r = run({ ...BASE, N: 28 }, s);
  console.log(`\n28코인 고정(사후 선택) N28: eq17 ${fmt(r.ret)} n${r.n} avg ${r.avg.toFixed(2)}% | OOS ${fmt(run({ ...BASE, N: 28 }, s, SPLIT).ret)}`);
  for (let i = 0; i < RANK.length; i++) RANK[i] = saved[i];
}
