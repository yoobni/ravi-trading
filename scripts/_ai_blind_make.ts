/**
 * 축 P — AI 판단 블라인드 백테스트: 스냅샷 생성 (2026-10-02)
 * 날짜·코인명·절대가격 제거, 정규화 지표만. 순서 셔플·무작위 ID. 결과(미래 수익)는 별도 파일에 저장하고 출력하지 않는다.
 * 기간: 2020-04 ~ (펀딩 이력 확보 이후) · 7일 간격(무작위 시작 오프셋) → 7일 보유 구간이 겹치지 않음.
 */
import fs from 'fs';
import crypto from 'crypto';
const D = 'data/research-ext/ai-blind';
const btc: any[] = JSON.parse(fs.readFileSync('data/research-ext/daily/KRW-BTC.json', 'utf8'));
const fng: any[] = JSON.parse(fs.readFileSync(`${D}/fng.json`, 'utf8')).data.map((x: any) => ({ ts: +x.timestamp * 1000, v: +x.value })).sort((a: any, b: any) => a.ts - b.ts);
const fund: [number, number][] = JSON.parse(fs.readFileSync('data/research-ext/binance/funding/BTC.json', 'utf8'));
const DAY = 86400e3;
const fngAt = (ts: number) => { let v = null as number | null; for (const x of fng) { if (x.ts <= ts) v = x.v; else break; } return v; };
// 일별 펀딩 평균(그날 UTC 정산분), 확정된 날만
const fundDay = new Map<number, number[]>();
for (const [t, r] of fund) { const k = Math.floor(t / DAY) * DAY; if (!fundDay.has(k)) fundDay.set(k, []); fundDay.get(k)!.push(r); }
const fundDaily = [...fundDay].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as [number, number]).sort((a, b) => a[0] - b[0]);
const sma = (i: number, n: number) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += btc[j].close; return s / n; };
const pctRank = (arr: number[], x: number) => arr.length ? 100 * arr.filter(v => v <= x).length / arr.length : 50;
let seed = 20261002; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const start = Date.UTC(2020, 3, 1) + Math.floor(rnd() * 7) * DAY;
const idxOf = new Map(btc.map((b, i) => [b.ts, i]));
const snaps: any[] = [], outs: any[] = [];
for (let t = start; ; t += 7 * DAY) {
  // 판단 시점 = 일봉 t 가 막 시작한 순간(KST 09:00). 정보 = 직전 확정 일봉(i-1)까지. 체결 = 일봉 t 시가.
  const i = idxOf.get(t); if (i === undefined) { if (t > btc[btc.length - 1].ts) break; continue; }
  if (i + 7 >= btc.length) break;
  const c = i - 1; // 확정 마지막 봉
  if (c < 400) continue;
  const cl = btc[c].close;
  const r = (n: number) => +(100 * (cl / btc[c - n].close - 1)).toFixed(1);
  const lr = Array.from({ length: 30 }, (_, k) => Math.log(btc[c - k].close / btc[c - k - 1].close));
  const vol30 = Math.sqrt(lr.reduce((a, b) => a + b * b, 0) / 30) * Math.sqrt(365) * 100;
  const volHist: number[] = []; for (let j = c - 365; j < c; j += 5) { const l2 = Array.from({ length: 30 }, (_, k) => Math.log(btc[j - k].close / btc[j - k - 1].close)); volHist.push(Math.sqrt(l2.reduce((a, b) => a + b * b, 0) / 30) * Math.sqrt(365) * 100); }
  const hi60 = Math.max(...btc.slice(c - 59, c + 1).map(b => b.high)), hi365 = Math.max(...btc.slice(c - 364, c + 1).map(b => b.high));
  const lo60 = Math.min(...btc.slice(c - 59, c + 1).map(b => b.low));
  const vals = btc.slice(c - 20, c).map(b => b.value), mv = vals.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(vals.reduce((a, b) => a + (b - mv) ** 2, 0) / 20);
  const fdHist = fundDaily.filter(([k]) => k < btc[c].ts + DAY);
  const f7 = fdHist.slice(-7).map(x => x[1]); const f7m = f7.reduce((a, b) => a + b, 0) / Math.max(f7.length, 1);
  const f7hist: number[] = []; for (let j = 7; j <= fdHist.length; j++) f7hist.push(fdHist.slice(j - 7, j).reduce((a, b) => a + b[1], 0) / 7);
  const fg = fngAt(btc[c].ts), fg7 = fngAt(btc[c].ts - 7 * DAY);
  const weekly = Array.from({ length: 8 }, (_, k) => +(100 * (btc[c - 7 * (7 - k)].close / btc[c - 7 * (8 - k)].close - 1)).toFixed(1));
  const id = crypto.createHash('sha1').update(String(t) + 'blind').digest('hex').slice(0, 6);
  snaps.push({ id, r1: r(1), r7: r(7), r30: r(30), r60: r(60),
    s20: +(100 * (cl / sma(c, 20) - 1)).toFixed(1), s50: +(100 * (cl / sma(c, 50) - 1)).toFixed(1), s100: +(100 * (cl / sma(c, 100) - 1)).toFixed(1), s200: +(100 * (cl / sma(c, 200) - 1)).toFixed(1),
    dd60: +(100 * (cl / hi60 - 1)).toFixed(1), dd365: +(100 * (cl / hi365 - 1)).toFixed(1), up60: +(100 * (cl / lo60 - 1)).toFixed(1),
    volPct: Math.round(pctRank(volHist, vol30)), volZ: +(sd ? (btc[c].value - mv) / sd : 0).toFixed(1),
    fg, fgChg7: fg != null && fg7 != null ? fg - fg7 : null, fundPct: Math.round(pctRank(f7hist.slice(-730), f7m)), weekly });
  // 결과: 7일 보유 = 일봉 t 시가 → 일봉 t+7 시가
  outs.push({ id, t, date: btc[i].date, fwd7: btc[i + 7].open / btc[i].open - 1, trend: btc[c].close > sma(c, 50) ? 1 : 0 });
}
// 셔플
for (let k = snaps.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [snaps[k], snaps[j]] = [snaps[j], snaps[k]]; }
const lines = snaps.map(s => `${s.id} | r1 ${s.r1} r7 ${s.r7} r30 ${s.r30} r60 ${s.r60} | sma20 ${s.s20} sma50 ${s.s50} sma100 ${s.s100} sma200 ${s.s200} | dd60 ${s.dd60} dd365 ${s.dd365} up60 ${s.up60} | volPct ${s.volPct} volZ ${s.volZ} | FG ${s.fg} (${s.fgChg7 >= 0 ? '+' : ''}${s.fgChg7}) fundPct ${s.fundPct} | wk ${s.weekly.join(' ')}`);
fs.writeFileSync(`${D}/snapshots.txt`, lines.join('\n') + '\n');
fs.writeFileSync(`${D}/outcomes.SEALED.json`, JSON.stringify(outs));
console.log('snapshots', snaps.length, '(outcomes sealed, not printed)');
