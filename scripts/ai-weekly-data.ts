#!/usr/bin/env tsx
/**
 * 주간 리포트 입력 — 대시보드 API 와 같은 계산으로 전략별 현재 성과를 뽑고, 백테스트 기대치와 나란히 놓는다.
 * 기대치 출처: docs/RESEARCH-LOG.md (2026-10-02 통합 재검증 · _bt_synth.ts 현실 시뮬). 서술·판정은 Claude Code 세션이 한다.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { GET } from '@/app/api/paper-trading/route';

// 연간 거래 수, 거래당 평균 수익(%) — 백테스트 기대 (현실 비용 기준)
const EXPECT: Record<string, { tradesYr: number; perTrade: number | null; note: string }> = {
  USDT_Z: { tradesYr: 12, perTrade: 1.4, note: '2.26년 +48.6%, 28건' },
  BTC_DIP: { tradesYr: 26, perTrade: null, note: 'TP 평균 +2.9%, 시간청산 평균 −3.7%' },
  ALT_SWING: { tradesYr: 189, perTrade: 1.2, note: '시점별 유니버스, 진입가 민감' },
  F7_sl: { tradesYr: 265, perTrade: 0.66, note: '15m 현실 시뮬, 28코인 편향' },
  F7_sl_AI: { tradesYr: 265, perTrade: 0.66, note: 'F7_sl 과 차이 = AI 기여' },
  F7_btc: { tradesYr: 200, perTrade: 1.09, note: 'F7+BTC50 현실 시뮬' },
  BTC_TREND: { tradesYr: 9, perTrade: null, note: '연 9회 전환' },
  BTC_TREND_AI: { tradesYr: 9, perTrade: null, note: 'BTC_TREND 와 차이 = AI 기여' },
  BTC_ENS: { tradesYr: 95, perTrade: null, note: '비중 변경 횟수' },
  ETH_TREND: { tradesYr: 9, perTrade: null, note: '사후선택 통제군' },
};
(async () => {
  const j = await (await GET()).json();
  const now = Date.now();
  console.log('| 전략 | 경과일 | 평가액 | 수익률 | 거래 | 승률 | 거래당 | PF | 기대 거래(경과기간) | 기대 거래당 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of j.strategies) {
    let started = now;
    const dir = s.id.startsWith('COMBO') ? null : null;
    try {
      const reg = (await import('@/lib/paper-registry')).SIMPLE_STRATEGIES.find((x) => x.id === s.id);
      const f7 = (await import('@/lib/paper-f7-store')).F7_VARIANTS.find((x) => x.id === s.id);
      const sf = reg?.state ?? (f7 ? path.join(f7.dir, 'state.json') : null);
      if (sf && fs.existsSync(sf)) started = Date.parse(JSON.parse(fs.readFileSync(sf, 'utf8')).startedAt);
    } catch { /* 조합 */ }
    void dir;
    const days = (now - started) / 86400e3;
    const e = EXPECT[s.id];
    const m = s.metrics;
    const per = m.trades ? (m.realizedPnl / m.trades / (s.capitalAlloc * 0.33)) * 100 : null;
    console.log(`| ${s.id}${s.benchmark ? ' (조합)' : ''} | ${days.toFixed(1)} | ${Math.round(s.totalEquity).toLocaleString()} | ${s.returnRate.toFixed(2)}% | ${m.trades} | ${m.trades ? m.wr.toFixed(0) + '%' : '-'} | ${per != null ? per.toFixed(2) + '%' : '-'} | ${m.trades ? m.pf.toFixed(2) : '-'} | ${e ? (e.tradesYr * days / 365).toFixed(1) : '-'} | ${e?.perTrade != null ? e.perTrade + '%' : '-'} |`);
  }
  console.log(`\n(거래당 = 실현손익 ÷ 거래수 ÷ 슬롯 크기(자본 33%) 근사. 추세·USDT_Z·BTC_DIP 은 자본 100% 단일 포지션이라 참고만.)`);
  process.exit(0);
})();
