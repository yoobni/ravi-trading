/**
 * AI 리스크 데스크 리서치(2026-10) — C: BTC 급락일 유형 분류 대리변수 (리서치 전용, API 호출 없음)
 * 급락일: 업비트 KRW-BTC 일봉(UTC00=KST09 경계) 종가/전일 종가 ≤ −5%, 2019~2026-10-02.
 * 동반 지표(그 날 봉 마감 t 시점까지 알 수 있는 것): 바이낸스 BTC 선물 OI 24h·7d 변화(2022-06~), 펀딩(직전 3회 평균, 2020~), USDT 프리미엄 24h 변화(2024-06~),
 *   S&P500 같은 날 수익·VIX 변화, BTC 거래대금 z(30일), 상위20 알트 중 BTC 보다 더 빠진 비율, 직전 30일 고점 대비 낙폭, 직전 7일 수익.
 * 대리 분류(사전 고정): LIQ = OI24h ≤ −7% (강제청산 동반) / MACRO = (LIQ 아님) & S&P ≤ −1.5% / OTHER. OI 없는 2019~2022-05 는 펀딩 기준(직전 펀딩 ≥ +0.03%/8h → LIQ-ish) 별도.
 * 라벨(알려진 구조적 사건, 날짜 범위로 매칭): COVID 2020-03-12, LUNA 2022-05-09~12, 3AC/Celsius 2022-06-13~18, FTX 2022-11-08~09, SVB 2023-03-09~10,
 *   엔캐리 2024-08-05, 관세 2025-02-03 / 2025-04-07, 바이비트 해킹+관세 2025-02-25~28 ; 청산형 라벨: 2021-04-18, 2021-05-19, 2021-12-04, 2023-08-17, 2024-03-05, 2025-10-10.
 * 이후 수익: 3·7·14일 종가 수익, 7일 내 최저가. BTC_DIP(4h −3% 지정가·+3% TP·72h, 관통 0.2%, 1포지션) 급락일 후 72h 내 진입 거래 수익, RS_LAG 거래(overlap-trades.json) 급락일 +3일 내 진입 수익.
 */
