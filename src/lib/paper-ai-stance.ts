/**
 * AI 리스크 판단(stance) — Claude Code 세션이 주기적으로 뉴스·공지·매크로를 읽고 data/ai-filter/stance.json 에 쓴다.
 * 2026-10-02: 문헌(Lopez-Lira, Profit Mirage)·실전(Alpha Arena)·블라인드 실험 모두 "AI 에 매수 권한 금지, 악재 감지 → 축소만"
 * 이라 이 값은 **상한(cap)** 으로만 쓴다. AI 가 비중을 늘리거나 매수를 만들 수는 없다.
 *
 *   normal  — 제한 없음 (기본값, 파일 없음·만료·파싱 실패도 normal)
 *   caution — 비중 상한 50%, 신규 진입 1개까지
 *   avoid   — 비중 상한 0%, 신규 진입 금지 (보유분 청산은 하지 않는다 — 추세 계열만 비중 축소로 매도)
 * 적용 대상은 쌍둥이 전략(*_AI) 뿐. 원 전략은 대조군으로 그대로 둔다.
 */
import fs from 'fs';
import path from 'path';

export const AI_STANCE_FILE = path.resolve(process.cwd(), 'data', 'ai-filter', 'stance.json');
export const AI_STANCE_LOG = path.resolve(process.cwd(), 'data', 'ai-filter', 'stance-log.jsonl');
export type StanceLevel = 'normal' | 'caution' | 'avoid';
export interface Stance { level: StanceLevel; reasons: string[]; updatedAt: string; validUntil: string; scope?: string[] }

export function readStance(now = Date.now()): Stance {
  try {
    const s: Stance = JSON.parse(fs.readFileSync(AI_STANCE_FILE, 'utf8'));
    if (!['normal', 'caution', 'avoid'].includes(s.level) || Date.parse(s.validUntil) < now) throw new Error('expired');
    return s;
  } catch { return { level: 'normal', reasons: [], updatedAt: '', validUntil: '' }; }
}
/** 비중 상한 */
export const stanceCap = (s: Stance) => (s.level === 'avoid' ? 0 : s.level === 'caution' ? 0.5 : 1);
/** 이번 tick 신규 진입 허용 개수 상한 */
export const stanceMaxNewEntries = (s: Stance) => (s.level === 'avoid' ? 0 : s.level === 'caution' ? 1 : Infinity);
