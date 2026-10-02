"""시계열 특징만(유니버스 의존 특징 xr_*·breadth·mkt_*·n_coins 제외)으로 ridge_raw 를 P28 에서 워크포워드 학습 →
 (a) P28 자체 OOS, (b) 28코인 밖 코인 OOS(같은 시점·같은 모델) 를 같은 기간에 비교."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ml_wf as W
from _ml_panel import COINS28
from sklearn.linear_model import Ridge
from _ml_sim import Mkt, rolling_thresh, sim_E, size_for
H = 18
X28 = W.make_labels(pd.read_pickle(os.path.join(W.OUT, 'P28.pkl')), H)
X118 = W.make_labels(pd.read_pickle(os.path.join(W.OUT, 'P118.pkl')), H)
F = [f for f in W.feat_cols(X28) if f not in ('y_raw', 'y_xs') and not f.startswith('xr_') and f not in ('breadth50', 'mkt_ret6', 'mkt_ret42', 'n_coins')]
print('특징', len(F))
ts28 = np.sort(X28.ts.unique())
t0 = ts28[0] + 360 * 86400_000
starts = [t for t in ts28 if t >= t0][::180]
p28, p118 = [], []
for k, s in enumerate(starts):
    e = starts[k + 1] if k + 1 < len(starts) else max(ts28[-1], X118.ts.max()) + 1
    tr = X28[(X28.ts < s - H * W.BAR) & X28.y_raw.notna()]
    mdl_in = tr
    te28 = X28[(X28.ts >= s) & (X28.ts < e)]
    te118 = X118[(X118.ts >= s) & (X118.ts < e) & ~X118.m.isin(COINS28)]
    mu = tr[F].mean(); sd = tr[F].std().replace(0, 1)
    z = lambda d: ((d[F] - mu) / sd).clip(-5, 5).fillna(0).values
    mdl = Ridge(alpha=3000).fit(z(tr), tr.y_raw.values)
    if len(te28): p28.append(pd.DataFrame({'ts': te28.ts.values, 'm': te28.m.values, 'pred': mdl.predict(z(te28))}))
    if len(te118): p118.append(pd.DataFrame({'ts': te118.ts.values, 'm': te118.m.values, 'pred': mdl.predict(z(te118))}))
pd.concat(p28).to_pickle(os.path.join(W.OUT, 'pred_P28_ridge_rawTS_H18.pkl'))
pd.concat(p118).to_pickle(os.path.join(W.OUT, 'pred_P118_ridge_rawTS_H18_from28.pkl'))
D = lambda s: int(pd.Timestamp(s, tz='UTC').value // 10**6)
common_from = D('2025-01-27')
for panel, name, excl in (('P28', 'pred_P28_ridge_rawTS_H18', False), ('P118', 'pred_P118_ridge_rawTS_H18_from28', True)):
    M = Mkt(panel, exclude28=excl)
    S = M.score_from_pred(name)
    first = np.where(~np.isnan(S).all(axis=1))[0][0]
    f6 = M.feat('f6'); ob = (np.arange(len(M.coins))[::-1] / 1e6)[None, :]
    S7 = np.where(f6 == 1, 1 + ob, np.nan); th7 = np.full(len(M.ts), 0.5)
    for (lo, hi_) in ((int(M.ts[first + 540]), int(M.ts[-1])), (common_from, int(M.ts[-1]))):
        if lo < M.ts[first + 540]: lo = int(M.ts[first + 540])
        print(f'\n{panel}{" 28밖" if excl else ""} {len(M.coins)}코인 · {pd.to_datetime(lo, unit="ms").date()}~{pd.to_datetime(hi_, unit="ms").date()}')
        for lab, SS, th in (('F7', S7, th7), ('ridge_rawTS q0.99', S, rolling_thresh(S, 0.99)), ('ridge_rawTS q0.985', S, rolling_thresh(S, 0.985)), ('ridge_rawTS q0.97', S, rolling_thresh(S, 0.97))):
            f = lambda z_, a=lo, b=hi_: sim_E(M, SS, th, z_, a, b, pen=0.005)
            r = f(0.33); sz = size_for(f); e = f(sz)
            print(f'  {lab:22s} 관통0.5% {r[0]:6.0f}% MDD{r[1]:3.0f}% n{r[2]:4d} {r[3]:+.2f}% | MDD17 {e[0]:5.0f}%')
