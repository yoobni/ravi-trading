/**
 * 갭 가드 — 크론이 며칠 밀린 뒤 라이브 tick 이 먼저 돌면 state.lastTickTs 가 현재로 점프해서
 * 그 뒤엔 backfill 로 갭을 못 채운다(되감기가 필요해진다). 그래서 tick 본체가 **쓰기 전에**
 * 먼저 갭을 감지해 backfill 을 돌린다. 이 시점엔 포인터가 아직 뒤에 있으므로 되감기 없이 채워진다.
 *
 * 맥이 배터리에서 잠드는 문제가 반복돼(2026-09 한 달간 4회) 사람이 개입해야만 복구되던 걸 자동화한 것.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

/**
 * @param label        로그용 전략 이름
 * @param stateFile    해당 전략 state.json 경로
 * @param intervalMs   정상 tick 간격 (4h 또는 12h)
 * @param backfillRel  갭이 있을 때 돌릴 backfill 스크립트 (scripts/ 기준 상대경로)
 */
export function ensureNoGap(label: string, stateFile: string, intervalMs: number, backfillRel: string): void {
  let lastTickTs: number | undefined;
  try {
    lastTickTs = JSON.parse(fs.readFileSync(stateFile, 'utf8'))?.lastTickTs;
  } catch { return; }                       // state 없음 = 최초 실행, 가드할 것 없음
  if (!lastTickTs) return;

  const behind = Date.now() - lastTickTs;
  // 1.5배까지는 정상 지터(크론 지연·실행시간)로 본다. 그 이상이면 슬롯을 건너뛴 것.
  if (behind <= intervalMs * 1.5) return;

  const missed = Math.floor(behind / intervalMs);
  console.log(`[gap-guard] ${label}: 마지막 tick 이후 ${(behind / 3600_000).toFixed(1)}h (약 ${missed}슬롯 결손) → backfill 먼저 실행`);
  try {
    const out = execFileSync('npx', ['tsx', path.join('scripts', backfillRel)], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15 * 60_000,
    });
    const tail = out.trim().split('\n').filter(l => /완료|ticks to backfill|no backfill/.test(l));
    console.log(`[gap-guard] ${label}: ${tail.join(' | ') || 'backfill 종료'}`);
  } catch (e: any) {
    // 백필이 실패해도 tick 자체는 계속 진행한다 — 갭은 남지만 라이브는 멈추지 않는다.
    console.log(`[gap-guard] ${label}: backfill 실패 — ${e?.message || e}`);
  }
}
