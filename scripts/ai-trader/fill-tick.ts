#!/usr/bin/env tsx
/** AI_TRADER 지정가 체결 크론 — 5분마다. AI 가 안 깨어 있어도(실행 실패·지연) 걸어둔 지정가가 제때 체결·만료되게 한다. */
import 'dotenv/config';
import fs from 'fs';
import { processFills, AT_STATE_FILE } from '@/lib/paper-aitrader-store';
(async () => {
  if (!fs.existsSync(AT_STATE_FILE)) process.exit(0);
  const out = await processFills();
  if (out.length) console.log(`[${new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16)}] ${out.join(' | ')}`);
  process.exit(0);
})().catch((e) => { console.error('[AI_TRADER fill FAIL]', e); process.exit(1); });
