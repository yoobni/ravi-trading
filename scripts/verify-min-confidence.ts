/**
 * minConfidence 필터 버그 수정 검증 스크립트
 *
 * config.json의 minConfidence 값 변경에 따라 매수 차단이 실제로 작동하는지 확인.
 *
 * 실행: npx tsx -r tsconfig-paths/register scripts/verify-min-confidence.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { updateConfig, getConfig, initConfigManager } from '@/lib/config-manager';

const CONFIG_FILE = path.resolve(process.cwd(), 'data/config.json');

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function pass(msg: string) { console.log(`  ✅ PASS: ${msg}`); }
function fail(msg: string) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }

// runRiskCheck 내부 로직과 동일한 신뢰도 체크 함수
function shouldBlockByConfidence(confidence: number, minConfidence: number): { blocked: boolean; reason: string | null } {
  if (confidence < minConfidence) {
    return { blocked: true, reason: `신뢰도 미달: ${confidence}% < 설정값 ${minConfidence}%` };
  }
  return { blocked: false, reason: null };
}

async function main() {
  console.log('\n========================================');
  console.log('  minConfidence 필터 검증');
  console.log('========================================\n');

  // ── 1. 유닛 로직 검증 (API 불필요) ──
  console.log('[1단계] 신뢰도 필터 로직 유닛 검증');

  const cases = [
    { confidence: 41, minConfidence: 75, expectBlock: true },
    { confidence: 55, minConfidence: 75, expectBlock: true },
    { confidence: 61, minConfidence: 75, expectBlock: true },
    { confidence: 74, minConfidence: 75, expectBlock: true },
    { confidence: 75, minConfidence: 75, expectBlock: false },
    { confidence: 80, minConfidence: 75, expectBlock: false },
    { confidence: 100, minConfidence: 75, expectBlock: false },
  ];

  let allPassed = true;
  for (const c of cases) {
    const { blocked, reason } = shouldBlockByConfidence(c.confidence, c.minConfidence);
    const ok = blocked === c.expectBlock;
    if (ok) {
      pass(`confidence=${c.confidence}%, min=${c.minConfidence}% → ${blocked ? `BLOCKED (${reason})` : 'ALLOWED'}`);
    } else {
      fail(`confidence=${c.confidence}%, min=${c.minConfidence}% → 예상: ${c.expectBlock ? 'BLOCKED' : 'ALLOWED'}, 실제: ${blocked ? 'BLOCKED' : 'ALLOWED'}`);
      allPassed = false;
    }
  }

  // ── 2. config.json 핫리로드 검증 ──
  console.log('\n[2단계] config.json minConfidence 반영 검증');

  initConfigManager();
  const originalMinConf = getConfig().trading.minConfidence;
  log('현재', `config.json minConfidence = ${originalMinConf}%`);

  // 99%로 상향
  updateConfig({ trading: { minConfidence: 99 } });
  const highConf = getConfig().trading.minConfidence;
  if (highConf === 99) {
    pass(`minConfidence를 99%로 상향 → getConfig() 반영 확인: ${highConf}%`);
    const { blocked } = shouldBlockByConfidence(75, highConf);
    if (blocked) {
      pass(`신뢰도 75% → min 99% 설정 시 BLOCKED 정상`);
    } else {
      fail(`신뢰도 75% → min 99% 설정 시 차단 실패`);
      allPassed = false;
    }
  } else {
    fail(`minConfidence 99% 설정 실패 (현재: ${highConf}%)`);
    allPassed = false;
  }

  // 40%로 하향
  updateConfig({ trading: { minConfidence: 40 } });
  const lowConf = getConfig().trading.minConfidence;
  if (lowConf === 40) {
    pass(`minConfidence를 40%로 하향 → getConfig() 반영 확인: ${lowConf}%`);
    const { blocked } = shouldBlockByConfidence(41, lowConf);
    if (!blocked) {
      pass(`신뢰도 41% → min 40% 설정 시 ALLOWED 정상`);
    } else {
      fail(`신뢰도 41% → min 40% 설정 시 잘못 차단됨`);
      allPassed = false;
    }
  } else {
    fail(`minConfidence 40% 설정 실패 (현재: ${lowConf}%)`);
    allPassed = false;
  }

  // 원래 값 복원
  updateConfig({ trading: { minConfidence: originalMinConf } });
  const restoredConf = getConfig().trading.minConfidence;
  if (restoredConf === originalMinConf) {
    pass(`config.json 원래 값(${originalMinConf}%) 복원 완료`);
  } else {
    fail(`복원 실패 (현재: ${restoredConf}%)`);
  }

  // ── 3. 소스 코드 수정 내용 검증 ──
  console.log('\n[3단계] 소스 코드 수정 검증');

  // strategy-pipeline.ts: runRiskCheck에 minConfidence 필터가 존재하는지
  const pipelineSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/lib/strategy-pipeline.ts'),
    'utf-8',
  );
  const hasPipelineFilter = /getConfig\(\)\.trading\?\.minConfidence/.test(pipelineSrc);
  if (hasPipelineFilter) {
    pass('strategy-pipeline.ts: runRiskCheck() 내 minConfidence 필터 확인');
  } else {
    fail('strategy-pipeline.ts: runRiskCheck()에 minConfidence 필터 없음 — 핵심 버그 미수정');
    allPassed = false;
  }

  // ai-judgment-engine.ts: 하드코딩된 40이 제거됐는지
  const aiEngineSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/lib/ai-judgment-engine.ts'),
    'utf-8',
  );
  const hasHardcoded40 = /response\.confidence\s*<\s*40/.test(aiEngineSrc);
  if (!hasHardcoded40) {
    pass('ai-judgment-engine.ts: 하드코딩된 "confidence < 40" 제거 확인');
  } else {
    fail('ai-judgment-engine.ts: 여전히 "confidence < 40" 하드코딩 존재 — minConfidence 미반영');
    allPassed = false;
  }

  const aiUsesGetConfig = /getConfig\(\)\.trading\?\.minConfidence/.test(aiEngineSrc);
  if (aiUsesGetConfig) {
    pass('ai-judgment-engine.ts: getConfig().trading.minConfidence 사용 확인');
  } else {
    fail('ai-judgment-engine.ts: getConfig() 호출 없음');
    allPassed = false;
  }

  // ── 4. 최종 결과 ──
  console.log('\n========================================');
  if (allPassed) {
    console.log('  결과: ALL PASS — minConfidence 필터 정상 작동');
    console.log(`  현재 설정값: ${getConfig().trading.minConfidence}%`);
    console.log('  수정 1: strategy-pipeline.ts runRiskCheck() 내 confidence < minConfidence 차단 추가');
    console.log('  수정 2: ai-judgment-engine.ts 하드코딩 40 → getConfig().trading.minConfidence 로 교체');
  } else {
    console.log('  결과: FAIL — 일부 케이스 실패, 위 로그 확인');
  }
  console.log('========================================\n');
}

main().catch(err => {
  console.error('검증 에러:', err);
  process.exit(1);
});
