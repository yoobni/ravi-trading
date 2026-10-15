#!/usr/bin/env tsx
/**
 * RS_LAG paper tick — 매일 KST 09:08 (`8 9 * * *`). 규칙은 src/lib/paper-rslag-store.ts.
 *
 * 1) 일봉은 ALT_SWING 캐시(data/paper-altswing/daily-cache, 09:03 tick 이 갱신)를 공유한다.
 *    어제 확정봉이 없는 종목만 직접 받아 채운다 — ALT_SWING tick 이 빠진 날을 대비.
 * 2) 마지막 처리일 이후 확정된 날을 차례로 재생: 보유분 익절(일봉 고가 관통)·시간청산.
 * 3) 어제 확정봉 기준 신호로 오늘 진입(09:00 에서 12시간 이내일 때만). 놓친 지난 날의 진입은 재생하지 않는다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from '@/lib/upbit-client';
import { isWarningBlocked } from '@/lib/paper-warning';
import { vetoOf } from '@/lib/paper-ai-veto';
import { readStance } from '@/lib/paper-ai-stance';
import { AS_CACHE_DIR, AS_STABLE, type DayBar } from '@/lib/paper-altswing-store';
import {
  RL_TRADES_FILE, RL_TICKS_FILE, RL_FEE, RL_TOP_N, RL_SLOTS, RL_POSITION_PCT, RL_BTC7_MAX, RL_LOOKBACK, RL_LAG_THR,
  RL_TP_PCT, RL_TP_PEN, RL_HOLD_BARS, RL_MAX_LATE_MS, RL_TWIN, rlSlip, retK, withRlState,
} from '@/lib/paper-rslag-store';
const ID = RL_TWIN ? 'RS_LAG_AI' : 'RS_LAG';

const DAY = 86400_000;
const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadCache(): Map<string, DayBar[]> {
  const out = new Map<string, DayBar[]>();
  if (!fs.existsSync(AS_CACHE_DIR)) return out;
  for (const f of fs.readdirSync(AS_CACHE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(AS_CACHE_DIR, f), 'utf8'))); } catch { /* 손상 — 아래에서 다시 받음 */ }
  }
  return out;
}

/** 어제(D) 확정봉이 없는 종목만 받아 캐시에 병합 (ALT_SWING refreshCache 와 같은 형식) */
async function fillStale(all: Map<string, DayBar[]>, markets: string[], D: number) {
  let n = 0;
  for (const m of markets) {
    const bars = all.get(m) || [];
    if (bars.some((b) => b.ts === D)) continue;
    try {
      const raw = await getUpbitClient().getCandlesDays(m, bars.length >= 60 ? 10 : 100);
      const fresh = (raw as any[]).map((x) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, value: x.candle_acc_trade_price }));
      const by = new Map(bars.map((b) => [b.ts, b]));
      for (const b of fresh) by.set(b.ts, b);
      const merged = [...by.values()].sort((a, b) => a.ts - b.ts).slice(-150);
      fs.writeFileSync(path.join(AS_CACHE_DIR, `${m}.json`), JSON.stringify(merged));
      all.set(m, merged); n++;
    } catch (e: any) { console.log(`[cache] ${m} 실패: ${e?.message || e}`); }
    await sleep(300);
  }
  if (n) console.log(`[cache] 오래된 종목 ${n}개 갱신`);
}