import fs from 'fs';
import * as L from './_bt_dip_alt_lib';
const OUT = 'data/research-ext/riskdesk-2026-10';
const DAY = 86400e3, H1 = 3600e3, H4 = 4 * H1;
const BTC = L.BTC; const TS = L.TS;
// OI
const OI = new Map<number, number>();
for (const l of fs.readFileSync('data/research-ext/binance/metrics/BTC.csv', 'utf8').split('\n').slice(1)) { const p = l.split(','); const t = Date.parse(p[0].replace(' ', 'T') + 'Z'); const v = +p[1]; if (Number.isFinite(t) && v > 0) OI.set(t, v); }
const oiAt = (t: number) => { for (let k = 0; k < 3; k++) { const v = OI.get(t - k * H1); if (v) return v; } return null; };
// funding [[ts, rate]]
const FUND: [number, number][] = JSON.parse(fs.readFileSync('data/research-ext/binance/funding/BTC.json', 'utf8')).map((x: number[]) => [Math.round(x[0] / 1e5) * 1e5, x[1]]);
const fundPre = (t: number) => { const xs = FUND.filter(f => f[0] <= t && f[0] > t - 24 * H1).map(f => f[1]); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
// USDT premium (4h) / fx
const U4: { ts: number; close: number }[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDT_240m.json', 'utf8'));
const UI = new Map(U4.map(x => [x.ts, x.close]));
const fxJ = JSON.parse(fs.readFileSync('data/research-ext/macro/yahoo-KRW=X.json', 'utf8')).chart.result[0]; const FX = new Map<number, number>(); fxJ.timestamp.forEach((t: number, i: number) => { const c = fxJ.indicators.quote[0].close[i]; if (c) FX.set(Math.floor(t / 86400) * DAY, c); });
const fxAt = (t: number) => { for (let k = 0; k < 7; k++) { const v = FX.get(Math.floor(t / DAY) * DAY - k * DAY); if (v) return v; } return null; };
const premAt = (t: number) => { const u = UI.get(t - H4) ?? UI.get(t - 2 * H4); const f = fxAt(t); return u && f ? u / f - 1 : null; };
// S&P / VIX
function yahoo(name: string) { const j = JSON.parse(fs.readFileSync(`data/research-ext/macro/yahoo-${name}.json`, 'utf8')).chart.result[0]; const q = j.indicators.quote[0]; const m = new Map<string, number>(); j.timestamp.forEach((t: number, i: number) => { if (q.close[i] != null) m.set(new Date((t + j.meta.gmtoffset) * 1000).toISOString().slice(0, 10), q.close[i]); }); return m; }
const SPX = yahoo('GSPC'), VIX = yahoo('VIX');
const dret = (m: Map<string, number>, d: string) => { const ks = [...m.keys()].sort(); const i = ks.indexOf(d); if (i <= 0) return null; return m.get(ks[i])! / m.get(ks[i - 1])! - 1; };
// 4h BTC
const B4: { ts: number; open: number; high: number; low: number; close: number }[] = JSON.parse(fs.readFileSync('data/candle-cache/KRW-BTC_240m_2022-06-10_2026-10-13.json', 'utf8')).sort((a: any, b: any) => a.ts - b.ts);
// BTC_DIP 1포지션 시뮬 (4h): 봉 i 마감 종가 c → 다음 봉에 c×0.97 지정가, 저가 ≤ 지정가×(1−0.002) 면 체결. TP +3% 는 체결 봉 다음 봉부터 고가 ≥ 목표×1.002, 72h(18봉) 시간청산 종가.
interface DipT { e: number; k: number; r: number }
const DIP: DipT[] = [];
{ const FEE = 0.0005; let i = 1; while (i < B4.length - 1) { const lim = B4[i - 1].close * 0.97; const b = B4[i]; if (b.low <= lim * 0.998) { const ep = lim; const tgt = ep * 1.03; let k = i + 1, px = 0; for (; k < B4.length && k <= i + 18; k++) { if (B4[k].high >= tgt * 1.002) { px = tgt; break; } } if (!px) { k = Math.min(i + 18, B4.length - 1); px = B4[k].close * (1 - 0.0001); } DIP.push({ e: i, k, r: (px * (1 - FEE)) / (ep / (1 - FEE)) - 1 }); i = k + 1; } else i++; } }
const RS: { m: string; e: number; k: number; r: number }[] = JSON.parse(fs.readFileSync(`${OUT}/overlap-trades.json`, 'utf8'))['RS_LAG/with-delisted'];
// 라벨
const LBL: [string, string, string, string][] = [['2020-03-12', '2020-03-13', 'STRUCT', 'COVID'], ['2022-05-09', '2022-05-12', 'STRUCT', 'LUNA'], ['2022-06-13', '2022-06-18', 'STRUCT', '3AC/Celsius'], ['2022-11-08', '2022-11-09', 'STRUCT', 'FTX'], ['2023-03-09', '2023-03-10', 'STRUCT', 'SVB'], ['2024-08-04', '2024-08-05', 'STRUCT', '엔캐리'], ['2025-02-02', '2025-02-03', 'STRUCT', '관세1'], ['2025-02-24', '2025-02-28', 'STRUCT', 'Bybit해킹+관세'], ['2025-04-06', '2025-04-07', 'STRUCT', '관세2'], ['2021-04-17', '2021-04-18', 'LIQ', '청산0418'], ['2021-05-18', '2021-05-19', 'LIQ', '중국금지+청산'], ['2021-12-03', '2021-12-04', 'LIQ', '청산1204'], ['2023-08-17', '2023-08-18', 'LIQ', '청산0817'], ['2024-03-05', '2024-03-05', 'LIQ', '청산0305'], ['2025-10-10', '2025-10-11', 'LIQ', '청산1010']];
const label = (d: string) => LBL.find(([a, b]) => d >= a && d <= b);
interface Row { d: string; i: number; ret: number; oi24: number | null; oi7: number | null; fund: number | null; prem: number | null; premChg: number | null; spx: number | null; vix: number | null; volz: number | null; breadth: number | null; dd30: number; r7pre: number | null; r3: number | null; r7: number | null; r14: number | null; lo7: number | null; cls: string; lbl: string; dipN: number; dipR: number | null; rsN: number; rsR: number | null }
const rows: Row[] = [];
for (let i = 31; i < TS.length - 1; i++) {
  if (TS[i] < Date.UTC(2019, 0, 1)) continue; const b = BTC[i], p = BTC[i - 1]; if (!b || !p) continue;
  const ret = b.close / p.close - 1; const lowR = b.low / p.close - 1; if (ret > -0.05 && lowR > -0.07) continue;
  const t = TS[i] + DAY; const d = new Date(TS[i]).toISOString().slice(0, 10);
  const o0 = oiAt(t), o1 = oiAt(t - 24 * H1), o7 = oiAt(t - 7 * DAY);
  const pr0 = premAt(t), pr1 = premAt(t - 24 * H1);
  let hi30 = 0; for (let j = i - 30; j < i; j++) if (BTC[j]) hi30 = Math.max(hi30, BTC[j]!.close);
  let worse = 0, n = 0; for (const [m, r] of L.ARANK[i]) { if (r >= 20) continue; const x = L.ret(m, i, 1); if (x == null) continue; n++; if (x < ret) worse++; }
  const fw = (k: number) => BTC[i + k] ? BTC[i + k]!.close / b.close - 1 : null;
  let lo = Infinity; for (let k = 1; k <= 7; k++) if (BTC[i + k]) lo = Math.min(lo, BTC[i + k]!.low); const lo7 = lo < Infinity ? lo / b.close - 1 : null;
  const spx = dret(SPX, d), vix = dret(VIX, d);
  const fund = fundPre(t);
  const cls = o0 && o1 ? ((o0 / o1 - 1) <= -0.07 ? 'LIQ' : (spx != null && spx <= -0.015) ? 'MACRO' : 'OTHER') : (fund != null ? (fund >= 0.0003 ? 'fLIQ' : (spx != null && spx <= -0.015) ? 'fMACRO' : 'fOTHER') : 'na');
  const dips = DIP.filter(x => B4[x.e].ts >= t && B4[x.e].ts < t + 72 * H1); const rs = RS.filter(x => x.e >= TS[i] && x.e <= TS[i] + 3 * DAY);
  const lb = label(d);
  rows.push({ d, i, ret, oi24: o0 && o1 ? o0 / o1 - 1 : null, oi7: o0 && o7 ? o0 / o7 - 1 : null, fund, prem: pr0, premChg: pr0 != null && pr1 != null ? pr0 - pr1 : null, spx, vix, volz: L.valZ('KRW-BTC', i), breadth: n ? worse / n : null, dd30: hi30 ? b.close / hi30 - 1 : 0, r7pre: BTC[i - 8] ? p.close / BTC[i - 8]!.close - 1 : null, r3: fw(3), r7: fw(7), r14: fw(14), lo7, cls, lbl: lb ? `${lb[2]}:${lb[3]}` : '', dipN: dips.length, dipR: dips.length ? dips.reduce((a, x) => a + x.r, 0) / dips.length : null, rsN: rs.length, rsR: rs.length ? rs.reduce((a, x) => a + x.r, 0) / rs.length : null });
}
fs.writeFileSync(`${OUT}/crash-days.json`, JSON.stringify(rows));
const P = (x: number | null | undefined, d = 1) => x == null || Number.isNaN(x) ? '    -' : ((100 * x >= 0 ? '+' : '') + (100 * x).toFixed(d)).padStart(6);
const N = (x: number | null | undefined, d = 2) => x == null || Number.isNaN(x) ? '   -' : x.toFixed(d).padStart(5);
const Lo: string[] = [];
Lo.push(`BTC daily close ≤ −5% OR intraday low ≤ −7% (vs prev close) days 2019~2026-10-02: ${rows.length}`);
Lo.push('date        ret   oi24   oi7   fund%  prem  Δprem  spx   Δvix  volz brdth  dd30  r7pre |   r3     r7    r14   lo7  | cls    label            | dip n/avg  rs n/avg');
for (const r of rows) Lo.push(`${r.d} ${P(r.ret)} ${P(r.oi24)} ${P(r.oi7)} ${r.fund != null ? (100 * r.fund).toFixed(3).padStart(6) : '     -'} ${P(r.prem)} ${P(r.premChg)} ${P(r.spx)} ${P(r.vix, 0)} ${N(r.volz, 1)} ${N(r.breadth)} ${P(r.dd30, 0)} ${P(r.r7pre)} | ${P(r.r3)} ${P(r.r7)} ${P(r.r14)} ${P(r.lo7)} | ${r.cls.padEnd(6)} ${r.lbl.padEnd(16)} | ${String(r.dipN).padStart(2)}/${P(r.dipR)} ${String(r.rsN).padStart(2)}/${P(r.rsR)}`);
// 그룹 통계
const mean = (a: (number | null)[]) => { const s = a.filter((x): x is number => x != null && !Number.isNaN(x)); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const med = (a: (number | null)[]) => { const s = a.filter((x): x is number => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
function grp(title: string, xs: Row[]) {
  Lo.push(`${title.padEnd(44)} n ${String(xs.length).padStart(3)} | r3 mean ${P(mean(xs.map(r => r.r3)))} med ${P(med(xs.map(r => r.r3)))} | r7 mean ${P(mean(xs.map(r => r.r7)))} med ${P(med(xs.map(r => r.r7)))} | r14 mean ${P(mean(xs.map(r => r.r14)))} | lo7 mean ${P(mean(xs.map(r => r.lo7)))} | %r7>0 ${xs.filter(r => r.r7 != null).length ? (100 * xs.filter(r => (r.r7 ?? 0) > 0).length / xs.filter(r => r.r7 != null).length).toFixed(0) : '-'}% | DIP trades ${xs.reduce((a, r) => a + r.dipN, 0)} avg ${P(mean(xs.filter(r => r.dipN).map(r => r.dipR)))} | RS_LAG trades ${xs.reduce((a, r) => a + r.rsN, 0)} avg ${P(mean(xs.filter(r => r.rsN).map(r => r.rsR)))}`);
}
Lo.push('\n### 대리 분류별 (OI 있는 2022-06~)');
for (const c of ['LIQ', 'MACRO', 'OTHER']) grp(`proxy ${c}`, rows.filter(r => r.cls === c));
Lo.push('\n### 펀딩 기준 (OI 없는 2020~2022-05)');
for (const c of ['fLIQ', 'fMACRO', 'fOTHER', 'na']) grp(`proxy ${c}`, rows.filter(r => r.cls === c));
Lo.push('\n### 라벨별');
grp('label STRUCT (known structural)', rows.filter(r => r.lbl.startsWith('STRUCT'))); grp('label LIQ (known liquidation)', rows.filter(r => r.lbl.startsWith('LIQ'))); grp('unlabelled', rows.filter(r => !r.lbl));
Lo.push('\n### 라벨 × 대리 교차 (OI 시대)');
for (const lb of ['STRUCT', 'LIQ', '']) for (const c of ['LIQ', 'MACRO', 'OTHER']) { const xs = rows.filter(r => (lb ? r.lbl.startsWith(lb) : !r.lbl) && r.cls === c); if (xs.length) Lo.push(`label ${(lb || 'none').padEnd(6)} × proxy ${c.padEnd(5)}: ${xs.map(r => r.d).join(', ')}`); }
// 단일 지표 상위/하위 반 비교 (OI 시대)
Lo.push('\n### 단일 지표 중앙값 분할 (OI 시대, 2022-06~): 지표 낮은 반 vs 높은 반의 r7 평균');
const era = rows.filter(r => r.oi24 != null);
for (const k of ['oi24', 'oi7', 'fund', 'premChg', 'spx', 'vix', 'volz', 'breadth', 'dd30', 'r7pre'] as (keyof Row)[]) {
  const xs = era.filter(r => r[k] != null && r.r7 != null).sort((a, b) => (a[k] as number) - (b[k] as number)); if (xs.length < 6) continue; const h = Math.floor(xs.length / 2);
  const lo = xs.slice(0, h), hi = xs.slice(h);
  Lo.push(`${String(k).padEnd(8)} low-half r7 ${P(mean(lo.map(r => r.r7)))} (DIP ${P(mean(lo.filter(r => r.dipN).map(r => r.dipR)))}, RS ${P(mean(lo.filter(r => r.rsN).map(r => r.rsR)))}) | high-half r7 ${P(mean(hi.map(r => r.r7)))} (DIP ${P(mean(hi.filter(r => r.dipN).map(r => r.dipR)))}, RS ${P(mean(hi.filter(r => r.rsN).map(r => r.rsR)))}) | split at ${N(med(xs.map(r => r[k] as number)), 3)}`);
}
// 4h −3% 봉 (BTC_DIP 트리거 규모)에서 OI 4h 변화로 분류 → 그 다음 72h 수익·DIP 거래
Lo.push('\n### 4h ≤ −3% 봉 (2022-06~): OI 4h 변화 분위별 다음 72h 종가 수익 / 그 봉 다음 DIP 체결 거래 수익');
{ const xs: { t: number; oi4: number | null; r72: number | null; dip: number | null }[] = [];
  for (let i = 1; i < B4.length - 18; i++) { const b = B4[i]; if (b.close / B4[i - 1].close - 1 > -0.03) continue; const t = b.ts + H4; const o0 = oiAt(t - H1), o1 = oiAt(t - 5 * H1); const d = DIP.find(x => x.e === i + 1 || x.e === i + 2); xs.push({ t, oi4: o0 && o1 ? o0 / o1 - 1 : null, r72: B4[i + 18].close / b.close - 1, dip: d ? d.r : null }); }
  const v = xs.filter(x => x.oi4 != null).sort((a, b) => a.oi4! - b.oi4!); const q = Math.floor(v.length / 3);
  for (const [nm, part] of [['OI drop big (bottom third)', v.slice(0, q)], ['OI mid', v.slice(q, 2 * q)], ['OI flat/up (top third)', v.slice(2 * q)]] as [string, typeof xs][]) Lo.push(`${nm.padEnd(28)} n ${part.length} oi4 range ${P(part[0]?.oi4)}..${P(part.at(-1)?.oi4)} | r72 mean ${P(mean(part.map(x => x.r72)))} med ${P(med(part.map(x => x.r72)))} | DIP fills ${part.filter(x => x.dip != null).length} avg ${P(mean(part.map(x => x.dip)))}`);
  Lo.push(`all 4h≤−3% bars n ${xs.length} r72 mean ${P(mean(xs.map(x => x.r72)))} | DIP fills ${xs.filter(x => x.dip != null).length} avg ${P(mean(xs.map(x => x.dip)))} | all DIP trades n ${DIP.length} avg ${P(mean(DIP.map(x => x.r)))}`); }
fs.writeFileSync(`${OUT}/crash-report.txt`, Lo.join('\n'));
console.log('done', rows.length);
