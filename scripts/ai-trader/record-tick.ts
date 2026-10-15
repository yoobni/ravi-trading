#!/usr/bin/env tsx
/**
 * AI_TRADER 실행 기록 — run.sh 가 claude -p 직후 부른다. 체결 처리 → 평가액 스냅샷 + 이번 실행의 비용·턴·요약을 ticks.jsonl 에.
 * 인자: <claude 결과 json 경로> <종료코드>
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { processFills, withAtState, prices, equityOf, AT_TICKS_FILE, AT_ORDERS_FILE } from '@/lib/paper-aitrader-store';
const kst = (ts: number) => new Date(ts + 9 * 3600e3).toISOString();
(async () => {
  const [file, code] = process.argv.slice(2);
  let r: any = {};
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 실패 실행 */ }
  const fills = await processFills().catch(() => []);
  const now = Date.now();
  const since = now - 20 * 60e3;
  const orders = fs.existsSync(AT_ORDERS_FILE) ? fs.readFileSync(AT_ORDERS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.ts >= since) : [];
  await withAtState(async (st) => {
    const px = await prices(['KRW-BTC', ...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market)]);
    let next: any = null; try { next = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data', 'paper-aitrader', 'next-run.json'), 'utf8')); if (next.nextTs < since) next = null; } catch { /* 없음 */ }
    const eq = equityOf(st, px);
    st.lastTickTs = now; st.lastTickAt = new Date(now).toISOString();
    fs.appendFileSync(AT_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kst(now), exit: Number(code), ok: r.subtype === 'success' && !r.is_error,
      equity: Math.round(eq), cash: Math.round(st.cash), openPositions: st.positions.length, pendingOrders: st.orders.length,
      newEntries: orders.filter((o) => o.side === 'buy' && !o.reject).length, exits: orders.filter((o) => o.side === 'sell' && !o.reject).length,
      rejects: orders.filter((o) => o.reject).length, fills,
      btcPrice: px.get('KRW-BTC') ?? null, nextMinutes: next?.minutes ?? null, nextReason: next?.reason ?? null,
      costUsd: r.total_cost_usd ?? null, turns: r.num_turns ?? null, durationMs: r.duration_ms ?? null,
      inTok: r.usage ? (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) : null, outTok: r.usage?.output_tokens ?? null,
      summary: typeof r.result === 'string' ? r.result.slice(0, 600) : null,
    }) + '\n');
  });
  process.exit(0);
})().catch((e) => { console.error('[AI_TRADER record FAIL]', e); process.exit(1); });
