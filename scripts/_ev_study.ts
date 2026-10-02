/**
 * 축 C: 업비트 공지 이벤트 스터디 (2026-10-02)
 * 입력: data/research-ext/ev-candles/*.json (_ev_candles.ts). 상폐 마켓은 업비트가 캔들을 안 준다(404) → 생존편향.
 * 비용: KRW 마켓 수수료 0.05%/편도, BTC·USDT 마켓 0.25%/편도. 슬리피지 가정은 각 섹션에 명시.
 */
import fs from 'fs';
const DIR = 'data/research-ext/ev-candles';
const R: any[] = fs.readdirSync(DIR).map(f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'))).sort((a, b) => a.annTs - b.annTs);
const M = 60e3, H = 3600e3, D = 86400e3;
type C = { ts: number; o: number; h: number; l: number; c: number; v: number };
const at = (xs: C[], t: number) => xs.find(x => x.ts >= t) ?? null;               // t 이후 첫 봉
const px = (xs: C[], t: number, tol = 30 * M) => { const x = at(xs, t); return x && x.ts - t <= tol ? x.o : null; };
const pxH = (r: any, t: number) => t - (r.openTs ?? r.annTs) <= 3.5 * H ? (px(r.krw1m, t) ?? px(r.krw60, t, 2 * H)) : px(r.krw60, t, 2 * H);
const pct = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const stat = (xs: number[]) => {
  if (!xs.length) return '   n=0';
  const s = xs.slice().sort((a, b) => a - b); const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(xs.length - 1, 1));
  return `n=${String(xs.length).padStart(3)} 평균 ${pct(mean).padStart(8)} 중앙 ${pct(s[Math.floor(s.length / 2)]).padStart(8)} 승률 ${(100 * xs.filter(x => x > 0).length / xs.length).toFixed(0).padStart(3)}% t=${(mean / (sd / Math.sqrt(xs.length))).toFixed(1).padStart(5)}`;
};
const yr = (ts: number) => new Date(ts + 9 * H).getUTCFullYear();

// ── 생존편향 집계
console.log('── 데이터 커버리지 (업비트는 상폐 마켓 캔들을 404 로 숨긴다) ──');
for (const t of ['LIST_KRW', 'CAUTION_ON', 'CAUTION_OFF', 'WARN', 'DELIST']) {
  const xs = R.filter(r => r.type === t); const ok = xs.filter(r => r.krw60.length > 0);
  console.log(`  ${t.padEnd(12)} 이벤트 ${String(xs.length).padStart(4)}  캔들 있음 ${String(ok.length).padStart(4)} (${(100 * ok.length / Math.max(xs.length, 1)).toFixed(0)}%)`);
}

// ── (a) 신규 KRW 상장: 매수 가능 시점(개시+5분 매수제한) 이후 경로
console.log('\n── (a) KRW 마켓 개시 후 롱 — 진입 = 실제 첫 1분봉 +6분 시가, 슬리피지 편도 0.5% (스트레스 1%) ──');
const A: any[] = [];
for (const r of R.filter(r => r.type === 'LIST_KRW' && r.krw1m.length)) {
  const open = r.krw1m[0].ts;
  if (r.openTs && Math.abs(open - r.openTs) > 3 * H) continue;          // 창 안에서 개시가 안 보이면(이미 KRW 마켓 존재 등) 제외
  if (open - (r.openTs ?? r.annTs) < -10 * M) continue;
  const e = px(r.krw1m, open + 6 * M, 5 * M); if (!e) continue;
  const first5hi = Math.max(...r.krw1m.filter((x: C) => x.ts < open + 5 * M).map((x: C) => x.h));
  const row: any = { sym: r.sym, ts: open, e, pump5: first5hi / r.krw1m[0].o - 1, open0: r.krw1m[0].o };
  for (const [k, dt] of [['30m', 30 * M], ['1h', H], ['4h', 4 * H], ['1d', D], ['3d', 3 * D], ['7d', 7 * D], ['30d', 29 * D]] as Array<[string, number]>) {
    const x = pxH(r, open + 6 * M + dt); row[k] = x ? x / e - 1 : null;
  }
  A.push(row);
}
const cost = (gross: number, slip: number, fee = 0.0005) => (1 + gross) * (1 - slip) * (1 - fee) / ((1 + slip) * (1 + fee)) - 1;
for (const k of ['30m', '1h', '4h', '1d', '3d', '7d', '30d']) {
  const g = A.filter(a => a[k] != null).map(a => a[k]);
  console.log(`  보유 ${k.padEnd(4)} 총수익 ${stat(g)}   | 비용후 ${stat(g.map(x => cost(x, 0.005)))}`);
}
console.log(`  개시 첫 5분 고점 / 개시가: 중앙 ${pct(A.map(a => a.pump5).sort((a, b) => a - b)[Math.floor(A.length / 2)] ?? 0)} · 진입가 / 개시가 중앙 ${pct(A.map(a => a.e / a.open0 - 1).sort((a, b) => a - b)[Math.floor(A.length / 2)] ?? 0)}`);
console.log('  연도별 1d 비용후:', [...new Set(A.map(a => yr(a.ts)))].map(y => `${y} ${stat(A.filter(a => yr(a.ts) === y && a['1d'] != null).map(a => cost(a['1d'], 0.005)))}`).join('\n                    '));

