import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ml_sim import Mkt, rolling_thresh, sim_E, size_for, btc_hold
D = lambda s: int(pd.Timestamp(s, tz='UTC').value // 10**6)
for excl in (False, True):
    M = Mkt('P118', exclude28=excl)
    S = M.score_from_pred('pred_P118_ridge_raw_H18_from28')
    first = np.where(~np.isnan(S).all(axis=1))[0][0]
    T0, T1 = int(M.ts[first + 540]), int(M.ts[-1])
    f6 = M.feat('f6'); ob = (np.arange(len(M.coins))[::-1] / 1e6)[None, :]
    S7 = np.where(f6 == 1, 1 + ob, np.nan); th7 = np.full(len(M.ts), 0.5)
    print(f'\n{"28코인 제외 " if excl else ""}P118 {len(M.coins)}코인 · {pd.to_datetime(T0, unit="ms").date()}~{pd.to_datetime(T1, unit="ms").date()}')
    for lab, SS, th in (('F7', S7, th7), ('ridge_raw(28학습) q0.99', S, rolling_thresh(S, 0.99)), ('ridge_raw(28학습) q0.995', S, rolling_thresh(S, 0.995)), ('ridge_raw(28학습) q0.98', S, rolling_thresh(S, 0.98))):
        for pen in (0.0, 0.005):
            f = lambda z, a=T0, b=T1: sim_E(M, SS, th, z, a, b, pen=pen)
            r = f(0.33); sz = size_for(f); e = f(sz)
            print(f'  {lab:26s} 관통{pen*100:.1f}% {r[0]:6.0f}% MDD{r[1]:3.0f}% n{r[2]:4d} {r[3]:+.2f}% | MDD17 {e[0]:5.0f}% | 25말 {f(sz, T0, D("2025-12-31"))[0]:5.0f}% 2026 {f(sz, D("2026-01-01"), T1)[0]:5.0f}%')
    w = size_for(lambda z: btc_hold(M, z, T0, T1)); print(f'  BTC 축소보유 MDD17 {btc_hold(M, w, T0, T1)[0]:.0f}%')
