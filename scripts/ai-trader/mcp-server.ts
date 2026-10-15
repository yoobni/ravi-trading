#!/usr/bin/env tsx
/**
 * upbit-paper MCP 서버 (stdio) — AI_TRADER 가 쓰는 유일한 손발. 조회 도구 + 페이퍼 주문 도구.
 * 실계좌 주문·잔고·출금 API 는 노출하지 않는다(upbit-client 의 공개 시세 메서드만 사용).
 * 위험 한도는 src/lib/paper-aitrader-store.ts 가 강제한다 — 여기서 우회 경로를 만들지 말 것.
 * 실행: scripts/ai-trader/run.sh 가 프로젝트 루트에서 claude -p 를 띄우고, claude 가 이 서버를 자식으로 띄운다.
 */
import './stdout-guard';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getUpbitClient } from '@/lib/upbit-client';
import { readBlockList } from '@/lib/paper-warning';
import { SIMPLE_STRATEGIES } from '@/lib/paper-registry';
import {
  AT_DIR, AT_JOURNAL_FILE, AT_PLAYBOOK_FILE, AT_TRADES_FILE, AT_LIMITS, readAtState, prices, equityOf,
  placeBuy, placeSell, cancelOrder, processFills, touchDay, kstNow,
} from '@/lib/paper-aitrader-store';

const kst = (ts: number) => new Date(ts + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const readLines = (f: string, n: number) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n) : []);
const fmt = (x: number | null) => (x == null ? '-' : x === 0 ? "0" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : x.toPrecision(5));

const server = new McpServer({ name: 'upbit-paper', version: '1.0.0' });

server.tool('portfolio', '현금·보유·평가손익·대기 주문·오늘 손익·위험 한도 사용량·최근 체결 10건. 매 판단의 첫 호출.', {}, async () => {
  const fills = await processFills().catch((e) => [`체결 처리 실패 ${e?.message || e}`]);
  await touchDay().catch(() => null);
  const st = readAtState();
  if (!st) return text('장부 없음(첫 실행) — 현금 10,000,000원, 보유 없음.');
  const px = await prices([...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market)]);
  const eq = equityOf(st, px);
  const lines = [
    `## ${kstNow()} KST · 평가액 ${fmt(eq)}원 (개시 대비 ${((eq / 1e7 - 1) * 100).toFixed(2)}%) · 현금 ${fmt(st.cash)}원`,
    st.day ? `오늘(${st.day.key}) 시작 ${fmt(st.day.startEquity)}원 → ${((eq / st.day.startEquity - 1) * 100).toFixed(2)}% · 주문 ${st.day.orders}/${AT_LIMITS.maxOrdersPerDay}` : '오늘 주문 0',
    fills.length ? `### 직전 체결/만료\n- ${fills.join('\n- ')}` : '',
    `### 보유 ${st.positions.length}/${AT_LIMITS.maxPositions}`,
    ...st.positions.map((p) => { const c = px.get(p.market) ?? p.entryPrice; return `- ${p.market} 수량 ${p.vol.toPrecision(6)} 평단 ${fmt(p.entryPrice)} 현재 ${fmt(c)} (${((c / p.entryPrice - 1) * 100).toFixed(2)}%) 평가 ${fmt(p.vol * c)}원 = ${((p.vol * c / eq) * 100).toFixed(1)}% · 진입 ${kst(p.entryTs)}`; }),
    `### 대기 주문 ${st.orders.length}`,
    ...st.orders.map((o) => `- ${o.id} ${o.side} ${o.market} @${fmt(o.price)} 현재 ${fmt(px.get(o.market) ?? 0)} ${o.side === 'buy' ? `묶인 ${fmt(o.reservedKrw)}원` : `수량 ${o.vol.toPrecision(6)}`} 만료 ${kst(o.expiresTs)} · ${o.reason}`),
    `### 최근 체결`,
    ...readLines(AT_TRADES_FILE, 10).map((l) => { const t = JSON.parse(l); return `- ${kst(t.exitTs)} ${t.market} ${t.reason} ${t.profitRate.toFixed(2)}% ${Math.round(t.profitKrw).toLocaleString()}원`; }),
    `누적 실현 ${fmt(st.totalRealizedPnl)}원 · 청산 ${st.totalTrades}건`,
    `한도: 종목당 ${AT_LIMITS.maxCoinPct * 100}% · 최대 ${AT_LIMITS.maxPositions}종목 · 일 주문 ${AT_LIMITS.maxOrdersPerDay} · 일 손실 ${AT_LIMITS.dailyLossStop * 100}% 시 매수 금지 · 24h 거래대금 ${AT_LIMITS.minValue24hKrw / 1e8}억 미만 매수 금지 · 수수료 0.05% · 시장가는 호가창 VWAP · 지정가는 0.2% 관통 시 체결`,
  ];
  return text(lines.filter(Boolean).join('\n'));
});

