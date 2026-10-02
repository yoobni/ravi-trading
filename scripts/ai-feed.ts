#!/usr/bin/env tsx
/**
 * AI 리스크 감시관 입력 수집 — RSS 8종 + 업비트 경고 공지 + 다가오는 매크로 일정을 모아 '새 헤드라인'만 짧게 출력한다.
 * Claude Code 세션의 예약 작업이 이 출력을 읽고 data/ai-filter/stance.json 을 갱신한다(LLM 호출은 세션 쪽).
 * 사용: npx tsx scripts/ai-feed.ts [--since-hours 24]   (기본: 지난 실행 이후 새 것만)
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'ai-feed');
const STORE = path.join(DIR, 'headlines.jsonl');
const CURSOR = path.join(DIR, 'cursor.json');
const FEEDS: [string, string][] = [
  ['cointelegraph', 'https://cointelegraph.com/rss'], ['decrypt', 'https://decrypt.co/feed'], ['theblock', 'https://www.theblock.co/rss.xml'],
  ['yna-econ', 'https://www.yna.co.kr/rss/economy.xml'], ['hankyung', 'https://www.hankyung.com/feed/finance'],
  ['tokenpost', 'https://www.tokenpost.kr/rss'], ['blockmedia', 'https://www.blockmedia.co.kr/feed'], ['fed', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  // 해외 거시·시장 (2026-10-02 추가 — 미국 금리·지표 발표에 크립토가 크게 흔들리므로)
  ['wsj-markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'], ['cnbc-economy', 'https://www.cnbc.com/id/20910258/device/rss/rss.html'],
  ['cnbc-top', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'], ['investing-econ', 'https://www.investing.com/rss/news_14.rss'],
  ['ft-markets', 'https://www.ft.com/markets?format=rss'],
];
const tag = (x: string, t: string) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : ''; };
const kst = (ts: number) => new Date(ts + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const i = process.argv.indexOf('--since-hours');
  const sinceH = i > 0 ? +process.argv[i + 1] : null;
  const seen = new Set<string>(fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).k) : []);
  const fresh: { k: string; src: string; ts: number; title: string; link: string }[] = [];
  for (const [src, url] of FEEDS) {
    try {
      const xml = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })).text();
      for (const it of xml.split(/<item[\s>]/).slice(1)) {
        const title = tag(it, 'title'); const link = tag(it, 'link');
        const d = Date.parse(tag(it, 'pubDate') || tag(it, 'dc:date')) || Date.now();
        const k = `${src}|${link || title}`;
        if (!title || seen.has(k)) continue;
        seen.add(k); fresh.push({ k, src, ts: d, title: title.slice(0, 160), link });
      }
    } catch (e: any) { console.log(`[feed] ${src} 실패: ${e?.message || e}`); }
  }
  for (const f of fresh) fs.appendFileSync(STORE, JSON.stringify(f) + '\n');
  const now = Date.now();
  let lastRun = 0; try { lastRun = JSON.parse(fs.readFileSync(CURSOR, 'utf8')).lastRun || 0; } catch { /* 첫 실행 */ }
  const from = sinceH != null ? now - sinceH * 3600e3 : lastRun || now - 6 * 3600e3;
  const all: any[] = fs.readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const show = all.filter((h) => h.ts >= from).sort((a, b) => b.ts - a.ts).slice(0, 80);
  fs.writeFileSync(CURSOR, JSON.stringify({ lastRun: now }));
  console.log(`## 헤드라인 ${show.length}건 (${kst(from)} 이후, KST)`);
  for (const h of show) console.log(`- [${kst(h.ts)} ${h.src}] ${h.title}`);
  // 업비트 경고 공지(최근 48h) + 차단 목록
  try {
    const ev = fs.readFileSync(path.resolve(process.cwd(), 'data/paper-warnings/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => Date.parse(e.at) >= now - 48 * 3600e3);
    console.log(`## 업비트 경고 공지(48h) ${ev.length}건`); for (const e of ev) console.log(`- ${e.kind} ${e.markets.join(',')} ${e.title}`);
  } catch { console.log('## 업비트 경고 공지: 없음'); }
  // 경제 캘린더(ForexFactory 주간 JSON, 무료): 지난 6h ~ 앞으로 48h 의 High 중요도 USD·EUR·JPY·CNY·GBP 이벤트 + Medium USD
  try {
    const cal: any[] = await (await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })).json();
    const evs = cal.filter((e) => (e.impact === 'High' && ['USD', 'EUR', 'JPY', 'CNY', 'GBP'].includes(e.country)) || (e.impact === 'Medium' && e.country === 'USD'))
      .map((e) => ({ ...e, t: Date.parse(e.date) })).filter((e) => e.t >= now - 6 * 3600e3 && e.t <= now + 48 * 3600e3).sort((a, b) => a.t - b.t);
    console.log(`## 경제 캘린더(−6h ~ +48h, KST) ${evs.length}건`);
    for (const e of evs) console.log(`- ${kst(e.t)} ${e.country} [${e.impact}] ${e.title}${e.forecast ? ` 예상 ${e.forecast}` : ''}${e.previous ? ` 이전 ${e.previous}` : ''}${e.t <= now ? ' ← 발표됨(결과는 헤드라인으로 확인)' : ''}`);
  } catch (e: any) { console.log(`## 경제 캘린더: 조회 실패 ${e?.message || e}`); }
  // 시장 반응 스냅샷(Yahoo 1h): 1시간·24시간 변화
  const SYMS: [string, string][] = [['S&P 선물', 'ES=F'], ['나스닥 선물', 'NQ=F'], ['미 10년물(%)', '^TNX'], ['달러지수', 'DX-Y.NYB'], ['VIX', '^VIX'], ['달러엔', 'JPY=X'], ['BTC-USD', 'BTC-USD']];
  const snap: string[] = [];
  for (const [name, sym] of SYMS) {
    try {
      const r = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&range=3d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })).json()).chart.result[0];
      const pts = r.timestamp.map((t: number, k: number) => [t * 1e3, r.indicators.quote[0].close[k]]).filter((x: any) => x[1] != null);
      const last = pts[pts.length - 1];
      const at = (ago: number) => { let v = pts[0][1]; for (const p of pts) if (p[0] <= last[0] - ago) v = p[1]; return v; };
      const ch = (a: number) => (sym === '^TNX' ? `${((last[1] - a) * 100).toFixed(0)}bp` : `${((last[1] / a - 1) * 100).toFixed(2)}%`);
      snap.push(`${name} ${(+last[1]).toFixed(sym === '^TNX' ? 3 : 2)} (1h ${ch(at(3600e3))}, 24h ${ch(at(86400e3))})`);
    } catch { snap.push(`${name} 조회실패`); }
  }
  console.log(`## 시장 반응: ${snap.join(' · ')}`);
})();
