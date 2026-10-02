#!/usr/bin/env tsx
/**
 * ALT_SWING paper tick — 매일 KST 09:03 (`3 9 * * *`). 규칙은 src/lib/paper-altswing-store.ts.
 *
 * 1) 업비트 KRW 전 종목 일봉 캐시를 갱신(종목당 1요청, 초당 ~4회 — 약 70초).
 * 2) 마지막 처리일 이후 확정된 날을 차례로 재생: 보유분 익절(일봉 고가 관통)·시간청산을 처리.
 *    지난 날(맥 수면 등으로 놓친 날)의 신규 진입은 재생하지 않는다 — 진입 지연에 민감한 전략이라 늦은 진입은 의미가 없다.
 * 3) 어제 확정봉 기준 신호로 오늘 진입(09:00 에서 1시간 이내일 때만).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import { isWarningBlocked } from '@/lib/paper-warning';
import {
  AS_CACHE_DIR, AS_TRADES_FILE, AS_TICKS_FILE, AS_FEE, AS_TOP_N, AS_SLOTS, AS_POSITION_PCT, AS_TP_PCT, AS_TP_PEN,
  AS_HOLD_DAYS, AS_MAX_LATE_MS, AS_STABLE, asSlip, breakout7, withAsState, type DayBar,
} from '@/lib/paper-altswing-store';

const DAY = 86400_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshCache(markets: string[]): Promise<Map<string, DayBar[]>> {
  if (!fs.existsSync(AS_CACHE_DIR)) fs.mkdirSync(AS_CACHE_DIR, { recursive: true });
  const out = new Map<string, DayBar[]>();
  for (const m of markets) {
    const f = path.join(AS_CACHE_DIR, `${m}.json`);
    let bars: DayBar[] = [];
    try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 새 종목 */ }
    try {
      const raw = await getUpbitClient().getCandlesDays(m, bars.length >= 60 ? 10 : 100);
      const fresh = (raw as any[]).map((x) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, value: x.candle_acc_trade_price }));
      const by = new Map(bars.map((b) => [b.ts, b]));
      for (const b of fresh) by.set(b.ts, b);
      bars = [...by.values()].sort((a, b) => a.ts - b.ts).slice(-150);
      fs.writeFileSync(f, JSON.stringify(bars));
    } catch (e: any) { console.log(`[cache] ${m} 실패: ${e?.message || e}`); }
    out.set(m, bars);
    await sleep(250);
  }
  return out;
}

