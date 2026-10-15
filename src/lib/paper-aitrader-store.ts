/**
 * AI_TRADER paper store — Claude(Opus)가 15분마다 직접 매수·매도를 결정하는 재량 슬리브 (2026-10-13 사용자 결정).
 *
 * AI 는 MCP 도구(scripts/ai-trader/mcp-server.ts)로만 이 장부를 만진다. **위험 한도는 전부 여기 코드가 강제한다** —
 * 프롬프트로 부탁하는 게 아니라 주문 함수가 거부한다. AI 의 판단 자유는 종목·시점·크기·청산 전부.
 *
 * 체결 모델 (기존 페이퍼보다 보수적):
 *   - 시장가: 주문 시점의 실제 업비트 호가창을 걸어 올라가며(매수 = 매도호가) VWAP 체결. 호가창이 모자라면 거부.
 *   - 지정가: 접수 후의 1분봉으로 판정, 0.2% 관통해야 체결(닿기만 하면 체결 안 함). 매수 대금은 접수 시 묶는다.
 *   - 수수료 0.05%/편도.
 * 여러 프로세스(MCP 서버 · 체결 크론)가 같은 장부를 쓰므로 파일 잠금(O_EXCL)으로 직렬화한다.
 */
import fs from 'fs';
import path from 'path';
import { getUpbitClient } from './upbit-client';
import { isWarningBlocked } from './paper-warning';

export const AT_DIR = path.resolve(process.cwd(), 'data', 'paper-aitrader');
export const AT_STATE_FILE = path.join(AT_DIR, 'state.json');
export const AT_TRADES_FILE = path.join(AT_DIR, 'trades.jsonl');
export const AT_TICKS_FILE = path.join(AT_DIR, 'ticks.jsonl');
export const AT_ORDERS_FILE = path.join(AT_DIR, 'orders.jsonl');     // 모든 주문 시도(거부 포함) 감사 로그
export const AT_JOURNAL_FILE = path.join(AT_DIR, 'journal.jsonl');
export const AT_PLAYBOOK_FILE = path.join(AT_DIR, 'playbook.md');
const LOCK_FILE = path.join(AT_DIR, 'state.lock');

export const AT_INITIAL_CASH_KRW = 10_000_000;
export const AT_FEE = 0.0005;
export const AT_LIMIT_PEN = 0.002;

/** 코드가 강제하는 위험 한도 */
export const AT_LIMITS = {
  minOrderKrw: 10_000,
  // 2026-10-15 사용자 요청 "조금 더 자유를" — 35%/6종목/30건/50억/72h → 아래로 완화. 일 손실 한도만 그대로.
  maxCoinPct: 0.50,              // 종목당 평가액 대비 최대 보유(대기 지정가 매수 포함)
  maxPositions: 8,
  maxOrdersPerDay: 40,           // KST 하루, 체결·대기 주문 합
  dailyLossStop: -0.05,          // KST 하루 시작 평가액 대비 −5% 면 그날 신규 매수 금지(매도는 허용)
  minValue24hKrw: 3_000_000_000, // 24h 거래대금 30억 미만 종목은 매수 금지(체결 현실성)
  limitMaxHours: 168,
  stable: new Set(['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'TUSD', 'PYUSD', 'FDUSD', 'USDE', 'RLUSD', 'EURC', 'USD0']),
};

export interface AtPosition { market: string; entryTs: number; entryDate: string; entryPrice: number; vol: number; cashUsed: number; entryBarsRemaining: number }
export interface AtOrder { id: string; side: 'buy' | 'sell'; market: string; price: number; vol: number; reservedKrw: number; createdTs: number; expiresTs: number; lastCheckTs: number; reason: string }
export interface AtState {
  startedAt: string; lastTickTs: number | null; lastTickAt: string | null;
  cash: number; positions: AtPosition[]; orders: AtOrder[];
  totalTrades: number; totalRealizedPnl: number;
  day: { key: string; startEquity: number; orders: number } | null;
}

const kstISO = (ts: number) => new Date(ts + 9 * 3600_000).toISOString();
const kstDay = (ts: number) => kstISO(ts).slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readAtState(): AtState | null {
  if (!fs.existsSync(AT_STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AT_STATE_FILE, 'utf-8')); } catch { return null; }
}

/** 프로세스 간 잠금 — O_EXCL 잠금파일, 60초 넘은 잠금은 죽은 것으로 보고 치운다 */
export async function withAtState<T>(fn: (s: AtState) => Promise<T>): Promise<T> {
  fs.mkdirSync(AT_DIR, { recursive: true });
  for (let k = 0; ; k++) {
    try { fs.closeSync(fs.openSync(LOCK_FILE, 'wx')); break; } catch {
      try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 60_000) { fs.unlinkSync(LOCK_FILE); continue; } } catch { /* 방금 풀림 */ }
      if (k > 300) throw new Error('state lock timeout');
      await sleep(100);
    }
  }
  try {
    const st: AtState = readAtState() ?? {
      startedAt: new Date().toISOString(), lastTickTs: null, lastTickAt: null,
      cash: AT_INITIAL_CASH_KRW, positions: [], orders: [], totalTrades: 0, totalRealizedPnl: 0, day: null,
    };
    st.orders ??= [];
    const r = await fn(st);
    fs.writeFileSync(AT_STATE_FILE + '.tmp', JSON.stringify(st, null, 2));
    fs.renameSync(AT_STATE_FILE + '.tmp', AT_STATE_FILE);
    return r;
  } finally { try { fs.unlinkSync(LOCK_FILE); } catch { /* */ } }
}

