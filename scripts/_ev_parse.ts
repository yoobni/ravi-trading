/** 축 C: 공지 → 이벤트 표 (data/research-ext/events.json) */
import fs from 'fs';
const d: any[] = Object.values(JSON.parse(fs.readFileSync('data/research-ext/ann-detail.json', 'utf8')));
const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const STOP = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'ATH', 'NFT', 'TOP', 'KST', 'API', 'X', 'SSC']);
function syms(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(/\(([^)]*)\)/g)) for (const t of m[1].split(/[,\s]+/)) if (/^[A-Z0-9]{2,12}$/.test(t) && !STOP.has(t)) out.add(t);
  return [...out];
}
function typeOf(t: string): string | null {
  if (/이벤트|당첨|업데이트 안내|연기|변경/.test(t) && !/신규 거래지원 안내|디지털 자산 추가|지정 안내|종료 안내|해제 안내|촉구/.test(t)) return null;
  if (/유의 ?종목.*해제/.test(t)) return 'CAUTION_OFF';
  if (/유의 ?종목.*지정/.test(t)) return 'CAUTION_ON';
  if (/유의 촉구/.test(t)) return 'WARN';
  if (/거래지원 종료/.test(t)) return 'DELIST';
  if (/신규 거래지원|디지털 자산 추가|마켓 추가/.test(t)) return /KRW/.test(t) ? 'LIST_KRW' : 'LIST_NONKRW';
  return null;
}
function parseOpen(body: string, annTs: number): number | null {
  const s = strip(body);
  const m = s.match(/거래\s*지원 개시 시점[^0-9즉]*?(\d{1,2})월 (\d{1,2})일 (\d{1,2})시(?: (\d{1,2})분)?/) || s.match(/(\d{1,2})월 (\d{1,2})일 (\d{1,2})시(?: (\d{1,2})분)? 예정/);
  if (!m) return null;
  const y = new Date(annTs + 9 * 3600e3).getUTCFullYear();
  const ts = Date.UTC(y, +m[1] - 1, +m[2], +m[3], +(m[4] || 0)) - 9 * 3600e3;
  return ts < annTs - 86400e3 ? Date.UTC(y + 1, +m[1] - 1, +m[2], +m[3], +(m[4] || 0)) - 9 * 3600e3 : ts;
}
const ev: any[] = [];
for (const x of d) {
  const type = typeOf(x.title); if (!type) continue;
  const annTs = Date.parse(x.first_listed_at);
  for (const s of syms(x.title)) ev.push({ id: x.id, type, sym: s, annTs, ann: x.first_listed_at, openTs: type.startsWith('LIST') ? parseOpen(x.body || '', annTs) : null, title: x.title });
}
ev.sort((a, b) => a.annTs - b.annTs);
fs.writeFileSync('data/research-ext/events.json', JSON.stringify(ev, null, 1));
const c: Record<string, number> = {}; for (const e of ev) c[e.type] = (c[e.type] || 0) + 1;
console.log(c, 'LIST_KRW openTs parsed', ev.filter(e => e.type === 'LIST_KRW' && e.openTs).length);
for (const t of Object.keys(c)) { const xs = ev.filter(e => e.type === t); console.log(t, xs[0].ann.slice(0, 10), '~', xs.at(-1).ann.slice(0, 10)); }
console.log(ev.filter(e => e.type === 'LIST_KRW').slice(-5).map(e => `${e.sym} ann ${e.ann} open ${e.openTs ? new Date(e.openTs + 9 * 3600e3).toISOString().slice(0, 16) : '-'}`).join('\n'));
