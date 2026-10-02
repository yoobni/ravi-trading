/**
 * 스프레드 포착(롱 재고 전용 마켓메이킹) 이벤트 시뮬 (2026-10-02) — data/research-ext/mm/ 웹소켓 기록 사용.
 *
 * 사이클(코인당 재고 1단위):
 *   FLAT  → 최우선 매수호가 P 에 지정가 매수(큐 맨 뒤: 앞 대기량 = 그 시점 표시 잔량).
 *           [improve 변형] 스프레드 ≥ 2틱이면 P+1틱 에 새 최우선 호가를 만든다(앞 대기량 0).
 *   체결  — 매도공격 체결이 가격 P 에서 앞 대기량을 다 먹고 남은 양이 내 수량을 채우면, 또는 P 미만 체결이 나오면.
 *           cap 모드(현실): 표시 잔량이 줄면 앞 대기량도 그만큼 줄었다고 본다(앞 대기량 ≤ 표시 잔량 — 낙관 아님).
 *           strict 모드(보수): 취소로는 큐가 줄지 않는다 — 체결로만 소진.
 *           최우선 매수호가가 P 위로 올라가 requoteS 초 지나면 취소 후 새 최우선에 재호가(큐 맨 뒤).
 *   LONG  → 체결 시점 최우선 매도호가 A(≥ P+1틱)에 지정가 매도. 같은 규칙으로 매수공격이 소진.
 *           holdS 초 안에 안 팔리면 출구 정책: 'mkt' 최우선 매수호가에 시장가 / 'join' 최우선 매도호가로 재호가(손실 감수) 후 maxS 에 시장가.
 * 수수료 편도 0.05%(업비트 KRW, 메이커·테이커 동일). 시장가 매도는 최우선 매수호가 체결 가정(소량).
 * 측정: 왕복 손익, 체결 대기, 매수 체결 후 60/300초 mid 변화(역선택), 재고 보유 시간.
 * 사용: npx tsx scripts/_bt_mm.ts [모드]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data/research-ext/mm');
type Lvl = [number, number];
interface Ev { t: number; k: 0 | 1; p?: number; v?: number; s?: number; a?: Lvl[]; b?: Lvl[] }
const rd = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
function load(code: string): Ev[] {
  const tr = rd(path.join(DIR, `trades_${code}.jsonl`)).map((x: any) => ({ t: x.t, k: 0 as const, p: x.p, v: x.v, s: x.s }));
  const bk = rd(path.join(DIR, `book_${code}.jsonl`)).map((x: any) => ({ t: x.t, k: 1 as const, a: x.a, b: x.b }));
  return [...tr, ...bk].sort((x, y) => x.t - y.t || y.k - x.k);  // 같은 ms 면 호가 먼저
}
const tickOf = (b: Lvl[]) => { let m = Infinity; for (let i = 1; i < b.length; i++) { const d = +(b[i - 1][0] - b[i][0]).toFixed(10); if (d > 0) m = Math.min(m, d); } return m; };

interface Cfg { sizeKrw: number; fee: number; mode: 'cap' | 'strict'; improve: boolean; requoteS: number; holdS: number; exit: 'mkt' | 'join'; maxS: number; from?: number; to?: number }
interface Trip { tBuy: number; tFill: number; tSell: number; buy: number; sell: number; pnl: number; how: string; adv60: number; adv300: number }

function sim(ev: Ev[], c: Cfg) {
  const trips: Trip[] = [];
  let book: { a: Lvl[]; b: Lvl[] } | null = null, tick = 0;
  let st: 'FLAT' | 'BUY' | 'SELL' = 'FLAT';
  let P = 0, qty = 0, ahead = 0, tPlace = 0, outbidSince = 0;
  let A = 0, tFill = 0, sellPhase = 0;
  const mids: Array<[number, number]> = [];
  const lo = c.from ?? -Infinity, hi = c.to ?? Infinity;
  let pending: Trip | null = null;
  for (const e of ev) {
    if (e.t < lo || e.t > hi) continue;
    if (e.k === 1) {
      book = { a: e.a!, b: e.b! }; const tk = tickOf(e.b!); if (isFinite(tk)) tick = tk;
      mids.push([e.t, (e.a![0][0] + e.b![0][0]) / 2]);
    }
    if (!book || !tick) continue;
    const bb = book.b[0][0], ba = book.a[0][0];
    const sizeAt = (side: Lvl[], px: number) => { const l = side.find(x => Math.abs(x[0] - px) < tick / 2); return l ? l[1] : 0; };

    if (st === 'FLAT') {
      const spreadTicks = Math.round((ba - bb) / tick);
      if (c.improve && spreadTicks >= 2) { P = +(bb + tick).toFixed(10); ahead = 0; }
      else { P = bb; ahead = sizeAt(book.b, P); }
      qty = c.sizeKrw / P; tPlace = e.t; outbidSince = 0; st = 'BUY';
      continue;
    }
    if (st === 'BUY') {
      if (e.k === 1) {
        if (c.mode === 'cap') ahead = Math.min(ahead, sizeAt(book.b, P));
        if (bb > P + tick / 2) { if (!outbidSince) outbidSince = e.t; if (e.t - outbidSince > c.requoteS * 1000) { st = 'FLAT'; continue; } }
        else outbidSince = 0;
      } else if (e.s === -1) {
        let filled = false;
        if (e.p! < P - tick / 2) filled = true;
        else if (Math.abs(e.p! - P) < tick / 2) { const rem = e.v! - ahead; ahead = Math.max(0, ahead - e.v!); if (rem > 0) { qty -= rem; if (qty <= 1e-12) filled = true; } }
        if (filled) {
          qty = c.sizeKrw / P; tFill = e.t; st = 'SELL'; sellPhase = 0;
          A = Math.max(ba, +(P + tick).toFixed(10)); ahead = Math.abs(A - ba) < tick / 2 ? sizeAt(book.a, A) : 0;
          pending = { tBuy: tPlace, tFill, tSell: 0, buy: P, sell: 0, pnl: 0, how: '', adv60: NaN, adv300: NaN };
        }
      }
      continue;
    }
    if (st === 'SELL') {
      const held = e.t - tFill;
      // 출구 정책
      if (c.exit === 'mkt' && held > c.holdS * 1000) { close(bb, 'mkt'); continue; }
      if (c.exit === 'join') {
        if (held > c.maxS * 1000) { close(bb, 'mkt'); continue; }
        if (held > c.holdS * 1000 && sellPhase === 0 && ba < A - tick / 2) { A = ba; ahead = sizeAt(book.a, A); sellPhase = 1; }
      }
      if (e.k === 1) { if (c.mode === 'cap') ahead = Math.min(ahead, sizeAt(book.a, A)); }
      else if (e.s === 1) {
        if (e.p! > A + tick / 2) { close(A, sellPhase ? 'join' : 'maker'); continue; }
        if (Math.abs(e.p! - A) < tick / 2) { const rem = e.v! - ahead; ahead = Math.max(0, ahead - e.v!); if (rem >= qty - 1e-12 || rem > 0 && (qty -= rem) <= 1e-12) { close(A, sellPhase ? 'join' : 'maker'); continue; } }
      }
    }
    function close(px: number, how: string) {
      const notional = c.sizeKrw / P * px;
      const pnl = notional * (1 - c.fee) - c.sizeKrw * (1 + c.fee);
      pending!.tSell = e.t; pending!.sell = px; pending!.pnl = pnl; pending!.how = how;
      trips.push(pending!); pending = null; st = 'FLAT';
    }
  }
  // 역선택: 매수 체결 후 60/300초 mid 변화(bps, 체결가 기준)
  for (const tr of trips) {
    const at = (t: number) => { let lo2 = 0, hi2 = mids.length - 1; while (lo2 < hi2) { const m = (lo2 + hi2 + 1) >> 1; if (mids[m][0] <= t) lo2 = m; else hi2 = m - 1; } return mids[lo2]?.[1]; };
    const m60 = at(tr.tFill + 60e3), m300 = at(tr.tFill + 300e3);
    tr.adv60 = m60 ? (m60 / tr.buy - 1) * 1e4 : NaN; tr.adv300 = m300 ? (m300 / tr.buy - 1) * 1e4 : NaN;
  }
  return { trips, openInv: st === 'SELL' ? { P, held: 0 } : null };
}

const CODES = fs.existsSync(DIR) ? [...new Set(fs.readdirSync(DIR).filter(f => f.startsWith('trades_')).map(f => f.slice(7, -6)))] : [];
const span = (ev: Ev[]) => ev.length ? (ev[ev.length - 1].t - ev[0].t) / 3600e3 : 0;
const base: Cfg = { sizeKrw: 1_000_000, fee: 0.0005, mode: 'cap', improve: true, requoteS: 30, holdS: 1800, exit: 'join', maxS: 7200 };
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const MODE = process.argv[2] || 'main';

function row(code: string, ev: Ev[], c: Cfg, h: number) {
  const { trips } = sim(ev, c);
  const pnl = trips.reduce((s, t) => s + t.pnl, 0);
  const how = (k: string) => trips.filter(t => t.how === k).length;
  const fillMin = mean(trips.map(t => (t.tFill - t.tBuy) / 60e3)), holdMin = mean(trips.map(t => (t.tSell - t.tFill) / 60e3));
  return { code, n: trips.length, pnl, perDay: pnl / h * 24, maker: how('maker'), join: how('join'), mkt: how('mkt'),
    fillMin, holdMin, adv60: mean(trips.map(t => t.adv60).filter(isFinite)), adv300: mean(trips.map(t => t.adv300).filter(isFinite)),
    gross: mean(trips.map(t => (t.sell / t.buy - 1) * 1e4)) };
}
function table(title: string, c: Cfg, sub?: (ev: Ev[]) => [number, number]) {
  console.log(`\n── ${title} ──`);
  console.log('코인        시간  왕복  메이커/재호가/시장가  매수대기 보유(분)  총스프레드  역선택60s/300s(bps)  손익(원)  하루환산');
  let tot = 0, totN = 0;
  for (const code of CODES) {
    const ev = load(code); let h = span(ev); let cc = c;
    if (sub) { const [a, b] = sub(ev); cc = { ...c, from: a, to: b }; h = (b - a) / 3600e3; }
    const r = row(code, ev, cc, h); tot += r.perDay; totN += r.n;
    console.log(`${code.padEnd(10)}${h.toFixed(1).padStart(5)}h ${String(r.n).padStart(4)}  ${String(r.maker).padStart(4)}/${String(r.join).padStart(3)}/${String(r.mkt).padStart(3)}      ${r.fillMin.toFixed(1).padStart(6)} ${r.holdMin.toFixed(1).padStart(6)}   ${r.gross.toFixed(1).padStart(7)}bps   ${r.adv60.toFixed(1).padStart(7)} / ${r.adv300.toFixed(1).padStart(7)}   ${Math.round(r.pnl).toLocaleString().padStart(8)} ${Math.round(r.perDay).toLocaleString().padStart(9)}`);
  }
  console.log(`합계 하루환산 ${Math.round(tot).toLocaleString()}원 (코인당 100만원 · ${CODES.length}코인 = 자본 ${CODES.length * 100}만원) · 왕복 ${totN}`);
}

if (MODE === 'main') {
  table('기본: 개선호가 · cap · 30분 후 매도 재호가 · 2시간 후 시장가', base);
  table('개선호가 없음(최우선에 줄서기)', { ...base, improve: false });
  table('strict 큐(취소로는 앞줄 안 줄어듦)', { ...base, mode: 'strict' });
  table('출구 시장가 10분', { ...base, exit: 'mkt', holdS: 600 });
  table('수수료 ×2', { ...base, fee: 0.001 });
  table('앞 절반', base, ev => [ev[0].t, (ev[0].t + ev[ev.length - 1].t) / 2]);
  table('뒤 절반', base, ev => [(ev[0].t + ev[ev.length - 1].t) / 2, ev[ev.length - 1].t]);
  table('주문 300만원', { ...base, sizeKrw: 3_000_000 });
}
if (MODE === 'check') {
  // 체결 방향 검증: s=+1 은 최우선 매도호가에서, s=-1 은 최우선 매수호가에서 체결돼야 한다
  for (const code of CODES.slice(0, 4)) {
    const ev = load(code); let bk: any = null; let atAsk = 0, atBid = 0, n = 0;
    for (const e of ev) { if (e.k === 1) bk = e; else if (bk) { n++; if (e.s === 1 && e.p! >= bk.a[0][0]) atAsk++; if (e.s === -1 && e.p! <= bk.b[0][0]) atBid++; } }
    console.log(code, `체결 ${n} · 매수공격이 매도호가 이상 ${atAsk} · 매도공격이 매수호가 이하 ${atBid}`);
  }
}
