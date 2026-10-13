/**
 * AI 리스크 데스크 리서치(2026-10) — A-2: 공지 사건 후 수익 분포 (리서치 전용, API 호출 없음)
 * 가격: 업비트 일봉(daily/, 현존 코인) + 바이낸스 USDT 일봉×환율(binance-1d-ext, 상폐 코인). 일봉 경계 UTC00 = KST09.
 * d0 = 공지 시각이 속한 일봉. r_pre = close(d0-1)/close(d0-8) (공지 전 7일), r_d0 = close(d0)/close(d0-1) (공지 당일, 공지 전 구간 포함),
 * r_N = close(d0+N)/close(d0) (공지일 종가에 반응했을 때 N일 뒤), open1 = open(d0+1)/close(d0).
 * 4h 반응(28코인+120코인 4h 캐시 있는 코인만): 공지 직후 첫 4h 봉 종가 / 공지 직전 4h 봉 종가 (데스크가 ≤4h 안에 팔 때 받는 가격 근사).
 */
import fs from 'fs';
import path from 'path';
const OUT = 'data/research-ext/riskdesk-2026-10';
const DAY = 86400e3;
interface Bar { ts: number; open: number; high: number; low: number; close: number }
interface Ev { id: number; ts: number; at: string; type: string; sub?: string; scope?: string; sym: string; title: string }
const ANN: Ev[] = JSON.parse(fs.readFileSync(`${OUT}/ann-catalog.json`, 'utf8'));
const PX = new Map<string, Map<number, Bar>>(); const SRC = new Map<string, string>();
for (const f of fs.readdirSync('data/research-ext/daily').filter(f => f.startsWith('KRW-'))) { const b: Bar[] = JSON.parse(fs.readFileSync(`data/research-ext/daily/${f}`, 'utf8')); PX.set(f.slice(4, -5), new Map(b.filter(x => x.close > 0).map(x => [x.ts, x]))); SRC.set(f.slice(4, -5), 'upbit'); }
const fxJ = JSON.parse(fs.readFileSync('data/research-ext/macro/yahoo-KRW=X.json', 'utf8')).chart.result[0]; const fx = new Map<number, number>(); fxJ.timestamp.forEach((t: number, i: number) => { const c = fxJ.indicators.quote[0].close[i]; if (c) fx.set(Math.floor(t / 86400) * DAY, c); });
const fxAt = (t: number) => { for (let k = 0; k < 7; k++) { const v = fx.get(t - k * DAY); if (v) return v; } return 1200; };
const extDir = `${OUT}/binance-1d-ext`;
for (const f of fs.readdirSync(extDir).filter(f => /^[A-Z0-9]+\.json$/.test(f))) { const s = f.slice(0, -5); if (PX.has(s)) continue; const b: number[][] = JSON.parse(fs.readFileSync(`${extDir}/${f}`, 'utf8'));
  // 상폐 공지 + 7일 이후는 버림 (바이낸스 심볼 재사용: LUNA 등)
  const d = ANN.filter(e => e.sym === s && e.type === 'DELIST' && e.scope === 'KRW').sort((a, b) => a.ts - b.ts)[0]; const tEnd = d ? d.ts + 7 * DAY : Infinity;
  PX.set(s, new Map(b.filter(k => k[4] > 0 && k[0] <= tEnd).map(k => { const x = fxAt(k[0]); return [k[0], { ts: k[0], open: k[1] * x, high: k[2] * x, low: k[3] * x, close: k[4] * x }]; }))); SRC.set(s, 'binance'); }
// 4h
const H4 = 4 * 3600e3; const P4 = new Map<string, Map<number, Bar>>();
{ const files = fs.readdirSync('data/candle-cache').filter(f => /_240m_/.test(f)); const best = new Map<string, string>();
  for (const f of files) { const m = f.split('_')[0]; const sz = fs.statSync(path.join('data/candle-cache', f)).size; if (!best.has(m) || sz > fs.statSync(path.join('data/candle-cache', best.get(m)!)).size) best.set(m, f); }
  for (const [m, f] of best) { const b: Bar[] = JSON.parse(fs.readFileSync(path.join('data/candle-cache', f), 'utf8')); P4.set(m.slice(4), new Map(b.map(x => [x.ts, x]))); } }