export async function prices(markets: string[]): Promise<Map<string, number>> {
  const uniq = [...new Set(markets)];
  if (!uniq.length) return new Map();
  const tk = (await getUpbitClient().getTicker(uniq)) as any[];
  return new Map(tk.map((t) => [t.market, t.trade_price as number]));
}

export function equityOf(st: AtState, px: Map<string, number>): number {
  const reserved = st.orders.filter((o) => o.side === 'buy').reduce((a, o) => a + o.reservedKrw, 0);
  return st.cash + reserved + st.positions.reduce((a, p) => a + p.vol * (px.get(p.market) ?? p.entryPrice), 0);
}

/** KST 날짜가 바뀌었으면 하루 카운터를 새로 연다 */
function rollDay(st: AtState, eq: number) {
  const key = kstDay(Date.now());
  if (!st.day || st.day.key !== key) st.day = { key, startEquity: eq, orders: 0 };
}

function audit(o: Record<string, unknown>) {
  fs.appendFileSync(AT_ORDERS_FILE, JSON.stringify({ ts: Date.now(), at: kstISO(Date.now()), ...o }) + '\n');
}

function addPosition(st: AtState, market: string, vol: number, krwOut: number, px: number) {
  const p = st.positions.find((x) => x.market === market);
  const now = Date.now();
  if (p) { p.cashUsed += krwOut; p.vol += vol; p.entryPrice = p.cashUsed / (p.vol / (1 - AT_FEE)); }
  else st.positions.push({ market, entryTs: now, entryDate: kstISO(now), entryPrice: px, vol, cashUsed: krwOut, entryBarsRemaining: 0 });
}

function reducePosition(st: AtState, market: string, vol: number, px: number, reason: string, exitTs = Date.now()) {
  const p = st.positions.find((x) => x.market === market)!;
  const frac = Math.min(1, vol / p.vol);
  const basis = p.cashUsed * frac;
  const got = vol * px * (1 - AT_FEE);
  const profitKrw = got - basis;
  st.cash += got; st.totalTrades += 1; st.totalRealizedPnl += profitKrw;
  fs.appendFileSync(AT_TRADES_FILE, JSON.stringify({
    market, entryTs: p.entryTs, exitTs, entryDate: p.entryDate, exitDate: kstISO(exitTs),
    entryPrice: p.entryPrice, exitPrice: px, profitRate: (got / basis - 1) * 100, profitKrw, reason,
    fraction: +frac.toFixed(4), recordedAt: new Date().toISOString(),
  }) + '\n');
  p.vol -= vol; p.cashUsed -= basis;
  if (p.vol * px < 1000 || frac >= 0.9999) st.positions.splice(st.positions.indexOf(p), 1);
  return { got, profitKrw };
}

