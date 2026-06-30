/**
 * Paper trading forward-return tick — 매시간 cron.
 *
 * 미finalized 신호에 대해 1h/4h/1d/3d/5d return 갱신.
 * 각 marker는 signalTime + N 시점의 Upbit KRW-BTC 1분 캔들 가격으로 산출.
 *
 * 모든 marker가 채워지면 finalized = true.
 * return_until_exit_rule은 paper-trading-tick.ts의 청산 시점에서 직접 갱신.
 */
import 'dotenv/config';
import {
  readJsonl,
  rewriteJsonl,
  FORWARD_RETURNS_FILE,
  type ForwardReturnRecord,
} from '@/lib/paper-trading-store';
import { withFileLock } from '@/lib/file-lock';
import { getUpbitClient } from '@/lib/upbit-client';

type Marker = { key: 'return_1h' | 'return_4h' | 'return_1d' | 'return_3d' | 'return_5d'; hours: number };

const MARKERS: Marker[] = [
  { key: 'return_1h', hours: 1 },
  { key: 'return_4h', hours: 4 },
  { key: 'return_1d', hours: 24 },
  { key: 'return_3d', hours: 72 },
  { key: 'return_5d', hours: 120 },
];

async function fetchUpbitPriceAt(timeIso: string): Promise<number | null> {
  try {
    const client = getUpbitClient();
    const candles = await client.getCandlesMinutes(1, 'KRW-BTC', 1, timeIso);
    return candles[0]?.trade_price ?? null;
  } catch (e: any) {
    console.error(`  price fetch fail @${timeIso}: ${e?.message ?? e}`);
    return null;
  }
}

async function fetchUpbitCurrentPrice(): Promise<number | null> {
  try {
    const client = getUpbitClient();
    const tickers = await client.getTicker(['KRW-BTC']);
    return tickers[0]?.trade_price ?? null;
  } catch {
    return null;
  }
}

function allMarkersFilled(r: ForwardReturnRecord): boolean {
  return MARKERS.every((m) => r[m.key] != null);
}

(async () => {
  const now = new Date();
  console.log(`\n=== Forward Return Tick ${now.toISOString()} ===`);

  await withFileLock(FORWARD_RETURNS_FILE, async () => {
    const records = readJsonl<ForwardReturnRecord>(FORWARD_RETURNS_FILE);
    if (records.length === 0) {
      console.log(`[skip] no forward-return records`);
      return;
    }

    let touched = 0;
    for (const r of records) {
      if (r.finalized) continue;

      const signalT = new Date(r.signalTime).getTime();
      const elapsedH = (now.getTime() - signalT) / 3600_000;

      for (const m of MARKERS) {
        if (r[m.key] != null) continue;
        if (elapsedH < m.hours) continue;

        // 정확한 시점 가격 시도. 미래 시점이면 null
        const targetMs = signalT + m.hours * 3600_000;
        const targetIso = new Date(targetMs).toISOString();
        let price = await fetchUpbitPriceAt(targetIso);
        if (price == null && elapsedH - m.hours < 1) {
          // marker 막 도달 — 현재가로 대체
          price = await fetchUpbitCurrentPrice();
        }
        if (price == null) continue;

        const ret = (price - r.priceAtSignal) / r.priceAtSignal * 100;
        r[m.key] = ret;
        r.lastUpdated = now.toISOString();
        touched += 1;
        console.log(`  ${r.signalId} ${m.key}=${ret.toFixed(3)}% (price=${price.toFixed(0)})`);
      }

      if (allMarkersFilled(r) && !r.finalized) {
        r.finalized = true;
        r.lastUpdated = now.toISOString();
        console.log(`  ${r.signalId} FINALIZED`);
      }
    }

    if (touched > 0) {
      rewriteJsonl(FORWARD_RETURNS_FILE, records);
      console.log(`\n[save] ${touched} markers updated, ${records.filter((r) => r.finalized).length}/${records.length} finalized`);
    } else {
      console.log(`[noop] no markers needed updating`);
    }
  });

  console.log(`=== Forward Return Tick complete ===`);
  process.exit(0);
})();