server.tool('market_scan', '업비트 KRW 마켓을 24h 거래대금 순으로: 현재가·24h 등락·거래대금·당일 고저·유의종목 표시.', { limit: z.number().int().min(5).max(100).default(30) }, async ({ limit }) => {
  const mk = ((await getUpbitClient().getMarkets(false)) as any[]).map((x) => x.market as string).filter((m) => m.startsWith('KRW-'));
  const tk = (await getUpbitClient().getTicker(mk)) as any[];
  const warn = readBlockList();
  const rows = tk.sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h).slice(0, limit)
    .map((t, i) => `${i + 1}. ${t.market} ${fmt(t.trade_price)} 24h ${(t.signed_change_rate * 100).toFixed(2)}% 대금 ${(t.acc_trade_price_24h / 1e8).toFixed(0)}억 고 ${fmt(t.high_price)} 저 ${fmt(t.low_price)}${warn[t.market] ? ' ⚠유의' : ''}`);
  return text(`## ${kstNow()} KST · KRW ${mk.length}종 중 거래대금 상위 ${limit}\n${rows.join('\n')}`);
});

const UNITS: Record<string, number | 'day'> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 'day' };
server.tool('candles', '캔들(KST, 오래된→최근). 마지막 줄은 진행 중일 수 있음. 열: 시각 시가 고가 저가 종가 거래대금(백만원).', {
  market: z.string(), interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']), count: z.number().int().min(5).max(200).default(60),
}, async ({ market, interval, count }) => {
  const u = UNITS[interval];
  const raw = (u === 'day' ? await getUpbitClient().getCandlesDays(market, count) : await getUpbitClient().getCandlesMinutes(u as any, market, count)) as any[];
  const rows = raw.reverse().map((x) => `${x.candle_date_time_kst.slice(5, 16).replace('T', ' ')} ${fmt(x.opening_price)} ${fmt(x.high_price)} ${fmt(x.low_price)} ${fmt(x.trade_price)} ${(x.candle_acc_trade_price / 1e6).toFixed(0)}`);
  return text(`## ${market} ${interval} ${rows.length}개\n${rows.join('\n')}`);
});

