/**
 * AI 리스크 데스크 리서치(2026-10) — A-1: 업비트 공지 사건 카탈로그 (리서치 전용, 라이브 무관, API 호출 없음)
 * 입력: data/research-ext/announcements.json (5,869건, 2017~2026-10-02)
 * 출력: data/research-ext/riskdesk-2026-10/ann-catalog.json  [{id, ts, type, sub, sym, scope, title}]
 *       data/research-ext/riskdesk-2026-10/ann-catalog.txt   (분류 집계·코인별 타임라인 요약)
 * 분류(제목 기반): CAUTION_ON / CAUTION_EXT / CAUTION_OFF / WARN(유의 촉구) / DELIST(scope KRW|OTHER) / DW_SUSPEND(sub FORK|MAINT|ISSUE|PLAIN)
 *   / DW_RESUME / FORK_SWAP / LIST(scope KRW|OTHER) / OTHER
 * 사건 시각 = first_listed_at (KST). 일봉 인덱스 = 그 시각이 속한 업비트 일봉(KST 09:00 경계).
 */
import fs from 'fs';
const OUT = 'data/research-ext/riskdesk-2026-10';
const A: any[] = JSON.parse(fs.readFileSync('data/research-ext/announcements.json', 'utf8'));
const STOP = new Set(['KRW', 'NFT', 'KCT', 'ERC', 'ERC20', 'BEP', 'BEP20', 'TRC', 'TRC20', 'SPL', 'API', 'KST', 'UTC', 'AM', 'PM', 'USD', 'EVM', 'DEX', 'CEX', 'DAXA', 'FIU', 'ETF', 'IP', 'OTC', 'PC', 'APP', 'IOS', 'WEB', 'QR', 'OTP', 'ATM', 'SSL', 'DNS', 'CS', 'FAQ', 'MM', 'DD', 'HH', 'ID', 'PIN', 'NEW', 'MAX', 'MIN', 'TOP', 'VIP', 'POS', 'POW', 'DAO', 'L2', 'L1', 'TPS', 'AI']);
const MARKETS = new Set(fs.readdirSync('data/research-ext/daily').filter(f => f.startsWith('KRW-')).map(f => f.slice(4, -5)));
function syms(title: string, allowBare: boolean): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(/\(([^)]*)\)/g)) for (const t of m[1].split(/[,\s·/]+/)) { const u = t.trim(); if (/^[A-Z0-9]{2,12}$/.test(u) && !STOP.has(u) && !/^\d+$/.test(u)) out.add(u); }
  if (allowBare || out.size === 0) {
    const bare = title.replace(/\([^)]*\)/g, ' ');
    for (const t of bare.split(/[,\s·/]+/)) { const u = t.trim(); if (/^[A-Z0-9]{2,12}$/.test(u) && !STOP.has(u) && !/^\d+$/.test(u) && !/^(BTC|ETH|USDT)$/.test(u)) out.add(u); }
    // 'BTC 마켓' 같은 마켓 명은 제외했으나 BTC/ETH/USDT 자체가 대상인 경우("ETH 입출금 일시 중단")는 '마켓' 단어가 바로 뒤에 없을 때 포함
    for (const c of ['BTC', 'ETH', 'USDT']) if (new RegExp(`(^|[\\s,])${c}(?![\\s]*마켓)(?=[\\s,]|$)`).test(bare) && !/마켓/.test(bare)) out.add(c);
  }
  return [...out];
}
interface Ev { id: number; ts: number; at: string; type: string; sub?: string; scope?: string; sym: string; title: string; cat: string }
const ev: Ev[] = [];
const typeCount: Record<string, number> = {};
let unclassified: string[] = [];
for (const a of A) {
  const t: string = a.title; const cat: string = a.category;
  if (cat === 'NFT' || cat === '이벤트' || /NFT/.test(t)) continue;
  const ts = Date.parse(a.first_listed_at || a.listed_at);
  const push = (type: string, ss: string[], extra: Partial<Ev> = {}) => { for (const s of ss) ev.push({ id: a.id, ts, at: a.first_listed_at, type, sym: s, title: t, cat, ...extra }); typeCount[type] = (typeCount[type] || 0) + (ss.length ? 1 : 0); };
  let done = false;
  // 거래지원 종료 (+ 꼬리의 유의 종목 해제)
  if (/거래 ?지원 종료/.test(t) && !/정책|사유 및|말씀드립니다|관련 안내$/.test(t)) {
    const tail = t.match(/-\s*([A-Z0-9, ]+)\s*유의 ?종목 해제/);
    const head = tail ? t.replace(tail[0], '') : t;
    const nonKrw = /(BTC|ETH|USDT) 마켓 거래 ?지원 종료/.test(head) && !/KRW/.test(head) || /\/(BTC|ETH|USDT)\b/.test(head) && !/\/KRW/.test(head);
    let ss = syms(head, false); if (!ss.length) ss = syms(head, true);
    // "X/BTC, Y/ETH 마켓" 형식
    for (const m of head.matchAll(/([A-Z0-9]{2,10})\/(BTC|ETH|USDT|KRW)/g)) ss.push(m[1]);
    push('DELIST', [...new Set(ss)], { scope: nonKrw ? 'OTHER' : 'KRW' });
    if (tail) push('CAUTION_OFF', tail[1].split(/[,\s]+/).filter(x => /^[A-Z0-9]{2,12}$/.test(x)));
    done = true;
  }
  if (!done && /유의 ?종목/.test(t)) {
    if (/해제/.test(t) && !/지정 안내/.test(t)) push('CAUTION_OFF', syms(t, false));
    else if (/기간 연장/.test(t)) push('CAUTION_EXT', syms(t, false));
    else if (/지정/.test(t)) push('CAUTION_ON', syms(t, false));
    else push('OTHER', []);
    done = true;
  }
  if (!done && /유의 촉구/.test(t)) { push('WARN', syms(t, false).length ? syms(t, false) : syms(t, true)); done = true; }
  if (!done && /(입출금|출금|입금)[^재]*(중단|제한)/.test(t) && !/원화|계좌|서비스 점검|보안|특정금융|미신고/.test(t)) {
    const sub = /하드포크|네트워크 업그레이드|메인넷|스왑|리브랜딩|마이그레이션|네트워크 전환|컨트랙트|업그레이드/.test(t) ? 'FORK' : /월렛 시스템 점검|정기 실사|점검|서버/.test(t) ? 'MAINT' : /이슈|해킹|사고|장애|보안|사업 중단|종료/.test(t) ? 'ISSUE' : 'PLAIN';
    push('DW_SUSPEND', syms(t, true), { sub }); done = true;
  }
  if (!done && /(입출금|출금|입금) ?재개/.test(t)) { push('DW_RESUME', syms(t, true)); done = true; }
  if (!done && /하드포크|토큰 스왑|리브랜딩|메인넷 (지원|전환)|네트워크 전환|마이그레이션/.test(t)) { push('FORK_SWAP', syms(t, true)); done = true; }
  if (!done && /신규 거래지원|디지털 자산 추가|마켓 추가|암호화폐 추가/.test(t) && !/스테이킹|취소/.test(t)) {
    const krw = /KRW|원화/.test(t) || (!/(BTC|ETH|USDT) 마켓/.test(t) && /신규 거래지원 안내/.test(t) && /KRW/.test(t));
    push('LIST', syms(t, false), { scope: krw ? 'KRW' : 'OTHER' }); done = true;
  }
  if (!done) { typeCount.OTHER = (typeCount.OTHER || 0) + 1; if (/거래|자산/.test(cat)) unclassified.push(t); }
}
ev.sort((a, b) => a.ts - b.ts);
fs.writeFileSync(`${OUT}/ann-catalog.json`, JSON.stringify(ev));
const L: string[] = [];
L.push('announcements classified (notice count by type, NFT/이벤트 제외): ' + JSON.stringify(typeCount));
const byType: Record<string, Ev[]> = {}; for (const e of ev) (byType[e.type] ||= []).push(e);
for (const [k, v] of Object.entries(byType)) {
  const subs: Record<string, number> = {}; for (const e of v) { const key = (e.scope || e.sub || '-'); subs[key] = (subs[key] || 0) + 1; }
  const yrs: Record<string, number> = {}; for (const e of v) { const y = e.at.slice(0, 4); yrs[y] = (yrs[y] || 0) + 1; }
  L.push(`${k.padEnd(12)} coin-events ${String(v.length).padStart(4)} | sub/scope ${JSON.stringify(subs)} | by year ${JSON.stringify(yrs)}`);
}
// 코인별 타임라인
const byCoin = new Map<string, Ev[]>(); for (const e of ev) { if (!byCoin.has(e.sym)) byCoin.set(e.sym, []); byCoin.get(e.sym)!.push(e); }
const DAY = 86400e3;
// 유의 지정 → KRW 상폐까지 일수 (첫 ON 이후 다음 사건이 DELIST KRW 인 경우; 해제가 먼저면 '해제')
const onToDelist: number[] = []; let onThenOff = 0, onOpen = 0, onThenDelist = 0;
const rows: string[] = [];
for (const [c, xs] of byCoin) {
  const ons = xs.filter(e => e.type === 'CAUTION_ON');
  for (const on of ons) {
    const after = xs.filter(e => e.ts > on.ts && (e.type === 'CAUTION_OFF' || (e.type === 'DELIST' && e.scope === 'KRW')));
    const nx = after[0];
    if (!nx) { onOpen++; continue; }
    if (nx.type === 'CAUTION_OFF') onThenOff++; else { onThenDelist++; onToDelist.push((nx.ts - on.ts) / DAY); }
  }
}
onToDelist.sort((a, b) => a - b);
const q = (a: number[], p: number) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;
L.push(`CAUTION_ON → next terminal event: delist(KRW) ${onThenDelist} (days to delist p25/p50/p75 = ${q(onToDelist, .25).toFixed(0)}/${q(onToDelist, .5).toFixed(0)}/${q(onToDelist, .75).toFixed(0)}, min ${onToDelist[0]?.toFixed(0)} max ${onToDelist.at(-1)?.toFixed(0)}) | lifted ${onThenOff} | still open/no record ${onOpen}`);
// 상폐(KRW) 코인 중 사전 유의 지정이 있었던 비율
const delK = ev.filter(e => e.type === 'DELIST' && e.scope === 'KRW');
const delCoins = new Set(delK.map(e => e.sym));
let withOn = 0, withAnyNeg = 0; const lead: number[] = [];
for (const c of delCoins) {
  const xs = byCoin.get(c)!; const d = xs.find(e => e.type === 'DELIST' && e.scope === 'KRW')!;
  const on = xs.filter(e => e.ts < d.ts && (e.type === 'CAUTION_ON')).at(-1);
  if (on) { withOn++; lead.push((d.ts - on.ts) / DAY); }
  if (xs.some(e => e.ts < d.ts && e.ts > d.ts - 90 * DAY && ['CAUTION_ON', 'CAUTION_EXT', 'WARN', 'DW_SUSPEND'].includes(e.type))) withAnyNeg++;
}
lead.sort((a, b) => a - b);
L.push(`KRW delist coins ${delCoins.size}: preceded by CAUTION_ON ${withOn} (lead days p50 ${q(lead, .5).toFixed(0)}, p25 ${q(lead, .25).toFixed(0)}, p75 ${q(lead, .75).toFixed(0)}) | any negative notice within 90d before ${withAnyNeg}`);
L.push(`KRW delist coins still in daily/ (survivor data): ${[...delCoins].filter(c => MARKETS.has(c)).length} (${[...delCoins].filter(c => MARKETS.has(c)).join(',')})`);
L.push(`KRW delist coins NOT in daily/ (need external data): ${[...delCoins].filter(c => !MARKETS.has(c)).length}`);
fs.writeFileSync(`${OUT}/delisted-krw.json`, JSON.stringify([...delCoins].map(c => { const xs = byCoin.get(c)!; const d = xs.find(e => e.type === 'DELIST' && e.scope === 'KRW')!; return { sym: c, delistAnn: d.at, inDaily: MARKETS.has(c) }; })));
// 유의 지정 코인 중 데이터 없음
const onCoins = new Set(ev.filter(e => e.type === 'CAUTION_ON' || e.type === 'WARN').map(e => e.sym));
L.push(`CAUTION_ON/WARN coins ${onCoins.size}: in daily/ ${[...onCoins].filter(c => MARKETS.has(c)).length}, not ${[...onCoins].filter(c => !MARKETS.has(c)).length}`);
fs.writeFileSync(`${OUT}/need-external.json`, JSON.stringify([...new Set([...delCoins, ...onCoins])].filter(c => !MARKETS.has(c))));
L.push('\nunclassified (거래/디지털 자산 카테고리) sample: ' + unclassified.slice(0, 40).join(' || '));
L.push('\nsample CAUTION_ON: ' + byType.CAUTION_ON.slice(-8).map(e => `${e.at.slice(0, 10)} ${e.sym}`).join(' | '));
L.push('sample DELIST KRW: ' + delK.slice(-12).map(e => `${e.at.slice(0, 10)} ${e.sym}`).join(' | '));
L.push('sample DW_SUSPEND PLAIN: ' + byType.DW_SUSPEND.filter(e => e.sub === 'PLAIN').slice(-10).map(e => `${e.at.slice(0, 10)} ${e.sym} [${e.title.slice(0, 40)}]`).join(' | '));
L.push('sample WARN: ' + byType.WARN.slice(-10).map(e => `${e.at.slice(0, 10)} ${e.sym} [${e.title.slice(0, 50)}]`).join(' | '));
// 코인별 타임라인 파일
const tl: string[] = [];
for (const [c, xs] of [...byCoin].sort((a, b) => a[0].localeCompare(b[0]))) tl.push(`${c}: ` + xs.map(e => `${e.at.slice(0, 10)} ${e.type}${e.scope ? '/' + e.scope : ''}${e.sub ? '/' + e.sub : ''}`).join(' → '));
fs.writeFileSync(`${OUT}/coin-timeline.txt`, tl.join('\n'));
fs.writeFileSync(`${OUT}/ann-catalog.txt`, L.join('\n'));
console.log('done', ev.length);
