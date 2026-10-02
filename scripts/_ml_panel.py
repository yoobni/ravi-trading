"""
축 G — 다변수 모델(ML) 횡단면 예측 (2026-10-02)

패널 두 개:
  P28  : 28코인 4h 2022-06 ~ 2026-08 (4년)
  P118 : 118코인 캐시 4h 2024-08 ~ 2026-08 (2년, 300봉 이상인 코인만)
특징은 t 봉 종가까지의 정보만. 라벨/체결은 t+1 봉 시가부터(봉마감 직후 크론 = 판단 지연 0 가정).
실행: data/research-ext/venv/bin/python scripts/_ml_panel.py build
"""
import json, os, sys, glob
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'candle-cache')
OUT = os.path.join(ROOT, 'data', 'research-ext', 'ml')
os.makedirs(OUT, exist_ok=True)
COINS28 = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT']


def load_json(p):
    with open(p) as f:
        d = json.load(f)
    if not d:
        return pd.DataFrame(columns=['ts', 'open', 'high', 'low', 'close', 'volume'])
    return pd.DataFrame(d)[['ts', 'open', 'high', 'low', 'close', 'volume']]


def load_panel(kind):
    frames = {}
    if kind == 'P28':
        for m in COINS28:
            fs = [f for f in glob.glob(os.path.join(CACHE, f'{m}_240m_2022-06-10_*.json'))]
            if not fs:
                continue
            best = max(fs, key=os.path.getsize)
            frames[m] = load_json(best)
    else:
        for a in glob.glob(os.path.join(CACHE, '*_240m_2024-08-01_2025-08-01.json')):
            m = os.path.basename(a).split('_')[0]
            b = os.path.join(CACHE, f'{m}_240m_2025-08-01_2026-08-24.json')
            if not os.path.exists(b):
                continue
            df = pd.concat([load_json(a), load_json(b)]).drop_duplicates('ts')
            if len(df) < 300:
                continue
            frames[m] = df
    out = {}
    for m, df in frames.items():
        df = df.astype(float)
        df['ts'] = df.ts.astype('int64')
        df = df.sort_values('ts').drop_duplicates('ts').set_index('ts')
        df = df[(df.close > 0) & (df.volume >= 0)]
        out[m] = df
    return out


def features(panel):
    """코인별 시계열 특징 + 시점별 횡단면 특징. 반환: long DataFrame (ts, m, feats..., fwd 정보)."""
    idx = sorted(set().union(*[set(d.index) for d in panel.values()]))
    btc = panel['KRW-BTC'].reindex(idx)
    btc_c = btc.close.ffill()
    rows = []
    for m, d in panel.items():
        d = d.reindex(idx)
        c, o, h, l, v = d.close, d.open, d.high, d.low, d.volume
        r1 = np.log(c / c.shift(1))
        f = pd.DataFrame(index=idx)
        for k in [1, 3, 6, 18, 42, 84, 180]:
            f[f'ret{k}'] = np.log(c / c.shift(k))
        f['vol18'] = r1.rolling(18).std()
        f['vol42'] = r1.rolling(42).std()
        f['vol_ratio'] = f.vol18 / f.vol42
        lv = np.log1p(v)
        f['vz30'] = (lv - lv.rolling(30).mean().shift(1)) / lv.rolling(30).std().shift(1)
        f['v6_42'] = np.log((v.rolling(6).mean() + 1e-9) / (v.rolling(42).mean() + 1e-9))
        hi42 = h.rolling(42).max(); lo42 = l.rolling(42).min()
        f['dhi42'] = np.log(c / hi42)
        f['dlo42'] = np.log(c / lo42)
        f['dhi180'] = np.log(c / h.rolling(180).max())
        f['pos42'] = (c - lo42) / (hi42 - lo42 + 1e-12)
        rng = (h - l).replace(0, np.nan)
        f['body'] = (c - o) / o
        f['uwick'] = (h - np.maximum(c, o)) / rng
        f['lwick'] = (np.minimum(c, o) - l) / rng
        f['sma50'] = np.log(c / c.rolling(50).mean())
        f['sma300'] = np.log(c / c.rolling(300).mean())
        up = r1.clip(lower=0).rolling(14).mean(); dn = (-r1.clip(upper=0)).rolling(14).mean()
        f['rsi14'] = up / (up + dn + 1e-12)
        f['green3'] = (c > o).astype(float).rolling(3).sum()
        f['btc_ret6'] = np.log(btc_c / btc_c.shift(6))
        f['btc_ret42'] = np.log(btc_c / btc_c.shift(42))
        f['btc_sma300'] = np.log(btc_c / btc_c.rolling(300).mean())
        f['rel6'] = f.ret6 - f.btc_ret6
        f['rel42'] = f.ret42 - f.btc_ret42
        # BTC 와의 베타(42봉)
        br = np.log(btc_c / btc_c.shift(1))
        f['beta42'] = r1.rolling(42).cov(br) / (br.rolling(42).var() + 1e-12)
        f['turn_krw'] = np.log1p((c * v).rolling(42).mean())
        # F6 신호 플래그: 직전 봉이 42봉 신고가 + 이번 봉 양봉 + 직전 고가 돌파 + vz≥0.5
        prevhi = h.shift(1); hi_before = h.shift(2).rolling(41).max()
        vmean = v.rolling(30).mean().shift(1); vstd = v.rolling(30).std(ddof=0).shift(1)
        vzr = (v - vmean) / vstd
        f['f6'] = ((prevhi > hi_before) & (c > o) & (c > prevhi) & (vzr >= 0.5)).astype(float)
        # 라벨/체결용 미래값 (특징 아님)
        f['o_next'] = o.shift(-1)
        for H in (6, 18):
            f[f'c_fwd{H}'] = c.shift(-H)
            f[f'hmax{H}'] = h[::-1].rolling(H).max()[::-1].shift(-1)  # t+1..t+H 최고가
        f['alive'] = c.notna() & c.shift(180).notna()
        f['m'] = m
        f['ts'] = idx
        rows.append(f.reset_index(drop=True))
    X = pd.concat(rows, ignore_index=True)
    X = X[X.alive].drop(columns='alive')
    # 시장 breadth (시점별): sma50 > 0 비율, 횡단면 평균 수익
    g = X.groupby('ts')
    X['breadth50'] = g.sma50.transform(lambda s: (s > 0).mean())
    X['mkt_ret6'] = g.ret6.transform('mean')
    X['mkt_ret42'] = g.ret42.transform('mean')
    X['n_coins'] = g.ret6.transform('count')
    # 횡단면 순위 특징
    for k in ['ret6', 'ret42', 'ret180', 'vz30', 'dhi42', 'vol42', 'rel42', 'turn_krw']:
        X[f'xr_{k}'] = g[k].rank(pct=True)
    return X


FEATS = None


def feat_cols(X):
    skip = {'m', 'ts', 'o_next'} | {c for c in X.columns if c.startswith(('c_fwd', 'hmax'))}
    return [c for c in X.columns if c not in skip]


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'build'
    if cmd == 'build':
        for kind in ('P28', 'P118'):
            p = load_panel(kind)
            X = features(p)
            X.to_pickle(os.path.join(OUT, f'{kind}.pkl'))
            print(kind, 'coins', len(p), 'rows', len(X), 'feats', len(feat_cols(X)),
                  pd.to_datetime(X.ts.min(), unit='ms').date(), '~', pd.to_datetime(X.ts.max(), unit='ms').date())
