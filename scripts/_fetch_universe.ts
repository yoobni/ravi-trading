/**
 * 전체 KRW 유니버스 캔들 수집 — 지금까지 28코인만 봤다는 사실을 고치기 위한 준비.
 *
 * 업비트 KRW 마켓은 286개인데 리서치는 손으로 고른 28개(대략 시총순)에서만 돌았다.
 * 나머지 258개는 한 번도 본 적 없는 가격 시계열이다.
 *
 * 여기서는 24시간 거래대금 상위 N개(스테이블·금 토큰 제외)를 2년치 4h 로 받아 캐시에 넣는다.
 * ⚠ 생존 편향: 상장폐지된 코인은 업비트 API 에서 사라지므로 과거 검증에 포함할 수 없다.
 *    즉 이 유니버스로 낸 성과는 낙관 쪽으로 치우친다 — 결론 낼 때 반드시 감안할 것.
 *
 * 실행: npx tsx scripts/_fetch_universe.ts [N]   (기본 120)
 */
import 'dotenv/config';
import { getUpbitClient } from '@/lib/upbit-client';
import { fetchMinutesCached } from '../algorithms/archive/_candle-cache';

/** 모멘텀이 존재하지 않는 종목 — 스테이블코인·금 연동 */
const PEGGED = ['USDT','USDC','USDS','USDE','USDG','USD1','RLUSD','XAUT'];
const N = Number(process.argv[2]) || 120;
const PERIODS = [{ from: '2024-08-01', to: '2025-08-01' }, { from: '2025-08-01', to: '2026-08-24' }];

(async () => {
  const client = getUpbitClient();
  const markets = (await client.getMarkets()).filter((m: any) => m.market.startsWith('KRW-'));
  const codes = markets.map((m: any) => m.market);

  // 거래대금 순위 — 티커는 100개씩 나눠 조회
  const tickers: any[] = [];
  for (let i = 0; i < codes.length; i += 100) {
    tickers.push(...(await client.getTicker(codes.slice(i, i + 100))));
    await new Promise((r) => setTimeout(r, 150));
  }
  const ranked = tickers
    .filter((t: any) => !PEGGED.includes(t.market.replace('KRW-', '')))
    .sort((a: any, b: any) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, N);

  console.log(`KRW 마켓 ${codes.length}개 → 거래대금 상위 ${ranked.length}개 수집 (스테이블 ${PEGGED.length}종 제외)`);
  console.log(`상위 10: ${ranked.slice(0, 10).map((t: any) => t.market.replace('KRW-', '')).join(' ')}\n`);

  let done = 0, failed: string[] = [];
  for (const t of ranked) {
    const m = t.market;
    let total = 0;
    for (const p of PERIODS) {
      try { total += (await fetchMinutesCached(m, 240, p.from, p.to)).length; }
      catch (e: any) { console.log(`  [${m}] ${p.from} FAIL ${e?.message || e}`); }
    }
    done++;
    if (total < 100) failed.push(m);
    console.log(`[${String(done).padStart(3)}/${ranked.length}] ${m.padEnd(12)} ${total} bars  (24h 거래대금 ${(t.acc_trade_price_24h / 1e8).toFixed(0)}억)`);
  }
  console.log(`\n완료: ${done - failed.length}/${done} · 데이터 부족 ${failed.length}종 ${failed.map((f) => f.replace('KRW-', '')).join(' ')}`);
  process.exit(0);
})();
