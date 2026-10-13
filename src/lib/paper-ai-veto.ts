/**
 * AI 코인별 거부권(veto) — 리스크 데스크(scripts/ai-riskdesk/run.ts)가 뉴스에서 **코인 고유 재난**(디페그·해킹·지급불능·
 * 체인 정지·소송/증권지정·상폐 위험)을 읽어 data/ai-filter/veto.json 에 쓴다. 쌍둥이(*_AI) 전략만 진입 직전에 본다.
 *
 * 2026-10-13 검증(riskdesk-2026-10): 업비트 공지 **반응**으로는 막을 돈이 없다(공지 자체가 충격). 돈이 되는 유일한 영역은
 * 공지 **전** 뉴스로 거부하는 것 — 7.75년에 LUNA 1건(05-07 UST 디페그 → 05-08 09:00 진입 전 거부), 상한 연 ≈1%p.
 * 그래서 이 값은 거부만 할 수 있고(매수 생성 불가), 코드가 종류·대상·기간을 검증한 것만 들어온다.
 */
import fs from 'fs';
import path from 'path';

export const AI_VETO_FILE = path.resolve(process.cwd(), 'data', 'ai-filter', 'veto.json');
export const AI_VETO_LOG = path.resolve(process.cwd(), 'data', 'ai-filter', 'veto-log.jsonl');
export const VETO_KINDS = ['depeg', 'hack', 'insolvency', 'chain_halt', 'legal', 'delist_risk'] as const;
export type VetoKind = typeof VETO_KINDS[number];
export const VETO_MAX_HOURS: Record<VetoKind, number> = { depeg: 72, hack: 72, insolvency: 168, chain_halt: 72, legal: 168, delist_risk: 168 };
export interface VetoEntry { kind: VetoKind; reason: string; since: string; until: string; source: string }
export type VetoList = Record<string, VetoEntry>;

export function readVetoList(now = Date.now()): VetoList {
  try {
    const v: VetoList = JSON.parse(fs.readFileSync(AI_VETO_FILE, 'utf8'));
    return Object.fromEntries(Object.entries(v).filter(([, e]) => Date.parse(e.until) > now));
  } catch { return {}; }
}
export function writeVetoList(v: VetoList) {
  fs.mkdirSync(path.dirname(AI_VETO_FILE), { recursive: true });
  fs.writeFileSync(AI_VETO_FILE, JSON.stringify(v, null, 2));
}
/** 쌍둥이 tick 진입 직전 확인. 파일 없음·만료 = 거부 없음 */
export function vetoOf(market: string, now = Date.now()): VetoEntry | null {
  return readVetoList(now)[market] ?? null;
}
