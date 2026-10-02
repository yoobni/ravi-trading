/**
 * 스프레드 포착(마켓메이킹) 리서치용 고해상도 수집기 (2026-10-02, 일회성 — 크론 등록 금지).
 * 업비트 웹소켓(trade + orderbook, SIMPLE 포맷)을 받아 data/research-ext/mm/ 에 저장한다.
 *   trades_<code>.jsonl : {t, p, v, s}   t=체결 ms, p=가격, v=수량, s=+1 매수공격(BID) / -1 매도공격(ASK)
 *   book_<code>.jsonl   : {t, a:[[가격,잔량]×3], b:[[가격,잔량]×3]}  — 최우선 3단계가 바뀔 때만 기록
 * 사용: npx tsx scripts/_collect_mm.ts <분>   (기본 240분)
 */
import fs from 'fs';
import path from 'path';

const CODES = ['KRW-DOGE', 'KRW-MANA', 'KRW-BAT', 'KRW-POL', 'KRW-ALGO', 'KRW-IMX', 'KRW-CHZ', 'KRW-ARB', 'KRW-GRT',
  'KRW-XRP', 'KRW-ADA', 'KRW-SAND', 'KRW-XLM'];
const OUT = path.resolve(process.cwd(), 'data/research-ext/mm');
fs.mkdirSync(OUT, { recursive: true });
const MIN = Number(process.argv[2] || 240);
const END = Date.now() + MIN * 60_000;

const streams = new Map<string, fs.WriteStream>();
const ws_ = (name: string) => {
  let s = streams.get(name);
  if (!s) { s = fs.createWriteStream(path.join(OUT, name), { flags: 'a' }); streams.set(name, s); }
  return s;
};
const lastTop = new Map<string, string>();
let nTrade = 0, nBook = 0;

function connect() {
  const sock = new WebSocket('wss://api.upbit.com/websocket/v1');
  sock.binaryType = 'arraybuffer';
  let ping: ReturnType<typeof setInterval> | null = null;
  sock.onopen = () => {
    sock.send(JSON.stringify([{ ticket: `mm-${Date.now()}` }, { type: 'trade', codes: CODES }, { type: 'orderbook', codes: CODES }, { format: 'SIMPLE' }]));
    ping = setInterval(() => { try { sock.send('PING'); } catch { /* */ } }, 60_000);
    console.log(new Date().toISOString(), 'connected');
  };
  sock.onmessage = (ev: MessageEvent) => {
    const txt = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
    let m: any; try { m = JSON.parse(txt); } catch { return; }
    if (m.ty === 'trade') {
      ws_(`trades_${m.cd}.jsonl`).write(JSON.stringify({ t: m.ttms, p: m.tp, v: m.tv, s: m.ab === 'BID' ? 1 : -1 }) + '\n');
      nTrade++;
    } else if (m.ty === 'orderbook' && m.obu?.length) {
      const u = m.obu.slice(0, 3);
      const rec = { a: u.map((x: any) => [x.ap, x.as]), b: u.map((x: any) => [x.bp, x.bs]) };
      const key = JSON.stringify(rec);
      if (lastTop.get(m.cd) === key) return;
      lastTop.set(m.cd, key);
      ws_(`book_${m.cd}.jsonl`).write(JSON.stringify({ t: m.tms, ...rec }) + '\n');
      nBook++;
    }
  };
  sock.onclose = () => {
    if (ping) clearInterval(ping);
    if (Date.now() < END) { console.log(new Date().toISOString(), 'closed — reconnect in 3s'); setTimeout(connect, 3000); }
  };
  sock.onerror = () => { /* onclose 가 처리 */ };
  return sock;
}

let sock = connect();
const stat = setInterval(() => console.log(new Date().toISOString(), `trades ${nTrade} book ${nBook}`), 10 * 60_000);
setTimeout(() => {
  clearInterval(stat);
  try { sock.close(); } catch { /* */ }
  for (const s of streams.values()) s.end();
  console.log('DONE', nTrade, nBook);
  setTimeout(() => process.exit(0), 1000);
}, MIN * 60_000);
