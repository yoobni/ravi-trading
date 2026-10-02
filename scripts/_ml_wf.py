"""
축 G — 워크포워드 학습/예측 (2026-10-02)
  - 확장창 학습, 매 RETRAIN 봉마다 재학습, 학습 라벨은 예측 시작 H 봉 전에서 끊는다(엠바고).
  - 모델: ridge / lgbm. 타깃: raw(순수익, 비용 차감) / xs(횡단면 평균 차감).
  - 하이퍼파라미터는 첫 학습창 내부(앞 80% 학습 · 뒤 20% 검증)에서만 고른다.
  - 출력: data/research-ext/ml/pred_{panel}_{model}_{target}_H{H}[ _placebo].pkl  (ts, m, pred)
실행: venv/bin/python scripts/_ml_wf.py P28 18
"""
import os, sys, json, time, warnings
import numpy as np
import pandas as pd
warnings.filterwarnings('ignore')
from sklearn.linear_model import Ridge
import lightgbm as lgb
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ml_panel import feat_cols, OUT, ROOT

SPREAD = json.load(open(os.path.join(ROOT, 'data', 'research-spread-p50.json')))
FEE = 0.0005
BAR = 4 * 3600_000


def slip_of(m):
    return max(0.0005, SPREAD[m] / 2 / 1e4) if m in SPREAD else 0.003


def make_labels(X, H):
    slip = X.m.map(slip_of)
    raw = np.log(X[f'c_fwd{H}'] / X.o_next) - 2 * FEE - 2 * slip
    X = X.assign(y_raw=raw)
    X['y_xs'] = X.y_raw - X.groupby('ts').y_raw.transform('mean')
    return X


def prep(Xtr, Xte, F):
    mu = Xtr[F].mean(); sd = Xtr[F].std().replace(0, 1)
    a = ((Xtr[F] - mu) / sd).clip(-5, 5).fillna(0).values
    b = ((Xte[F] - mu) / sd).clip(-5, 5).fillna(0).values
    return a, b


def fit_predict(model, params, Xtr, ytr, Xte):
    if model == 'ridge':
        m = Ridge(alpha=params['alpha']).fit(Xtr, ytr)
        return m.predict(Xte)
    m = lgb.LGBMRegressor(n_estimators=params['n'], learning_rate=0.03, num_leaves=params['leaves'],
                          min_child_samples=params['minc'], subsample=0.8, subsample_freq=1,
                          colsample_bytree=0.7, reg_lambda=1.0, verbose=-1, n_jobs=4)
    m.fit(Xtr, ytr)
    return m.predict(Xte)


def ic(pred, X, ycol):
    d = pd.DataFrame({'ts': X.ts.values, 'p': pred, 'y': X[ycol].values}).dropna()
    s = d.groupby('ts').apply(lambda g: g.p.rank().corr(g.y.rank()) if len(g) >= 5 else np.nan, include_groups=False)
    return s.mean()


GRID = {'ridge': [{'alpha': a} for a in (1, 100, 3000, 30000)],
        'lgbm': [{'n': n, 'leaves': lv, 'minc': mc} for n in (150, 400) for lv in (7, 31) for mc in (300,)]}


def run(panel, H, model, target, placebo=False, init_months=12, retrain_bars=180, seed=0):
    X = pd.read_pickle(os.path.join(OUT, f'{panel}.pkl'))
    X = make_labels(X, H)
    F = feat_cols(X)
    F = [f for f in F if f not in ('y_raw', 'y_xs')]
    ycol = f'y_{target}'
    ts_all = np.sort(X.ts.unique())
    t0 = ts_all[0] + init_months * 30 * 86400_000
    rng = np.random.default_rng(seed)
    # 첫 학습창에서 하이퍼파라미터 선택
    first = X[(X.ts < t0 - H * BAR) & X[ycol].notna()]
    cut = first.ts.quantile(0.8)
    a, b = first[first.ts < cut - H * BAR], first[first.ts >= cut]
    best, best_ic = None, -9
    for p in GRID[model]:
        ya = a[ycol].values
        if placebo:
            ya = rng.permutation(ya)
        A, B = prep(a, b, F)
        pr = fit_predict(model, p, A, ya, B)
        v = ic(pr, b, ycol)
        if v > best_ic:
            best, best_ic = p, v
    preds = []
    starts = [t for t in ts_all if t >= t0][::retrain_bars]
    for k, s in enumerate(starts):
        e = starts[k + 1] if k + 1 < len(starts) else ts_all[-1] + 1
        tr = X[(X.ts < s - H * BAR) & X[ycol].notna()]
        te = X[(X.ts >= s) & (X.ts < e)]
        if len(te) == 0:
            continue
        ytr = tr[ycol].values
        if placebo:
            ytr = rng.permutation(ytr)
        A, B = prep(tr, te, F)
        pr = fit_predict(model, best, A, ytr, B)
        preds.append(pd.DataFrame({'ts': te.ts.values, 'm': te.m.values, 'pred': pr}))
    P = pd.concat(preds, ignore_index=True)
    oos = X[X.ts >= t0].merge(P, on=['ts', 'm'])
    oic = ic(oos.pred.values, oos, ycol)
    name = f'pred_{panel}_{model}_{target}_H{H}' + ('_placebo' if placebo else '')
    P.to_pickle(os.path.join(OUT, name + '.pkl'))
    # 기준 특징 IC (같은 OOS 구간)
    return name, best, best_ic, oic, oos


if __name__ == '__main__':
    panel = sys.argv[1]; H = int(sys.argv[2])
    init = 12 if panel == 'P28' else 6
    only = sys.argv[3] if len(sys.argv) > 3 else None
    for model in ('ridge', 'lgbm'):
        for target in ('raw', 'xs'):
            for placebo in (False, True):
                if only and only != model:
                    continue
                if placebo and target == 'raw':
                    continue
                t = time.time()
                name, best, bic, oic, oos = run(panel, H, model, target, placebo, init_months=init)
                base = {k: ic(oos[k].values * (-1 if k == 'dhi42_neg' else 1), oos, f'y_{target}') for k in ('ret42', 'ret6', 'f6', 'xr_ret42')}
                print(f'{name:40s} 선택 {best} 검증IC {bic:+.4f} | OOS IC {oic:+.4f} | 기준IC ret42 {base["ret42"]:+.4f} ret6 {base["ret6"]:+.4f} f6 {base["f6"]:+.4f} | {time.time()-t:.0f}s', flush=True)
