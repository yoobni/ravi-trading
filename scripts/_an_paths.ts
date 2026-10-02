import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE0 = 0.0005, SLIP0 = 0.0005, INIT = 10_000_000;
let FEE = FEE0, SLIP = SLIP0;
const H = 3600_000, FOUR = 4 * H;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
const RAW = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 500) RAW.set(m, b); }
const IDX = new Map([...RAW].map(([m, b]) => [m, new Map(b.map((x, i) => [x.ts, i]))]));
const TS = [...new Set([...RAW.values()].flatMap(b => b.map(x => x.ts)))].sort((a, b) => a - b);
ORDER = [...RAW.keys()];

const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;
/**
 * F6 신호 경로 해부 (2026-10-02) — 슬롯 제약 없이 모든 신호를 독립 거래로 보고, 진입(다음 봉 시가) 후 18봉(3일) 경로를 기록.
 * 질문: 이기는 거래는 언제 이기나(최고점 시각), 지는 거래는 얼마나 빠지나, 어떤 진입 조건이 결과를 가르나(IS/OOS 일관성).
 */
interface Sig { m: string; ts: number; r3: number; mfe: number; mae: number; tMfe: number; tMae: number; hit6first: number; hour: number; btc7: number; own7: number; vz: number; brk: number; body: number }
const btc = RAW.get('KRW-BTC')!; const bIdx = IDX.get('KRW-BTC')!;
const sigs: Sig[] = [];
for (const [m, b] of RAW) {
  for (let i = 45; i < b.length - 19; i++) {
    if (!sigF6(b, i)) continue;
    const ep = b[i + 1].open;
    let mfe = -1e9, mae = 1e9, tMfe = 0, tMae = 0, hit6first = 0;
    for (let k = 1; k <= 18; k++) {
      const x = b[i + k];
      const hi = x.high / ep - 1, lo = x.low / ep - 1;
      if (hit6first === 0) { if (hi >= 0.06) hit6first = 1; else if (lo <= -0.02) hit6first = -1; }
      if (hi > mfe) { mfe = hi; tMfe = k; }
      if (lo < mae) { mae = lo; tMae = k; }
    }
    const bi = bIdx.get(b[i].ts);
    sigs.push({ m, ts: b[i].ts, r3: b[i + 18].close / ep - 1, mfe, mae, tMfe, tMae, hit6first,
      hour: new Date(b[i].ts + 9 * 3600e3).getUTCHours(),
      btc7: bi !== undefined && bi >= 42 ? btc[bi].close / btc[bi - 42].close - 1 : 0,
      own7: b[i].close / b[i - 42].close - 1, vz: volZ(b, i),
      brk: b[i].close / hiOf(b, i - 42, i - 1) - 1, body: b[i].close / b[i].open - 1 });
  }
}
const SPLIT = Date.UTC(2024, 7, 1);
const P = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
console.log(`신호 ${sigs.length}건 (IS ~2024-07: ${sigs.filter(s => s.ts < SPLIT).length} / OOS: ${sigs.filter(s => s.ts >= SPLIT).length})`);
console.log(`\n① 경로 — 3일 수익 평균 ${P(mean(sigs.map(s => s.r3)))}, MFE 평균 ${P(mean(sigs.map(s => s.mfe)))}, MAE 평균 ${P(mean(sigs.map(s => s.mae)))}`);
console.log(`   +6% 먼저 ${(100 * sigs.filter(s => s.hit6first === 1).length / sigs.length).toFixed(0)}% / −2% 먼저 ${(100 * sigs.filter(s => s.hit6first === -1).length / sigs.length).toFixed(0)}% / 둘 다 안 닿음 ${(100 * sigs.filter(s => s.hit6first === 0).length / sigs.length).toFixed(0)}%`);
const neg2 = sigs.filter(s => s.mae <= -0.02);
console.log(`   −2% 를 찍은 ${neg2.length}건 중 3일 뒤 플러스로 끝난 비율 ${(100 * neg2.filter(s => s.r3 > 0).length / neg2.length).toFixed(0)}%, 그 중 +6% 까지 간 비율 ${(100 * neg2.filter(s => s.mfe >= 0.06).length / neg2.length).toFixed(0)}%`);
console.log('\n   MFE(최고점) 시각 분포 — 진입 후 몇 번째 4h봉에서 고점을 찍나 (MFE≥+6% 인 승자만)');
const win = sigs.filter(s => s.mfe >= 0.06);
const hist = (xs: number[]) => [1, 2, 3, 6, 12, 18].map((u, j, arr) => { const lo = j ? arr[j - 1] : 0; return `${lo + 1}~${u}봉 ${(100 * xs.filter(x => x > lo && x <= u).length / xs.length).toFixed(0)}%`; }).join(' · ');
console.log('   ' + hist(win.map(s => s.tMfe)));
console.log('   MAE(최저점) 시각 분포 (전체):');
console.log('   ' + hist(sigs.map(s => s.tMae)));
console.log('\n② 진입 조건별 3일 수익 — IS/OOS 둘 다 같은 방향이어야 의미 있음 (5분위, 1=낮음)');
const feats: Array<[string, (s: Sig) => number]> = [['BTC 7일 수익', s => s.btc7], ['자기 7일 수익', s => s.own7], ['거래량 z', s => s.vz],
  ['돌파 폭', s => s.brk], ['신호봉 몸통', s => s.body]];
