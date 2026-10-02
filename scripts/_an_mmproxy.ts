/**
 * 스프레드 포착 — 1분 스냅샷(5주) 기반 역선택 대리지표 (2026-10-02).
 * "매도공격이 있었던 분" = 최우선 매수호가에 걸어둔 지정가가 체결될 수 있었던 분.
 * 그 분의 mid 대비 다음 5/30/60분 mid 변화를, 스프레드½(=최우선 매수가가 mid 보다 싼 정도)와 비교.
 * 메이커 매수의 기대 = 스프레드½ + (이후 mid 변화) − 수수료 → 매도도 메이커면 다시 스프레드½.
 * 왕복 이론치(양쪽 메이커) = 스프레드 − 수수료 10bps + 역선택(매수 체결 조건부 mid 하락) — 단 매도 체결까지의 시간 동안의 드리프트 포함.
 */
import fs from 'fs';
const files = fs.readdirSync('data/microstructure').filter(f => f.endsWith('.jsonl')).sort();
const by = new Map<string, Array<{ ts: number; mid: number; spr: number; sell: number; buy: number; tr: boolean }>>();
for (const f of files) for (const l of fs.readFileSync('data/microstructure/' + f, 'utf8').split('\n')) {
  if (!l) continue; let x: any; try { x = JSON.parse(l); } catch { continue; }
  if (!by.has(x.m)) by.set(x.m, []);
  by.get(x.m)!.push({ ts: x.ts, mid: x.mid, spr: x.spreadBps, sell: x.sellKrw, buy: x.buyKrw, tr: x.truncated });
}
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
console.log('코인        매도공격분 비율 | 스프레드½ | 다음 5/30/60분 mid(bps, 매도공격 분 조건부) | 무조건 60분 | 대량매도분(상위10%) 60분');
const rows: string[] = [];
for (const [m, a] of by) {
  a.sort((p, q) => p.ts - q.ts);
  const idx = (t: number) => { let lo = 0, hi = a.length - 1; while (lo < hi) { const k = (lo + hi) >> 1; if (a[k].ts < t) lo = k + 1; else hi = k; } return lo; };
  const fwd = (i: number, mins: number) => { const j = idx(a[i].ts + mins * 60e3); if (j >= a.length || Math.abs(a[j].ts - (a[i].ts + mins * 60e3)) > 120e3) return NaN; return (a[j].mid / a[i].mid - 1) * 1e4; };
  const sellMin = a.map((x, i) => i).filter(i => !a[i].tr && a[i].sell > 0);
  const thr = sellMin.map(i => a[i].sell).sort((p, q) => p - q)[Math.floor(sellMin.length * 0.9)] ?? Infinity;
  const big = sellMin.filter(i => a[i].sell >= thr);
  const all = a.map((x, i) => i).filter(i => i % 5 === 0);
  const f = (ids: number[], mn: number) => mean(ids.map(i => fwd(i, mn)).filter(isFinite));
  const half = mean(a.map(x => x.spr)) / 2;
  rows.push(`${m.padEnd(10)} ${(100 * sellMin.length / a.length).toFixed(0).padStart(5)}%     | ${half.toFixed(1).padStart(6)} | ${f(sellMin, 5).toFixed(1).padStart(7)} ${f(sellMin, 30).toFixed(1).padStart(7)} ${f(sellMin, 60).toFixed(1).padStart(7)} | ${f(all, 60).toFixed(1).padStart(7)} | ${f(big, 60).toFixed(1).padStart(7)}`);
}
console.log(rows.sort((p, q) => parseFloat(q.split('|')[1]) - parseFloat(p.split('|')[1])).join('\n'));
