/**
 * 진단 — 엣지 감쇠가 "국면"인가 "알파 소멸"인가 (2026-10-01)
 *
 * 2022~2026 에서 후보·A2 모두 2025~2026 에 거의 0 이 됐다. 두 설명이 가능하다:
 *   (A) 국면 — 암호화폐 전체가 횡보/하락이라 모멘텀이 안 먹힌다. 시장이 돌면 돌아온다.
 *   (B) 알파 소멸 — 신호 자체의 예측력이 사라졌다. 돌아오지 않는다.
 *
 * 가르는 방법: **청산·사이징·슬롯을 전부 제거하고 원시 드리프트만** 본다.
 *   "신호 다음 봉 시가에 사서 N봉 들고 있으면 평균 몇 %인가" — 연도별로.
 *   대조군은 같은 기간 **무작위 시점 보유**(= 시장 자체의 드리프트).
 *   신호 드리프트 − 시장 드리프트 = 신호의 순수 정보량. 이게 줄었으면 (B), 유지되면 (A).
 */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const f = fs.readdirSync(DIR).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] | null = null;
  for (const x of f) { const d = JSON.parse(fs.readFileSync(path.join(DIR, x), 'utf8')) as Bar[]; if (!best || d.length > best.length) best = d; }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
const D: Array<{ m: string; b: Bar[] }> = [];
for (const m of COINS) { const b = load(m); if (b && b.length > 500) D.push({ m, b }); }
const volZ = (b: Bar[], i: number, w = 30) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(b, i) >= 0.5;

const YEARS: Array<[string, number, number]> = [
  ['2022H2', Date.UTC(2022,6,1), Date.UTC(2022,11,31)], ['2023', Date.UTC(2023,0,1), Date.UTC(2023,11,31)],
  ['2024', Date.UTC(2024,0,1), Date.UTC(2024,11,31)], ['2025', Date.UTC(2025,0,1), Date.UTC(2025,11,31)],
  ['2026YTD', Date.UTC(2026,0,1), Date.UTC(2026,11,31)]];
const HOLDS = [6, 18, 42];   // 1일 / 3일 / 7일

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

console.log('원시 드리프트: 신호 다음 봉 시가 매수 → N봉 뒤 종가. 마찰·청산·슬롯 전부 없음.\n');
console.log('연도      신호수  ' + HOLDS.map(h => `[${h/6}일] 신호  시장   순수`.padStart(26)).join(''));
for (const [lab, a, b] of YEARS) {
  const out: string[] = []; let nsig = 0;
  for (const h of HOLDS) {
    const S: number[] = [], M: number[] = [];
    for (const d of D) {
      for (let i = 43; i < d.b.length - h - 2; i++) {
        if (d.b[i].ts < a || d.b[i].ts > b) continue;
        const r = d.b[i + 1 + h].close / d.b[i + 1].open - 1;
        if (sig(d.b, i)) S.push(r);
        else if (rnd() < 0.02) M.push(r);        // 같은 기간 무작위 시점 = 시장 드리프트
      }
    }
    if (h === HOLDS[0]) nsig = S.length;
    const ms = S.length ? 100 * S.reduce((p, q) => p + q, 0) / S.length : 0;
    const mm = M.length ? 100 * M.reduce((p, q) => p + q, 0) / M.length : 0;
    out.push(`${((ms>=0?'+':'')+ms.toFixed(2)+'%').padStart(9)}${((mm>=0?'+':'')+mm.toFixed(2)+'%').padStart(8)}${((ms-mm>=0?'+':'')+(ms-mm).toFixed(2)+'%p').padStart(9)}`);
  }
  console.log(`${lab.padEnd(9)} ${String(nsig).padStart(5)}  ` + out.join(''));
}
console.log('\n※ "순수" = 신호 − 시장. 이게 줄었으면 알파 소멸, 유지되면 국면 문제.');
