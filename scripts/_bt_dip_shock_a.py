# 축 A: S&P500 급락일 → 미국 장 마감 후 첫 실행 가능 시점 BTC 매수, 짧게 보유 (무스톱)
import sys, json, random, numpy as np
from zoneinfo import ZoneInfo
from datetime import datetime, timezone
sys.path.insert(0, '/Users/goyubin/Desktop/Ravi/project/upbit-trading/scripts')
from _bt_dip_shock_lib import *

ET = ZoneInfo('America/New_York')
def yahoo(sym):
    g = json.load(open(R + f'macro/yahoo-{sym}.json'))['chart']['result'][0]
    out = []
    for ts, c in zip(g['timestamp'], g['indicators']['quote'][0]['close']):
        if c is None: continue
        d = datetime.fromtimestamp(ts, ET).date()
        out.append((d, c))
    return out
spx = yahoo('GSPC'); vix = dict(yahoo('VIX')); ixic = dict(yahoo('IXIC'))
vixl = yahoo('VIX'); vixchg = {vixl[i][0]: vixl[i][1] / vixl[i - 1][1] - 1 for i in range(1, len(vixl))}
ixl = yahoo('IXIC'); ixret = {ixl[i][0]: ixl[i][1] / ixl[i - 1][1] - 1 for i in range(1, len(ixl))}
md = json.load(open(R + 'macro/macro-dates.json'))
MACRO = {k: set(v) for k, v in md.items()}

T0 = 1514764800000 + 2 * DAY  # 2018-01-03 (60m 시작 후)
TEND = int(B['T'][-1]) - 3 * DAY
days = []  # (date, ret, close_utc_ms)
for i in range(1, len(spx)):
    d, c = spx[i]
    cl = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET).astimezone(timezone.utc)
    ms = int(cl.timestamp() * 1000)
    if ms < T0 or ms > TEND: continue
    days.append((d, c / spx[i - 1][1] - 1, ms))
print(f'S&P 거래일 {len(days)} ({days[0][0]} ~ {days[-1][0]}), 경로: 2018~2020 60m · 2021~ 15m, SLIP {SLIP*1e4:.1f}bp FEE {FEE*1e4:.0f}bp')

def btc24(ms): return mark(ms) / mark(ms - DAY) - 1
def next0900(ms):  # 마감 +15분 이후 첫 00:00 UTC (= KST 09:00 일봉 시가)
    return ((ms + 15 * 60000) // DAY + 1) * DAY

EK = sys.argv[1] if len(sys.argv) > 1 else 'D15'
ENTRY = {'D15': 15, 'D30': 30, 'D60': 60, 'D120': 120, 'D180': 180, 'D240': 240, 'D360': 360, 'D480': 480, 'D720': 720, 'K09': None}
EXITS = {'T24': (None, 24), 'T48': (None, 48)}
for tp in [1, 1.5, 2, 3]:
    for h in [24, 48]: EXITS[f'TP{tp}/T{h}'] = (tp / 100, h)
XS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]

# 모든 S&P 거래일에 대해 거래를 미리 계산 (플라시보·조건 탐색용) — 슬리브 겹침 무시한 사건 단위
cache = {}
def trade_for(idx, ek, xk, cm=1.0):
    key = (idx, ek, xk, cm)
    if key in cache: return cache[key]
    d, r, ms = days[idx]; tp, h = EXITS[xk]
    if ek == 'K09': tr = sim_trade(ms, 0, tp=tp, hold_ms=h * 3600000, entry_at=next0900(ms), cost_mult=cm)
    else: tr = sim_trade(ms, ENTRY[ek] * 60000, tp=tp, hold_ms=h * 3600000, cost_mult=cm)
    cache[key] = tr; return tr

def ev(idxs, ek='D15', xk='T24', cm=1.0):
    v = [trade_for(i, ek, xk, cm) for i in idxs]; v = np.array([t['net'] for t in v if t])
    if len(v) < 2: return (len(v), v.mean() if len(v) else float('nan'), 0.0)
    return (len(v), v.mean(), v.mean() / v.std(ddof=1) * np.sqrt(len(v)))

ALL = list(range(len(days)))
def sig(x, cond=None): return [i for i in ALL if days[i][1] <= -x / 100 and (cond is None or cond(i))]
L = []
def log(s=''): print(s); L.append(s)

