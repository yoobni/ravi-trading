#!/bin/bash
# 시뮬레이션 상태 확인 스크립트
# 사용법: bash scripts/check-sim.sh

cd "$(dirname "$0")/.."

echo "═══════════════════════════════════════════"
echo "  시뮬레이션 상태 확인"
echo "═══════════════════════════════════════════"

# 프로세스 확인
PID=$(cat data/simulation/sim.pid 2>/dev/null)
if [ -n "$PID" ] && ps -p $PID > /dev/null 2>&1; then
  ELAPSED=$(ps -p $PID -o etime= 2>/dev/null | xargs)
  MEM=$(ps -p $PID -o rss= 2>/dev/null | xargs)
  echo "▸ 프로세스: 실행 중 (PID $PID, 경과 $ELAPSED, 메모리 ${MEM}KB)"
else
  echo "▸ 프로세스: 중지됨"
fi

echo ""

# 잔고 상태
if [ -f data/account-balance.json ]; then
  echo "▸ 잔고:"
  cat data/account-balance.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  현금: {d[\"cash\"]:,.0f}원')
print(f'  총 평가: {d[\"totalEquity\"]:,.0f}원')
print(f'  실현 손익: {d[\"totalRealizedPnl\"]:,.0f}원')
print(f'  수수료: {d[\"totalFeesPaid\"]:,.0f}원')
print(f'  보유: {len(d[\"holdings\"])}건')
for h in d['holdings']:
    print(f'    - {h[\"market\"]}: {h[\"volume\"]:.4f} @ {h[\"avgPrice\"]:,.0f}원')
"
fi

echo ""

# 최근 로그
echo "▸ 최근 로그 (마지막 10줄):"
tail -10 data/simulation/stdout.log 2>/dev/null | grep "^\[" || echo "  (로그 없음)"

echo ""

# 사이클 카운트
if [ -d data/cycle-logs ]; then
  CYCLE_COUNT=$(ls data/cycle-logs/*.json 2>/dev/null | wc -l | xargs)
  echo "▸ 완료 사이클: ${CYCLE_COUNT}회"
fi

# AI 판단 수
if [ -d data/ai-judgments ]; then
  JUDGMENT_COUNT=$(ls data/ai-judgments/*.json 2>/dev/null | wc -l | xargs)
  echo "▸ AI 판단 로그: ${JUDGMENT_COUNT}건"
fi

# 주문 수
if [ -f data/orders.json ]; then
  ORDER_COUNT=$(python3 -c "import json; print(len(json.load(open('data/orders.json'))))" 2>/dev/null)
  echo "▸ 총 주문: ${ORDER_COUNT}건"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  종료: kill $PID"
echo "  리포트: data/simulation/simulation-report.json"
echo "═══════════════════════════════════════════"
