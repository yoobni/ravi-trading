/**
 * 업비트 경고성 공지 리스크 규칙 (2026-10-02 축 C → 2026-10-13 리스크데스크 검증으로 개정, data/research-ext/riskdesk-2026-10/).
 *
 * 공지 5,869건(2017~2026) 사후 검증:
 *   유의 종목 **지정**(n=39): 공지일 −8.4%, 이후 1일 중앙 −3.2%, 7일 −6.4%, 30일 −15%. 75% 가 중앙 14일 뒤 상폐.
 *   유의 **촉구**(n=34): 공지일 −4.3%, 이후 7일 중앙 −4.7%, 30일 ≈0 — 그리고 **해제 공지가 없다**(영구 차단되면 목록만 자란다).
 *   유의 **해제**(n=15): 해제 후 7일 −10%, 30일 −12% → 해제를 재진입 신호로 쓰면 안 된다.
 *   입출금 일시중단(n=980): 1일 중앙 0.0% → 신호 아님(거부 사유로 쓰면 RS_LAG 연 −3~−4%p).
 *
 * 규칙:
 *   지정·연장  → 차단(만료 없음) + 보유분 즉시 시장가 청산. 공지 자체가 충격(SAND 15분 −18%)이라 막는 건 이후 드리프트뿐.
 *   촉구       → 차단 30일 + 보유분 청산.
 *   해제       → 청산은 안 하되 차단은 7일 더 유지.
 *   각 tick 은 진입 직전 isWarningBlocked 로 건너뛴다.
 */
import fs from 'fs';
import path from 'path';

export const WARNING_DIR = path.resolve(process.cwd(), 'data', 'paper-warnings');
export const WARNING_BLOCK_FILE = path.join(WARNING_DIR, 'blocked.json');
export const WARNING_LOG_FILE = path.join(WARNING_DIR, 'events.jsonl');

export type WarningKind = 'ON' | 'WARN' | 'OFF';
export interface WarningNotice { id: number; title: string; at: string; markets: string[]; kind: WarningKind }
/** until 없음 = 만료 없음. liquidate = 감시 스크립트가 보유분을 청산해야 하는 항목 */
export type BlockList = Record<string, { since: string; title: string; kind?: WarningKind; until?: string; liquidate?: boolean }>;

export const WARN_BLOCK_DAYS = 30;
export const OFF_HOLD_DAYS = 7;

/** 제목에서 괄호 안 심볼을 뽑아 KRW 마켓으로. 예: "인젝티브(INJ) 거래 유의 종목 지정 안내" → KRW-INJ */
function marketsOf(title: string): string[] {
  return [...title.matchAll(/\(([A-Z0-9]{2,15})\)/g)].map((m) => `KRW-${m[1]}`);
}

export function classifyWarning(title: string): WarningKind | null {
  if (/유의 ?종목.*해제/.test(title)) return 'OFF';
  if (/유의 ?종목.*지정/.test(title)) return 'ON';   // '지정 기간 연장'도 ON
  if (/유의 ?촉구/.test(title)) return 'WARN';
  return null;
}

/** 공지 최신 N페이지에서 경고성 공지만. 업비트 공지 API(공개). 실패 시 빈 배열. */
export async function fetchWarningNotices(pages = 2): Promise<WarningNotice[]> {
  const out: WarningNotice[] = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const r = await fetch(`https://api-manager.upbit.com/api/v1/announcements?os=web&page=${p}&per_page=20&category=all`);
      const j: any = await r.json();
      for (const n of j?.data?.notices || []) {
        const kind = classifyWarning(n.title);
        const markets = marketsOf(n.title);
        if (kind && markets.length) out.push({ id: n.id, title: n.title, at: n.first_listed_at || n.listed_at, markets, kind });
      }
    } catch { /* 네트워크 실패는 다음 주기에 다시 */ }
  }
  return out;
}

/** 공지 한 건을 차단 목록에 반영 */
export function applyWarning(block: BlockList, n: WarningNotice) {
  const at = Date.parse(n.at) || Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const m of n.markets) {
    if (n.kind === 'ON') block[m] = { since: n.at, title: n.title, kind: 'ON', liquidate: true };
    else if (n.kind === 'WARN') block[m] = { since: n.at, title: n.title, kind: 'WARN', until: iso(at + WARN_BLOCK_DAYS * 86400e3), liquidate: true };
    else block[m] = { since: n.at, title: n.title, kind: 'OFF', until: iso(at + OFF_HOLD_DAYS * 86400e3), liquidate: false };
  }
}

export function readBlockList(): BlockList {
  try { return JSON.parse(fs.readFileSync(WARNING_BLOCK_FILE, 'utf8')); } catch { return {}; }
}
export function writeBlockList(b: BlockList) {
  if (!fs.existsSync(WARNING_DIR)) fs.mkdirSync(WARNING_DIR, { recursive: true });
  fs.writeFileSync(WARNING_BLOCK_FILE, JSON.stringify(b, null, 2));
}
/** 만료된 항목 제거(변경 여부 반환) */
export function pruneBlockList(b: BlockList, now = Date.now()): boolean {
  let changed = false;
  for (const [m, e] of Object.entries(b)) if (e.until && Date.parse(e.until) < now) { delete b[m]; changed = true; }
  return changed;
}
/** tick 진입 직전 확인용. 파일이 없으면 아무것도 막지 않는다. */
export function isWarningBlocked(market: string, now = Date.now()): boolean {
  const e = readBlockList()[market];
  return !!e && !(e.until && Date.parse(e.until) < now);
}
