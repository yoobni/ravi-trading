/**
 * 축 ALT-2: 코인별 역프(업비트가 바이낸스보다 상대적으로 쌈) 회귀 — 시점별 유니버스 일봉.
 * '김프 단독'(시장 전체 김프 수준 필터)과 다름: 코인 단위 괴리.
 *   p_c(t)  = ln(업비트 KRW 종가 / 바이낸스 USDT 종가)   (두 거래소 일봉 경계 모두 00:00 UTC → 동시각 종가)
 *   rel     : rp_c = p_c − median_j p_j (그날 상위 50 알트 중 유효 코인) → 환율·시장 김프 상쇄, 코인 고유 괴리만
 *   raw     : p_c − ln(ECB USDKRW) (코인 자체 김프; 시장 성분 포함)
 *   z = (x_t − mean_{t−30..t−1}) / sd_{t−30..t−1}
 * 위생: 직전 30일 일수익 상관(업비트 vs 바이낸스) ≥ 0.7 (티커 충돌 제거), |30일 평균 rp| < 5%, 바이낸스 30일 평균 거래대금 ≥ $1M.
 * 신호(i 종가): z ≤ −Z & (x_t − mean) ≤ −gap. 진입 i+1 시가. 청산: z ≥ 0 (i 종가 판단 → 다음 시가) / H일 / TP 옵션.
 * 공지 필터: 신호 시각 이전 14일 안에 그 코인 '입출금·중단·네트워크·업그레이드·하드포크·점검·유의' 공지 → 제외.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/dip-2026-10/alt';
const BD = `${OUT}/binance-1d`;
const BIN = new Map<string, Float64Array>(), BQV = new Map<string, Float64Array>();
for (const f of fs.readdirSync(BD).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
  const c = f.slice(0, -5); const m = 'KRW-' + c; if (!L.G.has(m)) continue;
  const a = new Float64Array(L.TS.length).fill(NaN), q = new Float64Array(L.TS.length).fill(NaN);
  for (const k of JSON.parse(fs.readFileSync(`${BD}/${f}`, 'utf8'))) { const i = L.TI.get(k[0]); if (i != null) { a[i] = k[4]; q[i] = k[5]; } }
  BIN.set(m, a); BQV.set(m, q);
}
const FX: Record<string, number> = JSON.parse(fs.readFileSync('data/research-ext/fx-usdkrw.json', 'utf8'));
const fxArr = new Float64Array(L.TS.length).fill(NaN); { let last = NaN; for (let i = 0; i < L.TS.length; i++) { const d = new Date(L.TS[i]).toISOString().slice(0, 10); if (FX[d]) last = FX[d]; fxArr[i] = last; } }
// p_c
const P = new Map<string, Float64Array>();
for (const [m, b] of BIN) { const u = L.G.get(m)!; const p = new Float64Array(L.TS.length).fill(NaN); for (let i = 0; i < L.TS.length; i++) if (u[i] && b[i] > 0) p[i] = Math.log(u[i]!.close / b[i]); P.set(m, p); }
const MED = new Float64Array(L.TS.length).fill(NaN);
for (let i = 0; i < L.TS.length; i++) { const v: number[] = []; for (const [m, r] of L.ARANK[i]) { if (r >= 50) continue; const p = P.get(m)?.[i]; if (p != null && !Number.isNaN(p)) v.push(p); } if (v.length >= 8) MED[i] = L.median(v); }
const X: Record<string, Map<string, Float64Array>> = { rel: new Map(), raw: new Map() };
for (const [m, p] of P) {
  const r = new Float64Array(L.TS.length).fill(NaN), w = new Float64Array(L.TS.length).fill(NaN);
  for (let i = 0; i < L.TS.length; i++) { if (!Number.isNaN(MED[i])) r[i] = p[i] - MED[i]; if (!Number.isNaN(fxArr[i])) w[i] = p[i] - Math.log(fxArr[i]); }
  X.rel.set(m, r); X.raw.set(m, w);
}
// 위생 플래그
const OK = new Map<string, Uint8Array>();
for (const [m, b] of BIN) {
  const u = L.G.get(m)!; const ok = new Uint8Array(L.TS.length); const rp = X.rel.get(m)!; const qv = BQV.get(m)!;
  for (let i = 31; i < L.TS.length; i++) {
    const xs: number[] = [], ys: number[] = []; let s = 0, n = 0, q = 0, nq = 0;
    for (let j = i - 29; j <= i; j++) { if (u[j] && u[j - 1] && b[j] > 0 && b[j - 1] > 0) { xs.push(Math.log(u[j]!.close / u[j - 1]!.close)); ys.push(Math.log(b[j] / b[j - 1])); } if (!Number.isNaN(rp[j])) { s += rp[j]; n++; } if (!Number.isNaN(qv[j])) { q += qv[j]; nq++; } }
    if (xs.length < 25 || n < 25 || nq < 25) continue;
    const mx = xs.reduce((a, c) => a + c, 0) / xs.length, my = ys.reduce((a, c) => a + c, 0) / ys.length; let cv = 0, vx = 0, vy = 0; for (let k = 0; k < xs.length; k++) { cv += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; vy += (ys[k] - my) ** 2; }
    const corr = cv / Math.sqrt(vx * vy);
    if (corr >= 0.7 && Math.abs(s / n) < 0.05 && q / nq >= 1e6) ok[i] = 1;
  }
  OK.set(m, ok);
}
const zOf = (kind: string, m: string, i: number) => {
  const x = X[kind].get(m); if (!x || Number.isNaN(x[i])) return null; let s = 0, s2 = 0, n = 0;
  for (let j = i - 30; j < i; j++) { const v = x[j]; if (Number.isNaN(v)) continue; s += v; s2 += v * v; n++; }
  if (n < 25) return null; const mu = s / n, sd = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-12)); return { z: (x[i] - mu) / sd, dev: x[i] - mu };
};
// 공지
const ANN: { t: number; title: string }[] = JSON.parse(fs.readFileSync('data/research-ext/announcements.json', 'utf8')).map((a: any) => ({ t: Date.parse(a.first_listed_at || a.listed_at), title: a.title as string }));
const KW = /입출금|중단|네트워크|업그레이드|하드포크|점검|유의|출금|입금|지연/;
const annBy = new Map<string, number[]>();
for (const a of ANN) { if (!KW.test(a.title)) continue; for (const tk of a.title.match(/\(([A-Z0-9]{2,12})\)/g) ?? []) { const m = 'KRW-' + tk.slice(1, -1); if (!annBy.has(m)) annBy.set(m, []); annBy.get(m)!.push(a.t); } }
const annHit = (m: string, i: number, days = 14) => { const t1 = L.TS[i] + L.DAY; const t0 = t1 - days * L.DAY; return (annBy.get(m) ?? []).some(t => t >= t0 && t <= t1); };

const SIG = new Map<string, L.Sig>();
function sig(kind: string, Z: number, gap: number, ann: 'none' | 'excl' | 'only'): L.Sig {
  const k = `${kind}_${Z}_${gap}_${ann}`; if (SIG.has(k)) return SIG.get(k)!;
  const f = L.memo((m, i) => {
    if (!OK.get(m)?.[i]) return null; const r = zOf(kind, m, i); if (!r || r.z > -Z || r.dev > -gap / 100) return null;
    if (ann === 'excl' && annHit(m, i)) return null; if (ann === 'only' && !annHit(m, i)) return null;
    return -r.z;
  });
  SIG.set(k, f); return f;
}
const exitZ = (kind: string): L.Exit['exitSig'] => (m, i) => { const r = zOf(kind, m, i); return r != null && r.z >= 0; };
const out: string[] = [];
// 커버리지
{ let cov = 0, tot = 0; for (let i = L.TI.get(L.START)!; i < L.TS.length; i++) for (const [m, r] of L.ARANK[i]) { if (r >= 30) continue; tot++; if (OK.get(m)?.[i]) cov++; } out.push(`coverage: top30 alt coin-days with valid premium ${(100 * cov / tot).toFixed(0)}% (binance files ${BIN.size})`); }
const cells: L.Cell[] = [];
for (const kind of ['rel', 'raw']) for (const Z of [2, 2.5, 3]) for (const gap of [1, 2, 4]) for (const N of [30, 50]) for (const [tp, H] of [[null, 5], [null, 10], [5, 10]] as [number | null, number][])
  cells.push({ key: `${kind}_Z${Z}_g${gap}_N${N}_tp${tp}_H${H}`, params: { kind, Z, gap, N, tp: tp ?? '-', H }, c: { sig: sig(kind, Z, gap, 'excl'), N, K: 3, x: { tp, H, exitSig: exitZ(kind) } } });
const rows = L.runGrid(cells);
fs.writeFileSync(`${OUT}/prem-grid.tsv`, L.gridText(rows, ['kind', 'Z', 'gap', 'N', 'tp', 'H']));
for (const kind of ['rel', 'raw']) out.push(`${kind}: ` + JSON.stringify(L.wf(rows.filter(r => r.kind === kind))));
out.push('top by sharpe:\n' + L.gridText([...rows].sort((a, b) => b.sh - a.sh).slice(0, 10), ['kind', 'Z', 'gap', 'N', 'tp', 'H']));
// 공지 필터 효과: 이벤트 스터디
for (const kind of ['rel', 'raw']) for (const ann of ['none', 'excl', 'only'] as const) {
  const ev = L.events(sig(kind, 2.5, 2, ann), 50, { tp: null, H: 10, exitSig: exitZ(kind) }, { from: L.START });
  const s = L.evStats(ev); out.push(`events ${kind} Z2.5 gap2 ann=${ann}: n ${s.n} exec ${s.mean.toFixed(2)}% med ${s.med.toFixed(2)} win ${s.win.toFixed(0)}% cc ${s.cc.toFixed(2)} oo ${s.oo.toFixed(2)} t ${s.t.toFixed(1)}`);
}
for (const kind of ['rel', 'raw']) {
  const rep = L.fullReport(`PREM ${kind} Z2.5 gap2 N50 exit z≥0 / H10 (ann excl)`, { sig: sig(kind, 2.5, 2, 'excl'), N: 50, K: 3, x: { tp: null, H: 10, exitSig: exitZ(kind) } }, { seeds: 30 });
  out.push(rep.L.join('\n'));
}
fs.writeFileSync(`${OUT}/prem-report.txt`, out.join('\n\n'));
console.log('done');
