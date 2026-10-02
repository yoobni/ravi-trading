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
  // 매크로 일정(앞으로 48h). 발표 시각 근사: CPI·고용 08:30 ET, FOMC 14:00 ET (UTC, 서머타임 기준)
  try {
    const m = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/research-ext/macro/macro-dates.json'), 'utf8'));
    const items: string[] = [];
    for (const [k, v] of Object.entries<any>(m)) for (const d of (Array.isArray(v) ? v : [])) { const t = Date.parse(d) + (k === 'fomc' ? 18 : 12.5) * 3600e3; if (t >= now && t <= now + 48 * 3600e3) items.push(`${k} ${kst(t)}`); }
    console.log(`## 매크로 일정(48h): ${items.length ? items.join(' · ') : '없음'}`);
  } catch { console.log('## 매크로 일정: 데이터 없음'); }
})();
