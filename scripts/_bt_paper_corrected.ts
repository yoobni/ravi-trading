/**
 * 페이퍼 기록을 "업비트에서 실제로 가능한 체결"로 재채점 (2026-10-01).
 *
 * 보정 원칙:
 *   TP   — 보정 없음. 업비트는 지정가 주문을 지원하므로 "+5% 에 팔아라"를 미리 걸 수 있고
 *          그 가격에 실제로 체결된다. 페이퍼 기록이 맞다.
 *   TIME — 보정 없음. 원래 봉 종가로 정산하므로 이미 현실.
 *   SL / TRAIL — 보정. 스톱 주문 생성이 API 에 없으니 트리거 가격엔 못 팔고,
 *          크론이 확인하는 시점(= 트리거가 난 4h 봉의 종가) 시장가로 나간다.
 *
 * cashUsed 는 profitKrw = cashUsed*((1-FEE)^2*exit/entry - 1) 로 역산 (프로젝트 표준).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const FOUR_H = 4 * 3600_000, FEE = 0.0005, SLIP = 0.0005;
const CACHE = path.resolve(process.cwd(), 'data', 'candle-cache');
const DIRS: Array<[string, string, number]> = [
  ['paper-f6', 'F6', 1e7], ['paper-f6v2', 'F6_v2', 1e7], ['paper-f6v3', 'F6_v3', 1e7],
  ['paper-f6v5', 'F6_v5', 1e7], ['paper-f6v6', 'F6_v6', 1e7], ['paper-f6v7', 'F6_v7', 1e7],
  ['paper-f6v8', 'F6_v8', 1e7],
];
interface Bar { ts: number; open: number; high: number; low: number; close: number }

/** 4h 봉: 캐시(2022~2026-08-20) + 최근분은 API 로 보충 */
const bars = new Map<string, Bar[]>();
function fromCache(m: string): Bar[] {
  const fs_ = fs.readdirSync(CACHE).filter(x => x.startsWith(`${m}_240m_`));
  let best: Bar[] = [];
  for (const x of fs_) { const d = JSON.parse(fs.readFileSync(path.join(CACHE, x), 'utf8')) as Bar[]; if (d.length > best.length) best = d; }
  return best;
}
async function fetchRecent(m: string): Promise<Bar[]> {
  const c = await getUpbitClient().getCandlesMinutes(240, m, 200);
  return c.map((x: any) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price }));
}
async function barsFor(m: string): Promise<Bar[]> {
  if (bars.has(m)) return bars.get(m)!;
  const a = fromCache(m); let b: Bar[] = [];
  try { b = await fetchRecent(m); await new Promise(r => setTimeout(r, 130)); } catch { /* 캐시만으로 */ }
  const seen = new Set<number>(); const out: Bar[] = [];
  for (const x of [...a, ...b]) { if (!seen.has(x.ts)) { seen.add(x.ts); out.push(x); } }
  out.sort((p, q) => p.ts - q.ts); bars.set(m, out); return out;
}

const GAPS: Record<string, number[]> = {};
(async () => {
  console.log('페이퍼 기록 재채점 — TP/TIME 은 그대로, SL/TRAIL 만 "확인시점 시장가"로 보정\n');
  console.log('전략      기록 실현손익   보정 실현손익      차이    보정대상/전체  미측정');
  let tRec = 0, tCor = 0;
  const rows: Array<[string, number, number, number]> = [];
  for (const [d, name] of DIRS) {
    const tr = JSON.parse('[' + fs.readFileSync(`data/${d}/trades.jsonl`, 'utf8').trim().split('\n').join(',') + ']');
    let rec = 0, cor = 0, n = 0, miss = 0;
    for (const t of tr) {
      rec += t.profitKrw;
      if (t.reason === 'TP' || t.reason === 'TIME') { cor += t.profitKrw; continue; }
      const bs = await barsFor(t.market);
      const bar = bs.find(b => b.ts <= t.exitTs && t.exitTs < b.ts + FOUR_H);
      if (!bar) { cor += t.profitKrw; miss++; continue; }
      const k = (1 - FEE) ** 2 * t.exitPrice / t.entryPrice - 1;
      const cash = k ? t.profitKrw / k : 0;
      // 확인 시점 = 트리거 봉의 마감. 그 종가에 시장가 매도(슬리피지 동일 적용)
      const mktExit = bar.close * (1 - SLIP);
      cor += cash * ((1 - FEE) ** 2 * mktExit / t.entryPrice - 1);
      (GAPS[t.reason] ??= []).push(100 * (bar.close / t.exitPrice - 1));
      n++;
    }
    tRec += rec; tCor += cor; rows.push([name, rec, cor, tr.length]);
    console.log(`${name.padEnd(9)} ${rec.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)} ${cor.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(14)} ${(cor - rec).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)}    ${String(n).padStart(3)}/${String(tr.length).padEnd(3)}      ${miss}`);
  }
  console.log(`${'합계'.padEnd(9)} ${tRec.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)} ${tCor.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(14)} ${(tCor - tRec).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)}`);
  console.log('\n── 전략별 수익률 (1,000만 기준, 현재 전 전략 포지션 0 이라 실현손익이 곧 성적) ──');
  console.log('전략        기록 수익률   보정 수익률');
  for (const [name, rec, cor] of rows) {
    console.log(`${name.padEnd(11)} ${((rec / 1e7 * 100 >= 0 ? '+' : '') + (rec / 1e7 * 100).toFixed(2) + '%').padStart(10)} ${((cor / 1e7 * 100 >= 0 ? '+' : '') + (cor / 1e7 * 100).toFixed(2) + '%').padStart(13)}`);
  }
  console.log('\n── 보정 대상 거래의 체결격차 (확인시점 종가 vs 트리거가격) ──');
  for (const [r, v] of Object.entries(GAPS)) {
    const s2 = [...v].sort((a, b) => a - b);
    const pos = v.filter(x => x > 0).length;
    console.log(`  ${r.padEnd(6)} n=${String(v.length).padStart(3)}  평균 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}%  중앙 ${s2[Math.floor(s2.length / 2)].toFixed(3)}%  최악 ${s2[0].toFixed(2)}%  유리했던 비율 ${(100 * pos / v.length).toFixed(0)}%`);
  }
  console.log(`\n7전략 합계 (7,000만): 기록 ${(tRec / 7e7 * 100).toFixed(2)}% → 보정 ${(tCor / 7e7 * 100).toFixed(2)}%`);
})();
