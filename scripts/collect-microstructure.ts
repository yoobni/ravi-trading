#!/usr/bin/env tsx
/**
 * 마이크로구조 수집기 — 캔들에 없는 정보를 지금부터 쌓는다.
 *
 * 왜 지금 시작하는가: 지금까지의 리서치는 전부 같은 데이터(28코인 OHLCV)를 다른 해상도로
 *   자른 것이라 정보량이 늘지 않았고, 그래서 신호·필터·타임프레임이 전부 탈락했다.
 *   호가창과 체결 방향은 봉 데이터로 **복원 불가능한** 새 정보인데,
 *   업비트가 과거를 주지 않으므로 수집을 시작한 시점부터만 존재한다.
 *   → 늦게 시작할수록 백테스트 가능 시점이 그만큼 밀린다. 판단은 데이터가 쌓인 뒤에 한다.
 *
 * 수집 항목(스냅샷당 코인 1행):
 *   [호가] 스프레드, mid 대비 밴드별(0.1/0.3/0.5/1.0%) 누적 매수·매도 잔량(원화),
 *          밴드별 불균형 = (매수−매도)/(매수+매도), 전체 잔량.
 *   [체결] 직전 수집 이후 체결의 매수공격/매도공격 금액(ask_bid 기준), 건수, 최대 단일 체결.
 *          ask_bid 는 캔들에 아예 없는 축이다 — 같은 양봉이라도 누가 밀었는지가 다르다.
 *
 * 실행: 1분마다 cron. 체결은 sequential_id 커서로 중복 제거하며,
 *   200건으로 구간을 못 덮으면 truncated=true 로 표시한다(그 행은 체결 지표를 신뢰하지 말 것).
 *
 * 저장: data/microstructure/YYYY-MM-DD.jsonl (KST 일자). 하루 약 28×1440행.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import { withFileLock } from '@/lib/file-lock';
import { F6_COINS } from '@/lib/paper-f6-store';

const DIR = path.resolve(process.cwd(), 'data', 'microstructure');
const CURSOR_FILE = path.join(DIR, '_cursor.json');
const BANDS = [0.001, 0.003, 0.005, 0.01] as const;

interface Cursor { [market: string]: { lastSeq: number; lastTs: number } }

const kstDate = (ts: number) => new Date(ts + 9 * 3600_000).toISOString().slice(0, 10);
/** 원화 금액은 소수점이 무의미하므로 정수로, 비율은 4자리로 — 파일 크기를 줄인다 */
const r0 = (v: number) => Math.round(v);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

async function main() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const client = getUpbitClient();
  const now = Date.now();

  const cursor: Cursor = fs.existsSync(CURSOR_FILE)
    ? JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'))
    : {};

  // ── 호가: 28종목을 한 번에 (요청 1회)
  let books;
  try {
    books = await client.getOrderbook([...F6_COINS]);
  } catch (e) {
    console.error('[orderbook FAIL]', (e as Error)?.message ?? e);
    return;
  }
  const bookByMarket = new Map(books.map((b) => [b.market, b]));

  const rows: string[] = [];
  let okBooks = 0, okTrades = 0, truncatedCount = 0;

  for (const market of F6_COINS) {
    const ob = bookByMarket.get(market);
    if (!ob || !ob.orderbook_units?.length) continue;
    okBooks++;

    const bestAsk = ob.orderbook_units[0].ask_price;
    const bestBid = ob.orderbook_units[0].bid_price;
    const mid = (bestAsk + bestBid) / 2;
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

    // 밴드별 누적 잔량(원화). 호가 15단계 안에서만 집계되므로 넓은 밴드는 포화될 수 있다.
    const bandBid: number[] = [], bandAsk: number[] = [], bandImb: number[] = [];
    for (const band of BANDS) {
      let bk = 0, ak = 0;
      for (const u of ob.orderbook_units) {
        if (u.bid_price >= mid * (1 - band)) bk += u.bid_price * u.bid_size;
        if (u.ask_price <= mid * (1 + band)) ak += u.ask_price * u.ask_size;
      }
      bandBid.push(bk); bandAsk.push(ak);
      bandImb.push(bk + ak > 0 ? (bk - ak) / (bk + ak) : 0);
    }

    // ── 체결: 직전 수집 이후 신규분만
    let buyKrw = 0, sellKrw = 0, nTrades = 0, maxKrw = 0, truncated = false;
    let newSeq = cursor[market]?.lastSeq ?? 0;
    try {
      const ticks = await client.getTradesTicks(market, 200);
      okTrades++;
      const prevSeq = cursor[market]?.lastSeq ?? 0;
      for (const t of ticks) {
        if (prevSeq && t.sequential_id <= prevSeq) continue;
        const krw = t.trade_price * t.trade_volume;
        if (t.ask_bid === 'BID') buyKrw += krw; else sellKrw += krw;
        maxKrw = Math.max(maxKrw, krw);
        nTrades++;
        newSeq = Math.max(newSeq, t.sequential_id);
      }
      // 200건 전부가 신규 = 그 사이 체결을 다 못 봤을 수 있다
      if (prevSeq && nTrades >= ticks.length && ticks.length >= 200) { truncated = true; truncatedCount++; }
      if (!prevSeq) truncated = true;   // 첫 수집은 구간 정의가 없다
    } catch {
      truncated = true;
    }
    cursor[market] = { lastSeq: newSeq, lastTs: now };

    rows.push(JSON.stringify({
      ts: now,
      m: market,
      mid: mid,
      spreadBps: r4(spreadBps),
      // 밴드 0.1/0.3/0.5/1.0%
      bid: bandBid.map(r0), ask: bandAsk.map(r0), imb: bandImb.map(r4),
      totBid: r0(ob.total_bid_size * mid), totAsk: r0(ob.total_ask_size * mid),
      buyKrw: r0(buyKrw), sellKrw: r0(sellKrw), nTrades, maxKrw: r0(maxKrw),
      takerImb: buyKrw + sellKrw > 0 ? r4((buyKrw - sellKrw) / (buyKrw + sellKrw)) : 0,
      truncated,
    }));
    await new Promise((r) => setTimeout(r, 110));
  }

  const outFile = path.join(DIR, `${kstDate(now)}.jsonl`);
  fs.appendFileSync(outFile, rows.join('\n') + '\n');
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor));
  console.log(`[micro] ${new Date(now + 9 * 3600_000).toISOString().slice(0, 19)} rows=${rows.length} books=${okBooks} trades=${okTrades} truncated=${truncatedCount} → ${path.basename(outFile)}`);
}

// 1분 주기라 앞선 실행이 밀리면 겹칠 수 있다 — 락으로 중복 수집을 막는다.
withFileLock(CURSOR_FILE, main)
  .then(() => process.exit(0))
  .catch((e) => { console.error('[micro FAIL]', e); process.exit(1); });
