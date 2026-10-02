"""축 G 반증 — ridge_raw q0.99 의 733% 와 모멘텀 ret42 q0.97 의 200% 를 깨부순다.
실행: venv/bin/python scripts/_ml_break.py P28 [alpha]"""
import os, sys
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ml_sim import Mkt, rolling_thresh, sim_E, size_for, OUT
import _ml_wf as W

panel = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'all'
M = Mkt(panel)
D = lambda s: int(pd.Timestamp(s, tz='UTC').value // 10**6)
S_rr = M.score_from_pred(f'pred_{panel}_ridge_raw_H18')
first = np.where(~np.isnan(S_rr).all(axis=1))[0][0]
T_FROM, T_TO = int(M.ts[first + 540]), int(M.ts[-1])
SP = [('~23말', T_FROM, D('2023-12-31')), ('2024', D('2024-01-01'), D('2024-12-31')), ('2025', D('2025-01-01'), D('2025-12-31')), ('2026', D('2026-01-01'), T_TO)]
ret42 = M.feat('ret42')


def line(lab, S, th, fric=1.0, lagS=0, tp=6.0, maxb=18, pen=0.0):
    if lagS:
        S = np.vstack([np.full((lagS, S.shape[1]), np.nan), S[:-lagS]]); th = np.concatenate([np.full(lagS, np.nan), th[:-lagS]])
    f = lambda z, a=T_FROM, b=T_TO: sim_E(M, S, th, z, a, b, fric=fric, tp=tp, maxb=maxb, pen=pen)
    r = f(0.33); sz = size_for(f); e = f(sz)
    per = ''.join(f'{f(sz, a, b)[0]:7.0f}%' for _, a, b in SP)
    print(f'  {lab:40s} {r[0]:6.0f}% MDD{r[1]:3.0f}% n{r[2]:4d} {r[3]:+.2f}% | MDD17 {e[0]:5.0f}% |{per}', flush=True)
    return S, th


if mode in ('all', 'q'):
    print('① 분위 이웃 (고원인가)')
    for q in (0.95, 0.97, 0.98, 0.985, 0.99, 0.993, 0.995):
        line(f'ridge_raw q{q}', S_rr, rolling_thresh(S_rr, q))
    for q in (0.95, 0.97, 0.98, 0.99, 0.995):
        line(f'모멘텀 ret42 q{q}', ret42, rolling_thresh(ret42, q))

if mode in ('all', 'lag'):
    print('② 신호 1·2봉 지연 (타이밍 민감도) · 비용×2 · 청산 바꾸기')
    th = rolling_thresh(S_rr, 0.99); thm = rolling_thresh(ret42, 0.97)
    for lg in (1, 2):
        line(f'ridge_raw q0.99 지연{lg}', S_rr, th, lagS=lg)
        line(f'모멘텀 q0.97 지연{lg}', ret42, thm, lagS=lg)
    line('ridge_raw q0.99 비용×2', S_rr, th, fric=2.0)
    line('ridge_raw q0.99 비용×3', S_rr, th, fric=3.0)
    line('모멘텀 q0.97 비용×2', ret42, thm, fric=2.0)
    line('ridge_raw q0.99 TP4/2일', S_rr, th, tp=4, maxb=12)
    line('ridge_raw q0.99 TP10/5일', S_rr, th, tp=10, maxb=30)
    line('모멘텀 q0.97 TP10/5일', ret42, thm, tp=10, maxb=30)

if mode in ('all', 'conc'):
    print('③ 집중도 — 어떤 코인·시점이 수익을 만들었나 (ridge_raw q0.99, 33%×3 거래 목록 재구성)')
    th = rolling_thresh(S_rr, 0.99)
    # 거래 단위 재구성: sim_E 를 복제해 거래 기록
    from _ml_sim import FEE0
    fee = FEE0; slip = M.slip0
    cash, pos, trades = 1.0, [], []
    for i in range(1, len(M.ts)):
        if M.ts[i] < T_FROM: continue
        keep = []
        for p in pos:
            j = p[0]
            if np.isnan(M.h[i, j]): keep.append(p); continue
            p[4] += 1; tgt = p[1] * 1.06
            if M.h[i, j] >= tgt: got = p[2] * tgt * (1 - fee); cash += got; trades.append((M.coins[j], M.ts[p[5]], got / p[3] - 1, got - p[3]))
            elif p[4] >= 18: got = p[2] * M.c[i, j] * (1 - slip[j]) * (1 - fee); cash += got; trades.append((M.coins[j], M.ts[p[5]], got / p[3] - 1, got - p[3]))
            else: keep.append(p)
        pos = keep
        if len(pos) < 3 and not np.isnan(th[i - 1]):
            s = S_rr[i - 1]
            for j in [j for j in np.argsort(-np.nan_to_num(s, nan=-1e9)) if not np.isnan(s[j]) and s[j] >= th[i - 1]]:
                if len(pos) >= 3: break
                if j in {p[0] for p in pos} or np.isnan(M.o[i, j]): continue
                used = cash * 0.33; ep = M.o[i, j] * (1 + slip[j]); cash -= used
                pos.append([j, ep, used * (1 - fee) / ep, used, 0, i])
    T = pd.DataFrame(trades, columns=['m', 'ts', 'r', 'krw'])
    T['month'] = pd.to_datetime(T.ts, unit='ms').dt.strftime('%Y-%m')
    print(f'  거래 {len(T)} 승률 {(T.r > 0).mean()*100:.0f}% 평균 {T.r.mean()*100:+.2f}%')
    g = T.groupby('m').agg(n=('r', 'size'), avg=('r', 'mean'), krw=('krw', 'sum')).sort_values('krw', ascending=False)
    print('  코인별 (손익 상위/하위 5):'); print(g.head(5).to_string()); print(g.tail(5).to_string())
    sr = T.r.sort_values(ascending=False)
    print(f'  상위 10 거래 평균 {sr.head(10).mean()*100:+.2f}% · 상위 10 제외 평균 {sr.iloc[10:].mean()*100:+.2f}% · 상위 5% 제외 {sr.iloc[int(len(sr)*.05):].mean()*100:+.2f}%')
    print(f'  TP 도달(+5.9% 이상) 비율 {(T.r > 0.059).mean()*100:.0f}%')
    # 코인 반반 재현
    half = set(M.coins[::2])
    for lab, keep in (('짝수 코인', half), ('홀수 코인', set(M.coins) - half)):
        S2 = S_rr.copy(); S2[:, [k for k, m in enumerate(M.coins) if m not in keep]] = np.nan
        line(f'ridge_raw q0.99 {lab}만', S2, th)

if mode in ('all', 'alpha'):
    print('④ 하이퍼파라미터 민감도 — ridge raw alpha 고정 재학습 (선택값 3000)')
    for a in (1, 100, 30000, 300000):
        W.GRID['ridge'] = [{'alpha': a}]
        name, best, bic, oic, oos = W.run(panel, 18, 'ridge', 'raw', init_months=12)
        os.rename(os.path.join(OUT, name + '.pkl'), os.path.join(OUT, f'{name}_a{a}.pkl'))
        S = M.score_from_pred(f'{name}_a{a}')
        line(f'ridge_raw alpha={a} q0.99', S, rolling_thresh(S, 0.99))
        line(f'ridge_raw alpha={a} q0.97', S, rolling_thresh(S, 0.97))

if mode == 'pen':
    print('⑤ TP 관통 요구 · TP 없이 시간청산만 (신호 자체의 힘)')
    th = rolling_thresh(S_rr, 0.99); thm = rolling_thresh(ret42, 0.97)
    f6 = M.feat('f6'); ob = (np.arange(len(M.coins))[::-1] / 1e6)[None, :]
    S7 = np.where(f6 == 1, 1 + ob, np.nan); th7 = np.full(len(M.ts), 0.5)
    for lab, S, t in (('F7', S7, th7), ('ridge_raw q0.99', S_rr, th), ('모멘텀 q0.97', ret42, thm)):
        for pen in (0.002, 0.005):
            line(f'{lab} TP관통 {pen*100:.1f}%', S, t, pen=pen)
        line(f'{lab} TP없음·3일 시간청산', S, t, tp=0)
        line(f'{lab} TP없음·1일 시간청산', S, t, tp=0, maxb=6)