/** 호가창을 걸어 VWAP 계산. side=buy 면 krw 로 살 수 있는 수량, sell 이면 vol 을 팔아 받는 금액 */
async function walkBook(market: string, side: 'buy' | 'sell', amount: number) {
  const ob = ((await getUpbitClient().getOrderbook([market])) as any[])[0];
  const units = ob?.orderbook_units || [];
  let left = amount, vol = 0, krw = 0;
  for (const u of units) {
    const px = side === 'buy' ? u.ask_price : u.bid_price;
    const size = side === 'buy' ? u.ask_size : u.bid_size;
    if (side === 'buy') { const take = Math.min(left, px * size); vol += take / px; krw += take; left -= take; }
    else { const take = Math.min(left, size); vol += take; krw += take * px; left -= take; }
    if (left <= 1e-9) break;
  }
  if (left > 1e-9) return null;   // 호가창 15단으로 소화 불가
  return { vol, krw, vwap: krw / vol };
}

async function market24h(market: string) {
  const t = ((await getUpbitClient().getTicker([market])) as any[])[0];
  return { value: t?.acc_trade_price_24h as number, price: t?.trade_price as number };
}

export type OrderResult = { ok: true; detail: string } | { ok: false; reject: string };

export async function placeBuy(market: string, krw: number, type: 'market' | 'limit', limitPrice: number | undefined, reason: string): Promise<OrderResult> {
  return withAtState(async (st) => {
    const rej = (why: string): OrderResult => { audit({ side: 'buy', market, krw, type, limitPrice, reason, reject: why }); return { ok: false, reject: why }; };
    if (!/^KRW-[A-Z0-9]+$/.test(market) || AT_LIMITS.stable.has(market.slice(4))) return rej('KRW 마켓 비스테이블 코인만 가능');
    if (isWarningBlocked(market)) return rej('유의종목 지정 코인 — 매수 금지');
    const m24 = await market24h(market).catch(() => null);
    if (!m24?.price) return rej('시세 조회 실패 또는 없는 마켓');
    if (m24.value < AT_LIMITS.minValue24hKrw) return rej(`24h 거래대금 ${(m24.value / 1e8).toFixed(0)}억 < 50억 — 체결 현실성 하한`);
    const held = [...new Set([...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market), market])];
    const px = await prices(held);
    const eq = equityOf(st, px); rollDay(st, eq);
    if (st.day!.orders >= AT_LIMITS.maxOrdersPerDay) return rej(`오늘 주문 ${st.day!.orders}건 — 하루 한도 ${AT_LIMITS.maxOrdersPerDay}`);
    if (eq / st.day!.startEquity - 1 <= AT_LIMITS.dailyLossStop) return rej(`오늘 손실 ${((eq / st.day!.startEquity - 1) * 100).toFixed(1)}% — 일 손실 한도로 신규 매수 금지(매도는 가능)`);
    if (krw < AT_LIMITS.minOrderKrw) return rej(`최소 주문 ${AT_LIMITS.minOrderKrw}원`);
    if (krw > st.cash) return rej(`현금 부족 (가용 ${Math.floor(st.cash)}원)`);
    const exposure = (st.positions.find((p) => p.market === market)?.vol ?? 0) * (px.get(market) ?? 0)
      + st.orders.filter((o) => o.market === market && o.side === 'buy').reduce((a, o) => a + o.reservedKrw, 0);
    if ((exposure + krw) / eq > AT_LIMITS.maxCoinPct) return rej(`종목 비중 ${(((exposure + krw) / eq) * 100).toFixed(0)}% > 한도 ${AT_LIMITS.maxCoinPct * 100}%`);
    const isNew = !st.positions.some((p) => p.market === market) && !st.orders.some((o) => o.market === market && o.side === 'buy');
    const nPos = new Set([...st.positions.map((p) => p.market), ...st.orders.filter((o) => o.side === 'buy').map((o) => o.market)]).size;
    if (isNew && nPos >= AT_LIMITS.maxPositions) return rej(`보유 종목 수 한도 ${AT_LIMITS.maxPositions}`);

    if (type === 'market') {
      const w = await walkBook(market, 'buy', krw * (1 - AT_FEE));
      if (!w) return rej('호가창 깊이 부족 — 금액을 줄이거나 지정가로');
      st.cash -= krw; st.day!.orders++;
      addPosition(st, market, w.vol, krw, w.vwap);
      audit({ side: 'buy', market, krw, type, reason, fill: w.vwap, vol: w.vol });
      return { ok: true, detail: `시장가 매수 체결 ${market} ${Math.round(krw).toLocaleString()}원 @${w.vwap} (호가 VWAP, 현재가 대비 ${((w.vwap / m24.price - 1) * 100).toFixed(3)}%)` };
    }
    if (!limitPrice || limitPrice <= 0) return rej('지정가 가격 필요');
    if (limitPrice >= m24.price) return rej(`지정가 ${limitPrice} ≥ 현재가 ${m24.price} — 즉시 체결될 가격이면 시장가로`);
    const now = Date.now();
    const o: AtOrder = { id: `B${now.toString(36)}`, side: 'buy', market, price: limitPrice, vol: krw * (1 - AT_FEE) / limitPrice, reservedKrw: krw, createdTs: now, expiresTs: now + AT_LIMITS.limitMaxHours * 3600_000, lastCheckTs: now, reason };
    st.cash -= krw; st.day!.orders++; st.orders.push(o);
    audit({ side: 'buy', market, krw, type, limitPrice, reason, orderId: o.id });
    return { ok: true, detail: `지정가 매수 접수 ${o.id} ${market} ${limitPrice} × ${Math.round(krw).toLocaleString()}원 (0.2% 관통 시 체결, ${AT_LIMITS.limitMaxHours}h 후 만료)` };
  });
}