for (const [lab, f] of feats) {
  const row = (xs: Sig[]) => { const so = xs.slice().sort((a, b) => f(a) - f(b)); const q = 5; return Array.from({ length: q }, (_, j) => P(mean(so.slice(Math.floor(j * so.length / q), Math.floor((j + 1) * so.length / q)).map(s => s.r3))).padStart(8)).join(''); };
  console.log(`   ${lab.padEnd(12)} IS ${row(sigs.filter(s => s.ts < SPLIT))}   OOS ${row(sigs.filter(s => s.ts >= SPLIT))}`);
}
console.log('\n③ 신호봉 시각(KST 봉 시작) — 라이브에서 09·21시 진입이 좋아 보였던 것 검증');
for (const h of [1, 5, 9, 13, 17, 21]) {
  const xs = sigs.filter(s => s.hour === h);
  console.log(`   ${String(h).padStart(2)}시봉 ${String(xs.length).padStart(4)}건  IS ${P(mean(xs.filter(s => s.ts < SPLIT).map(s => s.r3))).padStart(8)}  OOS ${P(mean(xs.filter(s => s.ts >= SPLIT).map(s => s.r3))).padStart(8)}`);
}
console.log('\n④ 코인 효과 지속성 — IS 상위/하위 1/3 코인이 OOS 에서도 그런가');
const byC = (xs: Sig[]) => { const g = new Map<string, number[]>(); for (const s of xs) { if (!g.has(s.m)) g.set(s.m, []); g.get(s.m)!.push(s.r3); } return new Map([...g].map(([k, v]) => [k, mean(v)])); };
const isC = byC(sigs.filter(s => s.ts < SPLIT)), oosC = byC(sigs.filter(s => s.ts >= SPLIT));
const ranked = [...isC].filter(([k]) => oosC.has(k)).sort((a, b) => b[1] - a[1]).map(([k]) => k);
const third = Math.floor(ranked.length / 3);
for (const [lab, set] of [['IS 상위', ranked.slice(0, third)], ['IS 중위', ranked.slice(third, 2 * third)], ['IS 하위', ranked.slice(2 * third)]] as Array<[string, string[]]>)
  console.log(`   ${lab}  IS ${P(mean(set.map(k => isC.get(k)!))).padStart(8)}  → OOS ${P(mean(set.map(k => oosC.get(k)!))).padStart(8)}`);