(async () => {
  const now = Date.now();
  console.log(`\n=== ALT_SWING paper tick @ ${kstISO(now).slice(0, 19)} ===`);
  const markets = ((await getUpbitClient().getMarkets(false)) as any[]).map((x) => x.market as string)
    .filter((m) => m.startsWith('KRW-') && !AS_STABLE.has(m.slice(4)));
  const all = await refreshCache(markets);
  // 확정봉만 (시작 + 24h ≤ now)
  const done = new Map([...all].map(([m, b]) => [m, b.filter((x) => x.ts + DAY <= now)]));
  const btc = done.get('KRW-BTC') || [];
  const D = btc.length ? btc[btc.length - 1].ts : null;          // 어제(가장 최근 확정일)
  if (D == null) { console.log('BTC 일봉 없음 — skip'); process.exit(1); }
  const idx = (m: string, ts: number) => (done.get(m) || []).findIndex((x) => x.ts === ts);

  await withAsState(async (st) => {
    const startDay = st.lastDayTs == null ? D : st.lastDayTs + DAY;
    let exits = 0;
    for (let j = startDay; j <= D; j += DAY) {
      // ── 청산 (j 일 확정봉 기준)
      for (let p = st.positions.length - 1; p >= 0; p--) {
        const pos = st.positions[p];
        if (j < pos.entryDayTs) continue;
        const b = (done.get(pos.market) || []).find((x) => x.ts === j);
        if (!b) continue;
        const tgt = pos.entryPrice * (1 + AS_TP_PCT / 100);
        const held = Math.round((j - pos.entryDayTs) / DAY) + 1;        // 진입일 포함 확정봉 수
        let px = 0, reason = '';
        if (b.high >= tgt * (1 + AS_TP_PEN)) { px = tgt; reason = 'TP'; }
        else if (held >= AS_HOLD_DAYS + 1) { px = b.close * (1 - asSlip(pos.market)); reason = 'TIME'; }
        if (!px) continue;
        const got = pos.vol * px * (1 - AS_FEE);
        const profitKrw = got - pos.cashUsed;
        st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw;
        fs.appendFileSync(AS_TRADES_FILE, JSON.stringify({
          market: pos.market, entryTs: pos.entryTs, exitTs: j, entryDate: pos.entryDate, exitDate: kstISO(j),
          entryPrice: pos.entryPrice, exitPrice: px, profitRate: (px - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
          reason, recordedAt: new Date().toISOString(),
        }) + '\n');
        st.positions.splice(p, 1); exits++;
        console.log(`[ALT_SWING] ${kstISO(j).slice(0, 10)} ${reason} ${pos.market} ${((px / pos.entryPrice - 1) * 100).toFixed(2)}% pnl=${profitKrw.toFixed(0)}`);
      }
    }

    // ── 신규 진입: 어제(D) 확정봉 신호 → 오늘
    const late = now - (D + DAY);
    const btcI = btc.length - 1;
    const btcOn = btcI >= 49 && btc[btcI].close > btc.slice(btcI - 49, btcI + 1).reduce((a, x) => a + x.close, 0) / 50;
    // 유니버스: 직전 30일(어제 포함) 거래대금 합 상위 N, 이력 30일 이상, BTC 제외
    const ranked = [...done.entries()]
      .filter(([m, b]) => m !== 'KRW-BTC' && b.length >= 30 && b[b.length - 1].ts === D)
      .map(([m, b]) => [m, b.slice(-30).reduce((a, x) => a + x.value, 0)] as [string, number])
      .sort((a, b) => b[1] - a[1]).slice(0, AS_TOP_N).map(([m]) => m);
    const cands = ranked.map((m) => [m, breakout7(done.get(m)!, idx(m, D))] as [string, number | null])
      .filter((x): x is [string, number] => x[1] != null).sort((a, b) => b[1] - a[1]);
    let entries = 0;
    const why = !btcOn ? 'BTC 50일선 아래 — 진입 없음' : late > AS_MAX_LATE_MS ? `09:00 대비 ${(late / 60000).toFixed(0)}분 지연 — 진입 skip` : '';
    if (!why) {
      const tk = cands.length ? new Map(((await getUpbitClient().getTicker(cands.map(([m]) => m))) as any[]).map((t) => [t.market, t.trade_price as number])) : new Map();
      for (const [m, z] of cands) {
        if (st.positions.length >= AS_SLOTS) break;
        if (st.positions.some((p) => p.market === m)) continue;
        if (isWarningBlocked(m)) { console.log(`[warning] ${m} 진입 차단`); continue; }
        const raw = tk.get(m); if (raw == null) continue;
        const ep = raw * (1 + asSlip(m));
        const used = st.cash * AS_POSITION_PCT; if (used < 5000) continue;
        st.cash -= used;
        st.positions.push({ market: m, entryTs: now, entryDate: kstISO(now), entryPrice: ep, vol: used * (1 - AS_FEE) / ep, cashUsed: used, entryBarsRemaining: 0, entryDayTs: D + DAY });
        entries++;
        console.log(`[ALT_SWING] 진입 ${m} @${ep} z=${z.toFixed(2)} TP=${(ep * (1 + AS_TP_PCT / 100)).toFixed(4)}`);
      }
    } else console.log(`[ALT_SWING] ${why}`);

    st.lastDayTs = D; st.lastTickTs = now; st.lastTickAt = new Date(now).toISOString();
    fs.appendFileSync(AS_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kstISO(now), btcOn, universe: ranked, signals: cands.map(([m, z]) => ({ m, z: +z.toFixed(2) })),
      newEntries: entries, exits, openPositions: st.positions.length, cash: st.cash, ...(why ? { skip: why } : {}),
    }) + '\n');
    console.log(`[ALT_SWING] 유니버스 ${ranked.length} · 신호 ${cands.length} · 진입 ${entries} · 청산 ${exits} · 보유 ${st.positions.length}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[ALT_SWING tick FAIL]', e); process.exit(1); });