log('\n=== 0. 기준(무조건부: 모든 S&P 거래일 마감 후 진입) 사건 평균(순) ===')
for ek in ['D15', 'K09']:
    for xk in ['T24', 'T48', 'TP2/T24']:
        n, m, t = ev(ALL, ek, xk); log(f'  {ek} {xk:9s} n={n} 평균 {P(m,3)} t {t:.2f}')

log('\n=== 1. 격자: 사건 평균 순수익 (D15 진입, 슬리브 무시) — n / 평균 / t ===')
grid = {}
for xk in EXITS:
    row = []
    for x in XS:
        n, m, t = ev(sig(x), EK, xk); grid[(x, xk)] = (n, m, t); row.append(f'{n:3d} {P(m):>7} {t:4.1f}')
    log(f'  {xk:9s} | ' + ' | '.join(row))
log('  x열: ' + ' '.join(str(x) for x in XS))

log('\n=== 2. 진입 시점별 (T24, 사건 평균) ===')
for ek in ENTRY:
    log(f'  {ek:5s} ' + ' '.join(f'x{x}:{ev(sig(x), ek, "T24")[0]}/{P(ev(sig(x), ek, "T24")[1])}' for x in [1.0, 1.5, 2.0, 2.5, 3.0]))
log('  (TP2/T24) ' )
for ek in ENTRY:
    log(f'  {ek:5s} ' + ' '.join(f'x{x}:{P(ev(sig(x), ek, "TP2/T24")[1])}' for x in [1.0, 1.5, 2.0, 2.5, 3.0]))

log('\n=== 2b. 마감 후 경로: 마감+15분 가격 대비 h시간 뒤 BTC 평균 수익(비용 없음) — 신호일 vs 전체 ===')
HS = [1, 2, 3, 4, 6, 8, 12, 24, 36, 48]
def path(idxs):
    out = []
    for h in HS:
        v = [mark(days[i][2] + 15 * 60000 + h * 3600000) / mark(days[i][2] + 15 * 60000) - 1 for i in idxs]
        out.append(np.mean(v))
    return out
log('  h    : ' + ' '.join(f'{h:>7}' for h in HS))
log('  전체 : ' + ' '.join(f'{P(v):>7}' for v in path(ALL)))
for x in [1.0, 1.5, 2.0, 2.5]:
    log(f'  x{x}  : ' + ' '.join(f'{P(v):>7}' for v in path(sig(x))))
for nm, a, b in [('2018-21', 2018, 2021), ('2022-26', 2022, 2026)]:
    log(f'  x1.5 {nm}: ' + ' '.join(f'{P(v):>7}' for v in path([i for i in sig(1.5) if a <= days[i][0].year <= b])))
    log(f'  전체 {nm}: ' + ' '.join(f'{P(v):>7}' for v in path([i for i in ALL if a <= days[i][0].year <= b])))
# 마감 직전 24h BTC (이미 반영됐나)
log('  마감 전 24h BTC 평균: 전체 ' + P(np.mean([btc24(days[i][2]) for i in ALL])) + ' / ' + ' '.join(f'x{x} {P(np.mean([btc24(days[i][2]) for i in sig(x)]))}' for x in [1.0, 1.5, 2.0, 2.5]))

PER = [('2018-19', 2018, 2019), ('2020-21', 2020, 2021), ('2022-23', 2022, 2023), ('2024-26', 2024, 2026)]
def per_idx(idxs, a, b): return [i for i in idxs if a <= days[i][0].year <= b]
log('\n=== 3. 기간 분할 (D15, 사건 평균 n/평균/t) — 기준(무조건부) 대비 ===')
for xk in ['T24', 'T48', 'TP1/T24', 'TP2/T24', 'TP2/T48']:
    for x in [1.0, 1.5, 2.0, 2.5]:
        s = sig(x)
        log(f'  {xk:8s} x{x}: ' + ' | '.join(f'{nm} {ev(per_idx(s,a,b),EK,xk)[0]:2d} {P(ev(per_idx(s,a,b),EK,xk)[1]):>7} (기준 {P(ev(per_idx(ALL,a,b),EK,xk)[1],2)})' for nm, a, b in PER))

log('\n=== 4. 비용 ×2 (D15) ===')
for xk in ['T24', 'TP2/T24', 'TP2/T48']:
    log(f'  {xk:8s} ' + ' '.join(f'x{x}:{P(ev(sig(x),EK,xk,2.0)[1])}' for x in XS))

