# 축 B: Deribit DVOL(BTC) 공포 극단 → 업비트 BTC 보유 (무스톱). 스냅샷 = 22:00 UTC 시작 1h 봉 종가(23:00 UTC 확정) → 00:00 UTC(KST 09시) 업비트 시가 진입
import sys, json, numpy as np
sys.path.insert(0, '/Users/goyubin/Desktop/Ravi/project/upbit-trading/scripts')
from _bt_dip_shock_lib import *
dv = json.load(open(OUT + 'deribit-dvol-btc.json'))
hz = {int(r[0]): r[4] for r in dv['hourly']}
snap_days = []; vals = []
for t in sorted(hz):
    if t % DAY == 22 * 3600000:
        snap_days.append(t // DAY * DAY); vals.append(hz[t])
SD = np.array(snap_days, dtype=np.int64); V = np.array(vals, float)
n = len(V)
def zs(w):
    z = np.full(n, np.nan)
    for k in range(w, n): seg = V[k - w + 1:k + 1]; z[k] = (V[k] - seg.mean()) / seg.std(ddof=1)
    return z
def pct(w=365):
    p = np.full(n, np.nan)
    for k in range(w, n): seg = V[k - w + 1:k + 1]; p[k] = (seg < V[k]).mean()
    return p
Z = {30: zs(30), 60: zs(60)}; PC = pct()
TEND = int(B['T'][-1]) - 32 * DAY
print(f'DVOL 스냅샷 {n}일 {ymd(SD[0])} ~ {ymd(SD[-1])}, 평균 {V.mean():.1f}')
L = []
def log(s=''): print(s); L.append(s)

def entry_at(k, lag=0): return int(SD[k]) + DAY * (1 + lag)  # 스냅샷 날 다음 00:00 UTC
def trade(k, hold, exitz=None, w=30, lag=0, cm=1.0):
    t0 = entry_at(k, lag)
    if t0 > TEND: return None
    if exitz is None: h = hold * DAY
    else:
        h = None
        for j in range(k + 1, min(k + 1 + hold, n)):
            if Z[w][j] <= exitz: h = entry_at(j, lag) - t0; break
        if h is None: h = hold * DAY
    return sim_trade(int(SD[k]), 0, hold_ms=h, entry_at=t0, cost_mult=cm)

SIGS = {}
for w in [30, 60]:
    for zt in [1.5, 2.0, 2.5]: SIGS[f'z{w}≥{zt}'] = (lambda k, w=w, zt=zt: Z[w][k] >= zt, w)
for pt in [0.8, 0.9, 0.95]: SIGS[f'1y≥{int(pt*100)}%'] = (lambda k, pt=pt: PC[k] >= pt, 30)
EXITS = {'H7': (7, None), 'H14': (14, None), 'H30': (30, None), 'Z0(≤30d)': (30, 0.0)}

def events(cond, a=None, b=None):
    return [k for k in range(n) if not np.isnan(Z[60][k]) and cond(k) and (a is None or a <= int(ymd(SD[k])[:4]) <= b)]
def sleeve(ks, hold, ez, w, lag=0, cm=1.0):
    out = []; busy = 0
    for k in ks:
        if entry_at(k, lag) < busy: continue
        t = trade(k, hold, ez, w, lag, cm)
        if t is None: continue
        out.append(t); busy = t['xt']
    return out
def indep(ks, gap=30):
    out = []; last = -10**9
    for k in ks:
        if k - last >= gap: out.append(k); last = k
    return out

# 무조건 기준: 모든 날 진입 동일 보유
log('=== 0. 기준(모든 날 진입) 보유별 평균 순 ===')
ALLK = [k for k in range(n) if not np.isnan(Z[60][k])]
base = {}
for xk, (h, ez) in EXITS.items():
    v = [trade(k, h, ez, 30) for k in ALLK]; v = np.array([t['net'] for t in v if t]); base[xk] = v
    log(f'  {xk:9s} n={len(v)} 평균 {P(v.mean())}')

log('\n=== 1. 격자 (단일 슬리브 거래 기준: n / 평균 / t; 독립사건=30일 간격) ===')
res = {}
for sk, (c, w) in SIGS.items():
    ks = events(c); ind = indep(ks)
    row = []
    for xk, (h, ez) in EXITS.items():
        tr = sleeve(ks, h, ez, w); v = np.array([t['net'] for t in tr])
        t = v.mean() / v.std(ddof=1) * np.sqrt(len(v)) if len(v) > 2 else 0
        res[(sk, xk)] = tr; row.append(f'{xk}: {len(v):2d} {P(v.mean()) if len(v) else "-":>7} t{t:4.1f}')
    log(f'  {sk:9s} 신호일 {len(ks):3d} 독립사건 {len(ind):2d} | ' + ' | '.join(row))

log('\n=== 2. 반대: 낮은 DVOL 이후 BTC 전방 수익(비용 없음, 모든 해당일 평균) vs 전체 ===')
def fwd(k, d):
    t0 = entry_at(k)
    if t0 + d * DAY > TEND: return None
    return mark(t0 + d * DAY) / mark(t0) - 1
for lab, c in [('전체', lambda k: True), ('z30≤-1.5', lambda k: Z[30][k] <= -1.5), ('z30≤-2', lambda k: Z[30][k] <= -2), ('1y≤10%', lambda k: PC[k] <= 0.1), ('1y≤20%', lambda k: PC[k] <= 0.2), ('z30≥2', lambda k: Z[30][k] >= 2), ('1y≥90%', lambda k: PC[k] >= 0.9)]:
    ks = [k for k in ALLK if c(k)]
    out = []
    for d in [7, 14, 30]:
        v = [fwd(k, d) for k in ks]; v = [x for x in v if x is not None]
        out.append(f'{d}d {P(np.mean(v)) if v else "-"} (n{len(v)}, 음수비율 {np.mean(np.array(v)<0)*100:.0f}%)' if v else f'{d}d -')
    log(f'  {lab:9s} 독립 {len(indep(ks)):2d} · ' + ' · '.join(out))

YRS = [(2021, 2021), (2022, 2022), (2023, 2023), (2024, 2024), (2025, 2025), (2026, 2026)]
log('\n=== 3. 연도별·비용×2·지연1일·플라시보 (주요 칸) ===')
rng = np.random.default_rng(11)
for sk in ['z30≥2.0', 'z30≥1.5', 'z60≥2.0', '1y≥90%', '1y≥95%']:
    c, w = SIGS[sk]; ks = events(c)
    for xk in ['H7', 'H14', 'H30', 'Z0(≤30d)']:
        h, ez = EXITS[xk]; tr = sleeve(ks, h, ez, w); v = np.array([t['net'] for t in tr])
        if len(v) == 0: continue
        v2 = np.array([t['net'] for t in sleeve(ks, h, ez, w, cm=2.0)])
        v3 = np.array([t['net'] for t in sleeve(ks, h, ez, w, lag=1)])
        allv = base[xk]
        sims = np.array([rng.choice(allv, len(v), replace=False).mean() for _ in range(2000)])
        yr = ' '.join(f'{a}:{len([t for t in tr if int(ymd(t["et"])[:4])==a])}/{P(np.mean([t["net"] for t in tr if int(ymd(t["et"])[:4])==a]),1) if [t for t in tr if int(ymd(t["et"])[:4])==a] else "-"}' for a, _ in YRS)
        log(f'  {sk:8s} {xk:9s} n={len(v):2d} 평균 {P(v.mean())} 중앙 {P(np.median(v))} 승 {np.mean(v>0)*100:3.0f}% | 비용×2 {P(v2.mean())} | 지연1일 {P(v3.mean())} | 플라시보 백분위 {(sims<v.mean()).mean()*100:.0f} (중앙 {P(np.median(sims))}) | {yr}')

log('\n=== 4. 워크포워드: IS 2021-2023 에서 (신호, 청산) 최고 평균(n≥5) → OOS 2024-2026 ===')
best = None
for sk, (c, w) in SIGS.items():
    for xk, (h, ez) in EXITS.items():
        tr = sleeve(events(c, 2021, 2023), h, ez, w)
        if len(tr) >= 5:
            m = np.mean([t['net'] for t in tr])
            if best is None or m > best[0]: best = (m, sk, xk, len(tr))
m, sk, xk, nn = best; c, w = SIGS[sk]; h, ez = EXITS[xk]
tr = sleeve(events(c, 2024, 2026), h, ez, w)
log(f'  IS 선택 {sk} {xk} IS n={nn} {P(m)} → OOS n={len(tr)} {P(np.mean([t["net"] for t in tr])) if tr else "-"} (OOS 기준 {P(np.mean([t["net"] for t in sleeve([k for k in ALLK if int(ymd(SD[k])[:4])>=2024], h, ez, w)]))})')

log('\n=== 5. 포트폴리오 (단일 슬리브 1,000만, 2021-04 ~) ===')
t_s = int(SD[60]) + DAY; t_e = TEND // DAY * DAY
saved = {}
for sk, xk in [('z30≥2.0', 'H7'), ('z30≥2.0', 'H14'), ('z30≥2.0', 'H30'), ('z30≥2.0', 'Z0(≤30d)'), ('z30≥1.5', 'H14'), ('1y≥90%', 'H14'), ('1y≥90%', 'H30')]:
    c, w = SIGS[sk]; h, ez = EXITS[xk]
    for f in [1.0, 0.5]:
        tr = sleeve(events(c), h, ez, w); dr = daily_curve(tr, f, t_s, t_e); s = stats(tr, dr, f)
        log(f'  {sk} {xk:9s} f={f}: ' + fmt_stats(s))
        if f == 1.0:
            rg = regime(dr); cpl = complement(dr)
            log('     국면 ' + ' '.join(f'({g}) {rg[g][0]}일 일평균 {P(rg[g][1],3)} 누적 {P(rg[g][2],1)}' for g in 'abc'))
            if 'corr' in cpl: log(f'     보완성: 함대 상관 {cpl["corr"]:+.3f} · 함대 손실일 {cpl["loss_n"]}일 평균 {P(cpl["loss_mean"],3)} (전체일 {P(cpl["all_mean"],3)})')
            saved[f'{sk}_{xk}'] = {'trades': [{a: float(b) if isinstance(b, (np.floating,)) else b for a, b in t.items()} for t in tr], 'daily': {str(a): float(b) for a, b in dr.items()}}
# 비교: 같은 기간 BTC 보유
v = np.array([BTCD[t] for t in range(t_s, t_e, DAY) if t in BTCD]); eq = np.cumprod(1 + v)
log(f'  [참고] 같은 기간 BTC 보유: 총익 {P(eq[-1]-1,1)} MDD {P((eq/np.maximum.accumulate(eq)-1).min(),1)} 샤프 {v.mean()/v.std()*np.sqrt(365):.2f}')
log('\n=== 6. 신호 사건 목록 (z30≥2.0, 독립 30일) ===')
for k in indep(events(SIGS['z30≥2.0'][0])):
    t = trade(k, 14, None, 30)
    log(f'  {ymd(SD[k])} DVOL {V[k]:.0f} z {Z[30][k]:.1f} 1y {PC[k]*100:.0f}% · BTC 직전7일 {P(mark(entry_at(k))/mark(entry_at(k)-7*DAY)-1,1)} · H14 순 {P(t["net"],1) if t else "-"}')
json.dump(saved, open(OUT + 'b-results.json', 'w'))
open(OUT + 'b-report.txt', 'w').write('\n'.join(L))

log('\n=== 7. 공포(하락 동반) vs 상승 동반 분리: BTC 직전 7일 수익으로 (단일 슬리브) ===')
def r7(k): return mark(entry_at(k)) / mark(entry_at(k) - 7 * DAY) - 1
for sk in ['z30≥1.5', 'z30≥2.0', 'z60≥2.0']:
    c, w = SIGS[sk]
    for lab, cc in [('BTC7d≤-5%', lambda k: r7(k) <= -0.05), ('BTC7d<0', lambda k: r7(k) < 0), ('BTC7d≥0', lambda k: r7(k) >= 0)]:
        ks = [k for k in events(c) if cc(k)]
        row = []
        for xk in ['H7', 'H14', 'Z0(≤30d)']:
            h, ez = EXITS[xk]; tr = sleeve(ks, h, ez, w); v = np.array([t['net'] for t in tr])
            rr = np.array([t['net'] for t in sleeve(ks, h, ez, w)]) if len(tr) else []
            row.append(f'{xk} {len(v):2d} {P(v.mean()) if len(v) else "-"} (기준 {P(base[xk].mean())})')
        log(f'  {sk:8s} {lab:10s} 독립 {len(indep(ks)):2d} | ' + ' | '.join(row))
# 공포 버전 포트폴리오·국면
for sk, xk in [('z30≥1.5', 'H14'), ('z30≥2.0', 'H14')]:
    c, w = SIGS[sk]; h, ez = EXITS[xk]
    ks = [k for k in events(c) if r7(k) < 0]
    tr = sleeve(ks, h, ez, w); dr = daily_curve(tr, 1.0, t_s, t_e); s = stats(tr, dr)
    rg = regime(dr); cpl = complement(dr)
    log(f'  [공포판 BTC7d<0] {sk} {xk}: ' + fmt_stats(s))
    log('     국면 ' + ' '.join(f'({g}) 일평균 {P(rg[g][1],3)} 누적 {P(rg[g][2],1)}' for g in 'abc') + f' · 함대 상관 {cpl.get("corr", float("nan")):+.3f} 손실일 평균 {P(cpl.get("loss_mean", 0),3)}')
open(OUT + 'b-report.txt', 'w').write('\n'.join(L))
