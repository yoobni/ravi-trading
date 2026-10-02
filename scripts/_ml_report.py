"""축 G 결과표. 실행: venv/bin/python scripts/_ml_report.py P28 18 [excl28]"""
import os, sys
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ml_sim import Mkt, rolling_thresh, sim_E, sim_R, btc_hold, size_for, OUT

panel = sys.argv[1]; H = int(sys.argv[2]); excl = len(sys.argv) > 3 and sys.argv[3] == 'excl28'
M = Mkt(panel, exclude28=excl)
D = lambda s: int(pd.Timestamp(s, tz='UTC').value // 10**6)

models = [f'pred_{panel}_{m}_{t}_H{H}' for m in ('lgbm', 'ridge') for t in ('xs', 'raw')] + \
         [f'pred_{panel}_{m}_xs_H{H}_placebo' for m in ('lgbm', 'ridge')]
models = [m for m in models if os.path.exists(os.path.join(OUT, m + '.pkl'))]
S_ml = {m: M.score_from_pred(m) for m in models}
first_ml = min(np.where(~np.isnan(s).all(axis=1))[0][0] for s in S_ml.values())
T_FROM = int(M.ts[first_ml + 540]); T_TO = int(M.ts[-1])
if panel == 'P28':
    SP = [('~23말', T_FROM, D('2023-12-31')), ('2024', D('2024-01-01'), D('2024-12-31')), ('2025', D('2025-01-01'), D('2025-12-31')), ('2026', D('2026-01-01'), T_TO)]
else:
    SP = [('~25말', T_FROM, D('2025-12-31')), ('2026', D('2026-01-01'), T_TO)]
print(f'{panel}{" (28코인 제외)" if excl else ""} 코인 {len(M.coins)} · OOS 평가 {pd.to_datetime(T_FROM, unit="ms").date()} ~ {pd.to_datetime(T_TO, unit="ms").date()} · H={H}')

f6 = M.feat('f6'); ret42 = M.feat('ret42')
# F7: F6 플래그, 동률은 코인 목록 순서(기존 하네스와 같게)
order_bonus = (np.arange(len(M.coins))[::-1] / 1e6)[None, :]
S_f7 = np.where(f6 == 1, 1 + order_bonus, np.nan)
th_f7 = np.full(len(M.ts), 0.5)
scores_E = {'F7 (F6신호)': (S_f7, th_f7)}
for q in (0.99, 0.97):
    scores_E[f'모멘텀 ret42 q{q}'] = (ret42, rolling_thresh(ret42, q))
    for m, S in S_ml.items():
        scores_E[f'{m.replace("pred_" + panel + "_", "")} q{q}'] = (S, rolling_thresh(S, q))

def row_E(lab, S, th, fric=1.0):
    r = sim_E(M, S, th, 0.33, T_FROM, T_TO, fric=fric)
    sz = size_for(lambda z: sim_E(M, S, th, z, T_FROM, T_TO, fric=fric))
    e = sim_E(M, S, th, sz, T_FROM, T_TO, fric=fric)
    per = ''.join(f'{sim_E(M, S, th, sz, a, b, fric=fric)[0]:7.0f}%' for _, a, b in SP)
    print(f'  {lab:34s} {r[0]:7.0f}% {r[1]:5.0f}% {r[2]:5d} {r[3]:+6.2f}% | {e[0]:6.0f}% sz{sz*100:4.0f}% |{per}', flush=True)

print('\n── 엔진 E (F7형: 임계 초과 → 다음 시가 진입 · TP+6 지정가 · 3일 · 3슬롯) ──')
print(f'  {"점수":34s} {"33%×3":>8s} {"MDD":>5s} {"거래":>5s} {"거래당":>7s} | {"MDD17":>6s}       |' + ''.join(f'{s[0]:>8s}' for s in SP))
for lab, (S, th) in scores_E.items():
    row_E(lab, S, th)

print('\n── 엔진 E · 비용 ×2 스트레스 (상위만) ──')
for lab in [k for k in scores_E if k.startswith(('F7', '모멘텀 ret42 q0.99', 'lgbm_xs', 'ridge_xs', 'lgbm_raw')) and 'placebo' not in k and 'q0.97' not in k]:
    S, th = scores_E[lab]; row_E(lab + ' ×2', S, th, fric=2.0)

print(f'\n── 엔진 R (로테이션: {H}봉마다 상위 3, 동일비중) — MDD17 총익 / 구간 ──')
rot = {'모멘텀 ret42': (ret42, False)}
for m, S in S_ml.items():
    lab = m.replace('pred_' + panel + '_', '')
    rot[lab] = (S, False)
    if '_raw_' in m:
        rot[lab + ' (pred>0 일 때만)'] = (S, True)
for lab, (S, gate) in rot.items():
    w = size_for(lambda z: sim_R(M, S, z, T_FROM, T_TO, H=H, gate=gate))
    e = sim_R(M, S, w, T_FROM, T_TO, H=H, gate=gate)
    full = sim_R(M, S, 1.0, T_FROM, T_TO, H=H, gate=gate)
    per = ''.join(f'{sim_R(M, S, w, a, b, H=H, gate=gate)[0]:7.0f}%' for _, a, b in SP)
    print(f'  {lab:34s} 풀투자 {full[0]:6.0f}%/MDD{full[1]:3.0f}% | MDD17 {e[0]:6.0f}% w{w*100:4.0f}% |{per}', flush=True)

w = size_for(lambda z: btc_hold(M, z, T_FROM, T_TO))
print(f'\n  BTC 축소보유 MDD17: {btc_hold(M, w, T_FROM, T_TO)[0]:.0f}% (w {w*100:.0f}%) |' + ''.join(f'{btc_hold(M, w, a, b)[0]:7.0f}%' for _, a, b in SP))
