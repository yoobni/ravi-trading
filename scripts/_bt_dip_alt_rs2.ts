/**
 * 축 ALT-3 심층: 'BTC 7일 ≤ −5% 일 때 BTC 대비 가장 덜 오른(더 빠진) 상위 알트 매수 + TP 지정가' — TP 의존성·관통·고원·전체 보고.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const dn7 = (k: number) => (i: number) => { const r = L.btcRet(i, 7); return r != null && r <= -k; };
const SC = new Map<string, L.Sig>();
const lag = (Lb: number, thr: number) => { const key = `${Lb}_${thr}`; if (!SC.has(key)) SC.set(key, L.memo((m, i) => { const r = L.ret(m, i, Lb), b = L.btcRet(i, Lb); if (r == null || b == null) return null; const s = r - b; return s <= -thr ? -s : null; })); return SC.get(key)!; };
const anyAlt = L.memo((m, i) => (L.ret(m, i, 1) != null ? Math.random() * 0 + (L.RANK[i].get(m) ?? 0) * -1 : null));
const out: string[] = [];
// 1) TP·관통·보유 스윕 (고정 1/3), 중심 L14 t0.15 N20 dn5%
const rows: string[] = ['tp pen H dnK | ret mdd sh n | IS OOS | 22H2 23 24H1 24H2 25 26'];
const allRet: number[] = [];
for (const tp of [6, 8, 10, 12, 15]) for (const pen of [0.002, 0.01]) for (const H of [5, 7, 10]) for (const k of [0.04, 0.05, 0.07]) {
  const c: L.PCfg = { sig: lag(14, 0.15), N: 20, K: 3, x: { tp, H, pen }, btcOk: dn7(k) };
  const r = L.port(c, 1 / 3, L.START), is = L.port(c, 1 / 3, L.START, L.SPLIT), oos = L.port(c, 1 / 3, L.SPLIT); allRet.push(r.ret);
  rows.push(`${tp} ${pen} ${H} ${k} | ${L.f0(r.ret)} ${r.mdd.toFixed(0)} ${r.sharpe.toFixed(2)} ${r.n} | ${L.f0(is.ret)} ${L.f0(oos.ret)} | ${L.PERIODS.slice(2).map(([, a, z]) => L.f1(L.periodRet(r.daily, a, z))).join(' ')}`);
}
out.push(`sweep 90 cells: median ret ${L.median(allRet).toFixed(0)}%, positive ${(100 * allRet.filter(x => x > 0).length / allRet.length).toFixed(0)}%`);
out.push(rows.join('\n'));
// 2) 같은 날(BTC 급락) · 같은 TP 로 '아무 상위 알트'(거래대금 순) / 무작위
out.push(L.fullReport('RS_LAG dn7(−5%) L14 t0.15 N20 tp10 H7', { sig: lag(14, 0.15), N: 20, K: 3, x: { tp: 10, H: 7 }, btcOk: dn7(0.05) }, { seeds: 40 }).L.join('\n'));
out.push(L.fullReport('RS_LAG same, pen 1%', { sig: lag(14, 0.15), N: 20, K: 3, x: { tp: 10, H: 7, pen: 0.01 }, btcOk: dn7(0.05) }, { seeds: 20 }).L.join('\n'));
out.push(L.fullReport('CONTROL dn7 any top-volume alt N20 tp10 H7', { sig: anyAlt, N: 20, K: 3, x: { tp: 10, H: 7 }, btcOk: dn7(0.05) }, { seeds: 20 }).L.join('\n'));
out.push(L.fullReport('RS_LAG from 2022-07', { sig: lag(14, 0.15), N: 20, K: 3, x: { tp: 10, H: 7 }, btcOk: dn7(0.05) }, { seeds: 20, from: Date.UTC(2022, 6, 1) }).L.join('\n'));
const C28 = new Set(['ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'].map(c => 'KRW-' + c));
const lagX = L.memo((m, i) => C28.has(m) ? null : lag(14, 0.15)(m, i));
out.push(L.fullReport('RS_LAG excl-28coins N30', { sig: lagX, N: 30, K: 3, x: { tp: 10, H: 7 }, btcOk: dn7(0.05) }, { seeds: 20 }).L.join('\n'));
// TP 체결 의존: TP 로 끝난 거래 비중과 TP 없을 때 같은 거래의 결과
const ev = L.events(lag(14, 0.15), 20, { tp: 10, H: 7 }, { from: L.START, btcOk: dn7(0.05) });
const evNo = L.events(lag(14, 0.15), 20, { tp: null, H: 7 }, { from: L.START, btcOk: dn7(0.05) });
out.push(`events tp10: ${JSON.stringify(L.evStats(ev))} | tp share ${(100 * ev.filter(e => e.kind === 'tp').length / ev.length).toFixed(0)}% | same entries no-TP H7: ${JSON.stringify(L.evStats(evNo))}`);
const yrs: Record<string, L.Ev[]> = {}; for (const e of ev) (yrs[new Date(e.ts).getUTCFullYear()] ??= []).push(e);
out.push('events by year: ' + Object.entries(yrs).map(([y, e]) => { const s = L.evStats(e); return `${y} n${s.n} ${s.mean.toFixed(2)}% win${s.win.toFixed(0)} t${s.t.toFixed(1)}`; }).join(' | '));
const days = new Set(ev.map(e => e.i)); out.push(`unique signal days ${days.size}`);
fs.writeFileSync(`${OUT}/rs2-report.txt`, out.join('\n\n'));
console.log('done');
