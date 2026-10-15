#!/usr/bin/env tsx
/**
 * AI_TRADER 1회 실행 — crontab 15분마다 (`cd 프로젝트 && npx tsx scripts/ai-trader/run.ts`).
 * claude -p(비대화형, Opus)가 upbit-paper MCP 로 판단·주문하고, 끝나면 record-tick 으로 기록한다.
 * 셸 스크립트가 아니라 node 인 이유: macOS 가 크론의 /bin/bash 에 Desktop 폴더 실행을 막는다(Operation not permitted).
 * 앞 실행이 아직 돌고 있으면 건너뛰고, 12분 넘으면 강제 종료한다.
 */
import 'dotenv/config';   // .env 의 CLAUDE_CODE_OAUTH_TOKEN — 크론은 키체인 로그인에 접근 못 한다(claude setup-token 으로 발급)
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const D = path.resolve('data', 'paper-aitrader');
fs.mkdirSync(path.join(D, 'runs'), { recursive: true });
const LOCK = path.join(D, 'run.pid');
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
try { const pid = +fs.readFileSync(LOCK, 'utf8'); process.kill(pid, 0); console.log(`${kst()} 이전 실행(${pid}) 진행 중 — skip`); process.exit(0); } catch { /* 잠금 없음 또는 죽은 프로세스 */ }
fs.writeFileSync(LOCK, String(process.pid));
const cleanup = () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* */ } };
process.on('exit', cleanup);

// ── 실행 여부: AI 가 schedule_next 로 정한 시각(없으면 마지막 실행 +15분) 이전이면 건너뛴다. 단 BTC 가 ±2% 넘게 움직였거나 4시간 넘게 안 돌았으면 깨운다.
const NEXT_FILE = path.join(D, 'next-run.json');
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const lastTick = (() => { try { const l = fs.readFileSync(path.join(D, 'ticks.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); } catch { return null; } })();
const next = readJson(NEXT_FILE);
const force = process.argv.includes('--now');
if (!force && lastTick) {
  // 예약이 유효한 조건: 직전 실행 **중**에 설정된 것(실행 시작 ≈ 기록 시각 − 소요 시간). 그 전 실행의 예약은 버린다.
  const runStart = lastTick.ts - (lastTick.durationMs || 0) - 60_000;
  const valid = !!(next?.nextTs && next.setTs >= runStart);
  const due = valid ? next.nextTs : lastTick.ts + 15 * 60_000;
  const now = Date.now();
  let wake = now >= due - 30_000 || now - lastTick.ts > 4 * 3600_000;
  let why = wake ? (valid ? `예정(${next.minutes}분: ${next.reason})` : '기본 15분') : '';
  if (!wake && lastTick.btcPrice) {
    try {
      const r = JSON.parse(spawnSync('curl', ['-s', 'https://api.upbit.com/v1/ticker?markets=KRW-BTC'], { encoding: 'utf8', timeout: 10_000 }).stdout);
      const chg = r[0].trade_price / lastTick.btcPrice - 1;
      if (Math.abs(chg) >= 0.02) { wake = true; why = `BTC ${(chg * 100).toFixed(2)}% 급변 → 예정보다 일찍`; }
    } catch { /* 시세 실패 시 예정대로 */ }
  }
  if (!wake) { cleanup(); process.exit(0); }   // 조용히 건너뜀(크론 로그 오염 방지)
  console.log(`${kst()} 깨움: ${why}`);
}

const env = { ...process.env, PATH: `/opt/homebrew/bin:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` };
const stamp = kst().replace(/[- :]/g, '').slice(0, 12);
const out = path.join(D, 'runs', `${stamp}.json`), err = path.join(D, 'runs', `${stamp}.err`);
const prompt = `${fs.readFileSync('scripts/ai-trader/task.md', 'utf8')}\n\n현재 시각: ${kst()} KST`;
const r = spawnSync('claude', [
  '-p', prompt, '--model', 'opus',
  '--mcp-config', 'scripts/ai-trader/mcp.json', '--strict-mcp-config',
  '--allowedTools', 'mcp__upbit-paper', 'WebSearch', 'WebFetch',
  '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task',
  '--output-format', 'json',
], { env, encoding: 'utf8', timeout: 12 * 60_000, maxBuffer: 64 * 1024 * 1024 });
fs.writeFileSync(out, r.stdout || ''); fs.writeFileSync(err, (r.stderr || '') + (r.error ? `\n${r.error}` : ''));
const code = r.status ?? (r.signal ? 124 : 1);
spawnSync(path.resolve('node_modules/.bin/tsx'), ['scripts/ai-trader/record-tick.ts', out, String(code)], { env, stdio: 'inherit' });
let res: any = {}; try { res = JSON.parse(r.stdout); } catch { /* 실패 */ }
console.log(`${kst()} exit=${code} ${(res.total_cost_usd ?? 0).toFixed(3)}USD ${res.num_turns ?? '?'}턴 ${String(res.result ?? r.error ?? '결과 없음').replace(/\n/g, ' ').slice(0, 200)}`);
