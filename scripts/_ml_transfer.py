"""유니버스 전이 — P28 로 학습(확장창, 월간 재학습, alpha 3000 고정)한 ridge_raw 를 P118 의 28코인 밖 코인에 적용."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ml_wf as W
from _ml_panel import COINS28
from sklearn.linear_model import Ridge
H = 18
X28 = W.make_labels(pd.read_pickle(os.path.join(W.OUT, 'P28.pkl')), H)
X118 = W.make_labels(pd.read_pickle(os.path.join(W.OUT, 'P118.pkl')), H)
F = [f for f in W.feat_cols(X28) if f not in ('y_raw', 'y_xs')]
# P118 의 횡단면 특징(xr_*, breadth, mkt_*)은 107코인 기준으로 계산돼 있다 — 그대로 쓴다(실제 운용 유니버스 기준).
ts = np.sort(X118.ts.unique())
starts = [t for t in ts if t >= ts[0] + 60 * 86400_000][::180]
out = []
for k, s in enumerate(starts):
    e = starts[k + 1] if k + 1 < len(starts) else ts[-1] + 1
    tr = X28[(X28.ts < s - H * W.BAR) & X28.y_raw.notna()]
    te = X118[(X118.ts >= s) & (X118.ts < e)]
    A, B = W.prep(tr, te, F)
    out.append(pd.DataFrame({'ts': te.ts.values, 'm': te.m.values, 'pred': Ridge(alpha=3000).fit(A, tr.y_raw.values).predict(B)}))
P = pd.concat(out)
P.to_pickle(os.path.join(W.OUT, 'pred_P118_ridge_raw_H18_from28.pkl'))
oos = X118.merge(P, on=['ts', 'm'])
for lab, sub in (('전체 107', oos), ('28코인', oos[oos.m.isin(COINS28)]), ('28 밖 79', oos[~oos.m.isin(COINS28)])):
    print(f'{lab:8s} 예측 IC(raw) {W.ic(sub.pred.values, sub, "y_raw"):+.4f}  IC(xs) {W.ic(sub.pred.values, sub, "y_xs"):+.4f}')
