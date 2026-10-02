"""
축 G — 예측을 업비트 현물로 실행했을 때의 포트폴리오 시뮬 (2026-10-02)

엔진 E (이벤트, F7 형): 봉 t 종가에 점수 ≥ 임계값인 코인 → t+1 시가 시장가 진입(슬리피지=스프레드½),
   TP +6% 지정가(진입봉 다음 봉부터 고가 체크, 슬리피지 0) · 18봉 뒤 종가 시장가 · 무스톱. 최대 3슬롯, 진입당 현금×size.
   임계값 = 직전 90일(540봉) 전체 코인-봉 점수의 q 분위 (과거만 사용 → 미래참조 없음).
엔진 R (로테이션): H 봉마다 점수 상위 K 를 t+1 시가에 동일비중 보유(바뀐 것만 거래), 옵션: 점수>0 일 때만.
비교: F7(F6 신호·E 엔진), 모멘텀 ret42 (E·R 엔진), BTC 축소보유. 동일 MDD 17% 사이징 이분탐색.
"""
import os, sys, json
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ml_panel import load_panel, OUT, ROOT, COINS28

SPREAD = json.load(open(os.path.join(ROOT, 'data', 'research-spread-p50.json')))
FEE0 = 0.0005


class Mkt:
    def __init__(self, panel_kind, exclude28=False):
        P = load_panel(panel_kind)
        if exclude28:
            P = {m: d for m, d in P.items() if m not in COINS28}
        self.coins = [m for m in (COINS28 if panel_kind == 'P28' else sorted(P)) if m in P]
        idx = sorted(set().union(*[set(P[m].index) for m in self.coins]))
        self.ts = np.array(idx)
        f = lambda col: np.column_stack([P[m][col].reindex(idx).values for m in self.coins])
        self.o, self.h, self.c = f('open'), f('high'), f('close')
        self.slip0 = np.array([max(0.0005, SPREAD[m] / 2 / 1e4) if m in SPREAD else 0.003 for m in self.coins])
        X = pd.read_pickle(os.path.join(OUT, f'{panel_kind}.pkl'))
        X = X[X.m.isin(self.coins)]
        self.feat = lambda col: X.pivot(index='ts', columns='m', values=col).reindex(index=idx, columns=self.coins).values
        btc = P['KRW-BTC'].close.reindex(idx).ffill().values if 'KRW-BTC' in P else None
        self.btc = btc

    def score_from_pred(self, name):
        P = pd.read_pickle(os.path.join(OUT, name + '.pkl'))
        return P.pivot(index='ts', columns='m', values='pred').reindex(index=self.ts, columns=self.coins).values


def rolling_thresh(S, q, win=540):
    """각 봉 t 의 임계값 = t-win..t-1 봉의 모든 점수 q 분위 (과거만)."""
    T = S.shape[0]
    th = np.full(T, np.nan)
    for t in range(win, T):
        w = S[t - win:t].ravel()
        w = w[~np.isnan(w)]
        if len(w) > 200:
            th[t] = np.quantile(w, q)
    return th


def sim_E(M, S, th, size, t_from, t_to, tp=6.0, maxb=18, fric=1.0, slots=3, pen=0.0):
    fee = FEE0 * fric; slip = M.slip0 * fric
    cash, pos = 1.0, []           # pos: [j, ep, vol, used, bars]
    peak, mdd, n, sumr = 1.0, 0.0, 0, 0.0
    T, N = S.shape
    eq_last = 1.0
    for i in range(1, T):
        ts = M.ts[i]
        if ts < t_from or ts > t_to:
            continue
        # 청산
        keep = []
        for p in pos:
            j = p[0]
            if np.isnan(M.h[i, j]):
                keep.append(p); continue
            p[4] += 1
            tgt = p[1] * (1 + tp / 100)
            if tp > 0 and M.h[i, j] >= tgt * (1 + pen):
                got = p[2] * tgt * (1 - fee); cash += got; n += 1; sumr += got / p[3] - 1
            elif p[4] >= maxb:
                got = p[2] * M.c[i, j] * (1 - slip[j]) * (1 - fee); cash += got; n += 1; sumr += got / p[3] - 1
            else:
                keep.append(p)
        pos = keep
        # 진입 (신호: i-1 봉 종가 기준 점수)
        if len(pos) < slots and not np.isnan(th[i - 1]):
            s = S[i - 1]
            cand = [j for j in np.argsort(-np.nan_to_num(s, nan=-1e9)) if not np.isnan(s[j]) and s[j] >= th[i - 1]]
            held = {p[0] for p in pos}
            for j in cand:
                if len(pos) >= slots:
                    break
                if j in held or np.isnan(M.o[i, j]):
                    continue
                used = cash * size
                if used < 1e-4:
                    break
                ep = M.o[i, j] * (1 + slip[j])
                cash -= used
                pos.append([j, ep, used * (1 - fee) / ep, used, 0])
        eq = cash + sum(p[2] * (M.c[i, p[0]] if not np.isnan(M.c[i, p[0]]) else p[1]) for p in pos)
        peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak); eq_last = eq
    return 100 * (eq_last - 1), 100 * mdd, n, (100 * sumr / n if n else 0)


def sim_R(M, S, w, t_from, t_to, H=18, K=3, gate=False, fric=1.0):
    fee = FEE0 * fric; slip = M.slip0 * fric
    eq, peak, mdd = 1.0, 1.0, 0.0
    hold = {}          # j -> 보유 수량(비중 기준 가치로 관리)
    cash = 1.0
    T = S.shape[0]
    last_reb = -10 ** 9
    for i in range(1, T):
        ts = M.ts[i]
        if ts < t_from or ts > t_to:
            continue
        if i - last_reb >= H:
            s = S[i - 1]
            order = [j for j in np.argsort(-np.nan_to_num(s, nan=-1e9)) if not np.isnan(s[j]) and not np.isnan(M.o[i, j])]
            tgt = order[:K]
            if gate:
                tgt = [j for j in tgt if s[j] > 0]
            # 현재 가치 (시가 기준)
            val = cash + sum(q * M.o[i, j] for j, q in hold.items() if not np.isnan(M.o[i, j]))
            # 빠질 것 매도
            for j in list(hold):
                if j not in tgt and not np.isnan(M.o[i, j]):
                    cash += hold.pop(j) * M.o[i, j] * (1 - slip[j]) * (1 - fee)
            # 들어올 것 매수 (동일비중 val*w/K)
            for j in tgt:
                if j not in hold:
                    amt = val * w / K
                    amt = min(amt, cash)
                    if amt <= 0:
                        continue
                    cash -= amt
                    hold[j] = amt * (1 - fee) / (M.o[i, j] * (1 + slip[j]))
            last_reb = i
        e = cash + sum(q * (M.c[i, j] if not np.isnan(M.c[i, j]) else 0) for j, q in hold.items())
        peak = max(peak, e); mdd = max(mdd, 1 - e / peak); eq = e
    return 100 * (eq - 1), 100 * mdd


def btc_hold(M, w, t_from, t_to):
    m = (M.ts >= t_from) & (M.ts <= t_to)
    b = M.btc[m]; r = b / b[0]
    eq = 1 + w * (r - 1)
    peak = np.maximum.accumulate(eq)
    return 100 * (eq[-1] - 1), 100 * (1 - eq / peak).max()


def size_for(fn, target=17.0, lo=0.01, hi=1.0):
    for _ in range(16):
        mid = (lo + hi) / 2
        if fn(mid)[1] > target:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2
