# 축 A 보강: 진입 지연 자체의 워크포워드·플라시보, 꼬리 의존도(상위/하위 제거), 부트스트랩
import sys, json, numpy as np
from zoneinfo import ZoneInfo
from datetime import datetime, timezone
sys.path.insert(0, '/Users/goyubin/Desktop/Ravi/project/upbit-trading/scripts')
from _bt_dip_shock_lib import *
ET = ZoneInfo('America/New_York')
g = json.load(open(R + 'macro/yahoo-GSPC.json'))['chart']['result'][0]
spx = [(datetime.fromtimestamp(t, ET).date(), c) for t, c in zip(g['timestamp'], g['indicators']['quote'][0]['close']) if c is not None]
T0 = 1514764800000 + 2 * DAY; TEND = int(B['T'][-1]) - 3 * DAY
days = []
for i in range(1, len(spx)):
    d, c = spx[i]; ms = int(datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET).astimezone(timezone.utc).timestamp() * 1000)
    if T0 <= ms <= TEND: days.append((d, c / spx[i - 1][1] - 1, ms))
def k09(ms): return ((ms + 15 * 60000) // DAY + 1) * DAY
DL = {'D15': 15, 'D60': 60, 'D120': 120, 'D180': 180, 'D240': 240, 'D300': 300, 'D360': 360, 'D420': 420, 'D480': 480, 'D600': 600, 'D720': 720, 'K09': None}
C = {}
def tr(i, ek, h=24):
    k = (i, ek, h)
    if k not in C:
        ms = days[i][2]
        C[k] = sim_trade(ms, 0, hold_ms=h * 3600000, entry_at=k09(ms) if ek == 'K09' else ms + DL[ek] * 60000)
    return C[k]
ALL = range(len(days))
def sig(x, a=2018, b=2026): return [i for i in ALL if days[i][1] <= -x / 100 and a <= days[i][0].year <= b]
def mean(idx, ek): v = [tr(i, ek)['net'] for i in idx if tr(i, ek)]; return (len(v), np.mean(v) if v else np.nan)
XS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]
L = []
def log(s=''): print(s); L.append(s)
log('=== A. 진입 지연 × x 격자 (T24 사건 평균 순) ===')
log('        ' + ' '.join(f'{x:>7}' for x in XS) + '   중앙')
for ek in DL:
    r = [mean(sig(x), ek)[1] for x in XS]; log(f'  {ek:5s} ' + ' '.join(f'{P(v):>7}' for v in r) + f'  {P(np.median(r))}')
log('\n=== B. 워크포워드: (x, 진입지연) 를 IS 에서 고름 (T24, n≥15) ===')
for a, b, c, d in [(2018, 2021, 2022, 2026), (2018, 2022, 2023, 2026), (2018, 2023, 2024, 2026), (2022, 2026, 2018, 2021)]:
    best = max(((mean(sig(x, a, b), ek)[1], x, ek) for x in XS for ek in DL if mean(sig(x, a, b), ek)[0] >= 15))
    n, m = mean(sig(best[1], c, d), best[2]); nb, mb = mean([i for i in ALL if c <= days[i][0].year <= d], best[2])
    log(f'  IS {a}-{b} → x{best[1]} {best[2]} IS {P(best[0])} → OOS {c}-{d} n={n} {P(m)} (OOS 무조건 {P(mb)})')
log('\n=== C. 꼬리 의존도 (x2.0, 사건 단위) ===')
for ek in ['K09', 'D240', 'D480', 'D15']:
    v = np.sort([tr(i, ek)['net'] for i in sig(2.0) if tr(i, ek)])
    rng = np.random.default_rng(1); bs = [rng.choice(v, len(v)).mean() for _ in range(5000)]
    log(f'  {ek:5s} n={len(v)} 평균 {P(v.mean())} 중앙 {P(np.median(v))} | 최악1 제거 {P(v[1:].mean())} | 최고3 제거 {P(v[:-3].mean())} | 최고5 제거 {P(v[:-5].mean())} | 상하 5% 절사 {P(v[int(len(v)*.05):int(len(v)*.95)].mean())} | 부트스트랩 90% [{P(np.quantile(bs,.05))}, {P(np.quantile(bs,.95))}] P(>0)={np.mean(np.array(bs)>0):.2f}')
log('\n=== D. 플라시보(무작위 S&P 거래일 동일 수 2000회) — 진입지연별 x1.5/x2.0 백분위 ===')
for ek in ['K09', 'D240', 'D360', 'D480']:
    allv = np.array([tr(i, ek)['net'] for i in ALL if tr(i, ek)])
    out = []
    for x in [1.5, 2.0]:
        n, m = mean(sig(x), ek); rng = np.random.default_rng(3)
        sims = np.array([rng.choice(allv, n, replace=False).mean() for _ in range(2000)]); out.append(f'x{x} 실제 {P(m)} 백분위 {(sims < m).mean()*100:.1f}')
    log(f'  {ek:5s} 무조건 {P(allv.mean())} · ' + ' · '.join(out))
log('\n=== E. 연도별 (x2.0 K09 T24) ===')
for y in range(2018, 2027):
    n, m = mean(sig(2.0, y, y), 'K09'); n2, m2 = mean(sig(1.5, y, y), 'K09'); log(f'  {y}: x2.0 n={n:2d} {P(m) if n else "   -"} · x1.5 n={n2:2d} {P(m2) if n2 else "   -"}')
open(OUT + 'a-extra-report.txt', 'w').write('\n'.join(L))
