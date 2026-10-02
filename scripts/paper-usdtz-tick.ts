#!/usr/bin/env tsx
/**
 * USDT_Z paper tick — 15분마다 (`7,22,37,52 * * * *`). 규칙은 src/lib/paper-usdtz-store.ts.
 *
 * 마지막 처리한 15분봉 이후의 확정봉을 차례로 재생한다(스스로 결손을 메움, 최대 ~100시간):
 *   봉 i 종가로 프리미엄·z 계산 → 판단 → 봉 i+1 시가 ± 반틱 체결.
 * 첫 실행 시 리서치 데이터(data/research-ext/upbit-KRW-USDT_15m.json + usdt2/yahoo-krw-1h.json)로 30일 이력을 채운다.
 */
import 'dotenv/config';
import fs from 'fs';
import { getUpbitClient } from '@/lib/upbit-client';
import {
  UZ_PREM_FILE, UZ_TRADES_FILE, UZ_TICKS_FILE, UZ_MARKET, UZ_FEE, UZ_HALF_TICK, UZ_WINDOW, UZ_ENTRY_Z, UZ_EXIT_Z,
  UZ_DEPEG_LIMIT, premZ, withUzState, type PremRow,
} from '@/lib/paper-usdtz-store';

const Q = 15 * 60_000, H = 3600_000;
const kstISO = (ts: number) => new Date(ts + 9 * H).toISOString();

/** Yahoo 1h: 봉 시작 t → 그 봉 종가는 t+1h 이후에만 사용 (미래참조 방지) */
function fxSeries(chart: any): { t: number; c: number }[] {
  const r = chart?.chart?.result?.[0]; if (!r) return [];
  const out: { t: number; c: number }[] = [];
  r.timestamp.forEach((t: number, i: number) => { const c = r.indicators.quote[0].close[i]; if (c != null && c > 900 && c < 2000) out.push({ t: t * 1e3 + H, c }); });
  return out.sort((a, b) => a.t - b.t);
}
const fxAt = (fx: { t: number; c: number }[], ts: number) => { let a: number | null = null; for (const p of fx) { if (p.t <= ts) a = p.c; else break; } return a; };

function seedHistory(): PremRow[] {
  try {
    const bars: any[] = JSON.parse(fs.readFileSync('data/research-ext/upbit-KRW-USDT_15m.json', 'utf8'));
    const fx = fxSeries(JSON.parse(fs.readFileSync('data/research-ext/usdt2/yahoo-krw-1h.json', 'utf8')));
    const rows: PremRow[] = [];
    for (const b of bars.slice(-(UZ_WINDOW + 400))) { const f = fxAt(fx, b.ts + Q); if (f) rows.push({ ts: b.ts, close: b.close, fx: f, prem: b.close / f - 1 }); }
    console.log(`[seed] 리서치 데이터로 ${rows.length}개 표본 채움`);
    return rows;
  } catch (e: any) { console.log(`[seed] 실패: ${e?.message || e}`); return []; }
}