export async function placeSell(market: string, fraction: number, type: 'market' | 'limit', limitPrice: number | undefined, reason: string): Promise<OrderResult> {
  return withAtState(async (st) => {
    const rej = (why: string): OrderResult => { audit({ side: 'sell', market, fraction, type, limitPrice, reason, reject: why }); return { ok: false, reject: why }; };
    const p = st.positions.find((x) => x.market === market);
    if (!p) return rej('보유하지 않은 종목');
    if (!(fraction > 0 && fraction <= 1)) return rej('fraction 은 0~1');
    const lockedVol = st.orders.filter((o) => o.side === 'sell' && o.market === market).reduce((a, o) => a + o.vol, 0);
    const vol = Math.min(p.vol * fraction, p.vol - lockedVol);
    if (vol <= 0) return rej('이미 전량에 지정가 매도가 걸려 있음 — 먼저 취소');
    const px = await prices([...st.positions.map((x) => x.market)]);
    rollDay(st, equityOf(st, px));
    if (type === 'market') {
      const w = await walkBook(market, 'sell', vol);
      if (!w) return rej('호가창 깊이 부족');
      st.day!.orders++;
      const r = reducePosition(st, market, vol, w.vwap, `AI:${reason}`.slice(0, 200));
      audit({ side: 'sell', market, fraction, type, reason, fill: w.vwap, vol });
      return { ok: true, detail: `시장가 매도 체결 ${market} ${(fraction * 100).toFixed(0)}% @${w.vwap} 실현 ${Math.round(r.profitKrw).toLocaleString()}원` };
    }
    if (!limitPrice || limitPrice <= (px.get(market) ?? Infinity)) return rej(`지정가 매도는 현재가(${px.get(market)})보다 높아야 함 — 즉시 팔려면 시장가`);
    const now = Date.now();
    const o: AtOrder = { id: `S${now.toString(36)}`, side: 'sell', market, price: limitPrice, vol, reservedKrw: 0, createdTs: now, expiresTs: now + AT_LIMITS.limitMaxHours * 3600_000, lastCheckTs: now, reason };
    st.day!.orders++; st.orders.push(o);
    audit({ side: 'sell', market, fraction, type, limitPrice, reason, orderId: o.id });
    return { ok: true, detail: `지정가 매도 접수 ${o.id} ${market} @${limitPrice} 수량 ${vol}` };
  });
}