log('\n=== 5. 플라시보: 모든 S&P 거래일 중 무작위 같은 수 1000회 (D15) — 실제 평균의 백분위 ===')
random.seed(7)
plac = {}
for xk in ['T24', 'TP2/T24', 'TP2/T48', 'T48']:
    allv = np.array([trade_for(i, EK, xk)['net'] for i in ALL if trade_for(i, EK, xk)])
    for x in [1.0, 1.5, 2.0, 2.5, 3.0]:
        n, m, _ = ev(sig(x), EK, xk)
        sims = np.array([np.random.default_rng(k).choice(allv, n, replace=False).mean() for k in range(1000)])
        pct = (sims < m).mean(); plac[(x, xk)] = pct
        log(f'  {xk:8s} x{x}: n={n} 실제 {P(m)} 플라시보 중앙 {P(np.median(sims))} 95% {P(np.quantile(sims,.95))} → 백분위 {pct*100:.1f}')
# 변동성 맞춘 플라시보: S&P |수익| 이 큰 날(상승 급등 포함) — 하락 방향이 중요한지
log('  [대조] S&P 급등일(≥+x%) 같은 진입:')
for x in [1.0, 1.5, 2.0, 2.5]:
    up = [i for i in ALL if days[i][1] >= x / 100]; n, m, t = ev(up, EK, 'T24'); log(f'    x{x}: n={n} T24 {P(m)} t {t:.2f}')