/** 지표는 코드가 계산한다 — AI 가 손으로 SMA50 을 잘못 적고 30회 실행을 그 숫자로 판단한 일(2026-10-15)이 있었다 */
server.tool('indicators', '코드가 계산한 지표. 일봉: SMA20/50/100/200·종가 대비 %, RSI14, RSI2, ATR14(%), 20일 고저·박스폭, 7/14/30일 수익, 실현변동성(20일, 연환산). 4h/1h: SMA20/50, RSI14, ATR14, 최근 N봉 고저. 확정봉 기준(진행 중인 봉 제외).', {
  market: z.string(), interval: z.enum(['1h', '4h', '1d']).default('1d'),
}, async ({ market, interval }) => {
  const u = UNITS[interval];
  let raw = (u === 'day' ? await getUpbitClient().getCandlesDays(market, 200) : await getUpbitClient().getCandlesMinutes(u as any, market, 200)) as any[];
  if (u === 'day' && raw.length === 200) {   // SMA200 에 확정봉 200개가 필요 → 한 페이지 더
    const older = (await getUpbitClient().getCandlesDays(market, 60, raw[raw.length - 1].candle_date_time_utc)) as any[];
    raw = [...raw, ...older.filter((x) => x.candle_date_time_utc < raw[raw.length - 1].candle_date_time_utc)];
  }
  raw = raw.reverse();
  const bars = raw.slice(0, -1);   // 마지막(진행 중) 제외
  const c = bars.map((x) => x.trade_price as number), h = bars.map((x) => x.high_price as number), lo = bars.map((x) => x.low_price as number);
  const n = c.length, last = c[n - 1];
  const sma = (k: number) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
  const rsi = (k: number) => { if (n < k + 1) return null; let g = 0, l = 0; for (let i = n - k; i < n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + (g / k) / (l / k)); };
  const atr = (k: number) => { if (n < k + 1) return null; let s = 0; for (let i = n - k; i < n; i++) s += Math.max(h[i] - lo[i], Math.abs(h[i] - c[i - 1]), Math.abs(lo[i] - c[i - 1])); return s / k / last * 100; };
  const ret = (k: number) => (n > k ? (last / c[n - 1 - k] - 1) * 100 : null);
  const hi20 = Math.max(...h.slice(-20)), lo20 = Math.min(...lo.slice(-20));
  const f = (x: number | null, d = 2) => (x == null ? '-' : x.toFixed(d));
  const pct = (m: number | null) => (m == null ? '-' : ((last / m - 1) * 100).toFixed(2) + '%');
  const lines = [`## ${market} ${interval} 지표 (확정봉 ${n}개, 마지막 확정 ${bars[n - 1].candle_date_time_kst.slice(5, 16).replace('T', ' ')} KST 종가 ${fmt(last)})`];
  if (interval === '1d') {
    const rv = (() => { if (n < 21) return null; const r = []; for (let i = n - 20; i < n; i++) r.push(Math.log(c[i] / c[i - 1])); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(365) * 100; })();
    lines.push(`SMA20 ${fmt(sma(20))} (${pct(sma(20))}) · SMA50 ${fmt(sma(50))} (${pct(sma(50))}) · SMA100 ${fmt(sma(100))} (${pct(sma(100))}) · SMA200 ${fmt(sma(200))} (${pct(sma(200))})`,
      `RSI14 ${f(rsi(14), 1)} · RSI2 ${f(rsi(2), 1)} · ATR14 ${f(atr(14))}% · 실현변동성(20일, 연) ${f(rv, 1)}%`,
      `20일 고 ${fmt(hi20)} / 저 ${fmt(lo20)} · 박스폭 ${((hi20 / lo20 - 1) * 100).toFixed(1)}% · 종가 위치 ${(((last - lo20) / (hi20 - lo20)) * 100).toFixed(0)}%`,
      `수익 7일 ${f(ret(7))}% · 14일 ${f(ret(14))}% · 30일 ${f(ret(30))}%`);
  } else {
    lines.push(`SMA20 ${fmt(sma(20))} (${pct(sma(20))}) · SMA50 ${fmt(sma(50))} (${pct(sma(50))}) · RSI14 ${f(rsi(14), 1)} · ATR14 ${f(atr(14))}%`,
      `최근 20봉 고 ${fmt(hi20)} / 저 ${fmt(lo20)} · 최근 6봉 수익 ${f(ret(6))}% · 최근 24봉 ${f(ret(24))}%`);
  }
  return text(lines.join('\n'));
});

server.tool('orderbook', '호가창 상위 15단 + 스프레드(bp) + 양쪽 잔량 합.', { market: z.string() }, async ({ market }) => {
  const ob = ((await getUpbitClient().getOrderbook([market])) as any[])[0];
  if (!ob) return text('호가 없음');
  const u = ob.orderbook_units as any[];
  const sp = (u[0].ask_price / u[0].bid_price - 1) * 1e4;
  const askK = u.reduce((a, x) => a + x.ask_price * x.ask_size, 0), bidK = u.reduce((a, x) => a + x.bid_price * x.bid_size, 0);
  return text([`## ${market} 스프레드 ${sp.toFixed(1)}bp · 매도잔량 ${(askK / 1e6).toFixed(0)}백만 / 매수잔량 ${(bidK / 1e6).toFixed(0)}백만`,
    ...u.map((x) => `매도 ${fmt(x.ask_price)} ×${x.ask_size.toPrecision(4)} | 매수 ${fmt(x.bid_price)} ×${x.bid_size.toPrecision(4)}`)].join('\n'));
});

