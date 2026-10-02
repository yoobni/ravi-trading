#!/usr/bin/env tsx
/**
 * 운영 점검 — 결정론적. 전략별 마지막 tick 이 예정 간격보다 밀렸는지, cron.log 에 새 에러가 생겼는지,
 * 마이크로구조 수집이 살아 있는지를 본다. 문제 없으면 한 줄, 있으면 목록. (Claude Code 예약 작업이 매시 읽는다)
 */
import fs from 'fs';
import path from 'path';

const D = (p: string) => path.resolve(process.cwd(), 'data', p);
const M = 60e3, H = 3600e3;
// [표시명, 디렉토리, 허용 지연]
const CHECKS: [string, string, number][] = [
  ['F7_sl', 'paper-f7sl', 4 * H + 30 * M], ['F7_btc', 'paper-f7btc', 4 * H + 30 * M], ['F7_sl_AI', 'paper-f7sl-ai', 4 * H + 30 * M],
  ['BTC_TREND', 'paper-btctrend', 25 * H], ['BTC_ENS', 'paper-btcens', 25 * H], ['ETH_TREND', 'paper-ethtrend', 25 * H], ['BTC_TREND_AI', 'paper-btctrend-ai', 25 * H],
  ['ALT_SWING', 'paper-altswing', 25 * H], ['USDT_Z', 'paper-usdtz', 40 * M], ['BTC_DIP', 'paper-btcdip', 4 * H + 30 * M],
];
const CURSOR = D('ai-ops/log-cursor.json');
const now = Date.now();
const issues: string[] = [];
let cur: Record<string, number> = {};
try { cur = JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch { /* 첫 실행 */ }

for (const [id, dir, allow] of CHECKS) {
  const sf = path.join(D(dir), 'state.json');
  if (!fs.existsSync(sf)) { issues.push(`${id}: state 없음`); continue; }
  const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const age = st.lastTickTs ? now - st.lastTickTs : Infinity;
  if (age > allow) issues.push(`${id}: 마지막 tick ${(age / H).toFixed(1)}h 전 (허용 ${(allow / H).toFixed(1)}h)`);
}
// cron.log 새 에러 (지난 점검 이후 추가된 부분만)
for (const dir of ['paper-f7sl', 'paper-btctrend', 'paper-altswing', 'paper-usdtz', 'paper-btcdip', 'paper-warnings']) {
  const f = path.join(D(dir), 'cron.log');
  if (!fs.existsSync(f)) continue;
  const size = fs.statSync(f).size; const from = Math.min(cur[f] ?? 0, size);
  const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
  const errs = buf.toString('utf8').split('\n').filter((l) => /FAIL|Error|ERR!|ECONN|ETIMEDOUT|429/.test(l) && !/npm notice/.test(l));
  if (errs.length) issues.push(`${dir}/cron.log 새 에러 ${errs.length}줄: ${errs.slice(-2).map((l) => l.slice(0, 140)).join(' | ')}`);
  cur[f] = size;
}
// 마이크로구조 수집 (매분)
try {
  const files = fs.readdirSync(D('microstructure')).filter((f) => f.endsWith('.jsonl')).sort();
  const age = now - fs.statSync(path.join(D('microstructure'), files[files.length - 1])).mtimeMs;
  if (age > 10 * M) issues.push(`마이크로구조 수집: 마지막 기록 ${(age / M).toFixed(0)}분 전`);
} catch { /* 없음 */ }
fs.mkdirSync(D('ai-ops'), { recursive: true });
fs.writeFileSync(CURSOR, JSON.stringify(cur));
const kst = new Date(now + 9 * H).toISOString().slice(5, 16).replace('T', ' ');
console.log(issues.length ? `OPS 문제 ${issues.length}건 (${kst} KST)\n- ${issues.join('\n- ')}` : `OPS OK (${kst} KST, 전략 ${CHECKS.length}개 정상)`);
fs.appendFileSync(D('ai-ops/log.jsonl'), JSON.stringify({ ts: now, issues }) + '\n');