log('\n=== 6. 추가 조건 (하나씩, D15·T24 및 TP2/T24, x 격자 1.0~3.0 각 칸 평균의 중앙값) ===')
CONDS = {
    'BTC24h≤-2%': lambda i: btc24(days[i][2]) <= -0.02,
    'BTC24h>-0.5%(덜 빠짐)': lambda i: btc24(days[i][2]) > -0.005,
    'BTC24h≤-4%': lambda i: btc24(days[i][2]) <= -0.04,
    'VIX일변화≥+15%': lambda i: vixchg.get(days[i][0], 0) >= 0.15,
    'VIX<+15%': lambda i: vixchg.get(days[i][0], 0) < 0.15,
    'VIX≥25': lambda i: vix.get(days[i][0], 0) >= 25,
    'VIX<25': lambda i: vix.get(days[i][0], 99) < 25,
    'IXIC≤S&P×1.3(나스닥 더 빠짐)': lambda i: ixret.get(days[i][0], 0) <= days[i][1] * 1.3,
    'IXIC>S&P×1.3': lambda i: ixret.get(days[i][0], 0) > days[i][1] * 1.3,
    'BTC 국면 a(<SMA50, 전일 라벨)': lambda i: LAB.get((days[i][2] // DAY) * DAY - DAY) == 'a',
    'BTC 국면 b·c(전일 라벨)': lambda i: LAB.get((days[i][2] // DAY) * DAY - DAY) in ('b', 'c'),
}
for xk in ['T24', 'TP2/T24']:
    base = [ev(sig(x), EK, xk) for x in XS]
    log(f'  [{xk}] 무조건: 중앙 {P(np.median([b[1] for b in base]))} (n x1.0={base[0][0]}, x2.0={base[4][0]}, x3.0={base[-1][0]})')
    for nm, c in CONDS.items():
        r = [ev(sig(x, c), EK, xk) for x in XS]
        ok = [q[1] for q in r if q[0] >= 5]
        log(f'    {nm:28s} 중앙 {P(np.median(ok)) if ok else "  n/a"}  n(x1.0/2.0/3.0)={r[0][0]}/{r[4][0]}/{r[-1][0]}  칸별 ' + ' '.join(P(q[1], 1) if q[0] >= 5 else '·' for q in r))

log('\n=== 7. 매크로 발표일 겹침 (축 L) ===')
for x in [1.0, 1.5, 2.0, 2.5]:
    s = sig(x); ds = [days[i][0].isoformat() for i in s]
    f = sum(d in MACRO['fomc'] for d in ds); c = sum(d in MACRO['cpi'] for d in ds); e = sum(d in MACRO['empsit'] for d in ds)
    nm = [i for i in s if days[i][0].isoformat() not in (MACRO['fomc'] | MACRO['cpi'] | MACRO['empsit'])]
    n0, m0, _ = ev(nm, EK, 'T24')
    log(f'  x{x}: n={len(s)} FOMC {f} CPI {c} 고용 {e} (합 {(f+c+e)/len(s)*100:.0f}%) · 발표일 제외 n={n0} T24 {P(m0)}')
allds = [d[0].isoformat() for d in days]
log(f'  전체 거래일 중 발표일 비율 {sum(d in (MACRO["fomc"]|MACRO["cpi"]|MACRO["empsit"]) for d in allds)/len(allds)*100:.0f}%')

log('\n=== 8. 워크포워드: IS 에서 (x, 청산) 최고 평균(n≥15) 선택 → OOS ===')
for isA, isB, osA, osB in [(2018, 2021, 2022, 2026), (2018, 2022, 2023, 2026), (2018, 2023, 2024, 2026)]:
    best = None
    for xk in EXITS:
        for x in XS:
            n, m, _ = ev(per_idx(sig(x), isA, isB), EK, xk)
            if n >= 15 and (best is None or m > best[0]): best = (m, x, xk, n)
    m, x, xk, n = best; on, om, ot = ev(per_idx(sig(x), osA, osB), EK, xk)
    bn, bm, _ = ev(per_idx(ALL, osA, osB), EK, xk)
    log(f'  IS {isA}-{isB}: 선택 x{x} {xk} IS n={n} {P(m)} → OOS {osA}-{osB} n={on} {P(om)} t {ot:.2f} (OOS 기준 {P(bm)})')

log('\n=== 9. 포트폴리오 (1,000만 단일 슬리브, 신호 시 전액/50%, 2018-01 ~ ) ===')
reps = [(1.5, 'D360', 'T24'), (1.75, 'D360', 'T24'), (2.0, 'D360', 'T24'), (2.5, 'D360', 'T24'), (1.5, 'D360', 'T48'), (2.0, 'D15', 'T24'), (2.0, 'K09', 'T24'), (1.5, 'K09', 'T24'), (1.75, 'K09', 'T24'), (2.25, 'K09', 'T24'), (2.5, 'K09', 'T24'), (1.0, 'K09', 'T24'), (2.0, 'K09', 'T48'), (2.0, 'K09', 'TP3/T24'), (2.0, 'D240', 'T24'), (2.0, 'D480', 'T24')]
res = {}
for x, ek, xk in reps:
    tp, h = EXITS[xk]
    sigs = [(days[i][2], next0900(days[i][2]) if ek == 'K09' else None) for i in sig(x)]
    for f in [1.0, 0.5]:
        for cm in [1.0, 2.0]:
            tr = run(sigs, f=f, delay_ms=(ENTRY[ek] or 0) * 60000, tp=tp, hold_ms=h * 3600000, cost_mult=cm)
            dr = daily_curve(tr, f, T0 // DAY * DAY, TEND // DAY * DAY, cm)
            s = stats(tr, dr, f)
            log(f'  x{x} {ek} {xk:8s} f={f} 비용×{cm:.0f}: ' + fmt_stats(s))
            if f == 1.0 and cm == 1.0:
                res[(x, ek, xk)] = (tr, dr)
                rg = regime(dr)
                log('     국면 ' + ' '.join(f'({g}) {rg[g][0]}일 일평균 {P(rg[g][1],3)} 누적 {P(rg[g][2],1)}' for g in 'abc'))
                for nm, a, b in PER:
                    sub = {t: r for t, r in dr.items() if a <= int(ymd(t)[:4]) <= b}
                    tsub = [t for t in tr if a <= int(ymd(t['et'])[:4]) <= b]
                    v = np.array(list(sub.values()))
                    log(f'     {nm}: 거래 {len(tsub):2d} 누적 {P(np.prod(1+v)-1,1)} 거래평균 {P(np.mean([t["net"] for t in tsub]) if tsub else 0)}')
                c = complement(dr)
                if 'corr' in c:
                    log(f'     보완성(공통 {c["n"]}일, {c["first"]}~): 함대균등합 상관 {c["corr"]:+.3f} · 함대 손실일 {c["loss_n"]}일 평균 {P(c["loss_mean"],3)} (전체일 {P(c["all_mean"],3)}; 그날 함대 {P(c["fleet_loss_mean"],2)}) · 개별상관 ' + ' '.join(f'{k}:{v:+.2f}' for k, v in c['per'].items()))
# 결과 저장
json.dump({f'{k[0]}_{k[1]}_{k[2]}': {'trades': [{kk: (vv if not isinstance(vv, np.generic) else float(vv)) for kk, vv in t.items()} for t in v[0]], 'daily': {str(t): float(r) for t, r in v[1].items()}} for k, v in res.items()}, open(OUT + f'a-results-{EK}.json', 'w'))
open(OUT + f'a-report-{EK}.txt', 'w').write('\n'.join(L))
