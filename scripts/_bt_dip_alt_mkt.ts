/**
 * 축 ALT-1b: '시장 투매일' 후 낙폭 상위 알트 매수 — cap 격자에서 유일하게 살아남은 변형의 심층 검증.
 * 투매일(i): 시점별 상위 30 알트 중 일간 수익 ≤ −x 인 비율 ≥ b.
 * 선택: L=그날 낙폭 최대 / R=무작위 / V=거래대금 최상위 / W=낙폭 최소 / BTC=BTC 만.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const out: string[] = [];
const C28 = new Set(['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'].map(c => 'KRW-' + c));
const breadth = (x: number) => { const brd = new Float64Array(L.TS.length); for (let i = 1; i < L.TS.length; i++) { let n = 0, d = 0; for (const [m, r] of L.ARANK[i]) { if (r >= 30) continue; const q = L.ret(m, i, 1); if (q == null) continue; n++; if (q <= -x / 100) d++; } brd[i] = n ? d / n : 0; } return brd; };
const BR = new Map<number, Float64Array>(); const br = (x: number) => { if (!BR.has(x)) BR.set(x, breadth(x)); return BR.get(x)!; };
const hash = (s: string, i: number) => { let h = i * 2654435761; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
function mk(x: number, b: number, sel: string, excl28 = false): L.Sig {
  const brd = br(x);
  return L.memo((m, i) => {
    if (brd[i] < b) return null; if (excl28 && C28.has(m)) return null;
    if (sel === 'BTC') return m === 'KRW-BTC' ? 1 : null; if (m === 'KRW-BTC') return null;
    const r = L.ret(m, i, 1); if (r == null) return null;
    if (sel === 'L') return -r; if (sel === 'W') return r; if (sel === 'R') return hash(m, i); if (sel === 'V') return -(L.RANK[i].get(m) ?? 999);
    return null;
  });
}
// 1) 투매일 목록
const days = (x: number, b: number) => L.TS.map((t, i) => [t, i] as [number, number]).filter(([t, i]) => t >= L.START && br(x)[i] >= b);
for (const [x, b] of [[5, 0.4], [7, 0.3], [7, 0.4], [7, 0.5], [10, 0.4]]) {
  const d = days(x, b); const per: Record<string, number> = {}; for (const [t] of d) { const y = new Date(t).getUTCFullYear(); per[y] = (per[y] ?? 0) + 1; }
  out.push(`panic days x${x} b${b}: ${d.length} ${JSON.stringify(per)} regime ${JSON.stringify(d.reduce((a: any, [, i]) => { a[String(L.REGIME[i])] = (a[String(L.REGIME[i])] ?? 0) + 1; return a; }, {}))}`);
}
out.push('x7 b0.4 days: ' + days(7, 0.4).map(([t]) => new Date(t).toISOString().slice(2, 10)).join(' '));
// 2) 격자(선택 방식 포함, 고정 1/3)
const cells: L.Cell[] = [];
for (const x of [5, 7, 10]) for (const b of [0.3, 0.4, 0.5]) for (const sel of ['L', 'R', 'V', 'W']) for (const N of [20, 30]) for (const [tp, H] of [[5, 3], [8, 5], [12, 7], [100, 3], [100, 5]] as [number, number][])
  cells.push({ key: `x${x}_b${b}_${sel}_N${N}_tp${tp}_H${H}`, params: { x, b, sel, N, tp, H }, c: { sig: mk(x, b, sel), N, K: 3, x: { tp: tp === 100 ? null : tp, H } } });
for (const x of [5, 7, 10]) for (const b of [0.3, 0.4, 0.5]) for (const [tp, H] of [[5, 3], [8, 5], [100, 3], [100, 5]] as [number, number][])
  cells.push({ key: `x${x}_b${b}_BTC_tp${tp}_H${H}`, params: { x, b, sel: 'BTC', N: 1, tp, H }, c: { sig: mk(x, b, 'BTC'), N: 1, K: 1, inclBTC: true, x: { tp: tp === 100 ? null : tp, H } } });
const rows = L.runGrid(cells);
fs.writeFileSync(`${OUT}/mkt-grid.tsv`, L.gridText(rows, ['x', 'b', 'sel', 'N', 'tp', 'H']));
for (const sel of ['L', 'R', 'V', 'W', 'BTC']) { const s = rows.filter(r => r.sel === sel); out.push(`sel ${sel}: cells ${s.length} medRet ${L.median(s.map(r => r.ret))} medSh ${L.median(s.map(r => r.sh))} medOOS ${L.median(s.map(r => r.oosRet))} OOS>0 ${(100 * s.filter(r => r.oosRet > 0).length / s.length).toFixed(0)}% med22h2 ${L.median(s.map(r => r.y22h2))} med23 ${L.median(s.map(r => r.y23))} med24 ${L.median(s.map(r => r.y24))} med25 ${L.median(s.map(r => r.y25))} med26 ${L.median(s.map(r => r.y26))}`); }
out.push('WF (L only): ' + JSON.stringify(L.wf(rows.filter(r => r.sel === 'L'))));
out.push('WF (all sel): ' + JSON.stringify(L.wf(rows)));
// 3) 대표 칸 전체 보고
const main: L.PCfg = { sig: mk(7, 0.4, 'L'), N: 20, K: 3, x: { tp: 8, H: 5 } };
const rep = L.fullReport('MKT_PANIC L x7 b0.4 N20 tp8 H5', main, { seeds: 40 }); out.push(rep.L.join('\n'));
out.push(L.fullReport('MKT_PANIC R(random pick same days) x7 b0.4 N20 tp8 H5', { ...main, sig: mk(7, 0.4, 'R') }, { seeds: 20 }).L.join('\n'));
out.push(L.fullReport('MKT_PANIC BTC x7 b0.4 tp8 H5', { sig: mk(7, 0.4, 'BTC'), N: 1, K: 1, inclBTC: true, x: { tp: 8, H: 5 } }, { seeds: 20 }).L.join('\n'));
out.push(L.fullReport('MKT_PANIC L excl-28coins x7 b0.4 N30 tp8 H5', { ...main, N: 30, sig: mk(7, 0.4, 'L', true) }, { seeds: 20 }).L.join('\n'));
// 2022-07~ 만 (브리프 기간)
out.push(L.fullReport('MKT_PANIC L from 2022-07', main, { seeds: 20, from: Date.UTC(2022, 6, 1) }).L.join('\n'));
// 4) 잭나이프: 기여 상위 투매일 제거
const ev = L.events(main.sig, 20, main.x, { from: L.START });
const byDay = new Map<number, number>(); for (const e of ev) byDay.set(e.i, (byDay.get(e.i) ?? 0) + e.rExec);
const ranked = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
for (const k of [5, 10, 20]) {
  const drop = new Set(ranked.slice(0, k).map(([i]) => i));
  const base = mk(7, 0.4, 'L'); const sig: L.Sig = (m, i) => drop.has(i) ? null : base(m, i);
  const r = L.port({ ...main, sig }, rep.sz); out.push(`jackknife drop top${k} days: ret ${L.f0(r.ret)}% MDD ${r.mdd.toFixed(0)}% OOS ${L.f0(L.port({ ...main, sig }, rep.sz, L.SPLIT).ret)}%  (dropped ${ranked.slice(0, k).map(([i]) => new Date(L.TS[i]).toISOString().slice(2, 10)).join(',')})`);
}
// 연도별 이벤트 통계
const yrs: Record<string, L.Ev[]> = {}; for (const e of ev) { const y = new Date(e.ts).getUTCFullYear(); (yrs[y] ??= []).push(e); }
out.push('events by year (top20, exec%): ' + Object.entries(yrs).map(([y, e]) => { const s = L.evStats(e); return `${y} n${s.n} mean ${s.mean.toFixed(2)} win ${s.win.toFixed(0)} t ${s.t.toFixed(1)}`; }).join(' | '));
// 5) 지연(시간 단위) 민감도: 진입가를 다음날 시가 대신 다음날 종가(=24h 지연)로
fs.writeFileSync(`${OUT}/mkt-report.txt`, out.join('\n\n'));
const series: Record<string, [number, number][]> = { MKT_PANIC: L.TS.map((t, i) => [t, rep.r.daily[i]] as [number, number]).filter(([, r]) => !Number.isNaN(r)) };
fs.writeFileSync(`${OUT}/mkt-daily-eq17.json`, JSON.stringify(series));
console.log('done');