const NEWS_CACHE = path.join(AT_DIR, 'news-cache.json');
server.tool('news', '뉴스 헤드라인(크립토·국내·거시 RSS 13종) + 업비트 경고 공지 + 경제 캘린더 + 시장 반응(S&P·나스닥 선물·10년물·DXY·VIX). 10분 캐시.', {
  hours: z.number().min(1).max(48).default(6),
}, async ({ hours }) => {
  try { const c = JSON.parse(fs.readFileSync(NEWS_CACHE, 'utf8')); if (c.hours === hours && Date.now() - c.ts < 10 * 60e3) return text(c.out); } catch { /* 없음 */ }
  let out = '';
  try { out = execFileSync('npx', ['tsx', 'scripts/ai-feed.ts', '--since-hours', String(hours)], { encoding: 'utf8', timeout: 120_000 }); }
  catch (e: any) { out = `피드 실패: ${e?.message || e}`; }
  out = out.split('\n').filter((l) => !/npm notice/.test(l)).join('\n');
  fs.mkdirSync(AT_DIR, { recursive: true }); fs.writeFileSync(NEWS_CACHE, JSON.stringify({ ts: Date.now(), hours, out }));
  return text(out);
});

server.tool('fleet', '같은 장부의 규칙 기반 페이퍼 전략들(추세·테더·BTC 급락 흡수·알트 스윙·RS_LAG·F7)의 현재 보유와 마지막 판단 — 참고용 신호.', {}, async () => {
  const dirs: [string, string][] = SIMPLE_STRATEGIES.map((s) => [s.id, path.dirname(s.state)]);
  for (const [id, d] of [['F7_sl', 'paper-f7sl'], ['F7_btc', 'paper-f7btc']]) dirs.push([id, path.resolve('data', d)]);
  const out: string[] = [];
  for (const [id, d] of dirs) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
      const last = readLines(path.join(d, 'ticks.jsonl'), 1)[0];
      const t = last ? JSON.parse(last) : null;
      const hint = t ? ['detail', 'action', 'skip', 'z', 'prem', 'btc7', 'regimeOn', 'order'].filter((k) => t[k] != null).map((k) => `${k}=${typeof t[k] === 'object' ? JSON.stringify(t[k]) : t[k]}`).join(' ') : '';
      out.push(`- ${id}: 보유 ${(st.positions || []).map((p: any) => p.market).join(',') || '없음'} · 현금 ${fmt(st.cash)} · ${t ? kst(t.ts) : ''} ${hint}`.slice(0, 300));
    } catch { /* 없는 전략 */ }
  }
  return text(`## 규칙 기반 함대 (${kstNow()} KST)\n${out.join('\n')}`);
});

server.tool('buy', '페이퍼 매수. market 예: KRW-BTC. 시장가는 호가창 VWAP 즉시 체결, 지정가는 현재가보다 낮게만(0.2% 관통 시 체결, 금액은 접수 시 묶임). 한도 위반이면 거부 사유를 돌려준다.', {
  market: z.string(), krw: z.number().positive(), type: z.enum(['market', 'limit']), limit_price: z.number().positive().optional(), reason: z.string().min(5).max(300),
}, async ({ market, krw, type, limit_price, reason }) => {
  await processFills().catch(() => null);
  const r = await placeBuy(market, krw, type, limit_price, reason);
  return text(r.ok ? `✅ ${r.detail}` : `❌ 거부: ${r.reject}`);
});

