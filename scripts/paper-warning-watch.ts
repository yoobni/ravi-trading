#!/usr/bin/env tsx
/**
 * 경고성 공지 감시 — 10분마다. 규칙은 src/lib/paper-warning.ts.
 *
 * Cron: 5-55/10 * * * * — 매 시 :05, :15 … :55. 전략 tick(:00~:02)과 분을 겹치지 않게 했다.
 *   이 스크립트는 다른 프로세스의 state.json 을 고쳐 쓰므로(프로세스 간 잠금 없음) tick 과 동시에 돌면 안 된다.
 *
 * 하는 일: 새 공지 중 지정·촉구 → 차단 목록 추가, 해제 → 제거.
 *   차단 코인을 보유한 전략이 있으면 그 자리에서 시장가 청산(reason 'WARNING').
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  fetchWarningNotices, readBlockList, writeBlockList, WARNING_DIR, WARNING_LOG_FILE,
} from '@/lib/paper-warning';

const FEE = 0.0005, SLIP = 0.0005;
// F1F2(paper-trading)는 BTC 전용·다른 state 형태라 제외 — BTC 는 유의종목 대상이 될 일이 사실상 없다.
const STRATEGY_DIRS = ['paper-f6', 'paper-f6v6', 'paper-f7', 'paper-f7sl', 'paper-f7p', 'paper-f7btc', 'paper-btctrend'];
const CURSOR = path.join(WARNING_DIR, 'cursor.json');
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();

(async () => {
  const notices = (await fetchWarningNotices(2)).sort((a, b) => a.id - b.id);
  let lastId = 0;
  try { lastId = JSON.parse(fs.readFileSync(CURSOR, 'utf8')).lastId || 0; } catch { /* 첫 실행 */ }
  const fresh = notices.filter((n) => n.id > lastId);

  const block = readBlockList();
  for (const n of fresh) {
    for (const m of n.markets) {
      if (n.kind === 'ON') block[m] = { since: n.at, title: n.title };
      else delete block[m];
    }
    fs.mkdirSync(WARNING_DIR, { recursive: true });
    fs.appendFileSync(WARNING_LOG_FILE, JSON.stringify({ ...n, seenAt: new Date().toISOString() }) + '\n');
    console.log(`[warning] ${n.kind} ${n.markets.join(',')} — ${n.title}`);
  }
  if (fresh.length) {
    writeBlockList(block);
    fs.writeFileSync(CURSOR, JSON.stringify({ lastId: Math.max(lastId, ...fresh.map((n) => n.id)) }));
  }

  // 차단 코인 보유분 청산
  const now = Date.now();
  for (const dir of STRATEGY_DIRS) {
    const stateFile = path.resolve(process.cwd(), 'data', dir, 'state.json');
    if (!fs.existsSync(stateFile)) continue;
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const hit = (st.positions || []).filter((p: any) => block[p.market]);
    if (!hit.length) continue;
    for (const pos of hit) {
      let px: number | null = null;
      try { const tk = await getUpbitClient().getTicker([pos.market]); px = tk[0] ? (tk[0] as any).trade_price : null; } catch { /* 다음 주기 재시도 */ }
      if (px == null) continue;
      const exitPrice = px * (1 - SLIP);
      const cashGained = pos.vol * exitPrice * (1 - FEE);
      const profitKrw = cashGained - pos.cashUsed;
      st.cash += cashGained; st.totalRealizedPnl = (st.totalRealizedPnl || 0) + profitKrw; st.totalTrades = (st.totalTrades || 0) + 1;
      st.positions = st.positions.filter((p: any) => p !== pos);
      fs.appendFileSync(path.resolve(process.cwd(), 'data', dir, 'trades.jsonl'), JSON.stringify({
        market: pos.market, entryTs: pos.entryTs, exitTs: now, entryDate: pos.entryDate, exitDate: kstISO(now),
        entryPrice: pos.entryPrice, exitPrice, profitRate: (exitPrice - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
        reason: 'WARNING', note: block[pos.market].title, recordedAt: new Date().toISOString(),
      }) + '\n');
      console.log(`[warning] ${dir} 청산 ${pos.market} @${exitPrice} pnl=${profitKrw.toFixed(0)}`);
    }
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  }
  process.exit(0);
})().catch((e) => { console.error('[warning-watch FAIL]', e); process.exit(1); });
