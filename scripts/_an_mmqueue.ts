/**
 * 스프레드 포착 1단계 — 코인별 '최우선 호가 큐 대기 시간' 추정 (2026-10-02).
 * 현재 호가(REST 1회) 의 최우선 매수 잔량(원화) ÷ 최근 10일 분당 매도공격 체결액(1분 스냅샷 중앙값) = 큐 맨 뒤에서 체결까지 걸리는 분.
 * 스프레드를 틱 수로도 본다(1틱이면 큐 경쟁, 2틱 이상이면 내가 새 최우선 호가를 만들 수 있다).
 */
import fs from 'fs';
import 'dotenv/config';
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
(async () => {
  const r = await fetch('https://api.upbit.com/v1/orderbook?markets=' + COINS.join(','));
  const ob: any[] = await r.json();
  const files = fs.readdirSync('data/microstructure').filter(f => f.endsWith('.jsonl')).sort().slice(-10);
  const flow: Record<string, { sell: number[]; buy: number[]; spr: number[] }> = {};
  for (const f of files) for (const l of fs.readFileSync('data/microstructure/' + f, 'utf8').split('\n')) {
    if (!l) continue; let x: any; try { x = JSON.parse(l); } catch { continue; }
    if (x.truncated) continue;
    (flow[x.m] ??= { sell: [], buy: [], spr: [] }); flow[x.m].sell.push(x.sellKrw); flow[x.m].buy.push(x.buyKrw); flow[x.m].spr.push(x.spreadBps);
  }
  const med = (a: number[]) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? 0; };
  const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / Math.max(a.length, 1);
  const rows = ob.map(o => {
    const u = o.orderbook_units; const ap = u[0].ask_price, bp = u[0].bid_price;
    const tick = Math.min(...u.slice(0, 5).map((x: any, i: number, arr: any[]) => i ? Math.abs(arr[i - 1].bid_price - x.bid_price) : Infinity).filter((d: number) => d > 0));
    const f = flow[o.market];
    const bidQ = u[0].bid_size * bp, askQ = u[0].ask_size * ap;
    return { m: o.market, px: bp, tick, sprTicks: Math.round((ap - bp) / tick), sprBps: (ap - bp) / ((ap + bp) / 2) * 1e4,
      bidQ, askQ, sellMed: med(f.sell), sellMean: mean(f.sell), buyMean: mean(f.buy), sprMed: med(f.spr) };
  }).sort((a, b) => b.sprBps - a.sprBps);
  console.log('코인       가격      틱   스프레드(틱/bps) | 최우선매수잔량  매도공격 분당(중앙/평균) | 큐소진(평균흐름) | 10일 스프레드p50');
  for (const x of rows) console.log(`${x.m.padEnd(10)}${String(x.px).padStart(10)}${String(x.tick).padStart(7)}  ${String(x.sprTicks).padStart(3)}틱 ${x.sprBps.toFixed(1).padStart(6)}bps | ${(x.bidQ / 1e6).toFixed(1).padStart(8)}백만  ${(x.sellMed / 1e6).toFixed(2).padStart(6)} / ${(x.sellMean / 1e6).toFixed(2).padStart(6)}백만 | ${(x.bidQ / Math.max(x.sellMean, 1)).toFixed(0).padStart(6)}분 | ${x.sprMed.toFixed(1)}bps`);
})();