server.tool('sell', '페이퍼 매도. fraction = 보유 수량 대비 비율(0~1, 1=전량). 시장가는 호가창 VWAP, 지정가는 현재가보다 높게만(0.2% 관통 시 체결).', {
  market: z.string(), fraction: z.number().gt(0).max(1), type: z.enum(['market', 'limit']), limit_price: z.number().positive().optional(), reason: z.string().min(5).max(300),
}, async ({ market, fraction, type, limit_price, reason }) => {
  await processFills().catch(() => null);
  const r = await placeSell(market, fraction, type, limit_price, reason);
  return text(r.ok ? `✅ ${r.detail}` : `❌ 거부: ${r.reject}`);
});

server.tool('cancel', '대기 지정가 주문 취소(매수면 묶인 금액 반환).', { order_id: z.string() }, async ({ order_id }) => {
  const r = await cancelOrder(order_id);
  return text(r.ok ? `✅ ${r.detail}` : `❌ ${r.reject}`);
});

server.tool('journal_read', '내 지난 판단 일지(최근 n개). 이전 실행의 가설·무효화 조건·다음 확인 사항을 이어받는 기억이다.', { n: z.number().int().min(1).max(30).default(8) }, async ({ n }) => {
  const rows = readLines(AT_JOURNAL_FILE, n).map((l) => { const j = JSON.parse(l); return `### ${j.at}\n${j.text}`; });
  return text(rows.length ? rows.join('\n\n') : '일지 없음(첫 실행).');
});

server.tool('journal_write', '이번 판단 기록. 매 실행 끝에 반드시 1회: 시장 해석 · 한 일/안 한 일과 이유 · 보유별 가설과 무효화 조건 · 다음 실행에서 확인할 것. 1,500자 이내.', { text: z.string().min(20).max(1500) }, async ({ text: t }) => {
  fs.mkdirSync(AT_DIR, { recursive: true });
  fs.appendFileSync(AT_JOURNAL_FILE, JSON.stringify({ ts: Date.now(), at: kstNow(), text: t }) + '\n');
  return text('기록됨');
});

const NEXT_FILE = path.join(AT_DIR, 'next-run.json');
server.tool('schedule_next', '다음 실행까지 쉴 시간(분)을 네가 정한다. 5~240. 안 부르면 15분. 급한 국면(발표 직후·급변·지정가 체결 임박)은 짧게, 조용한 새벽·주말은 길게 — 실행마다 비용이 든다. 단 BTC 가 마지막 실행 대비 ±2% 넘게 움직이면 예정과 무관하게 깨어난다. 매 실행 마지막에 부를 것.', {
  minutes: z.number().int().min(5).max(240), reason: z.string().min(3).max(200),
}, async ({ minutes, reason }) => {
  fs.mkdirSync(AT_DIR, { recursive: true });
  const nextTs = Date.now() + minutes * 60_000;
  fs.writeFileSync(NEXT_FILE, JSON.stringify({ nextTs, minutes, reason, setTs: Date.now(), setAt: kstNow() }));
  return text(`다음 실행 ≈ ${kst(nextTs)} KST (${minutes}분 뒤) — ${reason}`);
});

server.tool('playbook_read', '내 매매 원칙 문서(스스로 다듬는 규칙집).', {}, async () => text(fs.existsSync(AT_PLAYBOOK_FILE) ? fs.readFileSync(AT_PLAYBOOK_FILE, 'utf8') : '(비어 있음)'));
server.tool('playbook_update', '매매 원칙 문서를 통째로 교체. 언제든 고칠 수 있으나 무엇을 왜 바꿨는지 문서 안에 적을 것. 6,000자 이내.', { text: z.string().min(50).max(6000) }, async ({ text: t }) => {
  fs.mkdirSync(AT_DIR, { recursive: true });
  if (fs.existsSync(AT_PLAYBOOK_FILE)) fs.copyFileSync(AT_PLAYBOOK_FILE, AT_PLAYBOOK_FILE.replace(/\.md$/, `.${Date.now()}.bak.md`));
  fs.writeFileSync(AT_PLAYBOOK_FILE, t);
  return text('원칙 문서 갱신됨(이전 판 백업)');
});

(async () => { await server.connect(new StdioServerTransport()); })();
