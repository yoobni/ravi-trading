# 축 A 교차확인: 바이낸스 BTCUSDT 4h 로 '마감 후 추가 하락 → 반등' 경로가 업비트 특유인지 (비용 없음, 서머타임 날만: 마감 20:00 UTC = 4h 봉 경계)
import sys, json, numpy as np
from zoneinfo import ZoneInfo
from datetime import datetime, timezone
sys.path.insert(0, '/Users/goyubin/Desktop/Ravi/project/upbit-trading/scripts')
from _bt_dip_shock_lib import R, OUT, P
ET = ZoneInfo('America/New_York')
b = json.load(open(R + 'binance-BTC_240m.json'))
rows = b if isinstance(b[0], list) else [[x['ts'], x['open'], x['high'], x['low'], x['close']] for x in b]
T = np.array([r[0] for r in rows], dtype=np.int64); O = np.array([float(r[1]) for r in rows])
g = json.load(open(R + 'macro/yahoo-GSPC.json'))['chart']['result'][0]
spx = [(datetime.fromtimestamp(t, ET).date(), c) for t, c in zip(g['timestamp'], g['indicators']['quote'][0]['close']) if c is not None]
def px(t):
    i = np.searchsorted(T, t)
    return O[i] if i < len(T) and T[i] == t else None
HS = [4, 8, 12, 24, 28, 32]
L = [f'바이낸스 4h {datetime.fromtimestamp(T[0]/1000, timezone.utc).date()}~{datetime.fromtimestamp(T[-1]/1000, timezone.utc).date()}, 서머타임 날만(마감=20:00 UTC 봉 시작)']
for lab, cond in [('전체', lambda r: True), ('S&P≤-1%', lambda r: r <= -0.01), ('S&P≤-1.5%', lambda r: r <= -0.015), ('S&P≤-2%', lambda r: r <= -0.02)]:
    acc = {h: [] for h in HS}; acc2 = []
    for i in range(1, len(spx)):
        d, c = spx[i]; r = c / spx[i - 1][1] - 1
        cl = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET).astimezone(timezone.utc)
        if cl.hour != 20 or not cond(r): continue
        t0 = int(cl.timestamp() * 1000); p0 = px(t0)
        if p0 is None: continue
        v = {h: px(t0 + h * 3600000) for h in HS}
        if any(x is None for x in v.values()): continue
        for h in HS: acc[h].append(v[h] / p0 - 1)
        acc2.append(v[32] / v[8] - 1)
    n = len(acc[4])
    L.append(f'  {lab:10s} n={n:4d} ' + ' '.join(f'+{h}h {P(np.mean(acc[h]))}' for h in HS) + f' | +8h→+32h(24h 보유) {P(np.mean(acc2))}')
print('\n'.join(L)); open(OUT + 'a-binance-check.txt', 'w').write('\n'.join(L))
# 같은 날·같은 시각 업비트 KRW-BTC (15m 경로 mark) 로 비교 + USDKRW 가 아니라 업비트 김프 변화인지
from _bt_dip_shock_lib import mark
L2 = ['', '같은 표본 업비트 KRW-BTC (마감 시각 가격 대비):']
for lab, cond in [('전체', lambda r: True), ('S&P≤-1%', lambda r: r <= -0.01), ('S&P≤-1.5%', lambda r: r <= -0.015), ('S&P≤-2%', lambda r: r <= -0.02)]:
    acc = {h: [] for h in HS}; bacc = {h: [] for h in HS}
    for i in range(1, len(spx)):
        d, c = spx[i]; r = c / spx[i - 1][1] - 1
        cl = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET).astimezone(timezone.utc)
        if cl.hour != 20 or not cond(r): continue
        t0 = int(cl.timestamp() * 1000)
        if t0 < T[0] or px(t0) is None or any(px(t0 + h * 3600000) is None for h in HS) or t0 + 32 * 3600000 > 1790900000000: continue
        for h in HS:
            acc[h].append(mark(t0 + h * 3600000) / mark(t0) - 1); bacc[h].append(px(t0 + h * 3600000) / px(t0) - 1)
    L2.append(f'  {lab:10s} n={len(acc[4]):4d} 업비트 ' + ' '.join(f'+{h}h {P(np.mean(acc[h]))}' for h in HS))
    L2.append(f'  {"":10s}        업-바 차(김프·환율 변화) ' + ' '.join(f'+{h}h {P(np.mean(acc[h]) - np.mean(bacc[h]))}' for h in HS))
print('\n'.join(L2)); open(OUT + 'a-binance-check.txt', 'a').write('\n' + '\n'.join(L2))
