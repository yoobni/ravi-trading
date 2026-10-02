/**
 * 축 C (b'): 상장 프리미엄 — 기존 BTC/USDT 마켓 코인이 KRW 마켓에 추가될 때,
 *   같은 업비트 지갑에서 BTC/USDT 마켓으로 미리 사서 → KRW 마켓 개시 직후 KRW 로 판다(같은 계정 안 이동, API 지원).
 *   KRW 개시 후 5분은 매수만 제한, 매도는 가능. 첫 2시간 시장가 불가 → 지정가 매도(체결가는 1분봉 가격으로 근사).
 * 비용: 매수 쪽 BTC/USDT 마켓 수수료 0.25% + 슬리피지 0.3%, KRW→BTC/USDT 환전 0.05%+0.05%(스프레드),
 *       매도 KRW 0.05% + 슬리피지 0.5%(개시 직후 변동성). 스트레스: 매도 체결을 그 1분봉 저가로.
 */
import fs from 'fs';
const DIR = 'data/research-ext/ev-candles';
const ev = JSON.parse(fs.readFileSync('data/research-ext/events.json', 'utf8'));
const FX: Record<string, any[]> = JSON.parse(fs.readFileSync('data/research-ext/ev-fx.json', 'utf8'));
const M = 60e3;
const at = (xs: any[], t: number, tol = 5 * M) => { const x = xs.find(y => y.ts >= t); return x && x.ts - t <= tol ? x : null; };
const pct = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const stat = (xs: number[]) => { if (!xs.length) return 'n=0'; const s = xs.slice().sort((a, b) => a - b), m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return `n=${String(xs.length).padStart(3)} 평균 ${pct(m).padStart(8)} 중앙 ${pct(s[Math.floor(s.length / 2)]).padStart(8)} 승률 ${(100 * xs.filter(x => x > 0).length / xs.length).toFixed(0).padStart(3)}% t=${(m / (sd / Math.sqrt(xs.length))).toFixed(1).padStart(5)} 최악 ${pct(s[0])}`; };
const rows: any[] = [];
for (const e of ev.filter((x: any) => x.type === 'LIST_KRW')) {
  const f = `${DIR}/${e.id}_${e.sym}.json`; if (!fs.existsSync(f)) continue;
  const r = JSON.parse(fs.readFileSync(f, 'utf8')); if (!r.krw1m.length) continue;
  const open = r.krw1m[0].ts;
  if (e.openTs && Math.abs(open - e.openTs) > 3 * 3600e3) continue;
  for (const [mk, xs] of [['BTC', r.btc1m], ['USDT', r.usdt1m]] as Array<[string, any[]]>) {
    if (!xs?.length || xs[0].ts > e.annTs - 30 * M) continue;
    const fx = FX[`${mk}|${e.openTs ?? (open)}`] || FX[`${mk}|${open}`]; if (!fx?.length) continue;
    const row: any = { sym: e.sym, mk, ts: e.annTs, gap: (open - e.annTs) / M };
    for (const [ek, et] of [['ann+1m', e.annTs + 2 * M], ['open-5m', open - 5 * M], ['open-1m', open - 1 * M]] as Array<[string, number]>) {
      if (et < e.annTs + 2 * M && ek !== 'ann+1m') continue;
      const q = at(xs, et), fxe = at(fx, et, 30 * M); if (!q || !fxe) continue;
      const costKrw = q.o * fxe.o;
      for (const [xk, xt] of [['open+1m', open + M], ['open+5m', open + 5 * M], ['open+30m', open + 30 * M]] as Array<[string, number]>) {
        const k = at(r.krw1m, xt); if (!k) continue;
        row[`${ek}→${xk}`] = k.o / costKrw - 1;
        row[`${ek}→${xk}|low`] = k.l / costKrw - 1;
      }
    }
    // 개시 1분봉 시가의 '김프' — 같은 시각 기존 마켓 가격 대비
    const q0 = at(xs, open - M), fx0 = at(fx, open - M, 30 * M);
    if (q0 && fx0) row.prem0 = r.krw1m[0].o / (q0.o * fx0.o) - 1;
    rows.push(row);
  }
}
const net = (g: number) => (1 + g) * (1 - 0.0025) * (1 - 0.003) * (1 - 0.001) * (1 - 0.0005) * (1 - 0.005) - 1;
console.log(`표본 ${rows.length}건 (BTC ${rows.filter(r => r.mk === 'BTC').length} / USDT ${rows.filter(r => r.mk === 'USDT').length}) · 공지→개시 중앙 ${rows.map(r => r.gap).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}분`);
console.log(`KRW 첫 1분봉 시가 vs 직전 기존마켓 가격(환산): ${stat(rows.filter(r => r.prem0 != null).map(r => r.prem0))}`);
for (const ek of ['ann+1m', 'open-5m', 'open-1m']) for (const xk of ['open+1m', 'open+5m', 'open+30m']) {
  const k = `${ek}→${xk}`; const g = rows.filter(r => r[k] != null).map(r => r[k]);
  if (!g.length) continue;
  console.log(`매수 ${ek.padEnd(8)} 매도 ${xk.padEnd(9)} 비용후 ${stat(g.map(net))}  | 매도=저가 ${stat(rows.filter(r => r[k + '|low'] != null).map(r => net(r[k + '|low'])))}`);
}
const yr = (t: number) => new Date(t + 9 * 3600e3).getUTCFullYear();
const key = 'open-5m→open+1m';
console.log('\n연도별 (' + key + ', 비용후):');
for (const y of [...new Set(rows.map(r => yr(r.ts)))].sort()) console.log(`  ${y} ${stat(rows.filter(r => yr(r.ts) === y && r[key] != null).map(r => net(r[key])))}`);
console.log('마켓별:'); for (const mk of ['BTC', 'USDT']) console.log(`  ${mk} ${stat(rows.filter(r => r.mk === mk && r[key] != null).map(r => net(r[key])))}`);
fs.writeFileSync('data/research-ext/eventPrem.json', JSON.stringify(rows));
