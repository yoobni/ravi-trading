/**
 * 단순 구조 전략 레지스트리 — state.json(cash·positions) + trades.jsonl + ticks.jsonl 형태를 공유하는 전략들.
 * 대시보드(/api/paper-trading), 기록(/api/paper-trading/history), 주간 리포트가 이 목록을 그대로 순회한다.
 * F6·F6_v6·F7 계열·F1F2 는 각자의 블록을 따로 가진다(역사적 이유).
 */
import path from 'path';
import { TREND_VARIANTS, trendFiles, TREND_INITIAL_CASH_KRW, TREND_FEE } from './paper-trend-store';
import { AS_STATE_FILE, AS_TRADES_FILE, AS_TICKS_FILE, AS_INITIAL_CASH_KRW, AS_FEE } from './paper-altswing-store';
import { UZ_STATE_FILE, UZ_TRADES_FILE, UZ_TICKS_FILE, UZ_INITIAL_CASH_KRW, UZ_FEE } from './paper-usdtz-store';
import { BD_STATE_FILE, BD_TRADES_FILE, BD_TICKS_FILE, BD_INITIAL_CASH_KRW, BD_FEE } from './paper-btcdip-store';

export interface SimpleStrategy {
  id: string; name: string; rule: string;
  state: string; trades: string; ticks: string;
  initial: number; fee: number; stepMs: number;
}
const H = 3600_000, DAY = 24 * H;
const TREND_RULE: Record<string, string> = {
  BTC_TREND: '매일 KST 09:02 · BTC 일봉 종가 > SMA50 이면 100% 보유, 아래면 현금 · 상태 바뀔 때만 시장가',
  BTC_ENS: '매일 KST 09:02 · BTC 종가가 SMA 10/20/50/100/200 중 k개 위 → 보유 비중 k/5 · 차액만 시장가',
  ETH_TREND: '매일 KST 09:02 · ETH 일봉 종가 > SMA50 이면 100% 보유, 아래면 현금',
  BTC_TREND_AI: 'BTC_TREND 와 같고 AI 리스크 판단이 비중 상한을 건다(caution 50% · avoid 0%) · AI 는 줄이기만 가능',
};
export const SIMPLE_STRATEGIES: SimpleStrategy[] = [
  ...TREND_VARIANTS.map((v) => {
    const f = trendFiles(v);
    return { id: v.id, name: v.name, rule: TREND_RULE[v.id], state: f.state, trades: f.trades, ticks: f.ticks, initial: TREND_INITIAL_CASH_KRW, fee: TREND_FEE, stepMs: DAY };
  }),
  { id: 'ALT_SWING', name: 'ALT_SWING (알트 일봉 스윙)', rule: '매일 KST 09:03 · 거래대금 상위 20 알트 · 7일 신고가+양봉+거래대금z≥0.5 · BTC>SMA50 일 때만 · TP +6% 지정가 · 3일 · 무스톱 · 33%×3',
    state: AS_STATE_FILE, trades: AS_TRADES_FILE, ticks: AS_TICKS_FILE, initial: AS_INITIAL_CASH_KRW, fee: AS_FEE, stepMs: DAY },
  { id: 'USDT_Z', name: 'USDT_Z (테더 프리미엄)', rule: '15분마다 · 업비트 USDT ÷ 장중 환율 프리미엄의 30일 z ≤ −2 매수 / ≥ 0 매도 · 디페그 가드(USDCUSDT>1.005)',
    state: UZ_STATE_FILE, trades: UZ_TRADES_FILE, ticks: UZ_TICKS_FILE, initial: UZ_INITIAL_CASH_KRW, fee: UZ_FEE, stepMs: 15 * 60_000 },
  { id: 'BTC_DIP', name: 'BTC_DIP (BTC 4h 급락 흡수)', rule: '4h 마다 직전가 −3% 매수 지정가 → +3% 매도 지정가 · 72시간 시간청산 · 무스톱 · 100%',
    state: BD_STATE_FILE, trades: BD_TRADES_FILE, ticks: BD_TICKS_FILE, initial: BD_INITIAL_CASH_KRW, fee: BD_FEE, stepMs: 4 * H },
];
export const SIMPLE_DIRS = SIMPLE_STRATEGIES.map((s) => path.basename(path.dirname(s.state)));

/**
 * 조합 전략 — 2026-10-02 밤 10개 선정의 9·10번. 비중은 출발 시점 고정(리밸런싱 없음 = 슬리브별 보유).
 *   COMBO_EQ4  : 통합 재검증에서 혼합 샤프 2.06 / MDD 8% (_bt_final_compare.ts)
 *   COMBO_CORE : 배분 리서치 권고형 코어 70 + 위성 30 (_bt_alloc.ts) — F7 무스톱 은퇴로 ALT_SWING 이 위성 한 자리를 대신
 */
export const COMBOS: { id: string; name: string; weights: [string, number][] }[] = [
  { id: 'COMBO_EQ4', name: 'COMBO_EQ4 (균등 4종)', weights: [['BTC_TREND', 0.25], ['ALT_SWING', 0.25], ['USDT_Z', 0.25], ['BTC_DIP', 0.25]] },
  { id: 'COMBO_CORE', name: 'COMBO_CORE (코어 70 + 위성 30)', weights: [['BTC_TREND', 0.7], ['F7_sl', 0.1], ['F7_btc', 0.1], ['ALT_SWING', 0.1]] },
];
/** 대시보드·기록에서 숨기는 은퇴 전략 (데이터는 보존) */
export const RETIRED = new Set(['F1F2_50', 'F1F2_100', 'F6', 'F6_v6', 'F7', 'F7_p']);
