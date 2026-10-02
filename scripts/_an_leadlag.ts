/**
 * 축 A — 바이낸스 → 업비트 1분 선행 (2026-10-02)
 * 업비트: data/microstructure 스냅샷 mid (매분 경계 +~2초). 바이낸스: 1분봉 close (경계 시각 가격).
 * 경계 B 에서: 바이낸스 k분 수익 xb, 업비트 k분 수익 xu, 괴리 gap = xb − xu.
 * 예측 대상: 업비트 mid 수익 B+L → B+L+h  (L = 0: 스냅샷 시점 즉시(~2초), L = 1: 1분 뒤 체결)
 */
import fs from 'fs';
import path from 'path';
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO','ETC','XLM','AAVE','ARB','APT','SUI','GRT','IMX','SAND','MANA','CHZ','AXS','BAT'];
const M = 60_000;
export const up = new Map<string, Map<number, { mid: number; spr: number }>>();   // coin → minute → mid
for (const f of fs.readdirSync('data/microstructure').filter(x => x.endsWith('.jsonl')).sort()) {
  for (const l of fs.readFileSync(path.join('data/microstructure', f), 'utf8').split('\n')) {
    if (!l) continue; let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (!r.mid || r.ts % M > 10_000) continue;
    const c = r.m.replace('KRW-', ''); if (!up.has(c)) up.set(c, new Map());
    up.get(c)!.set(Math.floor(r.ts / M) * M, { mid: r.mid, spr: r.spreadBps });
  }
}
export const bn = new Map<string, Map<number, number>>();   // coin → boundary ts → price at boundary (= close of kline opening 1 min before)
for (const c of COINS) {
  const rows: number[][] = JSON.parse(fs.readFileSync(`data/research-ext/binance/${c}USDT_1m.json`, 'utf8'));
  const m = new Map<number, number>(); for (const k of rows) m.set(k[0] + M, k[4]); bn.set(c, m);
}
const spearman = (x: number[], y: number[]) => {
  const rk = (a: number[]) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], j) => r[i] = j); return r; };
  const rx = rk(x), ry = rk(y), n = x.length, mx = (n - 1) / 2;
  let s = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { s += (rx[i] - mx) * (ry[i] - mx); sx += (rx[i] - mx) ** 2; sy += (ry[i] - mx) ** 2; }
  return s / Math.sqrt(sx * sy);
};
if (require.main === module) {
  const allT = [...up.get('BTC')!.keys()].sort((a, b) => a - b);
  const half = allT[Math.floor(allT.length / 2)];
  console.log(`업비트 스냅샷 분 ${allT.length} (${new Date(allT[0]).toISOString().slice(0, 16)} ~ ${new Date(allT[allT.length - 1]).toISOString().slice(0, 16)})`);
  console.log('\n① 괴리 gap(k=1/3분) → 업비트 향후 수익 IC (전 코인 풀링, 코인 내 순위 아님) · 전반/후반');
  for (const k of [1, 3]) for (const L of [0, 1]) for (const h of [1, 2, 5, 10]) {
    const X: number[][] = [[], []], Y: number[][] = [[], []], G: number[][] = [[], []];
    for (const c of COINS) {
      const u = up.get(c), b = bn.get(c); if (!u || !b) continue;
      for (const [t, v] of u) {
        const u0 = u.get(t - k * M), b0 = b.get(t - k * M), bt = b.get(t), ua = u.get(t + L * M), ub = u.get(t + (L + h) * M);
        if (!u0 || !b0 || !bt || !ua || !ub) continue;
        const xb = bt / b0 - 1, xu = v.mid / u0.mid - 1, y = ub.mid / ua.mid - 1;
        const s = t < half ? 0 : 1; G[s].push(xb - xu); X[s].push(xb); Y[s].push(y);
      }
    }
    const f = (a: number[], y: number[]) => spearman(a, y).toFixed(3);
    console.log(`  k=${k} L=${L} h=${String(h).padStart(2)}  gap IC ${f(G[0], Y[0])} / ${f(G[1], Y[1])}   바이낸스수익 IC ${f(X[0], Y[0])} / ${f(X[1], Y[1])}   n=${G[0].length + G[1].length}`);
  }
}
