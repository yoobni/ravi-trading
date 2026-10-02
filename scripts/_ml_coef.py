"""ridge_raw H18 이 무엇을 보는지 — 학습창별 표준화 계수 (첫 창 / 중간 / 마지막)."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ml_wf as W
from sklearn.linear_model import Ridge
X = W.make_labels(pd.read_pickle(os.path.join(W.OUT, 'P28.pkl')), 18)
F = [f for f in W.feat_cols(X) if f not in ('y_raw', 'y_xs')]
ts = np.sort(X.ts.unique())
res = {}
for lab, frac in (('2023-07', 0.25), ('2024-12', 0.6), ('2026-08', 1.0)):
    cut = ts[int(len(ts) * frac) - 1]
    tr = X[(X.ts < cut - 18 * W.BAR) & X.y_raw.notna()]
    A, _ = W.prep(tr, tr.iloc[:1], F)
    res[lab] = pd.Series(Ridge(alpha=3000).fit(A, tr.y_raw.values).coef_, index=F)
R = pd.DataFrame(res)
R['abs'] = R.abs().mean(axis=1)
print((R.sort_values('abs', ascending=False).head(15) * 1e4).round(1).drop(columns='abs').to_string())
print('(단위: 표준편차 1 당 18봉 순수익 bp)')
