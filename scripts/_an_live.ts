/**
 * 라이브 페이퍼 기록 해부 (2026-10-02) — 은퇴 5 + 리셋 전 2 = 7전략 394건.
 * 질문: 누가 벌었나, 승패를 가른 건 무엇인가(청산사유·보유시간·진입시각·코인·라이브/백필), 체결격차는 어디서 나왔나.
 */
import fs from 'fs';
import path from 'path';
const A = path.resolve(process.cwd(), 'data/_archive/20261001');
const S: Array<[string, string]> = [['F6', 'paper-f6-pre-reset'], ['F6_v2', 'paper-f6v2'], ['F6_v3', 'paper-f6v3'],
  ['F6_v5', 'paper-f6v5'], ['F6_v6', 'paper-f6v6-pre-reset'], ['F6_v7', 'paper-f6v7'], ['F6_v8', 'paper-f6v8']];
const rd = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const all: any[] = [];
for (const [id, d] of S) {
  const ticks = rd(path.join(A, d, 'ticks.jsonl'));
  const bf = new Set(ticks.filter((t: any) => t.backfilled).map((t: any) => t.ts));
  for (const t of rd(path.join(A, d, 'trades.jsonl'))) {
    const rec = Date.parse(t.recordedAt);
    // 백필 거래는 recordedAt 이 tick 격자 시각(초·ms=0)으로 찍힌다
    all.push({ ...t, sid: id, live: rec % 60_000 !== 0 && !bf.has(rec), holdH: (t.exitTs - t.entryTs) / 3600e3,
      hKst: new Date(t.entryTs + 9 * 3600e3).getUTCHours(), mktR: t.exitPriceMarket ? (t.exitPriceMarket / t.entryPrice - 1) * 100 : null });
  }
}
const pct = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const summ = (xs: any[]) => {
  const w = xs.filter(t => t.profitRate > 0), l = xs.filter(t => t.profitRate <= 0);
  const gw = w.reduce((a, t) => a + t.profitKrw, 0), gl = -l.reduce((a, t) => a + t.profitKrw, 0);
  const avg = xs.reduce((a, t) => a + t.profitRate, 0) / Math.max(xs.length, 1);
  return `${String(xs.length).padStart(4)}건 승률 ${(100 * w.length / Math.max(xs.length, 1)).toFixed(0).padStart(3)}% 평균 ${pct(avg).padStart(7)} ` +
    `평균승 ${pct(w.reduce((a, t) => a + t.profitRate, 0) / Math.max(w.length, 1)).padStart(7)} 평균패 ${pct(l.reduce((a, t) => a + t.profitRate, 0) / Math.max(l.length, 1)).padStart(7)} ` +
    `PF ${(gl > 0 ? gw / gl : 99).toFixed(2)} 손익 ${Math.round(gw - gl).toLocaleString().padStart(10)}`;
};
const group = (title: string, key: (t: any) => string, xs = all) => {
  console.log(`\n── ${title} ──`);
  const g = new Map<string, any[]>();
  for (const t of xs) { const k = key(t); if (!g.has(k)) g.set(k, []); g.get(k)!.push(t); }
  for (const [k, v] of [...g].sort()) console.log(`  ${k.padEnd(14)} ${summ(v)}`);
};
console.log(`전체 ${all.length}건 (라이브 ${all.filter(t => t.live).length} / 백필 ${all.filter(t => !t.live).length})`);
console.log(`기간 ${new Date(Math.min(...all.map(t => t.entryTs)) + 9 * 3600e3).toISOString().slice(0, 10)} ~ ${new Date(Math.max(...all.map(t => t.exitTs)) + 9 * 3600e3).toISOString().slice(0, 10)}`);
group('전략별', t => t.sid);
group('청산 사유별 (전 전략)', t => t.reason);
group('전략×청산사유', t => `${t.sid}/${t.reason}`);
group('라이브 vs 백필', t => t.live ? 'live' : 'backfill');
group('보유시간', t => t.holdH < 8 ? 'a <8h' : t.holdH < 24 ? 'b 8~24h' : t.holdH < 72 ? 'c 1~3일' : t.holdH < 168 ? 'd 3~7일' : 'e 7일+');
group('진입 시각(KST)', t => String(t.hKst).padStart(2, '0') + '시');
group('월별', t => new Date(t.entryTs + 9 * 3600e3).toISOString().slice(0, 7));
group('코인 (거래 6건 이상)', t => t.market, all.filter(t => all.filter(u => u.market === t.market).length >= 6));
const m = all.filter(t => t.mktR != null);
console.log(`\n── 체결격차 (exitPriceMarket 있는 ${m.length}건): 기록 vs 그 시점 시장가 ──`);
const gg = new Map<string, number[]>();
for (const t of m) { const k = t.reason; if (!gg.has(k)) gg.set(k, []); gg.get(k)!.push(t.mktR - t.profitRate); }
for (const [k, v] of gg) console.log(`  ${k.padEnd(6)} ${v.length}건 평균 ${pct(v.reduce((a, b) => a + b, 0) / v.length)}`);
