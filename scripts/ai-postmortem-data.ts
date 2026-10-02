#!/usr/bin/env tsx
/**
 * 사후 분석 입력 — 지난 N시간(기본 24) 동안 청산된 손실 거래를 모든 운영 전략에서 모아, 원인 분류에 필요한 맥락을 붙여 출력한다.
 * 맥락: 보유 중 BTC 변화, 손절이면 체결가가 손절선보다 얼마나 더 나빴나(실행 비용), 그 코인 유의 공지, 그 코인이 언급된 헤드라인, 보유 중 매크로 발표.
 * 분류(규칙대로의 손실 / 실행 문제 / 이벤트)는 Claude Code 세션이 이 출력을 읽고 한다.
 * 사용: npx tsx scripts/ai-postmortem-data.ts [--hours 24]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';

const H = 3600e3;
const DIRS: [string, string][] = [['F7_sl', 'paper-f7sl'], ['F7_btc', 'paper-f7btc'], ['F7_sl_AI', 'paper-f7sl-ai'], ['BTC_TREND', 'paper-btctrend'], ['BTC_ENS', 'paper-btcens'],
  ['ETH_TREND', 'paper-ethtrend'], ['BTC_TREND_AI', 'paper-btctrend-ai'], ['ALT_SWING', 'paper-altswing'], ['USDT_Z', 'paper-usdtz'], ['BTC_DIP', 'paper-btcdip']];
const rd = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const kst = (t: number) => new Date(t + 9 * H).toISOString().slice(5, 16).replace('T', ' ');

(async () => {
  const i = process.argv.indexOf('--hours'); const hours = i > 0 ? +process.argv[i + 1] : 24;
  const now = Date.now(), from = now - hours * H;
  const trades = DIRS.flatMap(([id, d]) => rd(path.resolve('data', d, 'trades.jsonl')).map((t: any) => ({ id, ...t })))
    .filter((t: any) => Date.parse(t.recordedAt) >= from);
  const losses = trades.filter((t: any) => t.profitKrw < 0);
  console.log(`## 지난 ${hours}h 청산 ${trades.length}건 (손실 ${losses.length}건, 수익 ${trades.length - losses.length}건) · 합계 ${Math.round(trades.reduce((a: number, t: any) => a + t.profitKrw, 0)).toLocaleString()}원`);
  if (!losses.length) return;
  const btc = ((await getUpbitClient().getCandlesMinutes(60, 'KRW-BTC', 200)) as any[]).map((c) => ({ ts: new Date(c.candle_date_time_utc + 'Z').getTime(), close: c.trade_price }));
  const btcAt = (t: number) => { let v: number | null = null; for (const b of btc) if (b.ts <= t && (v == null || b.ts > 0)) v = b.close; return v; };
  const heads = rd(path.resolve('data/ai-feed/headlines.jsonl'));
  const warns = rd(path.resolve('data/paper-warnings/events.jsonl'));
  let macro: Record<string, string[]> = {}; try { macro = JSON.parse(fs.readFileSync('data/research-ext/macro/macro-dates.json', 'utf8')); } catch { /* 없음 */ }
  for (const t of losses as any[]) {
    const sym = t.market.replace('KRW-', '');
    const b0 = btcAt(t.entryTs), b1 = btcAt(t.exitTs);
    const hs = heads.filter((h: any) => h.ts >= t.entryTs - 6 * H && h.ts <= t.exitTs + H && new RegExp(`\\b${sym}\\b`, 'i').test(h.title)).slice(0, 5);
    const ws = warns.filter((w: any) => w.markets.includes(t.market) && Date.parse(w.at) >= t.entryTs - 24 * H);
    const ms = Object.entries(macro).flatMap(([k, v]) => v.map((d) => [k, Date.parse(d) + (k === 'fomc' ? 18 : 12.5) * H] as [string, number]))
      .filter(([, x]) => x >= t.entryTs && x <= t.exitTs).map(([k, x]) => `${k} ${kst(x)}`);
    console.log(`\n### ${t.id} ${t.market} ${t.reason} ${t.profitRate.toFixed(2)}% (${Math.round(t.profitKrw).toLocaleString()}원)`);
    console.log(`- 보유 ${kst(t.entryTs)} → ${kst(t.exitTs)} (${((t.exitTs - t.entryTs) / H).toFixed(1)}h) · 진입 ${t.entryPrice} 청산 ${t.exitPrice}`);
    if (t.reason === 'SL') console.log(`- 손절선 −2% 대비 실제 ${t.profitRate.toFixed(2)}% → 실행 초과손실 ${(t.profitRate + 2).toFixed(2)}%p`);
    console.log(`- 보유 중 BTC ${b0 && b1 ? ((b1 / b0 - 1) * 100).toFixed(2) + '%' : '자료없음'}`);
    console.log(`- 유의 공지: ${ws.length ? ws.map((w: any) => w.title).join(' / ') : '없음'} · 매크로: ${ms.length ? ms.join(', ') : '없음'}`);
    console.log(`- 관련 헤드라인: ${hs.length ? hs.map((h: any) => `[${kst(h.ts)}] ${h.title}`).join(' | ') : '없음'}`);
  }
})();
