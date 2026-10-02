/**
 * 업비트 경고성 공지 리스크 규칙 (2026-10-02, docs/RESEARCH-LOG.md 축 C).
 *
 * 근거: 28코인 유니버스에 해당한 '거래 유의 종목 지정' · '유의 촉구' 공지 7건(7년)이 전부 1일 수익 음수
 *   (−0.9 ~ −15.1%), 지정 후 반등도 없었다(유의종목 지정 n=22 1일 −8.7%). 빈도는 연 1건 수준이지만
 *   꼬리 손실을 막는 거의 공짜 보험이다.
 *
 * 규칙: 지정·촉구·기간연장 공지가 뜬 코인은 차단 목록에 올린다 → 감시 스크립트가 모든 전략의 보유분을 즉시
 *   시장가 청산하고, 각 tick 은 차단 코인의 신규 진입을 건너뛴다. '해제' 공지가 뜨면 차단을 푼다.
 */
import fs from 'fs';
import path from 'path';

export const WARNING_DIR = path.resolve(process.cwd(), 'data', 'paper-warnings');
export const WARNING_BLOCK_FILE = path.join(WARNING_DIR, 'blocked.json');
export const WARNING_LOG_FILE = path.join(WARNING_DIR, 'events.jsonl');

export interface WarningNotice { id: number; title: string; at: string; markets: string[]; kind: 'ON' | 'OFF' }
export type BlockList = Record<string, { since: string; title: string }>;

/** 제목에서 괄호 안 심볼을 뽑아 KRW 마켓으로. 예: "인젝티브(INJ) 거래 유의 종목 지정 안내" → KRW-INJ */
function marketsOf(title: string): string[] {
  return [...title.matchAll(/\(([A-Z0-9]{2,15})\)/g)].map((m) => `KRW-${m[1]}`);
}

export function classifyWarning(title: string): 'ON' | 'OFF' | null {
  if (/유의 ?종목.*해제/.test(title)) return 'OFF';
  if (/유의 ?종목.*지정/.test(title) || /유의 ?촉구/.test(title)) return 'ON';   // '지정 기간 연장'도 ON
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

export function readBlockList(): BlockList {
  try { return JSON.parse(fs.readFileSync(WARNING_BLOCK_FILE, 'utf8')); } catch { return {}; }
}
export function writeBlockList(b: BlockList) {
  if (!fs.existsSync(WARNING_DIR)) fs.mkdirSync(WARNING_DIR, { recursive: true });
  fs.writeFileSync(WARNING_BLOCK_FILE, JSON.stringify(b, null, 2));
}
/** tick 진입 직전 확인용. 파일이 없으면 아무것도 막지 않는다. */
export function isWarningBlocked(market: string): boolean {
  return !!readBlockList()[market];
}