(async () => {
  const now = Date.now();
  console.log(`\n=== ${ID} paper tick @ ${kstISO(now).slice(0, 19)} ===`);
  const D = Math.floor(now / DAY) * DAY - DAY;               // 어제(가장 최근 확정일, UTC 00:00 = KST 09:00 경계)
  const markets = ((await getUpbitClient().getMarkets(false)) as any[]).map((x) => x.market as string)
    .filter((m) => m.startsWith('KRW-') && !AS_STABLE.has(m.slice(4)));
  fs.mkdirSync(AS_CACHE_DIR, { recursive: true });
  // ALT_SWING 09:03 tick 의 캐시 갱신이 끝날 때까지 기다린다(최대 6분) — 도중에 읽으면 유니버스가 어긋나고 fillStale 이 중복 호출을 낸다
  { const t0 = Date.now(); while (Date.now() - t0 < 6 * 60_000) { try { if (JSON.parse(fs.readFileSync(path.join(AS_CACHE_DIR, '.refreshed.json'), 'utf8')).dayTs === D) break; } catch { /* 아직 */ } await sleep(15_000); } }
  const all = loadCache();
  await fillStale(all, markets, D);
  const listed = new Set(markets);
  const done = new Map([...all].filter(([m]) => listed.has(m)).map(([m, b]) => [m, b.filter((x) => x.ts + DAY <= now)]));
  const btc = done.get('KRW-BTC') || [];
  if (!btc.length || btc[btc.length - 1].ts !== D) { console.log('BTC 어제 일봉 없음 — skip'); process.exit(1); }
  const at = (m: string, ts: number) => (done.get(m) || []).findIndex((x) => x.ts === ts);

  await withRlState(async (st) => {
    // ── 청산 재생 (보유 종목만, 확정봉 기준)
    let exits = 0;
    // 상장폐지 등으로 시세가 끊긴 보유분: 마지막 캐시 종가로 강제 청산(없으면 0) — 낙오 코인을 사는 전략이라 특히 중요
    for (const pos of [...st.positions]) {
      if (listed.has(pos.market) && (done.get(pos.market) || []).length) continue;
      const b = all.get(pos.market) || []; const px = b.length ? b[b.length - 1].close * (1 - rlSlip(pos.market)) : 0;
      const got = pos.vol * px * (1 - RL_FEE); const profitKrw = got - pos.cashUsed;
      st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw;
      fs.appendFileSync(RL_TRADES_FILE, JSON.stringify({ market: pos.market, entryTs: pos.entryTs, exitTs: now, entryDate: pos.entryDate, exitDate: kstISO(now), entryPrice: pos.entryPrice, exitPrice: px, profitRate: (px - pos.entryPrice) / pos.entryPrice * 100, profitKrw, reason: 'DELIST', recordedAt: new Date().toISOString() }) + '\n');
      st.positions.splice(st.positions.indexOf(pos), 1); exits++;
      console.log(`[${ID}] 시세 없음(상폐?) ${pos.market} 강제 청산 @${px} pnl=${profitKrw.toFixed(0)}`);
    }
    const startDay = st.lastDayTs == null ? D : st.lastDayTs + DAY;
    for (let j = startDay; j <= D; j += DAY) {
      for (let p = st.positions.length - 1; p >= 0; p--) {
        const pos = st.positions[p];
        if (j < pos.entryDayTs) continue;
        const b = (done.get(pos.market) || []).find((x) => x.ts === j);
        if (!b) continue;
        const tgt = pos.entryPrice * (1 + RL_TP_PCT / 100);
        const held = Math.round((j - pos.entryDayTs) / DAY) + 1;          // 진입일 포함 확정봉 수
        let px = 0, reason = '';
        if (b.high >= tgt * (1 + RL_TP_PEN)) { px = tgt; reason = 'TP'; }
        else if (held >= RL_HOLD_BARS) { px = b.close * (1 - rlSlip(pos.market)); reason = 'TIME'; }
        if (!px) continue;
        const got = pos.vol * px * (1 - RL_FEE);
        const profitKrw = got - pos.cashUsed;
        st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw;
        fs.appendFileSync(RL_TRADES_FILE, JSON.stringify({
          market: pos.market, entryTs: pos.entryTs, exitTs: j, entryDate: pos.entryDate, exitDate: kstISO(j),
          entryPrice: pos.entryPrice, exitPrice: px, profitRate: (px - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
          reason, recordedAt: new Date().toISOString(),
        }) + '\n');
        st.positions.splice(p, 1); exits++;
        console.log(`[${ID}] ${kstISO(j).slice(0, 10)} ${reason} ${pos.market} ${((px / pos.entryPrice - 1) * 100).toFixed(2)}% pnl=${profitKrw.toFixed(0)}`);
      }
    }

    // ── 신규 진입: 어제(D) 확정봉 신호 → 오늘
    const bi = btc.length - 1;
    const btc7 = retK(btc, bi, 7), btc14 = retK(btc, bi, RL_LOOKBACK);
    const regimeOn = btc7 != null && btc7 <= RL_BTC7_MAX;
    const late = now - (D + DAY);
    const ranked = [...done.entries()]
      .filter(([m, b]) => m !== 'KRW-BTC' && b.length >= 30 && b[b.length - 1].ts === D)
      .map(([m, b]) => [m, b.slice(-30).reduce((a, x) => a + x.value, 0)] as [string, number])
      .sort((a, b) => b[1] - a[1]).slice(0, RL_TOP_N).map(([m]) => m);
    const cands = ranked.map((m) => {
      const b = done.get(m)!; const r = retK(b, at(m, D), RL_LOOKBACK);
      return [m, r == null || btc14 == null ? null : r - btc14] as [string, number | null];
    }).filter((x): x is [string, number] => x[1] != null && x[1] <= -RL_LAG_THR).sort((a, b) => a[1] - b[1]);

    let entries = 0;
    const stance = RL_TWIN ? readStance() : null;
    const why = !regimeOn ? `BTC 7일 ${btc7 == null ? '?' : (btc7 * 100).toFixed(1) + '%'} > −5% — 진입 없음`
      : late > RL_MAX_LATE_MS ? `09:00 대비 ${(late / 60000).toFixed(0)}분 지연 — 진입 skip`
      : stance?.level === 'avoid' ? `AI avoid — 진입 없음 (${stance.reasons.join('; ')})` : '';
    if (!why && cands.length) {
      const tk = new Map(((await getUpbitClient().getTicker(cands.map(([m]) => m))) as any[]).map((t) => [t.market, t.trade_price as number]));
      // 평가액 = 현금 + 보유분(어제 종가)
      const equity = st.cash + st.positions.reduce((a, p) => {
        const b = done.get(p.market); return a + p.vol * (b && b.length ? b[b.length - 1].close : p.entryPrice);
      }, 0);
      for (const [m, s] of cands) {
        if (st.positions.length >= RL_SLOTS) break;
        if (st.positions.some((p) => p.market === m)) continue;
        if (isWarningBlocked(m)) { console.log(`[warning] ${m} 진입 차단`); continue; }
        if (RL_TWIN) { const v = vetoOf(m); if (v) { console.log(`[AI veto] ${m} ${v.kind} — ${v.reason}`); continue; } }
        const raw = tk.get(m); if (raw == null) continue;
        const ep = raw * (1 + rlSlip(m));
        const used = Math.min(st.cash, equity * RL_POSITION_PCT); if (used < 5000) continue;
        st.cash -= used;
        st.positions.push({ market: m, entryTs: now, entryDate: kstISO(now), entryPrice: ep, vol: used * (1 - RL_FEE) / ep, cashUsed: used, entryBarsRemaining: 0, entryDayTs: D + DAY, score: +s.toFixed(4) });
        entries++;
        console.log(`[${ID}] 진입 ${m} @${ep} 점수 ${(s * 100).toFixed(1)}%p TP=${(ep * (1 + RL_TP_PCT / 100)).toFixed(4)}`);
      }
    } else if (why) console.log(`[${ID}] ${why}`);

    st.lastDayTs = D; st.lastTickTs = now; st.lastTickAt = new Date(now).toISOString();
    fs.appendFileSync(RL_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kstISO(now), btc7: btc7 == null ? null : +btc7.toFixed(4), regimeOn, universe: ranked,
      signals: cands.map(([m, s]) => ({ m, s: +s.toFixed(4) })),
      newEntries: entries, exits, openPositions: st.positions.length, cash: st.cash, ...(why ? { skip: why } : {}),
    }) + '\n');
    console.log(`[${ID}] BTC 7일 ${btc7 == null ? '?' : (btc7 * 100).toFixed(1)}% · 유니버스 ${ranked.length} · 후보 ${cands.length} · 진입 ${entries} · 청산 ${exits} · 보유 ${st.positions.length}`);
  });
  process.exit(0);
})().catch((e) => { console.error(`[${ID} tick FAIL]`, e); process.exit(1); });
