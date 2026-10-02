/** 축 E-4b 시간대 매매 검증 — KST hA 시 시가 매수 → hB 시 시가 매도, 매일. 1h 28코인 2024-06~2026-08. */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const SP: Record<string, number> = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-spread-p50.json'), 'utf8'));
const load = (m: string) => { let best: any[] = []; for (const f of fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_60m_`))) { const b = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (b.length > best.length) best = b; } return best.sort((a, b) => a.ts - b.ts); };
const B = new Map(Object.keys(SP).map(m => [m, new Map(load(m).map((x: any) => [x.ts, x]))]));
const H = 3600e3, DAY = 86400e3, FEE = 0.0005;
const days: number[] = []; for (let t = Date.UTC(2024, 5, 12); t < Date.UTC(2026, 7, 19); t += DAY) days.push(t);
// KST h 시 = UTC (h-9) 시
const at = (day: number, kh: number) => day + ((kh - 9 + 24) % 24) * H;
function test(lab: string, coins: string[], hA: number, hB: number, mode: 'market' | 'limit') {
  const rs: { ts: number; r: number }[] = [];
  for (const d of days) {
    const ta = at(d, hA), tb = at(d, hB) + (hB <= hA ? DAY : 0);
    let s = 0, n = 0;
    for (const m of coins) {
      const a = B.get(m)!.get(ta), b = B.get(m)!.get(tb); if (!a || !b) continue;
      const sl = mode === 'market' ? Math.max(0.0005, SP[m] / 2 / 1e4) : 0;
      s += (b.open * (1 - sl)) / (a.open * (1 + sl)) * (1 - FEE) ** 2 - 1; n++;
    }
    if (n) rs.push({ ts: ta, r: s / n });
  }
  const mean = (a: typeof rs) => a.reduce((x, y) => x + y.r, 0) / Math.max(a.length, 1) * 1e4;
  const sd = Math.sqrt(rs.reduce((x, y) => x + (y.r * 1e4 - mean(rs)) ** 2, 0) / rs.length);
  const half = Date.UTC(2025, 6, 15);
  let eq = 1; for (const x of rs) eq *= 1 + x.r;
  console.log(`${lab.padEnd(36)} 일평균 ${mean(rs).toFixed(1).padStart(6)}bp  t ${(mean(rs) / (sd / Math.sqrt(rs.length))).toFixed(2).padStart(5)}  IS ${mean(rs.filter(x => x.ts < half)).toFixed(1).padStart(6)} OOS ${mean(rs.filter(x => x.ts >= half)).toFixed(1).padStart(6)}  누적 ${(100 * (eq - 1)).toFixed(0)}%`);
}
const ALL = Object.keys(SP), LIQ = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
console.log('비용 = 수수료 0.05%×2 (+ 시장가면 스프레드½×2). 지정가는 관통·미체결 위험 무시(상한).');
for (const [a, b] of [[5, 8], [5, 9], [6, 8], [4, 8], [18, 19], [10, 8]] as Array<[number, number]>) {
  test(`${a}→${b}시 전체28 시장가`, ALL, a, b, 'market');
  test(`${a}→${b}시 BTC·ETH·XRP·SOL 시장가`, LIQ, a, b, 'market');
  test(`${a}→${b}시 BTC·ETH·XRP·SOL 지정가(상한)`, LIQ, a, b, 'limit');
}
test('플라시보: 13→16시 유동4 지정가', LIQ, 13, 16, 'limit');
test('플라시보: 21→24시 유동4 지정가', LIQ, 21, 0, 'limit');
