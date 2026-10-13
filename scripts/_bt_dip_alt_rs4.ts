/**
 * 축 ALT-3 보강: 라이브 '유의 공지 리스크 규칙'(paper-warning) 을 백테스트에 넣었을 때 — 지정·촉구·연장 ON ~ 해제 OFF 동안 진입 금지,
 * 보유 중 ON 이 뜨면 그날 종가 판단 → 다음 시가 청산(라이브는 10분 안에 청산하므로 이건 보수적).
 * 상폐 코인 자체는 데이터에 없으므로(생존편향) 이 규칙의 효과는 남아있는 코인에서만 보인다.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const ANN: any[] = JSON.parse(fs.readFileSync('data/research-ext/announcements.json', 'utf8'));
const ev = new Map<string, { t: number; on: boolean }[]>();
for (const a of ANN) { const t = a.title as string; let k: boolean | null = null; if (/유의 ?종목.*해제/.test(t)) k = false; else if (/유의 ?종목.*지정/.test(t) || /유의 ?촉구/.test(t)) k = true; if (k == null) continue;
  for (const m of t.matchAll(/\(([A-Z0-9]{2,15})\)/g)) { const mk = 'KRW-' + m[1]; if (!ev.has(mk)) ev.set(mk, []); ev.get(mk)!.push({ t: Date.parse(a.first_listed_at || a.listed_at), on: k }); } }
for (const v of ev.values()) v.sort((a, b) => a.t - b.t);
const blocked = (m: string, i: number) => { const v = ev.get(m); if (!v) return false; const tEnd = L.TS[i] + L.DAY; let s = false; for (const e of v) { if (e.t > tEnd) break; s = e.on; } return s; };
const dn7 = (i: number) => { const r = L.btcRet(i, 7); return r != null && r <= -0.05; };
const lag = L.memo((m, i) => { const r = L.ret(m, i, 14), b = L.btcRet(i, 14); if (r == null || b == null) return null; const s = r - b; return s <= -0.15 ? -s : null; });
const lagW = L.memo((m, i) => blocked(m, i) ? null : lag(m, i));
const base: L.PCfg = { sig: lag, N: 20, K: 3, x: { tp: 10, H: 7 }, btcOk: dn7 };
const warn: L.PCfg = { sig: lagW, N: 20, K: 3, x: { tp: 10, H: 7, exitSig: (m, i) => blocked(m, i) }, btcOk: dn7 };
const out: string[] = [];
const sz = L.sizeFor(base, 17, L.START);
for (const [nm, c] of [['base', base], ['with warning rule', warn]] as [string, L.PCfg][]) { const r = L.port(c, sz, L.START); out.push(`${nm}: ${L.summary('', r)} | from2022-07 ${L.f0(L.port(c, sz, Date.UTC(2022, 6, 1)).ret)}%`); }
const e0 = L.events(lag, 20, base.x, { from: L.START, btcOk: dn7 }); const hit = e0.filter(e => { for (let k = e.i; k <= e.exitK; k++) if (blocked(e.m, k)) return true; return false; });
out.push(`base events touching a warning period: ${hit.length}/${e0.length}: ` + hit.map(e => `${new Date(e.ts).toISOString().slice(0, 10)} ${e.m} ${(e.rExec * 100).toFixed(1)}%`).join(' | '));
fs.writeFileSync(`${OUT}/rs4-report.txt`, out.join('\n'));
console.log('done');