const at = (s: string, t: number) => PX.get(s)?.get(t);
const lastBefore = (s: string, t: number, maxBack = 10) => { for (let k = 0; k <= maxBack; k++) { const b = at(s, t - k * DAY); if (b) return b; } return undefined; };
const lastAtOrBefore = (s: string, t: number) => { const m = PX.get(s); if (!m) return undefined; let best: Bar | undefined; for (const b of m.values()) if (b.ts <= t && (!best || b.ts > best.ts)) best = b; return best; };
interface Row { type: string; sub: string; sym: string; at: string; src: string; pre7: number; d0: number; open1: number; r1: number; r3: number; r7: number; r30: number; r4h: number | null; era: string }
const rows: Row[] = [];
const seen = new Set<string>();
for (const e of ANN) {
  if (e.ts < Date.UTC(2019, 0, 1)) continue;
  if (!['CAUTION_ON', 'CAUTION_EXT', 'CAUTION_OFF', 'WARN', 'DELIST', 'DW_SUSPEND', 'LIST'].includes(e.type)) continue;
  if (e.type === 'DELIST' && e.scope !== 'KRW') continue; if (e.type === 'LIST' && e.scope !== 'KRW') continue;
  const key = `${e.type}|${e.sym}|${Math.floor(e.ts / DAY)}`; if (seen.has(key)) continue; seen.add(key);
  const d0t = Math.floor(e.ts / DAY) * DAY; const b0 = at(e.sym, d0t); const bm1 = lastBefore(e.sym, d0t - DAY, 3); if (!b0 || !bm1) continue;
  if (e.type === 'LIST' && e.ts > d0t) { /* 상장 공지: 공지일 봉은 보통 없음 */ }
  const bm8 = lastBefore(e.sym, d0t - 8 * DAY, 3);
  const rN = (n: number) => { const b = at(e.sym, d0t + n * DAY) ?? lastAtOrBefore(e.sym, d0t + n * DAY); return b && b.ts > d0t ? b.close / b0.close - 1 : NaN; };
  const b1 = at(e.sym, d0t + DAY);
  let r4h: number | null = null; const p4 = P4.get(e.sym);
  if (p4) { const t0 = Math.floor(e.ts / H4) * H4; const prev = p4.get(t0 - H4), cur = p4.get(t0); if (prev && cur) r4h = cur.close / prev.close - 1; }
  rows.push({ type: e.type, sub: e.scope || e.sub || '-', sym: e.sym, at: e.at.slice(0, 10), src: SRC.get(e.sym)!, pre7: bm8 ? bm1.close / bm8.close - 1 : NaN, d0: b0.close / bm1.close - 1, open1: b1 ? b1.open / b0.close - 1 : NaN, r1: rN(1), r3: rN(3), r7: rN(7), r30: rN(30), r4h, era: e.ts < Date.UTC(2022, 0, 1) ? '2019-21' : e.ts < Date.UTC(2024, 0, 1) ? '2022-23' : '2024-26' });
}
fs.writeFileSync(`${OUT}/event-returns.json`, JSON.stringify(rows));
const q = (a: number[], p: number) => { const s = a.filter(x => !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = (a: number[]) => { const s = a.filter(x => !Number.isNaN(x)); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const pct = (x: number) => Number.isNaN(x) ? '   -  ' : ((100 * x >= 0 ? '+' : '') + (100 * x).toFixed(1)).padStart(6);
const L: string[] = [];
function block(title: string, xs: Row[]) {
  L.push(`\n### ${title}  n=${xs.length} (upbit ${xs.filter(r => r.src === 'upbit').length} / binance ${xs.filter(r => r.src === 'binance').length})`);
  L.push('metric   |  mean   med    p10    p25    p75    p90  | %neg  n');
  for (const k of ['pre7', 'd0', 'open1', 'r1', 'r3', 'r7', 'r30', 'r4h'] as (keyof Row)[]) {
    const a = xs.map(r => r[k] as number).filter(x => x != null && !Number.isNaN(x)); if (!a.length) continue;
    L.push(`${String(k).padEnd(8)} | ${pct(mean(a))} ${pct(q(a, .5))} ${pct(q(a, .1))} ${pct(q(a, .25))} ${pct(q(a, .75))} ${pct(q(a, .9))} | ${(100 * a.filter(x => x < 0).length / a.length).toFixed(0).padStart(4)}% ${a.length}`);
  }
}
const by = (f: (r: Row) => boolean) => rows.filter(f);
block('CAUTION_ON (유의 종목 지정) 전체', by(r => r.type === 'CAUTION_ON'));
for (const era of ['2019-21', '2022-23', '2024-26']) block(`CAUTION_ON ${era}`, by(r => r.type === 'CAUTION_ON' && r.era === era));
block('CAUTION_ON — 이후 KRW 상폐로 간 코인', by(r => r.type === 'CAUTION_ON' && ANN.some(e => e.sym === r.sym && e.type === 'DELIST' && e.scope === 'KRW' && e.ts > Date.parse(r.at) && e.ts < Date.parse(r.at) + 400 * DAY)));
block('CAUTION_ON — 해제된(살아남은) 코인', by(r => r.type === 'CAUTION_ON' && ANN.some(e => e.sym === r.sym && e.type === 'CAUTION_OFF' && e.ts > Date.parse(r.at) && e.ts < Date.parse(r.at) + 400 * DAY)));
block('CAUTION_EXT (지정 기간 연장)', by(r => r.type === 'CAUTION_EXT'));
block('WARN (유의 촉구)', by(r => r.type === 'WARN'));
block('DELIST KRW (거래지원 종료 공지)', by(r => r.type === 'DELIST'));
block('CAUTION_OFF (유의 해제)', by(r => r.type === 'CAUTION_OFF'));
block('DW_SUSPEND PLAIN (사유 없는 입출금 일시중단)', by(r => r.type === 'DW_SUSPEND' && r.sub === 'PLAIN'));
block('DW_SUSPEND ISSUE (네트워크/프로젝트 이슈)', by(r => r.type === 'DW_SUSPEND' && r.sub === 'ISSUE'));
block('DW_SUSPEND FORK (하드포크·업그레이드·스왑)', by(r => r.type === 'DW_SUSPEND' && r.sub === 'FORK'));
block('DW_SUSPEND MAINT (월렛 점검)', by(r => r.type === 'DW_SUSPEND' && r.sub === 'MAINT'));
block('LIST KRW (신규 상장 공지, 기존 마켓 보유 코인만)', by(r => r.type === 'LIST'));
// 유의 지정 → 상폐 공지까지 누적, 상폐 공지 → 7일
{ const xs: string[] = []; const cum: number[] = [], cumDel: number[] = [];
  for (const on of ANN.filter(e => e.type === 'CAUTION_ON' && e.ts >= Date.UTC(2019, 0, 1))) {
    const d = ANN.find(e => e.sym === on.sym && e.type === 'DELIST' && e.scope === 'KRW' && e.ts > on.ts && e.ts < on.ts + 400 * DAY); if (!d) continue;
    const b0 = at(on.sym, Math.floor(on.ts / DAY) * DAY), bd = at(on.sym, Math.floor(d.ts / DAY) * DAY); const b7 = lastAtOrBefore(on.sym, Math.floor(d.ts / DAY) * DAY + 7 * DAY);
    if (!b0 || !bd) continue; cum.push(bd.close / b0.close - 1); if (b7 && b7.ts > bd.ts) cumDel.push(b7.close / bd.close - 1);
    xs.push(`${on.sym} ${on.at.slice(0, 10)}→${d.at.slice(0, 10)} ${(100 * (bd.close / b0.close - 1)).toFixed(0)}%`);
  }
  L.push(`\n### 유의 지정일 종가 → 상폐 공지일 종가 (n=${cum.length}): mean ${pct(mean(cum))} med ${pct(q(cum, .5))} p10 ${pct(q(cum, .1))} p90 ${pct(q(cum, .9))} | 상폐 공지일 종가 → +7일: mean ${pct(mean(cumDel))} med ${pct(q(cumDel, .5))} n ${cumDel.length}`);
  L.push(xs.join(', ')); }
// 공지 시각 분포 (KST 시)
{ const h: Record<string, number> = {}; for (const e of ANN.filter(e => ['CAUTION_ON', 'WARN', 'DELIST'].includes(e.type) && e.ts >= Date.UTC(2019, 0, 1))) { const hr = new Date(e.ts + 9 * 3600e3).getUTCHours(); h[hr] = (h[hr] || 0) + 1; } L.push('\n공지 시각 분포(KST 시, CAUTION_ON/WARN/DELIST): ' + Object.entries(h).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}h:${v}`).join(' ')); }
fs.writeFileSync(`${OUT}/event-report.txt`, L.join('\n'));
console.log('done', rows.length);