(async () => {
  const now = Date.now();
  let hist: PremRow[] = fs.existsSync(UZ_PREM_FILE) ? JSON.parse(fs.readFileSync(UZ_PREM_FILE, 'utf8')) : seedHistory();

  // 업비트 15분봉 (최근 ~100시간, 2페이지) — 진행 중인 봉 포함
  const raw: any[] = [];
  let to: string | undefined;
  for (let p = 0; p < 2; p++) {
    const page = await getUpbitClient().getCandlesMinutes(15, UZ_MARKET, 200, to);
    if (!page.length) break; raw.push(...page); to = (page[page.length - 1] as any).candle_date_time_utc;
  }
  const seen = new Set<number>();
  const bars = raw.map((x) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), open: x.opening_price, close: x.trade_price }))
    .filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true))).sort((a, b) => a.ts - b.ts);
  const fxRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1h&range=7d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const fx = fxSeries(await fxRes.json());
  let depeg = false;
  try { const j: any = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT')).json(); depeg = +j.price > UZ_DEPEG_LIMIT; } catch { /* 조회 실패 시 가드 미적용 */ }

  await withUzState(async (st) => {
    const lastHist = hist.length ? hist[hist.length - 1].ts : 0;
    // 1) 확정봉 프리미엄 이력 추가
    for (const b of bars) {
      if (b.ts + Q > now || b.ts <= lastHist) continue;
      const f = fxAt(fx, b.ts + Q); if (!f) continue;
      hist.push({ ts: b.ts, close: b.close, fx: f, prem: b.close / f - 1 });
    }
    hist = hist.slice(-(UZ_WINDOW + 400));
    // 2) 판단 재생: 처리 안 한 확정봉 i 마다, 다음 봉 시가로 체결
    const from = st.lastBarTs ?? hist[hist.length - 1]?.ts - Q;
    let lastZ: number | null = null, actions = 0;
    for (let k = 0; k < hist.length; k++) {
      const row = hist[k]; if (row.ts <= from) continue;
      const next = bars.find((b) => b.ts === row.ts + Q); if (!next) break;   // 다음 봉이 아직 없으면 다음 tick 에
      const z = premZ(hist.slice(0, k + 1)); lastZ = z; st.lastBarTs = row.ts;
      if (z == null) continue;
      const pos = st.positions[0];
      if (!pos && z <= UZ_ENTRY_Z && !depeg && st.cash > 5000) {
        const ep = next.open + UZ_HALF_TICK; const used = st.cash;
        st.cash = 0;
        st.positions.push({ market: UZ_MARKET, entryTs: next.ts, entryDate: kstISO(next.ts), entryPrice: ep, vol: used * (1 - UZ_FEE) / ep, cashUsed: used, entryBarsRemaining: 0 });
        actions++; console.log(`[USDT_Z] ${kstISO(row.ts).slice(5, 16)} 매수 z=${z.toFixed(2)} 프리미엄 ${(100 * row.prem).toFixed(2)}% @${ep}`);
      } else if (pos && z >= UZ_EXIT_Z) {
        const xp = next.open - UZ_HALF_TICK; const got = pos.vol * xp * (1 - UZ_FEE); const profitKrw = got - pos.cashUsed;
        st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw; st.positions = [];
        fs.appendFileSync(UZ_TRADES_FILE, JSON.stringify({
          market: UZ_MARKET, entryTs: pos.entryTs, exitTs: next.ts, entryDate: pos.entryDate, exitDate: kstISO(next.ts),
          entryPrice: pos.entryPrice, exitPrice: xp, profitRate: (xp - pos.entryPrice) / pos.entryPrice * 100, profitKrw,
          reason: 'Z_EXIT', recordedAt: new Date().toISOString(),
        }) + '\n');
        actions++; console.log(`[USDT_Z] ${kstISO(row.ts).slice(5, 16)} 매도 z=${z.toFixed(2)} @${xp} pnl=${profitKrw.toFixed(0)}`);
      }
    }
    fs.writeFileSync(UZ_PREM_FILE, JSON.stringify(hist));
    st.lastTickTs = now; st.lastTickAt = new Date(now).toISOString();
    const lastRow = hist[hist.length - 1];
    fs.appendFileSync(UZ_TICKS_FILE, JSON.stringify({
      ts: now, tickAt: kstISO(now), prem: lastRow?.prem, z: lastZ, depeg, newEntries: actions, exits: 0,
      openPositions: st.positions.length, cash: st.cash,
    }) + '\n');
    console.log(`[USDT_Z] ${kstISO(now).slice(5, 16)} 프리미엄 ${lastRow ? (100 * lastRow.prem).toFixed(2) : '-'}% z=${lastZ?.toFixed(2) ?? '-'} 보유 ${st.positions.length} 표본 ${hist.length}${depeg ? ' ⚠ 디페그 가드' : ''}`);
  });
  process.exit(0);
})().catch((e) => { console.error('[USDT_Z tick FAIL]', e); process.exit(1); });