export async function cancelOrder(id: string): Promise<OrderResult> {
  return withAtState(async (st) => {
    const o = st.orders.find((x) => x.id === id);
    if (!o) return { ok: false, reject: '없는 주문(이미 체결·만료됐을 수 있음)' };
    if (o.side === 'buy') st.cash += o.reservedKrw;
    st.orders.splice(st.orders.indexOf(o), 1);
    audit({ cancel: id });
    return { ok: true, detail: `취소 ${id}` };
  });
}

/** KST 날짜가 바뀌었으면 하루 카운터(일 손실 한도 기준 평가액)를 새로 연다 — 주문이 없는 날도 portfolio 조회 때 굴린다 */
export async function touchDay(): Promise<void> {
  await withAtState(async (st) => {
    const key = kstDay(Date.now());
    if (st.day && st.day.key === key) return;
    const px = await prices([...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market)]);
    rollDay(st, equityOf(st, px));
  });
}

/** 대기 지정가 주문 체결 판정 — 접수 이후 1분봉, 0.2% 관통. MCP 도구 호출 전과 체결 크론에서 부른다 */
export async function processFills(): Promise<string[]> {
  return withAtState(async (st) => {
    const out: string[] = []; const now = Date.now();
    for (const o of [...st.orders]) {
      let filled = false, fillTs = 0;
      try {
        const bars = ((await getUpbitClient().getCandlesMinutes(1, o.market, 200)) as any[])
          .map((x) => ({ ts: new Date(x.candle_date_time_utc + 'Z').getTime(), high: x.high_price, low: x.low_price }))
          .filter((b) => b.ts >= o.lastCheckTs - 60_000 && b.ts >= o.createdTs - 0 && b.ts + 60_000 <= now)
          .sort((a, b) => a.ts - b.ts);
        for (const b of bars) {
          if (b.ts < o.createdTs) continue;               // 접수 분 이전 봉은 제외
          if (o.side === 'buy' ? b.low <= o.price * (1 - AT_LIMIT_PEN) : b.high >= o.price * (1 + AT_LIMIT_PEN)) { filled = true; fillTs = b.ts; break; }
        }
        if (!filled && bars.length) o.lastCheckTs = bars[bars.length - 1].ts + 60_000;
      } catch (e: any) { out.push(`${o.id} 체결 확인 실패: ${e?.message || e}`); continue; }
      if (filled) {
        st.orders.splice(st.orders.indexOf(o), 1);
        if (o.side === 'buy') { addPosition(st, o.market, o.vol, o.reservedKrw, o.price); out.push(`지정가 매수 체결 ${o.id} ${o.market} @${o.price}`); }
        else {
          const p = st.positions.find((x) => x.market === o.market);
          if (p) { const r = reducePosition(st, o.market, Math.min(o.vol, p.vol), o.price, `AI-limit:${o.reason}`.slice(0, 200), fillTs); out.push(`지정가 매도 체결 ${o.id} ${o.market} @${o.price} 실현 ${Math.round(r.profitKrw)}원`); }
        }
        audit({ fill: o.id, market: o.market, side: o.side, price: o.price, barTs: fillTs });
      } else if (now > o.expiresTs) {
        if (o.side === 'buy') st.cash += o.reservedKrw;
        st.orders.splice(st.orders.indexOf(o), 1);
        out.push(`만료 ${o.id} ${o.market}`); audit({ expire: o.id });
      }
      await sleep(150);
    }
    return out;
  });
}

export const kstNow = () => kstISO(Date.now()).slice(0, 16).replace('T', ' ');