// ── (b) 기존 BTC/USDT 마켓 코인의 KRW 마켓 추가: 공지 감지 후 기존 마켓에서 매수 → KRW 개시 무렵 매도
console.log('\n── (b) KRW 추가 공지 → 업비트 BTC/USDT 마켓에서 선매수, KRW 개시 시점 전후 매도 ──');
console.log('    수수료 BTC·USDT 마켓 0.25%/편도 + KRW↔BTC 환전 0.05%×2, 슬리피지 편도 0.3% (스트레스 1%)');
const B: any[] = [];
for (const r of R.filter(r => r.type === 'LIST_KRW')) {
  for (const [mk, xs] of [['BTC', r.btc1m], ['USDT', r.usdt1m]] as Array<[string, C[]]>) {
    if (!xs || !xs.length) continue;
    if (xs[0].ts > r.annTs - 30 * M) continue;                         // 공지 전에 이미 거래되던 마켓만
    const open = r.krw1m.length ? r.krw1m[0].ts : r.openTs; if (!open || open < r.annTs) continue;
    const pre = px(xs, r.annTs - 2 * M, 10 * M);
    const row: any = { sym: r.sym, mk, ts: r.annTs, gapMin: (open - r.annTs) / M, pre };
    for (const [k, dly] of [['d1', 1 * M], ['d5', 5 * M]] as Array<[string, number]>) {
      const e = px(xs, r.annTs + dly + M, 10 * M); if (!e) continue;
      row[k + 'e'] = e;
      for (const [hk, t] of [['@open', open], ['@open+30m', open + 30 * M], ['@open+2h', open + 2 * H]] as Array<[string, number]>) {
        const x = px(xs, t, 10 * M); if (x && t > r.annTs + dly + M) row[`${k}${hk}`] = x / e - 1;
      }
    }
    if (pre && row.d1e) row.jumpBefore1m = row.d1e / pre - 1;
    B.push(row);
  }
}
const costB = (g: number, slip: number) => (1 + g) * (1 - slip) * (1 - 0.0025) * (1 - 0.0005) / ((1 + slip) * (1 + 0.0025) * (1 + 0.0005)) - 1;
console.log(`  표본 ${B.length} (BTC ${B.filter(b => b.mk === 'BTC').length} / USDT ${B.filter(b => b.mk === 'USDT').length}), 공지→개시 간격 중앙 ${B.map(b => b.gapMin).sort((a, b) => a - b)[Math.floor(B.length / 2)]?.toFixed(0)}분`);
console.log(`  공지 직전→감지1분 후 이미 오른 폭: ${stat(B.filter(b => b.jumpBefore1m != null).map(b => b.jumpBefore1m))}`);
for (const d of ['d1', 'd5']) for (const h of ['@open', '@open+30m', '@open+2h']) {
  const g = B.filter(b => b[d + h] != null).map(b => b[d + h]);
  console.log(`  감지 ${d === 'd1' ? '1분' : '5분'} · 매도 ${h.padEnd(10)} 총 ${stat(g)} | 비용후 ${stat(g.map(x => costB(x, 0.003)))} | 비용×(슬립1%) ${stat(g.map(x => costB(x, 0.01)))}`);
}
console.log('  연도별 (감지1분·개시매도·비용후):', [...new Set(B.map(b => yr(b.ts)))].map(y => `${y} ${stat(B.filter(b => yr(b.ts) === y && b['d1@open'] != null).map(b => costB(b['d1@open'], 0.003)))}`).join('\n                                   '));
fs.writeFileSync('data/research-ext/eventB.json', JSON.stringify(B));
fs.writeFileSync('data/research-ext/eventA.json', JSON.stringify(A));

// ── (c) 유의종목 지정/해제, 유의 촉구, 거래지원 종료: 공지 후 롱
console.log('\n── (c) 경고성 공지 후 KRW 롱 — 진입 = 공지+2분(1분봉 시가), 슬리피지 편도 0.3% ──');
const Cev: any[] = [];
for (const t of ['CAUTION_ON', 'CAUTION_OFF', 'WARN', 'DELIST']) {
  const xs = R.filter(r => r.type === t && r.krw1m.length);
  console.log(` [${t}]`);
  for (const [k, dt] of [['1h', H], ['4h', 4 * H], ['1d', D], ['3d', 3 * D], ['7d', 7 * D], ['30d', 29 * D]] as Array<[string, number]>) {
    const g: number[] = [];
    for (const r of xs) { const e = px(r.krw1m, r.annTs + 2 * M, 5 * M); const x = e && pxH(r, r.annTs + 2 * M + dt); if (e && x) { g.push(x / e - 1); if (k === '1d') Cev.push({ t, ts: r.annTs, r: x / e - 1, sym: r.sym }); } }
    console.log(`   ${k.padEnd(4)} 총 ${stat(g)} | 비용후 ${stat(g.map(x => cost(x, 0.003)))}`);
  }
  const pre: number[] = [];
  for (const r of xs) { const a = px(r.krw1m, r.annTs - 30 * M, 10 * M), b = px(r.krw1m, r.annTs + 2 * M, 5 * M); if (a && b) pre.push(b / a - 1); }
  console.log(`   공지 30분 전 → 공지+2분 (이미 반영된 폭): ${stat(pre)}`);
}
fs.writeFileSync('data/research-ext/eventC.json', JSON.stringify(Cev));
