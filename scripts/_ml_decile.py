"""예측 10분위별 실현 순수익(비용 차감) — 롱 온리로 쓸 수 있는 건 상위 분위의 '절대' 수익뿐."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ml_wf as W
for panel, H in (('P118', 18), ('P118', 6), ('P28', 18), ('P28', 6)):
    X = W.make_labels(pd.read_pickle(os.path.join(W.OUT, f'{panel}.pkl')), H)
    for name in (f'pred_{panel}_lgbm_xs_H{H}', f'pred_{panel}_ridge_raw_H{H}'):
        P = pd.read_pickle(os.path.join(W.OUT, name + '.pkl'))
        d = X.merge(P, on=['ts', 'm']).dropna(subset=['y_raw'])
        d['dec'] = d.groupby('ts').pred.transform(lambda s: pd.qcut(s.rank(method='first'), 10, labels=False) if len(s) >= 10 else np.nan)
        g = d.groupby('dec').y_raw.mean() * 100
        top1 = d[d.groupby('ts').pred.rank(ascending=False) == 1].y_raw.mean() * 100
        print(f'{name:30s} 분위1..10 순수익% ' + ' '.join(f'{v:+.2f}' for v in g.values) + f' | 1등 {top1:+.2f}% | 시장평균 {d.y_raw.mean()*100:+.2f}%  (H={H}봉, 중첩표본)')
